//! The user's MCP servers: their settings in `servers.json` (private to the user, since header
//! and env values are secrets) and the live connections the Assistant uses. A server is only
//! ever started while it is switched on.

use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::{
    files,
    mcp_client::{self, Connection, ServerSpec, Timeouts, ToolInfo, ToolOutput},
    AppState, CmdResult, LockExt,
};

/// Same as `identifier` in tauri.conf.json.
const APP_ID: &str = "com.jetorbit.docbro";
/// The built-in document server's id in the Assistant.
pub const RESERVED_ID: &str = "docbro";
/// Tool names sent to the model are `<id>__<tool>` and at most 64 characters.
const MAX_ID: usize = 32;
/// How long a server that failed is left alone before the Assistant tries it again, so a dead
/// server does not add its whole connect time to every message.
const RETRY_AFTER: Duration = Duration::from_secs(30);

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct ServerConfig {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub spec: ServerSpec,
}

#[derive(Serialize, Debug, PartialEq)]
pub struct ServerView {
    pub id: String,
    pub name: String,
    pub enabled: bool,
    pub transport: String,
    /// the URL or the command line
    pub summary: String,
    /// header or env names, never their values
    pub secret_keys: Vec<String>,
    /// "off" | "ready" | "error"
    pub status: String,
    pub tools: usize,
    pub error: Option<String>,
}

#[derive(Serialize, Deserialize, Default)]
struct SavedFile {
    servers: Vec<ServerConfig>,
}

/// A live connection. Calls on one server take turns; calls on different servers do not.
type Live = Arc<Mutex<Box<dyn Connection>>>;

struct Entry {
    config: ServerConfig,
    live: Option<Live>,
    tools: Vec<ToolInfo>,
    error: Option<String>,
    /// when `error` happened
    failed_at: Option<Instant>,
    /// changes whenever the settings change or the server is switched off, so a connection
    /// that was being made for the old settings is thrown away instead of installed
    generation: u64,
}

impl Entry {
    fn view(&self) -> ServerView {
        let c = &self.config;
        let status = match (c.enabled, &self.error) {
            (false, _) => "off",
            (true, Some(_)) => "error",
            (true, None) => "ready",
        };
        ServerView {
            id: c.id.clone(),
            name: c.name.clone(),
            enabled: c.enabled,
            transport: c.spec.transport().into(),
            summary: c.spec.summary(),
            secret_keys: c.spec.secret_keys(),
            status: status.into(),
            tools: self.tools.len(),
            error: self.error.clone(),
        }
    }

    /// Forgets the connection, its tools and any error, and returns the connection so the
    /// caller can drop it (which stops a stdio server) after letting go of the lock.
    fn reset(&mut self, generation: u64) -> Option<Live> {
        self.tools.clear();
        self.error = None;
        self.failed_at = None;
        self.generation = generation;
        self.live.take()
    }

    fn fail(&mut self, error: String) -> Option<Live> {
        self.tools.clear();
        self.error = Some(error);
        self.failed_at = Some(Instant::now());
        self.live.take()
    }
}

fn config_path() -> CmdResult<PathBuf> {
    dirs::config_dir()
        .map(|d| d.join(APP_ID).join("servers.json"))
        .ok_or_else(|| "No config directory".to_string())
}

fn check_id(id: &str) -> CmdResult<()> {
    if id == RESERVED_ID {
        return Err("The id docbro is reserved for DocBro's own document server".into());
    }
    let allowed = |c: char| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_';
    // `__` separates the server from the tool in the names the model sees
    if id.is_empty() || id.len() > MAX_ID || !id.chars().all(allowed) || id.contains("__") {
        return Err(format!(
            "A server id is 1 to {MAX_ID} lowercase letters, digits, - and _ (no double _)"
        ));
    }
    Ok(())
}

fn check(config: &ServerConfig) -> CmdResult<()> {
    check_id(&config.id)?;
    if config.name.trim().is_empty() {
        return Err("Give the server a name".into());
    }
    config.spec.validate()
}

fn load_from(path: &Path) -> Vec<ServerConfig> {
    // a file someone else could read is made private before anything else
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Ok(meta) = fs::metadata(path) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
            }
        }
    }
    fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<SavedFile>(&text).ok())
        .map(|f| f.servers)
        .unwrap_or_default()
}

/// The list and its connections. The lock is only ever held for bookkeeping: connecting,
/// listing and calling tools happen without it.
struct Registry {
    entries: Vec<Entry>,
    /// where the settings are saved
    file: CmdResult<PathBuf>,
    timeouts: Timeouts,
    retry_after: Duration,
    next_generation: u64,
}

impl Registry {
    fn generation(&mut self) -> u64 {
        self.next_generation += 1;
        self.next_generation
    }

