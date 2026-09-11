import { processGroupSummary, type Block, type ChatMessage, type ChatReference } from "./state";
import { buildActionCard } from "../action-card";
import { fillMarkdown } from "../../shared/markdown/render";
import { createIcon } from "../../shared/ui/icon";
import { parseSelectionMessage } from "../../platform/selection-message";
import { wireOpenUrlLink } from "../../platform/open-url";
import { mentionPresentation, type MentionKind } from "../mention-picker";

/**
 * 助手聊天的 DOM 渲染层：把 state.ts 产出的 `ChatMessage`/`Block` 投影成
 * 可复用的 DOM 节点。状态与渲染分离——`reduceEvents` 是纯函数，DOM 增量
 * 复用由 `blocks.ts` 驱动（按稳定 message/block id 复用而非全量重建）。
 */

function visibleReferenceName(reference: ChatReference): string {
  const specialKind: MentionKind | undefined = reference.noteKind === "inbox" || reference.id === "_inbox"
    ? "inbox"
    : reference.noteKind === "tasks" || reference.id === "_tasks" ? "tasks" : undefined;
  if (!specialKind) return reference.display;
  return mentionPresentation({ name: reference.id, kind: specialKind }).displayName;
}

/**
 * 在气泡下方挂载复制按钮（hover 浮出）。一次性挂载：节点稳定，
 * 不随 token delta 重建。复制原始 markdown 文本（非渲染后纯文本）。
 * align: "left"（AI 气泡，靠左）/ "right"（用户气泡，靠右）。
 */
function attachCopyButton(textEl: HTMLElement, rawText: string, align: "left" | "right" = "left"): void {
  textEl.dataset.copyText = rawText;
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "chat-message-action chat-copy-btn" + (align === "right" ? " is-right" : "");
  btn.setAttribute("aria-label", "复制原文");
  btn.title = "复制";
  btn.append(createIcon({ phosphor: "ph ph-copy", size: 14 }));
  btn.addEventListener("click", () => {
    void copyText(textEl.dataset.copyText ?? "").then((ok) => {
      if (!ok) return;
      btn.title = "已复制";
      btn.setAttribute("aria-label", "已复制");
      btn.replaceChildren(createIcon({ phosphor: "ph ph-check", size: 14 }));
      btn.classList.add("is-copied");
      window.setTimeout(() => {
        btn.title = "复制";
        btn.setAttribute("aria-label", "复制原文");
        btn.replaceChildren(createIcon({ phosphor: "ph ph-copy", size: 14 }));
        btn.classList.remove("is-copied");
      }, 1200);
    });
  });
  ensureMessageActions(textEl, align).appendChild(btn);
}

function ensureMessageActions(textEl: HTMLElement, align: "left" | "right" = "left"): HTMLElement {
  let actions = textEl.querySelector<HTMLElement>(":scope > .chat-message-actions");
  if (!actions) {
    actions = document.createElement("div");
    actions.className = `chat-message-actions${align === "right" ? " is-right" : ""}`;
    textEl.appendChild(actions);
  }
  return actions;
}

function attachUserAction(
  textEl: HTMLElement,
  className: string,
  label: string,
  icon: string,
  messageId: string,
): void {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `chat-message-action ${className}`;
  btn.setAttribute("aria-label", label);
  btn.title = label;
  btn.append(createIcon({ phosphor: icon, size: 14 }));
  btn.addEventListener("click", () => {
    if (className === "chat-edit-btn") {
      const text = textEl.querySelector(".chat-user-message-text")?.textContent ?? "";
      startUserMessageEdit(textEl, messageId, text);
    }
    textEl.dispatchEvent(new CustomEvent(
      className === "chat-retry-btn" ? "chat:user-retry" : "chat:user-edit",
      { bubbles: true, detail: { messageId } },
    ));
  });
  ensureMessageActions(textEl, "right").appendChild(btn);
}

/** 复制文本：优先 navigator.clipboard，降级 execCommand 临时 textarea。 */
function copyText(text: string): Promise<boolean> {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard
      .writeText(text)
      .then(() => true)
      .catch(() => legacyCopy(text));
  }
  return Promise.resolve(legacyCopy(text));
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function decorateCodeBlocks(root: HTMLElement): void {
  for (const pre of root.querySelectorAll<HTMLElement>("pre.chat-codeblock")) {
    if (pre.querySelector(":scope > .chat-code-copy")) continue;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "chat-code-copy";
    button.title = "复制代码";
    button.setAttribute("aria-label", "复制代码");
    button.append(createIcon({ phosphor: "ph ph-copy", size: 13 }));
    button.addEventListener("click", () => {
      const code = pre.querySelector("code")?.textContent ?? "";
      void copyText(code).then((ok) => {
        if (!ok) return;
        button.title = "已复制";
        button.setAttribute("aria-label", "已复制");
        button.replaceChildren(createIcon({ phosphor: "ph ph-check", size: 13 }));
      });
    });
    pre.appendChild(button);
  }
}

