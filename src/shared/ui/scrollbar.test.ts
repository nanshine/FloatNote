// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { initScrollbar } from "./scrollbar";

describe("shared scrollbar", () => {
  afterEach(() => {
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  it("keeps the thumb on a stable host and maps pointer dragging to scrollTop", () => {
    vi.useFakeTimers();
    const host = document.createElement("div");
    const scroller = document.createElement("div");
    host.append(scroller);
    document.body.append(host);
    Object.defineProperties(scroller, {
      clientHeight: { value: 100 },
      scrollHeight: { value: 400 },
      scrollTop: { value: 200, writable: true },
    });

    initScrollbar(host, scroller);
    const thumb = host.querySelector<HTMLElement>(".fn-scroll__thumb")!;
    Object.defineProperty(thumb, "offsetHeight", { value: 28 });

    expect(thumb.parentElement).toBe(host);
    expect(thumb.style.height).toBe("28px");
    expect(thumb.style.top).toBe("48px");

    thumb.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0, clientY: 50 }));
    document.dispatchEvent(new MouseEvent("pointermove", { bubbles: true, clientY: 80 }));
    document.dispatchEvent(new MouseEvent("pointerup", { bubbles: true, clientY: 80 }));

    expect(scroller.scrollTop).toBe(325);
    expect(thumb.classList.contains("is-dragging")).toBe(false);
  });
});
