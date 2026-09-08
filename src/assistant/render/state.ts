import type { ChatDisplayMessage, ToolCategory } from "../../platform/agent";
import { type EditPreviewDetail, type WriteMode } from "../permission-bubble";

/**
 * 助手聊天的纯状态机：把流式 agent 事件 + 本地用户发送合并成一个块序列。
 *
 * 心智模型对标 Claude.ai / ChatGPT：一条 assistant 消息 = 一串平级块
 * （text / thinking / action / error），块互不嵌套。渲染与状态分离：
 * `reduceEvents` 是纯函数，便于单测；DOM 投影由 `blocks.ts` 增量复用。
 *
 * 闪烁修复的关键：状态层产出稳定的 message/block id，渲染层据此复用节点
 * 而非全量重建（见 `blocks.ts`）。
 */

/** 用户在输入框发送的本地事件 + 前端派生的 permission 事件，与 Rust AgentEvent 一起喂给 reducer。 */
export type ChatEvent =
  | {
      type: "session_opened";
      conversationId: string;
      sessionFile: string;
      messages: ChatDisplayMessage[];
    }
  | { type: "session_synced"; conversationId: string; sessionFile: string; messages: ChatDisplayMessage[] }
  | { type: "delta"; requestId: string; conversationId?: string; text: string }
  | { type: "tool"; requestId: string; conversationId?: string; callId?: string; name: string; category?: ToolCategory; label?: string; phase: "prepare" | "start" | "end"; error?: string; isError?: boolean }
  | { type: "done"; requestId: string; conversationId?: string; outcome?: "completed" | "cancelled" | "failed" }
  | { type: "title"; conversationId: string; title: string }
  | { type: "error"; requestId: string | null; conversationId?: string; message: string }
  | { type: "user"; conversationId?: string; text: string; references?: ChatReference[] }
  | { type: "user_edit"; messageId: string; text: string }
  | { type: "user_rewind"; messageId: string; text: string }
  | { type: "pending"; conversationId?: string }
  // thinking 块事件（Rust Agent 流式转发）。
  | { type: "thinking_start"; requestId: string; conversationId?: string; blockId: string }
  | { type: "thinking_delta"; requestId: string; conversationId?: string; text: string }
  | { type: "thinking_end"; requestId: string; conversationId?: string }
  // 流内动作卡：复用 Rust permission://request 流填充 detail，resolve 驱动状态。
  | {
      type: "permission_request";
      requestId: string; // Rust pending-edit id，resolve 幂等键
      callId?: string;
      conversationId?: string;
      toolName: string;
      detail: EditPreviewDetail;
      summary: string;
      oldContent: string;
      newContent: string;
      canSnapshot: boolean;
    }
  | { type: "permission_resolve"; requestId: string; decision: "allow" | "deny" }
  | { type: "permission_resolve_failed"; requestId: string; message: string }
  // thinking 折叠切换（仅内存，不落库）。
  | { type: "thinking_toggle"; blockId: string }
  | { type: "process_toggle"; blockId: string; collapsed: boolean };

export type ActionBlock = {
  id: string;
  kind: "action";
  tool: string;
  category?: ToolCategory;
  label?: string;
  detail?: EditPreviewDetail;
  summary?: string;
  oldContent?: string;
  newContent?: string;
  canSnapshot?: boolean;
  callId?: string;
  targets: string[];
  decision: "pending" | "allowed" | "denied";
  execution: "running" | "succeeded" | "failed" | "incomplete" | "rejected";
  resultSummary?: string;
  writeMode?: WriteMode;
  requestId?: string;
  permissionError?: string;
};

export type ThinkingBlock = { id: string; kind: "thinking"; text: string; collapsed: boolean; done: boolean };
export type ProcessItem = ThinkingBlock | ActionBlock;

export type Block =
  | { id: string; kind: "wait"; label: string }
  | { id: string; kind: "text"; text: string; streaming?: boolean }
  | ThinkingBlock
  | ActionBlock
  | { id: string; kind: "process_group"; collapsed: boolean; items: ProcessItem[] }
  | { id: string; kind: "status"; text: string }
  | { id: string; kind: "error"; text: string };

