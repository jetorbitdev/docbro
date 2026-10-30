//! The user's MCP servers: their settings in `servers.json` (private to the user, since header
//! and env values are secrets) and the live connections the Assistant uses. A server is only
//! ever started while it is switched on.

use std::{
    fs,
    path::{Path, PathBuf},
    thread,
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

struct Entry {
    config: ServerConfig,
    live: Option<Box<dyn Connection>>,
    tools: Vec<ToolInfo>,
    error: Option<String>,
}

impl Entry {
    fn new(config: ServerConfig) -> Entry {
        Entry { config, live: None, tools: Vec::new(), error: None }
    }

    /// Stops the server, if it runs, and forgets what it said.
    fn reset(&mut self) {
        self.live = None;
        self.tools.clear();
        self.error = None;
    }

    /// Connects to the server unless it is connected already, and lists its tools. A failure
    /// is kept for the status.
    fn connect(&mut self, timeouts: Timeouts) -> CmdResult<()> {
        if !self.config.enabled {
            return Err(format!("{} is off. Switch it on in MCP settings.", self.config.name));
        }
        if self.live.is_some() {
            return Ok(());
        }
        let connected = mcp_client::connect_with(&self.config.name, &self.config.spec, timeouts)
            .and_then(|mut conn| conn.list_tools().map(|tools| (conn, tools)));
        match connected {
            Ok((conn, tools)) => {
                (self.live, self.tools, self.error) = (Some(conn), tools, None);
                Ok(())
            }
            Err(e) => {
                self.reset();
                self.error = Some(e.clone());
                Err(e)
            }
        }
    }

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

/// Settings plus live connections; kept in `AppState`.
pub struct Servers {
    entries: Vec<Entry>,
    /// where the settings are saved
    file: CmdResult<PathBuf>,
    timeouts: Timeouts,
}

impl Servers {
    /// A missing or unreadable file is an empty list.
    pub fn load() -> Servers {
        Servers::at(config_path(), Timeouts::default())
    }

    fn at(file: CmdResult<PathBuf>, timeouts: Timeouts) -> Servers {
        let configs = file.as_deref().map(load_from).unwrap_or_default();
        Servers { entries: configs.into_iter().map(Entry::new).collect(), file, timeouts }
    }

    fn find(&self, id: &str) -> CmdResult<usize> {
        self.entries.iter().position(|e| e.config.id == id).ok_or_else(|| format!("There is no MCP server {id}"))
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

    pub fn views(&self) -> Vec<ServerView> {
        self.entries.iter().map(Entry::view).collect()
    }

    /// Adds `config`, or replaces the server with its id, stopping the old connection. A server
    /// saved switched on is connected at once, as when it is switched on.
    pub fn save(&mut self, config: ServerConfig) -> CmdResult<()> {
        let config = self.prepare(config)?;
        let index = self.find(&config.id).ok();
        let saved = config.clone();
        self.persist(self.configs_with(|all| match index {
            Some(i) => all[i] = saved,
            None => all.push(saved),
        }))?;
        let index = match index {
            Some(i) => {
                self.entries[i].reset();
                self.entries[i].config = config;
                i
            }
            None => {
                self.entries.push(Entry::new(config));
                self.entries.len() - 1
            }
        };
        if self.entries[index].config.enabled {
            // a failure shows in the server's status
            let _ = self.entries[index].connect(self.timeouts);
        }
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> CmdResult<()> {
        let Ok(index) = self.find(id) else { return Ok(()) };
        self.persist(self.configs_with(|all| {
            all.remove(index);
        }))?;
        self.entries.remove(index);
        Ok(())
    }

    /// Switching a server on connects to it at once, so its status shows whether it works.
    pub fn set_enabled(&mut self, id: &str, enabled: bool) -> CmdResult<()> {
        let index = self.find(id)?;
        if self.entries[index].config.enabled != enabled {
            self.persist(self.configs_with(|all| all[index].enabled = enabled))?;
            self.entries[index].config.enabled = enabled;
        }
        if enabled {
            // a failure shows in the server's status
            let _ = self.entries[index].connect(self.timeouts);
        } else {
            self.entries[index].reset();
        }
        Ok(())
    }

    /// The tools of every enabled server, or of server `only`, connecting to them as needed.
    /// A server that fails is skipped and shows the error in its status.
    #[allow(dead_code)] // the Assistant's chat loop (Task 16) calls it
    pub fn tools_for(&mut self, only: Option<&str>) -> Vec<(String, ToolInfo)> {
        let timeouts = self.timeouts;
        let wanted = |e: &Entry| e.config.enabled && only.is_none_or(|id| id == e.config.id);
        // all at once, so servers that hang cost one timeout, not one each
        thread::scope(|scope| {
            for entry in self.entries.iter_mut().filter(|e| wanted(e) && e.live.is_none()) {
                scope.spawn(move || entry.connect(timeouts));
            }
        });
        self.entries
            .iter()
            .filter(|e| wanted(e) && e.live.is_some())
            .flat_map(|e| e.tools.iter().map(|t| (e.config.id.clone(), t.clone())))
            .collect()
    }

    /// Calls a tool of an enabled server. When the connection fails (it timed out or the
    /// server went away), the server shows the error and reconnects on its next use.
    #[allow(dead_code)] // the Assistant's chat loop (Task 16) calls it
    pub fn call(&mut self, server_id: &str, tool: &str, args: &Value) -> Result<ToolOutput, String> {
        let index = self.find(server_id)?;
        let entry = &mut self.entries[index];
        entry.connect(self.timeouts)?;
        let live = entry.live.as_mut().ok_or("Not connected")?;
        live.call_tool(tool, args).inspect_err(|e| {
            entry.reset();
            entry.error = Some(e.clone());
        })
    }

    /// `config` checked and ready to connect to, with the secrets it leaves empty taken from
    /// the saved server it edits.
    fn prepare(&self, mut config: ServerConfig) -> CmdResult<ServerConfig> {
        config.name = config.name.trim().to_string();
        match &mut config.spec {
            ServerSpec::Http { url, .. } => *url = url.trim().to_string(),
            ServerSpec::Stdio { command, .. } => *command = command.trim().to_string(),
        }
        if let Ok(index) = self.find(&config.id) {
            let old = &self.entries[index].config.spec;
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
}

/// Connects without saving and returns the server's tool names.
fn test_connection(config: &ServerConfig, timeouts: Timeouts) -> CmdResult<Vec<String>> {
    let tools = mcp_client::connect_with(config.name.trim(), &config.spec, timeouts)?.list_tools()?;
    Ok(tools.into_iter().map(|t| t.name).collect())
}

// ------------------------------------------------------------------ commands

/// Runs `f` on the server list off the main thread: connecting may take seconds.
async fn with_servers<T: Send + 'static>(
    app: AppHandle,
    f: impl FnOnce(&mut Servers) -> T + Send + 'static,
) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || f(&mut app.state::<AppState>().servers.lock_recovering()))
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
    let (config, timeouts) = with_servers(app, |s| s.prepare(config).map(|c| (c, s.timeouts))).await??;
    tauri::async_runtime::spawn_blocking(move || test_connection(&config, timeouts))
        .await
        .map_err(|e| format!("Internal error: {e}"))?
}

#[cfg(test)]
mod tests {
    use std::{collections::BTreeMap, time::Duration};

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
        let (mut s, path) = servers("private");
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
            assert!(!format!("{:?}", s.entries.iter().map(|e| &e.config).collect::<Vec<_>>()).contains(secret));
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
        let (mut s, path) = servers("keep");
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
        let (mut s, path) = servers("reject");
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
        let (mut s, _) = servers("ids");
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
        let mut s = Servers::at(Ok(path), SHORT);
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
        let mut s = Servers::at(Ok(tmp("together")), SHORT);
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
        let (mut s, path) = servers("disabled");
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
        let (mut s, _) = servers("stops");
        let spec = fake_stdio("stubborn", &[]);
        s.save(config("local", "Local", true, spec.clone())).unwrap();
        let pid = |s: &mut Servers| s.call("local", "pid", &json!({})).unwrap().text;
        let gone = |pid: &str| (0..50).any(|_| { std::thread::sleep(Duration::from_millis(20)); !alive(pid) });

        assert_eq!(view(&s.views(), "local").tools, 4, "saving it switched on connects");
        let first = pid(&mut s);
        s.save(config("local", "Local", true, spec.clone())).unwrap();
        assert!(gone(&first), "saving left {first} running");
        let second = pid(&mut s);
        assert_ne!(first, second);
        s.set_enabled("local", false).unwrap();
        assert!(gone(&second), "switching off left {second} running");
        s.set_enabled("local", true).unwrap();
        let third = pid(&mut s);
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
}