    fn find(&self, id: &str) -> CmdResult<usize> {
        self.entries.iter().position(|e| e.config.id == id).ok_or_else(|| format!("There is no MCP server {id}"))
    }

    fn entry(&mut self, id: &str) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|e| e.config.id == id)
    }

    fn add(&mut self, config: ServerConfig) {
        let generation = self.generation();
        let entry = Entry { config, live: None, tools: Vec::new(), error: None, failed_at: None, generation };
        self.entries.push(entry);
    }

    /// Writes the list as it would be with `configs`; the caller applies it once that worked.
    fn persist(&self, configs: Vec<ServerConfig>) -> CmdResult<()> {
        let path = self.file.as_deref().map_err(Clone::clone)?;
        let failed = |e: String| format!("Could not save the MCP servers: {e}");
        fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(|e| failed(e.to_string()))?;
        let json = serde_json::to_string_pretty(&SavedFile { servers: configs }).map_err(|e| failed(e.to_string()))?;
        files::write_private(path, json.as_bytes()).map_err(failed)
    }

    fn configs_with(&self, change: impl FnOnce(&mut Vec<ServerConfig>)) -> Vec<ServerConfig> {
        let mut configs: Vec<ServerConfig> = self.entries.iter().map(|e| e.config.clone()).collect();
        change(&mut configs);
        configs
    }

    /// Whether `tools_for` should try to connect `e` now.
    fn due(&self, e: &Entry) -> bool {
        e.config.enabled && e.live.is_none() && e.failed_at.is_none_or(|at| at.elapsed() >= self.retry_after)
    }
}

/// Settings plus live connections; kept in `AppState`.
pub struct Servers {
    registry: Mutex<Registry>,
}

impl Servers {
    /// A missing or unreadable file is an empty list.
    pub fn load() -> Servers {
        Servers::at(config_path(), Timeouts::default())
    }

    fn at(file: CmdResult<PathBuf>, timeouts: Timeouts) -> Servers {
        let configs = file.as_deref().map(load_from).unwrap_or_default();
        let mut registry = Registry { entries: Vec::new(), file, timeouts, retry_after: RETRY_AFTER, next_generation: 0 };
        for config in configs {
            registry.add(config);
        }
        Servers { registry: Mutex::new(registry) }
    }

