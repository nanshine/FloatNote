// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { requestCapturePermission } from "../platform/onboarding";
import { mountCapturePermissionSettings } from "./capture-permission";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../platform/onboarding", () => ({ requestCapturePermission: vi.fn() }));
let controller: ReturnType<typeof mountCapturePermissionSettings>;
afterEach(() => { controller?.dispose(); document.body.replaceChildren(); vi.resetAllMocks(); });
async function mount(permission: string, monitor: string) {
  vi.mocked(invoke).mockResolvedValue({ permission, monitor });
  controller = mountCapturePermissionSettings(document.body);
  await vi.waitFor(() => expect(document.querySelector("[data-status]")?.textContent).not.toBe(""));
  return document.querySelector<HTMLButtonElement>("[data-action]")!;
}
it("offers setup and preserves the manual path across refreshes if opening settings fails", async () => {
  const button = await mount("required", "blocked");
  expect(button.textContent).toBe("前往开启");
  vi.mocked(requestCapturePermission).mockRejectedValue(new Error("launch failed"));
  button.click();
  await vi.waitFor(() => expect(document.querySelector("[data-error]")?.textContent).toContain("系统设置"));
  await controller.refresh();
  expect(document.querySelector("[data-error]")?.textContent).toContain("系统设置");
  vi.mocked(invoke).mockResolvedValue({ permission: "granted", monitor: "off" });
  await controller.refresh();
  expect(button.hidden).toBe(true);
  expect(document.querySelector("[data-status]")?.textContent).toBe("辅助功能已授权");
  expect(document.querySelector("[data-error]")?.textContent).toBe("");
});
it("retries monitor failures without requesting permission", async () => {
  const button = await mount("granted", "failed");
  expect(button.textContent).toBe("重试");
  button.click();
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledTimes(2));
  expect(requestCapturePermission).not.toHaveBeenCalled();
});
it("offers detection retry after a read failure", async () => {
  const button = await mount("granted", "running");
  vi.mocked(invoke).mockRejectedValue(new Error("offline"));
  await controller.refresh();
  expect(button.hidden).toBe(false);
  expect(button.textContent).toBe("重新检测");
});
it("omits macOS permissions on Windows", async () => {
  await mount("not_required", "running");
  expect(document.body.hidden).toBe(true);
});
