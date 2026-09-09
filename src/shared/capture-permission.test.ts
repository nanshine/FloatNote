// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { captureStatusText, mountCapturePermission } from "./capture-permission";

describe("capture availability messages", () => {
  it("distinguishes trust failure from monitor failure", () => {
    expect(captureStatusText({ permission: "required", monitor: "blocked" })).toBe("划线采集待授权");
    expect(captureStatusText({ permission: "granted", monitor: "failed" })).toBe("划线工具栏启动失败");
  });
  it("does not claim the disabled automatic toolbar is running", () => {
    expect(captureStatusText({ permission: "granted", monitor: "off" })).toContain("已关闭");
    expect(captureStatusText({ permission: "granted", monitor: "running" })).toBe("划线采集已就绪");
  });
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));
vi.mock("../platform/onboarding", () => ({ requestCapturePermission: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
import { requestCapturePermission } from "../platform/onboarding";
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); document.body.replaceChildren(); vi.clearAllMocks(); });

it("keeps dismissed guidance collapsed on refresh, and reports settings launch errors", async () => {
  vi.mocked(invoke).mockResolvedValue({ permission: "required", monitor: "blocked" });
  vi.mocked(requestCapturePermission).mockRejectedValue(new Error("请手动打开系统设置"));
  cleanup = mountCapturePermission(document.body, true);
  await vi.waitFor(() => expect(document.querySelector("[data-status]")?.textContent).toContain("待授权"));
  document.querySelector<HTMLButtonElement>("[data-status]")!.click();
  document.querySelector<HTMLButtonElement>("[data-open]")!.click();
  await vi.waitFor(() => expect(document.querySelector("[data-error]")?.textContent).toContain("手动打开"));
  document.querySelector<HTMLButtonElement>("[data-dismiss]")!.click();
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(document.querySelector<HTMLElement>("[data-detail]")!.hidden).toBe(true);
});

it("hides the macOS permission entry on Windows", async () => {
  vi.mocked(invoke).mockResolvedValue({ permission: "not_required", monitor: "running" });
  cleanup = mountCapturePermission(document.body);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalled());
  expect(document.querySelector<HTMLElement>(".capture-permission")!.hidden).toBe(true);
});
