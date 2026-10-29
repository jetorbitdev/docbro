mod files;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex, MutexGuard, PoisonError,
    },
};

use tauri::{
    ipc::{InvokeBody, Request, Response},
    menu::{Menu, MenuItemBuilder, SubmenuBuilder},
    AppHandle, Emitter, Manager, Runtime, State, WebviewWindowBuilder, Window, WindowEvent,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

type CmdResult<T> = Result<T, String>;

/// What the shell knows about the document in one window. The document itself lives in the
/// webview's editor, which reports these facts through `set_doc_meta`.
#[derive(Debug, Clone, PartialEq)]
struct WindowDoc {
    /// File the document was opened from or saved to
    path: Option<PathBuf>,
    /// Edited since it was opened or last saved
    dirty: bool,
    /// The empty document a window starts with, not a file that was opened
    blank: bool,
    /// The editor is mounted and listens for `mcp-call`
    ready: bool,
}

impl Default for WindowDoc {
    fn default() -> Self {
        WindowDoc { path: None, dirty: false, blank: true, ready: false }
    }
}

struct AppState {
    /// One entry per window, keyed by window label, once its editor has reported
    windows: Mutex<HashMap<String, WindowDoc>>,
    /// Label of the window that last had focus: menu commands act on it
    active: Mutex<String>,
    /// Files waiting for a window to pick them up once its webview listens. A label
    /// stays here after its files were taken, so that window is not handed another one.
    pending_open: Mutex<HashMap<String, Vec<String>>>,
}

impl AppState {
    fn new() -> Self {
        AppState {
            windows: Mutex::new(HashMap::new()),
            active: Mutex::new("main".into()),
            pending_open: Mutex::new(HashMap::new()),
        }
    }

    fn active_label(&self) -> String {
        self.active.lock_recovering().clone()
    }

    /// A window with nothing in it yet and no file on its way.
    fn untouched(&self, label: &str) -> bool {
        let pending = self.pending_open.lock_recovering().contains_key(label);
        is_untouched(pending, self.windows.lock_recovering().get(label))
    }
}

/// Whether a file may replace what a window shows: nothing is on its way to it, and it is
/// either still waiting for its editor or an empty document nobody typed into or saved.
fn is_untouched(pending_open: bool, doc: Option<&WindowDoc>) -> bool {
    !pending_open && doc.is_none_or(|d| d.blank && !d.dirty && d.path.is_none())
}

/// Locks a mutex even when a thread panicked while holding it. One command that panicked
/// must not make every later lock panic too, which would take the whole app down with the
/// unsaved work in it.
trait LockExt<T> {
    fn lock_recovering(&self) -> MutexGuard<'_, T>;
}

impl<T> LockExt<T> for Mutex<T> {
    fn lock_recovering(&self) -> MutexGuard<'_, T> {
        self.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

// ----------------------------------------------------------------- files

#[tauri::command]
async fn read_file(path: String) -> CmdResult<Response> {
    files::read_bytes(Path::new(&path)).map(Response::new)
}

/// The body is the file's raw bytes and the `x-path` header its URI-encoded path.
#[tauri::command]
async fn write_file(request: Request<'_>) -> CmdResult<()> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The file contents must be sent as raw bytes".into());
    };
    let header = request
        .headers()
        .get("x-path")
        .and_then(|v| v.to_str().ok())
        .ok_or("The file path is missing")?;
    files::write_atomic(&files::path_from_header(header)?, bytes)
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).is_file()
}

// ----------------------------------------------------------------- windows

/// The editor reports what its document is, so the shell can pick a window for a file,
/// find the window that has a file open, and ask before quitting over unsaved changes.
#[tauri::command]
fn set_doc_meta(
    path: Option<String>,
    dirty: bool,
    blank: bool,
    window: Window,
    state: State<AppState>,
) {
    let mut windows = state.windows.lock_recovering();
    let doc = windows.entry(window.label().to_string()).or_default();
    doc.path = path.map(PathBuf::from);
    doc.dirty = dirty;
    doc.blank = blank;
}

#[tauri::command]
fn editor_ready(window: Window, state: State<AppState>) {
    state.windows.lock_recovering().entry(window.label().to_string()).or_default().ready = true;
}

#[tauri::command]
fn take_pending_open(window: Window, state: State<AppState>) -> Vec<String> {
    state
        .pending_open
        .lock_recovering()
        .get_mut(window.label())
        .map(std::mem::take)
        .unwrap_or_default()
}

static NEXT_WINDOW: AtomicU64 = AtomicU64::new(1);

