import { getCurrentWindow, currentMonitor, LogicalSize } from "@tauri-apps/api/window";
import {
  getCapturePermissionState,
  getOnboardingPreview,
  getOnboardingState,
  onOnboardingChanged,
  onOnboardingPreviewChanged,
  requestCapturePermission,
  setOnboardingPreview,
  setOnboardingState,
  type CapturePermissionState,
  type OnboardingPreviewScene,
  type OnboardingState,
  type OnboardingStep,
} from "../platform/onboarding";
import { SPLIT_PREFS, canSplit } from "./split";
import { confirmDialog } from "./notes-state";
import { escapeHtml } from "../shared/escape";
import { listen } from "@tauri-apps/api/event";

const ORDER: OnboardingStep[] = ["welcome", "capture", "writing", "tasks", "split", "assistant"];

export interface CoachPlacement { left: number; top: number; side: "top" | "bottom" | "left" | "right" }

export function coachPlacement(anchor: DOMRect, card: { width: number; height: number }, viewport: { width: number; height: number }, gap = 12): CoachPlacement {
  const margin = 8;
  const side = anchor.bottom + gap + card.height <= viewport.height - margin ? "top" : "bottom";
  if (side === "bottom" && anchor.top - gap - card.height < margin) {
    const top = Math.max(margin, Math.min(anchor.top, viewport.height - card.height - margin));
    if (anchor.left - gap - card.width >= margin) return { left: anchor.left - gap - card.width, top, side: "right" };
    if (anchor.right + gap + card.width <= viewport.width - margin) return { left: anchor.right + gap, top, side: "left" };
  }
  const rawTop = side === "top" ? anchor.bottom + gap : anchor.top - card.height - gap;
  return {
    left: Math.min(Math.max(anchor.left + anchor.width / 2 - card.width / 2, margin), Math.max(margin, viewport.width - card.width - margin)),
    top: Math.min(Math.max(rawTop, margin), Math.max(margin, viewport.height - card.height - margin)),
    side,
  };
}

export function splitExpansionTarget(currentWidth: number, workAreaWidth: number): number | null {
  const minimum = 2 * SPLIT_PREFS.pad + 2 * SPLIT_PREFS.paneMin + SPLIT_PREFS.gap;
  if (workAreaWidth < minimum) return null;
  return Math.min(workAreaWidth, Math.max(currentWidth, 840));
}

interface OnboardingDeps {
  app: HTMLElement;
  hasProject: () => boolean;
  hasDocument?: () => boolean;
  createPiece: () => Promise<void>;
  selectView: (view: "inbox" | "piece" | "split") => void;
  focusPieceTitle: () => void;
  setTasksOpen: (open: boolean) => void;
  tasksOpen: () => boolean;
  openAssistant: () => Promise<void>;
  captureShortcut: () => string;
}

export interface OnboardingController {
  start: () => Promise<void>;
  captured: () => void;
  projectOpened: () => void;
  userSelectedView: (view: "inbox" | "piece" | "split") => void;
  assistantOpened: () => void;
  tasksChanged: () => void;
  documentOpened: () => void;
}

