pub const DRAG_THRESHOLD: f64 = 5.0;

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AxTargetKind {
    Text,
    TextArea,
    StaticText,
    WebArea,
    TitleBar,
    ScrollBar,
    Button,
    FileItem,
    Unknown,
}

#[cfg(any(target_os = "macos", test))]
impl AxTargetKind {
    pub fn is_textual(self) -> bool {
        matches!(
            self,
            Self::Text | Self::TextArea | Self::StaticText | Self::WebArea
        )
    }
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MouseDown {
    pub event_number: u64,
    pub pid: i32,
    pub point: Point,
    pub target: AxTargetKind,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct MouseUp {
    pub event_number: u64,
    pub pid: i32,
    pub point: Point,
    pub click_count: u8,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SelectionCandidate {
    pub event_number: u64,
    pub pid: i32,
    pub down: Point,
    pub up: Point,
    pub click_count: u8,
    pub target: AxTargetKind,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
pub struct SelectionIntentTracker {
    pending: Option<MouseDown>,
}

#[cfg(any(target_os = "macos", test))]
impl SelectionIntentTracker {
    pub fn on_mouse_down(&mut self, event: MouseDown) {
        self.pending = Some(event);
    }

    pub fn on_mouse_up(&mut self, event: MouseUp) -> Option<SelectionCandidate> {
        let down = self.pending.take()?;
        if down.event_number != event.event_number
            || down.pid != event.pid
            || !down.target.is_textual()
        {
            return None;
        }

        let distance = ((event.point.x - down.point.x).powi(2)
            + (event.point.y - down.point.y).powi(2))
        .sqrt();
        if distance < DRAG_THRESHOLD && event.click_count < 2 {
            return None;
        }

        Some(SelectionCandidate {
            event_number: event.event_number,
            pid: event.pid,
            down: down.point,
            up: event.point,
            click_count: event.click_count,
            target: down.target,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn down(target: AxTargetKind) -> MouseDown {
        MouseDown {
            event_number: 7,
            pid: 42,
            point: Point { x: 10.0, y: 20.0 },
            target,
        }
    }

    fn up(x: f64, click_count: u8) -> MouseUp {
        MouseUp {
            event_number: 7,
            pid: 42,
            point: Point { x, y: 20.0 },
            click_count,
        }
    }

    #[test]
    fn single_click_is_not_a_selection_candidate() {
        let mut tracker = SelectionIntentTracker::default();
        tracker.on_mouse_down(down(AxTargetKind::Text));
        assert!(tracker.on_mouse_up(up(11.0, 1)).is_none());
    }

    #[test]
    fn drag_in_text_content_creates_a_candidate() {
        let mut tracker = SelectionIntentTracker::default();
        tracker.on_mouse_down(down(AxTargetKind::WebArea));
        let candidate = tracker.on_mouse_up(up(18.0, 1)).unwrap();
        assert_eq!(candidate.event_number, 7);
        assert_eq!(candidate.pid, 42);
        assert_eq!(candidate.click_count, 1);
    }

    #[test]
    fn native_double_and_triple_click_create_candidates() {
        for click_count in [2, 3] {
            let mut tracker = SelectionIntentTracker::default();
            tracker.on_mouse_down(down(AxTargetKind::StaticText));
            assert!(tracker.on_mouse_up(up(10.0, click_count)).is_some());
        }
    }

    #[test]
    fn mismatched_event_number_or_pid_is_rejected() {
        let mut tracker = SelectionIntentTracker::default();
        tracker.on_mouse_down(down(AxTargetKind::Text));
        let mut wrong_event = up(20.0, 1);
        wrong_event.event_number = 8;
        assert!(tracker.on_mouse_up(wrong_event).is_none());

        tracker.on_mouse_down(down(AxTargetKind::Text));
        let mut wrong_pid = up(20.0, 1);
        wrong_pid.pid = 43;
        assert!(tracker.on_mouse_up(wrong_pid).is_none());
    }

    #[test]
    fn non_text_targets_are_rejected_even_for_drags() {
        for target in [
            AxTargetKind::TitleBar,
            AxTargetKind::ScrollBar,
            AxTargetKind::Button,
            AxTargetKind::FileItem,
            AxTargetKind::Unknown,
        ] {
            let mut tracker = SelectionIntentTracker::default();
            tracker.on_mouse_down(down(target));
            assert!(tracker.on_mouse_up(up(30.0, 1)).is_none());
        }
    }
}
