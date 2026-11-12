//! Sharing a recipe with everyone: the user signs in with GitHub on our sharing service, which
//! opens a pull request that adds the recipe to `recipes/community/`. Maintainers review it and
//! it ships with a later release. This is the client side. The poll token and the sign-in
//! address stay in Rust: the shell gets an opaque share id and a small status, never a token,
//! a sign-in address or anything from GitHub except the public pull request page and the login
//! name. See `client` for how the service itself is distrusted.

mod client;
pub mod commands;

use std::{
    collections::HashMap,
    sync::{Mutex, PoisonError},
    time::{Duration, Instant},
};

use serde::Serialize;
use url::Url;
use uuid::Uuid;
use zeroize::Zeroizing;

pub use client::Worker;
use client::{Polled, Reply};

use crate::error::{Error, Result};
use crate::recipes::{
    self, MARKET_PREFIX, MAX_RECIPE_BYTES, MAX_SUMMARY_CHARS, Meta, Origin, Recipe, Recipes,
    bundled, is_plain_text,
};

/// The sentences people read. Written here; nothing the service says is ever shown.
pub(crate) mod messages {
    pub const NOT_YOURS: &str = "Only recipes you made yourself can be shared.";
    pub const NEEDS_SUMMARY: &str = "Write a short description of 1 to 140 characters.";
    pub const UNAVAILABLE: &str = "Sharing is not available right now. Please try again later.";
    pub const REFUSED: &str =
        "The sharing service did not accept this recipe. Check it and try again.";
    pub const BUSY: &str = "The sharing service is busy. Please try again in a few minutes.";
    pub const OFFLINE: &str =
        "We could not reach the sharing service. Check your connection and try again.";
    pub const FAILED: &str = "Something went wrong. Please try again later.";
    pub const BROWSER: &str = "We could not open your browser. Please try again.";
    pub const EXPIRED: &str = "This sign-in took too long. Please start again.";
    pub const TOO_NEW: &str =
        "Your GitHub account is too new to share recipes yet. Please try again in a few days.";
    pub const LIMIT: &str = "You have shared a lot today. Please try again tomorrow.";
    pub const INVALID: &str =
        "This recipe cannot be shared as it is. Check its version and its scripts, then try again.";
    pub const CANCELLED: &str = "You cancelled the GitHub sign-in, so nothing was sent.";
}

/// A share the user can still follow, in memory only.
const SESSION_TTL: Duration = Duration::from_secs(15 * 60);
const MAX_SESSIONS: usize = 8;
const MAX_SLUG_NAME_CHARS: usize = 40;
const SUFFIX_CHARS: usize = 4;
const MAX_LOGIN_CHARS: usize = 39;
const CUSTOM_PREFIX: &str = "custom.";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareState {
    Waiting,
    Working,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ErrorCode {
    TooNew,
    Limit,
    Invalid,
    Offline,
    Busy,
    Failed,
    Cancelled,
}

impl ErrorCode {
    fn parse(text: &str) -> Self {
        match text {
            "tooNew" => Self::TooNew,
            "limit" => Self::Limit,
            "invalid" => Self::Invalid,
            "offline" => Self::Offline,
            "busy" => Self::Busy,
            "cancelled" => Self::Cancelled,
            _ => Self::Failed,
        }
    }

    fn sentence(self) -> &'static str {
        match self {
            Self::TooNew => messages::TOO_NEW,
            Self::Limit => messages::LIMIT,
            Self::Invalid => messages::INVALID,
            Self::Offline => messages::OFFLINE,
            Self::Busy => messages::BUSY,
            Self::Failed => messages::FAILED,
            Self::Cancelled => messages::CANCELLED,
        }
    }
}

/// What the shell sees of a share.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareStatus {
    pub state: ShareState,
    pub pr_url: Option<String>,
    pub login: Option<String>,
    pub error: Option<String>,
    pub error_code: Option<ErrorCode>,
}

impl ShareStatus {
    fn failed(code: ErrorCode, sentence: &str) -> Self {
        Self {
            state: ShareState::Failed,
            pr_url: None,
            login: None,
            error: Some(sentence.to_owned()),
            error_code: Some(code),
        }
    }
}

struct Session {
    poll_token: Zeroizing<String>,
    created: Instant,
    /// The pull request address the service reported and this client accepted.
    pr_url: Option<String>,
}

/// The sharing service this build talks to (if any) and the shares in flight.
pub struct Shares {
    worker: Option<Worker>,
    sessions: Mutex<HashMap<String, Session>>,
}

impl Shares {
    pub fn from_build() -> Self {
        Self::new(Worker::from_build())
    }

    pub fn new(worker: Option<Worker>) -> Self {
        Self {
            worker,
            sessions: Mutex::default(),
        }
    }

    pub fn available(&self) -> bool {
        self.worker.is_some()
    }

