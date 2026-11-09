//! The parts of a site view that Tauri's webview API does not expose, read from the `WKWebView`
//! itself. Every call hops to the main thread and waits for the answer, so none may run on it.

use std::{sync::mpsc, time::Duration};

use block2::RcBlock;
use objc2::{MainThreadMarker, msg_send, runtime::Bool};
use objc2_foundation::{NSArray, NSEdgeInsets, NSError, NSString};
use objc2_local_authentication::{LAContext, LAPolicy};
use objc2_web_kit::{
    WKContentRuleList, WKContentRuleListStore, WKUserContentController, WKWebView,
};
use tauri::{Runtime, Webview};

use crate::{ContentRuleList, Error, Result, ZoomAction};

/// How long to wait for the main thread. It only has to answer between two events.
const MAIN_THREAD_WAIT: Duration = Duration::from_secs(3);

/// What the web view knows about its page.
#[derive(Debug, Clone, PartialEq)]
pub struct PageSnapshot {
    pub url: Option<String>,
    pub title: Option<String>,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
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

pub fn snapshot<R: Runtime>(webview: &Webview<R>) -> Result<PageSnapshot> {
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

/// Turns on the trackpad gestures a Mac browser has: a two-finger swipe goes back and forward
/// through the page's history, and pinching or double-tapping with two fingers zooms.
pub fn enable_gestures<R: Runtime>(webview: &Webview<R>) -> Result<()> {
    // SAFETY: plain property writes on the main thread.
    with_view(webview, |view| unsafe {
        view.setAllowsBackForwardNavigationGestures(true);
        view.setAllowsMagnification(true);
    })
}

const ZOOM_STEP: f64 = 1.1;
const MIN_ZOOM: f64 = 0.3;
const MAX_ZOOM: f64 = 5.0;

/// The page size after `action`, given the size now.
pub fn zoomed(current: f64, action: ZoomAction) -> f64 {
    match action {
        ZoomAction::In => (current * ZOOM_STEP).min(MAX_ZOOM),
        ZoomAction::Out => (current / ZOOM_STEP).max(MIN_ZOOM),
        ZoomAction::Reset => 1.0,
    }
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
pub fn authenticate(reason: &str) -> Result<bool> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zooming_in_and_out_steps_and_stays_in_range() {
        assert!((zoomed(1.0, ZoomAction::In) - 1.1).abs() < 1e-9);
        assert!((zoomed(1.1, ZoomAction::Out) - 1.0).abs() < 1e-9);
        assert_eq!(zoomed(MAX_ZOOM, ZoomAction::In), MAX_ZOOM);
        assert_eq!(zoomed(MIN_ZOOM, ZoomAction::Out), MIN_ZOOM);
    }

    #[test]
    fn reset_returns_to_actual_size() {
        assert_eq!(zoomed(2.3, ZoomAction::Reset), 1.0);
    }
}