export type ChatMessage =
  | { id: string; role: "user"; text: string; references?: ChatReference[]; sessionEntryId?: string }
  | { id: string; role: "assistant"; blocks: Block[]; streaming: boolean; pending?: true };

export interface ChatState {
  activeConversationId?: string;
  messages: ChatMessage[];
}

/** 用户提交时已解析的文件/Skill 引用，供当前对话气泡渲染；不落入历史文本。 */
export type ChatReference = {
  kind: "file" | "skill";
  id: string;
  display: string;
  noteKind?: "inbox" | "tasks" | "piece" | "doc";
};

const EMPTY_RESPONSE_MESSAGE = "助手这次没有返回内容。请检查模型名称、API Key、服务商额度或网络连接后重试。";

// 稳定 id 生成：消息/块节点复用的键。用递增计数器（运行时单例足够）；
// 测试通过 stripIds 归一化比较，不依赖具体值。
let idSeq = 0;
function nextId(prefix: string): string {
  return `${prefix}${++idSeq}`;
}

export function emptyChat(): ChatState {
  return { messages: [] };
}

export function processGroupSummary(items: ProcessItem[]): string {
  const running = items.some((item) => item.kind === "thinking" ? !item.done : item.execution === "running");
  const failed = items.filter((item) => item.kind === "action" && item.execution === "failed").length;
  const incomplete = items.filter((item) => item.kind === "action" && item.execution === "incomplete").length;
  if (running) return `正在处理 · ${items.length} 个步骤`;
  if (failed) return `处理了 ${items.length} 个步骤 · ${failed} 项失败`;
  if (incomplete) return `处理了 ${items.length} 个步骤 · ${incomplete} 项未完成`;
  return `处理了 ${items.length} 个步骤`;
}

/** 当前是否正在流式输出（存在 streaming 的 assistant 消息）。 */
export function isChatStreaming(state: ChatState): boolean {
  return state.messages.some((m) => m.role === "assistant" && m.streaming);
}

