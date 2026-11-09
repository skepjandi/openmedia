//! The shell above the pages, as on mobile: the page views sit under a transparent shell, and a
//! touch (here a click) reaches the shell only where the shell says it has something, and the page
//! everywhere else.
//!
//! Three things make that so on macOS. The shell web view stops painting its own background (a
//! private `WKWebView` key, `drawsBackground`, the one Tauri's `macOSPrivateApi` sets), is kept
//! above every page view, and answers `hitTest:` with nothing outside the interactive regions the
//! shell reports, so AppKit offers the click to the page view underneath instead.

use std::{
    mem::transmute,
    ptr::{null, null_mut},
    sync::{
        Mutex, Once, OnceLock, PoisonError,
        atomic::{AtomicUsize, Ordering},
    },
};

use objc2::{
    msg_send,
    runtime::{AnyObject, Imp, Sel},
    sel,
};
use objc2_foundation::{NSEdgeInsets, NSNumber, NSPoint, NSRect, NSString};
use objc2_web_kit::WKWebView;

use crate::Rect;

/// Where the shell wants clicks, in the shell's own CSS pixels.
static REGIONS: Mutex<Vec<Rect>> = Mutex::new(Vec::new());
/// The shell's `WKWebView`, which is the only view whose `hitTest:` is filtered.
static SHELL: AtomicUsize = AtomicUsize::new(0);
static ORIGINAL: OnceLock<Imp> = OnceLock::new();
static HOOKED: Once = Once::new();

type HitTest = unsafe extern "C-unwind" fn(*mut AnyObject, Sel, NSPoint) -> *mut AnyObject;

pub fn set_regions(regions: Vec<Rect>) {
    *REGIONS.lock().unwrap_or_else(PoisonError::into_inner) = regions;
}

/// Whether a click at `point` (in the shell's superview) falls on something the shell drew.
fn shell_wants(view: *mut AnyObject, point: NSPoint) -> bool {
    // SAFETY: `view` is the live shell view AppKit is hit-testing; these are plain geometry reads.
    let (x, y) = unsafe {
        let view = &*view;
        let superview: *mut AnyObject = msg_send![view, superview];
        let local: NSPoint = msg_send![view, convertPoint: point, fromView: superview];
        let flipped: bool = msg_send![view, isFlipped];
        let bounds: NSRect = msg_send![view, bounds];
        let insets: NSEdgeInsets = msg_send![view, safeAreaInsets];
        let from_top = if flipped {
            local.y
        } else {
            bounds.size.height - local.y
        };
        (local.x - insets.left, from_top - insets.top)
    };
    REGIONS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .iter()
        .any(|r| x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height)
}

extern "C-unwind" fn hit_test(this: *mut AnyObject, sel: Sel, point: NSPoint) -> *mut AnyObject {
    let Some(original) = ORIGINAL.get() else {
        return null_mut();
    };
    // SAFETY: `ORIGINAL` is this very method's previous implementation, with this signature.
    let original: HitTest = unsafe { transmute(*original) };
    // SAFETY: calling the previous implementation with the arguments AppKit gave us.
    let hit = unsafe { original(this, sel, point) };
    if hit.is_null() || this as usize != SHELL.load(Ordering::Acquire) || shell_wants(this, point) {
        hit
    } else {
        null_mut()
    }
}

/// Replaces `hitTest:` on the shell's view class. Page views share that class, so the
/// replacement lets every view but the shell through untouched.
fn hook_hit_test(view: &WKWebView) {
    HOOKED.call_once(|| {
        // SAFETY: `view` is an object; its class and method table are read, and the replacement
        // has the signature of `hitTest:`.
        unsafe {
            let object = &*(view as *const WKWebView).cast::<AnyObject>();
            let class = object.class();
            let Some(method) = class.instance_method(sel!(hitTest:)) else {
                return;
            };
            let _ = ORIGINAL.set(method.implementation());
            let replacement: Imp = transmute(hit_test as extern "C-unwind" fn(_, _, _) -> _);
            let added = objc2::ffi::class_addMethod(
                (class as *const objc2::runtime::AnyClass).cast_mut(),
                sel!(hitTest:),
                replacement,
                objc2::ffi::method_getTypeEncoding(method),
            );
            if !added.as_bool() {
                method.set_implementation(replacement);
            }
        }
    });
}

/// Makes the shell transparent, filters its clicks and keeps it above every page view. Call it
/// on the main thread with the shell's `WKWebView`, and again after every page view is added
/// (a new view goes on top).
pub fn prepare(view: &WKWebView) {
    SHELL.store(view as *const WKWebView as usize, Ordering::Release);
    hook_hit_test(view);
    // SAFETY: a KVC write of a boolean, and a re-add of the shell above its siblings, on the
    // main thread.
    unsafe {
        let off = NSNumber::numberWithBool(false);
        let _: () =
            msg_send![view, setValue: &*off, forKey: &*NSString::from_str("drawsBackground")];
        let superview: *mut AnyObject = msg_send![view, superview];
        if !superview.is_null() {
            let above: isize = 1;
            let _: () = msg_send![superview, addSubview: view, positioned: above, relativeTo: null::<AnyObject>()];
        }
    }
}
