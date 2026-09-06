import type { ChatScope } from "../../platform/chat-history";
import type { MentionFile } from "../mention-picker";
import type { SkillSummary } from "../skill-picker";
import { Selection } from "@milkdown/kit/prose/state";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import { createStructuredMarkdownEditor, type StructuredMarkdownEditor } from "../../shared/markdown/structured-editor";
import { mountInputOverlay } from "./overlay";
import { detectTrigger, type Trigger } from "./trigger";
import { filterItems, type Candidate } from "./filter";
import { composePromptPayload, type PromptPayload } from "./submit";
import { docFromClipboard, parseDoc, REF_CLIPBOARD_MIME, refToken, type Ref } from "./model";

const COMPACT_INPUT_MAX_HEIGHT = 120;

export interface ComposerOptions {
  editorHost: HTMLElement;
  wrapHost: HTMLElement;
  getDockHost?: () => HTMLElement;
  placeholder: string;
  getScope: () => ChatScope | null;
  listFiles: (scope: ChatScope) => Promise<MentionFile[]>;
  listSkills: () => Promise<SkillSummary[]>;
  onSubmit: (payload: PromptPayload) => Promise<boolean>;
  onEmptySend?: () => void;
  onChange?: () => void;
  onLargeChange?: (large: boolean) => void;
}

export interface ComposerHandle {
  destroy: () => void;
  focus: () => void;
  clear: () => void;
  isEmpty: () => boolean;
  getDoc: () => string;
  insertText: (text: string, at?: number) => void;
  select: (head: number) => void;
  pressKey: (key: string, opts?: KeyboardEventInit) => void;
  pressComposition: (phase: "start" | "end") => void;
  __setComposing: (flag: boolean) => void;
  isPopoverOpen: () => boolean;
  closePopover: () => void;
  isLarge: () => boolean;
  isHeightLimited: () => boolean;
  collapseLarge: () => void;
  expandLarge: () => void;
  setScope: (scope: ChatScope | null) => void;
  submit: () => void;
  openSkillPicker: () => void;
}

interface RefMenu {
  el: HTMLElement;
  candidates: Candidate[];
  active: number;
  trigger: Trigger | null;
}

