import "@phosphor-icons/web/regular";
import "../../../src/styles/index.css";
import "../../../src/styles.css";
import "../../../src/assistant/styles.css";
import "./assistant-fixture.css";
import { mountAssistant } from "../../../src/assistant/assistant";
import { createPermissionDialog } from "../../../src/assistant/permission-dialog";
import { projectPermission, type PermissionRequest } from "../../../src/assistant/permission-model";
import type { ChatConversation } from "../../../src/platform/chat-history";

const root = document.querySelector<HTMLElement>("#assistant-region");
if (!root) throw new Error("assistant fixture root is missing");

const params = new URLSearchParams(location.search);
const setup = params.get("setup");
if (params.get("theme")) document.documentElement.dataset.theme = params.get("theme")!;
const now = Date.now();
const conversation: ChatConversation = {
  id: "browser-review",
  sessionFile: "/review/browser-review.jsonl",
  scopeType: "project",
  scopePath: "/review",
  scopeLabel: "Browser review",
  title: "新对话",
  titleState: "temporary",
  createdAt: now,
  updatedAt: now,
  lastOpenedAt: now,
};

const assistant = mountAssistant(root, {
  getReadiness: async () => ({ status: setup === "disabled" ? "disabled" : setup ? "unconfigured" : "ready" }),
  openSettings: async () => { document.body.dataset.settingsTarget = "ai"; },
  rewind: async () => {},
  rollbackConversation: async () => {},
  send: async () => "browser-review-request",
  createConversation: async () => conversation,
  openConversation: async (value) => value,
  listConversations: async () => [],
  getLastConversation: async () => null,
  updateTitle: async (_id, title, titleState) => ({ ...conversation, title, titleState }),
  subscribe: () => () => {},
  cancel: () => {},
  listSkills: async () => [],
  listFiles: async () => [],
});

assistant.setScope({
  scopeType: "project",
  scopePath: "/review",
  scopeLabel: "Browser review",
  cwd: "/review",
});

const permissionRequest: PermissionRequest = {
  request_id: "browser-permission-review",
  conversation_id: "browser-review",
  tool_name: "edit_note",
  old_content: `# 审查\n\n${"这是一段需要在窄窗口内正常换行的普通文本。".repeat(10)}\n\n${"unbreakable".repeat(80)}\n\n旧结论`,
  new_content: `# 审查\n\n${"这是一段需要在窄窗口内正常换行的普通文本。".repeat(10)}\n\n${"unbreakable".repeat(80)}\n\n行内公式 $E=mc^2$\n\n$$\n${Array.from({ length: 30 }, (_, index) => `a_{${index + 1}}`).join(" + ")}\n$$\n\n新结论`,
  preview: { tool: "edit_note", summary: "", detail: { kind: "diff", hunks: "" } },
  can_snapshot: false,
  resolved_path: "/review/piece.md",
};
const permissionDialog = createPermissionDialog({ onResolve: () => {}, onClose: () => {} });
(window as typeof window & { openPermissionReview: () => void }).openPermissionReview = () => {
  permissionDialog.open(permissionRequest, projectPermission(permissionRequest));
};

if (setup) assistant.setInputOpen(true);
document.body.dataset.reviewReady = "true";
