/**
 * 快捷键共享纯函数：键位默认值、KeyboardEvent→组合串、归一化、冲突检测。
 * 设置页（录制+冲突提示）与笔记窗（中央分派）共用，避免逻辑重复。
 */

const isMac =
  typeof navigator !== "undefined" && navigator.platform
    ? navigator.platform.toUpperCase().indexOf("MAC") >= 0
    : false;

export type WindowShortcutId =
  | "assistant"
  | "assistant_bubble"
  | "action_panel"
  | "add_action"
  | "new_conversation"
  | "view_inbox"
  | "view_piece"
  | "view_split";

export const WINDOW_SHORTCUT_IDS: WindowShortcutId[] = [
  "assistant",
  "assistant_bubble",
  "action_panel",
  "add_action",
  "new_conversation",
  "view_inbox",
  "view_piece",
  "view_split",
];

const primaryModifier = isMac ? "Cmd" : "Ctrl";

export const WINDOW_SHORTCUT_DEFAULTS: Record<WindowShortcutId, string> = {
  assistant: `${primaryModifier}+J`,
  assistant_bubble: `${primaryModifier}+B`,
  action_panel: `${primaryModifier}+T`,
  add_action: `${primaryModifier}+G`,
  new_conversation: `${primaryModifier}+K`,
  view_inbox: `${primaryModifier}+1`,
  view_piece: `${primaryModifier}+2`,
  view_split: `${primaryModifier}+3`,
};

export const WINDOW_SHORTCUT_LABELS: Record<WindowShortcutId, string> = {
  assistant: "切换 AI 助手",
  assistant_bubble: "展开 / 收起 AI 消息",
  action_panel: "打开 / 关闭待办面板",
  add_action: "新建待办",
  new_conversation: "新对话",
  view_inbox: "切换到采集视图",
  view_piece: "切换到写作视图",
  view_split: "切换到双栏视图",
};

/** 将内部快捷键字符串格式化为平台友好的显示文本。Mac 用符号（⌥ ⌘ C），Windows 用文字（Alt + Cmd + C）。 */
export function formatComboForDisplay(combo: string): string {
  if (!combo) return combo;
  const parts = combo.split("+");
  if (isMac) {
    return parts.map((p) => {
      switch (p) {
        case "Alt": return "⌥";
        case "Cmd": case "Meta": case "Mod": return "⌘";
        case "Shift": return "⇧";
        case "Ctrl": case "Control": return "⌃";
        case " ": return "␣";
        default: return p;
      }
    }).join(" ");
  }
  return parts.map((p) => {
    switch (p) {
      case "Cmd": case "Meta": case "Mod": return "Ctrl";
      case "Control": return "Ctrl";
      default: return p;
    }
  }).join(" + ");
}

const MAC_ICON_MAP: Record<string, string> = {
  Alt: "ph ph-option",
  Cmd: "ph ph-command",
  Meta: "ph ph-command",
  Mod: "ph ph-command",
  Shift: "ph ph-arrow-fat-up",
  Ctrl: "ph ph-control",
  Control: "ph ph-control",
};

/** 将内部快捷键字符串格式化为带 Phosphor 图标的 HTML（Mac 用图标，Windows 用文字）。 */
export function formatComboHtml(combo: string): string {
  if (!combo) return "";
  const parts = combo.split("+");
  if (isMac) {
    return parts.map((p) => {
      const icon = MAC_ICON_MAP[p];
      if (icon) return `<i class="${icon}" aria-hidden="true"></i>`;
      if (p === " ") return `<span class="combo-key">␣</span>`;
      return `<span class="combo-key">${p}</span>`;
    }).join("");
  }
  return parts.map((p) => {
    switch (p) {
      case "Cmd": case "Meta": case "Mod": return "<span class=\"combo-key\">Ctrl</span>";
      case "Control": return "<span class=\"combo-key\">Ctrl</span>";
      default: return `<span class="combo-key">${p}</span>`;
    }
  }).join("<span class=\"combo-sep\">+</span>");
}