export type AssistantOutputMode = "compact" | "detailed";

export function renderMessage(message: ChatMessage, outputMode: AssistantOutputMode = "detailed"): HTMLElement {
  const el = document.createElement("div");
  el.className = `chat-msg chat-${message.role}`;
  el.dataset.messageId = message.id;
  if (message.role === "user") {
    // 用户气泡可能把原始消息投影为问题正文 + 划线引用卡片；保留原文，
    // 以便增量协调时判定是否真的发生过内容变更。
    el.dataset.messageText = message.text;
    const body = document.createElement("div");
    body.className = "chat-msg-text";
    if (message.references?.length) {
      const refs = document.createElement("div");
      refs.className = "chat-reference-chips";
      for (const reference of message.references) {
        const chip = document.createElement("span");
        chip.className = `chat-reference-chip ${reference.kind}`;
        const displayName = reference.kind === "file" ? visibleReferenceName(reference) : reference.display;
        chip.textContent = reference.kind === "skill" ? `Skill · ${displayName}` : `@ ${displayName}`;
        refs.appendChild(chip);
      }
      body.appendChild(refs);
    }
    if (message.text) {
      const text = document.createElement("div");
      text.className = "chat-user-message-text";
      const selection = parseSelectionMessage(message.text);
      fillMarkdown(text, selection?.question ?? message.text);
      decorateCodeBlocks(text);
      body.appendChild(text);
      if (selection) {
        const card = document.createElement("div");
        card.className = "chat-selection-card";
        const lines = selection.selection.split("\n");
        if (lines.length > 3) card.classList.add("is-collapsed");
        const header = document.createElement("div");
        header.className = "chat-selection-header";
        const source = selection.source.url ? document.createElement("a") : document.createElement("span");
        source.className = "chat-selection-source";
        source.textContent = selection.source.label;
        if (source instanceof HTMLAnchorElement) {
          wireOpenUrlLink(source, selection.source.url!);
        }
        header.append(source);
        const quote = document.createElement("div");
        quote.className = "chat-selection-quote";
        quote.textContent = selection.selection;
        card.append(header, quote);
        if (lines.length > 3) {
          const toggle = document.createElement("button");
          toggle.type = "button";
          toggle.className = "chat-selection-toggle";
          toggle.textContent = "展开";
          toggle.addEventListener("click", () => {
            const collapsed = card.classList.toggle("is-collapsed");
            toggle.textContent = collapsed ? "展开" : "收起";
          });
          card.append(toggle);
        }
        body.appendChild(card);
      }
    }
    el.appendChild(body);
    attachUserAction(el, "chat-retry-btn", "重试", "ph ph-arrow-clockwise", message.id);
    attachUserAction(el, "chat-edit-btn", "编辑", "ph ph-pencil-simple", message.id);
    return el;
  }
  // assistant：纵向平级块容器。
  const stack = document.createElement("div");
  stack.className = "chat-blocks";
  const visibleBlocks = outputMode === "compact"
    ? message.blocks.filter((block) => block.kind === "text" || block.kind === "status" || block.kind === "error")
    : message.blocks;
  for (const block of visibleBlocks) {
    stack.appendChild(renderBlock(block, message.streaming));
  }
  applyStreamingProjection(stack, message, outputMode, visibleBlocks);
  el.appendChild(stack);
  return el;
}

export function applyStreamingProjection(
  stack: HTMLElement,
  message: Extract<ChatMessage, { role: "assistant" }>,
  outputMode: AssistantOutputMode,
  visibleBlocks: Block[],
): void {
  stack.querySelector(".chat-compact-progress")?.remove();
  stack.querySelectorAll(".chat-compact-cursor").forEach((node) => node.remove());
  if (outputMode !== "compact" || !message.streaming) return;
  const lastText = [...visibleBlocks].reverse().find((block) => block.kind === "text");
  if (lastText) {
    const block = Array.from(stack.children)
      .find((node) => (node as HTMLElement).dataset.blockId === lastText.id) as HTMLElement | undefined;
    const content = block?.querySelector<HTMLElement>(".chat-text-content");
    if (!content) return;
    const cursor = document.createElement("span");
    cursor.className = "chat-compact-cursor";
    cursor.setAttribute("aria-hidden", "true");
    cursor.textContent = "▋";
    (content.lastElementChild ?? content).appendChild(cursor);
    return;
  }
  const progress = document.createElement("span");
  progress.className = "chat-compact-progress";
  progress.setAttribute("role", "status");
  progress.setAttribute("aria-label", "助手正在处理");
  progress.textContent = "▋";
  stack.appendChild(progress);
}

