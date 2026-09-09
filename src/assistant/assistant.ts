import type { UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AgentEvent } from "../platform/agent";
import type { ChatConversation, ChatScope } from "../platform/chat-history";
import { deriveTitleFromFirstMessage, formatHistoryTime } from "../platform/chat-history-format";
import socratesSvg from "../assets/socrates.svg?raw";
import { mountPermissionBubble, type PermissionRequest } from "./permission-bubble.js";
import { projectPermission } from "./permission-model.js";
import type { SkillSummary } from "./skill-picker.js";
import type { MentionFile } from "./mention-picker.js";
import { mountComposer, type ComposerHandle } from "./input/structured-composer";
import { composePromptPayload, type PromptPayload } from "./input/submit";
import {
  type ChatEvent,
  type ChatState,
  emptyChat,
  isChatStreaming,
  reduceEvents,
} from "./render";
import { beginUserMessageEdit, reconcileMessages } from "./blocks";
import { createButton } from "../shared/ui/button";
import { showToast } from "../shared/toast";
import type { AiReadiness } from "../platform/ai-readiness";
import { openAiSettings } from "../platform/ai-readiness";
import type { AssistantOutputMode } from "../platform/assistant-output";

/**
 * 与挂载点无关的助手组件。挂在笔记窗内的 `#assistant-region`，inline/floating 共用同一份。
 *
 * 依赖经 `deps` 注入（发送 / 订阅），故组件本身不直接依赖 Tauri，便于测试与复用。
 * 状态用 render.ts 的纯 reducer 维护；DOM 只是状态的薄投影。
 */
export interface AssistantDeps {
  /** 发送一条用户消息给 tutor，返回 requestId（用于取消）。 */
  send: (payload: PromptPayload, conversationId: string) => Promise<string>;
  /** Rewind the persistent session before a user turn, so the next send forms a new branch. */
  rewind: (conversationId: string, userEntryId: string) => Promise<void>;
  createConversation: (scope: ChatScope) => Promise<ChatConversation>;
  rollbackConversation: (conversation: ChatConversation) => Promise<void>;
  openConversation: (conversation: ChatConversation) => Promise<ChatConversation | null | void>;
  listConversations: (scope: ChatScope) => Promise<ChatConversation[]>;
  getLastConversation: (scope: ChatScope) => Promise<ChatConversation | null>;
  updateTitle: (
    conversationId: string,
    title: string,
    titleState: ChatConversation["titleState"],
  ) => Promise<ChatConversation | null>;
  /** 订阅 agent 流式事件；返回取消订阅句柄。 */
  subscribe: (cb: (event: AgentEvent) => void) => UnlistenFn | Promise<UnlistenFn>;
  /** 取消进行中的请求（经 stdin 发 Cancel）。无活动请求时 no-op。 */
  cancel?: (requestId: string) => void;
  /** 拉取已加载 skill 列表（供 picker 右键菜单与 `/` 自动补全）。 */
  listSkills: () => Promise<SkillSummary[]>;
  /** 拉取当前作用域内全部文件（供 `@` 文件提及）：project 模式为项目内全部 .md，
   *  document 模式为当前文档。 */
  listFiles: (scope: ChatScope) => Promise<MentionFile[]>;
  getOutputMode?: () => Promise<AssistantOutputMode>;
  subscribeOutputMode?: (callback: (mode: AssistantOutputMode) => void) => UnlistenFn | Promise<UnlistenFn>;
  getReadiness?: () => Promise<AiReadiness>;
  retryConfiguration?: () => Promise<AiReadiness>;
  openSettings?: () => Promise<void>;
}

