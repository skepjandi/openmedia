//! Site views on macOS, Windows and Linux: one Tauri child webview per session, stacked above the
//! shell.
//!
//! On macOS the shell is the window's own webview, kept above the page views and transparent, as
//! on mobile: it reports the rectangle the page takes (`set_rect`) and the regions where it wants
//! clicks (`set_interactive_regions`); everywhere else a click goes to the page below. On Windows
//! and Linux a web view cannot be made click-through, so the page sits above the shell and is
//! fitted around the regions (`layout::fit_page`); while an overlay such as a sheet is open it is
//! hidden. What differs per system lives in [`platform`].
//!
//! Tauri's webview API has no navigation state, so a poll thread reads it (from the `WKWebView`
//! on macOS, from Tauri's own address and the page callbacks elsewhere, see [`platform`]) and
//! reports changes as `siteview:state`, the same event mobile sends.
//!
//! Calls that reach a web view hop to the main thread and wait, so they must never run on it.

mod favicon;
mod layout;
mod platform;

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    time::{Duration, Instant},
};

use serde::de::DeserializeOwned;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Runtime, Theme, Webview, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder, Window,
    plugin::PluginApi,
    webview::{
        DownloadEvent, NewWindowFeatures, NewWindowResponse, PageLoadEvent, PermissionResponse,
        WebviewBuilder,
    },
};
use url::Url;
use uuid::Uuid;

use platform::{PageSnapshot, Track};

use crate::events::{NOTIFICATION_TAP_EVENT, POPUP_BLOCKED_EVENT, STATE_EVENT};
use crate::models::*;
use crate::site::site_of_host;
use crate::validate::{
    check_auth_reason, check_evaluate_result, check_site, parse_profile_id, parse_session_id,
    parse_web_url, wrap_evaluate_script,
};
use crate::{Error, Result};

/// The longest page title, and address in bytes, the shell is told about.
const MAX_REPORTED_TITLE_CHARS: usize = 256;
const MAX_REPORTED_URL_BYTES: usize = 4096;

pub(crate) const MAIN_WINDOW: &str = "main";
/// How often each session's page state is read. Single-page sites change address without a page
/// load, so the state has to be asked for.
const POLL_INTERVAL: Duration = Duration::from_millis(400);
/// A page that has not finished loading is still shown after this long.
const PAINT_FALLBACK: Duration = Duration::from_millis(1500);
const EVALUATE_TIMEOUT: Duration = Duration::from_secs(5);
/// How many closed sessions are remembered; the oldest are forgotten first.
const MAX_REMEMBERED_BLOCKED: usize = 32;
/// Pauses what is playing in a page that went out of sight and remembers which elements it
/// paused, so showing the page again resumes exactly those and nothing the visitor had paused.
const PAUSE_MEDIA_SCRIPT: &str = "(function(){window.__openmediaHold=true;var held=window.__openmediaPaused=window.__openmediaPaused||[];document.querySelectorAll('video,audio').forEach(function(m){if(m.webkitPresentationMode==='picture-in-picture'||m===document.pictureInPictureElement)return;if(!m.paused&&!m.ended&&held.indexOf(m)<0){held.push(m);m.pause()}})})()";
const RESUME_MEDIA_SCRIPT: &str = "(function(){window.__openmediaHold=false;var held=window.__openmediaPaused||[];window.__openmediaPaused=[];held.forEach(function(m){if(!m.isConnected)return;try{var p=m.play();if(p&&p.catch)p.catch(function(){})}catch(e){}});document.dispatchEvent(new Event('openmedia-resume'))})()";
const STOP_MEDIA_SCRIPT: &str =
    "document.querySelectorAll('video,audio').forEach(function(m){m.pause()});window.stop();";
/// True when a video of the page's own document floats in a picture-in-picture window.
const PICTURE_IN_PICTURE_SCRIPT: &str = "(function(){var v=document.querySelectorAll('video');for(var i=0;i<v.length;i++){if(v[i].webkitPresentationMode==='picture-in-picture')return true}return !!document.pictureInPictureElement})()";
/// How long the page gets to say whether a video floats.
const PICTURE_IN_PICTURE_WAIT: Duration = Duration::from_secs(1);

/// What was last told to the shell about a session, so only changes are sent.
#[derive(Debug, Clone, PartialEq)]
struct Reported {
    page: PageSnapshot,
    painted: bool,
    scope: String,
}

struct Session<R: Runtime> {
    webview: Webview<R>,
    profile: Uuid,
    opened_url: String,
    opened_at: Instant,
    painted: bool,
    /// The registrable domain of the page now showing. New-window requests read it from the
    /// webview's own callbacks, which run on the main thread and must not wait on the state lock.
    scope: Arc<Mutex<String>>,
    /// What the page's callbacks reported, for systems whose web view cannot be asked.
    track: Arc<Track>,
    /// The page was opened under an older script; it is rebuilt when next shown.
    stale: bool,
    reported: Option<Reported>,
}

struct State<R: Runtime> {
    sessions: HashMap<String, Session<R>>,
    active: Option<String>,
    rect: Option<Rect>,
    regions: Vec<Rect>,
    document_start_script: String,
    rule_lists: Vec<ContentRuleList>,
    blocked: Vec<String>,
    /// The sites whose media keeps playing while their page is hidden.
    background_media: Vec<String>,
    /// Sessions whose media was paused because their page went out of sight.
    media_paused: HashSet<String>,
    /// Sessions whose web view was told to suspend all media, each owed one resume.
    native_suspended: HashSet<String>,
    /// True while the window is minimized or the app is hidden: no page is in front then.
    window_hidden: bool,
    /// True while the shell covers the page in front with a page of its own (a new tab).
    covered: bool,
}

