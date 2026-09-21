/** Keep caret reveal from shifting the note's clipped outer scrollports.
 * Descendant scrollports (CodeMirror, math, etc.) retain horizontal scrolling. */
export function guardNoteHorizontalScroll(content: HTMLElement) {
  const containers: HTMLElement[] = [];
  for (let node: HTMLElement | null = content; node; node = node.parentElement) {
    containers.push(node);
    if (node.classList.contains("note-scroll")) break;
  }
  // Detached previews have no note scrollport and need no scroll policy.
  if (!containers.at(-1)?.classList.contains("note-scroll")) containers.length = 0;
  const reset = () => {
    for (const node of containers) {
      if (node.scrollLeft !== 0) node.scrollLeft = 0;
    }
  };
  for (const node of containers) node.addEventListener("scroll", reset);
  reset();
  return {
    reset,
    destroy() {
      for (const node of containers) node.removeEventListener("scroll", reset);
    },
  };
}
