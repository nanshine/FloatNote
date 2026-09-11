import { invoke } from "@tauri-apps/api/core";
import { requestCapturePermission } from "../platform/onboarding";
import type { CaptureAvailability } from "../shared/capture-permission";

/** Settings use an inline status row; the note window retains its actionable card. */
export function mountCapturePermissionSettings(root: HTMLElement) {
  root.hidden = true;
  root.innerHTML = `<div class="settings-line capture-permission-line"><div><strong>辅助功能权限</strong><small data-status role="status"></small><small data-description></small></div><button type="button" class="settings-text-button" data-action hidden></button></div><p class="settings-inline-error" data-error role="status"></p>`;
  const status = root.querySelector<HTMLElement>("[data-status]")!;
  const description = root.querySelector<HTMLElement>("[data-description]")!;
  const action = root.querySelector<HTMLButtonElement>("[data-action]")!;
  const error = root.querySelector<HTMLElement>("[data-error]")!;
  let state: CaptureAvailability | undefined;
  let busy = false;
  let disposed = false;
  let launchError = "";

  async function refresh() {
    if (busy || disposed) return;
    busy = true;
    action.disabled = true;
    try {
      const next = await invoke<CaptureAvailability>("refresh_capture_availability");
      if (disposed) return;
      state = next;
      root.hidden = next.permission === "not_required";
      const required = next.permission === "required";
      const failed = next.monitor === "failed";
      status.textContent = required ? "未开启辅助功能权限" : failed ? "选中文字弹窗暂不可用" : "辅助功能已授权";
      status.dataset.state = required || failed ? "warning" : "ready";
      description.textContent = required ? "开启后可使用划词采集和选中文字弹窗" : failed ? "辅助功能已授权，请重试" : "";
      description.hidden = !description.textContent;
      action.hidden = !required && !failed;
      action.textContent = required ? "前往开启" : "重试";
      if (!required) launchError = "";
      error.textContent = launchError;
    } catch {
      if (disposed) return;
      state = undefined;
      root.hidden = false;
      status.textContent = "无法确认辅助功能权限";
      status.dataset.state = "warning";
      description.hidden = true;
      action.hidden = false;
      action.textContent = "重新检测";
    } finally {
      busy = false;
      action.disabled = false;
    }
  }

  action.onclick = async () => {
    if (state?.permission !== "required") { await refresh(); return; }
    action.disabled = true;
    try {
      await requestCapturePermission();
      launchError = "";
      error.textContent = "";
    } catch {
      launchError = "请手动打开「系统设置 → 隐私与安全性 → 辅助功能」，开启 FloatNote。";
      error.textContent = launchError;
    } finally { action.disabled = false; }
  };
  const onFocus = () => void refresh();
  window.addEventListener("focus", onFocus);
  const timer = window.setInterval(() => {
    if (document.visibilityState === "visible" && document.hasFocus() && state?.monitor !== "failed") void refresh();
  }, 3000);
  void refresh();
  return {
    refresh,
    dispose() { disposed = true; clearInterval(timer); window.removeEventListener("focus", onFocus); },
  };
}