/// What a page's media needs when its visibility changes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MediaStep {
    Pause,
    Resume,
}

/// A closed session is left to the usage block, which already stops its media. Otherwise a hidden
/// page pauses unless its site may play in the background, and a shown page resumes what was
/// paused; a page paused and then allowed to play on resumes too.
fn media_step(shown: bool, blocked: bool, keeps_playing: bool, paused: bool) -> Option<MediaStep> {
    if blocked {
        return None;
    }
    match (shown || keeps_playing, paused) {
        (false, false) => Some(MediaStep::Pause),
        (true, true) => Some(MediaStep::Resume),
        _ => None,
    }
}

/// Whether a video of the page floats in a picture-in-picture window. A page that does not answer
/// in time is taken as having none, so it is suspended like any other.
fn in_picture_in_picture<R: Runtime>(webview: &Webview<R>) -> bool {
    let (sender, receiver) = mpsc::channel();
    let asked = webview.eval_with_callback(PICTURE_IN_PICTURE_SCRIPT, move |answer| {
        let _ = sender.send(answer);
    });
    asked.is_ok()
        && receiver
            .recv_timeout(PICTURE_IN_PICTURE_WAIT)
            .is_ok_and(|answer| answer == "true")
}

/// Everything a new web view needs.
struct NewView<'a> {
    label: &'a str,
    url: Url,
    profile: Uuid,
    script: &'a str,
    scope: &'a Arc<Mutex<String>>,
    track: &'a Arc<Track>,
    bounds: Rect,
}

struct Inner<R: Runtime> {
    app: AppHandle<R>,
    state: Mutex<State<R>>,
    labels: AtomicU64,
    /// The label of the web view that was last given the keyboard.
    focused: Mutex<Option<String>>,
    /// Drop windows a page opens that are no sign-in; set by every `open`.
    block_popups: Arc<AtomicBool>,
}

pub struct Siteview<R: Runtime> {
    inner: Arc<Inner<R>>,
}

pub fn init<R: Runtime, C: DeserializeOwned>(
    app: &AppHandle<R>,
    _api: PluginApi<R, C>,
) -> Result<Siteview<R>> {
    let inner = Arc::new(Inner {
        app: app.clone(),
        state: Mutex::new(State {
            sessions: HashMap::new(),
            active: None,
            rect: None,
            regions: Vec::new(),
            document_start_script: String::new(),
            rule_lists: Vec::new(),
            blocked: Vec::new(),
            background_media: Vec::new(),
            media_paused: HashSet::new(),
            native_suspended: HashSet::new(),
            window_hidden: false,
            covered: false,
        }),
        labels: AtomicU64::new(0),
        focused: Mutex::new(None),
        block_popups: Arc::new(AtomicBool::new(true)),
    });
    spawn_poller(Arc::downgrade(&inner))?;
    let tapped = app.clone();
    platform::notify::install(move |session| {
        let _ = tapped.emit(NOTIFICATION_TAP_EVENT, session);
    });
    Ok(Siteview { inner })
}

fn spawn_poller<R: Runtime>(inner: Weak<Inner<R>>) -> Result<()> {
    std::thread::Builder::new()
        .name("siteview-poll".into())
        .spawn(move || {
            while let Some(inner) = inner.upgrade() {
                inner.poll();
                drop(inner);
                std::thread::sleep(POLL_INTERVAL);
            }
        })?;
    Ok(())
}

/// Only web pages are shown: every other scheme (`mailto:`, `tel:`, app store links) is refused,
/// as on mobile. `about:` covers blank and `srcdoc` frames. The popup-close address is refused
/// too, so a page that is not a popup cannot load it.
fn allows_navigation(url: &Url) -> bool {
    url.as_str() != POPUP_CLOSE_URL && matches!(url.scheme(), "http" | "https" | "about")
}

fn scope_contains(scope: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    host == scope || host.ends_with(&format!(".{scope}"))
}

/// Hosts, and their subdomains, that only identity providers and payment pages use.
const SIGN_IN_HOSTS: [&str; 9] = [
    "accounts.google.com",
    "accounts.youtube.com",
    "appleid.apple.com",
    "login.microsoftonline.com",
    "login.live.com",
    "checkout.stripe.com",
    "paypal.com",
    "okta.com",
    "auth0.com",
];
/// Path pieces that name a sign-in or an authorization step.
const SIGN_IN_PATHS: [&str; 9] = [
    "/oauth",
    "/authorize",
    "/saml",
    "/sso",
    "/openid",
    "/signin",
    "/sign-in",
    "/login",
    "/log-in",
];

/// Whether an address outside the session's site is plausibly a sign-in or a payment, the only
/// reason a page has to open another window on its own. Ad networks use throwaway domains with
/// none of these marks, so every other window a page opens is refused. Heuristic: an unknown
/// identity provider that uses none of these marks is refused too. Twin of
/// `DomainScope.looksLikeSignIn` on iOS and Android.
fn looks_like_sign_in(url: &Url) -> bool {
    let host = url.host_str().unwrap_or_default().to_ascii_lowercase();
    if SIGN_IN_HOSTS
        .iter()
        .any(|known| host == *known || host.ends_with(&format!(".{known}")))
    {
        return true;
    }
    let path = url.path().to_ascii_lowercase();
    if SIGN_IN_PATHS.iter().any(|piece| path.contains(piece))
        || path.ends_with("/auth")
        || path.contains("/auth/")
    {
        return true;
    }
    let names: Vec<String> = url
        .query_pairs()
        .map(|(name, _)| name.to_ascii_lowercase())
        .collect();
    let has = |name: &str| names.iter().any(|candidate| candidate == name);
    has("samlrequest") || (has("client_id") && (has("redirect_uri") || has("response_type")))
}

