//! Upload to Google Docs: the user's Google account, connected once through the browser, and the
//! upload of the open document as a Google Doc. Uploading the same file again updates the Google
//! Doc it made the first time, so its link and its sharing stay as they were.
//!
//! DocBro signs in the way Google asks desktop apps to: the browser shows Google's own sign-in
//! page and sends the answer back to a listener on 127.0.0.1 that exists only for that sign-in,
//! with PKCE, so another program that catches the answer cannot use it. DocBro asks only for
//! `drive.file`: it reaches the files it uploaded itself, and nothing else in the user's Drive.
//!
//! The refresh token, the access token and the OAuth client's secret stay in Rust, in
//! `google.json` (private to the user). They go only to Google's OAuth and Drive addresses,
//! redirects are not followed, and none of them is logged or put in an error message.

use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use percent_encoding::{percent_decode_str, utf8_percent_encode, NON_ALPHANUMERIC};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager, State,
};

use crate::{files, AppState, CmdResult, LockExt};

/// Same as `identifier` in tauri.conf.json.
const APP_ID: &str = "com.jetorbit.docbro";
const SCOPE: &str = "https://www.googleapis.com/auth/drive.file";
const DOCX: &str = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const GOOGLE_DOC: &str = "application/vnd.google-apps.document";

/// The OAuth client a build can carry, so its users only have to sign in. A client the user
/// enters in MCP settings takes its place.
const BUILT_IN_ID: Option<&str> = option_env!("DOCBRO_GOOGLE_CLIENT_ID");
const BUILT_IN_SECRET: Option<&str> = option_env!("DOCBRO_GOOGLE_CLIENT_SECRET");

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const RESPONSE_TIMEOUT: Duration = Duration::from_secs(120);
/// How long a sign-in waits for the browser.
const SIGN_IN_WAIT: Duration = Duration::from_secs(5 * 60);
/// An access token this close to running out is renewed first.
const RENEW_BEFORE: Duration = Duration::from_secs(60);
/// Google Docs converts Word files up to 50 MB.
const MAX_UPLOAD: usize = 50 * 1024 * 1024;

pub(crate) const NO_CLIENT: &str =
    "Google Docs needs an OAuth client first. Enter its client ID and secret under Google Docs in MCP settings.";
pub(crate) const NOT_CONNECTED: &str = "Connect your Google account under Google Docs in MCP settings first.";
const SIGNED_OUT: &str = "Google no longer accepts DocBro's access. Connect your Google account again in MCP settings.";
const UNREACHABLE: &str = "Could not reach Google. Check the internet connection and try again.";
const CANCELLED: &str = "The sign-in was cancelled.";
const TIMED_OUT: &str = "The sign-in timed out. Press Connect to try again.";
const DENIED: &str = "Google sign-in was declined, so DocBro is not connected.";
const NOT_A_CLIENT_ID: &str = "That is not an OAuth client ID. It ends in .apps.googleusercontent.com.";
const NO_SECRET: &str = "Enter the client secret too.";
const TOO_LARGE: &str = "The document is over 50 MB, more than Google Docs takes from a Word file.";

// -------------------------------------------------------------------- config

/// What `google.json` holds. No `Debug`: it carries the secret and the refresh token.
#[derive(Serialize, Deserialize, Default)]
#[serde(default)]
struct Config {
    /// the user's own OAuth client; empty uses the build's
    #[serde(skip_serializing_if = "String::is_empty")]
    client_id: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    client_secret: String,
    #[serde(skip_serializing_if = "String::is_empty")]
    refresh_token: String,
    /// the client the refresh token was given to: it works with that client only
    #[serde(skip_serializing_if = "String::is_empty")]
    token_client: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    email: Option<String>,
    /// the Google Doc made from each file, by the file's path
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    links: BTreeMap<String, String>,
}

/// An OAuth client: its ID, and the secret Google gives desktop apps with it.
#[derive(Clone, PartialEq)]
struct Client {
    id: String,
    secret: String,
}

