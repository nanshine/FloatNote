import { describe, it, expect, vi, afterEach } from "vitest";
import {
  canonicalize,
  checkConflict,
  findAllConflicts,
  findShortcutConflicts,
  eventToCombo,
  formatComboForDisplay,
  formatComboHtml,
  WINDOW_SHORTCUT_DEFAULTS,
  WINDOW_SHORTCUT_IDS,
  type WindowShortcutId,
} from "./shortcuts";

function fakeKey(key: string, mods: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean }): KeyboardEvent {
  return { key, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt } as KeyboardEvent;
}

describe("eventToCombo", () => {
  it("产出 Cmd/Ctrl+主键 格式；无修饰键或仅修饰键返回 null", () => {
    expect(canonicalize(eventToCombo(fakeKey("j", { meta: true }))!)).toBe("Mod+J");
    expect(canonicalize(eventToCombo(fakeKey("b", { ctrl: true }))!)).toBe("Mod+B");
    expect(eventToCombo(fakeKey("j", {}))).toBeNull();
    expect(eventToCombo(fakeKey("Shift", { shift: true }))).toBeNull();
  });
  it("保留 Shift/Alt", () => {
    expect(canonicalize(eventToCombo(fakeKey("k", { meta: true, shift: true }))!)).toBe("Shift+Mod+K");
    expect(canonicalize(eventToCombo(fakeKey("1", { meta: true }))!)).toBe("Mod+1");
  });
  it("将 Shift 输入的实体加号归一到等号键", () => {
    expect(eventToCombo(fakeKey("+", { meta: true, shift: true }))).toBe("Shift+Cmd+=");
  });
});

describe("canonicalize", () => {
  it("Cmd/Win/Ctrl/Meta 归一为 Mod，字母大写", () => {
    expect(canonicalize("Cmd+J")).toBe("Mod+J");
    expect(canonicalize("Ctrl+j")).toBe("Mod+J");
    expect(canonicalize("Win+J")).toBe("Mod+J");
  });
  it("修饰键顺序统一为 Shift,Alt,Mod", () => {
    expect(canonicalize("Cmd+Shift+U")).toBe("Shift+Mod+U");
    expect(canonicalize("Alt+Cmd+C")).toBe("Alt+Mod+C");
  });
  it("符号与功能键原样", () => {
    expect(canonicalize("Cmd+=")).toBe("Mod+=");
    expect(canonicalize("Cmd+-")).toBe("Mod+-");
    expect(canonicalize("Cmd+0")).toBe("Mod+0");
    expect(canonicalize("Cmd+/")).toBe("Mod+/");
    expect(canonicalize("Cmd+Enter")).toBe("Mod+Enter");
  });
});

describe("checkConflict", () => {
  const globals = { capture: "Alt+Cmd+C", toggle: "Alt+Cmd+N", popup: "Alt+Cmd+P" };
  const all = () => ({ ...WINDOW_SHORTCUT_DEFAULTS });

  it("保留键：Mod+A 与全选冲突", () => {
    const r = checkConflict({ combo: "Cmd+A", id: "assistant", all: all(), globals });
    expect(r?.kind).toBe("reserved");
    expect(r?.message).toContain("全选");
  });
  it("保留键：Mod+W 系统关窗", () => {
    const r = checkConflict({ combo: "Cmd+W", id: "assistant", all: all(), globals });
    expect(r?.kind).toBe("reserved");
    expect(r?.message).toContain("关闭窗口");
  });
  it("保留编辑器字号快捷键", () => {
    for (const combo of ["Cmd+=", "Cmd+-", "Cmd+0"]) {
      const r = checkConflict({ combo, id: "assistant", all: all(), globals });
      expect(r?.kind).toBe("reserved");
      expect(r?.message).toContain("字号");
    }
  });
  it("保留键：Shift+Mod+K（CM 占用）", () => {
    const r = checkConflict({ combo: "Cmd+Shift+K", id: "assistant", all: all(), globals });
    expect(r?.kind).toBe("reserved");
  });
  it("窗内重复：与另一项相同", () => {
    const a = all();
    a.action_panel = "Cmd+J"; // 与 assistant 默认相同
    const r = checkConflict({ combo: "Cmd+J", id: "action_panel", all: a, globals });
    expect(r?.kind).toBe("window");
    expect(r?.message).toContain("切换 AI 助手");
  });
  it("撞全局快捷键", () => {
    const r = checkConflict({ combo: "Alt+Cmd+C", id: "assistant", all: all(), globals });
    expect(r?.kind).toBe("global");
    expect(r?.message).toContain("划词采集");
  });
  it("合法组合返回 null", () => {
    expect(checkConflict({ combo: "Cmd+J", id: "assistant", all: all(), globals })).toBeNull();
  });
  it("不与自身重复", () => {
    const r = checkConflict({ combo: "Cmd+J", id: "assistant", all: all(), globals });
    expect(r).toBeNull();
  });
});

