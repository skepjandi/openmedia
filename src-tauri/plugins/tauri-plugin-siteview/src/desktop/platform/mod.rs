//! What differs between desktop systems. Each module offers the same functions; `desktop/mod.rs`
//! calls them and never asks which system it runs on.
//!
//! macOS reaches into its `WKWebView` and keeps the shell transparent above the pages. Windows and
//! Linux have no per-pixel click-through, so their pages sit above the shell and the shell is
//! kept clear of them instead (`layout::fit_page`); their remaining gaps are listed in
//! `docs/wiki/platform-support.md`.

use std::sync::{
    Mutex, PoisonError,
    atomic::{AtomicBool, Ordering},
};

use crate::ZoomAction;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::*;

#[cfg(any(windows, target_os = "linux"))]
mod portable;
#[cfg(any(windows, target_os = "linux"))]
pub use portable::*;

#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::*;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::*;

/// What the web view knows about its page.
#[derive(Debug, Clone, PartialEq)]
pub struct PageSnapshot {
    pub url: Option<String>,
    pub title: Option<String>,
    pub loading: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
}

/// What the page's own callbacks have said so far, for the systems whose web views cannot be asked
/// for it. The callbacks run on the main thread and only write here.
#[derive(Debug, Default)]
pub struct Track {
    title: Mutex<Option<String>>,
    loading: AtomicBool,
}

impl Track {
    pub fn set_title(&self, title: &str) {
        let title = (!title.is_empty()).then(|| title.to_owned());
        *self.title.lock().unwrap_or_else(PoisonError::into_inner) = title;
    }

    pub fn set_loading(&self, loading: bool) {
        self.loading.store(loading, Ordering::Relaxed);
    }

    #[cfg(any(windows, target_os = "linux"))]
    fn title(&self) -> Option<String> {
        self.title
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .clone()
    }

    #[cfg(any(windows, target_os = "linux"))]
    fn loading(&self) -> bool {
        self.loading.load(Ordering::Relaxed)
    }
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

    #[test]
    fn the_track_keeps_a_title_and_drops_an_empty_one() {
        let track = Track::default();
        track.set_title("A page");
        assert_eq!(track.title.lock().unwrap().as_deref(), Some("A page"));
        track.set_title("");
        assert_eq!(track.title.lock().unwrap().as_deref(), None);
    }
}
