import { mountCapturePermission } from "../shared/capture-permission";
import { listen } from "@tauri-apps/api/event";
import { showToast } from "../shared/toast";

/** Persistent capture permission guidance plus deduplicated browser automation notices. */
export function attachAutomationToasts() {
  mountCapturePermission(document.body, true);

  let lastAutomationToastAt = 0;

  void listen("automation-needed", () => {
    // 后端识别到当前前台是已知浏览器，但 osascript 读不到标签页 URL/标题
    // （macOS 自动化权限未授/被拒/超时）。提示用户去授权，授权后即可恢复
    // 网址+标题捕获；本条引用仍会以"仅 app 名"落地。
    const now = Date.now();
    if (now - lastAutomationToastAt < 30_000) return;
    lastAutomationToastAt = now;
    showToast("浏览器授权未完成，已先保存为应用来源；授权后重试即可");
  });
}
