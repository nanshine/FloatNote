import { startUpdates, isPreparingUpdate } from "./updates";
import { captureQuote, type QuotePayload } from "./capture";
import "@phosphor-icons/web/regular";
import "../assistant/styles.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { onFileChanged, onNoteUpdated, type NoteUpdated } from "../platform/agent";
import { decodeInbox } from "@floatnote/note-logic";
import { isImeComposing } from "../shared/keyboard";
import { createImeAnchorRefresher } from "../shared/ime-anchor";
import { showToast } from "../shared/toast";
import { createIcon } from "../shared/ui/icon";
import { createMenu, type MenuHandle } from "../shared/ui/menu";
import { createLayoutController } from "./layout-controller";
import { createPieceHeader } from "./piece-switcher";
import { actionTargetForTransition, createTasksPanel } from "./tasks-panel";
import {
  createDocument,
  createNote,
  createProject,
  confirmDialog,
  deleteNote,
  deleteProject,
  discardPending,
  flushAll,
  getConfig,
  inboxEntry,
  isDirty,
  lastKnownMtime,
  listPieces,
  listProjects,
  loadNote,
  onConflict,
  onSaveGaveUp,
  openDocumentFromFile,
  openExistingProject,
  renameNote,
  renameProject,
  revealInFileManager,
  resolveDocuments,
  resolveProjects,
  saveImmediate,
  scheduleSave,
  setLastKnown,
  settleAllPendingWrites,
  settlePendingWrites,
  setRecentDocuments,
  setRecentProjects,
  tasksPath,
  type NoteEntry,
  type ProjectEntry,
} from "./notes-state";
import { parentDir, pushRecent, removeFromRecent } from "./recent-projects";
import { initScrollbar } from "../shared/ui/scrollbar";
import { renderEmptyState } from "../shared/ui/empty-state";
import {
  resolveBootstrap,
  resolveOpenProject,
  type WindowState,
} from "./window-state";
import {
  renderTitlebar,
  renderTopbar,
  setProjectLabel,
  setTasksToggle,
  setViewSeg,
} from "./topbar";
import { mountResizeEdges } from "../shared/ui/window-caption";
import { canSplit } from "./split";
import { buildBindings, installShortcuts, type ShortcutActions } from "./shortcuts";
import { WINDOW_SHORTCUT_DEFAULTS, type WindowShortcutId } from "../shared/shortcuts";
import {
  deleteVersion,
  listVersions,
  readVersion,
  renameVersion,
  restoreVersion,
  snapshotNote,
} from "./versions";
import { createVersionPreviewState } from "./version-preview";
import { attachAutomationToasts } from "./automation-toasts";
import { createProjectMenuRenderer, fileManagerRevealLabel } from "./project-menu-render";
import { createAssistantController } from "./assistant-controller";
import { createNoteSession } from "./note-session";
import { resolveAgentWriteNavigation } from "./agent-write-navigation";
import {
  adjustEditorFontSize,
  initializeEditorFontSize,
  resetEditorFontSize,
} from "./font-size";
import {
  createStructuredMarkdownEditor,
  type StructuredEditorCheckpoint,
} from "../shared/markdown/structured-editor";
import { createStructuredInbox } from "./structured-inbox";
import { imageSrc } from "./image-fs";
import { attachStructuredMedia } from "./structured-media";
import { openSettings } from "../platform/onboarding";
import { createOnboardingController, type OnboardingController } from "./onboarding";


