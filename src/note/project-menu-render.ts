import { isImeComposing } from "../shared/keyboard";
import { createIcon } from "../shared/ui/icon";

export function fileManagerRevealLabel(platform = navigator.platform): string {
  return /Mac/i.test(platform) ? "在 Finder 中显示" : "在文件资源管理器中显示";
}

export interface RowAction {
  label: string;
  /** Phosphor icon class without the `ph ` prefix, e.g. `ph-pencil-simple`. */
  icon: string;
  /** Danger actions render red (e.g. delete). */
  danger?: boolean;
  /** Receives the row element so rename can replace it in-place. */
  onClick: (row: HTMLElement) => void;
}

export interface SwitcherRowOpts {
  label: string;
  active?: boolean;
  onOpen: () => void;
  actions: RowAction[];
}

interface ProjectMenuRendererDeps {
  closeMenu: () => void;
  closeSubmenu: () => void;
  openSubmenu: (trigger: HTMLElement, items: HTMLElement[]) => void;
  isSubmenuOpenFor: (trigger: HTMLElement) => boolean;
}

export function createProjectMenuRenderer(deps: ProjectMenuRendererDeps) {
  function makeSubmenuItem(
    label: string,
    opts: { onClick?: () => void; disabled?: boolean; ariaLabel?: string } = {},
  ): HTMLElement {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "fn-menu__item switch-submenu-item";
    item.innerHTML = label;
    if (opts.ariaLabel) item.setAttribute("aria-label", opts.ariaLabel);
    if (opts.disabled) {
      item.disabled = true;
      item.classList.add("disabled", "is-disabled");
    } else if (opts.onClick) {
      item.onclick = (event) => {
        event.stopPropagation();
        opts.onClick?.();
      };
    }
    return item;
  }

  function sectionHeader(
    icon: string,
    label: string,
    add?: { ariaLabel: string; onOpen: (trigger: HTMLButtonElement) => void },
  ): HTMLElement {
    const header = document.createElement("div");
    header.className = "switch-section";
    const headerLabel = document.createElement("span");
    headerLabel.textContent = label;
    header.append(createIcon({ phosphor: `ph ${icon}`, size: 11 }), headerLabel);
    if (!add) return header;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "switch-section-add";
    button.setAttribute("aria-label", add.ariaLabel);
    button.setAttribute("aria-haspopup", "menu");
    button.setAttribute("aria-expanded", "false");
    button.append(createIcon({ phosphor: "ph ph-plus", size: 14 }));
    button.onclick = (event) => {
      event.stopPropagation();
      if (deps.isSubmenuOpenFor(button)) {
        deps.closeSubmenu();
        return;
      }
      add.onOpen(button);
    };
    header.appendChild(button);
    return header;
  }

  function emptySectionHint(text: string): HTMLElement {
    const hint = document.createElement("div");
    hint.className = "switch-empty-hint";
    hint.textContent = text;
    return hint;
  }

  function buildKebabItems(row: HTMLElement, actions: RowAction[]): HTMLElement[] {
    return actions.map((action) => {
      const item = makeSubmenuItem(
        `${createIcon({ phosphor: `ph ${action.icon}`, size: 13 }).outerHTML} ${action.label}`,
        {
        onClick: () => {
          deps.closeSubmenu();
          action.onClick(row);
        },
      });
      if (action.danger) item.classList.add("danger", "fn-menu__item--danger");
      return item;
    });
  }

  function openRowKebab(trigger: HTMLElement, row: HTMLElement, actions: RowAction[]) {
    deps.openSubmenu(trigger, buildKebabItems(row, actions));
  }

  function makeSwitcherRow(opts: SwitcherRowOpts): HTMLElement {
    const row = document.createElement("div");
    row.className = "switch-row";
    if (opts.active) row.classList.add("active");

    const label = document.createElement("button");
    label.className = "switch-row-label";
    label.innerHTML = `<span class="switch-row-name">${opts.label}</span>`;
    label.onclick = (event) => {
      event.stopPropagation();
      opts.onOpen();
    };

    const kebab = document.createElement("button");
    kebab.type = "button";
    kebab.className = "switch-row-action switch-row-kebab";
    kebab.title = "更多";
    kebab.setAttribute("aria-label", "更多操作");
    kebab.setAttribute("aria-haspopup", "menu");
    kebab.setAttribute("aria-expanded", "false");
    kebab.append(createIcon({ phosphor: "ph ph-dots-three-vertical", size: 13 }));
    kebab.onclick = (event) => {
      event.stopPropagation();
      if (deps.isSubmenuOpenFor(kebab)) {
        deps.closeSubmenu();
        return;
      }
      openRowKebab(kebab, row, opts.actions);
    };

    const actions = document.createElement("div");
    actions.className = "switch-row-actions";
    actions.appendChild(kebab);
    row.append(label, actions);
    return row;
  }

  function promptRename(host: HTMLElement, currentName: string, commit: (name: string) => Promise<void>) {
    const input = document.createElement("input");
    input.className = "fn-control switch-new-input";
    input.value = currentName;
    host.replaceWith(input);
    input.focus();
    input.select();
    input.addEventListener("click", (event) => event.stopPropagation());

    // settled：已提交或已取消，防止 Enter / blur / 外部 pointerdown 多路径重复提交。
    let settled = false;

    // 菜单的重命名此前「只有回车才提交，失焦只关菜单不落盘」。中文输入法下确认
    // 候选词的回车会被 isImeComposing 吞掉，用户随后点别处 → 编辑被静默丢弃（表现为
    // 「重命名没有用」，Windows/WebView2 下尤甚）。现改为「失焦即提交」，与写作区
    // 标题的 commitRename 对齐。
    function detachPointerGuard() {
      document.removeEventListener("pointerdown", onOutsidePointerDown, true);
    }

    async function confirm() {
      if (settled) return;
      settled = true;
      detachPointerGuard();
      const name = input.value.trim();
      // 空 / 未改名 → 只关菜单，不落盘。
      if (!name || name === currentName) {
        deps.closeMenu();
        return;
      }
      try {
        await commit(name);
      } catch (error) {
        console.error("rename failed", error);
      }
      deps.closeMenu();
    }

    function cancel() {
      if (settled) return;
      settled = true;
      detachPointerGuard();
      deps.closeMenu();
    }

    // 点击输入框以外时，菜单的 outside-pointerdown（冒泡阶段）会先把 input 从 DOM
    // 移除，而被移除元素的 blur 在部分内核并不触发；再挂一个「捕获阶段」pointerdown
    // 兜底——它先于菜单的冒泡处理器执行，确保点击别处也能提交而非丢弃。
    function onOutsidePointerDown(event: PointerEvent) {
      if (!input.isConnected) {
        detachPointerGuard();
        return;
      }
      if (input.contains(event.target as Node)) return; // 点在输入框内：继续编辑
      void confirm();
    }
    document.addEventListener("pointerdown", onOutsidePointerDown, true);

    input.addEventListener("keydown", (event) => {
      if (isImeComposing(event)) return;
      if (event.key === "Enter") {
        event.preventDefault();
        void confirm();
      }
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        cancel();
      }
    });
    // 键盘切走焦点（如 Tab）时 input 仍在 DOM，blur 可靠触发 → 提交。
    input.addEventListener("blur", () => {
      void confirm();
    });
  }

  return {
    makeSubmenuItem,
    sectionHeader,
    emptySectionHint,
    buildKebabItems,
    openRowKebab,
    makeSwitcherRow,
    promptRename,
  };
}
