// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { runStartup } from "./startup-shell";

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = new DOMParser().parseFromString(
    readFileSync(resolve(process.cwd(), "index.html"), "utf8"),
    "text/html",
  ).body.innerHTML;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("provides a recovery link before any application JavaScript runs", () => {
  expect(document.querySelector("#startup-message")?.textContent).toContain("正在打开笔记");
  expect(document.querySelector("#startup-shell a")?.getAttribute("href")).toBe("index.html");
  expect(document.querySelector("#app")?.hasAttribute("inert")).toBe(true);
});

it("reveals the finished application immediately without waiting 800ms", async () => {
  const reveal = vi.fn(async () => {
    expect(document.querySelector("#startup-shell")).toBeNull();
    expect(document.querySelector("#app")?.hasAttribute("inert")).toBe(false);
  });
  await runStartup(async () => {}, reveal);
  expect(reveal).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps the shell through slow startup and accepts eventual success", async () => {
  let finish!: () => void;
  const pending = runStartup(() => new Promise<void>((resolve) => { finish = resolve; }), async () => {});
  await vi.advanceTimersByTimeAsync(15_000);
  expect(document.querySelector("#startup-message")?.textContent).toContain("还需要一点时间");
  expect(document.querySelector("#app")?.hasAttribute("inert")).toBe(true);
  finish();
  await pending;
  expect(document.querySelector("#startup-shell")).toBeNull();
  expect(document.querySelector("#app")?.hasAttribute("inert")).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("preserves recovery and blocks partial UI when application loading fails", async () => {
  vi.spyOn(console, "error").mockImplementation(() => {});
  await runStartup(async () => { throw new Error("module failed"); }, async () => {});
  await vi.advanceTimersByTimeAsync(20_000);
  expect(document.querySelector("#startup-message")?.textContent).toContain("暂时无法打开笔记");
  expect(document.querySelector("#startup-shell a")).not.toBeNull();
  expect(document.querySelector("#app")?.hasAttribute("inert")).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});
