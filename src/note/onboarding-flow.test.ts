// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOnboardingController } from "./onboarding";
import type { OnboardingState } from "../platform/onboarding";

const mocks = vi.hoisted(() => ({
  state: { version: 1, status: "in_progress", step: "welcome", capture_succeeded: false } as OnboardingState,
  confirm: vi.fn(),
  save: vi.fn(),
  openSettings: vi.fn(),
  toggleShortcut: vi.fn(),
}));
vi.mock("./notes-state", () => ({ confirmDialog: mocks.confirm }));
vi.mock("../platform/onboarding", () => ({
  getOnboardingState: async () => mocks.state,
  setOnboardingState: async (value: OnboardingState) => { mocks.save(value); mocks.state = value; return value; },
  getOnboardingPreview: async () => null,
  getCapturePermissionState: async () => "granted",
  requestCapturePermission: async () => "granted",
  onOnboardingChanged: vi.fn(), onOnboardingPreviewChanged: vi.fn(), setOnboardingPreview: vi.fn(),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ show: vi.fn(), setFocus: vi.fn() }),
  currentMonitor: vi.fn(), LogicalSize: vi.fn(),
}));
const handlers: Array<[string, EventListenerOrEventListenerObject]> = [];
beforeEach(() => {
  mocks.state = { version: 1, status: "in_progress", step: "welcome", capture_succeeded: false };
  mocks.confirm.mockResolvedValue(true);
  mocks.save.mockReset();
  mocks.openSettings.mockReset().mockResolvedValue(undefined);
  mocks.toggleShortcut.mockReset().mockResolvedValue("Alt+Ctrl+N");
  const original = window.addEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation((type, listener, options) => {
    handlers.push([type, listener]); original(type, listener, options);
  });
  document.body.innerHTML = '<div id="app"><button class="seg-btn" data-view="piece"></button><button class="seg-btn" data-view="split"></button><button id="tasks-toggle"></button><button id="assistant-btn"></button></div>';
});
afterEach(() => {
  handlers.splice(0).forEach(([type, listener]) => window.removeEventListener(type, listener));
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function click(text: string) {
  const button = [...document.querySelectorAll<HTMLButtonElement>("#onboarding-root button")].find((element) => element.textContent === text);
  expect(button, `button ${text}`).toBeTruthy(); button!.click(); await flush();
}
function setup(project = true, factory = createOnboardingController) {
  let tasksOpen = false;
  const createPiece = vi.fn(async () => {});
  const selectView = vi.fn();
  const controller = factory({
    app: document.querySelector("#app")!, hasProject: () => project, hasDocument: () => !project,
    createPiece, selectView, focusPieceTitle: vi.fn(),
    tasksOpen: () => tasksOpen, setTasksOpen: (open) => { tasksOpen = open; },
    openAssistant: async () => controller.assistantOpened(), captureShortcut: async () => "Alt+Cmd+C",
    toggleShortcut: mocks.toggleShortcut, openSettings: mocks.openSettings,
  });
  return { controller, createPiece, selectView, tasksOpen: () => tasksOpen };
}
const title = () => document.querySelector("#onboarding-root h2")?.textContent;

describe("onboarding interaction", () => {
  it.each([
    ["MacIntel", "⌥ ⌘ C"],
    ["Win32", "Alt + Ctrl + C"],
  ])("formats capture guidance for %s", async (platform, shortcut) => {
    vi.stubGlobal("navigator", { platform });
    vi.resetModules();
    const { createOnboardingController: factory } = await import("./onboarding");
    const { controller } = setup(true, factory);
    await controller.start();
    expect(document.querySelector("[data-capture-shortcut]")?.textContent).toBe(shortcut);
  });
  it("starts capture for an existing project, acknowledges actions, and finishes only on explicit completion", async () => {
    const { controller, createPiece, tasksOpen } = setup();
    await controller.start();
    expect(title()).toBe("收集一段有用的文字");
    controller.captured(); await flush();
    expect(title()).toBe("采集到第一条材料");
    await click("下一步"); expect(createPiece).toHaveBeenCalledTimes(1);
    await click("下一步"); await click("打开行动清单");
    expect(tasksOpen()).toBe(true); expect(title()).toBe("行动清单已打开");
    expect(document.body.textContent).not.toContain("打开行动清单");
    await click("下一步"); expect(tasksOpen()).toBe(false);
    await click("进入双栏"); expect(title()).toBe("现在可以边看边写");
    expect(mocks.state.step).toBe("split");
    await click("下一步"); await click("打开 AI 助手");
    expect(title()).toBe("认识苏格拉底 AI"); expect(mocks.state.status).toBe("in_progress");
    await click("下一步"); expect(title()).toBe("随时 打开/收起 FloatNote");
    expect(mocks.state.status).toBe("in_progress");
    await click("开始使用"); expect(mocks.state.status).toBe("completed"); expect(title()).toBeUndefined();
  });
  it("resumes the final step for documents and opens settings without completing", async () => {
    mocks.state.step = "access";
    const { controller } = setup(false);
    await controller.start();
    expect(title()).toBe("随时 打开/收起 FloatNote");
    expect(document.querySelector("kbd")?.textContent).toContain("N");
    await click("打开设置");
    expect(mocks.openSettings).toHaveBeenCalledOnce();
    expect(mocks.state.status).toBe("in_progress");
    mocks.toggleShortcut.mockResolvedValue("Alt+Ctrl+K");
    window.dispatchEvent(new Event("focus")); await flush();
    expect(document.querySelector("kbd")?.textContent).toContain("K");
    await click("上一步");
    expect(mocks.state.step).toBe("assistant");
  });
  it("keeps completion retryable after a save failure", async () => {
    mocks.state.step = "access";
    const { controller } = setup(); await controller.start();
    mocks.save.mockImplementationOnce(() => { throw new Error("保存失败"); });
    await click("开始使用");
    expect(mocks.state.status).toBe("in_progress");
    expect(document.querySelector(".onboarding-error")?.textContent).toContain("保存失败");
    await click("开始使用");
    expect(mocks.state.status).toBe("completed");
  });
  it("supports skipping and going back without losing capture success", async () => {
    const { controller } = setup(); await controller.start();
    await click("跳过这一步"); await click("上一步");
    expect(title()).toBe("收集一段有用的文字");
    controller.captured(); await flush(); await click("下一步"); await click("上一步");
    expect(title()).toBe("采集到第一条材料");
    await click("下一步"); await click("下一步"); await click("跳过");
    expect(mocks.state.step).toBe("split");
  });
  it("keeps the current step and shows an error when saving progress fails", async () => {
    mocks.state.step = "writing";
    const { controller } = setup();
    await controller.start();
    mocks.save.mockImplementationOnce(() => { throw new Error("无法保存引导进度"); });
    await click("下一步");
    expect(mocks.state.step).toBe("writing");
    expect(document.querySelector(".onboarding-error")?.textContent).toContain("无法保存引导进度");
    await click("下一步");
    expect(mocks.state.step).toBe("tasks");
  });
  it("uses a three-step document path instead of dismissing the tour", async () => {
    const { controller, createPiece } = setup(false); await controller.start();
    expect(title()).toBe("从这里开始写作");
    expect(document.querySelector(".onboarding-progress")?.textContent).toContain("1 / 3");
    await click("下一步"); expect(mocks.state.step).toBe("assistant");
    await click("上一步"); expect(mocks.state.step).toBe("writing");
    expect(createPiece).not.toHaveBeenCalled();
  });
  it("asks before closing and tells users where to restart", async () => {
    const { controller } = setup(); await controller.start();
    mocks.confirm.mockResolvedValueOnce(false);
    await click("×"); expect(mocks.state.status).toBe("in_progress");
    expect(mocks.confirm).toHaveBeenCalledWith(expect.stringContaining("设置 → 通用"), "关闭引导");
    await click("×"); expect(mocks.state.status).toBe("dismissed"); expect(title()).toBeUndefined();
  });
  it("acknowledges direct toolbar actions without advancing automatically", async () => {
    mocks.state.step = "split";
    const { controller } = setup(); await controller.start();
    controller.userSelectedView("split"); await flush();
    expect(title()).toBe("现在可以边看边写");
    await click("下一步"); controller.assistantOpened(); await flush();
    expect(title()).toBe("认识苏格拉底 AI"); expect(mocks.state.status).toBe("in_progress");
  });
});