export async function startNoteApp() {
initializeEditorFontSize();
const app = document.querySelector<HTMLElement>("#app")!;
app.innerHTML = `
  <div id="titlebar-root"></div>
  <div id="topbar-root"></div>
  <div id="note-body">
    <div id="tag-bar-root"></div>
    <div id="piece-topbar-root"></div>
    <div id="left-col"></div>
    <div id="text-col" class="note-column">
      <div id="editor-root" class="note-scroll note-editor-host">
        <div id="annotation-projection-root" hidden></div>
      </div>
    </div>
    <div id="piece-col" class="note-column">
      <div id="piece-scroll" class="note-scroll">
        <div id="piece-doc-header"></div>
        <div id="piece-editor-root" class="note-editor-host"></div>
      </div>
      <div id="piece-version-preview-root"></div>
      <div id="piece-empty-root"></div>
    </div>
    <div id="assistant-region"></div>
  </div>
  <div id="body-empty-root"></div>
`;

const noteBody = document.querySelector<HTMLElement>("#note-body")!;
const textCol = document.querySelector<HTMLElement>("#text-col")!;
const assistantRegion = document.querySelector<HTMLElement>("#assistant-region")!;
const bodyEmptyRoot = document.querySelector<HTMLElement>("#body-empty-root")!;
const pieceEmptyRoot = document.querySelector<HTMLElement>("#piece-empty-root")!;

const DEFAULT_PROJECT_NAME = "未命名项目";
const DEFAULT_PIECE_TITLE = "未命名作品";

const session = createNoteSession();
let onboardingController: OnboardingController | null = null;

/** 当前工作目录（隐式）：bootstrap 时从 config.working_dir 读取；项目新建时由后端
 * 自动回写，前端在此镜像。无工作目录时为空串——NO_PROJECT 空态的"新建项目"会弹
 * 目录选择让用户定位，"新建文档"则走保存对话框。用户不感知此概念。 */


/** 空态渲染的清理句柄；切换状态前先清掉上一个，避免残留 DOM 与监听。 */
let cleanupBodyEmpty: (() => void) | null = null;
let cleanupPieceEmpty: (() => void) | null = null;

/** 清掉所有空态层，恢复到编辑器可见。LOADED 与文档模式都走这里。 */
function clearEmptyState() {
  app.classList.remove("state-no-project", "state-path-error", "state-no-piece");
  cleanupBodyEmpty?.();
  cleanupBodyEmpty = null;
  cleanupPieceEmpty?.();
  cleanupPieceEmpty = null;
}

/** 按窗口状态渲染对应空态。LOADED 不渲染空态，只清理。文档模式由 openDocument
 * 自行调 clearEmptyState。 */
function renderWindowState(state: WindowState) {
  clearEmptyState();
  switch (state.kind) {
    case "NO_PROJECT":
      assistantHandle?.setScope(null);
      app.classList.add("state-no-project");
      setProjectLabel("");
      cleanupBodyEmpty = renderEmptyState(bodyEmptyRoot, {
        icon: "pen-nib",
        title: "把读到的变成学会的",
        hint: "收集材料，写下观点，让 AI 陪你深入思考。",
        primary: { label: "创建新项目", action: () => void createDefaultProject() },
      });
      break;
    case "PATH_ERROR":
      assistantHandle?.setScope(null);
      app.classList.add("state-path-error");
      setProjectLabel("");
      cleanupBodyEmpty = renderEmptyState(bodyEmptyRoot, {
        icon: "warning-circle",
        title: "读取失败",
        hint: state.error ?? "无法读取项目列表，请稍后重试。",
        primary: { label: "重试", action: () => void retryBootstrap() },
      });
      break;
    case "NO_PIECE":
      app.classList.add("state-no-piece");
      // 空态下无当前作品：清掉残留引用与面包屑/标题，避免上一个项目的作品名泄漏到新空态。
      session.currentPiece = null;
      pieceHeader?.setLabel("");
      cleanupPieceEmpty = renderEmptyState(pieceEmptyRoot, {
        icon: "file-text",
        title: "这里还没有作品",
        hint: `在「${state.project.name}」里新建一篇开始写作。`,
        primary: { label: "新建作品", action: () => void createFirstPiece() },
      });
      break;
    case "LOADED":
      break;
  }
}

/** 最近打开的项目路径（MRU，最近在前，上限 8）。项目可散落在磁盘任意位置，
 * 此列表是项目切换菜单的唯一数据来源，并持久化到 config.recent_projects。 */

/** 最近打开的独立文档路径（MRU，与 session.recentProjects 平行）。持久化到 config.recent_documents。 */



/** 当前窗口模式：项目（含采集/写作/双栏）或独立文档（单一编辑器，无滑拨杆）。 */

/** 进入文档模式前行动面板是否开着 —— 独立文档无 _tasks.md，进文档时关掉行动，
 *  返回项目时按此值恢复，呈现「临时遮挡」语义。仅项目→文档那一刻写入。 */

/** 文档模式下打开的独立文档；项目模式下为 null。复用 pieceEditor 渲染。 */

let menuEl: MenuHandle | null = null;
/** The project-name button the switcher menu is anchored to (for repositioning). */
let menuAnchor: HTMLElement | null = null;
/** AI 改写热刷新期间置位，避免编辑器变更回灌 autosave。 */
let applyingRemote = false;

const editorRoot = document.querySelector<HTMLElement>("#editor-root")!;
const annotationProjectionRoot = document.querySelector<HTMLElement>("#annotation-projection-root")!;
const structuredInbox = await createStructuredInbox({
  parent: editorRoot,
  projectionRoot: annotationProjectionRoot,
  onFocus: publishInboxActive,
  onCaptureCompleted: () => onboardingController?.captured(),
  onSave: (snapshot) => {
    if (!applyingRemote && session.currentInbox) scheduleSave(session.currentInbox.entry.path, snapshot);
  },
  resolveImageSrc: (url) => imageSrc(url, session.currentProject?.path ?? session.currentStartDir),
});
document.querySelector<HTMLElement>("#tag-bar-root")!.appendChild(structuredInbox.tagBar);
void attachStructuredMedia(structuredInbox.editor, () => session.currentProject?.path ?? session.currentStartDir);
// The thumb must live outside the scrolling element, otherwise it moves with
// the document instead of staying in the column gutter.
requestAnimationFrame(() => initScrollbar(textCol, editorRoot));

// 布局控制器：按窗口宽度分级收缩边距、决定助手嵌入/分离/分屏（init() 里用配置初始化）。
let layoutController: ReturnType<typeof createLayoutController> | null = null;

// ── 成品 session.surface ──────────────────────────────────────────────────────────
const pieceEditorRoot = document.querySelector<HTMLElement>("#piece-editor-root")!;
const pieceCol = document.querySelector<HTMLElement>("#piece-col")!;
const pieceScroll = document.querySelector<HTMLElement>("#piece-scroll")!;
const versionPreviewRoot = document.querySelector<HTMLElement>("#piece-version-preview-root")!;

/** 当前装载进 pieceEditor 的文件（项目模式=成品，文档模式=独立文档）。 */
function activePieceFile(): NoteEntry | null {
  return session.mode === "document" ? session.currentDocument : session.currentPiece;
}

// 共享正文表面铺满可用高度并随内容增长；标题和正文统一由 #piece-scroll 滚动。
const pieceEditor = await createStructuredMarkdownEditor({
  parent: pieceEditorRoot,
  context: {
    kind: "piece",
    resolveImageSrc: (url) => imageSrc(url,
      session.mode === "document" && session.currentDocument
        ? parentDir(session.currentDocument.path)
        : (session.currentProject?.path ?? session.currentStartDir)),
  },
  placeholder: "开始写…",
  onChange: (doc) => {
    if (applyingRemote) return;
    const f = activePieceFile();
    if (f) scheduleSave(f.path, doc);
  },
});
const versionPreview = createVersionPreviewState();
void attachStructuredMedia(pieceEditor, () =>
  session.mode === "document" && session.currentDocument
    ? parentDir(session.currentDocument.path)
    : (session.currentProject?.path ?? session.currentStartDir));
let versionPreviewEditorState: StructuredEditorCheckpoint | null = null;
let versionPreviewGeneration = 0;

function exitPieceVersionPreview() {
  versionPreviewGeneration += 1;
  versionPreview.exit();
  pieceEditor.setReadOnly(false);
  if (versionPreviewEditorState) {
    applyingRemote = true;
    try {
      pieceEditor.restore(versionPreviewEditorState);
    } finally {
      applyingRemote = false;
      versionPreviewEditorState = null;
    }
  }
}
// 滑块挂在不滚动的 #piece-col 上，监听真正滚动的 #piece-scroll。
requestAnimationFrame(() => initScrollbar(pieceCol, pieceScroll));

// 焦点跟随：哪个 session.surface 获得焦点，助手 active_note 就指向它（成品=润色面）。
pieceEditor.contentDOM.addEventListener("focus", () => {
  const f = activePieceFile();
  if (!f) return;
  const dir = session.mode === "document" ? parentDir(f.path) : session.currentProject?.path;
  if (!dir) return;
  void invoke("set_active_note", {
    dir,
    noteId: f.name,
    path: f.path,
    kind: session.mode === "document" ? "doc" : "piece",
  });
});

// 文档头（标题 + 切换箭头）挂在「写作」栏内容区顶部，随正文一起滚。
let pieceHeader: ReturnType<typeof createPieceHeader> | null = null;

function mountPieceHeader() {
  const topbar = document.querySelector<HTMLElement>("#piece-topbar-root")!;
  const titleHost = document.querySelector<HTMLElement>("#piece-doc-header")!;
  pieceHeader = createPieceHeader({
    topbarMount: topbar,
    titleMount: titleHost,
    previewMount: versionPreviewRoot,
    host: {
    dir: () =>
      session.mode === "document"
        ? session.currentDocument
          ? parentDir(session.currentDocument.path)
          : ""
        : session.currentProject?.path ?? "",
    current: () => activePieceFile(),
    open: async (entry) => {
      if (session.mode === "document") {
        // 文档模式下 open 仅在重命名后被调用：更新当前文档引用并同步 MRU 路径。
        const oldPath = session.currentDocument?.path;
        session.currentDocument = entry;
        pieceHeader?.setLabel(entry.name);
        // 顶栏项目按钮显示的是文档名，改名后同步刷新（切换菜单里的改名路径同样调它）。
        setProjectLabel(entry.name);
        if (oldPath && oldPath !== entry.path) {
          session.recentDocuments = session.recentDocuments.map((p) => (p === oldPath ? entry.path : p));
          void setRecentDocuments(session.recentDocuments);
          // 活动笔记随改名指向新路径，避免 AI apply_write 落到已不存在的旧文件。
          void invoke("set_active_note", { dir: parentDir(entry.path), noteId: entry.name, path: entry.path, kind: "doc" });
        }
      } else {
        await openPiece(entry);
      }
    },
    loadVersions: (target) => {
      if (session.mode !== "project" || activePieceFile()?.path !== target.path)
        return Promise.resolve([]);
      return listVersions(parentDir(target.path), target.name);
    },
    snapshot: async (target) => {
      if (session.mode !== "project" || activePieceFile()?.path !== target.path) return;
      await snapshotNote(
        parentDir(target.path),
        target.name,
        versionPreview.contentForRestore(pieceEditor.getMarkdown()),
        "manual",
      );
    },
    preview: async (target, v) => {
      if (session.mode !== "project" || activePieceFile()?.path !== target.path) return false;
      const generation = ++versionPreviewGeneration;
      const content = await readVersion(parentDir(target.path), target.name, v);
      if (generation !== versionPreviewGeneration || activePieceFile()?.path !== target.path) {
        return false;
      }
      versionPreview.begin(pieceEditor.getMarkdown());
      versionPreviewEditorState ??= pieceEditor.checkpoint();
      pieceEditor.setReadOnly(true);
      applyPiecePreview(content);
      return true;
    },
    exitPreview: exitPieceVersionPreview,
    restore: async (target, v) => {
      if (session.mode !== "project" || activePieceFile()?.path !== target.path) return;
      versionPreviewGeneration += 1;
      const path = target.path;
      try {
        await settlePendingWrites(path);
        if (activePieceFile()?.path !== target.path) return;
        let currentContent = versionPreview.contentForRestore(pieceEditor.getMarkdown());
        if (isDirty(path)) {
          await saveImmediate(path, currentContent);
          if (activePieceFile()?.path !== target.path) return;
          currentContent = versionPreview.contentForRestore(pieceEditor.getMarkdown());
        }
        const restored = await restoreVersion(
          parentDir(target.path),
          target.name,
          path,
          currentContent,
          v,
          lastKnownMtime(path) ?? null,
        );
        if (activePieceFile()?.path !== target.path) return;
        setLastKnown(path, restored.mtime);
        versionPreview.completeRestore();
        if (versionPreviewEditorState) {
          applyingRemote = true;
          try {
            pieceEditor.restore(versionPreviewEditorState);
          } finally {
            applyingRemote = false;
            versionPreviewEditorState = null;
          }
        }
        pieceEditor.setReadOnly(false);
        applyRemotePiece(restored.content);
      } catch (error) {
        throw error;
      }
    },
    renameVersion: async (target, v, name) => {
      await renameVersion(parentDir(target.path), target.name, v, name);
    },
    deleteVersion: async (target, v) => {
      await deleteVersion(parentDir(target.path), target.name, v);
    },
    onEmptied: () => {
      // 当前 piece 被删且项目已无 piece：清掉引用，切到 NO_PIECE 空态。
      session.currentPiece = null;
      if (session.currentProject) {
        renderWindowState({ kind: "NO_PIECE", project: session.currentProject });
      }
      session.surface = "piece";
      applyView();
    },
    focusTitle: () => focusPieceTitle(),
    focusBody: () => {
      // 标题回车后，焦点落到正文编辑器首行行首。
      pieceEditor.focus();
      pieceEditor.setSelection(0);
    },
    },
  });
}

async function openPiece(entry: NoteEntry) {
  pieceHeader?.exitVersionPreview();
  session.currentPiece = entry;
  pieceHeader?.setLabel(entry.name);
  applyRemotePiece(await loadNote(entry.path));
}

let captureTargetLoading = 0;

/** 打开一个独立文档：切到文档模式，复用 pieceEditor 渲染该文件。 */
async function openDocument(doc: NoteEntry) {
  captureTargetLoading += 1;
  try {
    pieceHeader?.exitVersionPreview();
    // 独立文档无 _tasks.md：进入文档模式时把行动「临时遮挡」——记下开关并关掉，
    // 返回项目时按记忆恢复（见 openProject）。
    const plan = actionTargetForTransition({
      from: session.mode,
      to: "document",
      currentOpen: tasksPanel.isOpen(),
      rememberedOpen: session.actionDesiredOpen,
    });
    if (plan.remember !== null) session.actionDesiredOpen = plan.remember;
    tasksPanel.setOpen(plan.open);
    session.mode = "document";
    session.currentDocument = doc;
    session.recentDocuments = pushRecent(session.recentDocuments, doc.path);
    await setRecentDocuments(session.recentDocuments);
    setProjectLabel(doc.name);
    clearEmptyState();
    applyRemotePiece(await loadNote(doc.path));
    pieceHeader?.setLabel(doc.name);
    applyView();
    void invoke("set_active_note", { dir: parentDir(doc.path), noteId: doc.name, path: doc.path, kind: "doc" });
    assistantHandle.setScope(assistantController.currentScope());
    // 独立文档不在项目目录内，停掉文件监听以免误刷新（返回项目时再 watch_dir）。
    void invoke("unwatch_dir");
    onboardingController?.documentOpened();
  } finally {
    captureTargetLoading -= 1;
  }
}

/** 列举项目内的 piece；失败时返回空数组并把错误上抛由调用方决定回退。 */
async function loadFirstPiece(): Promise<NoteEntry[]> {
  const dir = session.currentProject!.path;
  return listPieces(dir);
}

function publishInboxActive() {
  if (!session.currentProject || !session.currentInbox) return;
  void invoke("set_active_note", {
    dir: session.currentProject.path,
    noteId: session.currentInbox.entry.name,
    path: session.currentInbox.entry.path,
    kind: "inbox",
  });
}

// 单栏可见面（采集/写作）。双栏由 layoutController 持有；session.surface 始终记着「上次的
// 单栏面」，作为窗口变窄、双栏放不下时的回落目标。


function applyView() {
  const split = layoutController?.isSplit() ?? false;
  // 文档模式：单一编辑器，无滑拨杆 / 无采集面 / 无行动面板（CSS 经 .doc-session.mode 隐藏）。
  app.classList.toggle("doc-mode", session.mode === "document");
  if (session.mode === "document") {
    app.classList.add("show-piece");
    app.classList.remove("show-inbox");
    setViewSeg("piece", false);
    return;
  }
  // 双栏时采集恒在左、写作恒在右；单栏时按 session.surface 选一个。
  app.classList.toggle("show-piece", !split && session.surface === "piece");
  app.classList.toggle("show-inbox", split || session.surface === "inbox");
  setViewSeg(split ? "split" : session.surface, canSplit(window.innerWidth));
}

function selectView(view: "inbox" | "piece" | "split") {
  if (view === "split") {
    layoutController?.setSplit(true);
  } else {
    session.surface = view;
    layoutController?.setSplit(false);
  }
  applyView();
  tasksPanel.syncLayout();
  onboardingController?.userSelectedView(view);
}

const tasksPanel = createTasksPanel(noteBody, {
  tasksPath: () => (session.currentProject ? tasksPath(session.currentProject.path) : null),
  // 行动开关与助手开关同等地驱动右栏几何：打开即预留右栏、正文左推。
  onOpenChange: (open) => {
    setTasksToggle(open);
    layoutController?.setActionOpen(open);
    onboardingController?.tasksChanged();
  },
});

/** 用 AI/外部写入的新内容覆盖结构化写作编辑器，不触发本地 autosave。 */
function applyRemotePiece(content: string) {
  applyingRemote = true;
  try {
    pieceEditor.replace(content, { addToHistory: true });
  } finally {
    applyingRemote = false;
  }
}

/** Version preview is a transient projection, not an edit or undo step. */
function applyPiecePreview(content: string) {
  applyingRemote = true;
  try {
    pieceEditor.replace(content, { addToHistory: false });
  } finally {
    applyingRemote = false;
  }
}

function applyRemoteDoc(content: string) {
  const decoded = decodeInbox(content);
  applyingRemote = true;
  try {
    structuredInbox.load(decoded.markdown, decoded.metadata);
    structuredInbox.setReadOnly(decoded.warnings.length > 0);
  } finally {
    applyingRemote = false;
  }
  if (decoded.warnings.length > 0) {
    showToast(`Inbox metadata 已损坏，已用只读模式打开（${decoded.warnings.length} 条错误）`);
  }
}

const assistantController = createAssistantController({
  region: assistantRegion,
  session,
  openProject,
  openDocument,
  onChromeStateChange: (open) => {
    layoutController?.setAssistantOpen(open);
    tasksPanel.syncLayout();
  },
});
const assistantHandle = assistantController.handle;

async function toggleAssistantFromChrome() {
  await assistantController.toggleFromChrome();
  const current = await invoke<{ open: boolean }>("get_assistant_state");
  if (current.open) onboardingController?.assistantOpened();
}

async function handleAgentNoteUpdated(payload: NoteUpdated) {
  // 与 onFileChanged 对齐：编辑器有未保存的本地修改时跳过 AI 热刷新，
  // 否则磁盘内容会覆盖用户输入，而 pending 仍持旧内容会在后续 flush 时盖回 AI 结果。
  if (isDirty(payload.path)) return;

  const target = resolveAgentWriteNavigation(payload, {
    mode: session.mode,
    project: session.currentProject,
    document: session.currentDocument,
  });
  if (!target) return;

  switch (target.kind) {
    case "inbox":
      applyRemoteDoc(await loadNote(target.path));
      selectView("inbox");
      return;
    case "tasks":
      tasksPanel.setOpen(true);
      await tasksPanel.reload();
      return;
    case "piece":
      await openPiece(target.entry);
      renderWindowState({
        kind: "LOADED",
        project: session.currentProject!,
        piece: target.entry,
      });
      session.surface = "piece";
      applyView();
      return;
    case "document":
      pieceHeader?.exitVersionPreview();
      applyRemotePiece(await loadNote(target.entry.path));
      applyView();
      return;
  }
}

// Agent 一轮内可以连续写多个文件。串行消费成功提交事件，保证每次导航都发生，
// 同时避免较早的异步 loadNote 晚返回后覆盖较新的目标文件。
let agentNoteUpdateQueue = Promise.resolve();
void onNoteUpdated((payload) => {
  agentNoteUpdateQueue = agentNoteUpdateQueue
    .then(() => handleAgentNoteUpdated(payload))
    .catch((error) => console.error("AI write navigation failed", error));
});

// 外部文件修改：Rust watcher 检测到 .md 文件变化后广播，热刷新对应编辑器。
// 如果编辑器有未保存的本地修改（用户正在输入），跳过刷新以避免丢失输入。
void onFileChanged(async (changedPath) => {
  if (isDirty(changedPath)) return;

  const activeFile = activePieceFile();

  // Inbox 被外部修改。
  if (session.currentInbox && changedPath === session.currentInbox.entry.path) {
    try {
      applyRemoteDoc(await loadNote(session.currentInbox.entry.path));
    } catch {
      // _inbox.md 被外部删除 → 该目录不再是项目空间，回到 bootstrap 重新定位。
      console.warn("inbox vanished, re-bootstrapping");
      session.currentInbox = null;
      session.currentProject = null;
      await bootstrapProjects(await getConfig());
    }
    return;
  }
  // 成品（piece）或独立文档被外部修改 / 删除。
  if (activeFile && changedPath === activeFile.path) {
    try {
      pieceHeader?.exitVersionPreview();
      applyRemotePiece(await loadNote(activeFile.path));
    } catch {
      // 文件已不存在（外部删除）→ 列剩余 pieces，切下一片或 NO_PIECE。
      await handleActivePieceGone();
    }
    return;
  }
  // 行动（_tasks.md）被外部修改。
  if (session.currentProject && changedPath === tasksPath(session.currentProject.path)) {
    tasksPanel.reload();
    return;
  }
});

/** 路径已失效（目录被外部改名/移动/删除，写读双向失败）时的恢复：丢弃不可能
 * 落盘的 pending，按路径归属恢复——当前项目的系统文件（_inbox/_tasks）→ 项目
 * 目录已失效，重新 bootstrap 定位；当前 piece/文档 → 复用"当前文件消失"流程；
 * 其余路径仅提示。stalePathHandling 去重：同一路径的恢复不并发重入（冲突处理与
 * 写入放弃回调可能先后命中同一路径）。 */
const stalePathHandling = new Set<string>();
async function handleStaleSavePath(path: string): Promise<void> {
  if (stalePathHandling.has(path)) return;
  stalePathHandling.add(path);
  try {
    discardPending(path);
    const activeFile = activePieceFile();
    const isProjectSystemFile =
      session.currentProject !== null &&
      (path === session.currentInbox?.entry.path ||
        path === tasksPath(session.currentProject.path));
    if (isProjectSystemFile) {
      showToast("项目文件夹已被移动或删除，正在重新定位…");
      session.currentInbox = null;
      session.currentProject = null;
      await bootstrapProjects(await getConfig());
      return;
    }
    if (activeFile && path === activeFile.path) {
      showToast("当前文件已被移动或删除");
      await handleActivePieceGone();
      return;
    }
    showToast("保存失败：文件路径已失效（可能已被移动或删除）");
  } finally {
    stalePathHandling.delete(path);
  }
}

// 保存冲突：磁盘被外部改动而本地有未保存编辑时，由 write_note 的 mtime 守卫触发。
onConflict(async (path, localContent) => {
  const keepMine = await confirmDialog(
    `文件已在外部被修改：\n${path}\n\n「确定」保留我的编辑并覆盖磁盘；「取消」用磁盘版本替换本地。`,
    "保存冲突",
  );
  if (keepMine) {
    try {
      await saveImmediate(path, localContent, { force: true });
      return;
    } catch {
      // 覆盖写入失败：目标路径已不存在（目录被改名/移动/删除）。落入失效兜底，
      // 否则 pending 永远落不了盘，每次编辑都会重弹本对话框。
    }
  } else {
    // 保留磁盘版本：先丢弃本地 pending（清掉 dirty，避免后续重载被跳过），再按路径把
    // 磁盘内容重新注入对应编辑器。路由必须与 onFileChanged 一致——否则 tasks 文件或
    // 已切换项目的旧路径会被错误地塞进 pieceEditor 而覆盖 piece 内容。
    discardPending(path);
    try {
      const activeFile = activePieceFile();
      if (session.currentInbox && path === session.currentInbox.entry.path) {
        applyRemoteDoc(await loadNote(path));
      } else if (activeFile && path === activeFile.path) {
        pieceHeader?.exitVersionPreview();
        applyRemotePiece(await loadNote(path));
      } else if (session.currentProject && path === tasksPath(session.currentProject.path)) {
        tasksPanel.reload();
      } else {
        // 路径已失效（如项目已切换）—— 仅刷新 lastKnown，无对应编辑器需要更新。
        await loadNote(path);
      }
      return;
    } catch {
      // 磁盘版本也读不到：文件已不存在 → 同样落入失效兜底。
    }
  }
  await handleStaleSavePath(path);
});

// 写入重试耗尽（非冲突路径，多为目录被外部移动/删除）：走同一套失效兜底，
// 避免死路径上的写入永远空转、且下次编辑又撞出冲突弹窗。
onSaveGaveUp((path) => {
  void handleStaleSavePath(path);
});

// 关闭/隐藏前尽量把 pending 写盘（窗口关闭被后端改为隐藏，webview 存活，invoke 可完成）。
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushAll();
});
window.addEventListener("pagehide", () => flushAll());

