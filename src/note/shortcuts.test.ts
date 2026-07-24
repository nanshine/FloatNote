import { describe, it, expect } from "vitest";
import {
  buildBindings,
  resolveFontSizeShortcut,
  resolveEsc,
  resolveBoundCombo,
  viewTargetFor,
} from "./shortcuts";
import { WINDOW_SHORTCUT_DEFAULTS } from "../shared/shortcuts";

describe("buildBindings + resolveBoundCombo", () => {
  const bindings = buildBindings({ ...WINDOW_SHORTCUT_DEFAULTS });
  it("命中默认键", () => {
    expect(resolveBoundCombo("Cmd+J", bindings)).toBe("assistant");
    expect(resolveBoundCombo("Ctrl+J", bindings)).toBe("assistant"); // Ctrl≡Cmd
    expect(resolveBoundCombo("Cmd+1", bindings)).toBe("view_inbox");
  });
  it("未命中返回 null", () => {
    expect(resolveBoundCombo("Cmd+Z", bindings)).toBeNull();
    expect(resolveBoundCombo(null, bindings)).toBeNull();
  });
});

describe("resolveFontSizeShortcut", () => {
  function event(key: string, overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
    return { key, metaKey: true, ctrlKey: false, altKey: false, ...overrides } as KeyboardEvent;
  }

  it("recognizes both keyboard forms of increase", () => {
    expect(resolveFontSizeShortcut(event("="))).toBe("increase");
    expect(resolveFontSizeShortcut(event("+", { shiftKey: true }))).toBe("increase");
  });

  it("recognizes decrease and reset", () => {
    expect(resolveFontSizeShortcut(event("-"))).toBe("decrease");
    expect(resolveFontSizeShortcut(event("0"))).toBe("reset");
  });

  it("supports Ctrl on non-macOS keyboards", () => {
    expect(resolveFontSizeShortcut(event("-", { metaKey: false, ctrlKey: true }))).toBe("decrease");
  });

  it("ignores unrelated or modified combinations", () => {
    expect(resolveFontSizeShortcut(event("j"))).toBeNull();
    expect(resolveFontSizeShortcut(event("-", { altKey: true }))).toBeNull();
    expect(resolveFontSizeShortcut(event("-", { metaKey: false }))).toBeNull();
  });
});

describe("viewTargetFor", () => {
  it("双栏在窄窗回落写作", () => {
    expect(viewTargetFor("view_split", true)).toBe("split");
    expect(viewTargetFor("view_split", false)).toBe("piece");
  });
  it("采集/写作直达", () => {
    expect(viewTargetFor("view_inbox", false)).toBe("inbox");
    expect(viewTargetFor("view_piece", false)).toBe("piece");
  });
  it("非视图项返回 null", () => {
    expect(viewTargetFor("assistant", true)).toBeNull();
  });
});

describe("resolveEsc 优先级链", () => {
  const base = {
    permissionBubbleOpen: false,
    skillMenuOpen: false,
    mentionMenuOpen: false,
    historyPopoverOpen: false,
    focusInAssistant: false,
    streaming: false,
    actionPanelOpen: false,
    bubbleOpen: false,
  };
  it("0. 权限气泡最优先（高于 skill 菜单/历史浮层/行动面板/气泡/流式取消）", () => {
    expect(
      resolveEsc({
        ...base,
        permissionBubbleOpen: true,
        skillMenuOpen: true,
        historyPopoverOpen: true,
        focusInAssistant: true,
        streaming: true,
        actionPanelOpen: true,
        bubbleOpen: true,
      }),
    ).toBe("closePermissionBubble");
  });
  it("0b. skill 菜单优先于历史浮层/行动面板/气泡", () => {
    expect(
      resolveEsc({ ...base, skillMenuOpen: true, historyPopoverOpen: true, bubbleOpen: true }),
    ).toBe("closeSkillMenu");
  });
  it("0c. mention 下拉优先于历史浮层，但低于 skill 菜单", () => {
    expect(
      resolveEsc({ ...base, mentionMenuOpen: true, historyPopoverOpen: true, bubbleOpen: true }),
    ).toBe("closeMentionMenu");
    expect(resolveEsc({ ...base, skillMenuOpen: true, mentionMenuOpen: true })).toBe("closeSkillMenu");
  });
  it("1. 历史浮层最优先", () => {
    expect(
      resolveEsc({ ...base, historyPopoverOpen: true, actionPanelOpen: true, bubbleOpen: true }),
    ).toBe("closeHistoryPopover");
  });
  it("2. 焦点在助手+流式 → 取消回复（优先于行动面板）", () => {
    expect(
      resolveEsc({ ...base, focusInAssistant: true, streaming: true, actionPanelOpen: true }),
    ).toBe("cancelAssistant");
  });
  it("流式但焦点不在助手 → 不取消，落到行动面板", () => {
    expect(
      resolveEsc({ ...base, focusInAssistant: false, streaming: true, actionPanelOpen: true }),
    ).toBe("closeActionPanel");
  });
  it("3. 行动面板开 → 关面板（优先于气泡）", () => {
    expect(
      resolveEsc({ ...base, actionPanelOpen: true, bubbleOpen: true }),
    ).toBe("closeActionPanel");
  });
  it("4. 气泡展开 → 收起", () => {
    expect(resolveEsc({ ...base, bubbleOpen: true })).toBe("collapseBubble");
  });
  it("5. 全关 → null", () => {
    expect(resolveEsc(base)).toBeNull();
  });
});
