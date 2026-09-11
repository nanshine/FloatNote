import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type ToolCategory =
  | "skill"
  | "document_read"
  | "document_list"
  | "document_find"
  | "document_search"
  | "web_search"
  | "web_fetch"
  | "document_write"
  | "document_create"
  | "tag"
  | "other";

export type AgentEvent =
  | { type: "session_opened"; conversationId: string; sessionFile: string; messages: ChatDisplayMessage[] }
  | { type: "session_synced"; conversationId: string; sessionFile: string; messages: ChatDisplayMessage[] }
  | { type: "delta"; requestId: string; conversationId: string; text: string }
  | { type: "tool"; requestId: string; conversationId: string; callId: string; name: string; category?: ToolCategory; label?: string; phase: "prepare" | "start" | "end"; error?: string; isError?: boolean }
  | { type: "done"; requestId: string; conversationId: string; outcome?: "completed" | "cancelled" | "failed"; error?: string }
  | { type: "title"; conversationId: string; title: string }
  | { type: "error"; requestId: string | null; conversationId?: string; message: string }
  | { type: "thinking_start"; requestId: string; conversationId: string; blockId: string }
  | { type: "thinking_delta"; requestId: string; conversationId: string; text: string }
  | { type: "thinking_end"; requestId: string; conversationId: string };

export type ChatDisplayMessage =
  | { role: "user"; text: string; timestamp: number; entryId?: string }
  | { role: "assistant"; blocks?: ChatDisplayBlock[]; text?: string; timestamp: number; entryId?: string }
  | { role: "error"; text: string; timestamp: number; entryId?: string };

export type ChatDisplayBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; callId: string; name: string; category?: ToolCategory; label: string; status: "succeeded" | "failed" | "incomplete"; error?: string };

export interface NoteUpdated {
  noteId: string;
  path: string;
  version: number;
}

export interface Skill {
  name: string;
  description: string;
  displayName: string;
  displayDescription: string;
}

export function agentSend(args: {
  conversationId: string;
  userText: string;
  references?: { kind: "file" | "skill"; id: string; display: string; noteKind?: string }[];
  skill?: { name: string };
}): Promise<string> {
  return invoke<string>("agent_send", args);
}

/** Move a conversation's active session branch to immediately before one user turn. */
export function agentRewind(conversationId: string, userEntryId: string): Promise<void> {
  return invoke("agent_rewind", { conversationId, userEntryId });
}

export function agentNewSession(args: { conversationId: string; cwd: string; sessionDir: string }): Promise<void> {
  return invoke<void>("agent_new_session", args);
}

export function agentOpenSession(args: { conversationId: string; sessionFile: string }): Promise<void> {
  return invoke<void>("agent_open_session", args);
}

export function agentDiscardSession(args: { conversationId: string }): Promise<void> {
  return invoke<void>("agent_discard_session", args);
}

export function agentCancel(requestId: string): Promise<void> {
  return invoke<void>("agent_cancel", { requestId });
}

export function agentListSkills(): Promise<Skill[]> {
  return invoke<Skill[]>("agent_list_skills");
}

export function onAgentEvent(cb: (event: AgentEvent) => void): Promise<UnlistenFn> {
  return listen<AgentEvent>("agent://event", (event) => cb(event.payload));
}

export function onNoteUpdated(cb: (payload: NoteUpdated) => void): Promise<UnlistenFn> {
  return listen<NoteUpdated>("note://updated", (event) => cb(event.payload));
}

export function onFileChanged(cb: (path: string) => void): Promise<UnlistenFn> {
  return listen<string>("file://changed", (event) => cb(event.payload));
}