/// What the webview may know: the client's ID and its secret's last four characters, never a token.
#[derive(Serialize, Debug, PartialEq)]
pub struct Status {
    /// the OAuth client DocBro signs in with, empty when there is none
    pub client_id: String,
    /// the user entered this client; otherwise it is the one the build carries
    pub custom_client: bool,
    /// the build carries a client, used when the user enters none
    pub built_in: bool,
    pub secret_hint: Option<String>,
    pub connected: bool,
    /// the Google account connected
    pub email: Option<String>,
    /// a sign-in is waiting for the browser
    pub signing_in: bool,
}

/// One upload's outcome.
#[derive(Serialize, Debug, PartialEq)]
pub struct Uploaded {
    pub file_id: String,
    pub url: String,
    /// a new Google Doc; false when the one made before was updated
    pub created: bool,
}

fn config_path() -> CmdResult<PathBuf> {
    dirs::config_dir()
        .map(|d| d.join(APP_ID).join("google.json"))
        .ok_or_else(|| "No config directory".to_string())
}

/// A missing or broken file is no settings.
fn read_config(path: &Path) -> Config {
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
    fs::read_to_string(path).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default()
}

/// The last four characters of `secret`; none for a short one, which would give most of itself away.
fn hint(secret: &str) -> Option<String> {
    let chars: Vec<char> = secret.chars().collect();
    (chars.len() > 8).then(|| chars[chars.len() - 4..].iter().collect())
}

// ----------------------------------------------------------------- endpoints

/// Where DocBro talks to Google; tests point them at a local server.
#[derive(Clone)]
pub(crate) struct Endpoints {
    auth: String,
    token: String,
    revoke: String,
    drive: String,
    upload: String,
}

impl Endpoints {
    fn google() -> Endpoints {
        Endpoints {
            auth: "https://accounts.google.com/o/oauth2/v2/auth".into(),
            token: "https://oauth2.googleapis.com/token".into(),
            revoke: "https://oauth2.googleapis.com/revoke".into(),
            drive: "https://www.googleapis.com/drive/v3".into(),
            upload: "https://www.googleapis.com/upload/drive/v3".into(),
        }
    }
}

fn agent() -> ureq::Agent {
    ureq::Agent::config_builder()
        // a redirect could carry a token to another host
        .max_redirects(0)
        .proxy(ureq::Proxy::try_from_env())
        .http_status_as_error(false)
        .user_agent(concat!("DocBro/", env!("CARGO_PKG_VERSION")))
        .timeout_connect(Some(CONNECT_TIMEOUT))
        .timeout_recv_response(Some(RESPONSE_TIMEOUT))
        .build()
        .into()
}

type Response = ureq::http::Response<ureq::Body>;

/// `pairs` as `application/x-www-form-urlencoded`.
fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(k, v)| format!("{k}={}", utf8_percent_encode(v, NON_ALPHANUMERIC)))
        .collect::<Vec<_>>()
        .join("&")
}

/// At most 64 KiB of a failed answer, with every secret in `hide` taken out.
fn answer_text(res: Response, hide: &[&str]) -> (u16, String) {
    let status = res.status().as_u16();
    let mut body = Vec::new();
    let _ = res.into_body().into_reader().take(64 * 1024).read_to_end(&mut body);
    let mut text = String::from_utf8_lossy(&body).into_owned();
    for secret in hide.iter().filter(|s| !s.is_empty()) {
        text = text.replace(secret, "[hidden]");
    }
    (status, text)
}

/// Google's own words for a failure: `error.message` from the Drive API, `error_description` or
/// `error` from OAuth.
fn google_message(text: &str) -> String {
    let parsed: Value = serde_json::from_str(text).unwrap_or(Value::Null);
    let message = parsed["error"]["message"]
        .as_str()
        .or(parsed["error_description"].as_str())
        .or(parsed["error"].as_str())
        .unwrap_or(text.trim());
    message.chars().take(300).collect()
}

