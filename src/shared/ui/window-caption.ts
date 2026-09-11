import { getCurrentWindow } from "@tauri-apps/api/window";
import { createIcon } from "./icon";

/**
 * Windows 自绘窗口控件。Rust 侧（window_chrome.rs）已在 Windows 上去掉系统
 * 标题栏（左上角图标 + 系统色按钮区），这里补回与应用主题一致的
 * 最小化/最大化/关闭按钮、拖拽区双击最大化与边缘缩放手柄。
 * macOS 保留原生红绿灯，本模块所有入口在非 Windows 或非 Tauri 环境（如
 * 浏览器 review）一律早退、不动 DOM。
 */

const MAXIMIZE_ICON = "ph ph-square";
const RESTORE_ICON = "ph ph-copy";

/** 仅 Windows 且处于 Tauri 运行时返回 true。platform 可注入以便测试。 */
export function customChromeEnabled(platform?: string): boolean {
  const pf = platform ?? (typeof navigator !== "undefined" ? navigator.platform : "");
  return (
    /Win/i.test(pf) &&
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

export interface CaptionActions {
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
}

function captionButton(cls: string, title: string, phosphor: string): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = `caption-btn ${cls}`;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.appendChild(createIcon({ phosphor, size: 13 }));
  return btn;
}

/** 纯 DOM：三枚窗口按钮（最小化 / 最大化·还原 / 关闭），行为由调用方注入。 */
export function createCaptionButtons(actions: CaptionActions): HTMLElement {
  const group = document.createElement("div");
  group.className = "caption-buttons";
  const minimize = captionButton("caption-min", "最小化", "ph ph-minus");
  const maximize = captionButton("caption-max", "最大化", MAXIMIZE_ICON);
  const close = captionButton("caption-close", "关闭", "ph ph-x");
  minimize.addEventListener("click", actions.minimize);
  maximize.addEventListener("click", actions.toggleMaximize);
  close.addEventListener("click", actions.close);
  group.append(minimize, maximize, close);
  return group;
}

/** 按最大化状态切换最大化钮的图标（□ ↔ 双框）与文案。 */
export function syncMaximizeButton(group: HTMLElement, maximized: boolean): void {
  const btn = group.querySelector<HTMLButtonElement>(".caption-max");
  const icon = btn?.querySelector<HTMLElement>("i");
  if (!btn || !icon) return;
  icon.className = `fn-icon ${maximized ? RESTORE_ICON : MAXIMIZE_ICON}`;
  const title = maximized ? "还原" : "最大化";
  btn.title = title;
  btn.setAttribute("aria-label", title);
}

/**
 * 把自绘按钮组挂进标题栏容器，并随窗口尺寸变化同步最大化图标与
 * `html.window-maximized` 类（用于禁用边缘缩放）。非 Windows/Tauri 返回 false。
 */
export function mountCaptionButtons(container: HTMLElement): boolean {
  if (!customChromeEnabled()) return false;
  document.documentElement.classList.add("custom-chrome");
  const win = getCurrentWindow();
  const group = createCaptionButtons({
    minimize: () => void win.minimize(),
    toggleMaximize: () => void win.toggleMaximize(),
    close: () => void win.close(),
  });
  container.appendChild(group);
  const sync = async () => {
    const maximized = await win.isMaximized();
    syncMaximizeButton(group, maximized);
    document.documentElement.classList.toggle("window-maximized", maximized);
  };
  void sync();
  void win.onResized(() => void sync());
  return true;
}

/** 拖拽区双击 = 最大化/还原（Windows 习惯）。仅命中拖拽区自身时触发。 */
export function wireDragRegionToggleMaximize(region: HTMLElement): boolean {
  if (!customChromeEnabled()) return false;
  const win = getCurrentWindow();
  region.addEventListener("dblclick", (event) => {
    if (event.target !== region) return;
    void win.toggleMaximize();
  });
  return true;
}

/** startResizeDragging 的方向参数（@tauri-apps/api 未导出该类型，本地声明同名字面量联合）。 */
type ResizeDirection =
  | "East" | "North" | "NorthEast" | "NorthWest"
  | "South" | "SouthEast" | "SouthWest" | "West";

const EDGE_DIRECTIONS = {
  n: "North",
  s: "South",
  e: "East",
  w: "West",
  ne: "NorthEast",
  nw: "NorthWest",
  se: "SouthEast",
  sw: "SouthWest",
} as const satisfies Record<string, ResizeDirection>;

/**
 * 无边框窗口没有系统缩放手柄：补一圈边缘热区，mousedown 转交系统级
 * 拖拽缩放（保留 Aero Snap 行为）。最大化时由 CSS 隐藏热区。
 */
export function mountResizeEdges(host: HTMLElement = document.body): boolean {
  if (!customChromeEnabled()) return false;
  const win = getCurrentWindow();
  for (const [edge, direction] of Object.entries(EDGE_DIRECTIONS)) {
    const zone = document.createElement("div");
    zone.className = `resize-edge resize-edge-${edge}`;
    zone.addEventListener("mousedown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      void win.startResizeDragging(direction);
    });
    host.appendChild(zone);
  }
  return true;
}