/// WebKit does not tell the app when a page calls `window.close()`, which is how a sign-in popup
/// ends. The script turns that call into a navigation to this address, which the popup refuses
/// and closes itself on. A popup is built on its opener's web view configuration and so shares the
/// opener's user content controller: wry skips a popup's own initialization scripts, and the script
/// reaches it only through the one the site view was built with.
const POPUP_CLOSE_URL: &str = "https://openmedia.invalid/__close_popup__";
const POPUP_CLOSE_SCRIPT: &str = "(function(){var c=function(){location.href='https://openmedia.invalid/__close_popup__'};try{Object.defineProperty(window,'close',{value:c,configurable:true,writable:true})}catch(e){window.close=c}})();";
static POPUPS: AtomicU64 = AtomicU64::new(0);

/// Builds the window for a page's `window.open`. `features` ties it to the opener's web view
/// configuration. Must run on the main thread, where WebKit calls the new-window handler.
fn open_popup<R: Runtime>(
    app: &AppHandle<R>,
    features: NewWindowFeatures,
) -> Result<WebviewWindow<R>> {
    let label = format!("popup-{}", POPUPS.fetch_add(1, Ordering::Relaxed));
    let closing = app.clone();
    let closing_label = label.clone();
    let blank = Url::parse("about:blank").map_err(|e| Error::InvalidUrl(e.to_string()))?;
    let mut builder = WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank))
        .window_features(features);
    if let Some(agent) = platform::USER_AGENT {
        builder = builder.user_agent(agent);
    }
    Ok(builder
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
        })
        .on_navigation(move |url| {
            if url.as_str() == POPUP_CLOSE_URL {
                // Closing from inside the navigation callback would re-enter the web view.
                let app = closing.clone();
                let label = closing_label.clone();
                let _ = closing.run_on_main_thread(move || {
                    if let Some(window) = app.get_webview_window(&label) {
                        let _ = window.destroy();
                    }
                });
                return false;
            }
            allows_navigation(url)
        })
        .build()?)
}

fn scope_of(url: &str) -> Option<String> {
    let url = Url::parse(url).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url.host_str().map(site_of_host))?
}

impl<R: Runtime> Inner<R> {
    fn state(&self) -> MutexGuard<'_, State<R>> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }

    fn window(&self) -> Result<Window<R>> {
        self.app
            .get_window(MAIN_WINDOW)
            .ok_or(Error::MainWindowMissing)
    }

    /// Where the shell's page is drawn in the window, in logical pixels. The shell reports the
    /// page's rectangle in its own coordinates, and its web view reaches under the title bar while
    /// the page it draws starts below it, so the page is placed relative to that, not to the
    /// window.
    fn shell_frame(&self) -> Result<Rect> {
        let shell = self
            .app
            .get_webview(MAIN_WINDOW)
            .ok_or(Error::MainWindowMissing)?;
        let scale = shell.window().scale_factor()?;
        let bounds = shell.bounds()?;
        let position = bounds.position.to_logical::<f64>(scale);
        let size = bounds.size.to_logical::<f64>(scale);
        let (left, top, right, bottom) = platform::content_insets(&shell)?;
        Ok(Rect {
            x: position.x + left,
            y: position.y + top,
            width: size.width - left - right,
            height: size.height - top - bottom,
        })
    }

    /// Where the page goes in the window for a rectangle in the shell's coordinates; the whole
    /// shell while the shell has not reported one.
    fn page_bounds(&self, rect: Option<Rect>) -> Result<Rect> {
        let frame = self.shell_frame()?;
        Ok(match rect.and_then(layout::usable) {
            Some(rect) => Rect {
                x: frame.x + rect.x,
                y: frame.y + rect.y,
                ..rect
            },
            None => frame,
        })
    }

    fn next_label(&self, session: &str) -> String {
        format!(
            "site-{session}-{}",
            self.labels.fetch_add(1, Ordering::Relaxed)
        )
    }

    fn active_webview(&self) -> Result<Webview<R>> {
        let state = self.state();
        state
            .active
            .as_ref()
            .and_then(|id| state.sessions.get(id))
            .map(|session| session.webview.clone())
            .ok_or(Error::UnknownSession)
    }

    fn profiles_dir(&self) -> Result<PathBuf> {
        Ok(self
            .app
            .path()
            .app_data_dir()
            .map_err(|error| Error::Native(error.to_string()))?
            .join("profiles"))
    }