fn read_json(res: Response, what: &str) -> CmdResult<Value> {
    let failed = || format!("Google sent an answer DocBro could not read ({what}). Try again.");
    let text = res.into_body().read_to_string().map_err(|_| failed())?;
    serde_json::from_str(&text).map_err(|_| failed())
}

// ------------------------------------------------------------------- PKCE

fn random_text(bytes: usize) -> CmdResult<String> {
    let mut buf = vec![0u8; bytes];
    getrandom::fill(&mut buf).map_err(|e| format!("No secure random source: {e}"))?;
    Ok(base64url(&buf))
}

/// Base64url without padding, as PKCE and Google's state use it.
fn base64url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = chunk.iter().enumerate().fold(0u32, |n, (i, b)| n | (*b as u32) << (16 - 8 * i));
        for i in 0..=chunk.len() {
            out.push(ALPHABET[(n >> (18 - 6 * i) & 63) as usize] as char);
        }
    }
    out
}

fn challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

/// The query of a request target like `/?code=…&state=…`, decoded.
fn query(target: &str) -> BTreeMap<String, String> {
    let Some((_, query)) = target.split_once('?') else { return BTreeMap::new() };
    query
        .split('&')
        .filter_map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            let decode = |s: &str| percent_decode_str(&s.replace('+', " ")).decode_utf8().ok().map(|c| c.into_owned());
            Some((decode(k)?, decode(v)?))
        })
        .collect()
}

/// A Drive file id: what Google makes them of, so it can go in a URL as it is.
fn valid_file_id(id: &str) -> bool {
    (10..=200).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

/// The Google Cloud Console pages that set up an OAuth client, by the name the settings use.
pub(crate) fn console_url(page: &str) -> Option<&'static str> {
    match page {
        "drive_api" => Some("https://console.cloud.google.com/apis/library/drive.googleapis.com"),
        "oauth_client" => Some("https://console.cloud.google.com/apis/credentials/oauthclient"),
        _ => None,
    }
}

pub(crate) fn doc_url(id: &str) -> String {
    format!("https://docs.google.com/document/d/{id}/edit")
}

// ------------------------------------------------------------------- state

/// An access token, renewed from the refresh token when it runs out. No `Debug`.
struct Access {
    token: String,
    until: Instant,
    /// the refresh token it came from: a new connection makes it stale
    from: String,
}

/// The settings, read from the file whenever they are needed, and what one run keeps in memory;
/// kept in `AppState`.
pub struct Google {
    file: CmdResult<PathBuf>,
    endpoints: Endpoints,
    built_in: Option<Client>,
    /// changes read the file, change it and write it back: they take turns
    saving: Mutex<()>,
    access: Mutex<Option<Access>>,
    /// the sign-in waiting for the browser, which setting this flag stops
    signing_in: Mutex<Option<Arc<AtomicBool>>>,
    /// one upload at a time, so two uploads of a new file never make two Google Docs
    uploading: Mutex<()>,
}

impl Google {
    pub fn load() -> Google {
        let built_in = match (BUILT_IN_ID, BUILT_IN_SECRET) {
            (Some(id), Some(secret)) if !id.is_empty() => Some(Client { id: id.into(), secret: secret.into() }),
            _ => None,
        };
        Google::at(config_path(), Endpoints::google(), built_in)
    }

    fn at(file: CmdResult<PathBuf>, endpoints: Endpoints, built_in: Option<Client>) -> Google {
        Google {
            file,
            endpoints,
            built_in,
            saving: Mutex::new(()),
            access: Mutex::new(None),
            signing_in: Mutex::new(None),
            uploading: Mutex::new(()),
        }
    }

    fn config(&self) -> Config {
        self.file.as_deref().map(read_config).unwrap_or_default()
    }