function keyName(key: string): string {
  switch (key) {
    case "Meta": return isMac ? "Cmd" : "Win";
    case "Control": return "Ctrl";
    case "Alt": return "Alt";
    case "Shift": return "Shift";
    case " ": return "Space";
    case "+": return "=";
    default: return key.length === 1 ? key.toUpperCase() : key;
  }
}

/** KeyboardEvent → "Cmd+J" 格式；无修饰键或仅修饰键按下返回 null。 */
export function eventToCombo(e: KeyboardEvent): string | null {
  if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return null;
  const mods: string[] = [];
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  if (e.metaKey) mods.push(isMac ? "Cmd" : "Win");
  if (mods.length === 0) return null;
  mods.push(keyName(e.key));
  return mods.join("+");
}

/** "Cmd+J" → "Mod+J"（Cmd/Win/Ctrl/Meta 归一 Mod，字母大写，修饰键顺序 Shift,Alt,Mod）。 */
export function canonicalize(combo: string): string {
  const mods = new Set<string>();
  let main = "";
  for (const part of combo.split("+")) {
    if (part === "Mod" || part === "Cmd" || part === "Win" || part === "Ctrl" || part === "Meta") {
      mods.add("Mod");
    } else if (part === "Alt") {
      mods.add("Alt");
    } else if (part === "Shift") {
      mods.add("Shift");
    } else {
      main = part.length === 1 ? part.toUpperCase() : part;
    }
  }
  const out: string[] = [];
  for (const m of ["Shift", "Alt", "Mod"]) {
    if (mods.has(m)) out.push(m);
  }
  if (main) out.push(main);
  return out.join("+");
}

interface ReservedEntry {
  combo: string;
  reason: string;
}

const RAW_RESERVED: ReservedEntry[] = [
  // ProseMirror/嵌套代码编辑器默认键位占用；应用级保留标准编辑快捷键。
  { combo: "Mod+A", reason: "与编辑器「全选」相同，无法使用" },
  { combo: "Mod+I", reason: "该组合键已被编辑器占用" },
  { combo: "Mod+U", reason: "与编辑器「选区撤销」相同，无法使用" },
  { combo: "Mod+Shift+U", reason: "与编辑器「选区重做」相同，无法使用" },
  { combo: "Mod+Y", reason: "与编辑器「重做」相同，无法使用" },
  { combo: "Mod+Z", reason: "与编辑器「撤销」相同，无法使用" },
  { combo: "Mod+Shift+Z", reason: "与编辑器「重做」相同，无法使用" },
  { combo: "Mod+[", reason: "与编辑器「减少缩进」相同，无法使用" },
  { combo: "Mod+]", reason: "与编辑器「增加缩进」相同，无法使用" },
  { combo: "Mod+/", reason: "与编辑器「注释」相同，无法使用" },
  { combo: "Mod+Enter", reason: "该组合键已被编辑器占用" },
  { combo: "Shift+Mod+K", reason: "该组合键已被编辑器占用" },
  // 主笔记编辑器字号
  { combo: "Mod+=", reason: "与编辑器「增大字号」相同，无法使用" },
  { combo: "Shift+Mod+=", reason: "与编辑器「增大字号」相同，无法使用" },
  { combo: "Mod+-", reason: "与编辑器「减小字号」相同，无法使用" },
  { combo: "Mod+0", reason: "与编辑器「重置字号」相同，无法使用" },
  // 系统/平台保留
  { combo: "Mod+Q", reason: "与系统「退出应用」相同，无法使用" },
  { combo: "Mod+W", reason: "与系统「关闭窗口」相同，无法使用" },
  { combo: "Mod+M", reason: "与系统「最小化」相同，无法使用" },
  { combo: "Mod+H", reason: "与系统「隐藏」相同，无法使用" },
  { combo: "Mod+N", reason: "与系统「新窗口」相同，无法使用" },
  { combo: "Mod+R", reason: "与系统「刷新」相同，无法使用" },
  // 复制粘贴
  { combo: "Mod+C", reason: "与「复制」相同，无法使用" },
  { combo: "Mod+V", reason: "与「粘贴」相同，无法使用" },
  { combo: "Mod+X", reason: "与「剪切」相同，无法使用" },
];