    fn build_webview(&self, window: &Window<R>, view: NewView<'_>) -> Result<Webview<R>> {
        let NewView {
            label,
            url,
            profile,
            script,
            scope,
            track,
            bounds,
        } = view;
        let app = self.app.clone();
        let block_popups = Arc::clone(&self.block_popups);
        let scope = Arc::clone(scope);
        let own_label = label.to_owned();
        let downloading = Mutex::new(None::<PathBuf>);
        let page_track = Arc::clone(track);
        let title_track = Arc::clone(track);
        let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url))
            .on_navigation(allows_navigation)
            .on_page_load(move |_, payload| {
                page_track.set_loading(payload.event() == PageLoadEvent::Started);
            })
            .on_document_title_changed(move |_, title| title_track.set_title(&title))
            // A site never gets the camera, the microphone or the location: wry would otherwise
            // grant media capture when nothing handles the request.
            .on_permission_request(|_, _| PermissionResponse::Deny)
            // WebKit picks the Downloads folder and a free file name; the file is shown in Finder
            // once it is complete, since nothing else says a download happened.
            .on_download(move |_, event| {
                let mut pending = downloading.lock().unwrap_or_else(PoisonError::into_inner);
                match event {
                    DownloadEvent::Requested { destination, .. } => {
                        *pending = Some(destination.clone());
                    }
                    DownloadEvent::Finished { success: true, .. } => {
                        if let Some(file) = pending.take() {
                            platform::reveal_file(&file);
                        }
                    }
                    _ => *pending = None,
                }
                true
            })
            .on_new_window(move |url, features| {
                if !matches!(url.scheme(), "http" | "https") {
                    return NewWindowResponse::Deny;
                }
                let inside = url.host_str().is_some_and(|host| {
                    scope_contains(&scope.lock().unwrap_or_else(PoisonError::into_inner), host)
                });
                if inside {
                    if let Some(webview) = app.get_webview(&own_label) {
                        let _ = webview.navigate(url);
                    }
                    return NewWindowResponse::Deny;
                }
                if block_popups.load(Ordering::Relaxed) && !looks_like_sign_in(&url) {
                    // Not the site and not a sign-in: a popunder or an ad window. Say so, so a
                    // sign-in that was refused by mistake can be switched off.
                    let _ = app.emit(POPUP_BLOCKED_EVENT, url.host_str().unwrap_or_default());
                    return NewWindowResponse::Deny;
                }
                // Sign-in (Google, Apple) opens in a popup inside the app. It is
                // built on the opener's configuration, so it shares the session's data store and
                // keeps `window.opener`, which sign-in flows report back through.
                match open_popup(&app, features) {
                    Ok(window) => NewWindowResponse::Create { window },
                    Err(_) => {
                        platform::open_in_browser(&url);
                        NewWindowResponse::Deny
                    }
                }
            });
        builder = platform::configure_profile(builder, &self.profiles_dir()?, profile);
        if let Some(agent) = platform::USER_AGENT {
            builder = builder.user_agent(agent);
        }
        builder = builder.initialization_script(POPUP_CLOSE_SCRIPT);
        if !script.is_empty() {
            builder = builder.initialization_script(script);
        }
        let webview = window.add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )?;
        platform::enable_gestures(&webview)?;
        Ok(webview)
    }

    /// Puts every view where it belongs: the active one visible unless the shell covers it or the
    /// session is closed for the day, the rest hidden.
    fn sync_views(&self) {
        let (rect, regions, overlay, covered, views, media) = {
            let mut state = self.state();
            let rect = state.rect.and_then(layout::usable);
            let overlay = rect.is_some_and(|rect| layout::overlay_open(&rect, &state.regions));
            let views: Vec<(Webview<R>, bool)> = state
                .sessions
                .iter()
                .map(|(id, session)| {
                    let shown =
                        state.active.as_deref() == Some(id.as_str()) && !state.blocked.contains(id);
                    (session.webview.clone(), shown)
                })
                .collect();
            let media = Self::media_steps(&mut state);
            (
                rect,
                state.regions.clone(),
                overlay,
                state.covered,
                views,
                media,
            )
        };
        self.apply_media(media);
        // Without click-through the page would hide whatever the shell draws over it: it steps
        // aside for an overlay or a page of the shell's own, and keeps clear of the small controls.
        let shell_in_front = !platform::CLICK_THROUGH && (overlay || covered);
        let fitted = rect.map(|rect| {
            if platform::CLICK_THROUGH {
                rect
            } else {
                layout::fit_page(&rect, &regions)
            }
        });
        // Asked of the main thread, so never while the state lock is held.
        let bounds = fitted.and_then(|rect| self.page_bounds(Some(rect)).ok());
        let shell = self.app.get_webview(MAIN_WINDOW);
        let mut front = None;
        for (webview, shown) in &views {
            if let (Some(rect), Some(shell)) = (bounds, &shell) {
                let _ = platform::place(shell, webview, rect);
            }
            let shown = *shown && !shell_in_front;
            let _ = if shown {
                webview.show()
            } else {
                webview.hide()
            };
            if shown {
                front = Some(webview.label().to_owned());
            }
        }
        let focus = match front {
            Some(label) if !overlay => label,
            _ => MAIN_WINDOW.to_owned(),
        };
        self.focus(&focus);
    }

    /// Does what `media_steps` recorded. The page's script pauses what its own document plays and
    /// is told it is on hold; the web view then suspends every frame's media as well, which reaches
    /// the iframes of a player, unless a video of the page floats in a picture-in-picture window
    /// (suspending would close it). A resume undoes exactly the suspend that was made. Never on the
    /// main thread: the page is asked for its answer.
    fn apply_media(&self, steps: Vec<(String, Webview<R>, MediaStep)>) {
        for (id, webview, step) in steps {
            match step {
                MediaStep::Pause => {
                    let _ = webview.eval(PAUSE_MEDIA_SCRIPT);
                    if in_picture_in_picture(&webview) {
                        continue;
                    }
                    let suspend = self.state().native_suspended.insert(id);
                    if suspend {
                        let _ = platform::set_media_suspended(&webview, true);
                    }
                }
                MediaStep::Resume => {
                    let resume = self.state().native_suspended.remove(&id);
                    if resume {
                        let _ = platform::set_media_suspended(&webview, false);
                    }
                    let _ = webview.eval(RESUME_MEDIA_SCRIPT);
                }
            }
        }
    }

    /// The pause or resume each session needs for where it now stands, recorded as done. Run the
    /// scripts after the state lock is released.
    fn media_steps(state: &mut State<R>) -> Vec<(String, Webview<R>, MediaStep)> {
        let mut steps = Vec::new();
        for (id, session) in &state.sessions {
            let shown = state.active.as_deref() == Some(id.as_str())
                && !state.window_hidden
                && !state.covered;
            let blocked = state.blocked.contains(id);
            let scope = session
                .scope
                .lock()
                .unwrap_or_else(PoisonError::into_inner)
                .clone();
            let keeps_playing = state.background_media.contains(&scope);
            let paused = state.media_paused.contains(id);
            let Some(step) = media_step(shown, blocked, keeps_playing, paused) else {
                continue;
            };
            match step {
                MediaStep::Pause => state.media_paused.insert(id.clone()),
                MediaStep::Resume => state.media_paused.remove(id),
            };
            steps.push((id.clone(), session.webview.clone(), step));
        }
        steps
    }

    /// Gives the keyboard to the page showing, or to the shell while an overlay is open: the page
    /// would otherwise keep every key press, and Escape would never reach the shell.
    fn focus(&self, label: &str) {
        let already = {
            let focused = self.focused.lock().unwrap_or_else(PoisonError::into_inner);
            focused.as_deref() == Some(label)
        };
        if !already {
            self.give_keyboard(label);
        }
    }

    /// Gives the keyboard to `label` whether or not it was last given it: a click in the page
    /// takes the keyboard without telling us.
    fn give_keyboard(&self, label: &str) {
        let mut focused = self.focused.lock().unwrap_or_else(PoisonError::into_inner);
        if let Some(webview) = self.app.get_webview(label) {
            let _ = webview.set_focus();
        }
        *focused = Some(label.to_owned());
    }

    /// Keeps the shell above the page views; a view added later would otherwise cover it.
    fn raise_shell(&self) {
        if let Some(shell) = self.app.get_webview(MAIN_WINDOW) {
            let _ = platform::prepare_shell(&shell);
        }
    }

    fn attach_rule_lists(&self, webview: &Webview<R>) {
        let lists = self.state().rule_lists.clone();
        if !lists.is_empty() {
            let _ = platform::set_rule_lists(webview, lists);
        }
    }

    /// Replaces a session's view with a new one at the page's current address, so the page loads
    /// under the current script. The page's history is not carried over.
    fn rebuild(&self, session: &str) -> Result<()> {
        let window = self.window()?;
        let (old, old_track, profile, scope, opened_url, script, rect) = {
            let state = self.state();
            let entry = state.sessions.get(session).ok_or(Error::UnknownSession)?;
            (
                entry.webview.clone(),
                Arc::clone(&entry.track),
                entry.profile,
                Arc::clone(&entry.scope),
                entry.opened_url.clone(),
                state.document_start_script.clone(),
                state.rect,
            )
        };
        let track = Arc::new(Track::default());
        let url = platform::snapshot(&old, &old_track)
            .ok()
            .and_then(|page| page.url)
            .and_then(|url| parse_web_url(&url).ok())
            .map_or_else(|| parse_web_url(&opened_url), Ok)?;
        let bounds = self.page_bounds(rect)?;
        let label = self.next_label(session);
        let view = NewView {
            label: &label,
            url,
            profile,
            script: &script,
            scope: &scope,
            track: &track,
            bounds,
        };
        let webview = self.build_webview(&window, view)?;
        {
            let mut state = self.state();
            // The new view has not been paused: the next sync works that out afresh.
            state.media_paused.remove(session);
            state.native_suspended.remove(session);
            if let Some(entry) = state.sessions.get_mut(session) {
                entry.webview = webview.clone();
                entry.track = track;
                entry.stale = false;
                entry.reported = None;
            }
        }
        let _ = old.close();
        self.raise_shell();
        self.attach_rule_lists(&webview);
        self.sync_views();
        Ok(())
    }

    /// A minimized window or a hidden app has no page in front: its media is paused as a page out
    /// of sight is (a video in a picture-in-picture window is spared by the script), and resumed
    /// when the window is back.
    fn follow_window(&self) {
        let Some(window) = self.app.get_window(MAIN_WINDOW) else {
            return;
        };
        let hidden = window.is_minimized().unwrap_or(false) || !window.is_visible().unwrap_or(true);
        let media = {
            let mut state = self.state();
            if state.window_hidden == hidden {
                return;
            }
            state.window_hidden = hidden;
            Self::media_steps(&mut state)
        };
        self.apply_media(media);
    }

    fn poll(&self) {
        self.follow_window();
        let targets: Vec<(String, Webview<R>, Arc<Track>)> = self
            .state()
            .sessions
            .iter()
            .map(|(id, session)| {
                (
                    id.clone(),
                    session.webview.clone(),
                    Arc::clone(&session.track),
                )
            })
            .collect();
        for (id, webview, track) in targets {
            if let Ok(page) = platform::snapshot(&webview, &track) {
                self.report(&id, webview.label(), page);
            }
        }
    }

    /// Tells the shell about a session whose page state changed. `label` names the view the state
    /// was read from; a view that was replaced meanwhile is ignored.
    fn report(&self, session: &str, label: &str, mut page: PageSnapshot) {
        // Title and address are the page's own words: bound them before they reach the shell.
        page.title = page
            .title
            .map(|title| title.chars().take(MAX_REPORTED_TITLE_CHARS).collect());
        page.url = page.url.filter(|url| url.len() <= MAX_REPORTED_URL_BYTES);
        let event = {
            let mut state = self.state();
            let Some(entry) = state.sessions.get_mut(session) else {
                return;
            };
            if entry.webview.label() != label {
                return;
            }
            let mut scope = entry.scope.lock().unwrap_or_else(PoisonError::into_inner);
            if let Some(current) = page.url.as_deref().and_then(scope_of) {
                *scope = current;
            }
            let scope = scope.clone();
            entry.painted |= !page.loading || entry.opened_at.elapsed() >= PAINT_FALLBACK;
            let reported = Reported {
                page,
                painted: entry.painted,
                scope,
            };
            if entry.reported.as_ref() == Some(&reported) {
                return;
            }
            let event = SiteViewEvent::State {
                session: session.to_owned(),
                url: reported.page.url.clone(),
                title: reported.page.title.clone(),
                loading: reported.page.loading,
                can_go_back: reported.page.can_go_back,
                can_go_forward: reported.page.can_go_forward,
                painted: reported.painted,
                scope: reported.scope.clone(),
            };
            entry.reported = Some(reported);
            event
        };
        let _ = self.app.emit(STATE_EVENT, event);
    }
}