    fn write(&self, config: &Config) -> CmdResult<()> {
        let path = self.file.as_deref().map_err(Clone::clone)?;
        let failed = |e: String| format!("Could not save the Google Docs settings: {e}");
        fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(|e| failed(e.to_string()))?;
        let json = serde_json::to_string_pretty(config).map_err(|e| failed(e.to_string()))?;
        files::write_private(path, json.as_bytes()).map_err(failed)
    }

    /// Reads the settings, lets `f` change them, and writes them back, one change at a time.
    fn change<T>(&self, f: impl FnOnce(&mut Config) -> CmdResult<T>) -> CmdResult<T> {
        let _turn = self.saving.lock_recovering();
        let mut config = self.config();
        let out = f(&mut config)?;
        self.write(&config)?;
        Ok(out)
    }

    /// The user's client, else the build's.
    fn client_of(&self, config: &Config) -> Option<Client> {
        match config.client_id.is_empty() {
            false => Some(Client { id: config.client_id.clone(), secret: config.client_secret.clone() }),
            true => self.built_in.clone(),
        }
    }

    /// The refresh token, when it belongs to the client in use.
    fn connection(config: &Config, client: &Client) -> Option<String> {
        (!config.refresh_token.is_empty() && config.token_client == client.id).then(|| config.refresh_token.clone())
    }

    pub fn status(&self) -> Status {
        let config = self.config();
        let client = self.client_of(&config);
        let connected = client.as_ref().and_then(|c| Self::connection(&config, c)).is_some();
        Status {
            client_id: client.as_ref().map(|c| c.id.clone()).unwrap_or_default(),
            custom_client: !config.client_id.is_empty(),
            built_in: self.built_in.is_some(),
            secret_hint: (!config.client_id.is_empty()).then(|| hint(&config.client_secret)).flatten(),
            connected,
            email: connected.then_some(config.email).flatten(),
            signing_in: self.signing_in.lock_recovering().is_some(),
        }
    }

    /// Saves the user's own OAuth client; an empty ID goes back to the build's. A `secret` of None
    /// keeps the saved one, but only for the same client ID. A different client ends the connection,
    /// since Google's tokens work only with the client they were given to.
    pub fn save_client(&self, client_id: String, secret: Option<String>) -> CmdResult<Status> {
        let id = client_id.trim().to_string();
        let secret = secret.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
        if !id.is_empty() && !id.ends_with(".apps.googleusercontent.com") {
            return Err(NOT_A_CLIENT_ID.into());
        }
        self.change(|config| {
            if id.is_empty() {
                config.client_id.clear();
                config.client_secret.clear();
                return Ok(());
            }
            let secret = match secret {
                Some(secret) => secret,
                None if config.client_id == id && !config.client_secret.is_empty() => config.client_secret.clone(),
                None => return Err(NO_SECRET.to_string()),
            };
            config.client_id = id;
            config.client_secret = secret;
            Ok(())
        })?;
        Ok(self.status())
    }

    /// Stops the sign-in that is waiting for the browser, if any.
    pub fn cancel_sign_in(&self) {
        if let Some(flag) = self.signing_in.lock_recovering().take() {
            flag.store(true, Ordering::SeqCst);
        }
    }

    /// Signs in through the browser, which `open` shows Google's page in, and keeps the
    /// connection. Blocks until the browser comes back, the sign-in is cancelled, or it times out.
    pub fn sign_in(&self, open: impl FnOnce(&str) -> CmdResult<()>) -> CmdResult<Status> {
        self.sign_in_within(SIGN_IN_WAIT, open)
    }

    fn sign_in_within(&self, wait: Duration, open: impl FnOnce(&str) -> CmdResult<()>) -> CmdResult<Status> {
        let client = self.client_of(&self.config()).ok_or(NO_CLIENT)?;
        // a second Connect replaces the first
        let cancel = Arc::new(AtomicBool::new(false));
        if let Some(old) = self.signing_in.lock_recovering().replace(cancel.clone()) {
            old.store(true, Ordering::SeqCst);
        }
        let result = self.run_sign_in(&client, wait, &cancel, open);
        let mut slot = self.signing_in.lock_recovering();
        if slot.as_ref().is_some_and(|s| Arc::ptr_eq(s, &cancel)) {
            *slot = None;
        }
        drop(slot);
        result.map(|_| self.status())
    }

