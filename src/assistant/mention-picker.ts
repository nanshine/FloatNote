import type { ChatScope } from "../platform/chat-history";
import { createDockDropdown } from "./dock-dropdown.js";

/**
 * Mention picker：输入框任意位置输入 `@` → 弹出当前作用域内文件下拉。
 *
 * 下拉生命周期复用 `dock-dropdown.ts`（挂在 `.assistant-dock`：input-wrap 兄弟，
 * 避开其 overflow:hidden）+ `[hidden]` 切换 + `replaceChildren` + 外点关闭。
 *
 * 选中后把 `@query` 段替换为 `@<name> `（纯文本提及，不改 sidecar/agent_send 协议）。
 * 与 skill 下拉互斥：打开时调 `closeSkill()`，由 assistant 在 skill 下拉打开时调本件 close。
 */

export type MentionKind = "inbox" | "tasks" | "piece" | "doc";

export interface MentionFile {
  name: string;
  kind: MentionKind;
}

export interface MentionPickerOptions {
  input: HTMLTextAreaElement;
  dock: HTMLElement;
  listFiles: (scope: ChatScope) => Promise<MentionFile[]>;
  getScope: () => ChatScope | null;
  closeSkill: () => void;
}

export interface MentionPickerHandle {
  destroy: () => void;
  isOpen: () => boolean;
  close: () => void;
}

const KIND_LABEL: Record<MentionKind, string> = {
  inbox: "采集",
  tasks: "行动",
  piece: "写作",
  doc: "文档",
};

const SPECIAL_DISPLAY_NAME: Partial<Record<MentionKind, string>> = {
  inbox: "采集区",
  tasks: "行动清单",
};

const KIND_SEARCH_ALIASES: Record<MentionKind, string> = {
  inbox: "采集 采集区 inbox _inbox",
  tasks: "行动 行动清单 任务 tasks _tasks",
  piece: "写作 成品 piece",
  doc: "文档 document doc",
};

/** Keep filesystem identifiers stable while presenting system notes as product
 * concepts. This projection is shared by the legacy picker and the structured
 * composer, so `_inbox` / `_tasks` never leak into user-facing labels. */
export function mentionPresentation(file: MentionFile): {
  displayName: string;
  kindLabel: string;
  keywords: string;
} {
  return {
    displayName: SPECIAL_DISPLAY_NAME[file.kind] ?? file.name,
    kindLabel: KIND_LABEL[file.kind],
    keywords: `${file.name} ${KIND_SEARCH_ALIASES[file.kind]}`,
  };
}

/** 纯函数：构建文件列表 DOM（供 jsdom 测试）。按展示名和隐藏别名过滤。
 *  每项是 `<button data-mention-name="...">`，含 name + kind 标签两个 span。 */
export function renderFileList(files: MentionFile[], query: string): HTMLElement {
  const container = document.createElement("div");
  container.className = "assistant-mention-list";
  const q = query.trim().toLowerCase();
  const filtered = q ? files.filter((file) => {
    const presentation = mentionPresentation(file);
    return `${presentation.displayName} ${presentation.keywords}`.toLowerCase().includes(q);
  }) : files;
  if (filtered.length === 0) {
    const empty = document.createElement("div");
    empty.className = "assistant-mention-empty";
    empty.textContent = "没有匹配的文件";
    container.appendChild(empty);
    return container;
  }
  for (const f of filtered) {
    const presentation = mentionPresentation(f);
    const item = document.createElement("button");
    item.type = "button";
    item.className = "assistant-mention-item";
    item.dataset.mentionName = f.name;
    const name = document.createElement("span");
    name.className = "assistant-mention-name";
    name.textContent = presentation.displayName;
    const kind = document.createElement("span");
    kind.className = "assistant-mention-kind";
    kind.textContent = presentation.kindLabel;
    item.append(name, kind);
    container.appendChild(item);
  }
  return container;
}

