/**
 * Windows/WebView2 keeps a stale caret anchor after the host window is moved or
 * resized, so the IME composition and candidate windows get drawn at a screen
 * corner instead of under the caret. Typed characters still reach the document
 * because key events travel by focus, not by geometry
 * (MicrosoftEdge/WebView2Feedback#5675, still open; wry already calls
 * `NotifyParentWindowPositionChanged`, which is not enough on its own).
 *
 * Re-focusing the editable element makes Chromium report fresh caret bounds.
 * Switching note surfaces happens to force the same recalculation, which is why
 * the misplacement looks intermittent rather than permanent.
 *
 * The repair is a no-op outside Windows: the backend only emits the geometry
 * event there.
 */

type SelectionRestore = () => void;

function isTextField(element: Element): element is HTMLInputElement | HTMLTextAreaElement {
  return element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
}

function isEditable(element: Element): element is HTMLElement {
  if (isTextField(element)) return !element.readOnly && !element.disabled;
  return element instanceof HTMLElement && element.isContentEditable;
}

/**
 * Blur/focus drops the DOM selection, so capture it first. Text fields keep
 * offsets; contenteditable hosts (the Markdown editors) keep live ranges, which
 * survive the round trip because the nodes themselves are untouched.
 */
function captureSelection(doc: Document, element: HTMLElement): SelectionRestore {
  if (isTextField(element)) {
    const { selectionStart, selectionEnd, selectionDirection } = element;
    return () => {
      if (selectionStart === null || selectionEnd === null) return;
      element.setSelectionRange(selectionStart, selectionEnd, selectionDirection ?? undefined);
    };
  }
  const selection = doc.getSelection();
  if (!selection || selection.rangeCount === 0) return () => {};
  const ranges = Array.from({ length: selection.rangeCount }, (_, index) =>
    selection.getRangeAt(index).cloneRange(),
  );
  return () => {
    const current = doc.getSelection();
    if (!current) return;
    current.removeAllRanges();
    for (const range of ranges) current.addRange(range);
  };
}

/**
 * Re-anchor the IME to the focused editable element, preserving its selection.
 * Returns whether an editable element was actually re-focused.
 */
export function refreshImeAnchor(doc: Document = document): boolean {
  const active = doc.activeElement;
  if (!active || !isEditable(active)) return false;
  const restore = captureSelection(doc, active);
  active.blur();
  // `preventScroll` keeps the viewport still: this repair must be invisible.
  active.focus({ preventScroll: true });
  restore();
  return true;
}

export interface ImeAnchorRefresher {
  /** Ask for a repair once the geometry changes stop arriving. */
  schedule(): void;
  dispose(): void;
}

export interface ImeAnchorRefresherOptions {
  doc?: Document;
  /** Quiet period that marks the end of a drag or resize gesture. */
  settleMs?: number;
}

/**
 * Dragging a window emits one geometry change per mouse move, so repairs are
 * coalesced until the gesture settles. A repair mid-composition would discard
 * the characters the user is still assembling, so it is skipped and left to the
 * next gesture; the anchor only has to be fresh before a composition starts.
 */
export function createImeAnchorRefresher(
  options: ImeAnchorRefresherOptions = {},
): ImeAnchorRefresher {
  const doc = options.doc ?? document;
  const settleMs = options.settleMs ?? 150;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let composing = false;

  const onCompositionStart = () => { composing = true; };
  const onCompositionEnd = () => { composing = false; };
  doc.addEventListener("compositionstart", onCompositionStart, true);
  doc.addEventListener("compositionend", onCompositionEnd, true);

  return {
    schedule() {
      if (timer !== undefined) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = undefined;
        if (composing) return;
        refreshImeAnchor(doc);
      }, settleMs);
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      doc.removeEventListener("compositionstart", onCompositionStart, true);
      doc.removeEventListener("compositionend", onCompositionEnd, true);
    },
  };
}
