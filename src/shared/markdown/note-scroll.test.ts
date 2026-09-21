// @vitest-environment jsdom
import { expect, it } from "vitest";
import { guardNoteHorizontalScroll } from "./note-scroll";

it("corrects caret reveal without changing vertical or nested horizontal scrolling", () => {
  const outer = document.createElement("div");
  outer.className = "note-scroll";
  const content = outer.appendChild(document.createElement("div"));
  const code = content.appendChild(document.createElement("pre"));
  const guard = guardNoteHorizontalScroll(content);
  outer.scrollTop = 120;
  outer.scrollLeft = 7;
  content.scrollLeft = 3;
  code.scrollLeft = 80;
  outer.dispatchEvent(new Event("scroll"));
  expect(outer.scrollLeft).toBe(0);
  expect(content.scrollLeft).toBe(0);
  expect(outer.scrollTop).toBe(120);
  expect(code.scrollLeft).toBe(80);
  guard.destroy();
  outer.scrollLeft = 7;
  outer.dispatchEvent(new Event("scroll"));
  expect(outer.scrollLeft).toBe(7);
});

it("leaves surfaces without a note scrollport alone", () => {
  const content = document.createElement("div");
  content.scrollLeft = 10;
  const guard = guardNoteHorizontalScroll(content);
  expect(content.scrollLeft).toBe(10);
  guard.destroy();
});