/** 当前装载的 piece / 文档被外部删除后的兜底：项目模式 → 切下一片或 NO_PIECE；
 * 文档模式 → 回到项目或弹切换菜单。不再兜底建时间戳文件。 */
async function handleActivePieceGone() {
  if (session.mode === "document") {
    const gone = session.currentDocument;
    session.currentDocument = null;
    if (gone) {
      session.recentDocuments = session.recentDocuments.filter((p) => p !== gone.path);
      await setRecentDocuments(session.recentDocuments);
    }
    if (session.currentProject) {
      try {
        await openProject(session.currentProject);
        return;
      } catch (err) {
        console.error("return to project failed", err);
      }
    }
    await bootstrapProjects(await getConfig());
    return;
  }
  if (!session.currentProject) return;
  const remaining = await listPieces(session.currentProject.path).catch(() => []);
  if (remaining[0]) {
    session.currentPiece = remaining[0];
    await openPiece(remaining[0]);
    renderWindowState({ kind: "LOADED", project: session.currentProject, piece: remaining[0] });
  } else {
    session.currentPiece = null;
    renderWindowState({ kind: "NO_PIECE", project: session.currentProject });
  }
  session.surface = "piece";
  applyView();
}

function closeMenu() {
  menuEl?.hide();
  menuEl = null;
}