describe("findAllConflicts", () => {
  it("无冲突时返回空对象", () => {
    expect(Object.keys(findAllConflicts({ ...WINDOW_SHORTCUT_DEFAULTS }, {
      capture: "Alt+Cmd+C", toggle: "Alt+Cmd+N", popup: "Alt+Cmd+P",
    }))).toHaveLength(0);
  });
  it("标记所有冲突项", () => {
    const all = { ...WINDOW_SHORTCUT_DEFAULTS, action_panel: "Cmd+J" }; // 撞 assistant
    const r = findAllConflicts(all, { capture: "Alt+Cmd+C", toggle: "Alt+Cmd+N", popup: "Alt+Cmd+P" });
    expect(r.assistant?.kind).toBe("window");
    expect(r.action_panel?.kind).toBe("window");
  });
});

describe("findShortcutConflicts", () => {
  it("marks both global and window fields when their values collide", () => {
    const windows = { ...WINDOW_SHORTCUT_DEFAULTS };
    const globals = { capture: "Cmd+J", toggle: "Alt+Cmd+N", popup: "Alt+Cmd+P" };
    const conflicts = findShortcutConflicts(windows, globals);
    expect(conflicts.assistant?.message).toContain("划词采集");
    expect(conflicts.capture?.message).toContain("切换 AI 助手");
  });
});

describe("defaults", () => {
  it("8 项默认值齐备", () => {
    expect(WINDOW_SHORTCUT_IDS).toHaveLength(8);
    for (const id of WINDOW_SHORTCUT_IDS) {
      expect(typeof WINDOW_SHORTCUT_DEFAULTS[id as WindowShortcutId]).toBe("string");
    }
  });
});

describe("formatComboForDisplay", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("Windows 环境：文字 + 空格连接", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    vi.resetModules();
    const mod = await import("./shortcuts");
    expect(mod.formatComboForDisplay("Alt+Cmd+C")).toBe("Alt + Cmd + C");
    expect(mod.formatComboForDisplay("Cmd+J")).toBe("Cmd + J");
    expect(mod.formatComboForDisplay("Ctrl+Shift+K")).toBe("Ctrl + Shift + K");
  });

  it("Windows：Mod/Meta 显示为 Win", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    vi.resetModules();
    const mod = await import("./shortcuts");
    expect(mod.formatComboForDisplay("Mod+A")).toBe("Win + A");
    expect(mod.formatComboForDisplay("Meta+B")).toBe("Win + B");
  });

  it("Mac 环境：符号 + 空格连接", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    vi.resetModules();
    const mod = await import("./shortcuts");
    expect(mod.formatComboForDisplay("Alt+Cmd+C")).toBe("⌥ ⌘ C");
    expect(mod.formatComboForDisplay("Cmd+J")).toBe("⌘ J");
    expect(mod.formatComboForDisplay("Ctrl+Shift+K")).toBe("⌃ ⇧ K");
  });

  it("Mac：Mod/Meta 显示为 ⌘", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    vi.resetModules();
    const mod = await import("./shortcuts");
    expect(mod.formatComboForDisplay("Mod+A")).toBe("⌘ A");
    expect(mod.formatComboForDisplay("Meta+B")).toBe("⌘ B");
  });

  it("空字符串原样返回", () => {
    expect(formatComboForDisplay("")).toBe("");
  });
});

describe("formatComboHtml", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("Mac 环境：修饰键用 Phosphor 图标", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    vi.resetModules();
    const mod = await import("./shortcuts");
    const html = mod.formatComboHtml("Alt+Cmd+C");
    expect(html).toContain("ph-option");
    expect(html).toContain("ph-command");
    expect(html).toContain("combo-key\">C</span>");
  });

  it("Mac：Shift 用 arrow-fat-up 图标", async () => {
    vi.stubGlobal("navigator", { platform: "MacIntel" });
    vi.resetModules();
    const mod = await import("./shortcuts");
    const html = mod.formatComboHtml("Ctrl+Shift+K");
    expect(html).toContain("ph-control");
    expect(html).toContain("ph-arrow-fat-up");
    expect(html).toContain("combo-key\">K</span>");
  });

  it("Windows 环境：文字 + 分隔符", async () => {
    vi.stubGlobal("navigator", { platform: "Win32" });
    vi.resetModules();
    const mod = await import("./shortcuts");
    const html = mod.formatComboHtml("Alt+Cmd+C");
    expect(html).toContain("combo-key\">Alt</span>");
    expect(html).toContain("combo-key\">Cmd</span>");
    expect(html).toContain("combo-sep\">+</span>");
  });

  it("空字符串返回空", () => {
    expect(formatComboHtml("")).toBe("");
  });
});