const RESERVED_MAP = new Map<string, string>(
  RAW_RESERVED.map((r) => [canonicalize(r.combo), r.reason]),
);

export interface ConflictInput {
  combo: string;
  id: WindowShortcutId;
  all: Record<WindowShortcutId, string>;
  globals: { capture: string; toggle: string; popup: string };
}

export interface ConflictResult {
  kind: "reserved" | "window" | "global";
  message: string;
}

export function checkConflict(input: ConflictInput): ConflictResult | null {
  const c = canonicalize(input.combo);
  const reserved = RESERVED_MAP.get(c);
  if (reserved) return { kind: "reserved", message: reserved };
  for (const id of WINDOW_SHORTCUT_IDS) {
    if (id === input.id) continue;
    if (input.all[id] && canonicalize(input.all[id]) === c) {
      return { kind: "window", message: `与「${WINDOW_SHORTCUT_LABELS[id]}」相同` };
    }
  }
  const labels: Array<[string, string]> = [
    [input.globals.capture, "划词采集"],
    [input.globals.toggle, "显示/隐藏窗口"],
    [input.globals.popup, "选中文字弹窗"],
  ];
  for (const [combo, label] of labels) {
    if (combo && canonicalize(combo) === c) {
      return { kind: "global", message: `与系统快捷键「${label}」相同，会同时触发两个操作` };
    }
  }
  return null;
}

export function findAllConflicts(
  all: Record<WindowShortcutId, string>,
  globals: { capture: string; toggle: string; popup: string },
): Partial<Record<WindowShortcutId, ConflictResult>> {
  const out: Partial<Record<WindowShortcutId, ConflictResult>> = {};
  for (const id of WINDOW_SHORTCUT_IDS) {
    const r = checkConflict({ combo: all[id], id, all, globals });
    if (r) out[id] = r;
  }
  return out;
}

export type ShortcutFieldId = WindowShortcutId | "capture" | "toggle" | "popup";

export function findShortcutConflicts(
  all: Record<WindowShortcutId, string>,
  globals: { capture: string; toggle: string; popup: string },
): Partial<Record<ShortcutFieldId, ConflictResult>> {
  const conflicts: Partial<Record<ShortcutFieldId, ConflictResult>> = findAllConflicts(all, globals);
  const globalLabels = { capture: "划词采集", toggle: "显示 / 隐藏窗口", popup: "打开选中文字弹窗" };
  for (const globalId of ["capture", "toggle", "popup"] as const) {
    const value = globals[globalId];
    const reserved = RESERVED_MAP.get(canonicalize(value));
    if (reserved) {
      conflicts[globalId] = { kind: "reserved", message: reserved };
      continue;
    }
    for (const windowId of WINDOW_SHORTCUT_IDS) {
      if (canonicalize(all[windowId]) === canonicalize(value)) {
        conflicts[globalId] = { kind: "window", message: `与「${WINDOW_SHORTCUT_LABELS[windowId]}」相同` };
        conflicts[windowId] = {
          kind: "global",
          message: `与系统快捷键「${globalLabels[globalId]}」相同，会同时触发两个操作`,
        };
      }
    }
    for (const otherId of ["capture", "toggle", "popup"] as const) {
      if (otherId !== globalId && canonicalize(globals[otherId]) === canonicalize(value)) {
        conflicts[globalId] = { kind: "global", message: `与「${globalLabels[otherId]}」相同` };
      }
    }
  }
  return conflicts;
}
