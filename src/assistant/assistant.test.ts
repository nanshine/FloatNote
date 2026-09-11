// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mountAssistant, type AssistantDeps } from "./assistant";
import type { AgentEvent } from "../platform/agent";
import type { ChatConversation } from "../platform/chat-history";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const conversation: ChatConversation = {
  id: "c1", sessionFile: "/notes/.chat.json", scopeType: "project", scopePath: "/notes", scopeLabel: "Notes",
  title: "新对话", titleState: "temporary", createdAt: 0, updatedAt: 0, lastOpenedAt: 0,
};

beforeAll(() => {
  if (!Range.prototype.getClientRects) {
    Range.prototype.getClientRects = () => ({ length: 0, item: () => null, [Symbol.iterator]: function* () {} }) as DOMRectList;
  }
});

async function mountWithDeps(overrides: Partial<AssistantDeps> = {}) {
  const root = document.createElement("div");
  document.body.appendChild(root);
  let emitAgent: (event: AgentEvent) => void = () => {};
  const deps: AssistantDeps = {
    send: vi.fn().mockResolvedValue("r2"),
    rewind: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn(),
    createConversation: vi.fn().mockResolvedValue(conversation),
    rollbackConversation: vi.fn().mockResolvedValue(undefined),
    openConversation: vi.fn().mockResolvedValue(conversation),
    listConversations: vi.fn().mockResolvedValue([]),
    getLastConversation: vi.fn().mockResolvedValue(null),
    updateTitle: vi.fn().mockResolvedValue(conversation),
    subscribe: vi.fn((callback) => { emitAgent = callback; return () => {}; }),
    listSkills: vi.fn().mockResolvedValue([]),
    listFiles: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
  const handle = mountAssistant(root, deps);
  await handle.openConversation(conversation);
  return { root, deps, emitAgent, handle };
}

describe("assistant message actions", () => {
  afterEach(() => document.body.replaceChildren());

  it("waits for the reveal to finish before focusing and cancels focus when closed", async () => {
    const { root, handle } = await mountWithDeps();
    await vi.waitFor(() => expect(root.querySelector(".editor")).not.toBeNull());
    const wrap = root.querySelector<HTMLElement>(".assistant-input-wrap")!;
    const content = root.querySelector<HTMLElement>(".editor")!;
    handle.setInputOpen(false);
    let finish!: () => void;
    const getAnimations = vi.fn(() => [{ finished: new Promise<void>((resolve) => { finish = resolve; }) }]);
    Object.defineProperty(wrap, "getAnimations", { value: getAnimations });
    handle.setInputOpen(true);
    await vi.waitFor(() => expect(getAnimations).toHaveBeenCalledOnce());
    expect(document.activeElement).not.toBe(content);
    finish();
    await vi.waitFor(() => expect(document.activeElement).toBe(content));
    handle.setInputOpen(false);
    handle.setInputOpen(true);
    await vi.waitFor(() => expect(getAnimations).toHaveBeenCalledTimes(2));
    handle.setInputOpen(false);
    finish();
    await Promise.resolve();
    expect(document.activeElement).not.toBe(content);
    handle.destroy();
  });

  it("restores temporarily hidden suggestions when starting a new conversation", async () => {
    const { root, handle } = await mountWithDeps();
    handle.setScope({ scopeType: "project", scopePath: "/notes", scopeLabel: "Notes", cwd: "/notes" });
    root.querySelector<HTMLButtonElement>(".assistant-suggestions-close")!.click();
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>(".assistant-suggestions")!.hidden).toBe(true));
    await handle.refreshReadiness();
    expect(root.querySelector<HTMLElement>(".assistant-suggestions")!.hidden).toBe(true);
    handle.startNewConversation();
    await vi.waitFor(() => expect(root.querySelector<HTMLElement>(".assistant-suggestions")!.hidden).toBe(false));
    handle.destroy();
  });

  it("shows provider setup in an unconfigured empty conversation", async () => {
    const { root } = await mountWithDeps({ getReadiness: async () => ({ status: "unconfigured" }) });
    await vi.waitFor(() => expect(root.querySelector(".assistant-empty")?.textContent).toContain("配置 AI 服务"));
    expect(root.querySelector(".assistant-scroll")?.contains(root.querySelector(".assistant-empty"))).toBe(true);
  });

  it("restores dismissed setup on send, preserves the draft, then sends only after activation", async () => {
    let status: "ready" | "disabled" = "ready";
    const { root, deps, handle } = await mountWithDeps({ getReadiness: async () => ({ status }) });
    handle.setScope({ scopeType: "project", scopePath: "/notes", scopeLabel: "Notes", cwd: "/notes" });
    await vi.waitFor(() => expect(root.querySelector(".assistant-starters")).not.toBeNull());
    [...root.querySelectorAll<HTMLButtonElement>(".assistant-starters button")]
      .find((button) => button.textContent === "通过追问理清思路")!.click();
    await vi.waitFor(() => expect(root.querySelector(".fn-assistant-structured-editor")?.textContent).toContain("请先不要给结论"));
    status = "disabled";
    await handle.refreshReadiness();
    expect(root.querySelector(".assistant-setup")?.textContent).toContain("前往启用");
    root.querySelector<HTMLButtonElement>(".assistant-new")!.click();
    expect(root.querySelector(".assistant-setup")).toBeNull();
    root.querySelector<HTMLButtonElement>(".assistant-send")!.click();
    await vi.waitFor(() => expect(root.querySelector(".assistant-setup")?.textContent).toContain("内容已保留"));
    expect(deps.createConversation).not.toHaveBeenCalled();
    expect(deps.send).not.toHaveBeenCalled();
    expect(root.querySelector(".chat-block-error")).toBeNull();
    expect(root.querySelector(".fn-assistant-structured-editor")?.textContent).toContain("请先不要给结论");
    status = "ready";
    await handle.refreshReadiness();
    expect(root.querySelector(".assistant-setup")).toBeNull();
    expect(deps.send).not.toHaveBeenCalled();
    root.querySelector<HTMLButtonElement>(".assistant-send")!.click();
    await vi.waitFor(() => expect(deps.send).toHaveBeenCalledTimes(1));
    handle.destroy();
  });

  for (const configurationRace of [false, true]) {
    it(configurationRace ? "rolls back a session if the service is disabled during submission" : "keeps network failures as request errors", async () => {
      let status: "ready" | "disabled" = "ready";
      const send = vi.fn(async () => {
        if (configurationRace) status = "disabled";
        throw new Error(configurationRace ? "尚未启用 AI 提供商" : "网络超时");
      });
      const { root, deps, handle } = await mountWithDeps({ getReadiness: async () => ({ status }), send });
      handle.setScope({ scopeType: "project", scopePath: "/notes", scopeLabel: "Notes", cwd: "/notes" });
      await vi.waitFor(() => expect(root.querySelector(".assistant-starters")).not.toBeNull());
      [...root.querySelectorAll<HTMLButtonElement>(".assistant-starters button")]
        .find((button) => button.textContent === "通过追问理清思路")!.click();
      await vi.waitFor(() => expect(root.querySelector(".fn-assistant-structured-editor")?.textContent).toContain("请先不要给结论"));
      root.querySelector<HTMLButtonElement>(".assistant-send")!.click();
      if (configurationRace) {
        await vi.waitFor(() => expect(deps.rollbackConversation).toHaveBeenCalledWith(conversation));
        expect(root.querySelector(".chat-user-message-text")).toBeNull();
        expect(root.querySelector(".chat-block-error")).toBeNull();
        expect(root.querySelector(".assistant-setup")?.textContent).toContain("前往启用");
      } else {
        await vi.waitFor(() => expect(root.querySelector(".chat-block-error")?.textContent).toContain("网络超时"));
        expect(root.querySelector(".assistant-setup")).toBeNull();
      }
      expect(root.querySelector(".fn-assistant-structured-editor")?.textContent).toContain("请先不要给结论");
      handle.destroy();
    });
  }

  it("keeps history visible when disabled and starts a draft without creating a session", async () => {
    const { root, handle, deps, emitAgent } = await mountWithDeps({ getReadiness: async () => ({ status: "disabled" }) });
    handle.setScope({ scopeType: "project", scopePath: "/notes", scopeLabel: "Notes", cwd: "/notes" });
    await handle.openConversation(conversation);
    emitAgent({ type: "session_opened", conversationId: "c1", sessionFile: conversation.sessionFile, messages: [{ role: "user", text: "历史内容", timestamp: 0 }] });
    await handle.refreshReadiness();
    expect(root.querySelector(".chat-user-message-text")?.textContent).toContain("历史内容");
    root.querySelector<HTMLButtonElement>(".assistant-setup-close")!.click();
    expect(root.querySelector(".chat-user-message-text")?.textContent).toContain("历史内容");
    root.querySelector<HTMLButtonElement>(".assistant-new")!.click();
    await vi.waitFor(() => expect(root.querySelector(".assistant-setup")?.textContent).toContain("前往启用"));
    expect(deps.createConversation).not.toHaveBeenCalled();
    expect(root.querySelector(".chat-block-error")).toBeNull();
    handle.destroy();
  });

  it("routes configuration actions and retries local runtime initialization", async () => {
    let status: "runtime_unavailable" | "ready" = "runtime_unavailable";
    const openSettings = vi.fn().mockResolvedValue(undefined);
    const retryConfiguration = vi.fn(async () => { status = "ready"; return { status }; });
    const { root, handle } = await mountWithDeps({ getReadiness: async () => ({ status }), openSettings, retryConfiguration });
    await handle.refreshReadiness();
    [...root.querySelectorAll<HTMLButtonElement>(".assistant-setup button")].find((button) => button.textContent === "检查设置")!.click();
    expect(openSettings).toHaveBeenCalledOnce();
    [...root.querySelectorAll<HTMLButtonElement>(".assistant-setup button")].find((button) => button.textContent === "重试")!.click();
    await vi.waitFor(() => expect(root.querySelector(".assistant-setup")).toBeNull());
    expect(retryConfiguration).toHaveBeenCalledOnce();
    handle.destroy();
  });

  it("fills but does not send a Socratic starter in a configured empty conversation", async () => {
    const send = vi.fn().mockResolvedValue("r2");
    const { root } = await mountWithDeps({ getReadiness: async () => ({ status: "ready" }), send });
    await vi.waitFor(() => expect(root.querySelector(".assistant-starters")?.textContent).toContain("通过追问理清思路"));
    [...root.querySelectorAll<HTMLButtonElement>(".assistant-starters button")]
      .find((button) => button.textContent === "通过追问理清思路")!.click();
    await vi.waitFor(() => expect(root.querySelector(".fn-assistant-structured-editor")?.textContent).toContain("请先不要给结论"));
    expect(send).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(root.querySelector(".assistant-empty")).toBeNull());
  });

  it("starts a fresh prompted conversation and exposes the accepted request id", async () => {
    const send = vi.fn().mockResolvedValue("selection-r1");
    const createConversation = vi.fn().mockResolvedValue({ ...conversation, id: "selection-c1" });
    const { root, handle } = await mountWithDeps({
      send,
      createConversation,
      updateTitle: vi.fn().mockResolvedValue({ ...conversation, id: "selection-c1" }),
    });
    const result = await handle.startConversationWithPrompt({
      scopeType: "project", scopePath: "/notes", scopeLabel: "Notes", cwd: "/notes",
    }, "Why?\n\n> [!selection] Source\n> Quote");

    expect(result).toMatchObject({ requestId: "selection-r1", conversation: { id: "selection-c1" } });
    expect(root.querySelector(".chat-user-message-text")?.textContent).toContain("Why?");
    expect(send).toHaveBeenCalledWith({ userText: "Why?\n\n> [!selection] Source\n> Quote", references: [] }, "selection-c1");
  });

  it("rolls back a prompted conversation and restores the previous view before acceptance", async () => {
    const rollbackConversation = vi.fn().mockResolvedValue(undefined);
    const { root, handle } = await mountWithDeps({
      send: vi.fn().mockRejectedValue(new Error("send failed")),
      rollbackConversation,
    });
    await expect(handle.startConversationWithPrompt({
      scopeType: "project", scopePath: "/notes", scopeLabel: "Notes", cwd: "/notes",
    }, "question")).rejects.toThrow("send failed");
    expect(rollbackConversation).toHaveBeenCalledWith(conversation);
    expect(root.dataset.conversationId).toBe("c1");
  });

  it("shows stop and cancels the active request while streaming", async () => {
    const cancel = vi.fn();
    const { root, emitAgent } = await mountWithDeps({ cancel });
    emitAgent({ type: "delta", requestId: "r1", conversationId: "c1", text: "partial" });
    const action = root.querySelector<HTMLButtonElement>(".assistant-send")!;
    expect(action.getAttribute("aria-label")).toBe("停止生成");
    action.click();
    expect(cancel).toHaveBeenCalledWith("r1");
  });

  it("reopens the active conversation after configuration becomes available", async () => {
    const openConversation = vi.fn().mockResolvedValue(conversation);
    const { root, emitAgent, handle } = await mountWithDeps({ openConversation });
    emitAgent({ type: "error", requestId: null, conversationId: "c1", message: "尚未配置或启用 AI 提供商" });
    expect(root.querySelector(".chat-block-error")?.textContent).toContain("尚未配置");

    await handle.refreshConversation();
    expect(openConversation).toHaveBeenCalledTimes(2);

    emitAgent({ type: "session_opened", conversationId: "c1", sessionFile: conversation.sessionFile, messages: [] });
    expect(root.querySelector(".chat-block-error")).toBeNull();
  });

  it("does not show a stale refresh error after switching conversations", async () => {
    const other = { ...conversation, id: "c2", sessionFile: "/notes/.chat-2.json" };
    let rejectRefresh!: (error: Error) => void;
    let calls = 0;
    const openConversation = vi.fn((selected: ChatConversation) => {
      calls += 1;
      if (calls === 2) {
        return new Promise<ChatConversation>((_resolve, reject) => { rejectRefresh = reject; });
      }
      return Promise.resolve(selected);
    });
    const { root, handle } = await mountWithDeps({ openConversation });

    const refresh = handle.refreshConversation();
    await Promise.resolve();
    await handle.openConversation(other);
    rejectRefresh(new Error("旧会话打开失败"));
    await refresh;

    expect(root.dataset.conversationId).toBe("c2");
    expect(root.querySelector(".chat-block-error")).toBeNull();
  });

  it("ignores a late session-opened event after the active scope was cleared", async () => {
    const { root, emitAgent, handle } = await mountWithDeps();
    handle.setScope({
      scopeType: "project",
      scopePath: "/other",
      scopeLabel: "Other",
      cwd: "/other",
    });

    emitAgent({
      type: "session_opened",
      conversationId: "c1",
      sessionFile: conversation.sessionFile,
      messages: [{ role: "user", text: "stale", timestamp: 0 }],
    });

    expect(root.querySelectorAll(".chat-msg")).toHaveLength(0);
  });

  it("resends the selected user message", async () => {
    const send = vi.fn().mockResolvedValue("r2");
    const rewind = vi.fn().mockResolvedValue(undefined);
    const { root, emitAgent } = await mountWithDeps({ send, rewind });
    emitAgent({ type: "session_opened", conversationId: "c1", sessionFile: conversation.sessionFile, messages: [{ role: "user", text: "again", timestamp: 0, entryId: "u1" }] });
    root.querySelector<HTMLButtonElement>(".chat-retry-btn")!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ userText: "again", references: [] }, "c1"));
    expect(rewind).toHaveBeenCalledWith("c1", "u1");
    expect(root.querySelectorAll(".chat-msg.chat-user")).toHaveLength(1);
  });

  it("sends edited user text and replaces the bubble", async () => {
    const send = vi.fn().mockResolvedValue("r3");
    const rewind = vi.fn().mockResolvedValue(undefined);
    const { root, emitAgent } = await mountWithDeps({ send, rewind });
    emitAgent({ type: "session_opened", conversationId: "c1", sessionFile: conversation.sessionFile, messages: [{ role: "user", text: "before", timestamp: 0, entryId: "u1" }] });
    root.querySelector<HTMLButtonElement>(".chat-edit-btn")!.click();
    const input = root.querySelector<HTMLTextAreaElement>(".chat-user-edit-input")!;
    input.value = "after";
    root.querySelector<HTMLButtonElement>(".chat-user-edit-send")!.click();
    await vi.waitFor(() => expect(send).toHaveBeenCalledWith({ userText: "after", references: [] }, "c1"));
    expect(rewind).toHaveBeenCalledWith("c1", "u1");
    expect(root.querySelector(".chat-user-message-text")?.textContent).toBe("after");
  });

  it("does not let a stale initial output mode overwrite a newer change event", async () => {
    let resolveInitial!: (mode: "compact" | "detailed") => void;
    const initial = new Promise<"compact" | "detailed">((resolve) => { resolveInitial = resolve; });
    let emitMode: (mode: "compact" | "detailed") => void = () => {};
    const { root, emitAgent } = await mountWithDeps({
      getOutputMode: () => initial,
      subscribeOutputMode: (callback) => { emitMode = callback; return () => {}; },
    });
    emitAgent({ type: "session_opened", conversationId: "c1", sessionFile: conversation.sessionFile, messages: [{
      role: "assistant", timestamp: 0, blocks: [
        { type: "thinking", text: "分析" },
        { type: "tool", callId: "c1", name: "read", label: "读取文档", status: "succeeded" },
      ],
    }] });
    emitMode("detailed");
    expect(root.querySelector(".chat-process-group")).not.toBeNull();
    resolveInitial("compact");
    await Promise.resolve();
    await Promise.resolve();
    expect(root.querySelector(".chat-process-group")).not.toBeNull();
  });

  it("keeps a process group interactive while streaming and after completion", async () => {
    const { root, emitAgent } = await mountWithDeps({ getOutputMode: async () => "detailed" });
    await Promise.resolve();
    emitAgent({ type: "tool", requestId: "r1", conversationId: "c1", callId: "c1", name: "read", label: "读取文档", phase: "start" });
    emitAgent({ type: "tool", requestId: "r1", conversationId: "c1", callId: "c2", name: "list_tags", label: "读取标签", phase: "start" });

    root.querySelector<HTMLButtonElement>(".chat-process-group-head")!.click();
    expect(root.querySelector<HTMLButtonElement>(".chat-process-group-head")?.getAttribute("aria-expanded")).toBe("true");

    emitAgent({ type: "tool", requestId: "r1", conversationId: "c1", callId: "c2", name: "list_tags", phase: "end" });
    emitAgent({ type: "done", requestId: "r1", conversationId: "c1" });
    expect(root.querySelector<HTMLButtonElement>(".chat-process-group-head")?.getAttribute("aria-expanded")).toBe("true");

    root.querySelector<HTMLButtonElement>(".chat-process-group-head")!.click();
    expect(root.querySelector<HTMLButtonElement>(".chat-process-group-head")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("pauses bottom following after an upward scroll and resumes from the jump button", async () => {
    const { root, emitAgent } = await mountWithDeps();
    const scroll = root.querySelector<HTMLElement>(".assistant-scroll")!;
    let scrollHeight = 1000;
    Object.defineProperties(scroll, {
      clientHeight: { configurable: true, value: 100 },
      scrollHeight: { configurable: true, get: () => scrollHeight },
    });
    scroll.scrollTop = 900;

    scroll.scrollTop = 620;
    scroll.dispatchEvent(new Event("scroll"));
    const jump = root.querySelector<HTMLButtonElement>(".assistant-scroll-bottom")!;
    expect(jump).not.toBeNull();
    expect(jump.hidden).toBe(false);

    scrollHeight = 1200;
    emitAgent({ type: "delta", requestId: "r1", conversationId: "c1", text: "partial" });
    expect(scroll.scrollTop).toBe(620);

    jump.click();
    expect(scroll.scrollTop).toBe(1200);
    expect(jump.hidden).toBe(true);

    scroll.scrollTop = 800;
    scroll.dispatchEvent(new Event("scroll"));
    expect(jump.hidden).toBe(false);
    scroll.scrollTop = 1100;
    scroll.dispatchEvent(new Event("scroll"));
    expect(jump.hidden).toBe(true);

    scrollHeight = 1300;
    emitAgent({ type: "delta", requestId: "r1", conversationId: "c1", text: " more" });
    expect(scroll.scrollTop).toBe(1300);
  });
});
