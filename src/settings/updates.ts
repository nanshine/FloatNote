import { onShowUpdateSettings, onUpdateStatus, requestUpdate, type UpdateStatus } from "../platform/updates";
import { createIcon } from "../shared/ui/icon";
import { fillMarkdown } from "../shared/markdown/render";

function updateErrorCopy(error: string, hasUpdate: boolean): { title: string; message: string } {
  if (/valid release json/i.test(error)) {
    return {
      title: "无法读取更新信息",
      message: "更新服务暂时没有返回有效内容，请稍后重试。",
    };
  }
  return hasUpdate
    ? { title: "更新未完成", message: "安装包没有成功处理，你可以安全地重试。" }
    : { title: "无法检查更新", message: "请确认网络连接正常，然后重试。" };
}

export async function mountUpdates(root: HTMLElement): Promise<() => void> {
  root.innerHTML = `<div class="settings-card update-card" data-update-phase="idle"><div class="settings-line update-summary">
    <div><strong>应用更新</strong><small data-update-status role="status">正在读取版本…</small></div>
    <button class="settings-text-button update-check" type="button" data-update-check>${createIcon({ phosphor: "ph ph-arrow-clockwise" }).outerHTML}<span>检查更新</span></button>
    </div><div class="update-details">
    <div class="update-error" data-update-error role="alert" hidden>
      <span class="update-error-mark" aria-hidden="true">${createIcon({ phosphor: "ph ph-warning-circle" }).outerHTML}</span>
      <div class="update-error-copy"><strong data-update-error-title></strong><p data-update-error-message></p>
        <details><summary>查看技术详情</summary><code data-update-error-details></code></details>
      </div>
      <button class="settings-text-button update-retry" type="button" data-update-retry>${createIcon({ phosphor: "ph ph-arrow-clockwise" }).outerHTML}<span>重试</span></button>
    </div>
    <div class="update-notes" data-update-notes role="region" aria-label="更新说明" tabindex="0" hidden></div><progress data-update-progress aria-label="更新下载进度" hidden></progress>
    <button class="settings-text-button update-install" type="button" data-update-install hidden>${createIcon({ phosphor: "ph ph-download-simple" }).outerHTML}<span>下载并更新</span></button></div></div>`;
  const card = root.querySelector<HTMLElement>(".update-card")!;
  const text = root.querySelector<HTMLElement>("[data-update-status]")!;
  const errorPanel = root.querySelector<HTMLElement>("[data-update-error]")!;
  const errorTitle = root.querySelector<HTMLElement>("[data-update-error-title]")!;
  const errorMessage = root.querySelector<HTMLElement>("[data-update-error-message]")!;
  const errorDetails = root.querySelector<HTMLElement>("[data-update-error-details]")!;
  const notes = root.querySelector<HTMLElement>("[data-update-notes]")!;
  const progress = root.querySelector<HTMLProgressElement>("progress")!;
  const check = root.querySelector<HTMLButtonElement>("[data-update-check]")!;
  const install = root.querySelector<HTMLButtonElement>("[data-update-install]")!;
  const retry = root.querySelector<HTMLButtonElement>("[data-update-retry]")!;
  let retryRequest: "check" | "install" = "check";
  let renderedNotes = "";
  const showError = (message: string, hasUpdate: boolean) => {
    const copy = updateErrorCopy(message, hasUpdate);
    errorPanel.hidden = false;
    errorTitle.textContent = copy.title;
    errorMessage.textContent = copy.message;
    errorDetails.textContent = message;
    retryRequest = hasUpdate ? "install" : "check";
  };
  const render = (status: UpdateStatus) => {
    const busy = ["checking", "downloading", "preparing", "installing"].includes(status.phase);
    card.dataset.updatePhase = status.phase;
    card.setAttribute("aria-busy", String(busy));
    check.disabled = busy;
    install.disabled = busy;
    install.hidden = !status.info?.version;
    errorPanel.hidden = !status.error;
    if (status.error) showError(status.error, Boolean(status.info?.version));
    const content = status.info?.notes ?? "";
    notes.hidden = !content.trim();
    if (content !== renderedNotes) {
      fillMarkdown(notes, content);
      notes.scrollTop = 0;
      renderedNotes = content;
    }
    progress.hidden = status.phase !== "downloading";
    if (status.progress?.total) {
      progress.max = status.progress.total;
      progress.value = status.progress.downloaded;
    } else progress.removeAttribute("value");
    const labels: Record<UpdateStatus["phase"], string> = {
      idle: !status.info ? "尚未检查更新" : status.info.configured === false ? "此构建尚未启用在线更新" : "已是最新版本",
      checking: "正在检查更新…", available: `发现新版本 ${status.info?.version}`,
      downloading: "正在下载更新…", preparing: "正在保存笔记…", installing: "正在安装，即将重启…", error: "更新未完成，可以重试",
    };
    text.textContent = `${status.info?.currentVersion ? `当前版本 ${status.info.currentVersion} · ` : ""}${labels[status.phase]}`;
    // Prevent settings edits while the main webview flushes and installs.
    root.closest<HTMLElement>(".settings-window")?.querySelectorAll<HTMLElement>(".settings-section").forEach((section) => {
      if (!section.contains(root)) section.inert = status.phase === "preparing" || status.phase === "installing";
    });
  };
  const send = async (request: "check" | "install" | "snapshot") => {
    try { await requestUpdate(request); }
    catch (reason) { showError(String(reason), request === "install"); }
  };
  check.onclick = () => void send("check");
  install.onclick = () => void send("install");
  retry.onclick = () => void send(retryRequest);
  const unlisten = await onUpdateStatus(render);
  const stopNavigation = await onShowUpdateSettings(() => {
    root.closest(".settings-window")?.querySelector<HTMLButtonElement>('[data-tab="general"]')?.click();
    root.scrollIntoView({ block: "nearest" });
  });
  await send("snapshot");
  return () => { unlisten(); stopNavigation(); };
}