/** 收起二级菜单（委托给 createMenu 的 closeSubmenu：移除子菜单 + 复位 aria-expanded）。 */
function closeSubmenu() {
  menuEl?.closeSubmenu();
}

/** 在 `trigger` 右侧（空间不足则左侧/上方）弹出二级菜单。委托给 createMenu.openSubmenu：
 * 其内部对齐旧 note-app 的 flip 逻辑、Esc 收子菜单、焦点进首项。 */
function openSubmenu(trigger: HTMLElement, items: HTMLElement[]) {
  menuEl?.openSubmenu(trigger, items);
}

const {
  makeSubmenuItem,
  sectionHeader,
  emptySectionHint,
  makeSwitcherRow,
  promptRename,
} = createProjectMenuRenderer({
  closeMenu,
  closeSubmenu,
  openSubmenu,
  isSubmenuOpenFor: (trigger) => menuEl?.isSubmenuOpenFor(trigger) ?? false,
});

/** Record a project as most-recently-used and persist the capped MRU list. */
async function rememberProject(path: string) {
  session.recentProjects = pushRecent(session.recentProjects, path);
  await setRecentProjects(session.recentProjects);
}

/** Record a standalone document as most-recently-used and persist the MRU list. */
async function rememberDocument(path: string) {
  session.recentDocuments = pushRecent(session.recentDocuments, path);
  await setRecentDocuments(session.recentDocuments);
}