export interface AssistantHandle {
  destroy: () => void;
  setScope: (scope: ChatScope | null) => void;
  openConversation: (conversation: ChatConversation) => Promise<void>;
  showError: (message: string) => void;
  /** 展开/收起输入气泡。 */
  setInputOpen: (open: boolean) => void;
  /** 输入气泡是否展开。 */
  isInputOpen: () => boolean;
  /** AI 是否正在流式输出。 */
  isStreaming: () => boolean;
  /** 取消进行中的 AI 回复（焦点在助手区且流式时由 Esc 调用）。 */
  cancel: () => void;
  /** 开始新对话（连带展开气泡）。 */
  startNewConversation: () => void;
  /** Create an isolated conversation, render its first user turn, and resolve once the agent accepts it. */
  startConversationWithPrompt: (
    scope: ChatScope,
    prompt: string,
  ) => Promise<{ conversation: ChatConversation; requestId: string }>;
  /** 配置恢复后重新打开当前对话。 */
  refreshConversation: () => Promise<void>;
  /** 历史浮层是否打开。 */
  isHistoryPopoverOpen: () => boolean;
  /** 关闭历史浮层。 */
  closeHistoryPopover: () => void;
  /** 权限气泡是否打开（等待用户允许/拒绝）。 */
  isPermissionBubbleOpen: () => boolean;
  /** 拒绝当前权限请求并关闭气泡（Esc 最高优先级）。 */
  closePermissionBubble: () => void;
  /** skill 菜单/下拉是否打开（右键小人或输入框 `/` 触发）。 */
  isSkillMenuOpen: () => boolean;
  /** 关闭 skill 菜单/下拉（Esc 链中优先于历史浮层）。 */
  closeSkillMenu: () => void;
  /** `@` 文件提及下拉是否打开。 */
  isMentionMenuOpen: () => boolean;
  /** 关闭 `@` 文件提及下拉（Esc 链中置于 skill 菜单之后、历史浮层之前）。 */
  closeMentionMenu: () => void;
  refreshReadiness: () => Promise<void>;
  setReadinessPreview: (value: AiReadiness | null) => void;
}

