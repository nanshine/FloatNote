import type { MarkType, Node as ProseNode } from "@milkdown/kit/prose/model";
import { type EditorState } from "@milkdown/kit/prose/state";


/** Use every selection range: rectangular cell selections are not one text interval. */
export function selectionTextRuns(state: EditorState) {
  const runs: { node: ProseNode; parent: ProseNode; from: number; to: number }[] = [];
  for (const { $from, $to } of state.selection.ranges) {
    state.doc.nodesBetween($from.pos, $to.pos, (node, pos, parent) => {
      if (node.isText && parent) runs.push({ node, parent, from: Math.max(pos, $from.pos), to: Math.min(pos + node.nodeSize, $to.pos) });
    });
  }
  return runs.filter((run) => run.from < run.to);
}

export function selectionTable(state: EditorState): number | null {
  const { $from, $to } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "table" && $to.depth >= depth && $from.before(depth) === $to.before(depth)) return $from.before(depth);
  }
  return null;
}

/** Annotation menus must not silently skip incompatible selected content. */
export function canAnnotateSelection(state: EditorState, type: MarkType): boolean {
  const runs = selectionTextRuns(state);
  if (state.selection.empty || !runs.some(({ from, to }) => state.doc.textBetween(from, to).trim())) return false;
  let incompatible = false;
  for (const { $from, $to } of state.selection.ranges) {
    state.doc.nodesBetween($from.pos, $to.pos, (node) => {
      if (node.type.spec.code || (node.isAtom && !node.isText && node.type.name !== "hardbreak")) incompatible = true;
    });
  }
  return !incompatible && runs.every(({ parent, node }) => parent.type.allowsMarkType(type)
    && !node.marks.some((mark) => mark.type !== type && (mark.type.excludes(type) || type.excludes(mark.type))));
}
