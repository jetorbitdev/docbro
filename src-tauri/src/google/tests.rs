use std::{
    sync::{Arc, Mutex},
    thread,
};

use super::*;

const CLIENT_ID: &str = "1234-abc.apps.googleusercontent.com";
const SECRET: &str = "GOCSPX-very-secret-value";
const REFRESH: &str = "1//refresh-token-value";
const ACCESS: &str = "ya29.access-token-value";
const DOC_ID: &str = "1AbCdEfGhIjKlMnOpQrStUv";

/// One request the fake Google got.
#[derive(Clone, Debug)]
struct Seen {
    method: String,
    url: String,
    auth: Option<String>,
    content_type: Option<String>,
    body: Vec<u8>,
}

impl Seen {
    fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }
}

type Answer = Box<dyn Fn(&Seen) -> (u16, String) + Send + Sync>;

/// Google on 127.0.0.1: `answer` picks the reply to each request, and every request is kept.
struct FakeGoogle {
    base: String,
    seen: Arc<Mutex<Vec<Seen>>>,
}

impl FakeGoogle {
    fn start(answer: impl Fn(&Seen) -> (u16, String) + Send + Sync + 'static) -> FakeGoogle {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let base = format!("http://127.0.0.1:{}", server.server_addr().to_ip().unwrap().port());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let kept = seen.clone();
        let answer: Answer = Box::new(answer);
        thread::spawn(move || {
            for mut request in server.incoming_requests() {
                let header = |name: &'static str| {
                    request.headers().iter().find(|h| h.field.equiv(name)).map(|h| h.value.as_str().to_string())
                };
                let mut body = Vec::new();
                let (auth, content_type) = (header("Authorization"), header("Content-Type"));
                let _ = request.as_reader().read_to_end(&mut body);
                let one = Seen { method: request.method().to_string(), url: request.url().to_string(), auth, content_type, body };
                let (status, text) = answer(&one);
                kept.lock().unwrap().push(one);
                let _ = request.respond(tiny_http::Response::from_string(text).with_status_code(status));
            }
        });
        FakeGoogle { base, seen }
    }

    fn endpoints(&self) -> Endpoints {
        Endpoints {
            auth: format!("{}/auth", self.base),
            token: format!("{}/token", self.base),
            revoke: format!("{}/revoke", self.base),
            drive: format!("{}/drive/v3", self.base),
            upload: format!("{}/upload/drive/v3", self.base),
        }
    }

    fn seen(&self) -> Vec<Seen> {
        self.seen.lock().unwrap().clone()
    }
}

/// Google as DocBro meets it: tokens for a code or a refresh token, the account, and Drive files.
fn google_answers(seen: &Seen) -> (u16, String) {
    let path = seen.url.split('?').next().unwrap_or("");
    match (seen.method.as_str(), path) {
        ("POST", "/token") => (200, json!({ "access_token": ACCESS, "expires_in": 3599, "refresh_token": REFRESH }).to_string()),
        ("POST", "/revoke") => (200, "{}".into()),
        ("GET", "/drive/v3/about") => (200, json!({ "user": { "emailAddress": "rina@example.com" } }).to_string()),
        ("POST", "/upload/drive/v3/files") => (200, json!({ "id": DOC_ID }).to_string()),
        ("GET", p) if p.starts_with("/drive/v3/files/") => (200, json!({ "id": DOC_ID, "trashed": false }).to_string()),
        ("PATCH", p) if p.starts_with("/upload/drive/v3/files/") => (200, json!({ "id": DOC_ID }).to_string()),
        _ => (404, "{}".into()),
    }
}

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("docbro-google-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir.join("google.json")
}

fn own_client() -> Option<Client> {
    Some(Client { id: CLIENT_ID.into(), secret: SECRET.into() })
}

/// Settings already connected to `rina@example.com`, with no access token in memory.
fn connected(file: &Path, google: &FakeGoogle) -> Google {
    let config = Config {
        refresh_token: REFRESH.into(),
        token_client: CLIENT_ID.into(),
        email: Some("rina@example.com".into()),
        ..Config::default()
    };
    fs::write(file, serde_json::to_string(&config).unwrap()).unwrap();
    Google::at(Ok(file.to_path_buf()), google.endpoints(), own_client())
}