/** 纯函数：根据一条事件返回新状态（不变更入参）。 */
export function reduceEvents(state: ChatState, event: ChatEvent): ChatState {
  switch (event.type) {
    case "session_opened":
      if (!acceptsConversation(state, event)) return state;
      if (
        state.activeConversationId === event.conversationId &&
        state.messages.length > 0 &&
        event.messages.length === 0 &&
        state.messages.some((message) => message.role === "user" || message.streaming)
      ) {
        return removeConfigurationErrors(state);
      }
      return {
        activeConversationId: event.conversationId,
        messages: event.messages
          .map(displayMessageToChatMessage)
          .filter((m): m is ChatMessage => m !== null),
      };

    case "session_synced": {
      if (!acceptsConversation(state, event)) return state;
      const persistedUsers = event.messages.filter(
        (message): message is Extract<ChatDisplayMessage, { role: "user" }> => message.role === "user",
      );
      let userIndex = 0;
      return {
        ...state,
        messages: state.messages.map((message) => {
          if (message.role !== "user") return message;
          const entryId = persistedUsers[userIndex++]?.entryId;
          return entryId ? { ...message, sessionEntryId: entryId } : message;
        }),
      };
    }

    case "title":
      return state;

    case "user":
      if (!acceptsConversation(state, event)) return state;
      return push(state, {
        id: nextId("m"),
        role: "user",
        text: event.text,
        ...(event.references?.length ? { references: event.references } : {}),
      });

    case "user_edit":
      return {
        ...state,
        messages: state.messages.map((message) =>
          message.role === "user" && message.id === event.messageId
            ? { ...message, text: event.text }
            : message,
        ),
      };

    case "user_rewind": {
      const index = state.messages.findIndex(
        (message) => message.role === "user" && message.id === event.messageId,
      );
      if (index < 0) return state;
      const message = state.messages[index] as Extract<ChatMessage, { role: "user" }>;
      return {
        ...state,
        messages: [...state.messages.slice(0, index), { ...message, text: event.text }],
      };
    }

    case "pending":
      if (!acceptsConversation(state, event)) return state;
      return push(removePending(state), {
        id: nextId("m"),
        role: "assistant",
        blocks: [{ id: nextId("b"), kind: "wait", label: "正在准备回复…" }],
        streaming: true,
        pending: true,
      });

    case "delta": {
      if (!acceptsConversation(state, event)) return state;
      const last = state.messages[state.messages.length - 1];
      if (last && last.role === "assistant" && last.streaming) {
        if (last.pending) {
          // 首个真实 token：替换占位文本块，清除 pending。
          return updateLast(state, {
            ...last,
            pending: undefined,
            blocks: [{ id: nextId("b"), kind: "text", text: event.text, streaming: true }],
          });
        }
        const blocks = last.blocks.slice();
        const lb = blocks[blocks.length - 1];
        if (lb && lb.kind === "text") {
          blocks[blocks.length - 1] = { ...lb, text: lb.text + event.text, streaming: true };
        } else {
          blocks.push({ id: nextId("b"), kind: "text", text: event.text, streaming: true });
        }
        return updateLast(state, { ...last, blocks });
      }
      return push(state, {
        id: nextId("m"),
        role: "assistant",
        blocks: [{ id: nextId("b"), kind: "text", text: event.text, streaming: true }],
        streaming: true,
      });
    }

    case "thinking_start": {
      if (!acceptsConversation(state, event)) return state;
      const { state: s, msg } = ensureStreaming(state);
      return updateLast(s, {
        ...msg,
        blocks: appendProcessItem(msg.blocks, { id: event.blockId, kind: "thinking", text: "", collapsed: true, done: false }),
      });
    }

    case "thinking_delta": {
      if (!acceptsConversation(state, event)) return state;
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== "assistant" || !last.streaming) return state;
      const blocks = last.blocks.slice();
      if (!updateLastThinking(blocks, (thinking) => ({ ...thinking, text: thinking.text + event.text }))) {
        return updateLast(state, { ...last, blocks: appendProcessItem(blocks, { id: nextId("b"), kind: "thinking", text: event.text, collapsed: true, done: false }) });
      }
      return updateLast(state, { ...last, blocks });
    }

    case "thinking_end": {
      if (!acceptsConversation(state, event)) return state;
      const last = state.messages[state.messages.length - 1];
      if (!last || last.role !== "assistant") return state;
      const blocks = last.blocks.slice();
      updateLastThinking(blocks, (thinking) => ({ ...thinking, done: true }));
      return updateLast(state, { ...last, blocks });
    }

    case "done": {
      if (!acceptsConversation(state, event)) return state;
      if (event.outcome === "cancelled") {
        const cleaned = finalizeStreaming(removePending(state));
        const last = cleaned.messages[cleaned.messages.length - 1];
        if (last && last.role === "assistant" && !last.streaming) {
          const { pending: _pending, ...finished } = last;
          return updateLast(cleaned, {
            ...finished,
            blocks: [...finished.blocks, { id: nextId("b"), kind: "status", text: "已中断" }],
          });
        }
        return push(cleaned, {
          id: nextId("m"),
          role: "assistant",
          blocks: [{ id: nextId("b"), kind: "status", text: "已中断" }],
          streaming: false,
        });
      }
      if (hasPending(state)) {
        // 占位仍在 = 无任何真实输出 → 空响应错误。
        return push(removePending(state), {
          id: nextId("m"),
          role: "assistant",
          blocks: [{ id: nextId("b"), kind: "error", text: EMPTY_RESPONSE_MESSAGE }],
          streaming: false,
        });
      }
      return finalizeStreaming(state);
    }

    case "tool": {
      if (!acceptsConversation(state, event)) return state;
      if (event.phase === "prepare") {
        // 所有工具都产出流内块：写入/标签工具走完整 action 卡（detail 由
        // permission://request 填充），只读工具（read/ls/find/grep/list_tags）
        // 走紧凑行（无 detail/requestId → action-card 渲染 header-only）。
        const { state: s, msg } = ensureStreaming(state);
        const action: ActionBlock = {
          id: nextId("b"),
          kind: "action",
          callId: event.callId,
          tool: event.name,
          ...(event.category ? { category: event.category } : {}),
          label: event.label,
          targets: [],
          decision: "pending",
          execution: "running",
        };
        return updateLast(s, {
          ...msg,
          blocks: appendProcessItem(msg.blocks, action),
        });
      }
      if (event.phase === "start") {
        // toolcall_start 已经创建语义占位，执行实际开始时以同一 callId
        // 原位补充分类和目标信息，避免详细模式中出现两个工具行。
        const upgraded = updateAction(state, (b) => b.callId === event.callId && b.execution === "running", (b) => ({
          ...b,
          ...(event.category ? { category: event.category } : {}),
          ...(event.label ? { label: event.label } : {}),
        }));
        if (upgraded !== state) return upgraded;
        const { state: s, msg } = ensureStreaming(state);
        const action: ActionBlock = {
          id: nextId("b"),
          kind: "action",
          callId: event.callId,
          tool: event.name,
          ...(event.category ? { category: event.category } : {}),
          label: event.label,
          targets: [],
          decision: "pending",
          execution: "running",
        };
        return updateLast(s, {
          ...msg,
          blocks: appendProcessItem(msg.blocks, action),
        });
      }
      return updateAction(state, (b) => (event.callId ? b.callId === event.callId : b.tool === event.name && b.execution === "running") && b.execution !== "rejected", (b) => ({
        ...b,
        execution: event.isError ? "failed" : "succeeded",
        ...(event.isError && event.error ? { resultSummary: event.error } : {}),
      }));
    }

    case "error": {
      if (!acceptsConversation(state, event)) return state;
      const cleaned = finalizeStreaming(removePending(state));
      const last = cleaned.messages[cleaned.messages.length - 1];
      // 有内容的 assistant 消息：错误作为兄弟块追加；否则单开一条错误消息。
      if (last && last.role === "assistant" && last.blocks.length > 0 && !last.streaming) {
        return updateLast(cleaned, {
          ...last,
          blocks: [...last.blocks, { id: nextId("b"), kind: "error", text: event.message }],
        });
      }
      return push(cleaned, {
        id: nextId("m"),
        role: "assistant",
        blocks: [{ id: nextId("b"), kind: "error", text: event.message }],
        streaming: false,
      });
    }

    case "permission_request": {
      if (!acceptsConversation(state, event)) return state;
      return fillActionBlock(state, event);
    }

    case "permission_resolve": {
      return updateAction(state, (b) => b.requestId === event.requestId, (b) => ({
        ...b,
        decision: event.decision === "allow" ? "allowed" : "denied",
        ...(event.decision === "deny" ? { execution: "rejected" as const } : {}),
        permissionError: undefined,
      }));
    }

    case "permission_resolve_failed":
      return updateAction(state, (b) => b.requestId === event.requestId, (b) => ({
        ...b,
        decision: "pending",
        permissionError: event.message,
      }));

    case "thinking_toggle": {
      // 翻转指定 thinking 块的 collapsed（在任意 assistant 消息中查找）。
      const messages = state.messages.map((m) => {
        if (m.role !== "assistant") return m;
        let touched = false;
        const blocks = m.blocks.map((b) => {
          if (b.kind === "thinking" && b.id === event.blockId) {
            touched = true;
            return { ...b, collapsed: !b.collapsed };
          }
          if (b.kind === "process_group") {
            let groupTouched = false;
            const items = b.items.map((item) => {
              if (item.kind !== "thinking" || item.id !== event.blockId) return item;
              touched = true;
              groupTouched = true;
              return { ...item, collapsed: !item.collapsed };
            });
            return groupTouched ? { ...b, items } : b;
          }
          return b;
        });
        return touched ? { ...m, blocks } : m;
      });
      return { ...state, messages };
    }

    case "process_toggle":
      return {
        ...state,
        messages: state.messages.map((message) => message.role === "assistant"
          ? { ...message, blocks: message.blocks.map((block) =>
            block.kind === "process_group" && block.id === event.blockId
              ? { ...block, collapsed: event.collapsed }
              : block) }
          : message),
      };
  }
}