/// Opens another window like the main one, which loads `path` once its webview is ready.
fn open_window(app: &AppHandle, path: Option<String>) -> CmdResult<()> {
    let label = format!("doc-{}", NEXT_WINDOW.fetch_add(1, Ordering::Relaxed));
    build_window(app, label, path)
}

/// Window `label` shows `path` once its editor asks for it, an empty document when there is none.
fn build_window(app: &AppHandle, label: String, path: Option<String>) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let mut config = app.config().app.windows.first().cloned().ok_or("No window configuration")?;
    config.label = label.clone();
    let mut builder = WebviewWindowBuilder::from_config(app, &config).map_err(|e| e.to_string())?;
    // cascade from the window in front, like other document apps
    if let Some(front) = app.get_webview_window(&state.active_label()) {
        if let (Ok(pos), Ok(scale)) = (front.outer_position(), front.scale_factor()) {
            let pos = pos.to_logical::<f64>(scale);
            builder = builder.position(pos.x + 24.0, pos.y + 24.0);
        }
    }
    if let Some(path) = path {
        state.pending_open.lock_recovering().insert(label.clone(), vec![path]);
    }
    builder.build().map_err(|e| {
        state.pending_open.lock_recovering().remove(&label);
        e.to_string()
    })?;
    Ok(())
}

/// Brings forward the window that has `path` open, if any. A file lives in one window
/// only, so two windows never save over each other.
fn focus_window_with(app: &AppHandle, path: &str) -> bool {
    let has_it = app
        .state::<AppState>()
        .windows
        .lock_recovering()
        .iter()
        .find(|(_, d)| d.path.as_deref() == Some(Path::new(path)))
        .map(|(label, _)| label.clone());
    let Some(window) = has_it.and_then(|label| app.get_webview_window(&label)) else {
        return false;
    };
    let _ = window.unminimize();
    let _ = window.set_focus();
    true
}

/// Shows `path` from Finder in the window that already has it open, else in an untouched
/// window, else in a new window.
fn route_open(app: &AppHandle, path: String) -> CmdResult<()> {
    if focus_window_with(app, &path) {
        return Ok(());
    }
    let state = app.state::<AppState>();
    let active = state.active_label();
    let mut labels: Vec<String> = app.webview_windows().into_keys().collect();
    // the window in front first
    labels.sort_by_key(|l| *l != active);
    if let Some(label) = labels.into_iter().find(|l| state.untouched(l)) {
        state.pending_open.lock_recovering().insert(label.clone(), vec![path.clone()]);
        let _ = app.emit_to(label.as_str(), "open-file", path);
        return Ok(());
    }
    open_window(app, Some(path))
}

/// Opens a new window, empty or showing `path`, or focuses the window that has `path` open
/// already. With `here` the calling window takes the file instead: then this returns true
/// and the caller loads it.
#[tauri::command]
async fn open_in_window(path: Option<String>, here: bool, app: AppHandle) -> CmdResult<bool> {
    let Some(path) = path else {
        open_window(&app, None)?;
        return Ok(false);
    };
    if focus_window_with(&app, &path) {
        return Ok(false);
    }
    if here {
        return Ok(true);
    }
    open_window(&app, Some(path))?;
    Ok(false)
}

/// Open… with no window to ask from: every picked file gets a window of its own.
fn pick_and_open(app: &AppHandle) {
    let handle = app.clone();
    app.dialog().file().add_filter("Documents", &["docx", "md", "markdown"]).pick_files(
        move |picked| {
            for path in picked.into_iter().flatten().filter_map(|p| p.into_path().ok()) {
                let _ = route_open(&handle, path.to_string_lossy().to_string());
            }
        },
    );
}

/// Set once the user agreed to quit with unsaved changes, so the exit that follows goes through.
static QUIT_CONFIRMED: AtomicBool = AtomicBool::new(false);
/// A "quit anyway?" question is on screen, so a second quit request does not stack another.
static QUIT_ASKING: AtomicBool = AtomicBool::new(false);

