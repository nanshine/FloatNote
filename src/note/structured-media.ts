import { listen } from "@tauri-apps/api/event";
import { Fragment, Slice } from "@milkdown/kit/prose/model";
import type { StructuredMarkdownEditor } from "../shared/markdown/structured-editor";
import { showToast } from "../shared/toast";
import { importImageFiles, savePastedImage } from "./image-fs";

interface DragDropPayload {
  paths: string[];
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function insertImageLinks(editor: StructuredMarkdownEditor, links: readonly string[], from: number, to: number): void {
  editor.withView((view) => {
    const imageType = view.state.schema.nodes.image;
    const nodes = links.flatMap((link, index) => {
      const match = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(link.trim());
      if (!match) return [];
      const image = imageType.create({ src: match[2], alt: match[1], title: "", width: null, align: null });
      return index === 0 ? [image] : [view.state.schema.text(" "), image];
    });
    if (!nodes.length) return;
    const max = view.state.doc.content.size;
    view.dispatch(view.state.tr.replace(
      Math.min(from, max),
      Math.min(to, max),
      new Slice(Fragment.fromArray(nodes), 0, 0),
    ).scrollIntoView());
  });
}

/** Installs image paste and native file-drop at the structured editor boundary. */
export function attachStructuredMedia(
  editor: StructuredMarkdownEditor,
  getNoteDir: () => string,
): () => Promise<void> {
  const paste = (event: ClipboardEvent) => {
    const file = [...(event.clipboardData?.items ?? [])]
      .find((item) => item.type.startsWith("image/"))?.getAsFile();
    if (!file) return;
    event.preventDefault();
    const dir = getNoteDir();
    if (!dir) return void showToast("未打开项目");
    const selection = editor.withView((view) => ({ from: view.state.selection.from, to: view.state.selection.to }));
    void savePastedImage(dir, file)
      .then((link) => insertImageLinks(editor, [link], selection.from, selection.to))
      .catch((error) => showToast(error instanceof Error ? error.message : "图片粘贴失败"));
  };
  editor.contentDOM.addEventListener("paste", paste);

  let unlisten: (() => void) | undefined;
  const ready = listen<DragDropPayload>("tauri://drag-drop", (event) => {
    if (!editor.contentDOM.contains(document.activeElement)) return;
    const paths = (event.payload.paths ?? []).filter((path) => IMAGE_EXT_RE.test(path));
    const dir = getNoteDir();
    if (!paths.length || !dir) return;
    const selection = editor.withView((view) => ({ from: view.state.selection.from, to: view.state.selection.to }));
    void importImageFiles(dir, paths)
      .then((links) => insertImageLinks(editor, links, selection.from, selection.to))
      .catch((error) => showToast(error instanceof Error ? error.message : "图片导入失败"));
  }).then((fn) => { unlisten = fn; }).catch(() => undefined);

  return async () => {
    editor.contentDOM.removeEventListener("paste", paste);
    await ready;
    unlisten?.();
  };
}
