// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPieceHeader } from "./piece-switcher";

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  document.body.innerHTML = "";
  vi.stubGlobal("ResizeObserver", ResizeObserverStub);
});

describe("version menu", () => {
  it("can refit a wrapped title after its font size changes", () => {
    const topbarMount = document.createElement("div");
    const titleMount = document.createElement("div");
    const previewMount = document.createElement("div");
    document.body.append(topbarMount, titleMount, previewMount);
    const header = createPieceHeader({
      topbarMount,
      titleMount,
      previewMount,
      host: {
        dir: () => "/project",
        current: () => ({ name: "piece", path: "/project/piece.md" }),
        open: vi.fn(),
        loadVersions: async () => [],
        snapshot: vi.fn(),
        preview: vi.fn().mockResolvedValue(false),
        exitPreview: vi.fn(),
        restore: vi.fn(),
        renameVersion: vi.fn(),
        deleteVersion: vi.fn(),
        focusBody: vi.fn(),
      },
    });
    const title = titleMount.querySelector<HTMLTextAreaElement>(".piece-title-input")!;
    Object.defineProperty(title, "scrollHeight", { configurable: true, value: 72 });

    header.refit();

    expect(title.style.height).toBe("72px");
  });

  it("reopens immediately after an outside click closes it", async () => {
    const topbarMount = document.createElement("div");
    const titleMount = document.createElement("div");
    const previewMount = document.createElement("div");
    document.body.append(topbarMount, titleMount, previewMount);
    createPieceHeader({
      topbarMount,
      titleMount,
      previewMount,
      host: {
        dir: () => "/project",
        current: () => ({ name: "piece", path: "/project/piece.md" }),
        open: vi.fn(),
        loadVersions: async () => [],
        snapshot: vi.fn(),
        preview: vi.fn().mockResolvedValue(false),
        exitPreview: vi.fn(),
        restore: vi.fn(),
        renameVersion: vi.fn(),
        deleteVersion: vi.fn(),
        focusBody: vi.fn(),
      },
    });

    const trigger = topbarMount.querySelector<HTMLButtonElement>(".piece-version-btn")!;
    trigger.click();
    await vi.waitFor(() => expect(document.querySelector(".fn-menu")).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 0));

    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(document.querySelector(".fn-menu")).toBeNull();

    trigger.click();
    await vi.waitFor(() => expect(document.querySelector(".fn-menu")).toBeTruthy());
  });

  it("does not commit a title rename while an IME confirms text", () => {
    const topbarMount = document.createElement("div");
    const titleMount = document.createElement("div");
    const previewMount = document.createElement("div");
    document.body.append(topbarMount, titleMount, previewMount);
    const focusBody = vi.fn();
    createPieceHeader({
      topbarMount,
      titleMount,
      previewMount,
      host: {
        dir: () => "/project",
        current: () => ({ name: "piece", path: "/project/piece.md" }),
        open: vi.fn(),
        loadVersions: async () => [],
        snapshot: vi.fn(),
        preview: vi.fn().mockResolvedValue(false),
        exitPreview: vi.fn(),
        restore: vi.fn(),
        renameVersion: vi.fn(),
        deleteVersion: vi.fn(),
        focusBody,
      },
    });

    const title = titleMount.querySelector<HTMLTextAreaElement>(".piece-title-input")!;
    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, isComposing: true }));
    expect(focusBody).not.toHaveBeenCalled();

    title.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    expect(focusBody).toHaveBeenCalledOnce();
  });

  it("renders two-line version rows and exposes row actions from a kebab menu", async () => {
    const topbarMount = document.createElement("div");
    const titleMount = document.createElement("div");
    const previewMount = document.createElement("div");
    document.body.append(topbarMount, titleMount, previewMount);
    const preview = vi.fn().mockResolvedValue(undefined);
    createPieceHeader({
      topbarMount,
      titleMount,
      previewMount,
      host: {
        dir: () => "/project",
        current: () => ({ name: "piece", path: "/project/piece.md" }),
        open: vi.fn(),
        loadVersions: async () => [{
          v: 6,
          ts: new Date(2026, 6, 13, 14, 32).toISOString(),
          source: "manual",
          summary: "完成第一稿",
        }],
        snapshot: vi.fn(),
        preview: async (_target, v) => {
          await preview(v);
          return true;
        },
        exitPreview: vi.fn(),
        restore: vi.fn(),
        renameVersion: vi.fn(),
        deleteVersion: vi.fn(),
        focusBody: vi.fn(),
      },
    });

    topbarMount.querySelector<HTMLButtonElement>(".piece-version-btn")!.click();
    await vi.waitFor(() => expect(document.querySelector(".version-list-row")).toBeTruthy());

    expect(document.querySelector(".version-item-title")?.textContent).toBe("完成第一稿");
    expect(document.querySelector(".version-item-meta")?.textContent).toBe("7月13日 14:32");
    expect(document.body.textContent).not.toContain("手动");

    document.querySelector<HTMLButtonElement>(".version-row-main")!.click();
    await vi.waitFor(() => expect(preview).toHaveBeenCalledWith(6));
    await vi.waitFor(() => expect(previewMount.textContent).toContain("恢复此版本"));
    expect(previewMount.textContent).toContain("恢复此版本");
    expect(previewMount.textContent).toContain("退出预览");

    topbarMount.querySelector<HTMLButtonElement>(".piece-version-btn")!.click();
    await vi.waitFor(() => expect(document.querySelector(".version-list-row")).toBeTruthy());
    document.querySelector<HTMLButtonElement>(".version-row-kebab")!.click();
    await vi.waitFor(() => expect(document.querySelector(".fn-menu__submenu")).toBeTruthy());
    expect(document.querySelector(".fn-menu__submenu")?.textContent).toContain("恢复此版本");
    expect(document.querySelector(".fn-menu__submenu")?.textContent).toContain("重命名版本");
    expect(document.querySelector(".fn-menu__submenu")?.textContent).toContain("删除版本");
  });

  it("discards a version list that resolves after switching pieces", async () => {
    const topbarMount = document.createElement("div");
    const titleMount = document.createElement("div");
    const previewMount = document.createElement("div");
    document.body.append(topbarMount, titleMount, previewMount);
    let current = { name: "one", path: "/project/one.md" };
    let resolveVersions!: (entries: Array<{
      v: number; ts: string; source: "manual"; summary: null;
    }>) => void;
    const versions = new Promise<Array<{
      v: number; ts: string; source: "manual"; summary: null;
    }>>((resolve) => { resolveVersions = resolve; });
    createPieceHeader({
      topbarMount,
      titleMount,
      previewMount,
      host: {
        dir: () => "/project",
        current: () => current,
        open: vi.fn(),
        loadVersions: async () => versions,
        snapshot: vi.fn(),
        preview: vi.fn().mockResolvedValue(true),
        exitPreview: vi.fn(),
        restore: vi.fn(),
        renameVersion: vi.fn(),
        deleteVersion: vi.fn(),
        focusBody: vi.fn(),
      },
    });

    topbarMount.querySelector<HTMLButtonElement>(".piece-version-btn")!.click();
    current = { name: "two", path: "/project/two.md" };
    resolveVersions([{ v: 1, ts: "2026-07-13T14:32:00+08:00", source: "manual", summary: null }]);
    await Promise.resolve();
    await Promise.resolve();

    expect(document.querySelector(".version-list-row")).toBeNull();
  });

  it("does not show a preview bar when the host rejects a stale preview", async () => {
    const topbarMount = document.createElement("div");
    const titleMount = document.createElement("div");
    const previewMount = document.createElement("div");
    document.body.append(topbarMount, titleMount, previewMount);
    createPieceHeader({
      topbarMount,
      titleMount,
      previewMount,
      host: {
        dir: () => "/project",
        current: () => ({ name: "one", path: "/project/one.md" }),
        open: vi.fn(),
        loadVersions: async () => [{
          v: 1, ts: "2026-07-13T14:32:00+08:00", source: "manual", summary: null,
        }],
        snapshot: vi.fn(),
        preview: vi.fn().mockResolvedValue(false),
        exitPreview: vi.fn(),
        restore: vi.fn(),
        renameVersion: vi.fn(),
        deleteVersion: vi.fn(),
        focusBody: vi.fn(),
      },
    });

    topbarMount.querySelector<HTMLButtonElement>(".piece-version-btn")!.click();
    await vi.waitFor(() => expect(document.querySelector(".version-row-main")).toBeTruthy());
    document.querySelector<HTMLButtonElement>(".version-row-main")!.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(previewMount.hidden).toBe(true);
  });

  it("keeps the editor safe and reports a preview failure", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const topbarMount = document.createElement("div");
    const titleMount = document.createElement("div");
    const previewMount = document.createElement("div");
    document.body.append(topbarMount, titleMount, previewMount);
    createPieceHeader({
      topbarMount,
      titleMount,
      previewMount,
      host: {
        dir: () => "/project",
        current: () => ({ name: "one", path: "/project/one.md" }),
        open: vi.fn(),
        loadVersions: async () => [{
          v: 1, ts: "2026-07-13T14:32:00+08:00", source: "manual", summary: null,
        }],
        snapshot: vi.fn(),
        preview: vi.fn().mockRejectedValue(new Error("read failed")),
        exitPreview: vi.fn(),
        restore: vi.fn(),
        renameVersion: vi.fn(),
        deleteVersion: vi.fn(),
        focusBody: vi.fn(),
      },
    });

    topbarMount.querySelector<HTMLButtonElement>(".piece-version-btn")!.click();
    await vi.waitFor(() => expect(document.querySelector(".version-row-main")).toBeTruthy());
    document.querySelector<HTMLButtonElement>(".version-row-main")!.click();

    await vi.waitFor(() => expect(document.querySelector(".toast")).toBeTruthy());
    expect(document.querySelector(".toast")?.textContent).toContain("预览版本失败");
    expect(previewMount.hidden).toBe(true);
    consoleError.mockRestore();
  });
});