impl<R: Runtime> Siteview<R> {
    pub fn open(&self, request: OpenRequest) -> Result<()> {
        let inner = &self.inner;
        parse_session_id(&request.session)?;
        let url = parse_web_url(&request.url)?;
        let profile = parse_profile_id(&request.profile)?;
        let window = inner.window()?;
        if inner.state().sessions.contains_key(&request.session) {
            self.close(SessionRequest {
                session: request.session.clone(),
            })?;
        }
        let (script, bounds) = {
            let mut state = inner.state();
            if let Some(rect) = request.rect {
                state.rect = Some(rect);
            }
            if let Some(script) = request.document_start_script {
                state.document_start_script = script;
            }
            state.rule_lists = request.content_rule_lists;
            inner
                .block_popups
                .store(request.block_popups, Ordering::Relaxed);
            (state.document_start_script.clone(), state.rect)
        };
        let bounds = inner.page_bounds(bounds)?;
        let scope = Arc::new(Mutex::new(
            url.host_str().map(site_of_host).unwrap_or_default(),
        ));
        let track = Arc::new(Track::default());
        let label = inner.next_label(&request.session);
        let view = NewView {
            label: &label,
            url,
            profile,
            script: &script,
            scope: &scope,
            track: &track,
            bounds,
        };
        let webview = inner.build_webview(&window, view)?;
        {
            let mut state = inner.state();
            state.sessions.insert(
                request.session.clone(),
                Session {
                    webview: webview.clone(),
                    profile,
                    opened_url: request.url,
                    opened_at: Instant::now(),
                    painted: false,
                    scope,
                    track,
                    stale: false,
                    reported: None,
                },
            );
            state.active = Some(request.session);
        }
        inner.raise_shell();
        inner.attach_rule_lists(&webview);
        inner.sync_views();
        Ok(())
    }

