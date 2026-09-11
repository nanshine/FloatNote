import { processGroupSummary, type Block, type ChatMessage } from "./render";
import { applyStreamingProjection, decorateCodeBlocks, renderBlock, renderMessage, startUserMessageEdit, type AssistantOutputMode } from "./render/view";
import { updateActionCard } from "./action-card";
import { fillMarkdown } from "../shared/markdown/render";

/**
 * 定向增量渲染（消灭闪烁）。
 *
 * 聊天流是「只追加」形态：消息只 append、最后一条在流式。故用
 * `messageId → DOM 节点` Map 复用已完成消息、按 `blockId` 增量更新流式块，
 * 而非全量重建。已完成消息/块节点不重建 → 进场动画不重放 → 闪烁消失。
 */

/** 每条 assistant 消息的 block 节点 Map（按消息节点 WeakMap 关联，随消息销毁）。 */
const blockMaps = new WeakMap<HTMLElement, Map<string, HTMLElement>>();

/** 滚动粘底阈值：距底小于此值时才自动滚底（用户上滚阅读时不抢滚动）。 */
const STICK_TO_BOTTOM_PX = 120;

/** rerender 入口：定向增量更新消息列表。 */
export function reconcileMessages(
  scroll: HTMLElement,
  messages: ChatMessage[],
  map: Map<string, HTMLElement>,
  outputMode: AssistantOutputMode = "detailed",
  followBottom?: boolean,
): void {
  const stickToBottom = followBottom ?? isNearBottom(scroll);
  const seen = new Set<string>();
  let cursor: HTMLElement | null = null;

  for (const message of messages) {
    if (!isVisibleMessage(message, outputMode)) continue;
    seen.add(message.id);
    let node = map.get(message.id);
    if (
      node
      && message.role === "user"
      && node.dataset.messageText !== message.text
    ) {
      const replacement = renderMessage(message, outputMode);
      node.replaceWith(replacement);
      node = replacement;
      map.set(message.id, node);
    }
    if (!node) {
      node = renderMessage(message, outputMode);
      map.set(message.id, node);
    }
    // 维持顺序（消息一般只 append，但 session_opened 会整体替换）。
    const expectedNext: ChildNode | null = cursor ? cursor.nextSibling : scroll.firstChild;
    if (expectedNext !== node) {
      if (cursor) cursor.after(node!);
      else scroll.prepend(node!);
    }
    cursor = node!;

    if (message.role === "assistant") {
      reconcileBlocks(node!, message, outputMode);
    }
  }

  // 删除已不存在的消息节点（会话切换时）。
  for (const [id, node] of map) {
    if (!seen.has(id)) {
      node.remove();
      map.delete(id);
    }
  }

  if (stickToBottom) {
    scroll.scrollTop = scroll.scrollHeight;
  }
}

function isVisibleMessage(message: ChatMessage, outputMode: AssistantOutputMode): boolean {
  if (message.role === "user" || outputMode === "detailed" || message.streaming) return true;
  return message.blocks.some((block) => block.kind === "text" || block.kind === "status" || block.kind === "error");
}

/** 打开指定用户消息的临时编辑器，编辑状态仅保留在 DOM 内。 */
export function beginUserMessageEdit(messageEl: HTMLElement, messageId: string, text: string): void {
  startUserMessageEdit(messageEl, messageId, text);
}

/** 增量更新一条 assistant 消息的块序列。新建消息时 renderMessage 已构建块节点，
 *  这里先从 DOM 索引进 bmap，避免重复创建；之后按 blockId 复用/更新。 */
function reconcileBlocks(
  msgEl: HTMLElement,
  message: Extract<ChatMessage, { role: "assistant" }>,
  outputMode: AssistantOutputMode,
): void {
  let bmap = blockMaps.get(msgEl);
  if (!bmap) {
    bmap = new Map();
    blockMaps.set(msgEl, bmap);
    indexBlockNodes(msgEl, bmap);
  }
  const container = msgEl.querySelector<HTMLElement>(".chat-blocks");
  if (!container) return;

  const seen = new Set<string>();
  let cursor: HTMLElement | null = null;

  const visibleBlocks = outputMode === "compact"
    ? message.blocks.filter((block) => block.kind === "text" || block.kind === "status" || block.kind === "error")
    : message.blocks;
  for (const block of visibleBlocks) {
    seen.add(block.id);
    let node = bmap.get(block.id);
    if (!node) {
      node = renderBlock(block, message.streaming);
      bmap.set(block.id, node);
    } else {
      updateBlockNode(node, block, message.streaming);
    }
    const expectedNext: ChildNode | null = cursor ? cursor.nextSibling : container.firstChild;
    if (expectedNext !== node) {
      if (cursor) cursor.after(node!);
      else container.prepend(node!);
    }
    cursor = node!;
  }

  for (const [id, node] of bmap) {
    if (!seen.has(id)) {
      node.remove();
      bmap.delete(id);
    }
  }
  applyStreamingProjection(container, message, outputMode, visibleBlocks);
}

