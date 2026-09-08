// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { afterEach } from "vitest";
import { emptyChat, reduceEvents, type ChatState } from "./render";
import { reconcileMessages, __resetBlockMap } from "./blocks";

function makeScroll(): HTMLElement {
  const el = document.createElement("div");
  el.className = "assistant-scroll";
  Object.defineProperty(el, "clientHeight", { value: 100, configurable: true });
  Object.defineProperty(el, "scrollHeight", { value: 100, configurable: true });
  return el;
}

function run(events: Parameters<typeof reduceEvents>[1][]): ChatState {
  return events.reduce(reduceEvents, emptyChat());
}

describe("reconcileMessages", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it("reuses an existing message node across deltas (no rebuild)", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const s1 = run([{ type: "delta", requestId: "r1", text: "Hel" }]);
    reconcileMessages(scroll, s1.messages, map);
    const msgEl = scroll.querySelector<HTMLElement>(".chat-msg")!;
    expect(msgEl).toBeTruthy();
    // 给节点打标记，验证后续 delta 不重建节点。
    msgEl.dataset.marker = "kept";

    const s2 = reduceEvents(s1, { type: "delta", requestId: "r1", text: "lo" });
    reconcileMessages(scroll, s2.messages, map);
    const after = scroll.querySelector<HTMLElement>(".chat-msg")!;
    expect(after.dataset.marker).toBe("kept");
  });

  it("keeps a selection user bubble stable while the assistant streams", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const selection = "Why?\n\n> [!selection] Source\n> quoted text";
    const initial = run([{ type: "user", text: selection }]);
    reconcileMessages(scroll, initial.messages, map);
    const user = scroll.querySelector<HTMLElement>(".chat-msg.chat-user")!;
    user.dataset.marker = "kept";

    const streaming = reduceEvents(initial, { type: "delta", requestId: "r1", text: "Answer" });
    reconcileMessages(scroll, streaming.messages, map);

    expect(scroll.querySelector<HTMLElement>(".chat-msg.chat-user")?.dataset.marker).toBe("kept");
  });

  it("reuses a text block node and updates content without rebuilding", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const s1 = run([{ type: "delta", requestId: "r1", text: "Hel" }]);
    reconcileMessages(scroll, s1.messages, map);
    const block = scroll.querySelector<HTMLElement>(".chat-block-text")!;
    block.dataset.marker = "kept";

    const s2 = reduceEvents(s1, { type: "delta", requestId: "r1", text: "lo" });
    reconcileMessages(scroll, s2.messages, map);
    const after = scroll.querySelector<HTMLElement>(".chat-block-text")!;
    expect(after.dataset.marker).toBe("kept");
    expect(after.querySelector(".chat-text-content")?.textContent).toContain("Hello");
  });

  it("appends a new thinking block as a sibling without dropping the text block", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const s1 = run([{ type: "delta", requestId: "r1", text: "答案" }]);
    reconcileMessages(scroll, s1.messages, map);

    const s2 = reduceEvents(s1, { type: "thinking_start", requestId: "r1", blockId: "t1" });
    reconcileMessages(scroll, s2.messages, map);
    const blocks = scroll.querySelectorAll<HTMLElement>(".chat-block");
    expect(blocks.length).toBe(2);
    expect(blocks[0].classList.contains("chat-block-text")).toBe(true);
    expect(blocks[1].classList.contains("chat-block-thinking")).toBe(true);
  });

  it("keeps a process group open when streaming updates immediately after its toggle is clicked", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    let state = run([
      { type: "tool", requestId: "r1", callId: "c1", name: "read", label: "读取文档", phase: "start" },
      { type: "tool", requestId: "r1", callId: "c2", name: "read", label: "读取任务", phase: "start" },
    ]);
    reconcileMessages(scroll, state.messages, map);

    const group = scroll.querySelector<HTMLElement>(".chat-block-process_group")!;
    group.addEventListener("chat:toggle-process", (event) => {
      const detail = (event as CustomEvent<{ blockId: string; collapsed: boolean }>).detail;
      state = reduceEvents(state, { type: "process_toggle", ...detail });
      reconcileMessages(scroll, state.messages, map);
    });
    const toggle = group.querySelector<HTMLButtonElement>(".chat-process-group-head")!;
    const click = new MouseEvent("click", { bubbles: true, cancelable: true });
    toggle.dispatchEvent(click);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(group.querySelector("details")).toBeNull();

    state = reduceEvents(state, {
      type: "tool", requestId: "r1", callId: "c2", name: "read", phase: "end",
    });
    reconcileMessages(scroll, state.messages, map);
    expect(scroll.querySelector<HTMLButtonElement>(".chat-process-group-head")?.getAttribute("aria-expanded")).toBe("true");

    scroll.querySelector<HTMLButtonElement>(".chat-process-group-head")!.click();
    expect(scroll.querySelector<HTMLButtonElement>(".chat-process-group-head")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps an opened process group open when a contained thinking block is toggled", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    let state = run([
      { type: "thinking_start", requestId: "r1", blockId: "t1" },
      { type: "thinking_delta", requestId: "r1", text: "分析" },
      { type: "tool", requestId: "r1", callId: "c1", name: "read", label: "读取文档", phase: "start" },
      { type: "process_toggle", blockId: "t1", collapsed: false },
    ]);
    reconcileMessages(scroll, state.messages, map);

    const group = scroll.querySelector<HTMLElement>(".chat-block-process_group")!;
    group.addEventListener("chat:toggle-thinking", (event) => {
      const { blockId } = (event as CustomEvent<{ blockId: string }>).detail;
      state = reduceEvents(state, { type: "thinking_toggle", blockId });
      reconcileMessages(scroll, state.messages, map);
    });
    group.querySelector<HTMLButtonElement>(".chat-thinking-head")!.click();

    expect(scroll.querySelector<HTMLButtonElement>(".chat-process-group-head")?.getAttribute("aria-expanded")).toBe("true");
  });

  it("switches existing process blocks between compact and detailed projection", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const state = run([
      { type: "thinking_start", requestId: "r1", blockId: "t1" },
      { type: "thinking_delta", requestId: "r1", text: "分析" },
      { type: "tool", requestId: "r1", callId: "c1", name: "read", label: "读取文档", phase: "start" },
    ]);
    reconcileMessages(scroll, state.messages, map, "compact");
    expect(scroll.querySelector(".chat-block-process_group")).toBeNull();
    expect(scroll.querySelector(".chat-compact-progress")).not.toBeNull();

    reconcileMessages(scroll, state.messages, map, "detailed");
    expect(scroll.querySelector(".chat-block-process_group")).not.toBeNull();
    expect(scroll.querySelector(".chat-compact-progress")).toBeNull();
  });

  it("puts the compact cursor after streaming text and removes it when done", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const streaming = run([
      { type: "thinking_start", requestId: "r1", blockId: "t1" },
      { type: "thinking_end", requestId: "r1" },
      { type: "delta", requestId: "r1", text: "答案" },
    ]);
    reconcileMessages(scroll, streaming.messages, map, "compact");
    const cursor = scroll.querySelector(".chat-text-content .chat-compact-cursor");
    expect(cursor).not.toBeNull();
    expect(cursor?.closest(".chat-text-content")).not.toBeNull();
    const done = reduceEvents(streaming, { type: "done", requestId: "r1" });
    reconcileMessages(scroll, done.messages, map, "compact");
    expect(scroll.querySelector(".chat-compact-cursor")).toBeNull();
  });

  it("does not leave an empty assistant row for a completed process-only turn in compact mode", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const state = run([
      { type: "thinking_start", requestId: "r1", blockId: "t1" },
      { type: "thinking_end", requestId: "r1" },
      { type: "done", requestId: "r1" },
    ]);
    reconcileMessages(scroll, state.messages, map, "compact");
    expect(scroll.querySelector(".chat-assistant")).toBeNull();
  });

  it("removes stale messages on session switch", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const s1 = run([{ type: "user", text: "旧" }]);
    reconcileMessages(scroll, s1.messages, map);
    expect(scroll.querySelectorAll(".chat-msg").length).toBe(1);

    const s2 = run([{ type: "user", text: "新" }]);
    reconcileMessages(scroll, s2.messages, map);
    expect(scroll.querySelectorAll(".chat-msg").length).toBe(1);
    expect(scroll.querySelector(".chat-msg")?.textContent).toContain("新");
  });

  it("marks the assistant message node with data-message-id", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const s = run([{ type: "delta", requestId: "r1", text: "x" }]);
    reconcileMessages(scroll, s.messages, map);
    const el = scroll.querySelector<HTMLElement>(".chat-msg.chat-assistant")!;
    expect(el.dataset.messageId).toBeTruthy();
    __resetBlockMap(el);
  });

  it("copies the latest streamed text rather than the initial render value", async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text); } },
    });
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const s1 = run([{ type: "delta", requestId: "r1", text: "Hel" }]);
    reconcileMessages(scroll, s1.messages, map);
    const s2 = reduceEvents(s1, { type: "delta", requestId: "r1", text: "lo" });
    reconcileMessages(scroll, s2.messages, map);
    const completed = reduceEvents(s2, { type: "done", requestId: "r1" });
    reconcileMessages(scroll, completed.messages, map);
    scroll.querySelector<HTMLButtonElement>(".chat-copy-btn")!.click();
    await Promise.resolve();
    expect(writes).toEqual(["Hello"]);
  });

  it("renders only copy for a completed assistant text block", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const state = run([{ type: "delta", requestId: "r1", text: "answer" }, { type: "done", requestId: "r1" }]);
    reconcileMessages(scroll, state.messages, map);
    expect(Array.from(scroll.querySelectorAll<HTMLButtonElement>(".chat-message-action"))
      .map((button) => button.getAttribute("aria-label"))).toEqual(["复制原文"]);
  });

  it("renders retry and edit actions on a user bubble", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const state = run([{ type: "user", text: "question" }]);
    reconcileMessages(scroll, state.messages, map);
    expect(Array.from(scroll.querySelectorAll<HTMLButtonElement>(".chat-message-action"))
      .map((button) => button.getAttribute("aria-label"))).toEqual(["重试", "编辑"]);
  });

  it("edits a user bubble in place and cancel restores its text", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const state = run([{ type: "user", text: "before" }]);
    reconcileMessages(scroll, state.messages, map);
    scroll.querySelector<HTMLButtonElement>(".chat-edit-btn")!.click();
    const input = scroll.querySelector<HTMLTextAreaElement>(".chat-user-edit-input")!;
    expect(input.value).toBe("before");
    expect(input.dataset.focusStyle).toBe("quiet");
    expect(input.style.overflowY).toBe("hidden");
    expect(scroll.querySelector(".chat-message-actions")).toBeNull();
    input.value = "after";
    scroll.querySelector<HTMLButtonElement>(".chat-user-edit-cancel")!.click();
    expect(scroll.querySelector(".chat-user-edit-input")).toBeNull();
    expect(scroll.querySelector(".chat-user-message-text")?.textContent).toBe("before");
  });

  it("renders structured references as chips in a user bubble", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const state = run([{
      type: "user",
      text: "整理它",
      references: [
        { kind: "file", id: "piece.md", display: "piece.md" },
        { kind: "skill", id: "summarize", display: "summarize" },
      ],
    }]);
    reconcileMessages(scroll, state.messages, map);
    expect(scroll.querySelector(".chat-reference-chip.file")?.textContent).toContain("piece.md");
    expect(scroll.querySelector(".chat-reference-chip.skill")?.textContent).toContain("Skill · summarize");
  });

  it("normalizes legacy system-file references at the final display boundary", () => {
    const scroll = makeScroll();
    const map = new Map<string, HTMLElement>();
    const state = run([{
      type: "user",
      text: "整理它",
      references: [
        { kind: "file", id: "_inbox", display: "_inbox", noteKind: "inbox" },
        { kind: "file", id: "_tasks", display: "_tasks", noteKind: "tasks" },
      ],
    }]);
    reconcileMessages(scroll, state.messages, map);
    const text = scroll.querySelector(".chat-reference-chips")?.textContent ?? "";
    expect(text).toContain("采集区");
    expect(text).toContain("行动清单");
    expect(text).not.toContain("_inbox");
    expect(text).not.toContain("_tasks");
  });
});