    pub fn activate(&self, request: SessionRequest) -> Result<()> {
        let inner = &self.inner;
        parse_session_id(&request.session)?;
        let stale = {
            let mut state = inner.state();
            let stale = state
                .sessions
                .get(&request.session)
                .ok_or(Error::UnknownSession)?
                .stale;
            state.active = Some(request.session.clone());
            stale
        };
        if stale {
            inner.rebuild(&request.session)?;
        }
        inner.sync_views();
        Ok(())
    }

    pub fn close(&self, request: SessionRequest) -> Result<()> {
        let removed = {
            let mut state = self.inner.state();
            if state.active.as_deref() == Some(request.session.as_str()) {
                state.active = None;
            }
            state.media_paused.remove(&request.session);
            state.native_suspended.remove(&request.session);
            state.sessions.remove(&request.session)
        };
        if let Some(session) = removed {
            session.webview.close()?;
        }
        Ok(())
    }

    pub fn set_rect(&self, request: SetRectRequest) -> Result<()> {
        self.inner.state().rect = Some(request.rect);
        self.inner.sync_views();
        Ok(())
    }

    pub fn set_interactive_regions(&self, request: SetInteractiveRegionsRequest) -> Result<()> {
        platform::set_regions(request.regions.clone());
        self.inner.state().regions = request.regions;
        self.inner.sync_views();
        Ok(())
    }

    pub fn set_covered(&self, request: SetCoveredRequest) -> Result<()> {
        self.inner.state().covered = request.covered;
        self.inner.sync_views();
        Ok(())
    }

    pub fn navigate(&self, request: NavigateRequest) -> Result<()> {
        let url = parse_web_url(&request.url)?;
        Ok(self.inner.active_webview()?.navigate(url)?)
    }

    pub fn go_back(&self) -> Result<()> {
        platform::go_back(&self.inner.active_webview()?)
    }

    pub fn go_forward(&self) -> Result<()> {
        platform::go_forward(&self.inner.active_webview()?)
    }

    /// Zooms the page now showing. Rust-only: raised by the app's View menu.
    pub fn zoom(&self, request: ZoomRequest) -> Result<()> {
        platform::zoom(&self.inner.active_webview()?, request.action)
    }