    fn run_sign_in(&self, client: &Client, wait: Duration, cancel: &AtomicBool, open: impl FnOnce(&str) -> CmdResult<()>) -> CmdResult<()> {
        let server = tiny_http::Server::http("127.0.0.1:0").map_err(|e| format!("Could not start the sign-in: {e}"))?;
        let port = server.server_addr().to_ip().map(|a| a.port()).ok_or("Could not start the sign-in.")?;
        let redirect = format!("http://127.0.0.1:{port}");
        let verifier = random_text(32)?;
        let state = random_text(16)?;
        let url = format!(
            "{}?{}",
            self.endpoints.auth,
            form(&[
                ("client_id", &client.id),
                ("redirect_uri", &redirect),
                ("response_type", "code"),
                ("scope", SCOPE),
                ("code_challenge", &challenge(&verifier)),
                ("code_challenge_method", "S256"),
                ("state", &state),
                // a refresh token, so the connection outlives the hour an access token lasts
                ("access_type", "offline"),
                ("prompt", "consent"),
            ])
        );
        open(&url)?;

        let deadline = Instant::now() + wait;
        let (code, request) = loop {
            if cancel.load(Ordering::SeqCst) {
                return Err(CANCELLED.into());
            }
            let left = deadline.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return Err(TIMED_OUT.into());
            }
            let Ok(Some(request)) = server.recv_timeout(left.min(Duration::from_millis(250))) else { continue };
            let params = query(request.url());
            // the browser also asks for a favicon; and an answer to another sign-in is not this one's
            if params.get("state") != Some(&state) {
                let _ = request.respond(tiny_http::Response::empty(404));
                continue;
            }
            if let Some(code) = params.get("code").filter(|c| !c.is_empty()) {
                break (code.clone(), request);
            }
            let _ = request.respond(page("DocBro is not connected", "Google sign-in was declined. You can close this tab."));
            return Err(DENIED.into());
        };
        let outcome = self.finish_sign_in(client, &code, &redirect, &verifier);
        let _ = request.respond(match &outcome {
            Ok(()) => page("DocBro is connected", "DocBro can now upload to Google Docs. You can close this tab and go back to DocBro."),
            Err(e) => page("DocBro is not connected", e),
        });
        outcome
    }

    /// Trades the browser's code for tokens and keeps the connection.
    fn finish_sign_in(&self, client: &Client, code: &str, redirect: &str, verifier: &str) -> CmdResult<()> {
        let res = agent()
            .post(&self.endpoints.token)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .send(form(&[
                ("code", code),
                ("client_id", &client.id),
                ("client_secret", &client.secret),
                ("redirect_uri", redirect),
                ("grant_type", "authorization_code"),
                ("code_verifier", verifier),
            ]))
            .map_err(|_| UNREACHABLE.to_string())?;
        if !res.status().is_success() {
            let (status, text) = answer_text(res, &[code, &client.secret]);
            return Err(format!("Google refused the sign-in ({status}): {}", google_message(&text)));
        }
        let tokens = read_json(res, "tokens")?;
        let refresh = tokens["refresh_token"].as_str().unwrap_or_default().to_string();
        let access = tokens["access_token"].as_str().unwrap_or_default().to_string();
        if refresh.is_empty() || access.is_empty() {
            return Err("Google did not give DocBro lasting access. Press Connect to try again.".into());
        }
        let lasts = Duration::from_secs(tokens["expires_in"].as_u64().unwrap_or(3600));
        let email = self.account_email(&access);
        self.change(|config| {
            // Google Docs made under another account are not this one's to update
            if config.email != email || config.token_client != client.id {
                config.links.clear();
            }
            config.refresh_token = refresh.clone();
            config.token_client = client.id.clone();
            config.email = email;
            Ok(())
        })?;
        *self.access.lock_recovering() = Some(Access { token: access, until: Instant::now() + lasts, from: refresh });
        Ok(())
    }

    /// The account's address, for "Connected as …"; None when Drive does not say.
    fn account_email(&self, access: &str) -> Option<String> {
        let res = agent()
            .get(format!("{}/about?fields=user(emailAddress)", self.endpoints.drive))
            .header("Authorization", format!("Bearer {access}"))
            .call()
            .ok()
            .filter(|r| r.status().is_success())?;
        read_json(res, "account").ok()?["user"]["emailAddress"].as_str().map(str::to_string)
    }

    /// Forgets the connection and tells Google to end it; the OAuth client stays.
    pub fn disconnect(&self) -> CmdResult<Status> {
        self.cancel_sign_in();
        let refresh = self.change(|config| {
            let refresh = std::mem::take(&mut config.refresh_token);
            config.token_client.clear();
            config.email = None;
            config.links.clear();
            Ok(refresh)
        })?;
        *self.access.lock_recovering() = None;
        if !refresh.is_empty() {
            // best effort: the token is gone from this computer either way
            let _ = agent()
                .post(&self.endpoints.revoke)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .send(form(&[("token", &refresh)]));
        }
        Ok(self.status())
    }

    /// An access token that is good for a while yet, renewed when it is not.
    fn access_token(&self) -> CmdResult<String> {
        let config = self.config();
        let client = self.client_of(&config).ok_or(NO_CLIENT)?;
        let refresh = Self::connection(&config, &client).ok_or(NOT_CONNECTED)?;
        if let Some(access) = self.access.lock_recovering().as_ref() {
            if access.from == refresh && access.until > Instant::now() + RENEW_BEFORE {
                return Ok(access.token.clone());
            }
        }
        let res = agent()
            .post(&self.endpoints.token)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .send(form(&[
                ("client_id", &client.id),
                ("client_secret", &client.secret),
                ("refresh_token", &refresh),
                ("grant_type", "refresh_token"),
            ]))
            .map_err(|_| UNREACHABLE.to_string())?;
        if !res.status().is_success() {
            let (status, text) = answer_text(res, &[&refresh, &client.secret]);
            let parsed: Value = serde_json::from_str(&text).unwrap_or(Value::Null);
            // revoked, expired, or the password changed: only a new sign-in helps
            if parsed["error"] == "invalid_grant" {
                let _ = self.change(|config| {
                    if config.refresh_token == refresh {
                        config.refresh_token.clear();
                    }
                    Ok(())
                });
                return Err(SIGNED_OUT.into());
            }
            return Err(format!("Google refused DocBro's access ({status}): {}", google_message(&text)));
        }
        let tokens = read_json(res, "token")?;
        let token = tokens["access_token"].as_str().filter(|t| !t.is_empty()).ok_or(SIGNED_OUT)?.to_string();
        let lasts = Duration::from_secs(tokens["expires_in"].as_u64().unwrap_or(3600));
        *self.access.lock_recovering() = Some(Access { token: token.clone(), until: Instant::now() + lasts, from: refresh });
        Ok(token)
    }

    /// Runs `call` with an access token; when Google says the token is no good, once more with a new one.
    fn authorized(&self, call: impl Fn(&ureq::Agent, &str) -> Result<Response, ureq::Error>) -> CmdResult<(Response, String)> {
        let agent = agent();
        let token = self.access_token()?;
        let res = call(&agent, &token).map_err(|_| UNREACHABLE.to_string())?;
        if res.status().as_u16() != 401 {
            return Ok((res, token));
        }
        *self.access.lock_recovering() = None;
        let token = self.access_token()?;
        let res = call(&agent, &token).map_err(|_| UNREACHABLE.to_string())?;
        Ok((res, token))
    }

    /// Uploads `docx` as a Google Doc named `title`. The file at `path` updates the Google Doc it
    /// made before, unless that one was deleted or put in the trash; then it makes a new one.
    pub fn upload(&self, path: Option<&str>, title: &str, docx: &[u8]) -> CmdResult<Uploaded> {
        if docx.len() > MAX_UPLOAD {
            return Err(TOO_LARGE.into());
        }
        let _turn = self.uploading.lock_recovering();
        let linked = path.and_then(|p| self.config().links.get(p).cloned()).filter(|id| valid_file_id(id));
        if let Some(id) = linked {
            if self.still_there(&id)? {
                self.update(&id, docx)?;
                return Ok(Uploaded { url: doc_url(&id), file_id: id, created: false });
            }
        }
        let id = self.create(title, docx)?;
        if let Some(path) = path {
            self.change(|config| {
                config.links.insert(path.to_string(), id.clone());
                Ok(())
            })?;
        }
        Ok(Uploaded { url: doc_url(&id), file_id: id, created: true })
    }

    /// The Google Doc is there and not in the trash.
    fn still_there(&self, id: &str) -> CmdResult<bool> {
        let url = format!("{}/files/{id}?fields=id,trashed", self.endpoints.drive);
        let (res, token) = self.authorized(|agent, token| agent.get(&url).header("Authorization", format!("Bearer {token}")).call())?;
        match res.status().as_u16() {
            200..=299 => Ok(!read_json(res, "file")?["trashed"].as_bool().unwrap_or(false)),
            // deleted, or no longer this app's to reach
            403 | 404 => Ok(false),
            _ => Err(self.drive_error(res, &token)),
        }
    }

    fn update(&self, id: &str, docx: &[u8]) -> CmdResult<()> {
        let url = format!("{}/files/{id}?uploadType=media&fields=id", self.endpoints.upload);
        let (res, token) = self.authorized(|agent, token| {
            agent.patch(&url).header("Authorization", format!("Bearer {token}")).header("Content-Type", DOCX).send(docx)
        })?;
        match res.status().is_success() {
            true => Ok(()),
            false => Err(self.drive_error(res, &token)),
        }
    }

    fn create(&self, title: &str, docx: &[u8]) -> CmdResult<String> {
        let boundary = format!("docbro-{}", random_text(18)?);
        let meta = json!({ "name": title, "mimeType": GOOGLE_DOC });
        let mut body = format!(
            "--{boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n{meta}\r\n--{boundary}\r\nContent-Type: {DOCX}\r\n\r\n"
        )
        .into_bytes();
        body.extend_from_slice(docx);
        body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
        let url = format!("{}/files?uploadType=multipart&fields=id", self.endpoints.upload);
        let content_type = format!("multipart/related; boundary={boundary}");
        let (res, token) = self.authorized(|agent, token| {
            agent.post(&url).header("Authorization", format!("Bearer {token}")).header("Content-Type", &content_type).send(&body[..])
        })?;
        if !res.status().is_success() {
            return Err(self.drive_error(res, &token));
        }
        read_json(res, "upload")?["id"]
            .as_str()
            .filter(|id| valid_file_id(id))
            .map(str::to_string)
            .ok_or_else(|| "Google Drive did not say which Google Doc it made. Look for it in your Drive.".into())
    }

    fn drive_error(&self, res: Response, token: &str) -> String {
        let (status, text) = answer_text(res, &[token]);
        let message = google_message(&text);
        if status == 403 && text.contains("storageQuotaExceeded") {
            return "Your Google Drive is full. Free up space in it, then upload again.".into();
        }
        if status == 403 && text.contains("accessNotConfigured") {
            return "The Google Drive API is off for this OAuth client. Turn it on in Google Cloud Console, then upload again.".into();
        }
        format!("Google Drive refused the upload ({status}): {message}")
    }
}