/** 把 renderMessage 已构建的块节点（按 data-block-id）索引进 bmap。 */
function indexBlockNodes(msgEl: HTMLElement, bmap: Map<string, HTMLElement>): void {
  const container = msgEl.querySelector<HTMLElement>(".chat-blocks");
  if (!container) return;
  for (const child of Array.from(container.children)) {
    const id = (child as HTMLElement).getAttribute("data-block-id");
    if (id) bmap.set(id, child as HTMLElement);
  }
}

/** 更新已存在的块节点内容/状态（不重建）。 */
function updateBlockNode(node: HTMLElement, block: Block, streaming: boolean): void {
  switch (block.kind) {
    case "wait": {
      const label = node.lastElementChild;
      if (label) label.textContent = block.label;
      break;
    }
    case "text": {
      const content = node.querySelector<HTMLElement>(".chat-text-content");
      if (content) fillMarkdown(content, block.text);
      if (content) decorateCodeBlocks(content);
      node.dataset.copyText = block.text;
      node.classList.toggle("chat-streaming", streaming);
      const copy = node.querySelector(".chat-copy-btn");
      if (!streaming && !copy) {
        const replacement = renderBlock(block, false);
        node.replaceChildren(...Array.from(replacement.childNodes));
      }
      break;
    }
    case "thinking": {
      node.classList.toggle("chat-thinking-collapsed", block.collapsed);
      node.classList.toggle("chat-thinking-done", block.done);
      const body = node.querySelector<HTMLElement>(".chat-thinking-body");
      if (body) body.textContent = block.text;
      const head = node.querySelector<HTMLElement>(".chat-thinking-head");
      if (head) head.setAttribute("aria-expanded", String(!block.collapsed));
      const label = node.querySelector<HTMLElement>(".chat-thinking-label");
      if (label) label.textContent = block.done ? "思考" : "思考中…";
      break;
    }
    case "action":
      updateActionCard(node, block);
      break;
    case "process_group": {
      if (!node.classList.contains("chat-process-group")) {
        const replacement = renderBlock(block, streaming);
        node.className = replacement.className;
        node.replaceChildren(...Array.from(replacement.childNodes));
        break;
      }
      node.classList.toggle("is-collapsed", block.collapsed);
      const head = node.querySelector<HTMLButtonElement>(".chat-process-group-head");
      if (head) {
        head.textContent = processGroupSummary(block.items);
        head.setAttribute("aria-expanded", String(!block.collapsed));
      }
      const items = node.querySelector<HTMLElement>(".chat-process-group-items");
      if (!items) break;
      const existing = new Map<string, HTMLElement>();
      for (const child of Array.from(items.children) as HTMLElement[]) {
        if (child.dataset.blockId) existing.set(child.dataset.blockId, child);
      }
      let cursor: HTMLElement | null = null;
      const seen = new Set<string>();
      for (const item of block.items) {
        seen.add(item.id);
        let child = existing.get(item.id);
        if (child) updateBlockNode(child, item, streaming);
        else child = renderBlock(item, streaming);
        const expected: ChildNode | null = cursor ? cursor.nextSibling : items.firstChild;
        if (expected !== child) cursor ? cursor.after(child) : items.prepend(child);
        cursor = child;
      }
      for (const [id, child] of existing) if (!seen.has(id)) child.remove();
      break;
    }
    case "error":
      if (node.textContent !== block.text) node.textContent = block.text;
      break;
    case "status":
      if (node.textContent !== block.text) node.textContent = block.text;
      break;
  }
}

/** 是否贴近底部（用于决定是否自动滚底）。 */
function isNearBottom(scroll: HTMLElement): boolean {
  const dist = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight;
  return dist <= STICK_TO_BOTTOM_PX;
}

/** 供测试：清除某消息节点的 block 映射（避免跨用例泄漏）。 */
export function __resetBlockMap(msgEl: HTMLElement): void {
  blockMaps.delete(msgEl);
}
