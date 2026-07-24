// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installShortcuts, type ShortcutActions } from "./shortcuts";

function actions(): ShortcutActions {
  return {
    toggleAssistant: vi.fn(), toggleAssistantBubble: vi.fn(), toggleActionPanel: vi.fn(), quickAddAction: vi.fn(),
    selectView: vi.fn(), startNewConversation: vi.fn(), isAssistantStreaming: () => false, cancelAssistant: vi.fn(),
    isActionPanelOpen: () => true, closeActionPanel: vi.fn(), isAssistantBubbleOpen: () => false,
    collapseAssistantBubble: vi.fn(), isHistoryPopoverOpen: () => false, closeHistoryPopover: vi.fn(),
    isPermissionBubbleOpen: () => false, closePermissionBubble: vi.fn(), isSkillMenuOpen: () => false,
    closeSkillMenu: vi.fn(), isMentionMenuOpen: () => false, closeMentionMenu: vi.fn(), canSplit: () => false,
    increaseEditorFontSize: vi.fn(), decreaseEditorFontSize: vi.fn(), resetEditorFontSize: vi.fn(),
  };
}

describe("window shortcuts", () => {
  afterEach(() => document.body.replaceChildren());

  it("does not handle Escape already consumed by an inner control", () => {
    const shortcutActions = actions();
    const remove = installShortcuts(shortcutActions, { map: new Map() });
    const input = document.createElement("input");
    input.addEventListener("keydown", (event) => event.preventDefault());
    document.body.appendChild(input);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

    expect(shortcutActions.closeActionPanel).not.toHaveBeenCalled();
    remove();
  });

  it("handles fixed editor font-size shortcuts before configurable bindings", () => {
    const shortcutActions = actions();
    const remove = installShortcuts(shortcutActions, { map: new Map() });

    const increase = new KeyboardEvent("keydown", {
      key: "=",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(increase);
    expect(increase.defaultPrevented).toBe(true);
    expect(shortcutActions.increaseEditorFontSize).toHaveBeenCalledOnce();

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "-",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    expect(shortcutActions.decreaseEditorFontSize).toHaveBeenCalledOnce();

    document.dispatchEvent(new KeyboardEvent("keydown", {
      key: "0",
      metaKey: true,
      bubbles: true,
      cancelable: true,
    }));
    expect(shortcutActions.resetEditorFontSize).toHaveBeenCalledOnce();
    remove();
  });
});