async function openProject(project: ProjectEntry) {
  captureTargetLoading += 1;
  try {
    pieceHeader?.exitVersionPreview();
    // 从文档模式返回项目：按离开项目时记下的开关恢复行动面板。
    const wasDocument = session.mode === "document";
    session.mode = "project";
    session.currentDocument = null;
    session.currentProject = project;
    await rememberProject(project.path);
    const entry = inboxEntry(project);
    session.currentInbox = { dir: project.path, entry };
    setProjectLabel(project.name);
    applyRemoteDoc(await loadNote(entry.path));
    // 加载第一篇 piece — 不再兜底建时间戳文件；空列表 → NO_PIECE 空态。
    let pieces: NoteEntry[];
    try {
      pieces = await loadFirstPiece();
    } catch (err) {
      // 项目目录在打开过程中消失（被外部删除/权限丢失）→ 回到 bootstrap 兜底。
      console.error("list pieces failed", err);
      session.currentProject = null;
      session.currentInbox = null;
      await bootstrapProjects(await getConfig());
      return;
    }
    const state = resolveOpenProject({ project, pieces });
    if (state.kind === "LOADED") {
      await openPiece(state.piece);
    } else {
      session.surface = "inbox";
    }
    renderWindowState(state);
    tasksPanel.reload();
    // 文档→项目恢复行动面板：reload 已加载新项目 tasks，setOpen 仅切可见态。
    // 同模式（项目→项目）时 plan.open === 当前开关，setOpen 的 no-op 守卫不触发副作用。
    const plan = actionTargetForTransition({
      from: wasDocument ? "document" : "project",
      to: "project",
      currentOpen: tasksPanel.isOpen(),
      rememberedOpen: session.actionDesiredOpen,
    });
    tasksPanel.setOpen(plan.open);
    applyView();
    // 发布活动笔记（= 当前项目的 _inbox.md），供独立助手窗 / apply_write 定位。
    void invoke("set_active_note", { dir: project.path, noteId: entry.name, path: entry.path, kind: "inbox" });
    assistantHandle.setScope(assistantController.currentScope());
    // 切换文件监听到新项目目录。
    void invoke("watch_dir", { dir: project.path });
    onboardingController?.projectOpened();
  } finally {
    captureTargetLoading -= 1;
  }
}

/** 启动时打开项目：优先 MRU 列表里仍存在的第一个；MRU 为空时扫描工作目录下的
 * 项目空间。工作目录缺失或不可读则静默降级为 NO_PROJECT（不报错给用户）。MRU 解析
 * 本身抛错才进 PATH_ERROR。两者都空时进入 NO_PROJECT 欢迎空态（不强制 scaffold）。 */
async function bootstrapProjects(config: Awaited<ReturnType<typeof getConfig>>) {
  session.recentProjects = config.recent_projects ?? [];
  session.recentDocuments = config.recent_documents ?? [];
  const startDir = config.working_dir ?? "";
  session.currentStartDir = startDir;

  let recentResolved: ProjectEntry[] = [];
  let projects: ProjectEntry[] = [];
  try {
    recentResolved = await resolveProjects(session.recentProjects);
  } catch (err) {
    renderWindowState({ kind: "PATH_ERROR", startDir, error: String(err) });
    return;
  }
  session.recentProjects = recentResolved.map((p) => p.path);

  // MRU 为空时尝试扫描工作目录；工作目录找不到/不可读 → 视为没有工作目录，静默降级。
  if (recentResolved.length === 0 && startDir) {
    try {
      projects = await listProjects(startDir);
    } catch {
      // 工作目录不可读：降级到 NO_PROJECT，不向用户暴露"工作目录"概念。
    }
  }

  const outcome = resolveBootstrap({ recent: recentResolved, projects, startDir });
  if (outcome.kind === "OPEN") {
    await openProject(outcome.project);
    return;
  }
  // NO_PROJECT / PATH_ERROR：terminal 空态，不再自动建项目。
  renderWindowState(outcome);
}

/** Welcome creation uses the saved or per-user default folder without a picker. */
let creatingDefaultProject = false;
async function createDefaultProject() {
  if (creatingDefaultProject) return;
  creatingDefaultProject = true;
  try {
    const project = await createProject(null, DEFAULT_PROJECT_NAME);
    session.currentStartDir = parentDir(project.path);
    await openProject(project);
  } catch (error) {
    showToast("无法创建项目：" + String(error) + "。可从项目菜单选择其他位置新建。");
  } finally {
    creatingDefaultProject = false;
  }
}

