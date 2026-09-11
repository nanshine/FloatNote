// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCaptionButtons,
  customChromeEnabled,
  mountCaptionButtons,
  mountResizeEdges,
  syncMaximizeButton,
  wireDragRegionToggleMaximize,
} from "./window-caption";

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.classList.remove("custom-chrome", "window-maximized");
  // @ts-expect-error 清理测试注入的 Tauri 标记
  delete window.__TAURI_INTERNALS__;
});

describe("customChromeEnabled", () => {
  it("macOS 平台不启用", () => {
    expect(customChromeEnabled("MacIntel")).toBe(false);
  });

  it("Windows 但非 Tauri 运行时（浏览器 review）不启用", () => {
    expect(customChromeEnabled("Win32")).toBe(false);
  });

  it("Windows + Tauri 运行时启用", () => {
    // @ts-expect-error 模拟 Tauri 注入
    window.__TAURI_INTERNALS__ = {};
    expect(customChromeEnabled("Win32")).toBe(true);
  });

  it("jsdom 默认环境不启用", () => {
    expect(customChromeEnabled()).toBe(false);
  });
});

describe("createCaptionButtons", () => {
  it("按 最小化/最大化/关闭 顺序渲染，按钮带标题与图标类", () => {
    const group = createCaptionButtons({
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
    });
    const buttons = group.querySelectorAll<HTMLButtonElement>(".caption-btn");
    expect(buttons).toHaveLength(3);
    expect(buttons[0].classList.contains("caption-min")).toBe(true);
    expect(buttons[1].classList.contains("caption-max")).toBe(true);
    expect(buttons[2].classList.contains("caption-close")).toBe(true);
    expect(buttons[0].title).toBe("最小化");
    expect(buttons[1].title).toBe("最大化");
    expect(buttons[2].title).toBe("关闭");
    expect(buttons[1].querySelector("i")!.className).toContain("ph-square");
    expect(buttons[2].querySelector("i")!.className).toContain("ph-x");
  });

  it("点击分别触发注入的动作", () => {
    const actions = {
      minimize: vi.fn(),
      toggleMaximize: vi.fn(),
      close: vi.fn(),
    };
    const group = createCaptionButtons(actions);
    group.querySelector<HTMLButtonElement>(".caption-min")!.click();
    group.querySelector<HTMLButtonElement>(".caption-max")!.click();
    group.querySelector<HTMLButtonElement>(".caption-close")!.click();
    expect(actions.minimize).toHaveBeenCalledTimes(1);
    expect(actions.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(actions.close).toHaveBeenCalledTimes(1);
  });
});

describe("syncMaximizeButton", () => {
  it("最大化时切换为还原图标与文案", () => {
    const group = createCaptionButtons({
      minimize: () => {},
      toggleMaximize: () => {},
      close: () => {},
    });
    const btn = group.querySelector<HTMLButtonElement>(".caption-max")!;
    syncMaximizeButton(group, true);
    expect(btn.querySelector("i")!.className).toContain("ph-copy");
    expect(btn.title).toBe("还原");
    expect(btn.getAttribute("aria-label")).toBe("还原");
    syncMaximizeButton(group, false);
    expect(btn.querySelector("i")!.className).toContain("ph-square");
    expect(btn.title).toBe("最大化");
  });
});

describe("Tauri 绑定入口在非 Windows 环境早退", () => {
  it("mountCaptionButtons 不动 DOM、不加 custom-chrome 类", () => {
    const container = document.createElement("div");
    expect(mountCaptionButtons(container)).toBe(false);
    expect(container.children).toHaveLength(0);
    expect(document.documentElement.classList.contains("custom-chrome")).toBe(false);
  });

  it("wireDragRegionToggleMaximize 不挂监听", () => {
    const region = document.createElement("div");
    expect(wireDragRegionToggleMaximize(region)).toBe(false);
  });

  it("mountResizeEdges 不加热区", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    expect(mountResizeEdges(host)).toBe(false);
    expect(host.querySelectorAll(".resize-edge")).toHaveLength(0);
  });
});
