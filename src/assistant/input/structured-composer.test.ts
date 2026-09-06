// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountComposer, type ComposerHandle } from "./structured-composer";
import type { PromptPayload } from "./submit";

if (!Range.prototype.getClientRects) {
  Object.defineProperty(Range.prototype, "getClientRects", { value: () => [] });
}

describe("structured composer", () => {
  let handle: ComposerHandle | undefined;

  afterEach(() => {
    handle?.destroy();
    document.body.replaceChildren();
  });

  async function setup(): Promise<{ submitted: PromptPayload[]; host: HTMLElement }> {
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
      listFiles: async () => [{ name: "piece.md", kind: "piece" }],
      listSkills: async () => [],
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

  it("uses normal structural Enter behavior in expanded mode", async () => {
    await setup();
    handle!.insertText("first");
    handle!.expandLarge();
    handle!.pressKey("Enter");
    expect(handle!.getDoc()).toContain("first");
    expect(handle!.isLarge()).toBe(true);
  });
});