/** 渲染单个块节点（可复用：reconcile 按需更新而非重建）。 */
export function renderBlock(block: Block, streaming: boolean): HTMLElement {
  const el = document.createElement("div");
  el.className = `chat-block chat-block-${block.kind}`;
  el.dataset.blockId = block.id;
  switch (block.kind) {
    case "wait": {
      el.classList.add("chat-wait");
      el.setAttribute("role", "status");
      const indicator = document.createElement("span");
      indicator.className = "chat-wait-indicator";
      indicator.setAttribute("aria-hidden", "true");
      const label = document.createElement("span");
      label.textContent = block.label;
      el.append(indicator, label);
      break;
    }
    case "text": {
      el.classList.add("chat-text");
      const content = document.createElement("div");
      content.className = "chat-text-content";
      fillMarkdown(content, block.text);
      decorateCodeBlocks(content);
      el.appendChild(content);
      if (streaming) el.classList.add("chat-streaming");
      if (!streaming) attachCopyButton(el, block.text);
      break;
    }
    case "thinking":
      el.classList.toggle("chat-thinking-collapsed", block.collapsed);
      el.classList.toggle("chat-thinking-done", block.done);
      {
        const head = document.createElement("button");
        head.type = "button";
        head.className = "chat-thinking-head";
        head.setAttribute("aria-expanded", String(!block.collapsed));
        const label = document.createElement("span");
        label.className = "chat-thinking-label";
        label.textContent = block.done ? "思考" : "思考中…";
        head.append(label);
        head.addEventListener("click", () => {
          el.dispatchEvent(new CustomEvent("chat:toggle-thinking", { bubbles: true, detail: { blockId: block.id } }));
        });
        const body = document.createElement("div");
        body.className = "chat-thinking-body";
        body.textContent = block.text;
        el.append(head, body);
      }
      break;
    case "action":
      // 动作卡由 action-card 模块构建（header/body/footer + 状态 class）。
      return buildActionCard(block);
    case "process_group": {
      el.classList.add("chat-process-group");
      el.classList.toggle("is-collapsed", block.collapsed);
      const head = document.createElement("button");
      head.type = "button";
      head.className = "chat-process-group-head";
      head.textContent = processGroupSummary(block.items);
      head.setAttribute("aria-expanded", String(!block.collapsed));
      head.addEventListener("click", () => {
        const expanded = head.getAttribute("aria-expanded") === "true";
        head.dispatchEvent(new CustomEvent("chat:toggle-process", {
          bubbles: true,
          detail: { blockId: block.id, collapsed: expanded },
        }));
      });
      const items = document.createElement("div");
      items.className = "chat-process-group-items";
      for (const item of block.items) items.appendChild(renderBlock(item, streaming));
      el.append(head, items);
      break;
    }
    case "error":
      el.setAttribute("role", "alert");
      el.textContent = block.text;
      break;
    case "status":
      el.setAttribute("role", "status");
      el.textContent = block.text;
      break;
  }
  return el;
}

/** 在用户消息节点内打开临时编辑器；发送失败时由调用方保留该编辑器。 */
export function startUserMessageEdit(messageEl: HTMLElement, messageId: string, initialText: string): void {
  const body = messageEl.querySelector<HTMLElement>(":scope > .chat-msg-text");
  if (!body || messageEl.querySelector(".chat-user-edit-shell")) return;
  messageEl.classList.add("is-editing");
  const messageActions = messageEl.querySelector<HTMLElement>(":scope > .chat-message-actions");
  messageActions?.remove();

  const shell = document.createElement("div");
  shell.className = "chat-user-edit-shell";
  const input = document.createElement("textarea");
  input.className = "chat-user-edit-input";
  input.value = initialText;
  input.setAttribute("aria-label", "编辑消息");
  input.dataset.focusStyle = "quiet";
  const actions = document.createElement("div");
  actions.className = "chat-user-edit-actions";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "chat-user-edit-cancel";
  cancel.textContent = "取消";
  const send = document.createElement("button");
  send.type = "button";
  send.className = "chat-user-edit-send";
  send.textContent = "发送";
  cancel.addEventListener("click", () => {
    shell.replaceWith(body);
    messageEl.classList.remove("is-editing");
    if (messageActions) messageEl.appendChild(messageActions);
    messageEl.dispatchEvent(new CustomEvent("chat:user-edit-cancel", { bubbles: true, detail: { messageId } }));
  });
  send.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) return;
    messageEl.dispatchEvent(new CustomEvent("chat:user-edit-send", { bubbles: true, detail: { messageId, text } }));
  });
  actions.append(cancel, send);
  shell.append(input, actions);
  body.replaceWith(shell);
  const fitInput = () => {
    input.style.height = "0";
    const height = Math.max(38, Math.min(input.scrollHeight, 160));
    input.style.height = `${height}px`;
    input.style.overflowY = input.scrollHeight > height ? "auto" : "hidden";
  };
  input.addEventListener("input", fitInput);
  fitInput();
  input.focus();
}