export function createOnboardingController(deps: OnboardingDeps): OnboardingController {
  const root = document.createElement("div");
  root.id = "onboarding-root";
  root.setAttribute("aria-live", "polite");
  deps.app.append(root);
  let state: OnboardingState | null = null;
  let preview: OnboardingPreviewScene | null = null;
  let permission: CapturePermissionState = "not_required";
  let resizeFrame = 0;
  let splitOpened = false;
  let assistantOpened = false;
  let confirming = false;
  let enteringWriting = false;
  let anchorObserver: ResizeObserver | null = null;

  const active = () => preview !== null || state?.status === "not_started" || state?.status === "in_progress";

  async function persist(patch: Partial<OnboardingState>): Promise<void> {
    if (!state || preview) return;
    state = await setOnboardingState({ ...state, ...patch, version: 1 });
  }

  async function go(step: OnboardingStep): Promise<void> {
    if (!state) return;
    try {
      await persist({ status: "in_progress", step });
    } catch (error) {
      showError(error);
      return;
    }
    if (step !== "tasks") deps.setTasksOpen(false);
    if (step === "writing" && deps.hasProject()) deps.selectView("piece");
    if (step === "split" && splitOpened) deps.selectView("split");
    await render();
  }

  async function dismiss(): Promise<void> {
    if (preview) {
      await setOnboardingPreview(null);
      preview = null;
      await render();
      return;
    }
    if (confirming) return;
    confirming = true;
    try {
      if (await confirmDialog("现在关闭新手引导？你的内容会保留，随时可以在「设置 → 通用」重新开始。", "关闭引导")) {
        await persist({ status: "dismissed" });
        await render();
      }
    } catch (error) { showError(error); }
    finally { confirming = false; }
  }

  function button(label: string, className: string, action: () => void): HTMLButtonElement {
    const element = document.createElement("button");
    element.type = "button";
    element.className = className;
    element.textContent = label;
    element.onclick = action;
    return element;
  }

  function previewStep(): OnboardingStep | null {
    if (!preview) return null;
    if (preview.startsWith("capture")) return "capture";
    if (preview.startsWith("tasks")) return "tasks";
    if (preview.startsWith("split")) return "split";
    if (preview.startsWith("assistant")) return "assistant";
    return preview === "welcome" || preview === "writing" ? preview : null;
  }

  function resolvedStep(): OnboardingStep | null { return previewStep() ?? state?.step ?? null; }

  function decorate(card: HTMLElement, step: OnboardingStep): void {
    const close = button("×", "onboarding-close", () => void dismiss());
    close.setAttribute("aria-label", "关闭引导");
    close.title = "关闭引导";
    const progress = document.createElement("span");
    progress.className = "onboarding-progress";
    const route = deps.hasProject() || preview ? ORDER.slice(1) : ["writing", "assistant"];
    const labels: Record<string, string> = { capture: "采集", writing: "写作", tasks: "行动清单", split: "双栏", assistant: "苏格拉底 AI" };
    progress.textContent = `${route.indexOf(step) + 1} / ${route.length} · ${labels[step]}`;
    card.prepend(progress, close);
  }

  function navigation(step: OnboardingStep, label: string, action: () => void, skip?: () => void): HTMLElement {
    const actions = document.createElement("div");
    actions.className = "onboarding-actions";
    const previous = deps.hasProject() ? ORDER[ORDER.indexOf(step) - 1] : step === "assistant" ? "writing" : null;
    if (previous && previous !== "welcome") actions.append(button("上一步", "onboarding-back", () => void go(previous)));
    const forward = document.createElement("div");
    forward.className = "onboarding-forward";
    if (skip) forward.append(button("跳过", "onboarding-skip", skip));
    forward.append(button(label, label === "跳过这一步" ? "fn-btn fn-btn--secondary" : "fn-btn fn-btn--primary", action));
    actions.append(forward);
    return actions;
  }

  function captureCard(): HTMLElement {
    const card = document.createElement("section");
    card.className = "onboarding-content-card";
    const succeeded = preview === "capture-success" || (!preview && state?.capture_succeeded);
    const needsPermission = preview === "capture-permission" || (!preview && permission === "required");
    card.innerHTML = succeeded
      ? `<h2>采集到第一条材料</h2><p>采集你产生共鸣的任何内容，就这样放着，整理的工作以后来办。</p>`
      : `<h2>收集一段有用的文字</h2><p>在浏览器或 PDF 中划选文字。<br>点击旁边的「采集」，存入当前项目。</p><p class="onboarding-shortcut">也可以按 <kbd>${escapeHtml(deps.captureShortcut())}</kbd> 快速采集。</p>${needsPermission ? `<p class="onboarding-permission">先开启辅助功能权限，让 FloatNote 读取选中文字并显示采集按钮。</p>` : ""}`;
    decorate(card, "capture");
    if (needsPermission && !succeeded) card.append(button("打开系统设置", "fn-btn fn-btn--secondary", () => void requestCapturePermission().then((value) => { permission = value; void render(); }).catch(showError)));
    card.append(navigation("capture", succeeded ? "下一步" : "跳过这一步", () => void enterWriting()));
    const error = document.createElement("p");
    error.className = "onboarding-error";
    error.setAttribute("role", "alert");
    card.append(error);
    return card;
  }

  const coachContent: Record<Exclude<OnboardingStep, "welcome" | "capture">, { selector: string; title: string; body: string; action: string }> = {
    writing: { selector: '.seg-btn[data-view="piece"]', title: "从材料走向观点", body: "采集区保存材料，写作区形成感悟、判断和观点。", action: "下一步" },
    tasks: { selector: "#tasks-toggle", title: "记录接下来的行动", body: "把要查、要读、要写的事，记在项目的行动清单里。", action: "打开行动清单" },
    split: { selector: '.seg-btn[data-view="split"]', title: "让材料和观点并排", body: "左边看材料，右边写观点。窗口较窄时会自动加宽。", action: "进入双栏" },
    assistant: { selector: "#assistant-btn", title: "和苏格拉底一起思考", body: "让 AI 读取项目材料，帮你追问、整理、规划或共同写作。", action: "打开 AI 助手" },
  };

  function positionCoach(card: HTMLElement, anchor: HTMLElement): void {
    const place = coachPlacement(anchor.getBoundingClientRect(), { width: card.offsetWidth || 260, height: card.offsetHeight || 180 }, { width: innerWidth, height: innerHeight });
    card.style.left = `${place.left}px`;
    card.style.top = `${place.top}px`;
    card.dataset.arrow = place.side;
    card.style.setProperty("--onboarding-arrow-top", `${Math.max(20, Math.min(card.offsetHeight - 20, anchor.getBoundingClientRect().top + anchor.offsetHeight / 2 - place.top))}px`);
    card.style.setProperty("--onboarding-arrow-left", `${Math.max(20, Math.min(card.offsetWidth - 20, anchor.getBoundingClientRect().left + anchor.offsetWidth / 2 - place.left))}px`);
    if (!anchor.classList.contains("tasks-panel")) anchor.classList.add("onboarding-target");
  }

  function coach(step: "writing" | "tasks" | "split" | "assistant"): HTMLElement | null {
    const spec = coachContent[step];
    const anchor = step === "tasks" && deps.tasksOpen()
      ? document.querySelector<HTMLElement>(".tasks-panel") ?? document.querySelector<HTMLElement>(spec.selector)
      : document.querySelector<HTMLElement>(spec.selector);
    const done = step === "tasks" ? deps.tasksOpen() : step === "split" ? splitOpened : step === "assistant" ? assistantOpened || !!preview?.startsWith("assistant") : true;
    const result = {
      writing: { title: deps.hasProject() ? spec.title : "从这里开始写作", body: deps.hasProject() ? spec.body : "写下想法，内容会自动保存为本地文档。接下来认识你的 AI 助手。" },
      tasks: { title: "行动清单已打开", body: "点击清单中的「＋」添加一件待办，完成后勾选。" },
      split: { title: "现在可以边看边写", body: "采集材料在左，作品在右。随时点击顶部「采集」或「写作」回到单栏。" },
      assistant: { title: "认识苏格拉底 AI", body: "你可以请它梳理材料，或用追问帮你想清楚。首次使用需配置 AI 服务，可稍后再做。" },
    }[step];
    const card = document.createElement("section");
    card.className = anchor && anchor.getClientRects().length ? "onboarding-coach" : "onboarding-content-card";
    card.innerHTML = `<h2>${done ? result.title : spec.title}</h2><p>${done ? result.body : spec.body}</p>`;
    decorate(card, step);
    const next = () => {
      if (step === "assistant") void persist({ status: "completed", step: "assistant" }).then(render).catch(showError);
      else void go(step === "writing" ? deps.hasProject() ? "tasks" : "assistant" : step === "tasks" ? "split" : "assistant");
    };
    card.append(navigation(step, done ? step === "assistant" ? "完成引导" : "下一步" : spec.action, () => {
      if (done) next();
      else if (step === "tasks") { deps.setTasksOpen(true); void render(); }
      else if (step === "split") void enterSplit();
      else void deps.openAssistant().then(() => { assistantOpened = true; void render(); }).catch(showError);
    }, !done ? next : undefined));
    const error = document.createElement("p");
    error.className = "onboarding-error";
    error.setAttribute("role", "alert");
    card.append(error);
    root.append(card);
    if (anchor && card.classList.contains("onboarding-coach")) {
      positionCoach(card, anchor);
      if (step === "tasks" && done && typeof ResizeObserver !== "undefined") {
        anchorObserver = new ResizeObserver(() => positionCoach(card, anchor));
        anchorObserver.observe(anchor);
      }
    }
    return card;
  }

  async function enterWriting(): Promise<void> {
    if (!deps.hasProject() || enteringWriting) return;
    enteringWriting = true;
    try {
      await deps.createPiece();
      await go("writing");
      deps.focusPieceTitle();
    } catch (error) { showError(error); }
    finally { enteringWriting = false; }
  }

  function showError(error: unknown): void {
    const message = root.querySelector<HTMLElement>(".onboarding-error");
    if (message) message.textContent = error instanceof Error ? error.message : String(error);
  }

  async function enterSplit(): Promise<void> {
    if (canSplit(innerWidth)) {
      deps.selectView("split");
      splitOpened = true;
      await render();
      return;
    }
    try {
      const monitor = await currentMonitor();
      const window = getCurrentWindow();
      if (!monitor) throw new Error("无法读取显示器工作区");
      const scale = monitor.scaleFactor || 1;
      const workWidth = monitor.workArea.size.width / scale;
      const current = await window.outerSize();
      const target = splitExpansionTarget(current.width / scale, workWidth);
      if (target === null) throw new Error("当前显示器空间不足以使用双栏");
      await window.setSize(new LogicalSize(target, current.height / scale));
      await new Promise<void>((resolve) => {
        const finish = () => { removeEventListener("resize", finish); resolve(); };
        addEventListener("resize", finish, { once: true });
        setTimeout(finish, 350);
      });
      deps.selectView("split");
      splitOpened = true;
      await render();
    } catch (error) {
      const message = root.querySelector<HTMLElement>(".onboarding-error");
      if (message) message.textContent = error instanceof Error ? error.message : String(error);
    }
  }

  async function render(): Promise<void> {
    const focused = document.activeElement;
    if (focused instanceof HTMLButtonElement && root.contains(focused)) {
      const label = focused.textContent;
      queueMicrotask(() => {
        const buttons = [...root.querySelectorAll<HTMLButtonElement>("button")];
        const next = buttons.find((item) => item.textContent === label) ?? root.querySelector<HTMLButtonElement>(".onboarding-forward .fn-btn");
        next?.focus({ preventScroll: true });
      });
    }
    anchorObserver?.disconnect();
    deps.app.classList.toggle("onboarding-tasks-open", !!active() && resolvedStep() === "tasks" && deps.tasksOpen());
    document.querySelectorAll(".onboarding-target").forEach((element) => element.classList.remove("onboarding-target"));
    root.replaceChildren();
    if (!active()) return;
    const step = resolvedStep();
    if (!step) return;
    if (step === "welcome") {
      if (preview === "welcome") {
        const card = document.createElement("section");
        card.className = "onboarding-content-card";
        card.innerHTML = `<i class="ph ph-pen-nib" aria-hidden="true"></i><h2>把读到的变成学会的</h2><p>收集材料，写下观点，让 AI 陪你深入思考。</p>`;
        card.append(button("停止预览", "fn-btn fn-btn--secondary", () => void dismiss()));
        root.append(card);
      }
      return;
    }
    if (step === "capture") {
      deps.selectView("inbox");
      root.append(captureCard());
      return;
    }
    if (step === "tasks") {
      if (preview === "tasks-open") deps.setTasksOpen(true);
      if (preview === "tasks-closed") deps.setTasksOpen(false);
    }
    if (step === "assistant" && preview?.startsWith("assistant")) void deps.openAssistant();
    coach(step);
  }

  addEventListener("resize", () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => void render());
  });
  addEventListener("focus", () => {
    if (active() && resolvedStep() === "capture" && !preview) {
      void getCapturePermissionState().then((value) => { permission = value; void render(); });
    }
  });
  addEventListener("keydown", (event) => {
    if (event.key === "Escape" && active() && !event.defaultPrevented) void dismiss();
  });

  return {
    async start() {
      [state, preview, permission] = await Promise.all([getOnboardingState(), getOnboardingPreview(), getCapturePermissionState()]);
      void onOnboardingChanged((next) => {
        state = next;
        if ((next.status === "not_started" || next.status === "in_progress") && next.step === "welcome" && deps.hasProject()) void go("capture");
        else if (next.status === "in_progress" && next.step === "welcome" && deps.hasDocument?.()) void go("writing");
        else void render();
      });
      void onOnboardingPreviewChanged((next) => { preview = next; void render(); });
      void listen("accessibility-needed", () => { permission = "required"; void render(); });
      if ((state.status === "not_started" || state.status === "in_progress") && state.step === "welcome" && deps.hasProject()) {
        await go("capture");
      } else if (active() && deps.hasDocument?.()) {
        await go(state.step === "assistant" ? "assistant" : "writing");
      } else {
        await render();
      }
      // Initial visibility belongs to the startup gate; replay may still focus.
      if (active() && !document.querySelector("#startup-shell")) {
        const window = getCurrentWindow();
        await window.show();
        await window.setFocus();
      }
    },
    captured() {
      if (!active() || resolvedStep() !== "capture") return;
      if (state && !preview) void persist({ capture_succeeded: true }).then(render).catch(showError);
      else void render();
    },
    projectOpened() {
      if (!active()) return;
      const step = resolvedStep();
      if (step === "welcome") void go("capture");
    },
    userSelectedView(view) {
      if (!active()) return;
      if (view !== "split") splitOpened = false;
      if (resolvedStep() === "split") { splitOpened = view === "split"; void render(); }
      if (view === "piece" && resolvedStep() === "capture") void enterWriting();
    },
    assistantOpened() {
      if (!active() || resolvedStep() !== "assistant" || !state || preview) return;
      assistantOpened = true;
      void render();
    },
    tasksChanged() {
      if (active() && resolvedStep() === "tasks") void render();
    },
    documentOpened() {
      if (active()) void go("writing");
    },
  };
}
