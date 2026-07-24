import { canonicalize, eventToCombo, type WindowShortcutId } from "../shared/shortcuts";

/**
 * 笔记窗中央快捷键分派：唯一一个 document keydown 监听，
 * 分派可绑定组合（助手/气泡/行动/视图/新对话）+ Esc 优先级链 + 字号固定项。
 * 纯函数（resolveEsc/resolveBoundCombo/viewTargetFor）可单测；installShortcuts 是薄 DOM 包装。
 */

export interface Bindings {
  /** canonical combo → action id */
  map: Map<string, WindowShortcutId>;
}

export function buildBindings(values: Record<WindowShortcutId, string>): Bindings {
  const map = new Map<string, WindowShortcutId>();
  for (const id of Object.keys(values) as WindowShortcutId[]) {
    map.set(canonicalize(values[id]), id);
  }
  return { map };
}

export function resolveBoundCombo(combo: string | null, bindings: Bindings): WindowShortcutId | null {
  if (!combo) return null;
  return bindings.map.get(canonicalize(combo)) ?? null;
}

export function viewTargetFor(
  id: WindowShortcutId,
  canSplit: boolean,
): "inbox" | "piece" | "split" | null {
  if (id === "view_inbox") return "inbox";
  if (id === "view_piece") return "piece";
  if (id === "view_split") return canSplit ? "split" : "piece";
  return null;
}

export interface EscContext {
  permissionBubbleOpen: boolean;
  skillMenuOpen: boolean;
  historyPopoverOpen: boolean;
  mentionMenuOpen: boolean;
  focusInAssistant: boolean;
  streaming: boolean;
  actionPanelOpen: boolean;
  bubbleOpen: boolean;
}

export type EscAction =
  | "closePermissionBubble"
  | "closeSkillMenu"
  | "closeMentionMenu"
  | "closeHistoryPopover"
  | "cancelAssistant"
  | "closeActionPanel"
  | "collapseBubble";

export function resolveEsc(ctx: EscContext): EscAction | null {
  if (ctx.permissionBubbleOpen) return "closePermissionBubble";
  if (ctx.skillMenuOpen) return "closeSkillMenu";
  if (ctx.mentionMenuOpen) return "closeMentionMenu";
  if (ctx.historyPopoverOpen) return "closeHistoryPopover";
  if (ctx.focusInAssistant && ctx.streaming) return "cancelAssistant";
  if (ctx.actionPanelOpen) return "closeActionPanel";
  if (ctx.bubbleOpen) return "collapseBubble";
  return null;
}

export interface ShortcutActions {
  toggleAssistant(): void;
  toggleAssistantBubble(): void;
  toggleActionPanel(): void;
  quickAddAction(): void;
  selectView(v: "inbox" | "piece" | "split"): void;
  startNewConversation(): void;
  isAssistantStreaming(): boolean;
  cancelAssistant(): void;
  isActionPanelOpen(): boolean;
  closeActionPanel(): void;
  isAssistantBubbleOpen(): boolean;
  collapseAssistantBubble(): void;
  isHistoryPopoverOpen(): boolean;
  closeHistoryPopover(): void;
  isPermissionBubbleOpen(): boolean;
  closePermissionBubble(): void;
  isSkillMenuOpen(): boolean;
  closeSkillMenu(): void;
  isMentionMenuOpen(): boolean;
  closeMentionMenu(): void;
  canSplit(): boolean;
  increaseEditorFontSize(): void;
  decreaseEditorFontSize(): void;
  resetEditorFontSize(): void;
}

export type FontSizeShortcut = "increase" | "decrease" | "reset";

export function resolveFontSizeShortcut(e: KeyboardEvent): FontSizeShortcut | null {
  if ((!e.metaKey && !e.ctrlKey) || e.altKey) return null;
  if (e.key === "=" || e.key === "+") return "increase";
  if (e.key === "-") return "decrease";
  if (e.key === "0") return "reset";
  return null;
}

function isFocusInAssistant(): boolean {
  const el = document.activeElement;
  return el instanceof Element && !!el.closest("#assistant-region");
}

function runBound(id: WindowShortcutId, a: ShortcutActions): void {
  switch (id) {
    case "assistant": a.toggleAssistant(); break;
    case "assistant_bubble": a.toggleAssistantBubble(); break;
    case "action_panel": a.toggleActionPanel(); break;
    case "add_action": a.quickAddAction(); break;
    case "new_conversation": a.startNewConversation(); break;
    case "view_inbox": a.selectView("inbox"); break;
    case "view_piece": a.selectView("piece"); break;
    case "view_split": a.selectView(viewTargetFor("view_split", a.canSplit()) ?? "piece"); break;
  }
}

function runEsc(act: EscAction, a: ShortcutActions): void {
  switch (act) {
    case "closePermissionBubble": a.closePermissionBubble(); break;
    case "closeSkillMenu": a.closeSkillMenu(); break;
    case "closeMentionMenu": a.closeMentionMenu(); break;
    case "closeHistoryPopover": a.closeHistoryPopover(); break;
    case "cancelAssistant": a.cancelAssistant(); break;
    case "closeActionPanel": a.closeActionPanel(); break;
    case "collapseBubble": a.collapseAssistantBubble(); break;
  }
}

export function installShortcuts(actions: ShortcutActions, bindings: Bindings): () => void {
  const handler = (e: KeyboardEvent) => {
    // 内层控件（输入框、菜单、对话框）消费快捷键后，不能再落到窗口级动作。
    if (e.defaultPrevented) return;
    if (e.key === "Escape") {
      const act = resolveEsc({
        permissionBubbleOpen: actions.isPermissionBubbleOpen(),
        skillMenuOpen: actions.isSkillMenuOpen(),
        mentionMenuOpen: actions.isMentionMenuOpen(),
        historyPopoverOpen: actions.isHistoryPopoverOpen(),
        focusInAssistant: isFocusInAssistant(),
        streaming: actions.isAssistantStreaming(),
        actionPanelOpen: actions.isActionPanelOpen(),
        bubbleOpen: actions.isAssistantBubbleOpen(),
      });
      if (act) {
        e.preventDefault();
        runEsc(act, actions);
      }
      return;
    }
    if (!e.metaKey && !e.ctrlKey) return;
    const fontSizeAction = resolveFontSizeShortcut(e);
    if (fontSizeAction) {
      e.preventDefault();
      if (fontSizeAction === "increase") actions.increaseEditorFontSize();
      else if (fontSizeAction === "decrease") actions.decreaseEditorFontSize();
      else actions.resetEditorFontSize();
      return;
    }
    const id = resolveBoundCombo(eventToCombo(e), bindings);
    if (id) {
      e.preventDefault();
      runBound(id, actions);
    }
  };
  document.addEventListener("keydown", handler);
  return () => document.removeEventListener("keydown", handler);
}