export function mountAssistant(root: HTMLElement, deps: AssistantDeps): AssistantHandle {
  let state: ChatState = emptyChat();
  let outputMode: AssistantOutputMode = "compact";
  let readiness: AiReadiness | null = deps.getReadiness ? null : { status: "ready" };
  let readinessPreview: AiReadiness | null = null;
  let readinessRevision = 0;
  let setupDismissed = false;
  let setupNotice = "";
  let destroyed = false;
  const displayReadiness = () => readinessPreview ?? readiness;
  const setupVisible = () => displayReadiness()?.status !== "ready" && !setupDismissed;
  let suggestionsExpanded = true;
  let composerEmpty = true;

  root.classList.add("assistant");
  const newConversationButton = createButton({
    variant: "secondary",
    icon: "ph-plus",
    iconOnly: true,
    label: "新对话",
    title: "新对话",
  });
  newConversationButton.classList.add("assistant-new");
  const historyButton = createButton({
    variant: "primary",
    icon: "ph-clock-counter-clockwise",
    iconOnly: true,
    label: "查看项目对话历史",
    title: "查看项目对话历史",
  });
  historyButton.classList.add("assistant-send");
  root.innerHTML = `
    <div class="assistant-card">
      ${newConversationButton.outerHTML}
      <div class="assistant-scroll"></div>
      <button class="assistant-scroll-bottom" type="button" aria-label="回到底部" title="回到底部" hidden><i class="ph ph-arrow-down"></i></button>
    </div>
    <div class="assistant-dock">
      <button class="assistant-bot" type="button" aria-label="展开输入框">${socratesSvg}</button>
      <div class="fn-popover assistant-history-popover" hidden></div>
      <div class="assistant-perm-region"></div>
      <div class="assistant-input-wrap">
        <div class="assistant-input-host"></div>
        <button class="assistant-expand" type="button" aria-label="展开输入框" title="输入达到最大高度后可展开" disabled><i class="ph ph-arrows-out"></i></button>
        ${historyButton.outerHTML}
      </div>
    </div>
  `;

  const scroll = root.querySelector<HTMLElement>(".assistant-scroll")!;
  const scrollBottomBtn = root.querySelector<HTMLButtonElement>(".assistant-scroll-bottom")!;
  const newBtn = root.querySelector<HTMLButtonElement>(".assistant-new")!;
  const bot = root.querySelector<HTMLButtonElement>(".assistant-bot")!;
  const inputWrap = root.querySelector<HTMLElement>(".assistant-input-wrap")!;
  const inputHost = root.querySelector<HTMLElement>(".assistant-input-host")!;
  const expandBtn = root.querySelector<HTMLButtonElement>(".assistant-expand")!;
  const sendBtn = root.querySelector<HTMLButtonElement>(".assistant-send")!;
  const historyPopover = root.querySelector<HTMLElement>(".assistant-history-popover")!;
  const permRegion = root.querySelector<HTMLElement>(".assistant-perm-region")!;
  let currentScope: ChatScope | null = null;
  let activeConversation: ChatConversation | null = null;
  let scopeToken = 0;
  let conversationToken = 0;
  // 消息节点复用表（增量渲染，消灭闪烁）。会话切换时由 reconcile 的 stale 清理自动清空。
  const msgMap = new Map<string, HTMLElement>();
  const BOTTOM_EPSILON_PX = 4;
  let followingBottom = true;

  function isAtBottom(): boolean {
    return scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight <= BOTTOM_EPSILON_PX;
  }

  function updateBottomFollowing(): void {
    followingBottom = isAtBottom();
    scrollBottomBtn.hidden = followingBottom;
  }

  function resumeBottomFollowing(): void {
    followingBottom = true;
    scroll.scrollTop = scroll.scrollHeight;
    scrollBottomBtn.hidden = true;
  }

  scroll.addEventListener("scroll", updateBottomFollowing, { passive: true });
  scrollBottomBtn.addEventListener("click", resumeBottomFollowing);

  function rerender() {
    // 定向增量更新：已完成消息/块节点复用，不重放进场动画 → 消灭闪烁。
    reconcileMessages(scroll, state.messages, msgMap, outputMode, followingBottom);
    scroll.querySelector(".assistant-empty")?.remove();
    const hasMessages = state.messages.length > 0;
    if (setupVisible()) scroll.append(renderEmptyAssistant());
    else if (!hasMessages && composerEmpty && displayReadiness()?.status === "ready") scroll.append(renderEmptyAssistant());
    const closesSetup = setupVisible() && !hasMessages;
    newBtn.setAttribute("aria-label", closesSetup ? "关闭配置提示" : "新对话");
    newBtn.title = closesSetup ? "关闭配置提示" : "新对话";
    newBtn.innerHTML = `<i class="ph ${closesSetup ? "ph-x" : "ph-plus"}"></i>`;
    newBtn.disabled = isChatStreaming(state);
    // 无消息时不渲染聊天历史容器，避免 floating 态出现空的卡片/气泡（inline 态无副作用）。
    root.classList.toggle("has-messages", scroll.childElementCount > 0);
    for (const action of scroll.querySelectorAll<HTMLButtonElement>(".chat-retry-btn, .chat-edit-btn")) {
      action.disabled = isChatStreaming(state);
    }
    updateSendMode();
  }

  function renderEmptyAssistant(): HTMLElement {
    const empty = document.createElement("section");
    empty.className = "assistant-empty";
    const status = displayReadiness();
    if (status?.status !== "ready") {
      empty.classList.add("assistant-setup");
      empty.setAttribute("role", "status");
      const messages = {
        unconfigured: ["苏格拉底 AI", "它可以读取采集区和作品，帮你追问、整理、规划或共同写作。连接 AI 服务后即可开始使用。", "配置 AI 服务"],
        disabled: ["启用 AI 服务", "你已配置 AI 服务，启用一个服务后即可开始对话。", "前往启用"],
        incomplete: ["检查 AI 服务配置", "当前 AI 服务配置不完整，请检查后继续。", "检查配置"],
        runtime_unavailable: ["AI 服务暂时无法启动", "服务配置已保存，但运行时尚未就绪，请重试或检查设置。", "重试"],
      };
      const copy = status ? messages[status.status] : ["正在检查 AI 服务", "请稍候…", ""];
      empty.innerHTML = `<i class="ph ph-sparkle" aria-hidden="true"></i><h2></h2><p></p>`;
      empty.querySelector("h2")!.textContent = copy[0];
      empty.querySelector("p")!.textContent = copy[1];
      if (state.messages.length) {
        const close = document.createElement("button");
        close.type = "button";
        close.className = "assistant-setup-close";
        close.setAttribute("aria-label", "关闭配置提示");
        close.innerHTML = `<i class="ph ph-x" aria-hidden="true"></i>`;
        close.onclick = dismissSetup;
        empty.append(close);
      }
      const notice = document.createElement("p");
      notice.className = "assistant-setup-notice";
      notice.textContent = setupNotice || (status?.status === "incomplete" ? status.message : "");
      if (notice.textContent) empty.append(notice);
      const addAction = (label: string, action: () => Promise<void>, primary = true) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = primary ? "fn-btn fn-btn--primary" : "fn-btn fn-btn--secondary";
        button.textContent = label;
        button.onclick = async () => {
          button.disabled = true;
          try { await action(); }
          catch { setupNotice = "操作未完成，请重试；输入内容已保留。"; rerender(); }
          finally { button.disabled = false; }
        };
        empty.append(button);
      };
      const openSettings = () => (deps.openSettings ?? openAiSettings)();
      if (status?.status === "runtime_unavailable") {
        addAction(copy[2], async () => { await deps.retryConfiguration?.(); await refreshReadiness(); });
        addAction("检查设置", openSettings, false);
      } else if (status) addAction(copy[2], openSettings);
      else if (setupNotice) addAction("重试", refreshReadiness);
      return empty;
    }
    const heading = document.createElement("button");
    heading.type = "button";
    heading.className = "assistant-starters-toggle";
    heading.textContent = suggestionsExpanded ? "试试这样开始" : "查看提问建议";
    heading.setAttribute("aria-expanded", String(suggestionsExpanded));
    heading.onclick = () => { suggestionsExpanded = !suggestionsExpanded; rerender(); };
    empty.append(heading);
    if (!suggestionsExpanded) return empty;
    const starters = document.createElement("div");
    starters.className = "assistant-starters";
    const add = (label: string, action: () => void) => {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = label;
      item.onclick = action;
      starters.append(item);
    };
    add("结合项目资料梳理观点", () => composer.openFileStarter());
    add("使用一个 AI 技能", () => composer.openSkillPicker());
    add("用追问帮我想清楚", () => composer.fillStarter("请先不要给结论，通过追问帮我想清楚这个问题："));
    const collapse = buttonForCollapse();
    starters.append(collapse);
    empty.append(starters);
    return empty;
  }

  function dismissSetup() {
    setupDismissed = true;
    rerender();
  }

  async function refreshReadiness() {
    const revision = ++readinessRevision;
    try {
      const next = await deps.getReadiness?.() ?? { status: "ready" as const };
      if (destroyed || revision !== readinessRevision) return;
      if (readiness?.status !== next.status) setupDismissed = false;
      readiness = next;
      setupNotice = "";
      rerender();
    } catch {
      if (destroyed || revision !== readinessRevision) return;
      readiness = null;
      setupNotice = "无法读取 AI 服务状态，请重试。";
      rerender();
    }
  }

  async function ensureReady(): Promise<boolean> {
    // Preview affects presentation only; sending always checks the real service.
    await refreshReadiness();
    if (readiness?.status === "ready") return true;
    readinessPreview = null;
    setupDismissed = false;
    setupNotice = readiness ? "内容已保留，完成配置后即可发送。" : "无法读取 AI 服务状态，请重试；输入内容已保留。";
    rerender();
    resumeBottomFollowing();
    return false;
  }

  function buttonForCollapse(): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "assistant-starters-collapse";
    button.textContent = "收起建议";
    button.onclick = () => { suggestionsExpanded = false; rerender(); };
    return button;
  }

  function dispatch(event: ChatEvent) {
    state = reduceEvents(state, event);
    rerender();
  }

  function setActiveConversation(conversation: ChatConversation | null, clearMessages = false) {
    conversationToken += 1;
    activeConversation = conversation;
    root.dataset.conversationId = conversation?.id ?? "";
    if (!conversation) return;
    if (clearMessages) resumeBottomFollowing();
    if (clearMessages) suggestionsExpanded = true;
    state = clearMessages
      ? { activeConversationId: conversation.id, messages: [] }
      : { ...state, activeConversationId: conversation.id };
    if (clearMessages) rerender();
  }

  async function updateConversationTitle(
    conversation: ChatConversation,
    text: string,
  ): Promise<ChatConversation> {
    if (conversation.titleState !== "temporary" || conversation.title !== "新对话") {
      return conversation;
    }
    const derived = deriveTitleFromFirstMessage(text);
    let resolved: ChatConversation;
    try {
      const updated = await deps.updateTitle(conversation.id, derived.title, derived.titleState);
      resolved = updated ?? { ...conversation, ...derived };
    } catch {
      resolved = { ...conversation, ...derived };
    }
    if (activeConversation?.id === conversation.id) activeConversation = resolved;
    return resolved;
  }

  let inputOpen = false;
  let activeRequestId: string | null = null;
  function setInputOpen(open: boolean) {
    if (open && !inputOpen) void refreshReadiness();
    inputOpen = open;
    inputWrap.classList.toggle("open", open);
    // floating 态下，展开/收起整块浮层（聊天历史卡片）由这个类驱动；inline 态无副作用。
    root.classList.toggle("expanded", open);
    // 机器人轻微缩放「应答」，动画结束自动复位。
    bot.classList.remove("nudge");
    void bot.offsetWidth; // 强制重排以重启动画
    bot.classList.add("nudge");
    if (open) setTimeout(() => composer.focus(), 160);
    else (document.activeElement instanceof HTMLElement ? document.activeElement : null)?.blur();
    if (!open) closeHistoryPopover();
  }

  bot.addEventListener("click", () => setInputOpen(!inputOpen));

  function updateSendMode() {
    if (isChatStreaming(state)) {
      sendBtn.setAttribute("aria-label", "停止生成");
      sendBtn.title = "停止生成";
      sendBtn.innerHTML = `<i class="ph ph-stop"></i>`;
      return;
    }
    const payload = composePromptPayload(composer.getDoc());
    const hasContent = payload.userText.trim().length > 0 || payload.references.length > 0;
    const isSend = hasContent || composer.isLarge();
    sendBtn.setAttribute("aria-label", isSend ? "发送" : "查看项目对话历史");
    sendBtn.title = isSend ? "发送" : "查看项目对话历史";
    sendBtn.innerHTML = isSend
      ? `<i class="ph ph-arrow-up"></i>`
      : `<i class="ph ph-clock-counter-clockwise"></i>`;
  }

  function updateExpandState() {
    if (composer.isLarge()) {
      expandBtn.disabled = false;
      expandBtn.title = "关闭聚焦输入";
      expandBtn.setAttribute("aria-label", "关闭聚焦输入");
      expandBtn.innerHTML = `<i class="ph ph-x"></i>`;
      return;
    }
    const available = composer.isHeightLimited();
    expandBtn.disabled = !available;
    expandBtn.title = available ? "展开输入框" : "输入达到最大高度后可展开";
    expandBtn.setAttribute("aria-label", "展开输入框");
    expandBtn.innerHTML = `<i class="ph ph-arrows-out"></i>`;
  }

  async function submit(payload: PromptPayload): Promise<boolean> {
    const text = payload.userText.trim();
    const scope = currentScope;
    if (!scope) {
      dispatch({ type: "error", requestId: null, message: "当前没有打开的项目或文档，请稍后再试" });
      showToast("当前没有打开的项目或文档，输入内容已保留");
      return false;
    }
    const beforeSubmission = state;
    let createdConversation: ChatConversation | null = null;
    const submittedScopeToken = scopeToken;
    let expectedConversationToken = conversationToken;
    const isCurrentSubmission = (conversationId?: string) =>
      scopeToken === submittedScopeToken
      && conversationToken === expectedConversationToken
      && (!conversationId || activeConversation?.id === conversationId);
    try {
      if (!await ensureReady() || !isCurrentSubmission()) return false;
      let conversation = activeConversation;
      if (!conversation) {
        const created = await deps.createConversation(scope);
        if (!isCurrentSubmission()) return false;
        conversation = created;
        createdConversation = created;
        setActiveConversation(conversation);
        expectedConversationToken = conversationToken;
      }
      conversation = await updateConversationTitle(conversation, text);
      if (!isCurrentSubmission(conversation.id)) return false;
      state = { ...state, activeConversationId: conversation.id };
      const requestId = await sendTurn(conversation, payload);
      if (!isCurrentSubmission(conversation.id)) return false;
      activeRequestId = requestId;
      return true;
    } catch (err) {
      if (!isCurrentSubmission()) return false;
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("尚未配置或启用 AI 提供商") || message.includes("尚未启用 AI 提供商") || message === "agent not configured") {
        await ensureReady();
        if (!isCurrentSubmission()) return false;
        if (createdConversation) {
          try { await deps.rollbackConversation(createdConversation); } catch { /* best-effort compensation */ }
          if (!isCurrentSubmission()) return false;
          setActiveConversation(null);
        }
        state = beforeSubmission;
        rerender();
        return false;
      }
      dispatch({
        type: "error",
        requestId: null,
        conversationId: activeConversation?.id,
        message,
      });
      showToast("发送失败，输入内容已保留");
      return false;
    }
  }

  async function sendTurn(
    conversation: ChatConversation,
    payload: PromptPayload,
    options: { resend?: boolean } = {},
  ): Promise<string> {
    const text = payload.userText.trim();
    if (!options.resend) {
      resumeBottomFollowing();
      dispatch({ type: "user", conversationId: conversation.id, text, references: payload.references });
    }
    dispatch({ type: "pending", conversationId: conversation.id });
    const requestId = await deps.send({ ...payload, userText: text }, conversation.id);
    return requestId;
  }

  async function resendUserMessage(messageId: string, text: string, references: PromptPayload["references"]): Promise<void> {
    if (!activeConversation || isChatStreaming(state)) return;
    const token = conversationToken;
    try {
      if (!await ensureReady() || token !== conversationToken || !activeConversation) return;
      const messageIndex = state.messages.findIndex(
        (entry) => entry.role === "user" && entry.id === messageId,
      );
      if (messageIndex < 0) return;
      const target = state.messages[messageIndex];
      if (target.role !== "user" || !target.sessionEntryId) {
        throw new Error("该回合尚未同步到对话历史，请稍候再试");
      }
      const conversation = await updateConversationTitle(activeConversation, text.trim());
      await deps.rewind(conversation.id, target.sessionEntryId);
      dispatch({ type: "user_rewind", messageId, text: text.trim() });
      activeRequestId = await sendTurn(
        conversation,
        { userText: text, references },
        { resend: true },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dispatch({ type: "error", requestId: null, conversationId: activeConversation?.id, message });
      showToast("发送失败，消息内容已保留");
    }
  }

  async function startNewConversation() {
    if (!currentScope || isChatStreaming(state)) return;
    ++scopeToken;
    closeHistoryPopover();
    setActiveConversation(null);
    state = emptyChat();
    suggestionsExpanded = true;
    setupDismissed = false;
    rerender();
    setInputOpen(true);
    await refreshReadiness();
  }

  async function startConversationWithPrompt(
    scope: ChatScope,
    prompt: string,
  ): Promise<{ conversation: ChatConversation; requestId: string }> {
    if (!await ensureReady()) throw new Error("请先配置并启用 AI 服务，内容尚未发送");
    const previousConversation = activeConversation;
    const previousState = state;
    let created: ChatConversation | null = null;
    try {
      created = await deps.createConversation(scope);
      setActiveConversation(created, true);
      created = await updateConversationTitle(created, prompt.trim());
      setInputOpen(true);
      const requestId = await sendTurn(created, { userText: prompt, references: [] });
      activeRequestId = requestId;
      return { conversation: created, requestId };
    } catch (error) {
      if (created) {
        try { await deps.rollbackConversation(created); } catch { /* best-effort compensation */ }
      }
      conversationToken += 1;
      activeConversation = previousConversation;
      root.dataset.conversationId = previousConversation?.id ?? "";
      state = previousState;
      rerender();
      throw error;
    }
  }

  async function toggleHistoryPopover() {
    if (!historyPopover.hidden) {
      closeHistoryPopover();
      return;
    }
    const scope = currentScope;
    if (!scope) return;
    historyPopover.hidden = false;
    historyPopover.textContent = "载入中…";
    try {
      renderHistory(await deps.listConversations(scope), scope);
    } catch (err) {
      historyPopover.textContent = err instanceof Error ? err.message : String(err);
    }
  }

  function closeHistoryPopover() {
    historyPopover.hidden = true;
    historyPopover.replaceChildren();
  }

  function renderHistory(conversations: ChatConversation[], scope: ChatScope) {
    void scope;
    historyPopover.replaceChildren();
    if (conversations.length === 0) {
      const empty = document.createElement("div");
      empty.className = "assistant-history-empty";
      empty.textContent = "当前范围还没有对话";
      historyPopover.appendChild(empty);
      return;
    }
    for (const conversation of conversations) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "assistant-history-item";
      const title = document.createElement("span");
      title.className = "assistant-history-title";
      title.textContent = conversation.title;
      const meta = document.createElement("span");
      meta.className = "assistant-history-meta";
      meta.textContent = formatHistoryTime(conversation.updatedAt);
      item.append(title, meta);
      item.addEventListener("click", () => {
        void openConversation(conversation);
      });
      historyPopover.appendChild(item);
    }
  }

  async function openConversation(conversation: ChatConversation) {
    scopeToken += 1;
    closeHistoryPopover();
    setActiveConversation(conversation, true);
    setInputOpen(true);
    try {
      await deps.openConversation(conversation);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dispatch({ type: "error", requestId: null, conversationId: conversation.id, message });
    }
  }

  const composer: ComposerHandle = mountComposer({
    editorHost: inputHost,
    wrapHost: inputWrap,
    getDockHost: () => root.querySelector<HTMLElement>(".assistant-dock") ?? root,
    placeholder: "说点什么…",
    getScope: () => currentScope,
    listFiles: deps.listFiles,
    listSkills: deps.listSkills,
    onSubmit: submit,
    onEmptySend: () => { void toggleHistoryPopover(); },
    onChange: (empty) => {
      composerEmpty = empty;
      updateSendMode();
      updateExpandState();
      // CM6 的高度可能在 update listener 之后才由浏览器完成布局；下一帧复测，
      // 确保刚达到上限时放大按钮立即出现。
      requestAnimationFrame(updateExpandState);
      queueMicrotask(rerender);
    },
    onLargeChange: () => {
      updateSendMode();
      updateExpandState();
    },
  });
  sendBtn.addEventListener("click", () => {
    if (isChatStreaming(state)) {
      if (activeRequestId) deps.cancel?.(activeRequestId);
      return;
    }
    composer.submit();
  });
  expandBtn.addEventListener("click", () => {
    if (composer.isLarge()) composer.collapseLarge();
    else composer.expandLarge();
    updateExpandState();
  });
  newBtn.addEventListener("click", () => {
    if (setupVisible() && !state.messages.length) dismissSetup();
    else void startNewConversation();
  });

  function onDocumentPointerDown(e: PointerEvent) {
    if (historyPopover.hidden) return;
    const target = e.target;
    if (target instanceof Node && root.contains(target)) return;
    closeHistoryPopover();
  }

  document.addEventListener("pointerdown", onDocumentPointerDown);

  rerender();
  void refreshReadiness();
  updateSendMode();
  updateExpandState();

  let unlisten: UnlistenFn | null = null;
  let outputModeUnlisten: UnlistenFn | null = null;
  let outputModeRevision = 0;

  const loadInitialOutputMode = () => {
    const revision = outputModeRevision;
    void deps.getOutputMode?.().then((mode) => {
      if (destroyed || revision !== outputModeRevision) return;
      outputMode = mode;
      rerender();
    }).catch(() => {});
  };
  if (!deps.subscribeOutputMode) {
    loadInitialOutputMode();
  } else {
    void Promise.resolve(deps.subscribeOutputMode((mode) => {
      outputModeRevision += 1;
      outputMode = mode;
      rerender();
    })).then((unlistenMode) => {
      if (destroyed) {
        unlistenMode();
        return;
      }
      outputModeUnlisten = unlistenMode;
      loadInitialOutputMode();
    });
  }

  const permBubble = mountPermissionBubble(permRegion, (req, decision, writeMode) => {
    return resolvePermission(req.request_id, decision, writeMode);
  }, () => {
    showToast("写入失败，请重试");
  });
  bot.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    setInputOpen(true);
    composer.openSkillPicker();
  });

  /** 统一的 permission resolve 入口：派发 reducer 状态 + 调 Rust + 清 dock 兜底气泡。
   *  流内 action 卡与 dock 兜底气泡共用，以 requestId 为幂等键。 */
  function resolvePermission(
    requestId: string,
    decision: "allow" | "deny",
    writeMode: "direct" | "snapshot",
  ): Promise<void> {
    dispatch({ type: "permission_resolve", requestId, decision });
    return invoke("resolve_permission", { requestId, decision, writeMode }).then(() => {
      permBubble.clear(requestId);
    }).catch((err) => {
      dispatch({ type: "permission_resolve_failed", requestId, message: err instanceof Error ? err.message : String(err) });
      throw err;
    });
  }

  // 流内 action 卡的允许/拒绝按钮派发 chat:resolve（bubbles），在此统一处理。
  scroll.addEventListener("chat:resolve", (e) => {
    const detail = (e as CustomEvent).detail as {
      requestId: string;
      decision: "allow" | "deny";
      writeMode: "direct" | "snapshot";
    };
    void resolvePermission(detail.requestId, detail.decision, detail.writeMode).catch(() => {});
  });

  // thinking 块折叠/展开切换。
  scroll.addEventListener("chat:toggle-thinking", (e) => {
    const detail = (e as CustomEvent).detail as { blockId: string };
    dispatch({ type: "thinking_toggle", blockId: detail.blockId });
  });
  scroll.addEventListener("chat:toggle-process", (e) => {
    const detail = (e as CustomEvent).detail as { blockId: string; collapsed: boolean };
    dispatch({ type: "process_toggle", blockId: detail.blockId, collapsed: detail.collapsed });
  });

  scroll.addEventListener("chat:user-retry", (e) => {
    const { messageId } = (e as CustomEvent<{ messageId: string }>).detail;
    const message = state.messages.find((entry) => entry.role === "user" && entry.id === messageId);
    if (message?.role === "user") void resendUserMessage(message.id, message.text, message.references ?? []);
  });

  scroll.addEventListener("chat:user-edit", (e) => {
    if (isChatStreaming(state)) return;
    const { messageId } = (e as CustomEvent<{ messageId: string }>).detail;
    const message = state.messages.find((entry) => entry.role === "user" && entry.id === messageId);
    const node = msgMap.get(messageId);
    if (message?.role === "user" && node) beginUserMessageEdit(node, message.id, message.text);
  });

  scroll.addEventListener("chat:user-edit-send", (e) => {
    const { messageId, text } = (e as CustomEvent<{ messageId: string; text: string }>).detail;
    const message = state.messages.find((entry) => entry.role === "user" && entry.id === messageId);
    if (message?.role === "user") void resendUserMessage(messageId, text, message.references ?? []);
  });

  // permission://request：对话内 action 行保持只读，审批始终由 dock 卡片承担。
  let permUnlisten: UnlistenFn | null = null;
  listen<PermissionRequest>("permission://request", (e) => {
    const req = e.payload;
    dispatch({
      type: "permission_request",
      requestId: req.request_id,
      callId: req.tool_call_id,
      conversationId: req.conversation_id,
      toolName: req.tool_name,
      detail: req.preview.detail,
      summary: req.preview.summary,
      oldContent: req.old_content,
      newContent: req.new_content,
      canSnapshot: projectPermission(req).canSnapshot,
    });
    permBubble.show(req);
  }).then((un) => {
    if (destroyed) un();
    else permUnlisten = un;
  });

  Promise.resolve(deps.subscribe((event) => {
    if (event.type === "session_opened") {
      if (!activeConversation || activeConversation.id !== event.conversationId) return;
      state = reduceEvents(state, event);
      rerender();
      return;
    }
    if (event.type === "session_synced") {
      state = reduceEvents(state, event);
      rerender();
      return;
    }
    if (event.type === "title" && activeConversation?.id === event.conversationId) {
      activeConversation = { ...activeConversation, title: event.title, titleState: "final" };
    }
    if (event.type === "delta" || event.type === "tool") {
      activeRequestId = event.requestId;
    } else if (event.type === "done" || event.type === "error") {
      activeRequestId = null;
    }
    dispatch(event);
  })).then((un) => {
    if (destroyed) un();
    else unlisten = un;
  });

  return {
    destroy() {
      destroyed = true;
      unlisten?.();
      outputModeUnlisten?.();
      permUnlisten?.();
      permBubble.destroy();
      composer.destroy();
      document.removeEventListener("pointerdown", onDocumentPointerDown);
      root.classList.remove("assistant");
      root.innerHTML = "";
    },
    setScope(scope: ChatScope | null) {
      currentScope = scope;
      composer.setScope(scope);
      setActiveConversation(null);
      closeHistoryPopover();
      resumeBottomFollowing();
      state = emptyChat();
      suggestionsExpanded = true;
      rerender();
      const token = ++scopeToken;
      if (!scope) return;
      void deps.getLastConversation(scope)
        .then(async (conversation) => {
          if (token !== scopeToken) return;
          if (!conversation) return;
          setActiveConversation(conversation);
          await deps.openConversation(conversation);
        })
        .catch((err) => {
          if (token !== scopeToken) return;
          const message = err instanceof Error ? err.message : String(err);
          dispatch({ type: "error", requestId: null, message });
        });
    },
    openConversation,
    showError(message: string) {
      dispatch({ type: "error", requestId: null, message });
    },
    setInputOpen,
    isInputOpen() {
      return inputOpen;
    },
    isStreaming() {
      return isChatStreaming(state);
    },
    cancel() {
      if (activeRequestId) deps.cancel?.(activeRequestId);
    },
    startNewConversation() {
      void startNewConversation();
    },
    startConversationWithPrompt,
    async refreshConversation() {
      if (!activeConversation) return;
      const conversation = activeConversation;
      const token = conversationToken;
      try {
        await deps.openConversation(conversation);
      } catch (err) {
        if (token !== conversationToken || activeConversation?.id !== conversation.id) return;
        dispatch({
          type: "error",
          requestId: null,
          conversationId: conversation.id,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    },
    isHistoryPopoverOpen() {
      return !historyPopover.hidden;
    },
    closeHistoryPopover,
    isPermissionBubbleOpen() {
      return permBubble.isOpen();
    },
    closePermissionBubble() {
      permBubble.reject();
    },
    isSkillMenuOpen() {
      return composer.isPopoverOpen();
    },
    closeSkillMenu() {
      composer.closePopover();
    },
    isMentionMenuOpen() {
      return false;
    },
    closeMentionMenu() {
      composer.closePopover();
    },
    refreshReadiness,
    setReadinessPreview(value) {
      readinessPreview = value;
      setupDismissed = false;
      rerender();
      if (!value) void refreshReadiness();
    },
  };
}
