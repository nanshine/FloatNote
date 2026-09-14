import "../../../src/styles/index.css";
import "../../../src/settings/styles.css";
import "@phosphor-icons/web/regular";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { settingsShellMarkup, mountTabs } from "../../../src/settings/shell";
import { mountUpdates } from "../../../src/settings/updates";
import { publishUpdateStatus } from "../../../src/platform/updates";
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const state = params.get("state") === "error" ? "error" : "available";
mockWindows("main");
mockIPC(() => null, { shouldMockEvents: true });
const root = document.querySelector<HTMLElement>("#app")!;
root.innerHTML = settingsShellMarkup();
mountTabs(root);
const info = { configured: true, currentVersion: "0.1.0", version: "0.2.0", notes: "## 新功能\n- 支持**应用内更新**，下载后自动保存笔记并重启。\n- 使用 `快捷键` 快速记录。\n\n## 修复\n改善笔记保存的可靠性。\n\n[完整更新说明](https://example.com/releases)\n\n```text\nFloatNote 更新完成\n```" };
await mountUpdates(root.querySelector<HTMLElement>("#update-settings")!);
// Tauri's event mock supports emit but not emit_to; simulate the coordinator here.
root.querySelector("[data-update-install]")!.addEventListener("click", () => {
  void publishUpdateStatus({ phase: "downloading", info, progress: { downloaded: 40, total: 100 } });
});
await publishUpdateStatus(state === "error"
  ? { phase: "error", error: "Could not fetch a valid release JSON from the remote" }
  : { phase: "available", info });
document.body.dataset.reviewReady = "true";
