use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// A WebKit content rule list, compiled on demand. `id` names it in WebKit's persistent store, so
/// the JSON file at `path` is only read when the store does not already hold `id`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ContentRuleList {
    pub id: String,
    pub path: String,
}

/// Opens a new site view as session `session` and makes it the visible one. Other sessions stay
/// alive underneath, hidden, until closed. Without a `rect` the view fills the screen below the
/// top safe area until the shell reports the real page rectangle.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenRequest {
    pub session: String,
    pub profile: String,
    pub url: String,
    #[serde(default)]
    pub rect: Option<Rect>,
    #[serde(default)]
    pub document_start_script: Option<String>,
    #[serde(default)]
    pub ad_block_scriptlet: Option<String>,
    pub ad_block_enabled: bool,
    /// Drop pop-ups and redirects that are no sign-in; see `DomainScope.looksLikeSignIn`.
    pub block_popups: bool,
    #[serde(default)]
    pub content_rule_lists: Vec<ContentRuleList>,
}

/// Names one open session: `activate` shows it, `close` tears it down.
#[derive(Debug, Clone, Deserialize)]
pub struct SessionRequest {
    pub session: String,
}

/// A local notification for a hidden session. The text is the app's own (a favorite's name and a
/// fixed phrase), never taken from the page; tapping it reports `session` back to the shell.
#[derive(Debug, Clone, Deserialize)]
pub struct NotifyRequest {
    pub session: String,
    pub title: String,
    pub body: String,
}

/// Replaces the rule lists and scriptlet activation state on every open session.
#[derive(Debug, Clone, Deserialize)]
pub struct SetContentRuleListsRequest {
    pub enabled: bool,
    pub lists: Vec<ContentRuleList>,
}

/// Replaces the script injected at document start and reloads the open site view, so the page
/// loads under the new script. An empty script removes it.
#[derive(Debug, Clone, Deserialize)]
pub struct SetDocumentStartScriptRequest {
    pub script: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetRectRequest {
    pub rect: Rect,
}

/// Rectangles, in shell CSS pixels, where touches belong to the shell. Everywhere else a touch
/// goes to the site view underneath.
#[derive(Debug, Clone, Deserialize)]
pub struct SetInteractiveRegionsRequest {
    pub regions: Vec<Rect>,
}

/// Whether the shell covers the page in front with a page of its own (a new tab), so that none of
/// it is on screen: its media is then handled as that of a page left for another.
#[derive(Debug, Clone, Deserialize)]
pub struct SetCoveredRequest {
    pub covered: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NavigateRequest {
    pub url: String,
}

/// Events the native side sends to Core. Everything here is data from a hostile page or
/// derived from it; only [`SiteViewEvent::State`] fields are produced by the native layer itself.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum SiteViewEvent {
    State {
        session: String,
        url: Option<String>,
        title: Option<String>,
        loading: bool,
        can_go_back: bool,
        can_go_forward: bool,
        /// The page has drawn its first content and is showing; until then it is covered.
        painted: bool,
        /// The registrable domain this session is pinned to; see `DomainScope.swift`.
        scope: String,
    },
    /// The native side closed a session on its own, for example when its web content process died.
    Closed {
        session: String,
    },
    /// The OS asked the app to release memory.
    MemoryWarning,
    /// The user tapped a notification raised for this session.
    NotificationTapped {
        session: String,
    },
    Error {
        message: String,
    },
    Bridge {
        origin: String,
        body: String,
    },
    /// The page opened a window or redirected on its own and it was dropped; `host` is where it
    /// wanted to go.
    PopupBlocked {
        host: String,
    },
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct BridgeMessage {
    pub origin: String,
    pub body: serde_json::Value,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ColorScheme {
    System,
    Light,
    Dark,
}

/// How the page's size changes. Rust-only and desktop-only: the menu's zoom items raise it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ZoomAction {
    In,
    Out,
    Reset,
}

#[derive(Debug, Clone, Copy, Deserialize)]
pub struct ZoomRequest {
    pub action: ZoomAction,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SetColorSchemeRequest {
    pub scheme: ColorScheme,
}

#[derive(Debug, Clone, Deserialize)]
pub struct FetchFaviconRequest {
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaviconResponse {
    pub data_url: Option<String>,
}

/// Blocks or unblocks one session natively: the page is covered by a native shield, takes no
/// touches, stops loading and stops playing media. Rust-only: it is deliberately not a Tauri
/// command and has no permission, so no webview can call it.
#[derive(Debug, Clone, Deserialize)]
pub struct SetBlockedRequest {
    pub session: String,
    pub blocked: bool,
}

/// The sites whose pages may keep playing media while they are hidden behind another page or the
/// app is in the background, as registrable domains. Any other page has its media paused then and
/// resumed when it is shown again. Rust-only: it is deliberately not a Tauri command and has no
/// permission, so no webview can call it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SetBackgroundMediaRequest {
    pub sites: Vec<String>,
}

/// The sites whose videos may open in a picture-in-picture window, as registrable domains. Any
/// other page cannot. Rust-only: it is deliberately not a Tauri command and has no permission, so
/// no webview can call it.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct SetPictureInPictureRequest {
    pub sites: Vec<String>,
}

/// A script for the active page. Rust-only: not a Tauri command, never reachable from a webview.
#[derive(Debug, Clone, Deserialize)]
pub struct EvaluateRequest {
    /// A JavaScript expression whose value is JSON-serializable.
    pub script: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EvaluateResponse {
    pub json: String,
}

/// Asks the device owner to prove they are present: Face ID or Touch ID, with the device
/// passcode as the system's own fallback. Rust-only: it is deliberately not a Tauri command and
/// has no permission, so no webview can call it.
#[derive(Debug, Clone, Deserialize)]
pub struct AuthenticateRequest {
    /// Why the app asks, shown by the system in its prompt.
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticateResponse {
    /// False when the person cancelled or failed the check; an unavailable check is an error.
    pub authenticated: bool,
}

/// The kind of biometric check this device offers, only so the shell can draw the right icon.
/// iOS reports Face ID when the device has it. Touch ID, Android (which does not say whether a
/// biometric is a face or a finger) and the Mac report a fingerprint.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum BiometryKind {
    Face,
    #[default]
    Fingerprint,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BiometryResponse {
    pub kind: BiometryKind,
}
