import { confirm } from "@tauri-apps/plugin-dialog";
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { createUpdateController } from "../shared/updates/controller";
import { showToast } from "../shared/toast";
import * as updates from "../platform/updates";
import { saveBeforeUpdate } from "./notes-state";

let preparing = false;
export const isPreparingUpdate = () => preparing;

export async function startUpdates(): Promise<void> {
  const controller = createUpdateController({
    check: updates.checkUpdate,
    download: updates.downloadUpdate,
    prepare: updates.prepareUpdate,
    save: saveBeforeUpdate,
    install: updates.installUpdate,
    release: updates.releaseUpdate,
    confirm: () => confirm("下载完成后将保存笔记、安装更新并重启 FloatNote。请先保存设置中尚未提交的修改。", {
      title: "更新 FloatNote", kind: "info", okLabel: "下载并更新", cancelLabel: "稍后",
    }),
    freeze: (frozen) => {
      preparing = frozen;
      document.querySelector<HTMLElement>("#app")!.inert = frozen;
    },
    publish: (status) => { void updates.publishUpdateStatus(status).catch(console.error); },
    notify: (version) => showToast(`FloatNote ${version} 已可更新`, {
      label: "查看更新",
      onClick: () => { void (async () => {
        const settings = await WebviewWindow.getByLabel("settings");
        await settings?.show();
        await settings?.setFocus();
        await updates.showUpdateSettings();
      })().catch(console.error); },
    }),
  });
  await updates.onUpdateRequest((request) => {
    if (request === "snapshot") controller.snapshot();
    else if (request === "check") void controller.check(true);
    else if (request === "install") void controller.install();
  });
  setTimeout(() => void controller.check(), 10_000);
  setInterval(() => void controller.check(), 4 * 60 * 60 * 1000);
}
