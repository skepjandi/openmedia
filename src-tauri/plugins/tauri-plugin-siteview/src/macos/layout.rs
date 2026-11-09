//! Where the page sits in the window and when the shell has taken the keyboard.
//!
//! The shell is a transparent layer above the page (see `shell.rs`), so overlays such as the
//! command bar, Settings and the fan draw over the page, as on mobile. What the plugin still has
//! to know is whether one of them is open: the keyboard belongs to it then, not to the page.

use crate::Rect;

/// A region this share of the page, in both directions, is an overlay rather than a control.
const OVERLAY_SHARE: f64 = 0.6;

/// True when any region spans most of `page`: a sheet, the command bar or the fan's backdrop.
/// The floating button, the back button and a docked panel are too small to count.
pub fn overlay_open(page: &Rect, regions: &[Rect]) -> bool {
    regions.iter().any(|region| {
        region.width >= page.width * OVERLAY_SHARE && region.height >= page.height * OVERLAY_SHARE
    })
}

/// A rectangle a native view can take: finite, not negative, at least one pixel across.
pub fn usable(rect: Rect) -> Option<Rect> {
    let finite = [rect.x, rect.y, rect.width, rect.height]
        .iter()
        .all(|value| value.is_finite());
    finite.then(|| Rect {
        x: rect.x.max(0.0),
        y: rect.y.max(0.0),
        width: rect.width.max(1.0),
        height: rect.height.max(1.0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const PAGE: Rect = Rect {
        x: 0.0,
        y: 0.0,
        width: 800.0,
        height: 600.0,
    };

    fn region(x: f64, y: f64, width: f64, height: f64) -> Rect {
        Rect {
            x,
            y,
            width,
            height,
        }
    }

    #[test]
    fn a_full_screen_overlay_is_open() {
        assert!(overlay_open(&PAGE, &[region(0.0, 0.0, 800.0, 600.0)]));
    }

    #[test]
    fn the_floating_button_and_a_docked_panel_are_not_overlays() {
        assert!(!overlay_open(&PAGE, &[region(720.0, 300.0, 80.0, 80.0)]));
        assert!(!overlay_open(&PAGE, &[region(12.0, 520.0, 776.0, 76.0)]));
    }

    #[test]
    fn a_tall_but_narrow_panel_is_not_an_overlay() {
        assert!(!overlay_open(&PAGE, &[region(0.0, 0.0, 200.0, 600.0)]));
    }

    #[test]
    fn no_regions_is_no_overlay() {
        assert!(!overlay_open(&PAGE, &[]));
    }

    #[test]
    fn unusable_rectangles_are_refused_or_clamped() {
        assert_eq!(usable(region(f64::NAN, 0.0, 10.0, 10.0)), None);
        assert_eq!(
            usable(region(-5.0, -5.0, 0.0, -3.0)),
            Some(region(0.0, 0.0, 1.0, 1.0))
        );
    }
}
