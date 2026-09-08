//! Global mouse cursor position, in the logical coordinates the popup window
//! places itself with (`LogicalPosition` on the frontend side).

use tauri::AppHandle;

#[cfg(target_os = "macos")]
pub fn get_cursor_pos(_app: &AppHandle) -> Option<(f64, f64)> {
    use core_graphics::event::CGEvent;
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    let source = CGEventSource::new(CGEventSourceStateID::CombinedSessionState).ok()?;
    // A freshly-created event's location is the current cursor position.
    // Quartz already reports points, i.e. logical coordinates.
    let event = CGEvent::new(source).ok()?;
    let loc = event.location();
    Some((loc.x, loc.y))
}

/// Elsewhere the platform reports the cursor in physical pixels, so it has to
/// be divided by the scale factor of the display the cursor sits on. Without
/// that step the popup lands far from the selection on any scaled display.
#[cfg(not(target_os = "macos"))]
pub fn get_cursor_pos(app: &AppHandle) -> Option<(f64, f64)> {
    let physical = app.cursor_position().ok()?;
    let scale = app
        .monitor_from_point(physical.x, physical.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten())
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    Some(to_logical(physical.x, physical.y, scale))
}

/// Physical pixels to logical coordinates. A non-positive scale factor is
/// treated as 1.0 so a bogus monitor report degrades to an offset popup
/// instead of a division by zero.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn to_logical(x: f64, y: f64, scale: f64) -> (f64, f64) {
    if scale <= 0.0 {
        return (x, y);
    }
    (x / scale, y / scale)
}

#[cfg(test)]
mod tests {
    use super::to_logical;

    #[test]
    fn scales_physical_pixels_down_to_points() {
        assert_eq!(to_logical(300.0, 150.0, 1.5), (200.0, 100.0));
    }

    #[test]
    fn keeps_coordinates_on_unscaled_displays() {
        assert_eq!(to_logical(300.0, 150.0, 1.0), (300.0, 150.0));
    }

    #[test]
    fn preserves_negative_coordinates_of_secondary_displays() {
        assert_eq!(to_logical(-400.0, -200.0, 2.0), (-200.0, -100.0));
    }

    #[test]
    fn falls_back_to_identity_on_a_bogus_scale_factor() {
        assert_eq!(to_logical(300.0, 150.0, 0.0), (300.0, 150.0));
    }
}
