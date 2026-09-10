// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStarters } from "./starters";

afterEach(() => { localStorage.clear(); document.body.replaceChildren(); vi.useRealTimers(); });

function mount() {
  const actions = [vi.fn(), vi.fn(), vi.fn()];
  const focus = vi.fn();
  const starters = createStarters(actions, focus);
  document.body.append(starters.el);
  starters.update(true);
  return { ...starters, actions, focus };
}

function choose(index: number) {
  document.querySelector<HTMLButtonElement>(".assistant-suggestions-close")!.click();
  document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')[index].click();
}

describe("suggestion dismissal", () => {
  it("keeps temporary dismissal through updates but restores for a new conversation", () => {
    vi.useFakeTimers();
    const first = mount();
    choose(0);
    vi.advanceTimersByTime(120);
    first.update(false);
    first.update(true);
    expect(first.el.hidden).toBe(true);
    expect(first.focus).toHaveBeenCalledOnce();
    first.resetForNewConversation();
    first.update(true);
    expect(first.el.hidden).toBe(false);
    expect(first.el.classList.contains("is-leaving")).toBe(false);
    first.destroy();
  });

  it("cancels the old exit animation when a new conversation starts immediately", () => {
    vi.useFakeTimers();
    const first = mount();
    choose(0);
    first.resetForNewConversation();
    first.update(true);
    vi.advanceTimersByTime(120);
    expect(first.el.hidden).toBe(false);
    first.destroy();
  });

  it("persists opt-out across remounts without changing drafts", () => {
    const first = mount();
    choose(1);
    first.resetForNewConversation();
    first.update(true);
    expect(first.el.hidden).toBe(true);
    expect(first.actions.every((action) => action.mock.calls.length === 0)).toBe(true);
    first.destroy();
    const next = mount();
    expect(next.el.hidden).toBe(true);
    next.destroy();
  });

  it("supports keyboard menu navigation and Escape without dismissal", () => {
    const first = mount();
    const trigger = first.el.querySelector<HTMLButtonElement>(".assistant-suggestions-close")!;
    trigger.click();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement?.textContent).toBe("不再自动显示");
    menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(first.el.hidden).toBe(false);
    first.destroy();
  });
});