function push(state: ChatState, message: ChatMessage): ChatState {
  return { ...state, messages: [...state.messages, message] };
}

/** 替换末位消息（不变更入参）。 */
function updateLast(state: ChatState, message: ChatMessage): ChatState {
  const messages = state.messages.slice(0, -1);
  messages.push(message);
  return { ...state, messages };
}

/** 取得当前流式 assistant 消息；若无（或仅占位）则移除占位并新建一条空流式消息。 */
function ensureStreaming(state: ChatState): { state: ChatState; msg: Extract<ChatMessage, { role: "assistant" }> } {
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "assistant" && last.streaming && !last.pending) {
    return { state, msg: last };
  }
  const cleaned = removePending(state);
  const msg: Extract<ChatMessage, { role: "assistant" }> = { id: nextId("m"), role: "assistant", blocks: [], streaming: true };
  return { state: push(cleaned, msg), msg };
}

/** 收尾当前正在流的 assistant 消息（若有）。 */
function finalizeStreaming(state: ChatState): ChatState {
  const last = state.messages[state.messages.length - 1];
  if (last && last.role === "assistant" && last.streaming) {
    const finishItem = (item: ProcessItem): ProcessItem => item.kind === "thinking"
      ? { ...item, done: true }
      : item.execution === "running" ? { ...item, execution: "incomplete" } : item;
    const blocks = last.blocks.map((block): Block => {
      if (block.kind === "text") return { ...block, streaming: false };
      if (block.kind === "thinking" || block.kind === "action") return finishItem(block);
      if (block.kind === "process_group") return { ...block, items: block.items.map(finishItem) };
      return block;
    });
    return updateLast(state, { ...last, blocks, streaming: false });
  }
  return state;
}