/// Quitting the app (Cmd+Q) closes every window without the per-window "unsaved changes"
/// question. Returns true when the quit has to wait for an answer.
fn hold_quit_for_unsaved_changes(app: &AppHandle) -> bool {
    if QUIT_CONFIRMED.load(Ordering::SeqCst) {
        return false;
    }
    let unsaved =
        app.state::<AppState>().windows.lock_recovering().values().filter(|d| d.dirty).count();
    if unsaved == 0 {
        return false;
    }
    if !QUIT_ASKING.swap(true, Ordering::SeqCst) {
        let text = match unsaved {
            1 => "1 document has unsaved changes. Quit without saving it?".to_string(),
            n => format!("{n} documents have unsaved changes. Quit without saving them?"),
        };
        let handle = app.clone();
        app.dialog()
            .message(text)
            .title("Unsaved changes")
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancelCustom("Quit".into(), "Cancel".into()))
            .show(move |quit| {
                QUIT_ASKING.store(false, Ordering::SeqCst);
                if quit {
                    QUIT_CONFIRMED.store(true, Ordering::SeqCst);
                    handle.exit(0);
                }
            });
    }
    true
}

// ----------------------------------------------------------------- menu

/// Every item except Cut, Copy, Paste, Select All and Close is custom: it sends its id to the
/// window in front as the `menu` event, so its shortcut reaches the editor instead of being
/// swallowed by the native responder chain. The clipboard items are the system's own, because
/// the editor needs the webview's clipboard handling (pasting HTML).
fn build_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let item = |id: &str, text: &str, accel: &str| {
        MenuItemBuilder::with_id(id, text).accelerator(accel).build(app)
    };
    let app_menu = SubmenuBuilder::new(app, "DocBro")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New", "CmdOrCtrl+N")?)
        .item(&item("open", "Open…", "CmdOrCtrl+O")?)
        .separator()
        .item(&item("save", "Save", "CmdOrCtrl+S")?)
        .item(&item("save_as", "Save As…", "CmdOrCtrl+Shift+S")?)
        .separator()
        .item(&item("print", "Print…", "CmdOrCtrl+P")?)
        .separator()
        .close_window()
        .build()?;
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo", "CmdOrCtrl+Z")?)
        .item(&item("redo", "Redo", "CmdOrCtrl+Shift+Z")?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find…", "CmdOrCtrl+F")?)
        .item(&item("replace", "Find and Replace…", "CmdOrCtrl+Alt+F")?)
        .build()?;
    let view = SubmenuBuilder::new(app, "View")
        .item(&MenuItemBuilder::with_id("focus", "Focus mode").build(app)?)
        .item(&MenuItemBuilder::with_id("outline", "Show outline").build(app)?)
        .item(&MenuItemBuilder::with_id("comments", "Show comments").build(app)?)
        .item(&item("assistant", "Assistant", "CmdOrCtrl+Alt+A")?)
        .separator()
        .item(&MenuItemBuilder::with_id("dark_mode", "Dark mode").build(app)?)
        .item(&MenuItemBuilder::with_id("larger_text", "Larger text").build(app)?)
        .item(&MenuItemBuilder::with_id("sans_font", "Sans-serif body").build(app)?)
        .separator()
        .item(&item("palette", "Command palette…", "CmdOrCtrl+K")?)
        .build()?;
    let insert = SubmenuBuilder::new(app, "Insert")
        .item(&MenuItemBuilder::with_id("table", "Table").build(app)?)
        .item(&MenuItemBuilder::with_id("image", "Image…").build(app)?)
        .item(&item("link", "Link…", "CmdOrCtrl+Shift+K")?)
        .item(&MenuItemBuilder::with_id("divider", "Divider").build(app)?)
        .separator()
        .item(&item("comment", "Comment", "CmdOrCtrl+Alt+M")?)
        .separator()
        .item(&MenuItemBuilder::with_id("header", "Header").build(app)?)
        .item(&MenuItemBuilder::with_id("footer", "Footer").build(app)?)
        .item(&MenuItemBuilder::with_id("page_numbers", "Page numbers").build(app)?)
        .build()?;
    let format = SubmenuBuilder::new(app, "Format")
        .item(&item("text", "Text", "CmdOrCtrl+Alt+0")?)
        .item(&item("h1", "Heading 1", "CmdOrCtrl+Alt+1")?)
        .item(&item("h2", "Heading 2", "CmdOrCtrl+Alt+2")?)
        .item(&item("h3", "Heading 3", "CmdOrCtrl+Alt+3")?)
        .item(&MenuItemBuilder::with_id("quote", "Quote").build(app)?)
        .separator()
        .item(&item("ul", "Bulleted list", "CmdOrCtrl+Shift+8")?)
        .item(&item("ol", "Numbered list", "CmdOrCtrl+Shift+7")?)
        .separator()
        .item(&item("bold", "Bold", "CmdOrCtrl+B")?)
        .item(&item("italic", "Italic", "CmdOrCtrl+I")?)
        .item(&item("underline", "Underline", "CmdOrCtrl+U")?)
        .item(&item("strike", "Strikethrough", "CmdOrCtrl+Shift+X")?)
        .item(&MenuItemBuilder::with_id("highlight", "Highlight").build(app)?)
        .item(&MenuItemBuilder::with_id("color", "Text color…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id("align_left", "Align left").build(app)?)
        .item(&MenuItemBuilder::with_id("align_center", "Align center").build(app)?)
        .item(&MenuItemBuilder::with_id("align_right", "Align right").build(app)?)
        .item(&MenuItemBuilder::with_id("align_justify", "Justify").build(app)?)
        .build()?;
    let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &insert, &format, &window])
}

