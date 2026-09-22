import { closeHistory } from "@milkdown/kit/prose/history";
import type { Mark } from "@milkdown/kit/prose/model";
import { TextSelection } from "@milkdown/kit/prose/state";
import type { EditorView } from "@milkdown/kit/prose/view";
import { createModalPaper } from "../ui/modal-paper";
import { externalLinkUrl, hasCodeOrAtom } from "./link-input";

/** Expand across formatting boundaries, but never across different targets. */
function linkRange(view: EditorView): { from: number; to: number; mark: Mark } | null {
  const { $from, from, to } = view.state.selection;
  const runs: { from: number; to: number; mark: Mark }[] = [];
  $from.parent.forEach((node, offset) => {
    const mark = node.marks.find((item) => item.type.name === "link");
    if (!mark) return;
    const start = $from.start() + offset;
    const previous = runs.at(-1);
    if (previous?.to === start && previous.mark.eq(mark)) previous.to += node.nodeSize;
    else runs.push({ from: start, to: start + node.nodeSize, mark });
  });
  return runs.find((run) => run.from <= from && run.to >= to && from < run.to)
    ?? runs.find((run) => run.to === from && from === to) ?? null;
}

export function createLinkEditor(view: EditorView) {
  let close = () => {};
  const modal = createModalPaper({
    ariaLabel: "编辑链接",
    layerClass: "fn-link-dialog",
    backdropClass: "fn-link-dialog__backdrop",
    paperClass: "fn-link-dialog__paper",
    onEscape: () => close(),
  });
  const heading = document.createElement("h2");
  const form = document.createElement("form");
  const field = (title: string, name: string) => {
    const label = document.createElement("label");
    label.textContent = title;
    const input = document.createElement("input");
    input.name = name;
    input.autocomplete = "off";
    label.append(input);
    form.append(label);
    return input;
  };
  const labelInput = field("显示文字", "label");
  const urlInput = field("链接地址", "url");
  urlInput.placeholder = "https://example.com 或邮箱地址";
  urlInput.required = true;
  const error = document.createElement("p");
  error.className = "fn-link-dialog__error";
  error.setAttribute("role", "alert");
  form.append(error);
  modal.paper.append(heading, form);
  let snapshot: {
    doc: EditorView["state"]["doc"];
    from: number;
    to: number;
    label: string;
    title: string | null;
    href: string | null;
    changed: boolean;
  } | null = null;

  function showError(message: string) {
    error.textContent = message;
    urlInput.setAttribute("aria-invalid", "true");
  }
  close = () => {
    const wasOpen = modal.isOpen();
    modal.close({ restoreFocus: false });
    if (snapshot?.changed && view.state.doc === snapshot.doc) view.dispatch(closeHistory(view.state.tr));
    snapshot = null;
    if (wasOpen) view.focus();
  };
  modal.backdrop.onclick = close;
  const autosave = () => {
    if (!snapshot || !view.editable || view.state.doc !== snapshot.doc) { close(); return; }
    const href = externalLinkUrl(urlInput.value);
    if (!href) {
      showError(urlInput.value ? "请输入完整的网页地址或邮箱地址" : "");
      return;
    }
    error.textContent = "";
    urlInput.removeAttribute("aria-invalid");
    const { from, to, label, title } = snapshot;
    const text = labelInput.value || href;
    if (text === label && href === snapshot.href) return;
    const type = view.state.schema.marks.link;
    const tr = snapshot.changed ? view.state.tr : closeHistory(view.state.tr);
    let end = to;
    if (text !== label || from === to) {
      tr.insertText(text, from, to);
      end = from + text.length;
    }
    tr.addMark(from, end, type.create({ href, title })).removeStoredMark(type);
    tr.setSelection(TextSelection.create(tr.doc, end));
    snapshot = { doc: tr.doc, from, to: end, label: text, title, href, changed: true };
    view.dispatch(tr);
  };
  let composing = false;
  form.addEventListener("compositionstart", () => { composing = true; });
  form.addEventListener("compositionend", () => { composing = false; autosave(); });
  form.addEventListener("input", (event) => {
    if (!composing && !(event as InputEvent).isComposing) autosave();
  });
  form.onsubmit = (event) => {
    event.preventDefault();
    if (composing) return;
    autosave();
    close();
  };
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.isComposing || composing) return;
    event.preventDefault();
    autosave();
    close();
  });

  return {
    handleKeyDown(event: KeyboardEvent): boolean {
      const modifier = /Mac/i.test(navigator.platform) ? event.metaKey : event.ctrlKey;
      if (!modifier || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k"
        || event.isComposing || !view.editable) return false;
      event.preventDefault();
      const { state } = view;
      const { selection } = state;
      if (!(selection instanceof TextSelection) || !selection.$from.sameParent(selection.$to)
        || hasCodeOrAtom(state, selection.from, selection.to)) return true;
      const range = linkRange(view);
      const from = range?.from ?? selection.from;
      const to = range?.to ?? selection.to;
      const label = state.doc.textBetween(from, to);
      snapshot = { doc: state.doc, from, to, label, title: range?.mark.attrs.title ?? null, href: range?.mark.attrs.href ?? null, changed: false };
      composing = false;
      heading.textContent = range ? "编辑链接" : "添加链接";
      labelInput.value = label;
      urlInput.value = range?.mark.attrs.href ?? externalLinkUrl(label) ?? "";
      error.textContent = "";
      urlInput.removeAttribute("aria-invalid");
      modal.open();
      urlInput.focus();
      urlInput.select();
      return true;
    },
    close,
    destroy: () => modal.destroy(),
  };
}