function removePending(state: ChatState): ChatState {
  const index = lastIndex(state.messages, (m) => m.role === "assistant" && Boolean(m.pending));
  if (index < 0) return state;
  const messages = state.messages.slice();
  messages.splice(index, 1);
  return { ...state, messages };
}

function hasPending(state: ChatState): boolean {
  return state.messages.some((m) => m.role === "assistant" && Boolean(m.pending));
}

function removeConfigurationErrors(state: ChatState): ChatState {
  const messages = state.messages.flatMap((message): ChatMessage[] => {
    if (message.role !== "assistant") return [message];
    const blocks = message.blocks.filter((block) => !(
      block.kind === "error" && (
        block.text === "agent not configured" ||
        block.text.includes("尚未配置或启用 AI 提供商")
      )
    ));
    return blocks.length > 0 ? [{ ...message, blocks }] : [];
  });
  return { ...state, messages };
}

/**
 * 填充最近一个同 tool 的 pending action block（detail/old/new/canSnapshot/requestId）。
 * 匹配规则：从末位 assistant 消息倒序找首个 `kind==="action" && status==="pending" && tool===toolName && requestId==null`。
 * 找不到则忽略（dock 固定弹窗作为兜底会处理）。
 */
function fillActionBlock(state: ChatState, event: Extract<ChatEvent, { type: "permission_request" }>): ChatState {
  // 交互确认仅显示在 dock 气泡中。对话流只保存关联键，以便把用户裁决
  // 映射回正确的工具行；预览数据仍不进入聊天流。
  if (!event.callId) return state;
  return updateAction(
    state,
    (block) => block.callId === event.callId && block.execution === "running" && !block.requestId,
    (block) => ({ ...block, requestId: event.requestId }),
  );
}

/**
 * 修改最后一个满足 `pred(status)`（且可选 `where`）的 action block 的 status。
 * 用于 tool_end（→ done）与 permission_resolve（→ approved/rejected）。
 */
