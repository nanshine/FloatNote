import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  inboxPath,
  inboxEntry,
  scheduleSave,
  saveBeforeUpdate,
  saveImmediate,
  settleAllPendingWrites,
  settlePendingWrites,
  flushAll,
  isDirty,
  lastKnownMtime,
  onConflict,
  onSaveGaveUp,
  setLastKnown,
  discardPending,
  loadNote,
  revealInFileManager,
  __resetSaveStateForTests,
} from "./notes-state";
import { invoke } from "@tauri-apps/api/core";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const mockedInvoke = invoke as unknown as ReturnType<typeof vi.fn>;
const okWrite = (mtime: number | null = null) => ({ conflict: false, mtime });

describe("inboxPath", () => {
  it("joins a POSIX project folder with _inbox.md", () => {
    expect(inboxPath("/Users/me/FloatNote/阅读笔记")).toBe(
      "/Users/me/FloatNote/阅读笔记/_inbox.md",
    );
  });

  it("joins a Windows project folder with a backslash", () => {
    expect(inboxPath("C:\\Users\\me\\FloatNote\\阅读笔记")).toBe(
      "C:\\Users\\me\\FloatNote\\阅读笔记\\_inbox.md",
    );
  });

  it("strips a trailing separator before joining", () => {
    expect(inboxPath("/Users/me/proj/")).toBe("/Users/me/proj/_inbox.md");
  });
});

describe("inboxEntry", () => {
  it("names the entry _inbox and points at the inbox file", () => {
    const entry = inboxEntry({ name: "阅读笔记", path: "/Users/me/proj" });
    expect(entry).toEqual({ name: "_inbox", path: "/Users/me/proj/_inbox.md" });
  });
});

describe("revealInFileManager", () => {
  it("asks the backend to reveal the selected project or document path", async () => {
    mockedInvoke.mockReset();
    mockedInvoke.mockResolvedValue(undefined);

    await revealInFileManager("/Users/me/FloatNote/项目 A");

    expect(mockedInvoke).toHaveBeenCalledWith("reveal_in_file_manager", {
      path: "/Users/me/FloatNote/项目 A",
    });
  });
});

