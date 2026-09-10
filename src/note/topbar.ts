import socratesIconSvg from "../assets/socrates_head_icon.svg?raw";
import { createIcon } from "../shared/ui/icon";
import {
  mountCaptionButtons,
  wireDragRegionToggleMaximize,
} from "../shared/ui/window-caption";
import {
  viewToIdx,
  maxReachableIdx,
  type Reach,
} from "./seg-switch";

/** 顶栏居中三段视图：采集（_inbox.md）/ 写作（piece）/ 双栏（并排）。 */
export type ViewSeg = "inbox" | "piece" | "split";

export interface TopbarCallbacks {
  /** 项目名按钮：开/关项目空间下拉（含切换最近项目、新建项目）。 */
  onToggleProjects: (anchor: HTMLElement) => void;
  /** 三段视图切换：采集 / 写作 / 双栏。 */
  onSelectView: (view: ViewSeg) => void;
  /** 行动面板开关。 */
  onToggleTasks: () => void;
}

export interface TitlebarCallbacks {
  /** 助手 icon 单击：开/关助手。 */
  onAssistantToggle: () => void;
}

/**
 * 第一行标题栏：左侧空位让系统红绿灯叠加、整行可拖拽，最右端助手 icon。
 * macOS 经 `titleBarStyle:"Overlay"` 与系统标题栏合并为一条。
 */
/** 项目名面包屑内部标记：folder/file 图标靠 `.project-name-icon` 类做
 *  项目/文档模式可见性切换，故 createIcon 产物需保留这些类。 */
function projectNameInner(): string {
  const folder = createIcon({ phosphor: "ph ph-folder", size: 13 });
  folder.classList.add("project-name-icon", "folder-icon");
  const file = createIcon({ phosphor: "ph ph-file", size: 13 });
  file.classList.add("project-name-icon", "file-icon");
  const label = document.createElement("span");
  label.id = "project-label";
  label.textContent = "-";
  const caret = createIcon({ phosphor: "ph ph-caret-down", size: 13 });
  return folder.outerHTML + file.outerHTML + label.outerHTML + caret.outerHTML;
}

export function renderTitlebar(root: HTMLElement, callbacks: TitlebarCallbacks) {
  root.innerHTML = `
    <div class="titlebar">
      <div class="titlebar-drag" data-tauri-drag-region></div>
      <button class="assistant-btn" id="assistant-btn" title="开关助手">${socratesIconSvg}</button>
    </div>
  `;
  root.querySelector<HTMLElement>("#assistant-btn")!.onclick = () => callbacks.onAssistantToggle();
  // Windows：系统标题栏已去除，补自绘 min/max/close 与拖拽区双击最大化；
  // macOS 与浏览器 review 环境下两个调用均早退。
  mountCaptionButtons(root.querySelector<HTMLElement>(".titlebar")!);
  wireDragRegionToggleMaximize(root.querySelector<HTMLElement>(".titlebar-drag")!);
}

export function renderTopbar(root: HTMLElement, callbacks: TopbarCallbacks) {
  root.innerHTML = `
    <div class="topbar">
      <div class="topbar-left">
        <button class="project-name" id="project-name" title="切换项目空间">
          ${projectNameInner()}
        </button>
      </div>
      <div class="view-seg" id="view-seg" data-reach="full">
        <div class="seg-track" id="seg-track">
          <button class="seg-btn active" data-view="inbox" data-idx="0">采集</button>
          <button class="seg-btn"        data-view="piece" data-idx="1">写作</button>
          <button class="seg-btn"        data-view="split" data-idx="2" title="双栏（采集 ｜ 写作）">双栏<span class="seg-lock">${createIcon({ phosphor: "ph ph-lock-simple", size: 10 }).outerHTML}</span></button>
          <div class="seg-knob" id="seg-knob" role="presentation" aria-hidden="true">采集</div>
        </div>
      </div>
      <div class="topbar-right">
        <button class="icon-btn" id="tasks-toggle" title="行动">${createIcon({ phosphor: "ph ph-list-checks", size: 13 }).outerHTML}</button>
      </div>
    </div>
  `;

  const projectButton = root.querySelector<HTMLElement>("#project-name")!;
  projectButton.onclick = () => callbacks.onToggleProjects(projectButton);

  root.querySelector<HTMLElement>("#tasks-toggle")!.onclick = callbacks.onToggleTasks;

  wireSegSwitch(root, callbacks);
}

export function setProjectLabel(name: string) {
  document.querySelector<HTMLElement>("#project-label")!.textContent = name;
}

/**
 * 高亮当前视图段并把胶囊钮拨到对应档；窄窗（放不下两栏）时双栏不可达。
 * 由 --idx 驱动钮位、data-reach 驱动可达性，CSS 完成滑动动画与变暗。
 * 钮面文字随当前段同步，故用户看到的就是「拨到的那一档的名字」。
 */
export function setViewSeg(view: ViewSeg, splitAllowed: boolean) {
  const seg = document.querySelector<HTMLElement>("#view-seg");
  const knob = document.querySelector<HTMLElement>("#seg-knob");
  const reach: Reach = splitAllowed ? "full" : "narrow";
  if (seg) {
    seg.dataset.reach = reach;
    seg.style.setProperty("--idx", String(viewToIdx(view)));
  }
  let label = "";
  document.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((btn) => {
    const v = btn.dataset.view as ViewSeg;
    const active = v === view;
    btn.classList.toggle("active", active);
    if (v === "split") {
      btn.disabled = !splitAllowed;
      btn.title = splitAllowed ? "双栏（采集 ｜ 写作）" : "";
      if (splitAllowed) {
        btn.removeAttribute("data-tip");
      } else {
        btn.dataset.tip = "窗口过窄，拉宽后可用双栏";
      }
    }
    if (active) label = btn.childNodes[0]?.textContent ?? "";
  });
  if (knob) knob.textContent = label;
}

export function setTasksToggle(open: boolean) {
  document.querySelector<HTMLElement>("#tasks-toggle")!.classList.toggle("on", open);
}

/**
 * 滑拨杆仅支持点击：点任一标签即提交，钮随 --idx 滑过去。钮本身
 * pointer-events:none，绝不拦截按钮点击——故从任一档都能无障碍拨回。
 * 方向键在可达档间步进；窄窗下双栏档禁用且方向键跳不过去。
 */
function wireSegSwitch(root: HTMLElement, callbacks: TopbarCallbacks) {
  const seg = root.querySelector<HTMLElement>("#view-seg")!;

  const reachOf = (): Reach => (seg.dataset.reach as Reach) ?? "full";

  root.querySelectorAll<HTMLButtonElement>(".seg-btn").forEach((btn) => {
    btn.onclick = () => {
      if (btn.disabled) return;
      callbacks.onSelectView(btn.dataset.view as ViewSeg);
    };

    btn.addEventListener("keydown", (e) => {
      const max = maxReachableIdx(reachOf());
      const cur = Number(btn.dataset.idx);
      let next: number | null = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = Math.min(max, cur + 1);
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = Math.max(0, cur - 1);
      else if (e.key === "Home") next = 0;
      else if (e.key === "End") next = max;
      else return;
      e.preventDefault();
      if (next === null || next === cur) return;
      const target = root.querySelector<HTMLButtonElement>(`.seg-btn[data-idx="${next}"]`);
      if (!target || target.disabled) return;
      target.focus();
      callbacks.onSelectView(target.dataset.view as ViewSeg);
    });
  });
}