    fn lock(&self) -> MutexGuard<'_, Registry> {
        self.registry.lock_recovering()
    }

    pub fn views(&self) -> Vec<ServerView> {
        self.lock().entries.iter().map(Entry::view).collect()
    }

    /// Adds `config`, or replaces the server with its id, stopping the old connection. A server
    /// saved switched on is connected at once, as when it is switched on.
    pub fn save(&self, config: ServerConfig) -> CmdResult<()> {
        let mut reg = self.lock();
        let config = prepare(&reg, config)?;
        let (id, enabled) = (config.id.clone(), config.enabled);
        let index = reg.find(&config.id).ok();
        let saved = config.clone();
        reg.persist(reg.configs_with(|all| match index {
            Some(i) => all[i] = saved,
            None => all.push(saved),
        }))?;
        let old = match index {
            Some(i) => {
                let generation = reg.generation();
                reg.entries[i].config = config;
                reg.entries[i].reset(generation)
            }
            None => {
                reg.add(config);
                None
            }
        };
        drop(reg);
        drop(old);
        if enabled {
            // a failure shows in the server's status
            let _ = self.connect(&id, false);
        }
        Ok(())
    }

    pub fn remove(&self, id: &str) -> CmdResult<()> {
        let mut reg = self.lock();
        let Ok(index) = reg.find(id) else { return Ok(()) };
        reg.persist(reg.configs_with(|all| {
            all.remove(index);
        }))?;
        let old = reg.entries.remove(index).live;
        drop(reg);
        drop(old);
        Ok(())
    }

    /// Switching a server on connects to it at once, so its status shows whether it works.
    /// Switching it on again retries a server that failed.
    pub fn set_enabled(&self, id: &str, enabled: bool) -> CmdResult<()> {
        let mut reg = self.lock();
        let index = reg.find(id)?;
        if reg.entries[index].config.enabled != enabled {
            reg.persist(reg.configs_with(|all| all[index].enabled = enabled))?;
            reg.entries[index].config.enabled = enabled;
        }
        let old = if enabled {
            None
        } else {
            let generation = reg.generation();
            reg.entries[index].reset(generation)
        };
        drop(reg);
        drop(old);
        if enabled {
            let _ = self.connect(id, false);
        }
        Ok(())
    }

    /// The connection to server `id`, connecting first when there is none. The lock is let go
    /// while connecting; a connection made for settings that changed meanwhile is dropped.
    /// With `wait_out_failure`, a server that failed recently answers with its error at once.
    fn connect(&self, id: &str, wait_out_failure: bool) -> CmdResult<Live> {
        let (name, spec, generation, timeouts) = {
            let reg = self.lock();
            let e = &reg.entries[reg.find(id)?];
            if !e.config.enabled {
                return Err(format!("{} is off. Switch it on in MCP settings.", e.config.name));
            }
            if let Some(live) = &e.live {
                return Ok(live.clone());
            }
            if let (true, Some(error)) = (wait_out_failure && !reg.due(e), &e.error) {
                return Err(error.clone());
            }
            (e.config.name.clone(), e.config.spec.clone(), e.generation, reg.timeouts)
        };
        let connected = mcp_client::connect_with(&name, &spec, timeouts)
            .and_then(|mut conn| conn.list_tools().map(|tools| (conn, tools)));
        let mut reg = self.lock();
        let Some(entry) = reg.entry(id).filter(|e| e.generation == generation) else {
            // switched off, removed or changed while connecting: `connected` is dropped (and a
            // stdio server stopped) once the lock is let go
            drop(reg);
            drop(connected);
            return Err(format!("{name} changed while DocBro was connecting to it"));
        };
        match (connected, entry.live.clone()) {
            // another caller connected first: use that one, and stop ours
            (Ok((conn, _)), Some(first)) => {
                drop(reg);
                drop(conn);
                Ok(first)
            }
            // this attempt failed while another caller connected (a server that cannot run
            // twice fails the second start): the working connection stays, with no error
            (Err(_), Some(first)) => Ok(first),
            (Ok((conn, tools)), None) => {
                let live: Live = Arc::new(Mutex::new(conn));
                (entry.live, entry.tools, entry.error, entry.failed_at) = (Some(live.clone()), tools, None, None);
                Ok(live)
            }
            (Err(e), None) => {
                let old = entry.fail(e.clone());
                drop(reg);
                drop(old);
                Err(e)
            }
        }
    }

    /// The tools of every enabled server, or of server `only`, connecting to them as needed
    /// (all at once). A server that fails is skipped, shows the error in its status, and is
    /// tried again after `RETRY_AFTER`.
    pub fn tools_for(&self, only: Option<&str>) -> Vec<(String, ToolInfo)> {
        let wanted = |e: &Entry| e.config.enabled && only.is_none_or(|id| id == e.config.id);
        let pending: Vec<String> = {
            let reg = self.lock();
            reg.entries.iter().filter(|e| wanted(e) && reg.due(e)).map(|e| e.config.id.clone()).collect()
        };
        thread::scope(|scope| {
            for id in &pending {
                scope.spawn(move || self.connect(id, false));
            }
        });
        let reg = self.lock();
        reg.entries
            .iter()
            .filter(|e| wanted(e) && e.live.is_some())
            .flat_map(|e| e.tools.iter().map(|t| (e.config.id.clone(), t.clone())))
            .collect()
    }

    /// Calls a tool of an enabled server. When the connection fails (it timed out or the
    /// server went away), the server shows the error and reconnects on a later use.
    pub fn call(&self, server_id: &str, tool: &str, args: &Value) -> Result<ToolOutput, String> {
        let live = self.connect(server_id, true)?;
        let result = live.lock_recovering().call_tool(tool, args);
        if let Err(e) = &result {
            let mut reg = self.lock();
            // only if it is still the connection this call used: it may have been replaced
            let old = reg
                .entry(server_id)
                .filter(|entry| entry.live.as_ref().is_some_and(|l| Arc::ptr_eq(l, &live)))
                .and_then(|entry| entry.fail(e.clone()));
            drop(reg);
            drop(old);
        }
        result
    }

    /// `config` checked and ready to connect to, with the secrets it leaves empty taken from
    /// the saved server it edits.
    fn prepare(&self, config: ServerConfig) -> CmdResult<ServerConfig> {
        prepare(&self.lock(), config)
    }

    fn timeouts(&self) -> Timeouts {
        self.lock().timeouts
    }
}

fn prepare(reg: &Registry, mut config: ServerConfig) -> CmdResult<ServerConfig> {
    config.name = config.name.trim().to_string();
    match &mut config.spec {
        ServerSpec::Http { url, .. } => *url = url.trim().to_string(),
        ServerSpec::Stdio { command, .. } => *command = command.trim().to_string(),
    }
    if let Ok(index) = reg.find(&config.id) {
        let old = &reg.entries[index].config.spec;
        if old.transport() == config.spec.transport() {
            for (key, value) in config.spec.secrets_mut() {
                if let (true, Some(kept)) = (value.is_empty(), old.secrets().get(key)) {
                    value.clone_from(kept);
                }
            }
        }
    }
    check(&config)?;
    Ok(config)
}