/// The page the browser shows once the sign-in came back.
fn page(title: &str, text: &str) -> tiny_http::Response<std::io::Cursor<Vec<u8>>> {
    let escape = |s: &str| s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    let html = format!(
        "<!doctype html><meta charset=utf-8><title>{t}</title>\
         <body style=\"font:16px -apple-system,system-ui,sans-serif;margin:15vh auto;max-width:28em;padding:0 1em\">\
         <h1 style=\"font-size:22px\">{t}</h1><p>{x}</p>",
        t = escape(title),
        x = escape(text)
    );
    let header = tiny_http::Header::from_bytes("Content-Type", "text/html; charset=utf-8").expect("a valid header");
    tiny_http::Response::from_string(html).with_header(header)
}

/// Shows `url` in the user's browser.
fn open_in_browser(url: &str) -> CmdResult<()> {
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut c = std::process::Command::new("rundll32");
        c.arg("url.dll,FileProtocolHandler");
        c
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    let mut child = command.arg(url).spawn().map_err(|e| format!("Could not open the browser: {e}"))?;
    // reaped, so it leaves no zombie behind
    std::thread::spawn(move || child.wait());
    Ok(())
}

// ------------------------------------------------------------------ commands

async fn with_google<T: Send + 'static>(app: AppHandle, f: impl FnOnce(&Google) -> T + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(move || f(&app.state::<AppState>().google))
        .await
        .map_err(|e| format!("Internal error: {e}"))
}

