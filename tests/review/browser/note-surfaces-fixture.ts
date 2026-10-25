import "../../../src/styles/index.css";
import "../../../src/styles.css";
import "./note-surfaces-fixture.css";
import { createStructuredMarkdownEditor } from "../../../src/shared/markdown/structured-editor";

const inboxHost = document.querySelector<HTMLElement>("#inbox-host");
const pieceHost = document.querySelector<HTMLElement>("#piece-host");
if (!inboxHost || !pieceHost) throw new Error("note surface fixture hosts are missing");
const fixtureParams = new URLSearchParams(window.location.search);
const markdown = fixtureParams.has("selection")
  ? "**bold** plain\n\n> quoted\n\n```ts\nconst value = 1;\n```\n\n| A | B |\n| --- | --- |\n| one | two |\n\nafter"
  : fixtureParams.has("long")
  ? Array.from({ length: 80 }, (_, index) => `第 ${index + 1} 段正文`).join("\n\n")
  : fixtureParams.has("image")
    ? "![宽图片](/assets/01-hero.png)"
  : fixtureParams.has("special")
    ? [
      "> [!quote] [Browser](https://example.com)",
      "> captured text",
      "",
      "```ts",
      "const value = 1;",
      "```",
      "",
      "---",
    ].join("\n")
  : fixtureParams.has("lists")
    ? [
      "9. 第九项",
      "10. 第十项",
      "11. 有子列表",
      "    - 无序子项",
      "      - 更深一层",
    ].join("\n")
  : fixtureParams.has("sample")
    ? "正文\n\n---\n\n结尾"
    : "";

const [inbox, piece] = await Promise.all([
  createStructuredMarkdownEditor({
    parent: inboxHost,
    context: { kind: "inbox" },
    placeholder: "在这里写点什么…",
  }),
  createStructuredMarkdownEditor({
    parent: pieceHost,
    context: { kind: "piece" },
    placeholder: "开始写…",
  }),
]);
// Production note loading rebuilds EditorState after the editor is mounted.
// The fixture must exercise that lifecycle or it will miss root replacement.
inbox.load(markdown);
piece.load(markdown);

if (fixtureParams.has("selection")) {
  for (const editor of [inbox, piece]) editor.withView((view) => {
    view.dispatch(view.state.tr.insert(view.state.doc.firstChild!.nodeSize, view.state.schema.nodes.paragraph.create()));
  });
}

document.body.dataset.reviewReady = "true";