/** NO_PIECE 空态"新建作品"：默认名建 piece，载入并聚焦标题栏全选。 */
async function createFirstPiece() {
  if (!session.currentProject) return;
  const entry = await createNote(session.currentProject.path, DEFAULT_PIECE_TITLE);
  await openPiece(entry);
  renderWindowState({ kind: "LOADED", project: session.currentProject, piece: entry });
  session.surface = "piece";
  applyView();
  focusPieceTitle();
}

/** 聚焦并全选 piece 标题栏（用于新建后原地改名）。延迟一帧等布局就位。 */
function focusPieceTitle() {
  requestAnimationFrame(() => pieceHeader?.focusTitle());
}

/** PATH_ERROR"重试"：重新跑一次 bootstrap。 */
async function retryBootstrap() {
  await bootstrapProjects(await getConfig());
}

async function showProjectSwitcher(anchor: HTMLElement) {
  if (menuEl) {
    closeMenu();
    return;
  }

  const [projects, documents] = await Promise.all([
    resolveProjects(session.recentProjects),
    resolveDocuments(session.recentDocuments),
  ]);
  // 顺手把已不存在的路径从 MRU 里清掉（resolve 已经过滤，这里同步内存列表）。
  session.recentProjects = projects.map((p) => p.path);
  session.recentDocuments = documents.map((d) => d.path);

  menuAnchor = anchor;
  const handle = createMenu({ anchor, onOutside: () => { menuEl = null; } });
  const items: HTMLElement[] = [];

  // ── 项目区 ──
  items.push(
    sectionHeader("ph-folder", "项目", {
      ariaLabel: "新建项目",
      onOpen: (trigger) => openProjectAddSubmenu(trigger),
    }),
  );
  if (projects.length > 0) {
    for (const project of projects) {
      items.push(
        makeSwitcherRow({
          label: project.name,
          active: session.mode === "project" && session.currentProject?.path === project.path,
          onOpen: () => {
            closeMenu();
            void openProject(project);
          },
          actions: [
            {
              label: fileManagerRevealLabel(),
              icon: "ph-folder-open",
              onClick: () => void revealPath(project.path),
            },
            {
              label: "重命名",
              icon: "ph-pencil-simple",
              onClick: (host) =>
                void promptRename(host, project.name, async (name) => {
                  const isCurrent = session.currentProject?.path === project.path;
                  const isActive = isCurrent && session.mode === "project";
                  if (isActive) {
                    // 重命名会使旧路径整体失效：先把未落盘编辑写到旧路径（此刻旧目录
                    // 还在，写必然成功），否则后面重开会话时用磁盘内容重载编辑器会
                    // 丢掉这些未保存编辑。
                    await settleAllPendingWrites();
                  }
                  const newPath = await renameProject(project.path, name);
                  session.recentProjects = session.recentProjects.map((p) => (p === project.path ? newPath : p));
                  await setRecentProjects(session.recentProjects);
                  if (isActive) {
                    // 活动项目等价于重新打开：currentInbox / currentPiece / watcher /
                    // active_note 全部重建到新路径。否则编辑器继续往已不存在的旧目录
                    // 写盘，每次保存都被 mtime 守卫误判为外部冲突，冲突弹窗无限循环。
                    await openProject({ name, path: newPath });
                  } else if (isCurrent) {
                    // 文档模式下项目只是后台引用：同步路径即可，不打扰当前文档会话。
                    session.currentProject = { name, path: newPath };
                  }
                }),
            },
            {
              label: "移除",
              icon: "ph-minus-circle",
              onClick: () => void removeProjectFromRecent(project),
            },
            {
              label: "删除",
              icon: "ph-trash",
              danger: true,
              onClick: () => void deleteProjectFlow(project),
            },
          ],
        }),
      );
    }
  } else {
    items.push(emptySectionHint("暂无项目"));
  }

  // ── 文档区 ──
  items.push(
    sectionHeader("ph-file", "文档", {
      ariaLabel: "新建或打开文档",
      onOpen: (trigger) => openDocumentAddSubmenu(trigger),
    }),
  );
  if (documents.length > 0) {
    for (const doc of documents) {
      items.push(
        makeSwitcherRow({
          label: doc.name,
          active: session.mode === "document" && session.currentDocument?.path === doc.path,
          onOpen: () => {
            closeMenu();
            void openDocument(doc);
          },
          actions: [
            {
              label: fileManagerRevealLabel(),
              icon: "ph-folder-open",
              onClick: () => void revealPath(doc.path),
            },
            {
              label: "重命名",
              icon: "ph-pencil-simple",
              onClick: (host) =>
                void promptRename(host, doc.name, async (name) => {
                  const newPath = await renameNote(parentDir(doc.path), doc.name, name);
                  session.recentDocuments = session.recentDocuments.map((p) => (p === doc.path ? newPath : p));
                  await setRecentDocuments(session.recentDocuments);
                  if (session.mode === "document" && session.currentDocument?.path === doc.path) {
                    session.currentDocument = { name, path: newPath };
                    setProjectLabel(name);
                    pieceHeader?.setLabel(name);
                    // 活动笔记随改名指向新路径，避免 AI apply_write 落到已不存在的旧文件。
                    void invoke("set_active_note", { dir: parentDir(newPath), noteId: name, path: newPath, kind: "doc" });
                  }
                }),
            },
            {
              label: "移除",
              icon: "ph-minus-circle",
              onClick: () => void removeDocumentFromRecent(doc),
            },
            {
              label: "删除",
              icon: "ph-trash",
              danger: true,
              onClick: () => void deleteDocumentFlow(doc),
            },
          ],
        }),
      );
    }
  } else {
    items.push(emptySectionHint("暂无文档"));
  }

  const rect = anchor.getBoundingClientRect();
  menuEl = handle;
  handle.showAt(rect.left, rect.bottom + 2, items);
}

async function revealPath(path: string) {
  closeMenu();
  try {
    await revealInFileManager(path);
  } catch (error) {
    console.error("reveal in file manager failed", error);
    showToast("无法在文件管理器中显示该位置");
  }
}

async function deleteProjectFlow(project: ProjectEntry) {
  if (!(await confirmDialog(`删除项目「${project.name}」？其下所有文件都会移到废纸篓。`))) return;
  try {
    await deleteProject(project.path);
  } catch (err) {
    console.error("delete project failed", err);
    return;
  }
  session.recentProjects = session.recentProjects.filter((p) => p !== project.path);
  await setRecentProjects(session.recentProjects);
  const wasActive = session.mode === "project" && session.currentProject?.path === project.path;
  closeMenu();
  if (wasActive) {
    session.currentProject = null;
    session.currentInbox = null;
    session.currentPiece = null;
    await bootstrapProjects(await getConfig());
  }
}

async function deleteDocumentFlow(doc: NoteEntry) {
  if (!(await confirmDialog(`删除文档「${doc.name}」？它会被移到废纸篓。`))) return;
  try {
    await deleteNote(parentDir(doc.path), doc.name);
  } catch (err) {
    console.error("delete document failed", err);
    return;
  }
  session.recentDocuments = session.recentDocuments.filter((p) => p !== doc.path);
  await setRecentDocuments(session.recentDocuments);
  const wasActive = session.mode === "document" && session.currentDocument?.path === doc.path;
  closeMenu();
  if (wasActive) {
    session.currentDocument = null;
    if (session.currentProject) {
      try {
        await openProject(session.currentProject);
        return;
      } catch (err) {
        console.error("return to project failed", err);
      }
    }
    await bootstrapProjects(await getConfig());
  }
}

