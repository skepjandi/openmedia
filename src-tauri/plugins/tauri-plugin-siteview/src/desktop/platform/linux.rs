//! Linux: WebKitGTK through its GTK widget, for what Tauri's webview API does not expose.
//!
//! Tauri packs every web view of a window into one vertical box, so a second web view would take
//! its share of the height instead of floating over the shell. The shell is therefore moved into a
//! `GtkOverlay` whose top layer is a `GtkFixed` (empty areas let clicks through), and each page
//! view is moved into that layer at the rectangle the shell asked for. Everything else about the
//! page (loading, scripts, popups, downloads, profiles) is still Tauri's.
//!
//! The calls run on the main thread and are waited for, so none may run on it.

use std::{process::Command, sync::mpsc, time::Duration};

use gtk::prelude::*;
use tauri::{AppHandle, Runtime, Webview};
use webkit2gtk::WebViewExt;

use crate::{Error, Rect, Result};

/// How long to wait for the main thread. It only has to answer between two events.
const MAIN_THREAD_WAIT: Duration = Duration::from_secs(3);
/// The name that marks the layer the page views live in.
const PAGES_LAYER: &str = "openmedia-pages";

/// Runs `work` on the main thread with the session's WebKitGTK widget and returns its result.
fn with_view<R, T>(
    webview: &Webview<R>,
    work: impl FnOnce(&webkit2gtk::WebView) -> T + Send + 'static,
) -> Result<T>
where
    R: Runtime,
    T: Send + 'static,
{
    let (sender, receiver) = mpsc::channel();
    webview.with_webview(move |platform| {
        let _ = sender.send(work(&platform.inner()));
    })?;
    receiver
        .recv_timeout(MAIN_THREAD_WAIT)
        .map_err(|_| Error::PageTimeout)
}

/// Whether the page's history has an entry before and after the one showing.
pub fn history<R: Runtime>(webview: &Webview<R>) -> Result<(bool, bool)> {
    with_view(webview, |view| (view.can_go_back(), view.can_go_forward()))
}

pub fn go_back<R: Runtime>(webview: &Webview<R>) -> Result<()> {
    with_view(webview, |view| view.go_back())
}

pub fn go_forward<R: Runtime>(webview: &Webview<R>) -> Result<()> {
    with_view(webview, |view| view.go_forward())
}

/// Moves the shell's web view into an overlay with an empty layer above it for the pages. Safe to
/// repeat: a shell that is already in its overlay is left alone.
pub fn prepare_shell<R: Runtime>(shell: &Webview<R>) -> Result<()> {
    with_view(shell, |view| {
        let widget: &gtk::Widget = view.upcast_ref();
        let Some(container) = widget
            .parent()
            .and_then(|parent| parent.downcast::<gtk::Box>().ok())
        else {
            return;
        };
        let position = container
            .children()
            .iter()
            .position(|child| child == widget)
            .and_then(|at| i32::try_from(at).ok())
            .unwrap_or(0);
        let overlay = gtk::Overlay::new();
        let pages = gtk::Fixed::new();
        pages.set_widget_name(PAGES_LAYER);
        container.remove(view);
        overlay.add(view);
        overlay.add_overlay(&pages);
        overlay.set_overlay_pass_through(&pages, true);
        container.pack_start(&overlay, true, true, 0);
        container.reorder_child(&overlay, position);
        overlay.show_all();
    })
}

/// The pages layer inside the window `widget` is in.
fn pages_layer(widget: &gtk::Widget) -> Option<gtk::Fixed> {
    fn search(node: &gtk::Widget) -> Option<gtk::Fixed> {
        if node.widget_name().as_str() == PAGES_LAYER {
            return node.clone().downcast().ok();
        }
        node.clone()
            .downcast::<gtk::Container>()
            .ok()?
            .children()
            .iter()
            .find_map(search)
    }
    search(&widget.toplevel()?)
}

/// Puts the page view at `bounds` (the shell's coordinates, logical pixels).
pub fn place<R: Runtime>(shell: &Webview<R>, page: &Webview<R>, bounds: Rect) -> Result<()> {
    prepare_shell(shell)?;
    #[allow(
        clippy::cast_possible_truncation,
        reason = "a window is far smaller than i32"
    )]
    let (x, y, width, height) = (
        bounds.x.round() as i32,
        bounds.y.round() as i32,
        bounds.width.round() as i32,
        bounds.height.round() as i32,
    );
    with_view(page, move |view| {
        let widget: &gtk::Widget = view.upcast_ref();
        let Some(pages) = pages_layer(widget) else {
            return;
        };
        let in_layer = widget
            .parent()
            .is_some_and(|parent| &parent == pages.upcast_ref::<gtk::Widget>());
        if in_layer {
            pages.move_(view, x, y);
        } else {
            if let Some(parent) = widget
                .parent()
                .and_then(|parent| parent.downcast::<gtk::Container>().ok())
            {
                parent.remove(view);
            }
            pages.put(view, x, y);
        }
        view.set_size_request(width, height);
    })
}

/// Asks the person at the keyboard to prove they are present, through PolicyKit's own prompt (their
/// password, in whatever agent the desktop runs). `Ok(false)` means they cancelled or failed; a
/// system without PolicyKit is an error, so the check fails closed. Waits for the person, so it
/// must not run on the main thread.
pub fn authenticate<R: Runtime>(_app: &AppHandle<R>, _reason: &str) -> Result<bool> {
    match Command::new("pkexec").arg("true").status() {
        Ok(status) => Ok(status.success()),
        Err(_) => Err(Error::OwnerCheckUnavailable),
    }
}