    fn worker(&self) -> Result<&Worker> {
        self.worker
            .as_ref()
            .ok_or_else(|| Error::Share(messages::UNAVAILABLE.into()))
    }

    fn sessions(&self) -> std::sync::MutexGuard<'_, HashMap<String, Session>> {
        let mut sessions = self.sessions.lock().unwrap_or_else(PoisonError::into_inner);
        sessions.retain(|_, session| session.created.elapsed() < SESSION_TTL);
        sessions
    }

    fn insert(&self, id: String, poll_token: String) {
        let mut sessions = self.sessions();
        if sessions.len() >= MAX_SESSIONS {
            let oldest = sessions
                .iter()
                .min_by_key(|(_, session)| session.created)
                .map(|(id, _)| id.clone());
            if let Some(oldest) = oldest {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(
            id,
            Session {
                poll_token: Zeroizing::new(poll_token),
                created: Instant::now(),
                pr_url: None,
            },
        );
    }

    /// Forgets a share. The shell calls this when the user cancels.
    pub fn cancel(&self, id: &str) {
        self.sessions().remove(id);
    }
}

/// Starts sharing one of the user's own recipes. Everything the service would refuse for the
/// recipe is checked here first, so nothing is sent for a recipe that cannot be shared. On
/// success the sign-in page has been opened in the system browser and only the share id returns.
pub async fn start(
    shares: &Shares,
    recipes: &Recipes,
    recipe_id: &str,
    summary: &str,
    open: impl FnOnce(&str) -> Result<()>,
) -> Result<String> {
    let worker = shares.worker()?;
    let body = request_body(recipes, recipe_id, summary)?;
    let created = worker.create(body).await?;
    shares.insert(created.id.clone(), created.poll_token);
    if open(created.login_url.as_str()).is_err() {
        shares.cancel(&created.id);
        return Err(Error::Share(messages::BROWSER.into()));
    }
    Ok(created.id)
}

/// The JSON the service gets: the recipe under its new `market.` id, and the summary.
fn request_body(recipes: &Recipes, recipe_id: &str, summary: &str) -> Result<Vec<u8>> {
    let mut recipe = recipes
        .get(recipe_id)
        .filter(|recipe| {
            recipe.id.starts_with(CUSTOM_PREFIX)
                && matches!(recipe.origin, Origin::User | Origin::Ai)
        })
        .ok_or_else(|| Error::Share(messages::NOT_YOURS.into()))?;
    let summary = match summary.trim() {
        "" => default_summary(&recipe),
        text => text.to_owned(),
    };
    if summary.trim().is_empty() || !is_plain_text(&summary, MAX_SUMMARY_CHARS) {
        return Err(Error::Share(messages::NEEDS_SUMMARY.into()));
    }
    recipe.id = new_id(&recipe.name);
    let own = recipe.meta.take();
    recipe.meta = Some(Meta {
        author: own.as_ref().and_then(|meta| meta.author.clone()),
        homepage: own.as_ref().and_then(|meta| meta.homepage.clone()),
        last_verified: None,
        summary: Some(summary.clone()),
        notes: own.and_then(|meta| meta.notes),
    });
    let mut checked =
        recipes::parse_bundled_recipe(&serde_json::to_vec(&recipe)?).map_err(not_shareable)?;
    if let Some(meta) = checked.meta.as_mut() {
        meta.summary = None;
    }
    let body = serde_json::to_vec(&serde_json::json!({ "recipe": checked, "summary": summary }))?;
    if body.len() > MAX_RECIPE_BYTES + 4096 {
        return Err(Error::Share(messages::INVALID.into()));
    }
    Ok(body)
}

fn not_shareable(error: Error) -> Error {
    let findings = match error {
        Error::Recipe(text) => text,
        other => other.to_string(),
    };
    Error::Share(format!(
        "This recipe uses something that cannot be shared yet: {findings}"
    ))
}

/// `market.<name>-<4 random characters>`: every share is a new community recipe, so it can never
/// replace a file that is already there.
fn new_id(name: &str) -> String {
    loop {
        let suffix: String = Uuid::new_v4()
            .simple()
            .to_string()
            .chars()
            .take(SUFFIX_CHARS)
            .collect();
        let id = format!("{MARKET_PREFIX}{}", slug_for(name, &suffix));
        if bundled::find(&id).is_none() {
            return id;
        }
    }
}

/// Lowercase letters, digits and `-` from the name, at most 40 characters, `recipe` when nothing
/// is left, never starting with `official`, then `-` and the suffix.
fn slug_for(name: &str, suffix: &str) -> String {
    let mut base = String::new();
    for c in name.chars() {
        if c.is_ascii_alphanumeric() {
            base.push(c.to_ascii_lowercase());
        } else if !base.ends_with('-') {
            base.push('-');
        }
    }
    let base: String = base
        .trim_matches('-')
        .chars()
        .take(MAX_SLUG_NAME_CHARS)
        .collect();
    let base = base.trim_matches('-');
    let base = match base {
        "" => "recipe",
        other => other,
    };
    if base.starts_with("official") {
        format!("my-{base}-{suffix}")
    } else {
        format!("{base}-{suffix}")
    }
}

/// One line about a recipe when its author wrote none: what its tabs open, or what its options
/// hide.
fn default_summary(recipe: &Recipe) -> String {
    let join = |prefix: &str, labels: Vec<String>| {
        let mut text = prefix.to_owned();
        for label in labels {
            let next = if text == prefix {
                format!("{prefix}{label}")
            } else {
                format!("{text}, {label}")
            };
            if next.chars().count() > MAX_SUMMARY_CHARS {
                break;
            }
            text = next;
        }
        text
    };
    if let Some(hub) = recipe.hub.as_ref().filter(|hub| !hub.tabs.is_empty()) {
        return join(
            "Opens ",
            hub.tabs.iter().map(|tab| tab.label.clone()).collect(),
        );
    }
    let labels = recipe
        .options
        .iter()
        .map(|option| {
            let label = option.label.trim_end_matches('.');
            ["Hide the ", "Hide all ", "Hide "]
                .iter()
                .find_map(|prefix| label.strip_prefix(prefix))
                .unwrap_or(label)
                .to_owned()
        })
        .collect();
    let text = join("Hides ", labels);
    if text == "Hides " {
        format!("Quieter {}", recipe.name)
    } else {
        text
    }
}

/// Asks the service how a share is going. A share this device does not know (or that expired) is
/// reported as failed without asking anyone.
pub async fn status(shares: &Shares, id: &str) -> Result<ShareStatus> {
    let worker = shares.worker()?;
    let token = shares
        .sessions()
        .get(id)
        .map(|session| session.poll_token.clone());
    let Some(token) = token else {
        return Ok(ShareStatus::failed(ErrorCode::Failed, messages::EXPIRED));
    };
    match worker.poll(id, &token).await? {
        Polled::Gone => Ok(ShareStatus::failed(ErrorCode::Failed, messages::EXPIRED)),
        Polled::Reply(reply) => {
            let status = checked_status(reply)?;
            if let Some(session) = shares.sessions().get_mut(id) {
                session.pr_url.clone_from(&status.pr_url);
            }
            Ok(status)
        }
    }
}

/// Turns the service's answer into what the shell may see: a fixed state, a pull request address
/// only if it has the shape of one, a login name only if it has the shape of one, and a sentence
/// written here.
fn checked_status(reply: Reply) -> Result<ShareStatus> {
    let state = match reply.state.as_deref() {
        Some("waiting") => ShareState::Waiting,
        Some("working") => ShareState::Working,
        Some("done") => ShareState::Done,
        Some("failed") => ShareState::Failed,
        _ => return Err(Error::Share(messages::UNAVAILABLE.into())),
    };
    let code = (state == ShareState::Failed)
        .then(|| ErrorCode::parse(reply.error_code.as_deref().unwrap_or_default()));
    Ok(ShareStatus {
        state,
        pr_url: reply
            .pr_url
            .filter(|url| state == ShareState::Done && is_pull_request_url(url)),
        login: reply.login.filter(|login| is_login(login)),
        error: code.map(|code| code.sentence().to_owned()),
        error_code: code,
    })
}

/// Opens the pull request page a status reported for this share.
pub fn open_pull_request(
    shares: &Shares,
    id: &str,
    open: impl FnOnce(&str) -> Result<()>,
) -> Result<()> {
    let url = shares
        .sessions()
        .get(id)
        .and_then(|session| session.pr_url.clone())
        .ok_or_else(|| Error::Share(messages::EXPIRED.into()))?;
    open(&url).map_err(|_| Error::Share(messages::BROWSER.into()))
}

fn is_login(login: &str) -> bool {
    (1..=MAX_LOGIN_CHARS).contains(&login.len())
        && login
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `https://github.com/<owner>/<repo>/pull/<number>` and nothing else.
fn is_pull_request_url(text: &str) -> bool {
    let Ok(url) = Url::parse(text) else {
        return false;
    };
    let segments: Vec<&str> = url
        .path_segments()
        .map(Iterator::collect)
        .unwrap_or_default();
    let name = |part: &str, max: usize| {
        (1..=max).contains(&part.len())
            && part
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
    };
    url.scheme() == "https"
        && url.host_str() == Some("github.com")
        && url.port().is_none()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && text == url.as_str()
        && matches!(
            segments.as_slice(),
            [owner, repo, "pull", number]
                if name(owner, MAX_LOGIN_CHARS)
                    && name(repo, 100)
                    && (1..=10).contains(&number.len())
                    && number.bytes().all(|b| b.is_ascii_digit())
        )
}

#[cfg(test)]
mod tests;
