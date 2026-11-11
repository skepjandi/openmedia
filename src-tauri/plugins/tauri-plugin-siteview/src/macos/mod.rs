//! Site views on macOS: one Tauri child webview per session, stacked above the shell.
//!
//! The shell is the window's own webview, kept above the page views and transparent, as on
//! mobile: it reports the rectangle the page takes (`set_rect`) and the regions where it wants
//! clicks (`set_interactive_regions`); everywhere else a click goes to the page below. See
//! [`shell`] for how that is done.
//!
//! Tauri's webview API has no navigation state, so a poll thread reads it from the `WKWebView`
//! (see [`native`]) and reports changes as `siteview:state`, the same event mobile sends.
//!
//! Calls that reach a web view hop to the main thread and wait, so they must never run on it.

mod favicon;
mod layout;
mod native;
mod notify;
mod shell;

use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex, MutexGuard, PoisonError, Weak,
        atomic::{AtomicU64, Ordering},
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
        DownloadEvent, NewWindowFeatures, NewWindowResponse, PermissionResponse, WebviewBuilder,
    },
};
use url::Url;
use uuid::Uuid;

use native::PageSnapshot;

use crate::events::{NOTIFICATION_TAP_EVENT, STATE_EVENT};
use crate::models::*;
use crate::site::site_of_host;
use crate::validate::{
    check_auth_reason, check_evaluate_result, parse_profile_id, parse_session_id, parse_web_url,
    wrap_evaluate_script,
};
use crate::{Error, Result};

/// The longest page title, and address in bytes, the shell is told about.
const MAX_REPORTED_TITLE_CHARS: usize = 256;
const MAX_REPORTED_URL_BYTES: usize = 4096;

const MAIN_WINDOW: &str = "main";
/// How often each session's page state is read. Single-page sites change address without a page
/// load, so the state has to be asked for.
const POLL_INTERVAL: Duration = Duration::from_millis(400);
/// A page that has not finished loading is still shown after this long.
const PAINT_FALLBACK: Duration = Duration::from_millis(1500);
const EVALUATE_TIMEOUT: Duration = Duration::from_secs(5);
/// A `WKWebView` reports no `Safari` token, which Google reads as an embedded browser and refuses
/// to sign in from. This is what Safari on macOS sends (it freezes the OS version in the string).
const SAFARI_USER_AGENT: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15";
/// How many closed sessions are remembered; the oldest are forgotten first.
const MAX_REMEMBERED_BLOCKED: usize = 32;
const STOP_MEDIA_SCRIPT: &str =
    "document.querySelectorAll('video,audio').forEach(function(m){m.pause()});window.stop();";

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
}

/// Everything a new web view needs.
struct NewView<'a> {
    label: &'a str,
    url: Url,
    profile: Uuid,
    script: &'a str,
    scope: &'a Arc<Mutex<String>>,
    bounds: Rect,
}