/// Connects without saving and returns the server's tool names.
fn test_connection(config: &ServerConfig, timeouts: Timeouts) -> CmdResult<Vec<String>> {
    let tools = mcp_client::connect_with(config.name.trim(), &config.spec, timeouts)?.list_tools()?;
    Ok(tools.into_iter().map(|t| t.name).collect())
}

// ------------------------------------------------------------------ commands

/// Runs `f` off the main thread: connecting may take seconds.
async fn with_servers<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&Servers) -> T + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>().servers))
        .await
        .map_err(|e| format!("Internal error: {e}"))
}

#[tauri::command]
pub async fn servers_list(app: AppHandle) -> Vec<ServerView> {
    with_servers(app, |s| s.views()).await.unwrap_or_default()
}

#[tauri::command]
pub async fn servers_save(config: ServerConfig, app: AppHandle) -> CmdResult<Vec<ServerView>> {
    with_servers(app, |s| s.save(config).map(|_| s.views())).await?
}

#[tauri::command]
pub async fn servers_remove(id: String, app: AppHandle) -> CmdResult<Vec<ServerView>> {
    with_servers(app, move |s| s.remove(&id).map(|_| s.views())).await?
}

#[tauri::command]
pub async fn servers_set_enabled(id: String, enabled: bool, app: AppHandle) -> CmdResult<Vec<ServerView>> {
    with_servers(app, move |s| s.set_enabled(&id, enabled).map(|_| s.views())).await?
}