describe("save scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockedInvoke.mockReset();
    __resetSaveStateForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps per-path timers independent (regression: switching files no longer drops the first file)", async () => {
    mockedInvoke.mockResolvedValue(okWrite(1000));
    scheduleSave("/a.md", "A1");
    await vi.advanceTimersByTimeAsync(100);
    scheduleSave("/b.md", "B1");
    await vi.advanceTimersByTimeAsync(400); // A 的 500ms 到
    expect(mockedInvoke).toHaveBeenCalledWith("write_note", {
      path: "/a.md",
      content: "A1",
      expectedMtime: null,
    });
    expect(isDirty("/a.md")).toBe(false);
    expect(isDirty("/b.md")).toBe(true);
    await vi.advanceTimersByTimeAsync(100); // B 的 500ms 到
    expect(mockedInvoke).toHaveBeenCalledWith("write_note", {
      path: "/b.md",
      content: "B1",
      expectedMtime: null,
    });
    expect(isDirty("/b.md")).toBe(false);
  });

  it("coalesces rapid edits on the same path to the last content", async () => {
    mockedInvoke.mockResolvedValue(okWrite());
    scheduleSave("/a.md", "v1");
    await vi.advanceTimersByTimeAsync(150);
    scheduleSave("/a.md", "v2");
    await vi.advanceTimersByTimeAsync(150);
    scheduleSave("/a.md", "v3");
    await vi.advanceTimersByTimeAsync(500);
    const calls = mockedInvoke.mock.calls.filter((c) => c[0] === "write_note");
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toMatchObject({ path: "/a.md", content: "v3" });
  });

  it("retries on io error with backoff and clears pending on eventual success", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("io")).mockResolvedValueOnce(okWrite(2000));
    scheduleSave("/a.md", "x");
    await vi.advanceTimersByTimeAsync(500); // 首次失败
    expect(isDirty("/a.md")).toBe(true);
    await vi.advanceTimersByTimeAsync(500); // 退避 1 后成功
    expect(isDirty("/a.md")).toBe(false);
  });

  it("saveImmediate writes without waiting for the debounce timer", async () => {
    mockedInvoke.mockResolvedValue(okWrite(3000));
    await saveImmediate("/a.md", "now");
    expect(mockedInvoke).toHaveBeenCalledWith("write_note", {
      path: "/a.md",
      content: "now",
      expectedMtime: null,
    });
    expect(isDirty("/a.md")).toBe(false);
  });

  it("rejects an immediate save that was not persisted before its retry", async () => {
    mockedInvoke.mockRejectedValueOnce(new Error("io")).mockResolvedValueOnce(okWrite(3001));

    await expect(saveImmediate("/a.md", "draft before restore")).rejects.toThrow(
      "save did not persist",
    );
    expect(isDirty("/a.md")).toBe(true);
    expect(mockedInvoke).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(isDirty("/a.md")).toBe(false);
  });

  it("flushAll flushes every pending path immediately", async () => {
    mockedInvoke.mockResolvedValue(okWrite());
    scheduleSave("/a.md", "A");
    scheduleSave("/b.md", "B");
    flushAll();
    await vi.advanceTimersByTimeAsync(0);
    expect(mockedInvoke).toHaveBeenCalledWith("write_note", {
      path: "/a.md",
      content: "A",
      expectedMtime: null,
    });
    expect(mockedInvoke).toHaveBeenCalledWith("write_note", {
      path: "/b.md",
      content: "B",
      expectedMtime: null,
    });
  });

  it("onConflict handler is called and pending retained when write reports conflict", async () => {
    mockedInvoke.mockResolvedValue({ conflict: true, mtime: null });
    const handler = vi.fn();
    onConflict(handler);
    scheduleSave("/a.md", "local");
    await vi.advanceTimersByTimeAsync(500);
    expect(handler).toHaveBeenCalledWith("/a.md", "local");
    expect(isDirty("/a.md")).toBe(true);
  });

  it("discardPending clears a path's pending state", async () => {
    mockedInvoke.mockResolvedValue(okWrite());
    scheduleSave("/a.md", "x");
    discardPending("/a.md");
    expect(isDirty("/a.md")).toBe(false);
  });

  it("loadNote records mtime and scheduleSave passes it as expectedMtime", async () => {
    mockedInvoke.mockResolvedValueOnce({ content: "disk", mtime: 42 });
    const content = await loadNote("/a.md");
    expect(content).toBe("disk");
    expect(lastKnownMtime("/a.md")).toBe(42);
    mockedInvoke.mockResolvedValueOnce(okWrite(43));
    scheduleSave("/a.md", "edited");
    await vi.advanceTimersByTimeAsync(500);
    expect(mockedInvoke).toHaveBeenLastCalledWith("write_note", {
      path: "/a.md",
      content: "edited",
      expectedMtime: 42,
    });
  });

  it("saveImmediate force write passes expectedMtime null", async () => {
    mockedInvoke.mockResolvedValue(okWrite(50));
    setLastKnown("/a.md", 42);
    await saveImmediate("/a.md", "force", { force: true });
    expect(mockedInvoke).toHaveBeenCalledWith("write_note", {
      path: "/a.md",
      content: "force",
      expectedMtime: null,
    });
  });

  it("saveImmediate waits for an in-flight autosave on the same path", async () => {
    let resolveFirst!: (value: ReturnType<typeof okWrite>) => void;
    mockedInvoke.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
    scheduleSave("/a.md", "current");
    await vi.advanceTimersByTimeAsync(500);

    const immediate = saveImmediate("/a.md", "current");
    expect(mockedInvoke).toHaveBeenCalledTimes(1);
    resolveFirst(okWrite(60));
    await immediate;

    expect(mockedInvoke).toHaveBeenCalledTimes(1);
  });

  it("allows conflict resolution to force-save without waiting on itself", async () => {
    mockedInvoke
      .mockResolvedValueOnce({ conflict: true, mtime: null })
      .mockResolvedValueOnce(okWrite(61));
    onConflict(async (path, content) => {
      await saveImmediate(path, content, { force: true });
    });
    scheduleSave("/a.md", "mine");
    await vi.advanceTimersByTimeAsync(500);

    await settlePendingWrites("/a.md");

    expect(mockedInvoke).toHaveBeenCalledTimes(2);
    expect(isDirty("/a.md")).toBe(false);
  });

  it("settleAllPendingWrites flushes every pending path and resolves after completion", async () => {
    mockedInvoke.mockResolvedValue(okWrite(100));
    scheduleSave("/a.md", "A");
    scheduleSave("/b.md", "B");

    await settleAllPendingWrites();

    expect(mockedInvoke).toHaveBeenCalledWith("write_note", {
      path: "/a.md",
      content: "A",
      expectedMtime: null,
    });
    expect(mockedInvoke).toHaveBeenCalledWith("write_note", {
      path: "/b.md",
      content: "B",
      expectedMtime: null,
    });
    expect(isDirty("/a.md")).toBe(false);
    expect(isDirty("/b.md")).toBe(false);
  });

  it("onSaveGaveUp fires once retries are exhausted; pending is retained for the UI to decide", async () => {
    mockedInvoke.mockRejectedValue(new Error("io"));
    const gaveUp = vi.fn();
    onSaveGaveUp(gaveUp);
    scheduleSave("/a.md", "x");

    await vi.advanceTimersByTimeAsync(500); // 首次失败
    await vi.advanceTimersByTimeAsync(500); // 退避 1 失败
    await vi.advanceTimersByTimeAsync(1000); // 退避 2 失败
    expect(gaveUp).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2000); // 退避 3 失败 → 放弃
    expect(gaveUp).toHaveBeenCalledTimes(1);
    expect(gaveUp).toHaveBeenCalledWith("/a.md", "x");
    // notes-state 不擅自丢用户内容：pending 保留，由 UI 兜底丢弃。
    expect(isDirty("/a.md")).toBe(true);
  });

  it("does not report gave-up when a retry eventually succeeds", async () => {
    mockedInvoke
      .mockRejectedValueOnce(new Error("io"))
      .mockRejectedValueOnce(new Error("io"))
      .mockResolvedValueOnce(okWrite(7));
    const gaveUp = vi.fn();
    onSaveGaveUp(gaveUp);
    scheduleSave("/a.md", "x");

    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);

    expect(gaveUp).not.toHaveBeenCalled();
    expect(isDirty("/a.md")).toBe(false);
  });
});

describe("update save barrier", () => {
  beforeEach(() => { __resetSaveStateForTests(); mockedInvoke.mockReset(); });
  afterEach(() => { __resetSaveStateForTests(); });
  it("persists queued content before permitting installation", async () => {
    mockedInvoke.mockResolvedValue(okWrite(42));
    scheduleSave("/a.md", "latest draft");
    await saveBeforeUpdate();
    expect(isDirty("/a.md")).toBe(false);
    expect(mockedInvoke).toHaveBeenCalledWith("write_note", expect.objectContaining({ content: "latest draft" }));
  });
  it("blocks installation and retains edits after a disk failure", async () => {
    mockedInvoke.mockRejectedValue(new Error("disk full"));
    scheduleSave("/a.md", "keep this");
    await expect(saveBeforeUpdate()).rejects.toThrow("仍有笔记未保存");
    expect(isDirty("/a.md")).toBe(true);
  });
});
