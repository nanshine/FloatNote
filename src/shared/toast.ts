/**
 * Self-contained transient toast, shared across windows (note + popup).
 *
 * Each Vite entry loads a different stylesheet, so the toast can't rely on a
 * shared `.toast` rule being present. This module injects its own `<style>`
 * once per document and creates the element on demand. Append to document.body
 * so it floats above editors/panels (not inside an editable region).
 */
let styleInjected = false;
let toastEl: HTMLElement | null = null;
let dismissTimer: number | null = null;

const TOAST_STYLE = `
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  max-width: min(360px, calc(100vw - 32px));
  box-sizing: border-box;
  background: #1f2937;
  color: #fff;
  font-size: 13px;
  line-height: 1.45;
  padding: 8px 14px;
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.22);
  z-index: 200;
  opacity: 1;
  transition: opacity 200ms ease;
  pointer-events: none;
  white-space: normal;
  overflow-wrap: anywhere;
  text-align: center;
}
.toast.toast-leave {
  opacity: 0;
}
@media (prefers-color-scheme: dark) {
  .toast {
    background: #374151;
  }
}
`;

function ensureStyle(): void {
  if (styleInjected || document.getElementById("floatnote-toast-style")) {
    styleInjected = true;
    return;
  }
  const style = document.createElement("style");
  style.id = "floatnote-toast-style";
  style.textContent = TOAST_STYLE;
  document.head.appendChild(style);
  styleInjected = true;
}

/** Show a brief toast at the bottom-center of the window; auto-dismisses. */
export function showToast(message: string, action?: { label: string; onClick: () => void }): void {
  ensureStyle();
  if (dismissTimer !== null) {
    window.clearTimeout(dismissTimer);
    dismissTimer = null;
  }
  toastEl?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = message;
  el.setAttribute("role", "status");
  if (action) {
    el.style.pointerEvents = "auto";
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.style.cssText = "margin-left:12px;color:inherit;background:transparent;border:0;text-decoration:underline;cursor:pointer;font:inherit";
    button.onclick = () => { el.remove(); action.onClick(); };
    el.appendChild(button);
  }
  document.body.appendChild(el);
  toastEl = el;
  dismissTimer = window.setTimeout(() => {
    el.classList.add("toast-leave");
    window.setTimeout(() => {
      el.remove();
      if (toastEl === el) toastEl = null;
    }, 200);
    dismissTimer = null;
  }, 4000);
}
