// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { mountUpdates } from "./updates";
import { onUpdateStatus, requestUpdate, type UpdateStatus } from "../platform/updates";
vi.mock("../platform/updates", () => ({ onShowUpdateSettings: vi.fn().mockResolvedValue(() => {}), onUpdateStatus: vi.fn(), requestUpdate: vi.fn().mockResolvedValue(undefined) }));
it("renders untrusted notes as text, unknown download size and retryable failure", async () => {
  let render!: (status: UpdateStatus) => void;
  vi.mocked(onUpdateStatus).mockImplementation(async (handler) => { render = handler; return () => {}; });
  const root = document.createElement("div");
  await mountUpdates(root);
  expect(requestUpdate).toHaveBeenCalledWith("snapshot");
  const info = { configured: true, currentVersion: "0.1.0", version: "0.2.0", notes: "<img src=x onerror=alert(1)>" };
  render({ phase: "downloading", info, progress: { downloaded: 2, total: null } });
  expect(root.querySelector("img")).toBeNull();
  expect(root.querySelector("pre")?.textContent).toBe(info.notes);
  expect(root.querySelector("progress")?.hasAttribute("value")).toBe(false);
  expect(root.querySelector<HTMLButtonElement>("[data-update-install]")?.disabled).toBe(true);
  render({ phase: "error", info, error: "network failed" });
  const button = root.querySelector<HTMLButtonElement>("[data-update-install]")!;
  expect(button.disabled).toBe(false);
  expect(root.querySelector("[data-update-error-title]")?.textContent).toBe("更新未完成");
  expect(root.querySelector("[data-update-error-details]")?.textContent).toBe("network failed");
  root.querySelector<HTMLButtonElement>("[data-update-retry]")!.click();
  expect(requestUpdate).toHaveBeenCalledWith("install");
});

it("localizes an invalid feed response and offers a check retry", async () => {
  let render!: (status: UpdateStatus) => void;
  vi.mocked(onUpdateStatus).mockImplementation(async (handler) => { render = handler; return () => {}; });
  const root = document.createElement("div");
  await mountUpdates(root);
  render({ phase: "error", error: "Could not fetch a valid release JSON from the remote" });
  expect(root.querySelector(".update-card")?.getAttribute("aria-busy")).toBe("false");
  expect(root.querySelector("[data-update-error-title]")?.textContent).toBe("无法读取更新信息");
  expect(root.querySelector("[data-update-error-message]")?.textContent).toContain("稍后重试");
  expect(root.querySelector("[data-update-error-details]")?.textContent).toContain("valid release JSON");
  root.querySelector<HTMLButtonElement>("[data-update-retry]")!.click();
  expect(requestUpdate).toHaveBeenCalledWith("check");
});