function updateAction(
  state: ChatState,
  where: (b: Extract<Block, { kind: "action" }>) => boolean,
  update: (b: Extract<Block, { kind: "action" }>) => Extract<Block, { kind: "action" }>,
): ChatState {
  const messages = state.messages.slice();
  for (let mi = messages.length - 1; mi >= 0; mi--) {
    const message = messages[mi];
    if (message.role !== "assistant") continue;
    const blocks = message.blocks.slice();
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b.kind === "action" && where(b)) {
        blocks[i] = update(b);
        messages[mi] = { ...message, blocks };
        return { ...state, messages };
      }
      if (b.kind === "process_group") {
        const itemIndex = b.items.findIndex((item) => item.kind === "action" && where(item));
        if (itemIndex >= 0) {
          const items = b.items.slice();
          const action = items[itemIndex];
          if (action.kind !== "action") continue;
          items[itemIndex] = update(action);
          blocks[i] = { ...b, items };
          messages[mi] = { ...message, blocks };
          return { ...state, messages };
        }
      }
    }
  }
  return state;
}

function appendProcessItem(blocks: Block[], item: ProcessItem): Block[] {
  const out = blocks.slice();
  const last = out[out.length - 1];
  if (last?.kind === "process_group") {
    out[out.length - 1] = { ...last, items: [...last.items, item] };
    return out;
  }
  if (last && isProcessItem(last)) {
    out[out.length - 1] = { id: last.id, kind: "process_group", collapsed: true, items: [last, item] };
    return out;
  }
  return [...out, item];
}

function isProcessItem(block: Block): block is ProcessItem {
  return block.kind === "thinking" || block.kind === "action";
}

function updateLastThinking(blocks: Block[], update: (thinking: ThinkingBlock) => ThinkingBlock): boolean {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index];
    if (block.kind === "thinking" && !block.done) {
      blocks[index] = update(block);
      return true;
    }
    if (block.kind === "process_group") {
      for (let itemIndex = block.items.length - 1; itemIndex >= 0; itemIndex--) {
        const item = block.items[itemIndex];
        if (item.kind !== "thinking" || item.done) continue;
        const items = block.items.slice();
        items[itemIndex] = update(item);
        blocks[index] = { ...block, items };
        return true;
      }
    }
  }
  return false;
}

function acceptsConversation(state: ChatState, event: { conversationId?: string }): boolean {
  if (!state.activeConversationId || !event.conversationId) return true;
  return state.activeConversationId === event.conversationId;
}

function displayMessageToChatMessage(message: ChatDisplayMessage): ChatMessage | null {
  switch (message.role) {
    case "user":
      return {
        id: nextId("m"),
        role: "user",
        text: message.text,
        ...(message.entryId ? { sessionEntryId: message.entryId } : {}),
      };
    case "assistant":
      {
        const displayBlocks = message.blocks ?? (message.text ? [{ type: "text" as const, text: message.text }] : []);
        const blocks = displayBlocks.reduce<Block[]>((items, block) => {
          if (block.type === "text") return [...items, { id: nextId("b"), kind: "text", text: block.text, streaming: false }];
          if (block.type === "thinking") return appendProcessItem(items, { id: nextId("b"), kind: "thinking", text: block.text, collapsed: true, done: true });
          return appendProcessItem(items, {
            id: nextId("b"),
            kind: "action",
            callId: block.callId,
            tool: block.name,
            ...(block.category ? { category: block.category } : {}),
            label: block.label,
            targets: [],
            decision: "pending",
            execution: block.status,
            ...(block.error ? { resultSummary: block.error } : {}),
          });
        }, []);
      return {
        id: nextId("m"),
        role: "assistant",
        blocks,
        streaming: false,
      };
      }
    case "error":
      return {
        id: nextId("m"),
        role: "assistant",
        blocks: [{ id: nextId("b"), kind: "error", text: message.text }],
        streaming: false,
      };
  }
}

function lastIndex<T>(items: T[], pred: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i--) {
    if (pred(items[i])) return i;
  }
  return -1;
}
