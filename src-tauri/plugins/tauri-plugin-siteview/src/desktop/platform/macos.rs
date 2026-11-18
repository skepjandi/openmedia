//! macOS: the parts of a site view that Tauri's webview API does not expose, read from the
//! `WKWebView` itself. Every call hops to the main thread and waits for the answer, so none may
//! run on it.

use std::{path::Path, process::Command, sync::mpsc, time::Duration};

use block2::RcBlock;
use objc2::{MainThreadMarker, MainThreadOnly, msg_send, rc::Retained, runtime::Bool};
use objc2_foundation::{NSArray, NSEdgeInsets, NSError, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};
use objc2_web_kit::{
    WKContentRuleList, WKContentRuleListStore, WKUserContentController, WKUserScript,
    WKUserScriptInjectionTime, WKWebView,
};
use tauri::{AppHandle, Runtime, Webview, webview::WebviewBuilder};
use url::Url;
use uuid::Uuid;

use super::{PageSnapshot, Track, zoomed};
use crate::{ContentRuleList, Error, Rect, Result, ZoomAction};

pub mod notify;
mod shell;

/// How long to wait for the main thread. It only has to answer between two events.
const MAIN_THREAD_WAIT: Duration = Duration::from_secs(3);

/// A `WKWebView` reports no `Safari` token, which Google reads as an embedded browser and refuses
/// to sign in from. This is what Safari on macOS sends (it freezes the OS version in the string).
pub const USER_AGENT: Option<&str> = Some(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Safari/605.1.15",
);

/// The shell is transparent and answers clicks only where it drew something, so the page sits
/// under it at full size (see `shell.rs`).
pub const CLICK_THROUGH: bool = true;

/// Safari content rule lists block requests inside the web view.
pub const APPLIES_RULE_LISTS: bool = true;

/// Where the shell wants clicks, in its own CSS pixels.
pub fn set_regions(regions: Vec<Rect>) {
    shell::set_regions(regions);
}

/// Puts the page view at `bounds` (window coordinates, logical pixels).
pub fn place<R: Runtime>(_shell: &Webview<R>, page: &Webview<R>, bounds: Rect) -> Result<()> {
    Ok(page.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
    })?)
}

/// A data store per profile keeps cookies and storage apart (macOS 14 and later, which the bundle
/// requires).
pub fn configure_profile<R: Runtime>(
    builder: WebviewBuilder<R>,
    _profiles: &Path,
    profile: Uuid,
) -> WebviewBuilder<R> {
    builder.data_store_identifier(profile.into_bytes())
}

/// Selects a file in Finder.
pub fn reveal_file(file: &Path) {
    let _ = Command::new("open").arg("-R").arg(file).spawn();
}

/// Hands a link to the user's browser. The URL is http or https and is passed as one argument.
pub fn open_in_browser(url: &Url) {
    let _ = Command::new("open").arg(url.as_str()).spawn();
}

/// Runs `work` on the main thread with the session's `WKWebView` and returns its result.
fn with_view<R, T>(
    webview: &Webview<R>,
    work: impl FnOnce(&WKWebView) -> T + Send + 'static,
) -> Result<T>
where
    R: Runtime,
    T: Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    webview.with_webview(move |platform| {
        // SAFETY: on macOS `inner()` is the session's `WKWebView`; it stays alive while this
        // closure runs on the main thread, and nothing keeps the reference past it.
        let view = unsafe { &*platform.inner().cast::<WKWebView>() };
        let _ = sender.send(work(view));
    })?;
    receiver
        .recv_timeout(MAIN_THREAD_WAIT)
        .map_err(|_| Error::PageTimeout)
}

pub fn snapshot<R: Runtime>(webview: &Webview<R>, _track: &Track) -> Result<PageSnapshot> {
    with_view(webview, |view| {
        // SAFETY: plain property reads on the main thread.
        unsafe {
            PageSnapshot {
                url: view
                    .URL()
                    .and_then(|url| url.absoluteString())
                    .map(|url| url.to_string()),
                title: view
                    .title()
                    .map(|title| title.to_string())
                    .filter(|title| !title.is_empty()),
                loading: view.isLoading(),
                can_go_back: view.canGoBack(),
                can_go_forward: view.canGoForward(),
            }
        }
    })
}

