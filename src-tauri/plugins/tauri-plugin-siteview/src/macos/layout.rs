//! Where the page sits in the window and when the shell covers it.
//!
//! On desktop the page is a child webview above the shell, so shell controls cannot float over it
//! as they do on mobile. The shell keeps its permanent controls beside the page and reports its
//! interactive regions here; a region that reaches into the page is an overlay, and the page steps
//! aside (is hidden) while it is open.

use crate::Rect;

/// How far, per axis, a region must reach into the page to count as covering it. Regions carry a
/// few pixels of padding around their element, so a control standing next to the page brushes it
/// without covering it.
const COVER_DEPTH: f64 = 24.0;

fn overlap(a_start: f64, a_len: f64, b_start: f64, b_len: f64) -> f64 {
    (a_start + a_len).min(b_start + b_len) - a_start.max(b_start)
}

/// True when any region reaches deep enough into `page` to hide part of it.
pub fn is_covered(page: &Rect, regions: &[Rect]) -> bool {
    regions.iter().any(|region| {
        overlap(page.x, page.width, region.x, region.width) >= COVER_DEPTH.min(page.width)
            && overlap(page.y, page.height, region.y, region.height) >= COVER_DEPTH.min(page.height)
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
        x: 84.0,
        y: 0.0,
        width: 716.0,
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
    fn a_full_screen_overlay_covers_the_page() {
        assert!(is_covered(&PAGE, &[region(0.0, 0.0, 800.0, 600.0)]));
    }

    #[test]
    fn a_control_in_the_rail_does_not_cover_the_page() {
        // The floating button, 64 wide with 8 of padding on each side, ends 4 short of the page.
        assert!(!is_covered(&PAGE, &[region(2.0, 300.0, 80.0, 80.0)]));
        // Padding that brushes the page by a few pixels is still not a cover.
        assert!(!is_covered(&PAGE, &[region(10.0, 300.0, 80.0, 80.0)]));
    }

    #[test]
    fn a_dock_the_page_made_room_for_does_not_cover_it() {
        // The shell shortens the page to 520 when a 60 high dock sits at the bottom.
        let page = Rect {
            height: 520.0,
            ..PAGE
        };
        assert!(!is_covered(&page, &[region(4.0, 524.0, 792.0, 76.0)]));
        assert!(is_covered(&PAGE, &[region(4.0, 524.0, 792.0, 76.0)]));
    }

    #[test]
    fn a_panel_over_part_of_the_page_covers_it() {
        assert!(is_covered(&PAGE, &[region(100.0, 20.0, 600.0, 120.0)]));
    }

    #[test]
    fn no_regions_cover_nothing() {
        assert!(!is_covered(&PAGE, &[]));
    }

    #[test]
    fn a_page_smaller_than_the_depth_is_covered_by_an_overlay_over_all_of_it() {
        let sliver = region(0.0, 0.0, 10.0, 10.0);
        assert!(is_covered(&sliver, &[region(0.0, 0.0, 100.0, 100.0)]));
        assert!(!is_covered(&sliver, &[region(5.0, 5.0, 100.0, 100.0)]));
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