    /// Gives the keyboard to the shell, whose shortcuts then see every key, or back to the page
    /// showing. Rust-only: raised by the shell's own shortcuts.
    pub fn focus_keyboard(&self, to_shell: bool) -> Result<()> {
        let label = if to_shell {
            MAIN_WINDOW.to_owned()
        } else {
            self.inner.active_webview()?.label().to_owned()
        };
        self.inner.give_keyboard(&label);
        Ok(())
    }

    pub fn reload(&self) -> Result<()> {
        Ok(self.inner.active_webview()?.reload()?)
    }

    /// A local notification for a hidden session; tapping it reports the session to the shell.
    pub fn notify(&self, request: NotifyRequest) -> Result<()> {
        platform::notify::notify(&request.session, &request.title, &request.body)
    }
}

impl<R: Runtime> Siteview<R> {
    /// The window's appearance decides `prefers-color-scheme` for every page in it.
    pub fn set_color_scheme(&self, request: SetColorSchemeRequest) -> Result<()> {
        self.inner.app.set_theme(match request.scheme {
            ColorScheme::System => None,
            ColorScheme::Light => Some(Theme::Light),
            ColorScheme::Dark => Some(Theme::Dark),
        });
        Ok(())
    }

    /// Fetches a small PNG for the site's icon. Blocks on the network, so callers stay off the
    /// main thread.
    pub fn fetch_favicon(&self, request: FetchFaviconRequest) -> Result<Option<String>> {
        Ok(favicon::fetch(&parse_web_url(&request.url)?))
    }

    /// Replaces the script injected at document start. Every view gets the new script for the
    /// pages it loads next and runs it on the page it shows now, so a switch changed in Settings
    /// shows at once and the page keeps its place. A view whose user scripts cannot be swapped is
    /// rebuilt at its address instead (the visible one now, a hidden one when next shown).
    pub fn set_document_start_script(&self, request: SetDocumentStartScriptRequest) -> Result<()> {
        let script = request.script;
        let (previous, views, active) = {
            let mut state = self.inner.state();
            let previous = std::mem::replace(&mut state.document_start_script, script.clone());
            let views: Vec<(String, Webview<R>)> = state
                .sessions
                .iter()
                .map(|(id, session)| (id.clone(), session.webview.clone()))
                .collect();
            (previous, views, state.active.clone())
        };
        let live = format!(
            "document.querySelectorAll('style[data-openmedia]').forEach(function(s){{s.remove()}});{script}"
        );
        let mut rebuild_active = false;
        for (id, webview) in views {
            let swapped =
                platform::replace_user_script(&webview, &previous, &script).unwrap_or(false);
            if swapped {
                let _ = webview.eval(&live);
                continue;
            }
            if active.as_deref() == Some(id.as_str()) {
                rebuild_active = true;
            } else if let Some(session) = self.inner.state().sessions.get_mut(&id) {
                session.stale = true;
            }
        }
        match active {
            Some(session) if rebuild_active => self.inner.rebuild(&session),
            _ => Ok(()),
        }
    }

    /// Replaces the rule lists on every open view and reloads the visible one.
    pub fn set_content_rule_lists(&self, request: SetContentRuleListsRequest) -> Result<()> {
        let (views, active) = {
            let mut state = self.inner.state();
            state.rule_lists = request.lists.clone();
            let views: Vec<Webview<R>> = state
                .sessions
                .values()
                .map(|session| session.webview.clone())
                .collect();
            let active = state
                .active
                .as_ref()
                .and_then(|id| state.sessions.get(id))
                .map(|session| session.webview.clone());
            (views, active)
        };
        for webview in views {
            platform::set_rule_lists(&webview, request.lists.clone())?;
        }
        if let (Some(webview), true) = (active, platform::APPLIES_RULE_LISTS) {
            webview.reload()?;
        }
        Ok(())
    }

    /// Closes a session for the day: the view is hidden, its media stops and its load is cut.
    /// Rust-only: there is no command for it, so no webview can call it.
    pub fn set_blocked(&self, request: SetBlockedRequest) -> Result<()> {
        let webview = {
            let mut state = self.inner.state();
            state.blocked.retain(|id| id != &request.session);
            if request.blocked {
                state.blocked.push(request.session.clone());
                if state.blocked.len() > MAX_REMEMBERED_BLOCKED {
                    state.blocked.remove(0);
                }
            }
            state
                .sessions
                .get(&request.session)
                .map(|session| session.webview.clone())
        };
        if let (Some(webview), true) = (webview, request.blocked) {
            let _ = webview.eval(STOP_MEDIA_SCRIPT);
        }
        self.inner.sync_views();
        Ok(())
    }

    /// Names the sites whose media may keep playing while hidden. Rust-only: there is no command
    /// for it, so no webview can call it.
    pub fn set_background_media(&self, request: SetBackgroundMediaRequest) -> Result<()> {
        self.inner.state().background_media = request.sites;
        self.inner.sync_views();
        Ok(())
    }

    /// macOS child webviews leave picture-in-picture to WebKit's own video controls, so the list
    /// is accepted and not acted on.
    pub fn set_picture_in_picture(&self, _request: SetPictureInPictureRequest) -> Result<()> {
        Ok(())
    }

    /// Desktop system web views already send a desktop user agent and lay pages out at desktop
    /// width, so the list is accepted and not acted on.
    pub fn set_desktop_sites(&self, _request: SetDesktopSitesRequest) -> Result<()> {
        Ok(())
    }