/// How far the web view's content is pushed in from its own frame, in points: `(left, top, right,
/// bottom)`. A web view under a full-size title bar lays its page out below it, so the page the
/// shell draws starts below the frame's top edge.
pub fn content_insets<R: Runtime>(webview: &Webview<R>) -> Result<(f64, f64, f64, f64)> {
    with_view(webview, |view| {
        // SAFETY: `safeAreaInsets` is a plain property of `NSView` (macOS 11 and later).
        let insets: NSEdgeInsets = unsafe { msg_send![view, safeAreaInsets] };
        (insets.left, insets.top, insets.right, insets.bottom)
    })
}

/// Prepares the shell's web view (see `shell.rs`); run it again after each page view is added.
pub fn prepare_shell<R: Runtime>(shell: &Webview<R>) -> Result<()> {
    with_view(shell, shell::prepare)
}

/// Turns on the trackpad gestures a Mac browser has: a two-finger swipe goes back and forward
/// through the page's history, and pinching or double-tapping with two fingers zooms.
pub fn enable_gestures<R: Runtime>(webview: &Webview<R>) -> Result<()> {
    // SAFETY: plain property writes on the main thread.
    with_view(webview, |view| unsafe {
        view.setAllowsBackForwardNavigationGestures(true);
        view.setAllowsMagnification(true);
    })
}

/// Suspends or resumes the media of every frame of the page, the iframes of a player included,
/// which a script of the page's own document cannot reach. WebKit counts the calls: each suspend
/// needs one resume, so the caller keeps them in pairs.
pub fn set_media_suspended<R: Runtime>(webview: &Webview<R>, suspended: bool) -> Result<()> {
    // SAFETY: a plain call on the main thread; no completion handler is needed.
    with_view(webview, move |view| unsafe {
        view.setAllMediaPlaybackSuspended_completionHandler(suspended, None);
    })
}

/// Changes the page size, as Cmd + / Cmd - / Cmd 0 do in a browser. A reset also drops a pinch.
pub fn zoom<R: Runtime>(webview: &Webview<R>, action: ZoomAction) -> Result<()> {
    // SAFETY: property reads and writes on the main thread.
    with_view(webview, move |view| unsafe {
        view.setPageZoom(zoomed(view.pageZoom(), action));
        if action == ZoomAction::Reset {
            view.setMagnification(1.0);
        }
    })
}

/// Swaps the document-start script `old` for `new` among the web view's user scripts, keeping the
/// others (Tauri adds its own beside ours). `old` empty means no script was installed yet. Says
/// whether the swap happened: false when `old` is not among the scripts, which the caller answers
/// by rebuilding the view.
pub fn replace_user_script<R: Runtime>(webview: &Webview<R>, old: &str, new: &str) -> Result<bool> {
    let (old, new) = (old.to_owned(), new.to_owned());
    with_view(webview, move |view| {
        let Some(mtm) = MainThreadMarker::new() else {
            return false;
        };
        // SAFETY: user-script bookkeeping on the main thread; every script that is removed is
        // added again unless it is the one being replaced.
        unsafe {
            let controller = view.configuration().userContentController();
            let kept: Vec<Retained<WKUserScript>> = controller
                .userScripts()
                .iter()
                .filter(|script| script.source().to_string() != old)
                .collect();
            if !old.is_empty() && kept.len() == controller.userScripts().len() {
                return false;
            }
            controller.removeAllUserScripts();
            for script in &kept {
                controller.addUserScript(script);
            }
            if !new.is_empty() {
                let script = WKUserScript::initWithSource_injectionTime_forMainFrameOnly(
                    WKUserScript::alloc(mtm),
                    &NSString::from_str(&new),
                    WKUserScriptInjectionTime::AtDocumentStart,
                    true,
                );
                controller.addUserScript(&script);
            }
            true
        }
    })
}

pub fn go_back<R: Runtime>(webview: &Webview<R>) -> Result<()> {
    // SAFETY: a navigation request on the main thread; the returned navigation is not needed.
    with_view(webview, |view| unsafe {
        view.goBack();
    })
}

pub fn go_forward<R: Runtime>(webview: &Webview<R>) -> Result<()> {
    // SAFETY: as for `go_back`.
    with_view(webview, |view| unsafe {
        view.goForward();
    })
}

/// Replaces the content rule lists on the web view with `lists` (none turns blocking off).
///
/// Lists the system already holds attach as soon as WebKit answers the lookup; missing ones are
/// read from their file and compiled in the background, then attach without a reload. So the very
/// first page after an install or a list update is not blocked, and its next navigation is.
/// Lists nobody asked for any more are dropped from the system's store.
pub fn set_rule_lists<R: Runtime>(webview: &Webview<R>, lists: Vec<ContentRuleList>) -> Result<()> {
    with_view(webview, move |view| {
        let Some(main) = MainThreadMarker::new() else {
            return;
        };
        // SAFETY: WebKit calls on the main thread; the blocks run there too, and own what they use.
        unsafe {
            let controller = view.configuration().userContentController();
            controller.removeAllContentRuleLists();
            let Some(store) = WKContentRuleListStore::defaultStore(main) else {
                return;
            };
            let keep: Vec<String> = lists.iter().map(|list| list.id.clone()).collect();
            for list in lists {
                attach_or_compile(&store, &controller, list);
            }
            remove_stale(&store, keep);
        }
    })
}