export function mountComposer(options: ComposerOptions): ComposerHandle {
  let editor: StructuredMarkdownEditor | null = null;
  let pendingMarkdown = "";
  let pendingSelection = 1;
  let currentScope = options.getScope();
  let fileCache: { scope: ChatScope; files: MentionFile[] } | null = null;
  let skillCache: SkillSummary[] | null = null;
  let composing = false;
  let submitting = false;
  let destroyed = false;
  let large = false;
  let triggerToken = 0;
  const cleanups: (() => void)[] = [];

  const menu: RefMenu = {
    el: document.createElement("div"),
    candidates: [],
    active: 0,
    trigger: null,
  };
  menu.el.className = "fn-popover fn-ref-popover";
  menu.el.hidden = true;
  menu.el.setAttribute("role", "listbox");
  document.body.append(menu.el);

  const overlay = mountInputOverlay({
    host: options.wrapHost,
    getDockHost: options.getDockHost ?? (() => options.wrapHost.parentElement ?? document.body),
    getView: () => editor ? { requestMeasure: () => undefined, focus: () => editor?.focus() } : null,
    onCollapse: () => editor?.focus(),
    onLargeChange(value) {
      large = value;
      options.onLargeChange?.(value);
    },
  });

  function refs(): Ref[] {
    if (!editor) return [];
    return editor.withView((view) => {
      const found: Ref[] = [];
      view.state.doc.descendants((node) => {
        if (node.type.name !== "assistant_ref") return;
        found.push({
          kind: node.attrs.kind,
          id: node.attrs.id,
          display: node.attrs.display,
          meta: node.attrs.noteKind ? { noteKind: node.attrs.noteKind } : undefined,
        });
      });
      return found;
    });
  }

  function selectionTokenDoc(): string {
    if (!editor) return "";
    return editor.withView((view) => {
      const { from, to } = view.state.selection;
      if (from === to) return "";
      let result = "";
      view.state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.isText && node.text) {
          const start = Math.max(from, pos) - pos;
          const end = Math.min(to, pos + node.nodeSize) - pos;
          result += node.text.slice(start, end);
        } else if (node.type.name === "assistant_ref" && pos >= from && pos < to) {
          result += refToken({
            kind: node.attrs.kind,
            id: node.attrs.id,
            display: node.attrs.display,
            meta: node.attrs.noteKind ? { noteKind: node.attrs.noteKind } : undefined,
          });
          return false;
        }
      });
      return result;
    });
  }

  function installClipboard(): void {
    if (!editor) return;
    const copy = (event: ClipboardEvent) => {
      if (!event.clipboardData) return;
      const tokenDoc = selectionTokenDoc();
      if (!tokenDoc) return;
      const segments = parseDoc(tokenDoc);
      event.preventDefault();
      event.clipboardData.setData("text/plain", segments.map((segment) => (
        segment.type === "text" ? segment.text : `@${segment.ref.display}`
      )).join(""));
      event.clipboardData.setData(REF_CLIPBOARD_MIME, JSON.stringify(segments));
    };
    const cut = (event: ClipboardEvent) => {
      copy(event);
      if (!event.defaultPrevented || !editor) return;
      editor.withView((view) => view.dispatch(view.state.tr.deleteSelection()));
    };
    const paste = (event: ClipboardEvent) => {
      if (!event.clipboardData || !editor) return;
      const structured = event.clipboardData.getData(REF_CLIPBOARD_MIME);
      if (!structured) return;
      const tokenDoc = docFromClipboard(event.clipboardData.getData("text/plain"), structured);
      const segments = parseDoc(tokenDoc);
      event.preventDefault();
      editor.withView((view) => {
        const refType = view.state.schema.nodes.assistant_ref;
        const nodes = segments.flatMap((segment) => {
          if (segment.type === "text") return segment.text ? [view.state.schema.text(segment.text)] : [];
          return [refType.create({
            kind: segment.ref.kind,
            id: segment.ref.id,
            display: segment.ref.display,
            noteKind: segment.ref.meta?.noteKind ?? null,
          })];
        });
        view.dispatch(view.state.tr.replaceSelection(new Slice(Fragment.fromArray(nodes), 0, 0)));
      });
    };
    editor.contentDOM.addEventListener("copy", copy);
    editor.contentDOM.addEventListener("cut", cut);
    editor.contentDOM.addEventListener("paste", paste);
    cleanups.push(() => {
      editor?.contentDOM.removeEventListener("copy", copy);
      editor?.contentDOM.removeEventListener("cut", cut);
      editor?.contentDOM.removeEventListener("paste", paste);
    });
  }

  function getDoc(): string {
    const markdown = (editor?.getMarkdown() ?? pendingMarkdown).replace(/\n$/, "");
    const tokens = refs().map(refToken).join("");
    return `${markdown}${tokens}`;
  }

  function renderMenu(candidates: Candidate[], trigger: Trigger): void {
    const scored = filterItems(candidates, trigger.query);
    if (scored.length === 0) return closeMenu();
    menu.candidates = scored.map((item) => item.candidate);
    menu.active = 0;
    menu.trigger = trigger;
    menu.el.replaceChildren();
    for (const [index, candidate] of menu.candidates.entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "fn-ref-popover-item";
      button.classList.toggle("active", index === 0);
      button.textContent = candidate.ref.display;
      button.onmouseenter = () => { menu.active = index; refreshActive(); };
      button.onclick = () => confirmMenu();
      menu.el.append(button);
    }
    menu.el.hidden = false;
    const rect = options.editorHost.getBoundingClientRect();
    menu.el.style.left = `${rect.left}px`;
    menu.el.style.top = `${rect.top - menu.el.offsetHeight - 6}px`;
  }

  function refreshActive(): void {
    [...menu.el.children].forEach((child, index) => child.classList.toggle("active", index === menu.active));
  }

  function closeMenu(): void {
    menu.el.hidden = true;
    menu.candidates = [];
    menu.trigger = null;
  }

  function plainTextBeforeSelection(): { text: string; blockStart: number } | null {
    if (!editor) return null;
    return editor.withView((view) => {
      const { $from } = view.state.selection;
      return {
        text: $from.parent.textBetween(0, $from.parentOffset, "\n", "\uFFFC"),
        blockStart: $from.start(),
      };
    });
  }

  async function recompute(): Promise<void> {
    const current = plainTextBeforeSelection();
    if (!current) return;
    const trigger = detectTrigger(current.text, current.text.length);
    if (!trigger) { closeMenu(); return; }
    const token = ++triggerToken;
    if (trigger.mode === "file") {
      if (!currentScope) return closeMenu();
      if (!fileCache || fileCache.scope.scopePath !== currentScope.scopePath) {
        fileCache = { scope: currentScope, files: await options.listFiles(currentScope) };
      }
      if (token !== triggerToken) return;
      renderMenu(fileCache.files.map((file) => ({
        ref: { kind: "file", id: file.name, display: file.name, meta: { noteKind: file.kind } },
      })), { ...trigger, from: current.blockStart + trigger.from, to: current.blockStart + trigger.to });
    } else {
      skillCache ??= await options.listSkills().catch(() => []);
      if (token !== triggerToken) return;
      renderMenu(skillCache.map((skill) => ({
        ref: { kind: "skill", id: skill.name, display: skill.displayName ?? skill.name },
        description: skill.displayDescription ?? skill.description,
      })), { ...trigger, from: current.blockStart + trigger.from, to: current.blockStart + trigger.to });
    }
  }

  function confirmMenu(): void {
    if (!editor || !menu.trigger || menu.candidates.length === 0) return;
    const ref = menu.candidates[menu.active].ref;
    const trigger = menu.trigger;
    editor.withView((view) => {
      const type = view.state.schema.nodes.assistant_ref;
      view.dispatch(view.state.tr.replaceWith(trigger.from, trigger.to, type.create({
        kind: ref.kind,
        id: ref.id,
        display: ref.display,
        noteKind: ref.meta?.noteKind ?? null,
      })));
    });
    closeMenu();
    editor.focus();
    options.onChange?.();
  }

  function submit(): void {
    if (submitting || destroyed) return;
    const doc = getDoc();
    const payload = composePromptPayload(doc);
    if (!payload.userText.trim() && payload.references.length === 0) {
      if (!large) options.onEmptySend?.();
      return;
    }
    submitting = true;
    Promise.resolve(options.onSubmit(payload)).then((accepted) => {
      if (accepted && getDoc() === doc) {
        editor?.load("");
        pendingMarkdown = "";
        closeMenu();
        overlay.collapse();
        options.onChange?.();
      }
    }).catch(() => false).finally(() => { submitting = false; });
  }

  void createStructuredMarkdownEditor({
    parent: options.editorHost,
    markdown: pendingMarkdown,
    context: { kind: "composer" },
    placeholder: options.placeholder,
    className: "fn-assistant-structured-editor",
    onChange(markdown) {
      pendingMarkdown = markdown;
      void recompute();
      options.onChange?.();
    },
    onSelectionChange: () => { void recompute(); },
    handleKeyDown(event) {
      if (composing) return event.key === "Enter";
      if (!menu.el.hidden) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          menu.active = (menu.active + (event.key === "ArrowDown" ? 1 : -1) + menu.candidates.length) % menu.candidates.length;
          refreshActive();
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") { confirmMenu(); return true; }
        if (event.key === "Escape") { closeMenu(); return true; }
      }
      if (event.key === "Enter" && !event.shiftKey && !large) { submit(); return true; }
      if (event.key === "Escape" && large) { overlay.collapse(); return true; }
      return false;
    },
  }).then((created) => {
    if (destroyed) return void created.destroy();
    editor = created;
    editor.contentDOM.addEventListener("compositionstart", () => { composing = true; });
    editor.contentDOM.addEventListener("compositionend", () => { composing = false; void recompute(); });
    installClipboard();
    if (pendingMarkdown) editor.load(pendingMarkdown);
    editor.setSelection(pendingSelection);
  });

  const handle: ComposerHandle = {
    destroy() { destroyed = true; cleanups.splice(0).forEach((cleanup) => cleanup()); closeMenu(); menu.el.remove(); overlay.destroy(); void editor?.destroy(); },
    focus: () => editor?.focus(),
    clear() { pendingMarkdown = ""; editor?.load(""); closeMenu(); },
    isEmpty: () => !getDoc().trim(),
    getDoc,
    insertText(text, at) {
      if (!editor) { pendingMarkdown += text; pendingSelection = pendingMarkdown.length; return; }
      editor.withView((view) => {
        const pos = at ?? view.state.selection.from;
        const transaction = view.state.tr.insertText(text, pos, pos);
        transaction.setSelection(Selection.near(transaction.doc.resolve(
          Math.min(pos + text.length, transaction.doc.content.size),
        )));
        view.dispatch(transaction);
      });
    },
    select(head) { pendingSelection = head; editor?.setSelection(head); },
    pressKey(key, init) { editor?.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init })); },
    pressComposition(phase) { editor?.contentDOM.dispatchEvent(new CompositionEvent(phase === "start" ? "compositionstart" : "compositionend", { bubbles: true })); },
    __setComposing: (value) => { composing = value; },
    isPopoverOpen: () => !menu.el.hidden,
    closePopover: closeMenu,
    isLarge: () => large,
    isHeightLimited: () => options.editorHost.scrollHeight >= COMPACT_INPUT_MAX_HEIGHT,
    collapseLarge: overlay.collapse,
    expandLarge: overlay.expand,
    setScope(scope) { currentScope = scope; fileCache = null; },
    submit,
    openSkillPicker() { handle.insertText("/"); void recompute(); editor?.focus(); },
  };
  return handle;
}
