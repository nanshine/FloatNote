import { createMenu } from "../shared/ui/menu";

const preferenceKey = "floatnote.assistant.hideStarters";

/** Local presentation preference; never changes AI configuration or drafts. */
export function createStarters(actions: (() => void)[], focusComposer: () => void) {
  const el = document.createElement("section");
  el.className = "assistant-suggestions";
  el.setAttribute("aria-label", "提问建议");
  el.hidden = true;
  let dismissed = false;
  let appeared = false;
  let exitTimer: ReturnType<typeof setTimeout> | undefined;
  const permanentlyHidden = () => {
    try { return localStorage.getItem(preferenceKey) === "true"; }
    catch { return false; }
  };
  const close = document.createElement("button");
  close.type = "button";
  close.className = "assistant-suggestions-close";
  close.setAttribute("aria-label", "隐藏提问建议");
  close.setAttribute("aria-haspopup", "menu");
  close.setAttribute("aria-expanded", "false");
  close.innerHTML = '<i class="ph ph-x" aria-hidden="true"></i>';
  el.append(close);
  const menu = createMenu({ anchor: close, placement: "down-right", onOutside: () => close.setAttribute("aria-expanded", "false") });
  menu.el.setAttribute("role", "menu");
  const hideMenu = () => { menu.hide(); close.setAttribute("aria-expanded", "false"); };
  const dismiss = () => {
    dismissed = true;
    hideMenu();
    el.classList.add("is-leaving");
    exitTimer = setTimeout(() => { el.hidden = true; }, 120);
  };
  close.onclick = () => {
    if (menu.isOpen()) { hideMenu(); return; }
    const items = ["本次隐藏", "不再自动显示"].map((label, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "fn-menu__item";
      item.setAttribute("role", "menuitem");
      item.textContent = label;
      item.title = index === 0 ? "当前对话内不再显示，新建对话时恢复" : "记住此选择，重启后也不自动显示";
      item.onclick = () => {
        if (index === 1) {
          try { localStorage.setItem(preferenceKey, "true"); }
          catch { item.textContent = "无法保存，请选择本次隐藏"; return; }
        }
        dismiss();
        focusComposer();
      };
      return item;
    });
    menu.show(items);
    close.setAttribute("aria-expanded", "true");
    items[0].focus();
  };
  menu.el.addEventListener("keydown", (event) => {
    const items = [...menu.el.querySelectorAll<HTMLButtonElement>("button")];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (event.key === "Escape" || event.key === "Tab") {
      hideMenu();
      close.focus();
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); }
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[next].focus();
    }
  });
  const list = document.createElement("div");
  list.className = "assistant-starters";
  [
    ["ph-files", "结合资料梳理观点"],
    ["ph-sparkle", "选择一个 AI 技能"],
    ["ph-chat-circle", "通过追问理清思路"],
  ].forEach(([icon, label], index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.innerHTML = `<i class="ph ${icon}" aria-hidden="true"></i><span>${label}</span>`;
    button.style.setProperty("--starter-delay", `${index * 40}ms`);
    button.onclick = () => { dismiss(); actions[index](); };
    list.append(button);
  });
  el.append(list);
  const onStorage = (event: StorageEvent) => {
    if (event.key === preferenceKey && permanentlyHidden()) { dismissed = true; el.hidden = true; hideMenu(); }
  };
  window.addEventListener("storage", onStorage);
  return {
    el,
    resetForNewConversation() {
      clearTimeout(exitTimer);
      exitTimer = undefined;
      hideMenu();
      dismissed = false;
      appeared = false;
      el.hidden = true;
      el.classList.remove("is-leaving", "is-appearing");
    },
    update(eligible: boolean) {
      const visible = eligible && !dismissed && !permanentlyHidden();
      if (dismissed && exitTimer) return;
      el.hidden = !visible;
      if (!visible) hideMenu();
      if (visible && !appeared) {
        appeared = true;
        el.classList.add("is-appearing");
        list.lastElementChild?.addEventListener("animationend", () => el.classList.remove("is-appearing"), { once: true });
      }
    },
    destroy() { clearTimeout(exitTimer); menu.destroy(); window.removeEventListener("storage", onStorage); el.remove(); },
  };
}