/// # Safety
/// Main thread only.
unsafe fn attach_or_compile(
    store: &objc2::rc::Retained<WKContentRuleListStore>,
    controller: &objc2::rc::Retained<WKUserContentController>,
    list: ContentRuleList,
) {
    let identifier = NSString::from_str(&list.id);
    let lookup = {
        let store = store.clone();
        let controller = controller.clone();
        RcBlock::new(move |found: *mut WKContentRuleList, _error: *mut NSError| {
            // SAFETY: WebKit hands over a valid list or null, on the main queue.
            if let Some(found) = unsafe { found.as_ref() } {
                unsafe { controller.addContentRuleList(found) };
            } else {
                unsafe { compile(&store, &controller, &list) };
            }
        })
    };
    unsafe {
        store.lookUpContentRuleListForIdentifier_completionHandler(Some(&identifier), Some(&lookup))
    };
}

/// # Safety
/// Main thread only.
unsafe fn compile(
    store: &WKContentRuleListStore,
    controller: &objc2::rc::Retained<WKUserContentController>,
    list: &ContentRuleList,
) {
    let Ok(json) = std::fs::read_to_string(&list.path) else {
        return;
    };
    let controller = controller.clone();
    let done = RcBlock::new(
        move |compiled: *mut WKContentRuleList, _error: *mut NSError| {
            // SAFETY: WebKit hands over a valid list or null, on the main queue.
            if let Some(compiled) = unsafe { compiled.as_ref() } {
                unsafe { controller.addContentRuleList(compiled) };
            }
        },
    );
    unsafe {
        store.compileContentRuleListForIdentifier_encodedContentRuleList_completionHandler(
            Some(&NSString::from_str(&list.id)),
            Some(&NSString::from_str(&json)),
            Some(&done),
        );
    }
}

/// # Safety
/// Main thread only.
unsafe fn remove_stale(store: &objc2::rc::Retained<WKContentRuleListStore>, keep: Vec<String>) {
    let inner = store.clone();
    let available = RcBlock::new(move |identifiers: *mut NSArray<NSString>| {
        // SAFETY: WebKit hands over a valid array or null, on the main queue.
        let Some(identifiers) = (unsafe { identifiers.as_ref() }) else {
            return;
        };
        for identifier in identifiers.iter() {
            if !keep.contains(&identifier.to_string()) {
                let removed = RcBlock::new(|_error: *mut NSError| {});
                unsafe {
                    inner.removeContentRuleListForIdentifier_completionHandler(
                        Some(&identifier),
                        Some(&removed),
                    );
                }
            }
        }
    });
    unsafe { store.getAvailableContentRuleListIdentifiers(Some(&available)) };
}

/// How long the person has to answer the system's prompt.
const AUTHENTICATION_WAIT: Duration = Duration::from_secs(180);

/// Asks the Mac's owner to prove they are present: Touch ID or Apple Watch, with the account
/// password as the system's own fallback. `Ok(false)` means they cancelled or failed; a Mac with
/// neither a password nor Touch ID set up is an error, so the check fails closed. Waits for the
/// person, so it must not run on the main thread.
pub fn authenticate<R: Runtime>(_app: &AppHandle<R>, reason: &str) -> Result<bool> {
    // SAFETY: plain calls into LocalAuthentication; the reply block owns its sender and runs once.
    unsafe {
        let context = LAContext::new();
        context
            .canEvaluatePolicy_error(LAPolicy::DeviceOwnerAuthentication)
            .map_err(|_| Error::OwnerCheckUnavailable)?;
        let (sender, receiver) = mpsc::channel();
        let reply = RcBlock::new(move |passed: Bool, _error: *mut NSError| {
            let _ = sender.send(passed.as_bool());
        });
        context.evaluatePolicy_localizedReason_reply(
            LAPolicy::DeviceOwnerAuthentication,
            &NSString::from_str(reason),
            &reply,
        );
        receiver
            .recv_timeout(AUTHENTICATION_WAIT)
            .map_err(|_| Error::PageTimeout)
    }
}
