// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountComposer, type ComposerHandle } from "./structured-composer";
import type { PromptPayload } from "./submit";
import type { MentionFile } from "../mention-picker";
import type { SkillSummary } from "../skill-picker";

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
}

describe("structured composer", () => {
  let handle: ComposerHandle | undefined;

  afterEach(() => {
    handle?.destroy();
    document.body.replaceChildren();
  });

  async function setup(options: {
    files?: MentionFile[];
    skills?: SkillSummary[];
  } = {}): Promise<{ submitted: PromptPayload[]; host: HTMLElement }> {
    const wrap = document.createElement("div");
    const host = document.createElement("div");
    wrap.append(host);
    document.body.append(wrap);
    const submitted: PromptPayload[] = [];
    handle = mountComposer({
      editorHost: host,
      wrapHost: wrap,
      placeholder: "说点什么…",
      getScope: () => ({ scopeType: "project", scopePath: "p", scopeLabel: "p", cwd: "p" }),
      listFiles: async () => options.files ?? [{ name: "piece.md", kind: "piece" }],
      listSkills: async () => options.skills ?? [],
      onSubmit: async (payload) => { submitted.push(payload); return true; },
    });
    await vi.waitFor(() => expect(host.querySelector(".fn-assistant-structured-editor")).toBeTruthy());
    return { submitted, host };
  }

  it("submits canonical Markdown from the structural document", async () => {
    const { submitted } = await setup();
    handle!.insertText("**hello**");
    handle!.submit();
    expect(submitted).toEqual([{ userText: "\\*\\*hello\\*\\*", references: [] }]);
    await vi.waitFor(() => expect(handle!.getDoc()).toBe(""));
  });

  it("keeps file references as atomic nodes and out of userText", async () => {
    const { submitted, host } = await setup();
    handle!.insertText("@pi");
    await vi.waitFor(() => expect(handle!.isPopoverOpen()).toBe(true));
    handle!.pressKey("Enter");
    expect(host.querySelector("[data-assistant-ref]")?.textContent).toBe("piece.md");
    handle!.submit();
    expect(submitted[0]).toEqual({
      userText: "",
      references: [{ kind: "file", id: "piece.md", display: "piece.md", noteKind: "piece" }],
    });
  });

  it("atomically inserts the file starter reference and suffix without sending", async () => {
    const { submitted, host } = await setup();
    handle!.openFileStarter();
    await vi.waitFor(() => expect(handle!.isPopoverOpen()).toBe(true));
    handle!.pressKey("Enter");
    expect(host.querySelector("[data-assistant-ref]")?.textContent).toBe("piece.md");
    expect(handle!.getDoc()).toContain("请结合");
    expect(handle!.getDoc()).toContain("帮我梳理核心观点");
    expect(submitted).toEqual([]);
  });

  it("preserves a draft when opening skills or choosing a starter", async () => {
    await setup();
    handle!.insertText("保留我的问题 ");
    handle!.fillStarter("替换文字");
    handle!.openFileStarter();
    expect(handle!.getDoc()).toContain("保留我的问题");
    expect(handle!.getDoc()).not.toContain("替换文字");
    handle!.openSkillPicker();
    expect(handle!.getDoc()).toContain("保留我的问题 /");
  });

  it("does not carry a cancelled starter suffix into a later reference", async () => {
    const { host } = await setup();
    handle!.openFileStarter();
    await vi.waitFor(() => expect(handle!.isPopoverOpen()).toBe(true));
    handle!.closePopover();
    handle!.clear();
    handle!.insertText("@pi");
    await vi.waitFor(() => expect(handle!.isPopoverOpen()).toBe(true));
    handle!.pressKey("Enter");
    expect(host.querySelector("[data-assistant-ref]")?.textContent).toBe("piece.md");
    expect(handle!.getDoc()).not.toContain("帮我梳理核心观点");
  });

  it("uses normal structural Enter behavior in expanded mode", async () => {
    await setup();
    handle!.insertText("first");
    handle!.expandLarge();
    handle!.pressKey("Enter");
    expect(handle!.getDoc()).toContain("first");
    expect(handle!.isLarge()).toBe(true);
  });

  it("renders structured, accessible candidates and hides system filenames", async () => {
    const { submitted, host } = await setup({
      files: [
        { name: "_inbox", kind: "inbox" },
        { name: "_tasks", kind: "tasks" },
      ],
    });
    handle!.insertText("@");
    await vi.waitFor(() => expect(handle!.isPopoverOpen()).toBe(true));

    const popover = document.querySelector<HTMLElement>(".fn-ref-popover")!;
    const options = popover.querySelectorAll<HTMLElement>("[role=option]");
    expect(popover.getAttribute("aria-label")).toBe("引用文档");
    expect(popover.textContent).toContain("采集区");
    expect(popover.textContent).toContain("行动清单");
    expect(popover.textContent).not.toContain("_inbox");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[0].querySelector(".fn-ref-popover-icon")).toBeTruthy();
    expect(options[0].querySelector(".fn-ref-popover-kind")?.textContent).toBe("采集");

    const editor = host.querySelector<HTMLElement>(".editor")!;
    expect(editor.getAttribute("aria-expanded")).toBe("true");
    expect(editor.getAttribute("aria-activedescendant")).toBe(options[0].id);
    handle!.pressKey("Enter");
    const chip = host.querySelector<HTMLElement>("[data-assistant-ref]")!;
    expect(chip.textContent).toBe("采集区");
    expect(chip.title).toBe("采集区");
    handle!.submit();
    expect(submitted[0].references).toEqual([
      { kind: "file", id: "_inbox", display: "采集区", noteKind: "inbox" },
    ]);
  });

  it("shows skill descriptions and type labels in the shared menu", async () => {
    await setup({
      skills: [{
        name: "organize",
        description: "Organize collected notes",
        displayName: "梳理材料",
        displayDescription: "按主题整理采集内容",
      }],
    });
    handle!.insertText("/");
    await vi.waitFor(() => expect(handle!.isPopoverOpen()).toBe(true));
    const popover = document.querySelector<HTMLElement>(".fn-ref-popover")!;
    expect(popover.getAttribute("aria-label")).toBe("使用技能");
    expect(popover.querySelector(".fn-ref-popover-label")?.textContent).toBe("梳理材料");
    expect(popover.querySelector(".fn-ref-popover-desc")?.textContent).toBe("按主题整理采集内容");
    expect(popover.querySelector(".fn-ref-popover-kind")?.textContent).toBe("技能");
  });
});
