// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImeAnchorRefresher, refreshImeAnchor } from "./ime-anchor";

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

/** jsdom has no contenteditable support, so stand in for the editor host. */
function mountEditableHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.tabIndex = 0;
  Object.defineProperty(host, "isContentEditable", { value: true });
  host.textContent = "socratic";
  document.body.append(host);
  return host;
}

describe("refreshImeAnchor", () => {
  it("re-focuses a text field without moving its selection", () => {
    const input = document.createElement("textarea");
    input.value = "hello world";
    document.body.append(input);
    input.focus();
    input.setSelectionRange(3, 8);
    const focus = vi.spyOn(input, "focus");
    const blur = vi.spyOn(input, "blur");

    expect(refreshImeAnchor(document)).toBe(true);

    expect(blur).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(document.activeElement).toBe(input);
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 8]);
  });

  it("re-focuses the editor host and restores its selection range", () => {
    const host = mountEditableHost();
    host.focus();
    const range = document.createRange();
    range.setStart(host.firstChild!, 2);
    range.setEnd(host.firstChild!, 5);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);

    expect(refreshImeAnchor(document)).toBe(true);

    expect(document.activeElement).toBe(host);
    const restored = document.getSelection()!.getRangeAt(0);
    expect([restored.startOffset, restored.endOffset]).toEqual([2, 5]);
  });

  it("leaves a non-editable focus target alone", () => {
    const button = document.createElement("button");
    document.body.append(button);
    button.focus();
    const blur = vi.spyOn(button, "blur");

    expect(refreshImeAnchor(document)).toBe(false);
    expect(blur).not.toHaveBeenCalled();
  });

  it("skips read-only and disabled fields, which have no IME anchor to fix", () => {
    const readOnly = document.createElement("input");
    readOnly.readOnly = true;
    document.body.append(readOnly);
    readOnly.focus();

    expect(refreshImeAnchor(document)).toBe(false);
  });

  it("does nothing when focus sits on the document body", () => {
    expect(refreshImeAnchor(document)).toBe(false);
  });
});

describe("createImeAnchorRefresher", () => {
  it("coalesces a burst of geometry changes into a single repair", () => {
    vi.useFakeTimers();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const focus = vi.spyOn(input, "focus");
    const refresher = createImeAnchorRefresher({ settleMs: 150 });

    refresher.schedule();
    vi.advanceTimersByTime(100);
    refresher.schedule();
    vi.advanceTimersByTime(100);
    expect(focus).not.toHaveBeenCalled();

    vi.advanceTimersByTime(50);
    expect(focus).toHaveBeenCalledOnce();
    refresher.dispose();
  });

  it("does not interrupt an in-flight composition", () => {
    vi.useFakeTimers();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const focus = vi.spyOn(input, "focus");
    const refresher = createImeAnchorRefresher({ settleMs: 150 });

    input.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    refresher.schedule();
    vi.advanceTimersByTime(150);
    expect(focus).not.toHaveBeenCalled();

    input.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    refresher.schedule();
    vi.advanceTimersByTime(150);
    expect(focus).toHaveBeenCalledOnce();
    refresher.dispose();
  });

  it("stops repairing after dispose", () => {
    vi.useFakeTimers();
    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    const focus = vi.spyOn(input, "focus");
    const refresher = createImeAnchorRefresher({ settleMs: 150 });

    refresher.schedule();
    refresher.dispose();
    vi.advanceTimersByTime(500);

    expect(focus).not.toHaveBeenCalled();
  });
});