/** 从最近列表移除项目（不删磁盘文件、不弹确认）。与 deleteProjectFlow 同构地处理
 * "移除的是当前打开项"——清状态后回 bootstrap 重定位。被移除的文件夹仍在原地，
 * 下次「打开现有项目」选同一文件夹即可找回。 */
async function removeProjectFromRecent(project: ProjectEntry) {
  session.recentProjects = removeFromRecent(session.recentProjects, project.path);
  await setRecentProjects(session.recentProjects);
  const wasActive = session.mode === "project" && session.currentProject?.path === project.path;
  closeMenu();
  if (wasActive) {
    session.currentProject = null;
    session.currentInbox = null;
    session.currentPiece = null;
    await bootstrapProjects(await getConfig());
  }
}

/** 从最近列表移除文档（不删磁盘文件、不弹确认）。镜像 removeProjectFromRecent。 */
async function removeDocumentFromRecent(doc: NoteEntry) {
  session.recentDocuments = removeFromRecent(session.recentDocuments, doc.path);
  await setRecentDocuments(session.recentDocuments);
  const wasActive = session.mode === "document" && session.currentDocument?.path === doc.path;
  closeMenu();
  if (wasActive) {
    session.currentDocument = null;
    if (session.currentProject) {
      try {
        await openProject(session.currentProject);
        return;
      } catch (err) {
        console.error("return to project failed", err);
      }
    }
    await bootstrapProjects(await getConfig());
  }
}

/** 「打开现有项目」：选一个已有文件夹；后端无 `_inbox.md` 则自动建空 Inbox，
 * 再加入 MRU 并打开。working_dir 由后端落盘为该文件夹父目录，前端镜像到
 * session.currentStartDir 使后续「在当前目录新建」指向新父目录。 */
async function openExistingProjectFlow() {
  const picked = await open({ directory: true, multiple: false });
  if (typeof picked !== "string") return;
  try {
    const project = await openExistingProject(picked);
    session.currentStartDir = parentDir(project.path);
    await rememberProject(project.path);
    await openProject(project);
  } catch (err) {
    console.error("open existing project failed", err);
    showToast("无法打开该文件夹：" + String(err));
  }
}

/** 在锚点（项目名按钮）下方重建一个空的最小浮层，用于承载命名输入框。
 * 用于「选择位置新建」等会弹原生对话框、可能令主菜单已被外点击关闭的场景。 */
function rebuildMenuAtAnchor(): MenuHandle | null {
  if (!menuAnchor) return null;
  const handle = createMenu({ onOutside: () => { menuEl = null; } });
  const rect = menuAnchor.getBoundingClientRect();
  handle.showAt(rect.left, rect.bottom + 2, []);
  return handle;
}

/** 收起当前菜单，在锚点处开一个只含命名输入框的最小浮层。 */
function beginNewProjectName(parent: string) {
  closeMenu();
  const m = rebuildMenuAtAnchor();
  if (!m) return;
  menuEl = m;
  promptNewProjectName(m.el, parent);
}

/** 项目标题 `+` 的二级菜单：在当前目录新建 / 选择位置新建… */
function openProjectAddSubmenu(trigger: HTMLButtonElement) {
  const items = [
    makeSubmenuItem(`${createIcon({ phosphor: "ph ph-plus", size: 13 }).outerHTML} 在当前目录新建`, {
      disabled: !session.currentProject,
      onClick: () => {
        if (!session.currentProject) return;
        beginNewProjectName(parentDir(session.currentProject.path));
      },
    }),
    makeSubmenuItem(`${createIcon({ phosphor: "ph ph-folder-open", size: 13 }).outerHTML} 选择位置新建…`, {
      onClick: async () => {
        const picked = await open({ directory: true, multiple: false });
        const parent = typeof picked === "string" ? picked : null;
        if (!parent) {
          closeMenu();
          return;
        }
        beginNewProjectName(parent);
      },
    }),
    makeSubmenuItem(`${createIcon({ phosphor: "ph ph-folder-open", size: 13 }).outerHTML} 打开现有项目…`, {
      onClick: async () => {
        closeSubmenu();
        closeMenu();
        await openExistingProjectFlow();
      },
    }),
  ];
  openSubmenu(trigger, items);
}

/** 文档标题 `+` 的二级菜单：新建文档 / 打开 Markdown 文件… */
function openDocumentAddSubmenu(trigger: HTMLButtonElement) {
  const items = [
    makeSubmenuItem(`${createIcon({ phosphor: "ph ph-file-plus", size: 13 }).outerHTML} 新建文档…`, {
      onClick: async () => {
        closeSubmenu();
        closeMenu();
        const doc = await createDocument();
        if (!doc) return;
        await rememberDocument(doc.path);
        await openDocument(doc);
      },
    }),
    makeSubmenuItem(`${createIcon({ phosphor: "ph ph-folder-open", size: 13 }).outerHTML} 打开 Markdown 文件…`, {
      onClick: async () => {
        closeSubmenu();
        closeMenu();
        const doc = await openDocumentFromFile();
        if (!doc) return;
        await rememberDocument(doc.path);
        await openDocument(doc);
      },
    }),
  ];
  openSubmenu(trigger, items);
}

/** Replace `host` (a menu item) — or append to it, if it is the menu — with an
 * inline input that creates a project under `parent` on Enter. */
function promptNewProjectName(host: HTMLElement, parent: string) {
  const input = document.createElement("input");
  input.className = "fn-control switch-new-input";
  input.placeholder = "项目名称";
  if (host === menuEl?.el) host.appendChild(input);
  else host.replaceWith(input);
  input.focus();
  // 阻止"点击外部关闭"在自己的输入框上触发。
  input.addEventListener("click", (e) => e.stopPropagation());

  let submitting = false;
  async function confirm() {
    if (submitting) return;
    const name = input.value.trim();
    if (!name) {
      closeMenu();
      return;
    }
    submitting = true;
    const project = await createProject(parent, name);
    // 后端 create_project 已把 working_dir 落盘为 parent；同步内存镜像，使后续
    // 新建项目/文档默认落在同一目录（"在当前目录新建" 与 "选择位置新建" 共用此路径）。
    session.currentStartDir = parent;
    closeMenu();
    await openProject(project);
  }

  input.addEventListener("keydown", (e) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") { e.preventDefault(); void confirm(); }
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
  });
}

renderTopbar(document.querySelector("#topbar-root")!, {
  onToggleProjects: (anchor) => {
    void showProjectSwitcher(anchor);
  },
  onSelectView: (view) => {
    selectView(view);
  },
  onToggleTasks: () => tasksPanel.toggle(),
});

// #piece-doc-header 已在 app.innerHTML 中就位，挂载文档头到「写作」栏顶部。
mountPieceHeader();

// 标题栏（第一行）：macOS 左侧留给系统红绿灯、可拖拽，最右端助手 icon；
// Windows 由 renderTitlebar 内补自绘窗口按钮。
renderTitlebar(document.querySelector("#titlebar-root")!, {
  // 单击：开/关整个助手。
  onAssistantToggle: async () => {
    await toggleAssistantFromChrome();
  },
});

// Windows 无边框窗口的边缘缩放手柄（非 Windows 早退）。
mountResizeEdges();

