import "../../../src/styles/index.css";
import "../../../src/settings/styles.css";
import "@phosphor-icons/web/regular";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { settingsShellMarkup, mountTabs } from "../../../src/settings/shell";
import { mountUpdates } from "../../../src/settings/updates";
import { publishUpdateStatus } from "../../../src/platform/updates";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
mockWindows("main");
mockIPC(() => null, { shouldMockEvents: true });
const root = document.querySelector<HTMLElement>("#app")!;
root.innerHTML = settingsShellMarkup();
mountTabs(root);
const info = { configured: true, currentVersion: "0.1.0", version: "0.2.0", notes: "新功能\n支持应用内更新，下载后自动保存笔记并重启。\n\n修复\n改善笔记保存的可靠性。" };
await mountUpdates(root.querySelector<HTMLElement>("#update-settings")!);
// Tauri's event mock supports emit but not emit_to; simulate the coordinator here.
root.querySelector("[data-update-install]")!.addEventListener("click", () => {
  void publishUpdateStatus({ phase: "downloading", info, progress: { downloaded: 40, total: 100 } });
});
await publishUpdateStatus({ phase: "available", info });
document.body.dataset.reviewReady = "true";
