//! Tool calls that Rust forwards to a document window, and the answers that come back.
//!
//! The document lives in the webview's editor, so a tool call (from an MCP client, or from
//! DocBro's own assistant) becomes an `mcp-call` event `{ id, name, args, origin }` sent to one
//! window. The window runs the tool as one editor transaction and answers with the
//! `mcp_reply` command. The caller waits on a channel with no lock held, so a slow answer
//! never holds up window events, `editor_ready` or the answer itself.

use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, RecvTimeoutError},
        Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::{AppState, LockExt};

pub type Reply = Result<String, String>;

/// How long a window gets to run one tool
pub const CALL_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a window that was just opened gets to mount its editor
pub const READY_TIMEOUT: Duration = Duration::from_secs(10);
const READY_POLL: Duration = Duration::from_millis(50);
/// How long before Rust gives up a call the window stops starting it
const DEADLINE_MARGIN: Duration = Duration::from_secs(2);

const TIMED_OUT: &str = "DocBro did not answer in time. Is a dialog open in the document window?";
const CLOSED: &str = "The document window was closed.";
const NOT_READY: &str = "The DocBro window did not finish opening in time. Try again in a moment.";

/// Who made a tool call. The window lists external clients' calls in its activity feed; the
/// assistant's own show up in its chat instead.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Origin {
    External,
    Assistant,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Origin::External => "external",
            Origin::Assistant => "assistant",
        }
    }
}

/// Calls waiting for their answer: id → (window label, where the answer goes)
type Waiting = HashMap<u64, (String, mpsc::Sender<Reply>)>;

#[derive(Default)]
pub struct Calls {
    next: AtomicU64,
    waiting: Mutex<Waiting>,
}

impl Calls {
    /// Registers a call to window `label`; its answer arrives on the receiver.
    pub fn begin(&self, label: &str) -> (u64, mpsc::Receiver<Reply>) {
        let id = self.next.fetch_add(1, Ordering::Relaxed) + 1;
        let (tx, rx) = mpsc::channel();
        self.waiting.lock_recovering().insert(id, (label.to_string(), tx));
        (id, rx)
    }

    /// Waits for the answer to call `id`. On timeout the call is abandoned, so a late answer
    /// finds nobody waiting.
    pub fn wait(&self, id: u64, rx: mpsc::Receiver<Reply>, timeout: Duration) -> Reply {
        match rx.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(RecvTimeoutError::Disconnected) => Err(CLOSED.into()),
            Err(RecvTimeoutError::Timeout) => {
                if self.forget(id) {
                    return Err(TIMED_OUT.into());
                }
                // answered between the timeout and now: `finish` sends under the lock, so the
                // answer is already in the channel
                rx.try_recv().unwrap_or_else(|_| Err(CLOSED.into()))
            }
        }
    }

    /// Hands the answer to the call that waits for it; false if nobody waits (it timed out,
    /// or the id is unknown).
    pub fn finish(&self, id: u64, result: Reply) -> bool {
        let mut waiting = self.waiting.lock_recovering();
        waiting.remove(&id).is_some_and(|(_, tx)| tx.send(result).is_ok())
    }

    /// Window `label` is gone: its calls fail now instead of waiting out the timeout.
    pub fn fail_window(&self, label: &str) {
        self.waiting.lock_recovering().retain(|_, (window, tx)| {
            if window != label {
                return true;
            }
            let _ = tx.send(Err(CLOSED.into()));
            false
        });
    }

    /// Drops call `id` without an answer; true if it was still waiting.
    fn forget(&self, id: u64) -> bool {
        self.waiting.lock_recovering().remove(&id).is_some()
    }
}

/// Polls `done` every `every` until it holds or `timeout` has passed; returns whether it held.
fn poll_until(timeout: Duration, every: Duration, mut done: impl FnMut() -> bool) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if done() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        thread::sleep(every);
    }
}

fn is_ready(state: &AppState, label: &str) -> bool {
    state.windows.lock_recovering().get(label).is_some_and(|d| d.ready)
}

/// The `mcp-call` event: `{ id, name, args, origin, deadline }`. `deadline` (Unix time in ms) comes
/// `DEADLINE_MARGIN` before Rust stops waiting, and the window refuses a call it would start
/// after it. A call the client was told timed out is then never applied behind its back, where
/// a retry of a tool such as `insert_content` would apply it twice.
fn call_payload(id: u64, name: &str, args: &Value, origin: Origin, now_ms: u64, timeout: Duration) -> Value {
    let wait_ms = u64::try_from(timeout.saturating_sub(DEADLINE_MARGIN).as_millis()).unwrap_or(u64::MAX);
    json!({ "id": id, "name": name, "args": args, "origin": origin.as_str(), "deadline": now_ms.saturating_add(wait_ms) })
}