// resize 过渡门控：连续拖拽（事件间隔 <120ms）时关掉过渡保证不卡顿；
// 离散跳变（双击标题栏放大、开关助手）是孤立事件，保留过渡 → 平滑动画。
let lastResize = 0;
let resizeSettle: number | undefined;
window.addEventListener("resize", () => {
  const now = performance.now();
  const continuous = now - lastResize < 120;
  lastResize = now;
  noteBody.classList.toggle("resizing", continuous);
  layoutController?.apply();
  applyView();
  tasksPanel.syncLayout();
  if (resizeSettle) clearTimeout(resizeSettle);
  resizeSettle = window.setTimeout(() => noteBody.classList.remove("resizing"), 180);
});

// WebView2 的输入法锚点在窗口被拖动/缩放后会失效（候选框跑到屏幕角落），
// 手势停下后重新聚焦编辑器即可复位。后端只在 Windows 上发这个事件。
const imeAnchorRefresher = createImeAnchorRefresher();
void listen("window-geometry-changed", () => imeAnchorRefresher.schedule());

async function init() {
  const config = await getConfig();
  await bootstrapProjects(config);

  const assistant = await invoke<{ open: boolean }>("get_assistant_state");
  layoutController = createLayoutController(app, { assistantOpen: assistant.open });
  layoutController.apply();
  applyView();

  onboardingController = createOnboardingController({
    app,
    hasProject: () => session.mode === "project" && session.currentProject !== null,
    createPiece: async () => {
      if (!session.currentPiece) await createFirstPiece();
    },
    selectView,
    focusPieceTitle,
    hasDocument: () => session.mode === "document",
    setTasksOpen: (open) => tasksPanel.setOpen(open),
    tasksOpen: () => tasksPanel.isOpen(),
    openAssistant: async () => {
      const current = await invoke<{ open: boolean }>("get_assistant_state");
      if (!current.open) await toggleAssistantFromChrome();
      onboardingController?.assistantOpened();
    },
    captureShortcut: async () => (await getConfig()).shortcut_capture,
    toggleShortcut: async () => (await getConfig()).shortcut_toggle,
    openSettings,
  });
  await onboardingController.start();

  // ── 窗内快捷键 ──
  let uninstallShortcuts: (() => void) | null = null;

  async function loadShortcuts() {
    const ws = await invoke<Record<WindowShortcutId, string>>("get_window_shortcuts");
    const values: Record<WindowShortcutId, string> = { ...WINDOW_SHORTCUT_DEFAULTS, ...ws };
    const bindings = buildBindings(values);
    if (uninstallShortcuts) uninstallShortcuts();
    uninstallShortcuts = installShortcuts(actions, bindings);
  }

  const actions: ShortcutActions = {
    toggleAssistant: async () => {
      await toggleAssistantFromChrome();
    },
    toggleAssistantBubble: async () => {
      const cur = await invoke<{ open: boolean }>("get_assistant_state");
      if (!cur.open) {
        const next = await invoke<{ open: boolean }>("toggle_assistant");
        layoutController?.setAssistantOpen(next.open);
        tasksPanel.syncLayout();
        assistantHandle.setInputOpen(true);
      } else {
        assistantHandle.setInputOpen(!assistantHandle.isInputOpen());
      }
    },
    toggleActionPanel: () => tasksPanel.toggle(),
    quickAddAction: () => tasksPanel.quickAdd(),
    increaseEditorFontSize: () => {
      const size = adjustEditorFontSize(1);
      pieceHeader?.refit();
      showToast(`笔记字号 ${size}px`);
    },
    decreaseEditorFontSize: () => {
      const size = adjustEditorFontSize(-1);
      pieceHeader?.refit();
      showToast(`笔记字号 ${size}px`);
    },
    resetEditorFontSize: () => {
      const size = resetEditorFontSize();
      pieceHeader?.refit();
      showToast(`笔记字号 ${size}px`);
    },
    selectView: (v) => selectView(v),
    startNewConversation: async () => {
      const cur = await invoke<{ open: boolean }>("get_assistant_state");
      if (!cur.open) {
        const next = await invoke<{ open: boolean }>("toggle_assistant");
        layoutController?.setAssistantOpen(next.open);
        tasksPanel.syncLayout();
      }
      assistantHandle.startNewConversation();
    },
    isAssistantStreaming: () => assistantHandle.isStreaming(),
    cancelAssistant: () => assistantHandle.cancel(),
    isActionPanelOpen: () => tasksPanel.isOpen(),
    closeActionPanel: () => tasksPanel.setOpen(false),
    isAssistantBubbleOpen: () => assistantHandle.isInputOpen(),
    collapseAssistantBubble: () => assistantHandle.setInputOpen(false),
    isHistoryPopoverOpen: () => assistantHandle.isHistoryPopoverOpen(),
    closeHistoryPopover: () => assistantHandle.closeHistoryPopover(),
    isPermissionBubbleOpen: () => assistantHandle.isPermissionBubbleOpen(),
    closePermissionBubble: () => assistantHandle.closePermissionBubble(),
    isSkillMenuOpen: () => assistantHandle.isSkillMenuOpen(),
    closeSkillMenu: () => assistantHandle.closeSkillMenu(),
    isMentionMenuOpen: () => assistantHandle.isMentionMenuOpen(),
    closeMentionMenu: () => assistantHandle.closeMentionMenu(),
    canSplit: () => canSplit(window.innerWidth),
  };

  await loadShortcuts();
  await listen<QuotePayload>("quote-captured", ({ payload }) => {
    if (isPreparingUpdate()) { showToast("正在安装更新，请重启后重新采集"); return; }
    if (captureTargetLoading) {
      showToast("文档正在加载，请稍后重新采集");
      return;
    }
    if (session.mode === "document") {
      const document = session.currentDocument;
      if (!document) return;
      if (versionPreview.active) {
        showToast("请先退出版本预览再采集");
        return;
      }
      captureQuote(pieceEditor, payload);
      scheduleSave(document.path, pieceEditor.getMarkdown());
      pieceEditor.focus();
      return;
    }
    const project = session.currentProject;
    const inbox = session.currentInbox;
    if (!project || !inbox) {
      showToast("请先打开项目或独立文档再采集");
      return;
    }
    const writing = session.surface === "piece" && !layoutController?.isSplit();
    if (!structuredInbox.capture(payload, !writing) || !writing) return;
    const snapshot = structuredInbox.snapshot();
    const selection = structuredInbox.editor.withView((view) => view.state.selection.from);
    void saveImmediate(inbox.entry.path, snapshot).then(() => {
      showToast(`已采集到「${project.name}」的采集区`, {
        label: "查看",
        onClick: () => {
          void (async () => {
            if (session.mode !== "project" || session.currentProject?.path !== project.path) {
              await openProject(project);
            }
            structuredInbox.setFilter(null);
            selectView("inbox");
            structuredInbox.editor.setSelection(selection);
            structuredInbox.editor.focus();
            structuredInbox.editor.withView((view) => view.dispatch(view.state.tr.scrollIntoView()));
          })().catch(() => showToast("无法打开采集区"));
        },
      });
    }).catch(() => showToast("采集内容保存失败，请检查文件状态"));
  });
  await listen("window-shortcuts-changed", () => { void loadShortcuts(); });

}

async function initialize() {
  try {
    await init();
    startUpdates();
  } catch (reason) {
    console.error("Note initialization failed", reason);
    clearEmptyState();
    app.classList.add("state-path-error");
    cleanupBodyEmpty = renderEmptyState(bodyEmptyRoot, {
      title: "无法完成启动",
      hint: "请重试以载入项目和新手引导。",
      primary: { label: "重试", action: () => window.location.reload() },
    });
  }
}
await initialize();

attachAutomationToasts();

}
