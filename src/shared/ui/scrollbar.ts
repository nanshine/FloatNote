/**
 * Self-painted scroll indicator. `thumbParent` is the positioning host (not
 * scrolled); `scroller` is the element that actually scrolls — they may differ.
 * The note window keeps each thumb on a stable column while Inbox and writing
 * provide their actual outer scrollports explicitly.
 *
 * Shared by note, history and assistant scrollports. CSS lives in
 * `src/styles/components.css` as `.fn-scroll__thumb`.
 */
export function initScrollbar(
  thumbParent: HTMLElement,
  scroller: HTMLElement,
): void {
  const thumb = document.createElement("div");
  thumb.className = "fn-scroll__thumb";
  thumbParent.appendChild(thumb);

  let timer: ReturnType<typeof setTimeout> | null = null;
  let dragging = false;

  function hideLater() {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      if (!dragging) thumb.classList.remove("is-visible");
      timer = null;
    }, 900);
  }

  function update() {
    const { scrollTop, scrollHeight, clientHeight } = scroller!;
    if (scrollHeight <= clientHeight) {
      thumb.classList.remove("is-visible");
      return;
    }

    const thumbH = Math.max(28, (clientHeight / scrollHeight) * clientHeight);
    const maxTop = clientHeight - thumbH;
    const thumbTop = (scrollTop / (scrollHeight - clientHeight)) * maxTop;

    thumb.style.height = `${thumbH}px`;
    thumb.style.top = `${thumbTop}px`;
    thumb.classList.add("is-visible");
    if (!dragging) hideLater();
  }

  scroller.addEventListener("scroll", update, { passive: true });
  thumbParent.addEventListener("mouseenter", update, { passive: true });

  thumb.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragging = true;
    thumb.classList.add("is-dragging", "is-visible");
    const startY = event.clientY;
    const startScrollTop = scroller.scrollTop;

    const move = (moveEvent: PointerEvent) => {
      const maxThumbTop = scroller.clientHeight - thumb.offsetHeight;
      const maxScrollTop = scroller.scrollHeight - scroller.clientHeight;
      if (maxThumbTop <= 0 || maxScrollTop <= 0) return;
      scroller.scrollTop = startScrollTop + ((moveEvent.clientY - startY) / maxThumbTop) * maxScrollTop;
    };
    const finish = () => {
      dragging = false;
      thumb.classList.remove("is-dragging");
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", finish);
      document.removeEventListener("pointercancel", finish);
      hideLater();
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", finish);
    document.addEventListener("pointercancel", finish);
  });

  if (typeof ResizeObserver !== "undefined") new ResizeObserver(update).observe(scroller);
  update();
}
