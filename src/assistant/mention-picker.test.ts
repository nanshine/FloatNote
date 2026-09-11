// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  currentMentionQuery,
  mentionPresentation,
  mountMentionPicker,
  renderFileList,
  type MentionFile,
} from "./mention-picker.js";

const FILES: MentionFile[] = [
  { name: "_inbox", kind: "inbox" },
  { name: "_tasks", kind: "tasks" },
  { name: "piece", kind: "piece" },
  { name: "structure", kind: "piece" },
];

describe("renderFileList", () => {
  it("lists files with product names instead of exposing system filenames", () => {
    const el = renderFileList(FILES, "");
    expect(el.querySelectorAll(".assistant-mention-item")).toHaveLength(4);
    expect(el.querySelector(".assistant-mention-name")?.textContent).toBe("采集区");
    expect(el.querySelector(".assistant-mention-kind")?.textContent).toBe("采集");
    expect(el.textContent).not.toContain("_inbox");
    expect(el.textContent).not.toContain("_tasks");
  });

  it("keeps system filenames as hidden searchable identifiers", () => {
    const inbox = mentionPresentation(FILES[0]);
    expect(inbox).toMatchObject({ displayName: "采集区", kindLabel: "采集" });
    expect(inbox.keywords).toContain("_inbox");
    expect(renderFileList(FILES, "inbox").textContent).toContain("采集区");
  });

  it("filters by name substring (case-insensitive)", () => {
    const el = renderFileList(FILES, "STR");
    const items = el.querySelectorAll(".assistant-mention-item");
    expect(items).toHaveLength(1);
    expect(items[0].getAttribute("data-mention-name")).toBe("structure");
  });

  it("shows empty state when nothing matches", () => {
    const el = renderFileList(FILES, "zzz");
    expect(el.querySelectorAll(".assistant-mention-item")).toHaveLength(0);
    expect(el.querySelector(".assistant-mention-empty")?.textContent).toContain("没有匹配");
  });
});

describe("currentMentionQuery", () => {
  function ta(value: string, caret: number): HTMLTextAreaElement {
    const t = document.createElement("textarea");
    t.value = value;
    t.selectionStart = caret;
    t.selectionEnd = caret;
    return t;
  }
  it("matches @ at line start", () => {
    expect(currentMentionQuery(ta("@pi", 3))).toEqual({ query: "pi", start: 0, end: 3 });
  });
  it("matches @ mid-sentence after a space", () => {
    expect(currentMentionQuery(ta("看看 @pie", 7))).toEqual({ query: "pie", start: 3, end: 7 });
  });
  it("does not match @ glued to a word (no preceding space)", () => {
    expect(currentMentionQuery(ta("a@pie", 5))).toBeNull();
  });
  it("does not match when no @ present", () => {
    expect(currentMentionQuery(ta("hello world", 11))).toBeNull();
  });
  it("stops query at the first space after @", () => {
    // "看 @pie 末尾" caret 在末尾 → 最后一段不是 @，无命中
    expect(currentMentionQuery(ta("看 @pie 末尾", 8))).toBeNull();
  });
  it("matches the latest @ when caret right after it", () => {
    expect(currentMentionQuery(ta("a @b @c", 7))).toEqual({ query: "c", start: 5, end: 7 });
  });
});

describe("mountMentionPicker", () => {
  function setup(files: MentionFile[] = FILES) {
    document.body.innerHTML = "";
    const dock = document.createElement("div");
    dock.className = "assistant-dock";
    const input = document.createElement("textarea");
    input.className = "assistant-input";
    dock.appendChild(input);
    document.body.appendChild(dock);
    const listFiles = vi.fn(async () => files);
    const getScope = vi.fn(() => ({ scopeType: "project" as const, scopePath: "/p", scopeLabel: "p", cwd: "/p" }));
    const closeSkill = vi.fn();
    const picker = mountMentionPicker({ input, dock, listFiles, getScope, closeSkill });
    return { input, dock, listFiles, getScope, closeSkill, picker };
  }

  it("opens dropdown on @ and replaces query with @<name> on click", async () => {
    const { input, closeSkill, picker } = setup();
    input.value = "看看 @pie";
    input.selectionStart = 7;
    input.selectionEnd = 7;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector(".assistant-mention-dropdown")?.hasAttribute("hidden")).toBe(false);
    });
    // 打开 mention 下拉时应关闭互斥的 skill 下拉
    expect(closeSkill).toHaveBeenCalled();
    expect(document.querySelectorAll(".assistant-mention-item").length).toBeGreaterThan(0);

    const item = document.querySelector<HTMLButtonElement>('.assistant-mention-item[data-mention-name="piece"]')!;
    item.click();
    expect(input.value).toBe("看看 @piece ");
    expect(picker.isOpen()).toBe(false);
    picker.destroy();
  });

  it("closes dropdown when @ token is gone", async () => {
    const { input, picker } = setup();
    input.value = "@pie";
    input.selectionStart = 4;
    input.selectionEnd = 4;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector(".assistant-mention-dropdown")?.hasAttribute("hidden")).toBe(false);
    });
    input.value = "hello";
    input.selectionStart = 5;
    input.selectionEnd = 5;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector(".assistant-mention-dropdown")?.hasAttribute("hidden")).toBe(true);
    });
    picker.destroy();
  });

  it("closes on outside pointerdown", async () => {
    const { input, picker } = setup();
    input.value = "@";
    input.selectionStart = 1;
    input.selectionEnd = 1;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.waitFor(() => {
      expect(document.querySelector(".assistant-mention-dropdown")?.hasAttribute("hidden")).toBe(false);
    });
    const elsewhere = document.createElement("div");
    document.body.appendChild(elsewhere);
    elsewhere.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".assistant-mention-dropdown")?.hasAttribute("hidden")).toBe(true);
    picker.destroy();
  });

  it("does not open when there is no scope", async () => {
    document.body.innerHTML = "";
    const dock = document.createElement("div");
    const input = document.createElement("textarea");
    dock.appendChild(input);
    document.body.appendChild(dock);
    const picker = mountMentionPicker({
      input,
      dock,
      listFiles: vi.fn(async () => FILES),
      getScope: () => null,
      closeSkill: () => {},
    });
    input.value = "@pie";
    input.selectionStart = 4;
    input.selectionEnd = 4;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((r) => setTimeout(r, 0));
    expect(document.querySelector(".assistant-mention-dropdown")).toBeNull();
    picker.destroy();
  });
});