struct Inner<R: Runtime> {
    app: AppHandle<R>,
    state: Mutex<State<R>>,
    labels: AtomicU64,
    /// The label of the web view that was last given the keyboard.
    focused: Mutex<Option<String>>,
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
        }),
        labels: AtomicU64::new(0),
        focused: Mutex::new(None),
    });
    spawn_poller(Arc::downgrade(&inner))?;
    let tapped = app.clone();
    notify::install(move |session| {
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

/// Selects a file in Finder.
fn reveal_in_finder(file: &Path) {
    let _ = Command::new("open").arg("-R").arg(file).spawn();
}

/// Hands a link to the user's browser. The URL is http or https and is passed as one argument.
fn open_in_browser(url: &Url) {
    let _ = Command::new("open").arg(url.as_str()).spawn();
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
    Ok(
        WebviewWindowBuilder::new(app, &label, WebviewUrl::External(blank))
            .window_features(features)
            .user_agent(SAFARI_USER_AGENT)
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
            .build()?,
    )
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
        let (left, top, right, bottom) = native::content_insets(&shell)?;
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

    fn build_webview(&self, window: &Window<R>, view: NewView<'_>) -> Result<Webview<R>> {
        let NewView {
            label,
            url,
            profile,
            script,
            scope,
            bounds,
        } = view;
        let app = self.app.clone();
        let scope = Arc::clone(scope);
        let own_label = label.to_owned();
        let downloading = Mutex::new(None::<PathBuf>);
        let mut builder = WebviewBuilder::new(label, WebviewUrl::External(url))
            .user_agent(SAFARI_USER_AGENT)
            // A data store per profile keeps cookies and storage apart (macOS 14 and later, which
            // the bundle requires).
            .data_store_identifier(profile.into_bytes())
            .on_navigation(allows_navigation)
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
                            reveal_in_finder(&file);
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
                // Sign-in (Google, Apple) and outside links open in a popup inside the app. It is
                // built on the opener's configuration, so it shares the session's data store and
                // keeps `window.opener`, which sign-in flows report back through.
                match open_popup(&app, features) {
                    Ok(window) => NewWindowResponse::Create { window },
                    Err(_) => {
                        open_in_browser(&url);
                        NewWindowResponse::Deny
                    }
                }
            });
        builder = builder.initialization_script(POPUP_CLOSE_SCRIPT);
        if !script.is_empty() {
            builder = builder.initialization_script(script);
        }
        let webview = window.add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )?;
        native::enable_gestures(&webview)?;
        Ok(webview)
    }

    /// Puts every view where it belongs: the active one visible unless the shell covers it or the
    /// session is closed for the day, the rest hidden.
    fn sync_views(&self) {
        let (rect, overlay, views) = {
            let state = self.state();
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
            (rect, overlay, views)
        };
        // Asked of the main thread, so never while the state lock is held.
        let bounds = rect.and_then(|rect| self.page_bounds(Some(rect)).ok());
        for (webview, shown) in &views {
            if let Some(rect) = bounds {
                let _ = webview.set_bounds(tauri::Rect {
                    position: LogicalPosition::new(rect.x, rect.y).into(),
                    size: LogicalSize::new(rect.width, rect.height).into(),
                });
            }
            let _ = if *shown {
                webview.show()
            } else {
                webview.hide()
            };
        }
        let page = views.iter().find(|(_, shown)| *shown);
        let focus = match page {
            Some((webview, _)) if !overlay => webview.label().to_owned(),
            _ => MAIN_WINDOW.to_owned(),
        };
        self.focus(&focus);
    }

    /// Gives the keyboard to the page showing, or to the shell while an overlay is open: the page
    /// would otherwise keep every key press, and Escape would never reach the shell.
    fn focus(&self, label: &str) {
        let mut focused = self.focused.lock().unwrap_or_else(PoisonError::into_inner);
        if focused.as_deref() == Some(label) {
            return;
        }
        if let Some(webview) = self.app.get_webview(label) {
            let _ = webview.set_focus();
        }
        *focused = Some(label.to_owned());
    }

    /// Keeps the shell above the page views; a view added later would otherwise cover it.
    fn raise_shell(&self) {
        if let Some(shell) = self.app.get_webview(MAIN_WINDOW) {
            let _ = native::prepare_shell(&shell);
        }
    }

    fn attach_rule_lists(&self, webview: &Webview<R>) {
        let lists = self.state().rule_lists.clone();
        if !lists.is_empty() {
            let _ = native::set_rule_lists(webview, lists);
        }
    }

    /// Replaces a session's view with a new one at the page's current address, so the page loads
    /// under the current script. The page's history is not carried over.
    fn rebuild(&self, session: &str) -> Result<()> {
        let window = self.window()?;
        let (old, profile, scope, opened_url, script, rect) = {
            let state = self.state();
            let entry = state.sessions.get(session).ok_or(Error::UnknownSession)?;
            (
                entry.webview.clone(),
                entry.profile,
                Arc::clone(&entry.scope),
                entry.opened_url.clone(),
                state.document_start_script.clone(),
                state.rect,
            )
        };
        let url = native::snapshot(&old)
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
            bounds,
        };
        let webview = self.build_webview(&window, view)?;
        {
            let mut state = self.state();
            if let Some(entry) = state.sessions.get_mut(session) {
                entry.webview = webview.clone();
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

    fn poll(&self) {
        let targets: Vec<(String, Webview<R>)> = self
            .state()
            .sessions
            .iter()
            .map(|(id, session)| (id.clone(), session.webview.clone()))
            .collect();
        for (id, webview) in targets {
            if let Ok(page) = native::snapshot(&webview) {
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
            (state.document_start_script.clone(), state.rect)
        };
        let bounds = inner.page_bounds(bounds)?;
        let scope = Arc::new(Mutex::new(
            url.host_str().map(site_of_host).unwrap_or_default(),
        ));
        let label = inner.next_label(&request.session);
        let view = NewView {
            label: &label,
            url,
            profile,
            script: &script,
            scope: &scope,
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
        shell::set_regions(request.regions.clone());
        self.inner.state().regions = request.regions;
        self.inner.sync_views();
        Ok(())
    }

    pub fn navigate(&self, request: NavigateRequest) -> Result<()> {
        let url = parse_web_url(&request.url)?;
        Ok(self.inner.active_webview()?.navigate(url)?)
    }

    pub fn go_back(&self) -> Result<()> {
        native::go_back(&self.inner.active_webview()?)
    }

    pub fn go_forward(&self) -> Result<()> {
        native::go_forward(&self.inner.active_webview()?)
    }

    /// Zooms the page now showing. Rust-only: raised by the app's View menu.
    pub fn zoom(&self, request: ZoomRequest) -> Result<()> {
        native::zoom(&self.inner.active_webview()?, request.action)
    }

    pub fn reload(&self) -> Result<()> {
        Ok(self.inner.active_webview()?.reload()?)
    }

    /// A local notification for a hidden session; tapping it reports the session to the shell.
    pub fn notify(&self, request: NotifyRequest) -> Result<()> {
        notify::notify(&request.session, &request.title, &request.body)
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
                native::replace_user_script(&webview, &previous, &script).unwrap_or(false);
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
            native::set_rule_lists(&webview, request.lists.clone())?;
        }
        if let Some(webview) = active {
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

    /// Touch ID, Apple Watch or the account password, as the system offers. Rust-only: there is
    /// no command for it, so no webview can raise or answer the prompt. Waits for the person.
    pub fn authenticate(&self, request: AuthenticateRequest) -> Result<bool> {
        native::authenticate(check_auth_reason(&request.reason)?)
    }

    /// The Mac's biometric is Touch ID.
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
