import { invoke } from "@tauri-apps/api/core";
import { emit, emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { mountAssistant, type AssistantHandle } from "../assistant/assistant";
import {
  agentCancel,
  agentDiscardSession,
  agentRewind,
  agentListSkills,
  agentNewSession,
  agentOpenSession,
  agentSend,
  onAgentEvent,
} from "../platform/agent";
import {
  chatCreate,
  chatDelete,
  chatGetForScope,
  chatListForScope,
  chatOpen,
  chatUpdateTitle,
  sessionDirFromFile,
  type ChatConversation,
  type ChatScope,
} from "../platform/chat-history";
import { type NoteEntry, type ProjectEntry, listNotes, resolveDocuments, resolveProjects } from "./notes-state";
import { NoteSession } from "./note-session";
import { parentDir } from "./recent-projects";
import { getAssistantOutputMode, onAssistantOutputModeChanged } from "../platform/assistant-output";
import { buildSelectionMessage } from "../platform/selection-message";
import {
  completePopupQuestion,
  popupAiSelectionSnapshot,
  type PopupQuestionRequest,
  type PopupQuestionResult,
} from "../platform/selection-popup";
import { onOnboardingPreviewChanged } from "../platform/onboarding";

export function chatScopeForSession(session: NoteSession): ChatScope | null {
  if (session.mode === "document") {
    if (!session.currentDocument) return null;
    return {
      scopeType: "document",
      scopePath: session.currentDocument.path,
      scopeLabel: session.currentDocument.name,
      cwd: parentDir(session.currentDocument.path),
    };
  }
  if (!session.currentProject) return null;
  return {
    scopeType: "project",
    scopePath: session.currentProject.path,
    scopeLabel: session.currentProject.name,
    cwd: session.currentProject.path,
  };
}

interface AssistantControllerDeps {
  region: HTMLElement;
  session: NoteSession;
  openProject: (project: ProjectEntry) => Promise<void>;
  openDocument: (document: NoteEntry) => Promise<void>;
  onChromeStateChange: (open: boolean) => void;
}

export interface AssistantController {
  handle: AssistantHandle;
  currentScope: () => ChatScope | null;
  toggleFromChrome: () => Promise<void>;
}

interface AgentConversationOperations {
  create: (scope: ChatScope) => Promise<ChatConversation>;
  newSession: (conversation: ChatConversation, scope: ChatScope) => Promise<void>;
  discard: (conversation: ChatConversation) => Promise<void>;
  delete: (conversation: ChatConversation) => Promise<unknown>;
}

async function compensateConversation(
  conversation: ChatConversation,
  operations: Pick<AgentConversationOperations, "discard" | "delete">,
): Promise<void> {
  await Promise.allSettled([
    operations.discard(conversation),
    operations.delete(conversation),
  ]);
}

export async function createAgentConversation(
  scope: ChatScope,
  operations: AgentConversationOperations,
): Promise<ChatConversation> {
  const conversation = await operations.create(scope);
  try {
    await operations.newSession(conversation, scope);
    return conversation;
  } catch (error) {
    await compensateConversation(conversation, operations);
    throw error;
  }
}

/** Owns the assistant panel, its agent session bridge, and history-open events. */
export function createAssistantController(deps: AssistantControllerDeps): AssistantController {
  const currentScope = () => chatScopeForSession(deps.session);
  const conversationOperations: AgentConversationOperations = {
    create: chatCreate,
    newSession: (conversation, scope) => agentNewSession({
      conversationId: conversation.id,
      cwd: scope.cwd,
      sessionDir: sessionDirFromFile(conversation.sessionFile),
    }),
    discard: (conversation) => agentDiscardSession({
      conversationId: conversation.id,
    }),
    delete: (conversation) => chatDelete(conversation.id),
  };
  const handle = mountAssistant(deps.region, {
    send: (payload, conversationId) => agentSend({ conversationId, ...payload }),
    rewind: (conversationId, userTurnIndex) => agentRewind(conversationId, userTurnIndex),
    createConversation: (scope) => createAgentConversation(scope, conversationOperations),
    rollbackConversation: async (conversation) => {
      await compensateConversation(conversation, conversationOperations);
    },
    openConversation: async (conversation) => {
      const opened = await chatOpen(conversation.id);
      if (!opened) return null;
      await agentOpenSession({ conversationId: opened.id, sessionFile: opened.sessionFile });
      return opened;
    },
    listConversations: chatListForScope,
    getLastConversation: chatGetForScope,
    updateTitle: chatUpdateTitle,
    subscribe: onAgentEvent,
    cancel: (requestId) => { void agentCancel(requestId); },
    listSkills: agentListSkills,
    getOutputMode: getAssistantOutputMode,
    subscribeOutputMode: onAssistantOutputModeChanged,
    isConfigured: async () => {
      const config = await invoke<{ ai_settings?: { activeProviderId?: string | null; active_provider_id?: string | null } }>("get_config");
      return Boolean(config.ai_settings?.activeProviderId ?? config.ai_settings?.active_provider_id);
    },
    listFiles: async (scope) => {
      if (scope.scopeType === "project") {
        const notes = await listNotes(scope.scopePath);
        return notes.map((note) => ({
          name: note.name,
          kind: note.name === "_inbox" ? "inbox" : note.name === "_tasks" ? "tasks" : "piece",
        }));
      }
      return [{ name: deps.session.currentDocument?.name ?? scope.scopeLabel, kind: "doc" as const }];
    },
  });

  let navigationToken = 0;

  async function openConversationFromHistory(conversation: ChatConversation) {
    const token = ++navigationToken;
    const window = getCurrentWindow();
    await window.show();
    await window.setFocus();
    if (conversation.scopeType === "project") {
      const [project] = await resolveProjects([conversation.scopePath]);
      if (!project) {
        handle.showError("这个项目已不可用，可在对话历史中删除该记录。");
        return;
      }
      await deps.openProject(project);
      if (token !== navigationToken) return;
    } else {
      const [document] = await resolveDocuments([conversation.scopePath]);
      if (!document) {
        handle.showError("这个文档已不可用，可在对话历史中删除该记录。");
        return;
      }
      await deps.openDocument(document);
      if (token !== navigationToken) return;
    }
    await handle.openConversation(conversation);
    if (token === navigationToken) await emit("chat://active", conversation.id);
  }

  void listen<string>("chat://open-id", async (event) => {
    const conversation = await chatOpen(event.payload);
    if (conversation) await openConversationFromHistory(conversation);
  });
  void listen<string>("chat://deleted", () => {
    navigationToken += 1;
    handle.setScope(currentScope());
  });
  void listen<boolean>("agent://configuration-changed", (event) => {
    handle.setConfigured(event.payload);
    if (event.payload) void handle.refreshConversation();
  });
  void onOnboardingPreviewChanged(async (scene) => {
    if (scene === "assistant-configured-empty") handle.setConfigured(true);
    else if (scene === "assistant-unconfigured") handle.setConfigured(false);
    else {
      const config = await invoke<{ ai_settings?: { activeProviderId?: string | null } }>("get_config");
      handle.setConfigured(Boolean(config.ai_settings?.activeProviderId));
    }
  });

  void listen<PopupQuestionRequest>("popup-question-request", async (event) => {
    const request = event.payload;
    const reply = (result: Omit<PopupQuestionResult, "generationId" | "popupRequestId">) =>
      emitTo("selection-popup", "popup-question-result", {
        generationId: request.generationId,
        popupRequestId: request.popupRequestId,
        ...result,
      });
    if (!request.question.trim()) {
      await reply({ ok: false, message: "请输入问题" });
      return;
    }
    const scope = currentScope();
    if (!scope) {
      await reply({ ok: false, message: "请先在 FloatNote 中打开项目或文档" });
      return;
    }
    let sent = false;
    try {
      const capture = await popupAiSelectionSnapshot(request.generationId);
      const prompt = buildSelectionMessage({
        question: request.question,
        selection: capture.text,
        source: capture.source,
      });
      await handle.startConversationWithPrompt(scope, prompt);
      sent = true;
      await completePopupQuestion(request.generationId);
      const window = getCurrentWindow();
      await window.show();
      await window.setFocus();
      const assistant = await invoke<{ open: boolean }>("get_assistant_state");
      if (!assistant.open) {
        const next = await invoke<{ open: boolean }>("toggle_assistant");
        deps.onChromeStateChange(next.open);
      }
      handle.setInputOpen(true);
      await reply({ ok: true, sent: true });
    } catch (error) {
      await reply({
        ok: false,
        sent,
        message: sent ? "已发送，可在对话历史中查看" : error instanceof Error ? error.message : String(error),
      });
    }
  });

  async function toggleFromChrome() {
    const next = await invoke<{ open: boolean }>("toggle_assistant");
    deps.onChromeStateChange(next.open);
    handle.setInputOpen(next.open);
  }

  return { handle, currentScope, toggleFromChrome };
}