/// Runs tool `name` in window `label` and returns its answer. With no such window, it opens
/// one with that label (an empty document) and waits up to `READY_TIMEOUT` for its editor.
///
/// This blocks for up to `READY_TIMEOUT + CALL_TIMEOUT`, so it must run on a thread of its
/// own (the MCP server gives every request one), never on the main thread: the window's
/// answer and its `editor_ready` come in through commands that the main thread runs.
pub fn call_in_window(app: &AppHandle, label: &str, name: &str, args: &Value, origin: Origin) -> Reply {
    let state = app.state::<AppState>();
    if app.get_webview_window(label).is_none() {
        if let Err(e) = crate::build_window(app, label.to_string(), None) {
            // another call may have opened it a moment ago
            if app.get_webview_window(label).is_none() {
                return Err(format!("Could not open a DocBro window: {e}"));
            }
        }
    }
    if !poll_until(READY_TIMEOUT, READY_POLL, || is_ready(&state, label)) {
        return Err(NOT_READY.into());
    }
    let (id, rx) = state.calls.begin(label);
    // Closing a window removes its entry before it fails its calls, so a window that closed
    // after the check above either fails this call or is caught here.
    if !is_ready(&state, label) {
        state.calls.forget(id);
        return Err(CLOSED.into());
    }
    let now_ms = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as u64);
    let payload = call_payload(id, name, args, origin, now_ms, CALL_TIMEOUT);
    if let Err(e) = app.emit_to(label, "mcp-call", payload) {
        state.calls.forget(id);
        return Err(format!("Could not reach the document window: {e}"));
    }
    state.calls.wait(id, rx, CALL_TIMEOUT)
}

/// The window's answer to the `mcp-call` with this id: `ok` false makes `text` an error the
/// AI reads. An answer that comes too late is dropped.
#[tauri::command]
pub fn mcp_reply(id: u64, ok: bool, text: String, state: State<AppState>) {
    state.calls.finish(id, if ok { Ok(text) } else { Err(text) });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::Arc, thread, time::Instant};

    const SHORT: Duration = Duration::from_millis(50);

    #[test]
    fn a_reply_reaches_the_call_that_waits_for_it() {
        let calls = Arc::new(Calls::default());
        let (first, rx1) = calls.begin("main");
        let (second, rx2) = calls.begin("main");
        assert_ne!(first, second);
        // the webview answers from another thread, in any order
        let answering = calls.clone();
        thread::spawn(move || {
            assert!(answering.finish(second, Err("no".into())));
            assert!(answering.finish(first, Ok("yes".into())));
        });
        assert_eq!(calls.wait(first, rx1, CALL_TIMEOUT), Ok("yes".into()));
        assert_eq!(calls.wait(second, rx2, CALL_TIMEOUT), Err("no".into()));
        // an id answers once
        assert!(!calls.finish(first, Ok("again".into())));
    }

    #[test]
    fn call_times_out_with_a_readable_error() {
        let calls = Calls::default();
        let (id, rx) = calls.begin("main");
        let started = Instant::now();
        let err = calls.wait(id, rx, SHORT).unwrap_err();
        assert!(err.contains("did not answer"), "{err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn finish_after_timeout_is_ignored() {
        let calls = Calls::default();
        let (id, rx) = calls.begin("main");
        assert!(calls.wait(id, rx, SHORT).is_err());
        assert!(!calls.finish(id, Ok("late".into())));
        // nothing is left behind for the abandoned call
        assert!(calls.waiting.lock().unwrap().is_empty());
    }

    #[test]
    fn closing_a_window_fails_its_calls() {
        let calls = Arc::new(Calls::default());
        let (closing, rx) = calls.begin("doc-1");
        let (other, other_rx) = calls.begin("doc-2");
        let closer = calls.clone();
        thread::spawn(move || closer.fail_window("doc-1"));
        assert_eq!(calls.wait(closing, rx, CALL_TIMEOUT), Err("The document window was closed.".into()));
        // the other window's call still waits for its own answer
        assert!(calls.finish(other, Ok("fine".into())));
        assert_eq!(calls.wait(other, other_rx, SHORT), Ok("fine".into()));
        assert!(!calls.finish(closing, Ok("late".into())));
    }

    #[test]
    fn a_call_carries_the_deadline_after_which_the_window_must_not_run_it() {
        let args = serde_json::json!({ "from": 2 });
        let payload = call_payload(7, "delete_blocks", &args, Origin::External, 1_000_000, CALL_TIMEOUT);
        // 2 s before Rust gives up, so a call the window starts late is refused, not applied
        assert_eq!(
            payload,
            serde_json::json!({
                "id": 7, "name": "delete_blocks", "args": { "from": 2 }, "origin": "external", "deadline": 1_028_000u64
            })
        );
        // a timeout shorter than the margin does not underflow: the deadline is now
        assert_eq!(call_payload(1, "undo", &args, Origin::External, 5_000, SHORT)["deadline"], 5_000);
        assert_eq!(call_payload(1, "undo", &args, Origin::External, u64::MAX, CALL_TIMEOUT)["deadline"], u64::MAX);
    }

    #[test]
    fn a_call_says_whether_the_assistant_or_an_external_client_made_it() {
        let args = serde_json::json!({});
        // the window shows external calls in its activity feed; the assistant's are in the chat
        assert_eq!(call_payload(1, "document_info", &args, Origin::Assistant, 0, CALL_TIMEOUT)["origin"], "assistant");
        assert_eq!(call_payload(1, "document_info", &args, Origin::External, 0, CALL_TIMEOUT)["origin"], "external");
    }

    #[test]
    fn waiting_for_a_window_stops_when_it_is_ready_or_the_time_is_up() {
        let mut polls = 0;
        assert!(poll_until(CALL_TIMEOUT, Duration::from_millis(1), || {
            polls += 1;
            polls == 3
        }));
        assert_eq!(polls, 3);
        let started = Instant::now();
        assert!(!poll_until(SHORT, Duration::from_millis(5), || false));
        assert!(started.elapsed() >= SHORT && started.elapsed() < Duration::from_secs(5));
    }
}
