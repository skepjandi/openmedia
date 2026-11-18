//! Where the page sits in the window and when the shell has taken the keyboard.
//!
//! On macOS the shell is a transparent layer above the page (see `platform/macos/shell.rs`), so
//! overlays such as the command bar, Settings and the fan draw over the page, as on mobile. What
//! the plugin still has to know is whether one of them is open: the keyboard belongs to it then,
//! not to the page. Windows and Linux cannot do that, so `fit_page` keeps the page clear of the
//! shell's controls instead.

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

/// The least of the page a view may keep when making room for the shell's controls.
const MIN_KEPT_SHARE: f64 = 0.4;

fn overlaps(a: &Rect, b: &Rect) -> bool {
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
}

/// The four ways to cut `region` out of `fit`: keep what lies right of it, left of it, below it,
/// or above it.
fn cuts(fit: &Rect, region: &Rect) -> [Rect; 4] {
    let (fit_right, fit_bottom) = (fit.x + fit.width, fit.y + fit.height);
    let (region_right, region_bottom) = (region.x + region.width, region.y + region.height);
    [
        Rect {
            x: region_right,
            width: fit_right - region_right,
            ..*fit
        },
        Rect {
            width: region.x - fit.x,
            ..*fit
        },
        Rect {
            y: region_bottom,
            height: fit_bottom - region_bottom,
            ..*fit
        },
        Rect {
            height: region.y - fit.y,
            ..*fit
        },
    ]
}

/// Where a page view can sit so the shell's controls stay reachable. A web view on Windows or
/// Linux cannot let clicks through to what lies under it, so it would bury every control the
/// shell floats over the page. Each region that touches the page is cut out by trimming the one
/// side that costs the least page; a region that cannot be cleared without leaving less than 40%
/// of the page in either direction is left under it.
pub fn fit_page(page: &Rect, regions: &[Rect]) -> Rect {
    let (min_width, min_height) = (page.width * MIN_KEPT_SHARE, page.height * MIN_KEPT_SHARE);
    regions.iter().fold(*page, |fit, region| {
        if !overlaps(&fit, region) {
            return fit;
        }
        cuts(&fit, region)
            .into_iter()
            .filter(|cut| cut.width >= min_width && cut.height >= min_height)
            .max_by(|a, b| (a.width * a.height).total_cmp(&(b.width * b.height)))
            .unwrap_or(fit)
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

    #[test]
    fn a_docked_panel_costs_the_page_its_bottom_strip() {
        assert_eq!(
            fit_page(&PAGE, &[region(12.0, 520.0, 776.0, 76.0)]),
            region(0.0, 0.0, 800.0, 520.0)
        );
    }

    #[test]
    fn a_floating_button_at_the_edge_costs_a_narrow_strip() {
        assert_eq!(
            fit_page(&PAGE, &[region(720.0, 300.0, 80.0, 80.0)]),
            region(0.0, 0.0, 720.0, 600.0)
        );
    }

    #[test]
    fn controls_outside_the_page_leave_it_whole() {
        assert_eq!(fit_page(&PAGE, &[region(0.0, 700.0, 800.0, 60.0)]), PAGE);
    }

    #[test]
    fn a_control_that_would_cost_most_of_the_page_stays_under_it() {
        assert_eq!(fit_page(&PAGE, &[region(300.0, 200.0, 200.0, 200.0)]), PAGE);
    }

    #[test]
    fn several_controls_are_cleared_in_turn() {
        assert_eq!(
            fit_page(
                &PAGE,
                &[
                    region(12.0, 520.0, 776.0, 76.0),
                    region(720.0, 300.0, 80.0, 80.0)
                ]
            ),
            region(0.0, 0.0, 720.0, 520.0)
        );
    }
}