#[tauri::command]
pub async fn servers_test(config: ServerConfig, app: AppHandle) -> CmdResult<Vec<String>> {
    with_servers(app, move |s| s.prepare(config).and_then(|c| test_connection(&c, s.timeouts()))).await?
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, sync::Arc, time::{Duration, Instant}};

    use serde_json::json;

    use super::*;
    use crate::mcp_client::tests::{fake_stdio, FakeHttp, Reply, SHORT};

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("docbro-servers-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir.join("nested").join("servers.json")
    }

    fn servers(name: &str) -> (Servers, PathBuf) {
        let path = tmp(name);
        (Servers::at(Ok(path.clone()), Timeouts::default()), path)
    }

    fn config(id: &str, name: &str, enabled: bool, spec: ServerSpec) -> ServerConfig {
        ServerConfig { id: id.into(), name: name.into(), enabled, spec }
    }

    fn http(url: &str, headers: &[(&str, &str)]) -> ServerSpec {
        let headers = headers.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        ServerSpec::Http { url: url.into(), headers }
    }

    fn view<'a>(views: &'a [ServerView], id: &str) -> &'a ServerView {
        views.iter().find(|v| v.id == id).unwrap()
    }

    #[test]
    fn servers_file_is_private_and_views_never_contain_secret_values() {
        let (s, path) = servers("private");
        assert!(s.views().is_empty());
        s.save(config("notes", "Notes", false, http("https://notes.example/mcp", &[("Authorization", "Bearer tok-9f8e7d6c5b")]))).unwrap();
        s.save(config("fs", "Files", false, fake_stdio("1", &[("API_KEY", "sk-live-abcdef123")]))).unwrap();

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // the file is the one place that holds them, and nothing else is left in the folder
        let saved = fs::read_to_string(&path).unwrap();
        assert!(saved.contains("tok-9f8e7d6c5b") && saved.contains("sk-live-abcdef123"));
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);

        let views = s.views();
        let shown = serde_json::to_string(&views).unwrap() + &format!("{views:?}");
        for secret in ["tok-9f8e7d6c5b", "sk-live-abcdef123"] {
            assert!(!shown.contains(secret), "{shown}");
            assert!(!format!("{:?}", s.lock().entries.iter().map(|e| &e.config).collect::<Vec<_>>()).contains(secret));
        }
        let notes = view(&views, "notes");
        assert_eq!(notes.secret_keys, ["Authorization"]);
        assert_eq!((notes.transport.as_str(), notes.summary.as_str(), notes.status.as_str()), ("http", "https://notes.example/mcp", "off"));
        assert_eq!(view(&views, "fs").secret_keys, ["API_KEY", "DOCBRO_FAKE_MCP"]);

        // the list comes back after a restart; a file other users could read is made private
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        }
        let again = Servers::at(Ok(path.clone()), Timeouts::default());
        assert_eq!(again.views(), views);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // a corrupt file is an empty list
        fs::write(&path, "{ not json").unwrap();
        assert!(Servers::at(Ok(path.clone()), Timeouts::default()).views().is_empty());
        assert!(config_path().unwrap().ends_with("com.jetorbit.docbro/servers.json"));
    }

    #[test]
    fn editing_with_empty_secret_values_keeps_the_saved_ones() {
        let (s, path) = servers("keep");
        s.save(config("notes", "Notes", false, http("https://a.example/mcp", &[("Authorization", "Bearer old-secret-1"), ("X-Team", "team-one")]))).unwrap();
        // the form only knows the names: an empty value means "unchanged", a new one replaces it
        s.save(config("notes", "Notes 2", false, http("https://b.example/mcp", &[("Authorization", ""), ("X-Team", "team-two")]))).unwrap();
        let saved = fs::read_to_string(&path).unwrap();
        assert!(saved.contains("old-secret-1") && saved.contains("team-two") && !saved.contains("team-one"), "{saved}");
        assert_eq!(s.views().len(), 1);
        assert_eq!(s.views()[0].name, "Notes 2");
        // a key left out is removed
        s.save(config("notes", "Notes", false, http("https://b.example/mcp", &[]))).unwrap();
        assert!(s.views()[0].secret_keys.is_empty());
    }

    #[test]
    fn saving_rejects_empty_names_commands_and_non_http_urls() {
        let (s, path) = servers("reject");
        let stdio = |command: &str| ServerSpec::Stdio { command: command.into(), args: vec![], env: BTreeMap::new() };
        let cases = [
            (config("a", "  ", false, http("https://x.example/mcp", &[])), "name"),
            (config("a", "A", false, stdio("")), "command"),
            (config("a", "A", false, stdio("   ")), "command"),
            (config("a", "A", false, http("ftp://x.example/mcp", &[])), "http://"),
            (config("a", "A", false, http("javascript:alert(1)", &[])), "http://"),
            (config("a", "A", false, http("x.example/mcp", &[])), "http://"),
            (config("a", "A", false, http("https://x.example/mcp", &[("X-Key", "v\r\nX-Evil: 1")])), "line break"),
        ];
        for (bad, why) in cases {
            let e = s.save(bad.clone()).unwrap_err();
            assert!(e.contains(why), "{bad:?}: {e}");
            assert!(s.prepare(bad).is_err());
        }
        assert!(s.views().is_empty());
        assert!(!path.exists());
    }

    #[test]
    fn the_reserved_id_docbro_is_refused() {
        let (s, _) = servers("ids");
        let spec = http("https://x.example/mcp", &[]);
        let e = s.save(config("docbro", "Mine", false, spec.clone())).unwrap_err();
        assert!(e.contains("reserved"), "{e}");
        for bad in ["", "Notes", "a b", "a.b", "é", "a__b", &"a".repeat(MAX_ID + 1)] {
            assert!(s.save(config(bad, "X", false, spec.clone())).is_err(), "{bad:?}");
        }
        for good in ["notes", "my-notes_2", "0"] {
            s.save(config(good, "X", false, spec.clone())).unwrap();
        }
        assert_eq!(s.views().len(), 3);
    }

    #[test]
    fn a_failing_server_is_skipped_and_marked_error_while_others_still_list_tools() {
        let path = tmp("failing");
        let s = Servers::at(Ok(path), SHORT);
        let good = FakeHttp::standard();
        let hung = FakeHttp::start(|_, _| Reply::status(200, "").stall());
        let missing = ServerSpec::Stdio { command: "docbro-no-such-program".into(), args: vec![], env: BTreeMap::new() };
        s.save(config("good", "Good", true, good.spec(&[]))).unwrap();
        s.save(config("hung", "Hung server", true, hung.spec(&[]))).unwrap();
        s.save(config("gone", "Gone server", true, missing)).unwrap();

        let tools = s.tools_for(None);
        let got: Vec<(&str, &str)> = tools.iter().map(|(id, t)| (id.as_str(), t.name.as_str())).collect();
        assert_eq!(got, [("good", "echo"), ("good", "fail"), ("good", "env"), ("good", "pid")]);
        let views = s.views();
        assert_eq!((view(&views, "good").status.as_str(), view(&views, "good").tools), ("ready", 4));
        for (id, name) in [("hung", "Hung server"), ("gone", "Gone server")] {
            let v = view(&views, id);
            assert_eq!(v.status, "error");
            assert!(v.error.as_deref().unwrap().starts_with(name), "{v:?}");
        }
        assert_eq!(s.tools_for(Some("good")).len(), 4);
        assert!(s.tools_for(Some("gone")).is_empty());
        assert!(!s.call("good", "echo", &json!({})).unwrap().is_error);
        assert!(s.call("gone", "echo", &json!({})).unwrap_err().starts_with("Gone server"));
        assert!(s.call("nobody", "echo", &json!({})).is_err());
        // the good server was connected once and kept
        assert_eq!(good.seen().iter().filter(|r| r.body["method"] == "initialize").count(), 1);
    }

    #[test]
    fn hung_servers_are_waited_for_together() {
        let s = Servers::at(Ok(tmp("together")), SHORT);
        let hung: Vec<FakeHttp> = (0..4).map(|_| FakeHttp::start(|_, _| Reply::status(200, "").stall())).collect();
        for (i, fake) in hung.iter().enumerate() {
            s.save(config(&format!("h{i}"), "Hung", true, fake.spec(&[]))).unwrap();
        }
        let started = std::time::Instant::now();
        assert!(s.tools_for(None).is_empty());
        // one after another would take 4 x 400 ms
        assert!(started.elapsed() < Duration::from_millis(1200), "{:?}", started.elapsed());
        assert!(s.views().iter().all(|v| v.status == "error"));
    }

    #[test]
    fn a_disabled_server_is_never_started() {
        let (s, path) = servers("disabled");
        let mark = path.with_file_name("started");
        let fake = FakeHttp::standard();
        let stdio = fake_stdio("1", &[("DOCBRO_FAKE_MARK", &mark.to_string_lossy())]);
        s.save(config("web", "Web", false, fake.spec(&[]))).unwrap();
        s.save(config("local", "Local", false, stdio.clone())).unwrap();
        s.set_enabled("web", false).unwrap();

        assert!(s.tools_for(None).is_empty());
        assert!(s.tools_for(Some("local")).is_empty());
        let e = s.call("local", "echo", &json!({})).unwrap_err();
        assert!(e.contains("Local is off"), "{e}");
        assert!(s.views().iter().all(|v| v.status == "off" && v.tools == 0));
        std::thread::sleep(Duration::from_millis(300));
        assert!(!mark.exists(), "the stdio server was started");
        assert!(fake.seen().is_empty(), "the HTTP server got a request");

        // switching it on is what starts it
        s.set_enabled("local", true).unwrap();
        assert!(mark.exists());
        assert_eq!(view(&s.views(), "local").tools, 4);
        assert!(fake.seen().is_empty());
        assert!(s.set_enabled("nobody", true).is_err());
    }

    #[cfg(unix)]
    fn alive(pid: &str) -> bool {
        std::process::Command::new("kill").args(["-0", pid]).stderr(std::process::Stdio::null()).status().unwrap().success()
    }

    #[cfg(unix)]
    #[test]
    fn saving_switching_off_or_removing_stops_the_running_server() {
        let (s, _) = servers("stops");
        let spec = fake_stdio("stubborn", &[]);
        s.save(config("local", "Local", true, spec.clone())).unwrap();
        let pid = |s: &Servers| s.call("local", "pid", &json!({})).unwrap().text;
        let gone = |pid: &str| (0..50).any(|_| { std::thread::sleep(Duration::from_millis(20)); !alive(pid) });

        assert_eq!(view(&s.views(), "local").tools, 4, "saving it switched on connects");
        let first = pid(&s);
        s.save(config("local", "Local", true, spec.clone())).unwrap();
        assert!(gone(&first), "saving left {first} running");
        let second = pid(&s);
        assert_ne!(first, second);
        s.set_enabled("local", false).unwrap();
        assert!(gone(&second), "switching off left {second} running");
        s.set_enabled("local", true).unwrap();
        let third = pid(&s);
        s.remove("local").unwrap();
        assert!(gone(&third), "removing left {third} running");
        assert!(s.views().is_empty());
    }

    #[test]
    fn testing_a_config_connects_without_saving_it() {
        let (s, path) = servers("test");
        let fake = FakeHttp::standard();
        let config = s.prepare(config("web", "Web", false, fake.spec(&[]))).unwrap();
        assert_eq!(test_connection(&config, SHORT).unwrap(), ["echo", "fail", "env", "pid"]);
        assert!(!path.exists() && s.views().is_empty());
        let hung = FakeHttp::start(|_, _| Reply::status(200, "").stall());
        let e = test_connection(&s.prepare(config_for(&hung)).unwrap(), SHORT).unwrap_err();
        assert!(e.starts_with("Hung: "), "{e}");
    }

    fn config_for(fake: &FakeHttp) -> ServerConfig {
        config("hung", "Hung", true, fake.spec(&[]))
    }

    fn slow_calls(ms: u64) -> FakeHttp {
        FakeHttp::start(move |m, _| {
            if m["method"] == "tools/call" {
                std::thread::sleep(Duration::from_millis(ms));
            }
            Reply::standard(m)
        })
    }

    fn initializes(fake: &FakeHttp) -> usize {
        fake.seen().iter().filter(|r| r.body["method"] == "initialize").count()
    }

    #[test]
    fn a_slow_tool_call_does_not_block_servers_list_or_set_enabled() {
        let fake = slow_calls(1500);
        let (s, _) = servers("slow-call");
        s.save(config("slow", "Slow", true, fake.spec(&[]))).unwrap();
        thread::scope(|scope| {
            let call = scope.spawn(|| s.call("slow", "echo", &json!({})));
            std::thread::sleep(Duration::from_millis(300));
            let started = Instant::now();
            assert_eq!(s.views().len(), 1);
            s.set_enabled("slow", false).unwrap();
            assert!(started.elapsed() < Duration::from_millis(200), "{:?}", started.elapsed());
            assert_eq!(s.views()[0].status, "off");
            // the call that was running still gets its answer
            assert!(!call.join().unwrap().unwrap().is_error);
        });
        assert!(s.call("slow", "echo", &json!({})).unwrap_err().contains("Slow is off"));
    }

    #[cfg(unix)]
    #[test]
    fn switching_a_server_off_during_a_connect_discards_the_new_connection() {
        let (s, path) = servers("off-while-connecting");
        let mark = path.with_file_name("pid");
        let spec = fake_stdio("slowstart", &[("DOCBRO_FAKE_MARK", &mark.to_string_lossy())]);
        s.save(config("local", "Local", false, spec)).unwrap();
        thread::scope(|scope| {
            let on = scope.spawn(|| s.set_enabled("local", true));
            let started = (0..250).any(|_| {
                std::thread::sleep(Duration::from_millis(20));
                fs::read_to_string(&mark).is_ok_and(|p| !p.is_empty())
            });
            assert!(started, "the server never started");
            // it is still in its slow start: switching off must not wait for it
            let off = Instant::now();
            s.set_enabled("local", false).unwrap();
            assert!(off.elapsed() < Duration::from_millis(300), "{:?}", off.elapsed());
            on.join().unwrap().unwrap();
        });
        let pid = fs::read_to_string(&mark).unwrap();
        let gone = (0..100).any(|_| {
            std::thread::sleep(Duration::from_millis(20));
            !alive(&pid)
        });
        assert!(gone, "the connection made for the switched-off server is still running ({pid})");
        let v = &s.views()[0];
        assert_eq!((v.status.as_str(), v.tools), ("off", 0));
        assert!(s.lock().entries[0].live.is_none());
    }

    #[test]
    fn two_calls_to_different_servers_run_in_parallel() {
        let (a, b) = (slow_calls(800), slow_calls(800));
        let (s, _) = servers("parallel");
        s.save(config("a", "A", true, a.spec(&[]))).unwrap();
        s.save(config("b", "B", true, b.spec(&[]))).unwrap();
        let started = Instant::now();
        thread::scope(|scope| {
            let calls = [scope.spawn(|| s.call("a", "echo", &json!({}))), scope.spawn(|| s.call("b", "echo", &json!({})))];
            for call in calls {
                assert!(!call.join().unwrap().unwrap().is_error);
            }
        });
        // one after the other would take 1600 ms
        assert!(started.elapsed() < Duration::from_millis(1400), "{:?}", started.elapsed());
    }

    #[test]
    fn a_failed_server_is_not_retried_before_its_backoff_and_is_afterwards() {
        use std::sync::atomic::{AtomicBool, Ordering};
        assert_eq!(RETRY_AFTER, Duration::from_secs(30));
        let up = Arc::new(AtomicBool::new(false));
        let flag = up.clone();
        let fake = FakeHttp::start(move |m, _| if flag.load(Ordering::SeqCst) { Reply::standard(m) } else { Reply::status(503, "") });
        let (s, _) = servers("backoff");
        s.lock().retry_after = Duration::from_millis(500);
        s.save(config("web", "Web", true, fake.spec(&[]))).unwrap();
        assert_eq!((initializes(&fake), s.views()[0].status.as_str()), (1, "error"));

        up.store(true, Ordering::SeqCst);
        assert!(s.tools_for(None).is_empty());
        assert!(s.call("web", "echo", &json!({})).unwrap_err().contains("503"));
        assert_eq!(initializes(&fake), 1, "retried before the backoff ran out");

        std::thread::sleep(Duration::from_millis(700));
        assert_eq!(s.tools_for(None).len(), 4);
        assert_eq!(initializes(&fake), 2);
        assert_eq!((s.views()[0].status.as_str(), s.views()[0].error.as_deref()), ("ready", None));

        // switching it on again is the user asking: that retries at once
        up.store(false, Ordering::SeqCst);
        s.set_enabled("web", false).unwrap();
        s.set_enabled("web", true).unwrap();
        assert_eq!((initializes(&fake), s.views()[0].status.as_str()), (3, "error"));
        up.store(true, Ordering::SeqCst);
        s.set_enabled("web", true).unwrap();
        assert_eq!((initializes(&fake), s.views()[0].status.as_str()), (4, "ready"));
    }

    #[test]
    fn a_call_error_resets_only_the_connection_it_used() {
        let fake = FakeHttp::start(|m, _| {
            if m["params"]["name"] == "slow" {
                std::thread::sleep(Duration::from_secs(3));
            }
            Reply::standard(m)
        });
        let timeouts = Timeouts { handshake: Duration::from_secs(5), call: Duration::from_millis(800) };
        let s = Servers::at(Ok(tmp("only-its-own")), timeouts);
        s.save(config("web", "Web", true, fake.spec(&[]))).unwrap();
        thread::scope(|scope| {
            let call = scope.spawn(|| s.call("web", "slow", &json!({})));
            std::thread::sleep(Duration::from_millis(200));
            // re-saving makes a new connection while the old one's call is still running
            s.save(config("web", "Web", true, fake.spec(&[]))).unwrap();
            let e = call.join().unwrap().unwrap_err();
            assert!(e.starts_with("Web: ") && e.contains("within 800 ms"), "{e}");
        });
        let v = &s.views()[0];
        assert_eq!((v.status.as_str(), v.tools, v.error.as_deref()), ("ready", 4, None));
        assert!(!s.call("web", "echo", &json!({})).unwrap().is_error);
        assert_eq!(initializes(&fake), 2, "the new connection was thrown away");

        // a failure on the connection in use does reset it
        assert!(s.call("web", "slow", &json!({})).is_err());
        assert_eq!(s.views()[0].status, "error");
        assert!(s.lock().entries[0].live.is_none());
    }

    /// Connect A succeeds at about 300 ms; connect B, started earlier, fails at about 900 ms
    /// (a server that cannot run twice). B must not undo A.
    #[test]
    fn a_failed_duplicate_connect_leaves_the_good_connection_alone() {
        use std::sync::atomic::{AtomicUsize, Ordering};
        let count = Arc::new(AtomicUsize::new(0));
        let seen = count.clone();
        let fake = FakeHttp::start(move |m, _| {
            if m["method"] != "initialize" {
                return Reply::standard(m);
            }
            match seen.fetch_add(1, Ordering::SeqCst) {
                0 => {
                    std::thread::sleep(Duration::from_millis(900));
                    Reply::status(503, "")
                }
                _ => {
                    std::thread::sleep(Duration::from_millis(300));
                    Reply::standard(m)
                }
            }
        });
        let (s, _) = servers("duplicate");
        s.save(config("web", "Web", false, fake.spec(&[]))).unwrap();
        // switched on without the connect that `set_enabled` would start
        s.lock().entries[0].config.enabled = true;
        let (b, a) = thread::scope(|scope| {
            let b = scope.spawn(|| s.connect("web", false));
            while count.load(Ordering::SeqCst) == 0 {
                std::thread::sleep(Duration::from_millis(5));
            }
            let a = scope.spawn(|| s.connect("web", false));
            (b.join().unwrap(), a.join().unwrap())
        });
        let a = a.unwrap();
        // the failed one gets the working connection instead of its error
        assert!(Arc::ptr_eq(&a, &b.unwrap()));
        assert_eq!(initializes(&fake), 2);
        {
            let reg = s.lock();
            let e = &reg.entries[0];
            assert!(e.live.as_ref().is_some_and(|l| Arc::ptr_eq(l, &a)));
            assert!(e.error.is_none() && e.failed_at.is_none(), "{:?}", e.error);
        }
        let v = &s.views()[0];
        assert_eq!((v.status.as_str(), v.tools, v.error.as_deref()), ("ready", 4, None));
        assert!(!s.call("web", "echo", &json!({})).unwrap().is_error);
        assert_eq!(initializes(&fake), 2, "the good connection was replaced");
    }

    #[test]
    fn two_successful_connects_keep_one_connection() {
        let fake = FakeHttp::start(|m, _| {
            if m["method"] == "initialize" {
                std::thread::sleep(Duration::from_millis(300));
            }
            Reply::standard(m)
        });
        let (s, _) = servers("two-successes");
        s.save(config("web", "Web", false, fake.spec(&[]))).unwrap();
        s.lock().entries[0].config.enabled = true;
        let (a, b) = thread::scope(|scope| {
            let a = scope.spawn(|| s.connect("web", false));
            let b = scope.spawn(|| s.connect("web", false));
            (a.join().unwrap().unwrap(), b.join().unwrap().unwrap())
        });
        // both callers get the one that was installed; the other was dropped
        assert!(Arc::ptr_eq(&a, &b));
        assert_eq!(initializes(&fake), 2);
        assert_eq!(Arc::strong_count(&a), 3, "the entry and the two callers hold it, nothing else");
        let v = &s.views()[0];
        assert_eq!((v.status.as_str(), v.tools), ("ready", 4));
    }
}