/// What a browser does with Google's sign-in page once the user agreed: it goes to the
/// redirect address with the code and the state.
fn browser_agrees(url: &str, code: &str) -> CmdResult<()> {
    let params = query(url);
    let redirect = params["redirect_uri"].clone();
    let state = params["state"].clone();
    let code = code.to_string();
    thread::spawn(move || {
        let agent = agent();
        // the browser asks for a favicon too, and something else on this computer may try a code
        let _ = agent.get(format!("{redirect}/favicon.ico")).call();
        let _ = agent.get(format!("{redirect}/?code=stolen&state=guessed")).call();
        let page = agent.get(format!("{redirect}/?code={code}&state={state}&scope=x")).call().unwrap();
        assert!(page.into_body().read_to_string().unwrap().contains("DocBro is connected"));
    });
    Ok(())
}

#[test]
fn base64url_and_the_pkce_challenge_match_the_rfc() {
    assert_eq!(base64url(b""), "");
    assert_eq!(base64url(b"f"), "Zg");
    assert_eq!(base64url(b"fo"), "Zm8");
    assert_eq!(base64url(b"foo"), "Zm9v");
    assert_eq!(base64url(&[0xfb, 0xff]), "-_8");
    // SHA-256 of "abc", in base64url
    assert_eq!(challenge("abc"), "ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0");
    assert_eq!(random_text(32).unwrap().len(), 43);
}

#[test]
fn a_redirect_query_is_decoded() {
    let q = query("/?code=4%2F0Ab+c&state=xyz&empty");
    assert_eq!(q["code"], "4/0Ab c");
    assert_eq!(q["state"], "xyz");
    assert_eq!(q["empty"], "");
    assert!(query("/favicon.ico").is_empty());
}

#[test]
fn only_a_plain_drive_id_goes_in_a_url() {
    assert!(valid_file_id(DOC_ID));
    assert!(!valid_file_id("short"));
    assert!(!valid_file_id("1AbCdEfGhIjKl/../evil"));
    assert!(!valid_file_id("1AbCdEfGhIjKl?x=1"));
    assert_eq!(doc_url(DOC_ID), format!("https://docs.google.com/document/d/{DOC_ID}/edit"));
}

#[test]
fn only_the_known_console_pages_open() {
    assert_eq!(console_url("drive_api"), Some("https://console.cloud.google.com/apis/library/drive.googleapis.com"));
    assert_eq!(console_url("oauth_client"), Some("https://console.cloud.google.com/apis/credentials/oauthclient"));
    assert_eq!(console_url("https://evil.example"), None);
}

#[test]
fn the_status_shows_the_secrets_last_four_characters_and_never_a_token() {
    let file = tmp("status");
    let google = FakeGoogle::start(google_answers);
    let g = Google::at(Ok(file.clone()), google.endpoints(), None);
    assert_eq!(
        g.status(),
        Status { client_id: "".into(), custom_client: false, built_in: false, secret_hint: None, connected: false, email: None, signing_in: false }
    );
    g.save_client(CLIENT_ID.into(), Some(SECRET.into())).unwrap();
    let config = Config { refresh_token: REFRESH.into(), token_client: CLIENT_ID.into(), email: Some("rina@example.com".into()), ..read_config(&file) };
    g.write(&config).unwrap();
    let status = g.status();
    assert_eq!(status.secret_hint.as_deref(), Some("alue"));
    assert!(status.connected && status.custom_client);
    let shown = format!("{status:?}");
    assert!(!shown.contains(SECRET) && !shown.contains(REFRESH), "{shown}");
}