/** 纯函数：基于光标位置检测 `@` 触发。支持句中 `@`（@ 前须为行首或空白）。
 *  返回 `{ query, start, end }`：start..end 为待替换的 `@query` 区间；无命中返回 null。 */
export function currentMentionQuery(input: HTMLTextAreaElement): {
  query: string;
  start: number;
  end: number;
} | null {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const m = before.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) return null;
  // m.index 是「@」前导（行首或空白）的起始；待替换区间从「@」开始。
  const atIdx = (m.index ?? 0) + (m[0].length - 1 - m[1].length);
  return { query: m[1], start: atIdx, end: caret };
}

/** 把选中文件替换进输入框的 `@query` 区间，光标置尾并聚焦，触发 input 事件驱动 autosize。 */
function applyMention(
  input: HTMLTextAreaElement,
  name: string,
  start: number,
  end: number,
): void {
  const before = input.value.slice(0, start);
  const after = input.value.slice(end);
  const insertion = `@${name} `;
  input.value = `${before}${insertion}${after}`;
  const caret = (before + insertion).length;
  input.focus();
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

export function mountMentionPicker(opts: MentionPickerOptions): MentionPickerHandle {
  const { input, dock, listFiles, getScope, closeSkill } = opts;
  let cache: { scope: ChatScope; files: MentionFile[] } | null = null;
  // 当前打开下拉时记录的 `@query` 区间；点击选中时用它做替换。每次 openDropdown 更新。
  let activeRange: { start: number; end: number } = { start: 0, end: 0 };

  function close(): void {
    menu.hide();
  }

  // 复用共享 dock-dropdown：click 委托 + pointerdown stopPropagation + 外点关闭 + 生命周期。
  const menu = createDockDropdown({
    className: "fn-popover assistant-mention-dropdown",
    parent: dock,
    inside: input,
    selector: "[data-mention-name]",
    attr: "data-mention-name",
    onSelect: (name) => {
      // 替换区间以实时 activeRange 为准（过滤期间会更新）。
      const file = cache?.files.find((candidate) => candidate.name === name);
      applyMention(input, file ? mentionPresentation(file).displayName : name, activeRange.start, activeRange.end);
      close();
    },
    onOutside: close,
  });

  async function ensureFiles(): Promise<MentionFile[] | null> {
    const scope = getScope();
    if (!scope) return null;
    if (cache && cache.scope.scopeType === scope.scopeType && cache.scope.scopePath === scope.scopePath) {
      return cache.files;
    }
    try {
      const files = await listFiles(scope);
      cache = { scope, files };
      return files;
    } catch {
      cache = null;
      return null;
    }
  }

  function openDropdown(files: MentionFile[], query: string, range: { start: number; end: number }): void {
    activeRange = range;
    menu.show(renderFileList(files, query));
  }

  async function recompute() {
    const range = currentMentionQuery(input);
    if (!range) {
      menu.hide();
      return;
    }
    const files = await ensureFiles();
    if (!files || files.length === 0) {
      menu.hide();
      return;
    }
    // 异步拉取期间 `@query` 可能已变，重新校验区间。
    const latest = currentMentionQuery(input);
    if (!latest) {
      menu.hide();
      return;
    }
    closeSkill(); // 与 skill 下拉互斥
    openDropdown(files, latest.query, latest);
  }

  function onInput() {
    void recompute();
  }
  function onKeyup(e: KeyboardEvent) {
    // 方向键移动光标需重算提及区间。
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      void recompute();
    }
  }

  input.addEventListener("input", onInput);
  input.addEventListener("keyup", onKeyup);

  function isOpen(): boolean {
    return menu.isOpen();
  }

  function destroy(): void {
    close();
    input.removeEventListener("input", onInput);
    input.removeEventListener("keyup", onKeyup);
    menu.destroy();
  }

  return { destroy, isOpen, close };
}