/// Entry point of `--mcp-stdio`: relays MCP messages between stdin/stdout and the running app.
/// A stub until the MCP server lands.
pub fn mcp_stdio_bridge() -> i32 {
    1
}

// ----------------------------------------------------------------- run

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(AppState::new())
        .setup(|app| {
            app.set_menu(build_menu(app.handle())?)?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let id = event.id().0.as_str();
            if id == "new" {
                let _ = open_window(app, None);
                return;
            }
            // on macOS the app stays running with every window closed
            if app.webview_windows().is_empty() {
                if id == "open" {
                    pick_and_open(app);
                }
                return;
            }
            // only the window in front acts on a menu command
            let label = app.state::<AppState>().active_label();
            let _ = app.emit_to(label.as_str(), "menu", id);
        })
        .on_window_event(|window, event| {
            let state = window.state::<AppState>();
            let label = window.label();
            match event {
                WindowEvent::Focused(true) => *state.active.lock_recovering() = label.to_string(),
                WindowEvent::Destroyed => {
                    state.windows.lock_recovering().remove(label);
                    state.pending_open.lock_recovering().remove(label);
                    let mut active = state.active.lock_recovering();
                    if *active == label {
                        let others = window.webview_windows().into_keys().find(|l| l != label);
                        if let Some(next) = others {
                            *active = next;
                        }
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            file_exists,
            set_doc_meta,
            editor_ready,
            take_pending_open,
            open_in_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building DocBro");

    app.run(|handle, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            if hold_quit_for_unsaved_changes(handle) {
                api.prevent_exit();
                return;
            }
        }
        #[cfg(target_os = "macos")]
        match event {
            // Finder "Open With" / dropping a file on the Dock icon
            tauri::RunEvent::Opened { urls } => {
                for path in urls.iter().filter_map(|u| u.to_file_path().ok()) {
                    let _ = route_open(handle, path.to_string_lossy().to_string());
                }
            }
            // the last window closed (Quit is `Some` or skips this): stay in the Dock like
            // other Mac apps
            tauri::RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
            // clicking the Dock icon with no window open
            tauri::RunEvent::Reopen { .. } if handle.webview_windows().is_empty() => {
                let _ = open_window(handle, None);
            }
            _ => {}
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (handle, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn blank() -> WindowDoc {
        WindowDoc::default()
    }

    #[test]
    fn only_an_untouched_blank_window_takes_a_file() {
        // a window that has not reported yet, and a blank one
        assert!(is_untouched(false, None));
        assert!(is_untouched(false, Some(&blank())));
        // typed into, saved to a file, or loaded from one
        assert!(!is_untouched(false, Some(&WindowDoc { dirty: true, ..blank() })));
        assert!(!is_untouched(false, Some(&WindowDoc { path: Some("/a.docx".into()), ..blank() })));
        assert!(!is_untouched(false, Some(&WindowDoc { blank: false, ..blank() })));
        // a file is already on its way to it
        assert!(!is_untouched(true, None));
        assert!(!is_untouched(true, Some(&blank())));
    }

    #[test]
    fn a_window_is_untouched_until_it_reports_work_or_is_sent_a_file() {
        let state = AppState::new();
        assert!(state.untouched("doc-1"));

        state.windows.lock_recovering().insert("doc-1".into(), blank());
        assert!(state.untouched("doc-1"));

        state.pending_open.lock_recovering().insert("doc-1".into(), vec!["/a.docx".into()]);
        assert!(!state.untouched("doc-1"));
        // the file was taken, but the window still must not be handed another
        state.pending_open.lock_recovering().get_mut("doc-1").map(std::mem::take);
        assert!(!state.untouched("doc-1"));

        assert!(state.untouched("doc-2"));
        state
            .windows
            .lock_recovering()
            .insert("doc-2".into(), WindowDoc { dirty: true, ..blank() });
        assert!(!state.untouched("doc-2"));
    }
}