    /// No desktop system has a share sheet in this build: the shell copies the address instead.
    pub fn share(&self, _request: ShareRequest) -> Result<()> {
        Err(Error::DesktopUnsupported("sharing"))
    }

    /// Erases one site's cookies, storage and cache from the active page's data store, then
    /// reloads the page. Rust-only: no webview can call it. Where the system web view cannot
    /// erase one site (Windows and Linux), it is an error and nothing is erased.
    pub fn clear_site_data(&self, request: ClearSiteDataRequest) -> Result<()> {
        let site = check_site(&request.site)?;
        let webview = self.inner.active_webview()?;
        platform::clear_site_data(&webview, site)?;
        Ok(webview.reload()?)
    }

    /// The system's owner check (Touch ID or the account password on a Mac, Windows Hello on
    /// Windows, the PolicyKit prompt on Linux). Rust-only: there is no command for it, so no
    /// webview can raise or answer the prompt. Waits for the person.
    pub fn authenticate(&self, request: AuthenticateRequest) -> Result<bool> {
        platform::authenticate(&self.inner.app, check_auth_reason(&request.reason)?)
    }

    /// The generic fingerprint icon is shown on every desktop system.
    pub fn biometry_kind(&self) -> Result<BiometryKind> {
        Ok(BiometryKind::Fingerprint)
    }

    /// Runs `request.script` (an expression) in the active session's main frame and returns its
    /// value as JSON text. Rust-only: no webview can call it. The result is hostile page data.
    pub fn evaluate(&self, request: EvaluateRequest) -> Result<String> {
        let script = wrap_evaluate_script(&request.script)?;
        let webview = self.inner.active_webview()?;
        let (sender, receiver) = mpsc::channel();
        webview.eval_with_callback(script, move |answer| {
            let _ = sender.send(answer);
        })?;
        let answer = receiver
            .recv_timeout(EVALUATE_TIMEOUT)
            .map_err(|_| Error::PageTimeout)?;
        // The page returned `JSON.stringify(...)`, a string, and the callback JSON-encodes it again.
        let json: String =
            serde_json::from_str(&answer).map_err(|_| Error::BridgeMessageInvalid)?;
        check_evaluate_result(json)
    }

    /// Reads no pixel: the page script's own color is used on the Mac. Rust-only like `evaluate`.
    pub fn sample_color(&self, _request: SampleColorRequest) -> Result<Option<String>> {
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_hidden_page_pauses_unless_its_site_plays_on_and_a_shown_one_resumes() {
        assert_eq!(
            media_step(false, false, false, false),
            Some(MediaStep::Pause)
        );
        assert_eq!(media_step(false, false, false, true), None);
        assert_eq!(media_step(false, false, true, false), None);
        assert_eq!(
            media_step(true, false, false, true),
            Some(MediaStep::Resume)
        );
        assert_eq!(media_step(true, false, false, false), None);
        assert_eq!(
            media_step(false, false, true, true),
            Some(MediaStep::Resume)
        );
    }

    #[test]
    fn a_closed_session_is_left_to_the_usage_block() {
        assert_eq!(media_step(false, true, false, false), None);
        assert_eq!(media_step(true, true, false, true), None);
    }

    #[test]
    fn only_web_pages_may_load() {
        for allowed in [
            "https://example.com/",
            "http://localhost:8080/",
            "about:blank",
        ] {
            assert!(
                allows_navigation(&Url::parse(allowed).unwrap()),
                "{allowed}"
            );
        }
        for refused in [
            "mailto:a@b.c",
            "tel:123",
            "javascript:alert(1)",
            "file:///etc/passwd",
            "tauri://localhost/",
            "itms-apps://apps.apple.com/",
            POPUP_CLOSE_URL,
        ] {
            assert!(
                !allows_navigation(&Url::parse(refused).unwrap()),
                "{refused}"
            );
        }
    }

    #[test]
    fn a_scope_covers_itself_and_its_subdomains_only() {
        assert!(scope_contains("instagram.com", "instagram.com"));
        assert!(scope_contains("instagram.com", "WWW.Instagram.com."));
        assert!(!scope_contains("instagram.com", "notinstagram.com"));
        assert!(!scope_contains("instagram.com", "instagram.com.evil.net"));
    }

    #[test]
    fn the_scope_of_a_page_is_its_registrable_domain() {
        assert_eq!(
            scope_of("https://m.youtube.com/watch"),
            Some("youtube.com".into())
        );
        assert_eq!(
            scope_of("https://news.bbc.co.uk/"),
            Some("bbc.co.uk".into())
        );
        assert_eq!(scope_of("about:blank"), None);
    }

    #[test]
    fn sign_in_windows_are_told_from_ad_windows() {
        let yes = |url: &str| looks_like_sign_in(&Url::parse(url).unwrap());
        assert!(yes("https://accounts.google.com/o/oauth2/v2/auth?x=1"));
        assert!(yes("https://appleid.apple.com/auth/authorize?a=b"));
        assert!(yes("https://sub.okta.com/app/x"));
        assert!(yes("https://idp.example/oauth2/authorize?client_id=1"));
        assert!(yes(
            "https://idp.example/start?client_id=1&redirect_uri=https%3A%2F%2Fa"
        ));
        assert!(yes("https://idp.example/x?SAMLRequest=abc"));
        assert!(!yes("https://mv.auditsupcast.click/sbx/b/abc?xy=1"));
        assert!(!yes("https://evil.io/author/page"));
        assert!(!yes("https://notpaypal.com/"));
        assert!(!yes("https://x.example/?client_id=1"));
    }
}