#[test]
fn a_client_id_must_be_googles_and_comes_with_its_secret() {
    let file = tmp("client");
    let g = Google::at(Ok(file.clone()), Endpoints::google(), None);
    assert_eq!(g.save_client("not-a-client".into(), Some(SECRET.into())).unwrap_err(), NOT_A_CLIENT_ID);
    assert_eq!(g.save_client(CLIENT_ID.into(), None).unwrap_err(), NO_SECRET);
    g.save_client(format!("  {CLIENT_ID} "), Some(SECRET.into())).unwrap();
    // the same client keeps its saved secret
    g.save_client(CLIENT_ID.into(), None).unwrap();
    assert_eq!(read_config(&file).client_secret, SECRET);
    // another client does not get it
    assert_eq!(g.save_client("999-x.apps.googleusercontent.com".into(), None).unwrap_err(), NO_SECRET);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[test]
fn the_builds_client_is_used_until_the_user_enters_their_own() {
    let file = tmp("built-in");
    let built_in = Some(Client { id: "build.apps.googleusercontent.com".into(), secret: "build-secret".into() });
    let g = Google::at(Ok(file), Endpoints::google(), built_in);
    let status = g.status();
    assert_eq!((status.client_id.as_str(), status.built_in, status.custom_client, status.secret_hint), ("build.apps.googleusercontent.com", true, false, None));
    g.save_client(CLIENT_ID.into(), Some(SECRET.into())).unwrap();
    assert_eq!(g.status().client_id, CLIENT_ID);
    g.save_client("".into(), None).unwrap();
    assert_eq!(g.status().client_id, "build.apps.googleusercontent.com");
}

#[test]
fn a_connection_belongs_to_the_client_it_was_made_with() {
    let file = tmp("other-client");
    let google = FakeGoogle::start(google_answers);
    let g = connected(&file, &google);
    g.save_client(CLIENT_ID.into(), Some(SECRET.into())).unwrap();
    assert!(g.status().connected);
    g.save_client("999-x.apps.googleusercontent.com".into(), Some("another-secret".into())).unwrap();
    assert!(!g.status().connected);
    assert_eq!(g.upload(None, "A", b"docx").unwrap_err(), NOT_CONNECTED);
}

#[test]
fn signing_in_through_the_browser_keeps_the_connection() {
    let file = tmp("sign-in");
    let google = FakeGoogle::start(google_answers);
    let g = Google::at(Ok(file.clone()), google.endpoints(), own_client());
    let mut asked = String::new();
    let status = g
        .sign_in_within(Duration::from_secs(20), |url| {
            asked = url.to_string();
            browser_agrees(url, "4/the-code")
        })
        .unwrap();
    assert!(status.connected && !status.signing_in);
    assert_eq!(status.email.as_deref(), Some("rina@example.com"));

    // Google's page was asked for the Drive files DocBro makes, with PKCE and lasting access
    let params = query(&asked);
    assert!(asked.starts_with(&format!("{}/auth?", google.base)));
    assert_eq!(params["client_id"], CLIENT_ID);
    assert_eq!(params["scope"], SCOPE);
    assert_eq!(params["code_challenge_method"], "S256");
    assert_eq!(params["access_type"], "offline");
    assert!(params["redirect_uri"].starts_with("http://127.0.0.1:"));

    // the code was traded with the verifier behind the challenge, and only the agreed code was
    let token = google.seen().into_iter().find(|s| s.url == "/token").unwrap();
    let sent = query(&format!("/?{}", token.text()));
    assert_eq!(sent["code"], "4/the-code");
    assert_eq!(sent["grant_type"], "authorization_code");
    assert_eq!(sent["client_secret"], SECRET);
    assert_eq!(challenge(&sent["code_verifier"]), params["code_challenge"]);
    assert_eq!(google.seen().iter().filter(|s| s.url == "/token").count(), 1);

    let config = read_config(&file);
    assert_eq!((config.refresh_token.as_str(), config.token_client.as_str()), (REFRESH, CLIENT_ID));
}

#[test]
fn a_declined_sign_in_keeps_nothing() {
    let file = tmp("declined");
    let google = FakeGoogle::start(google_answers);
    let g = Google::at(Ok(file.clone()), google.endpoints(), own_client());
    let err = g
        .sign_in_within(Duration::from_secs(20), |url| {
            let params = query(url);
            let (redirect, state) = (params["redirect_uri"].clone(), params["state"].clone());
            thread::spawn(move || agent().get(format!("{redirect}/?error=access_denied&state={state}")).call());
            Ok(())
        })
        .unwrap_err();
    assert_eq!(err, DENIED);
    assert!(!g.status().connected);
    assert!(google.seen().is_empty());
}

#[test]
fn a_sign_in_can_be_cancelled_and_times_out() {
    let file = tmp("cancel");
    let g = Arc::new(Google::at(Ok(file), Endpoints::google(), own_client()));
    let waiting = g.clone();
    let run = thread::spawn(move || waiting.sign_in_within(Duration::from_secs(20), |_| Ok(())));
    while !g.status().signing_in {
        thread::sleep(Duration::from_millis(10));
    }
    g.cancel_sign_in();
    assert_eq!(run.join().unwrap().unwrap_err(), CANCELLED);
    assert!(!g.status().signing_in);

    assert_eq!(g.sign_in_within(Duration::from_millis(300), |_| Ok(())).unwrap_err(), TIMED_OUT);
}

#[test]
fn signing_in_needs_a_client() {
    let g = Google::at(Ok(tmp("no-client")), Endpoints::google(), None);
    assert_eq!(g.sign_in_within(Duration::from_secs(1), |_| panic!("no browser without a client")).unwrap_err(), NO_CLIENT);
}

#[test]
fn the_first_upload_makes_a_google_doc_and_the_next_updates_it() {
    let file = tmp("upload");
    let google = FakeGoogle::start(google_answers);
    let g = connected(&file, &google);

    let first = g.upload(Some("/docs/Plan.docx"), "Plan", b"PK-docx-bytes").unwrap();
    assert_eq!(first, Uploaded { file_id: DOC_ID.into(), url: doc_url(DOC_ID), created: true });
    let seen = google.seen();
    // the access token came from the refresh token, and went to Drive only
    let refresh = query(&format!("/?{}", seen[0].text()));
    assert_eq!((refresh["grant_type"].as_str(), refresh["refresh_token"].as_str()), ("refresh_token", REFRESH));
    let create = seen.iter().find(|s| s.method == "POST" && s.url.starts_with("/upload/")).unwrap();
    assert_eq!(create.auth.as_deref(), Some(format!("Bearer {ACCESS}").as_str()));
    assert!(create.content_type.as_deref().unwrap().starts_with("multipart/related; boundary=docbro-"));
    let body = create.text();
    assert!(body.contains(r#""mimeType":"application/vnd.google-apps.document""#), "{body}");
    assert!(body.contains(r#""name":"Plan""#) && body.contains(DOCX) && body.contains("PK-docx-bytes"));
    assert_eq!(read_config(&file).links["/docs/Plan.docx"], DOC_ID);

    let again = g.upload(Some("/docs/Plan.docx"), "Plan", b"PK-new-bytes").unwrap();
    assert_eq!(again, Uploaded { file_id: DOC_ID.into(), url: doc_url(DOC_ID), created: false });
    let seen = google.seen();
    let update = seen.iter().find(|s| s.method == "PATCH").unwrap();
    assert_eq!(update.url, format!("/upload/drive/v3/files/{DOC_ID}?uploadType=media&fields=id"));
    assert_eq!((update.content_type.as_deref(), update.body.as_slice()), (Some(DOCX), &b"PK-new-bytes"[..]));
    // the access token was kept for the second upload
    assert_eq!(seen.iter().filter(|s| s.url == "/token").count(), 1);
}

#[test]
fn a_document_with_no_file_makes_a_new_google_doc_each_time() {
    let file = tmp("untitled");
    let google = FakeGoogle::start(google_answers);
    let g = connected(&file, &google);
    assert!(g.upload(None, "Untitled", b"a").unwrap().created);
    assert!(g.upload(None, "Untitled", b"b").unwrap().created);
    assert!(read_config(&file).links.is_empty());
}

#[test]
fn a_google_doc_in_the_trash_or_gone_is_replaced_by_a_new_one() {
    for (status, answer) in [(200, json!({ "id": "1OldOldOldOldOld", "trashed": true })), (404, json!({ "error": { "message": "File not found" } }))] {
        let file = tmp(&format!("gone-{status}"));
        let google = FakeGoogle::start(move |seen| match seen.url.starts_with("/drive/v3/files/") {
            true => (status, answer.to_string()),
            false => google_answers(seen),
        });
        let g = connected(&file, &google);
        g.change(|c| {
            c.links.insert("/a.docx".into(), "1OldOldOldOldOld".into());
            Ok(())
        })
        .unwrap();
        let up = g.upload(Some("/a.docx"), "A", b"x").unwrap();
        assert!(up.created);
        assert!(!google.seen().iter().any(|s| s.method == "PATCH"));
        assert_eq!(read_config(&file).links["/a.docx"], DOC_ID);
    }
}

#[test]
fn an_access_token_google_turns_down_is_renewed_once() {
    let file = tmp("renew");
    let refused = Arc::new(Mutex::new(false));
    let once = refused.clone();
    let google = FakeGoogle::start(move |seen| {
        let mut done = once.lock().unwrap();
        if seen.url.starts_with("/upload/") && !*done {
            *done = true;
            return (401, json!({ "error": { "message": "Invalid Credentials" } }).to_string());
        }
        google_answers(seen)
    });
    let g = connected(&file, &google);
    assert!(g.upload(None, "A", b"x").is_ok());
    assert_eq!(google.seen().iter().filter(|s| s.url == "/token").count(), 2);
}

#[test]
fn a_revoked_connection_is_forgotten_and_says_to_connect_again() {
    let file = tmp("revoked");
    let google = FakeGoogle::start(|seen| match seen.url.as_str() {
        "/token" => (400, json!({ "error": "invalid_grant", "error_description": format!("Token {REFRESH} has been revoked") }).to_string()),
        _ => google_answers(seen),
    });
    let g = connected(&file, &google);
    assert_eq!(g.upload(None, "A", b"x").unwrap_err(), SIGNED_OUT);
    assert!(!g.status().connected);
    assert!(read_config(&file).refresh_token.is_empty());
}

#[test]
fn drives_errors_say_what_to_do_and_never_carry_a_token() {
    let file = tmp("errors");
    let google = FakeGoogle::start(|seen| match seen.url.starts_with("/upload/") {
        true => (500, json!({ "error": { "message": format!("backend broke while holding {ACCESS}") } }).to_string()),
        false => google_answers(seen),
    });
    let g = connected(&file, &google);
    let err = g.upload(None, "A", b"x").unwrap_err();
    assert!(err.starts_with("Google Drive refused the upload (500)"), "{err}");
    assert!(!err.contains(ACCESS), "{err}");

    let file = tmp("full");
    let google = FakeGoogle::start(|seen| match seen.url.starts_with("/upload/") {
        true => (403, json!({ "error": { "errors": [{ "reason": "storageQuotaExceeded" }], "message": "quota" } }).to_string()),
        false => google_answers(seen),
    });
    let g = connected(&file, &google);
    assert!(g.upload(None, "A", b"x").unwrap_err().contains("Google Drive is full"));
}

#[test]
fn a_document_too_large_for_google_docs_is_not_sent() {
    let file = tmp("large");
    let google = FakeGoogle::start(google_answers);
    let g = connected(&file, &google);
    assert_eq!(g.upload(None, "A", &vec![0u8; MAX_UPLOAD + 1]).unwrap_err(), TOO_LARGE);
    assert!(google.seen().is_empty());
}

#[test]
fn disconnecting_forgets_the_account_and_revokes_its_token() {
    let file = tmp("disconnect");
    let google = FakeGoogle::start(google_answers);
    let g = connected(&file, &google);
    g.upload(Some("/a.docx"), "A", b"x").unwrap();
    let status = g.disconnect().unwrap();
    assert!(!status.connected && status.email.is_none());
    let config = read_config(&file);
    assert!(config.refresh_token.is_empty() && config.links.is_empty());
    let revoke = google.seen().into_iter().find(|s| s.url == "/revoke").unwrap();
    assert_eq!(query(&format!("/?{}", revoke.text()))["token"], REFRESH);
    assert_eq!(g.upload(None, "A", b"x").unwrap_err(), NOT_CONNECTED);
}
