import { onShowUpdateSettings, onUpdateStatus, requestUpdate, type UpdateStatus } from "../platform/updates";

export async function mountUpdates(root: HTMLElement): Promise<() => void> {
  root.innerHTML = `<div class="settings-card"><div class="settings-line">
    <div><strong>应用更新</strong><small data-update-status role="status">正在读取版本…</small></div>
    <button class="settings-text-button" type="button" data-update-check>检查更新</button>
    </div><div class="update-details"><p data-update-error role="alert" hidden></p>
    <pre data-update-notes hidden></pre><progress data-update-progress aria-label="更新下载进度" hidden></progress>
    <button class="settings-text-button" type="button" data-update-install hidden>下载并更新</button></div></div>`;
  const text = root.querySelector<HTMLElement>("[data-update-status]")!;
  const error = root.querySelector<HTMLElement>("[data-update-error]")!;
  const notes = root.querySelector<HTMLElement>("[data-update-notes]")!;
  const progress = root.querySelector<HTMLProgressElement>("progress")!;
  const check = root.querySelector<HTMLButtonElement>("[data-update-check]")!;
  const install = root.querySelector<HTMLButtonElement>("[data-update-install]")!;
  const render = (status: UpdateStatus) => {
    const busy = ["checking", "downloading", "preparing", "installing"].includes(status.phase);
    check.disabled = busy;
    install.disabled = busy;
    install.hidden = !status.info?.version;
    error.hidden = !status.error;
    error.textContent = status.error ?? "";
    notes.hidden = !status.info?.notes;
    notes.textContent = status.info?.notes ?? "";
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
    catch (reason) { error.hidden = false; error.textContent = String(reason); }
  };
  check.onclick = () => void send("check");
  install.onclick = () => void send("install");
  const unlisten = await onUpdateStatus(render);
  const stopNavigation = await onShowUpdateSettings(() => {
    root.closest(".settings-window")?.querySelector<HTMLButtonElement>('[data-tab="general"]')?.click();
    root.scrollIntoView({ block: "nearest" });
  });
  await send("snapshot");
  return () => { unlisten(); stopNavigation(); };
}