#[tauri::command]
pub fn google_status(state: State<AppState>) -> Status {
    state.google.status()
}

#[tauri::command]
pub fn google_save_client(client_id: String, client_secret: Option<String>, state: State<AppState>) -> CmdResult<Status> {
    state.google.save_client(client_id, client_secret)
}

/// Resolves once the browser came back, the sign-in was cancelled, or it timed out.
#[tauri::command]
pub async fn google_connect(app: AppHandle) -> CmdResult<Status> {
    with_google(app, |g| g.sign_in(open_in_browser)).await?
}

#[tauri::command]
pub fn google_cancel(state: State<AppState>) {
    state.google.cancel_sign_in();
}

#[tauri::command]
pub async fn google_disconnect(app: AppHandle) -> CmdResult<Status> {
    with_google(app, |g| g.disconnect()).await?
}

/// The body is the document as `.docx` bytes; the `x-title` header is its URI-encoded name, and
/// `x-path`, when there is one, the URI-encoded path of the file it was opened from or saved to.
#[tauri::command]
pub async fn google_upload(request: Request<'_>, app: AppHandle) -> CmdResult<Uploaded> {
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("The document must be sent as raw bytes".into());
    };
    let header = |name: &str| -> CmdResult<Option<String>> {
        request
            .headers()
            .get(name)
            .map(|v| {
                let raw = v.to_str().map_err(|_| format!("The {name} header is not valid text"))?;
                percent_decode_str(raw).decode_utf8().map(|t| t.into_owned()).map_err(|_| format!("The {name} header is not valid text"))
            })
            .transpose()
    };
    let title = header("x-title")?.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| "Untitled".into());
    let path = header("x-path")?.filter(|p| !p.is_empty());
    let bytes = bytes.clone();
    with_google(app, move |g| g.upload(path.as_deref(), &title, &bytes)).await?
}

/// Shows the Google Doc in the browser.
#[tauri::command]
pub fn google_open(file_id: String) -> CmdResult<()> {
    if !valid_file_id(&file_id) {
        return Err("That is not a Google Doc id.".into());
    }
    open_in_browser(&doc_url(&file_id))
}

/// Shows a Google Cloud Console page for setting up an OAuth client: `drive_api` or `oauth_client`.
#[tauri::command]
pub fn google_open_console(page: String) -> CmdResult<()> {
    open_in_browser(console_url(&page).ok_or("That is not a Google Cloud Console page DocBro knows.")?)
}

#[cfg(test)]
mod tests;
