import { invoke } from "@tauri-apps/api/core";
import { withAppState } from "../platform/startup";
import { listen } from "@tauri-apps/api/event";
import { requestCapturePermission, type CapturePermissionState } from "../platform/onboarding";
import { showToast } from "./toast";

export interface CaptureAvailability { permission: CapturePermissionState; monitor: "off" | "blocked" | "running" | "failed" }
export function captureStatusText(state: CaptureAvailability): string {
  if (state.permission === "required") return "划线采集待授权";
  if (state.monitor === "failed") return "划线工具栏启动失败";
  if (state.monitor === "off") return "自动划线工具栏已关闭";
  return "划线采集已就绪";
}

/** A persistent entry, with an expanded explanation only on explicit interaction. */
export function mountCapturePermission(root: HTMLElement, compact = false): () => void {
  const style = document.createElement("style");
  style.textContent = `.capture-permission{font-size:12px;line-height:1.7;color:var(--color-text);background:var(--color-surface);border:1px solid var(--color-border);border-radius:10px;padding:12px}.capture-permission[hidden]{display:none}.capture-permission button{font:inherit;color:inherit;background:var(--color-surface-2);border:1px solid var(--color-border);border-radius:6px;padding:6px 10px;cursor:pointer}.capture-permission p{margin:8px 0}.capture-permission-actions{display:flex;gap:8px;flex-wrap:wrap}.capture-permission-compact{position:fixed;bottom:12px;right:12px;z-index:90;max-width:min(340px,calc(100vw - 48px))}`;
  root.append(style);
  const card = document.createElement("section");
  card.className = `capture-permission${compact ? " capture-permission-compact" : ""}`;
  card.hidden = true;
  card.setAttribute("aria-label", "划线采集权限");
  card.innerHTML = `<button type="button" data-status aria-expanded="false"></button><div data-detail hidden><p data-purpose>FloatNote 需要辅助功能权限，才能获取其他应用中选中的文字，并在旁边显示划线工具栏。</p><p data-instructions>请在「系统设置 → 隐私与安全性 → 辅助功能」中开启 FloatNote。暂不开启也可以继续写笔记和手动粘贴。</p><div class="capture-permission-actions"><button type="button" data-open>打开系统设置</button><button type="button" data-retry>重新检测</button><button type="button" data-dismiss>暂时不用</button></div><p data-error role="status"></p></div>`;
  root.append(card);
  const status = card.querySelector<HTMLButtonElement>("[data-status]")!;
  const detail = card.querySelector<HTMLElement>("[data-detail]")!;
  const open = card.querySelector<HTMLButtonElement>("[data-open]")!;
  const error = card.querySelector<HTMLElement>("[data-error]")!;
  let previous: CaptureAvailability | undefined;
  let wasGranted = false;
  let busy = false;
  let disposed = false;
  const expand = (value: boolean) => { detail.hidden = !value; status.setAttribute("aria-expanded", String(value)); };
  async function refresh() {
    if (busy || disposed) return;
    busy = true;
    try {
      const next = await withAppState(() => invoke<CaptureAvailability>("refresh_capture_availability"));
      if (disposed) return;
      const recovered = previous?.permission === "required" && next.permission === "granted";
      previous = next;
      card.hidden = (next.permission === "not_required" && next.monitor !== "failed") || (compact && next.permission !== "required" && next.monitor !== "failed");
      status.textContent = next.permission === "required" && wasGranted ? "辅助功能权限已关闭" : captureStatusText(next);
      wasGranted ||= next.permission === "granted";
      card.querySelector<HTMLElement>("[data-purpose]")!.hidden = next.permission !== "required";
      card.querySelector<HTMLElement>("[data-instructions]")!.hidden = next.permission !== "required";
      open.hidden = next.permission !== "required";
      error.textContent = next.monitor === "failed" ? "权限已开启，但工具栏未能启动。请重新检测，仍失败时重启 FloatNote。" : "";
      if (recovered && compact) showToast(next.monitor === "running" ? "划线采集已就绪，重新划选一段文字试试" : captureStatusText(next));
      if (!compact) expand(true);
    } catch (reason) {
      if (disposed) return;
      card.hidden = false;
      status.textContent = "无法检测划线采集状态";
      card.querySelector<HTMLElement>("[data-purpose]")!.hidden = true;
      card.querySelector<HTMLElement>("[data-instructions]")!.hidden = true;
      open.hidden = true;
      error.textContent = "请重新检测，仍失败时重启 FloatNote。可以继续写笔记和手动粘贴。";
      console.error("Capture availability check failed", reason);
      expand(true);
    } finally { busy = false; }
  }
  status.onclick = () => expand(detail.hidden);
  card.querySelector<HTMLButtonElement>("[data-dismiss]")!.onclick = () => expand(false);
  card.querySelector<HTMLButtonElement>("[data-retry]")!.onclick = () => void refresh();
  open.onclick = async () => {
    open.disabled = true;
    try { await requestCapturePermission(); } catch (reason) { error.textContent = String(reason); }
    finally { open.disabled = false; }
  };
  const focus = () => void refresh();
  window.addEventListener("focus", focus);
  const timer = window.setInterval(() => { if (document.visibilityState === "visible" && document.hasFocus() && previous?.monitor !== "failed") void refresh(); }, 3000);
  const subscription = compact ? listen("accessibility-needed", () => { card.hidden = false; expand(true); void refresh(); }) : Promise.resolve(() => {});
  void refresh();
  return () => { disposed = true; clearInterval(timer); window.removeEventListener("focus", focus); void subscription.then((stop) => stop()); card.remove(); style.remove(); };
}
