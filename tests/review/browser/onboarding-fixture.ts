import "../../../src/styles/index.css";
import "../../../src/styles.css";
import "@phosphor-icons/web/regular";
import { mockIPC, mockWindows } from "@tauri-apps/api/mocks";
import { createOnboardingController } from "../../../src/note/onboarding";
import type { OnboardingState, OnboardingStep } from "../../../src/platform/onboarding";
import starterInbox from "../../../src-tauri/resources/onboarding/inbox.md?raw";
import { decodeInbox } from "@floatnote/note-logic";
import { applyQuoteSources } from "../../../src/note/capture";
import guide from "../../../src-tauri/resources/onboarding/guide.md?raw";
import { createStructuredMarkdownEditor } from "../../../src/shared/markdown/structured-editor";
import { renderEmptyState } from "../../../src/shared/ui/empty-state";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
const scene = params.get("scene") ?? "capture";
const app = document.querySelector<HTMLElement>("#app")!;
const content = document.querySelector<HTMLElement>("#fixture-content")!;
let project = scene !== "welcome" && !params.has("document");
let tasks = false;
let state: OnboardingState = { version: 1, status: "in_progress", step: (scene === "capture-success" || scene === "capture-permission" ? "capture" : scene) as OnboardingStep, capture_succeeded: scene === "capture-success" };
mockWindows("main");
mockIPC((command, payload) => {
  if (command === "get_onboarding_state") return state;
  if (command === "set_onboarding_state") {
    state = (payload as { onboarding: OnboardingState }).onboarding;
    document.body.dataset.onboardingStatus = state.status;
    return state;
  }
  if (command === "get_onboarding_preview") return null;
  if (command === "get_capture_permission_state") return scene === "capture-permission" ? "required" : "granted";
  if (command === "request_capture_permission") return "granted";
  if (command === "plugin:dialog|confirm") return true;
  return null;
}, { shouldMockEvents: true });
const panel = document.createElement("section");
panel.className = "tasks-panel";
panel.style.cssText = "top:90px;display:none";
panel.innerHTML = '<div class="tasks-head">行动清单<button aria-label="添加行动">＋</button></div><p>暂无待办</p>';
app.append(panel);
const controller = createOnboardingController({
  app,
  hasProject: () => project,
  hasDocument: () => params.has("document"),
  createPiece: async () => { content.textContent = "未命名作品"; },
  selectView: (view) => { app.dataset.view = view; },
  focusPieceTitle: () => {},
  setTasksOpen: (open) => { tasks = open; panel.style.display = open ? "flex" : "none"; },
  tasksOpen: () => tasks,
  openAssistant: async () => { app.dataset.assistantOpen = "true"; controller.assistantOpened(); },
  captureShortcut: async () => "Alt+Cmd+C",
    toggleShortcut: async () => "Alt+Ctrl+N", openSettings: async () => {},
});
document.querySelector("#tasks-toggle")!.addEventListener("click", () => {
  tasks = !tasks; panel.style.display = tasks ? "flex" : "none"; controller.tasksChanged();
});
document.querySelector("#assistant-btn")!.addEventListener("click", () => controller.assistantOpened());
if (scene === "welcome") {
  app.classList.add("state-no-project");
  const openProject = () => { project = true; content.replaceChildren(); app.classList.remove("state-no-project"); controller.projectOpened(); };
  renderEmptyState(content, {
    icon: "pen-nib", title: "把读到的变成学会的", hint: "收集材料，写下观点，让 AI 陪你深入思考。",
    primary: { label: "创建新项目", action: openProject },
  });
}
if (scene === "tutorial" || scene === "tutorial-inbox") {
  state = { ...state, status: "completed", step: "access" };
  content.style.overflowY = "auto";
  const decoded = decodeInbox(starterInbox);
  const inbox = scene === "tutorial-inbox";
  const editor = await createStructuredMarkdownEditor({ parent: content, context: { kind: inbox ? "inbox" : "piece" }, markdown: inbox ? decoded.markdown : guide });
  if (inbox) editor.withView((view) => applyQuoteSources(view, editor.getMarkdown(), decoded.metadata));
}
await controller.start();
document.body.dataset.reviewReady = "true";
