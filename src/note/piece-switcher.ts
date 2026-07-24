import { sanitizePieceStem } from "./piece-name";
import {
  confirmDialog,
  createNote,
  deleteNote,
  listPieces,
  renameNote,
  type NoteEntry,
} from "./notes-state";
import { formatVersionEntry, type VersionEntry } from "./versions";
import { isImeComposing } from "../shared/keyboard";
import { createIcon } from "../shared/ui/icon";
import { createMenu, type MenuHandle } from "../shared/ui/menu";
import { showToast } from "../shared/toast";

export interface PieceHeaderHost {
  /** 当前项目文件夹路径。 */
  dir: () => string;
  /** 当前成品（用于高亮 / 重命名旧名）。 */
  current: () => NoteEntry | null;
  /** 切到某成品（switch / 新建 / 重命名后）。 */
  open: (entry: NoteEntry) => void;
  /** 读取当前成品的版本列表。 */
  loadVersions: (target: NoteEntry) => Promise<VersionEntry[]>;
  /** 手动记录当前成品为一个新版本。 */
  snapshot: (target: NoteEntry) => Promise<void>;
  /** 无副作用地把版本 v 显示为只读预览。 */
  preview: (target: NoteEntry, v: number) => Promise<boolean>;
  /** 退出只读预览并恢复原本的编辑内容。 */
  exitPreview: () => void;
  /** 恢复当前成品到版本 v（不同的当前内容会存为“恢复前备份”）。 */
  restore: (target: NoteEntry, v: number) => Promise<void>;
  renameVersion: (target: NoteEntry, v: number, name: string) => Promise<void>;
  deleteVersion: (target: NoteEntry, v: number) => Promise<void>;
  /** 删完当前 piece 后项目里已无 piece；切到 NO_PIECE 空态而非自动建空文件。 */
  onEmptied?: () => void;
  /** 聚焦并全选标题栏（新建 piece 后原地改名）。 */
  focusTitle?: () => void;
  /** 回车提交标题后，焦点跳到正文编辑器首行。 */
  focusBody: () => void;
}

/**
 * 写作栏的文档头分两处挂载：
 *  - 顶栏（topbarMount，固定不随正文滚动）：breadcrumb 切换行 + 版本入口。
 *  - 标题（titleMount，随正文滚动）：大标题（= 文件名，可编辑）。
 * 单栏 / 双栏共用同一份 DOM，左缘与正文对齐，故两种模式表现完全一致。
 * 文档模式下整行 #piece-topbar-root 由 CSS 隐藏：独立文档无项目内切换、无版本历史，
 * 删除走左上角切换菜单的「文档」区逐行垃圾桶（与项目模式删成品同构）。
 */
export function createPieceHeader(args: {
  topbarMount: HTMLElement;
  titleMount: HTMLElement;
  previewMount: HTMLElement;
  host: PieceHeaderHost;
}) {
  const { topbarMount, titleMount, previewMount, host } = args;
  let menuEl: MenuHandle | null = null;
  let renaming = false;

  function reportVersionError(action: string, error: unknown) {
    console.error(`${action} failed`, error);
    showToast(`${action}失败，请重试`);
  }

  const crumb = document.createElement("button");
  crumb.className = "piece-breadcrumb";
  crumb.title = "切换成品";
  const crumbLabel = document.createElement("span");
  crumbLabel.className = "piece-breadcrumb-label";
  crumbLabel.textContent = "-";
  crumb.append(
    createIcon({ phosphor: "ph ph-file-text", size: 12 }),
    crumbLabel,
    createIcon({ phosphor: "ph ph-caret-down", size: 12 }),
  );
  crumb.onclick = (e) => {
    e.stopPropagation();
    void openMenu();
  };

  // 版本入口：切换行最右端的低调时钟图标，点击向下展开版本菜单。
  const versionBtn = document.createElement("button");
  versionBtn.className = "piece-version-btn";
  versionBtn.title = "版本";
  versionBtn.append(createIcon({ phosphor: "ph ph-clock-counter-clockwise", size: 14 }));
  versionBtn.onclick = (e) => {
    e.stopPropagation();
    void openVersionMenu();
  };

  // breadcrumb 与版本入口共处一行：左切换、右版本。
  const crumbRow = document.createElement("div");
  crumbRow.className = "piece-crumb-row";
  crumbRow.appendChild(crumb);
  crumbRow.appendChild(versionBtn);

  // 标题即可编辑文本区：长标题自然软包折行，回车提交重命名并跳到正文。
  // value 永远单行（回车不写入换行符），折行只是视觉呈现。
  const title = document.createElement("textarea");
  title.className = "piece-title-input";
  title.rows = 1;
  title.spellcheck = false;
  title.setAttribute("aria-label", "成品标题（即文件名）");
  // textarea 默认能输入换行；标题=文件名不允许换行符，统一拦掉。
  title.setAttribute("wrap", "soft");

  topbarMount.appendChild(crumbRow);
  titleMount.appendChild(title);

  function fit() {
    // 粘贴 / IME 可能带入换行符；标题=文件名永远是单行，落到 value 前先剔掉。
    if (title.value.includes("\n")) {
      const pos = Math.min(title.selectionStart ?? title.value.length, title.value.length);
      title.value = title.value.replace(/\n/g, "");
      title.selectionStart = title.selectionEnd = Math.min(pos, title.value.length);
    }
    // 软包折行后按内容高度撑高，不出现内部滚动条。
    title.style.height = "auto";
    title.style.height = `${title.scrollHeight}px`;
  }

  function setLabel(name: string) {
    title.value = name;
    crumb.querySelector<HTMLElement>(".piece-breadcrumb-label")!.textContent = name;
    title.classList.remove("rename-error");
    fit();
  }

  /** 聚焦标题并全选，供新建 piece / 文档后原地改名。等一帧让布局就位。 */
  function focusTitle() {
    requestAnimationFrame(() => {
      title.focus();
      title.select();
    });
  }

  title.addEventListener("input", fit);
  // 窗口变窄 → 软包行数变多，按内容重撑高，避免高度停留在旧值被裁掉。
  const ro = new ResizeObserver(() => fit());
  ro.observe(title);
  title.addEventListener("keydown", (e) => {
    if (isImeComposing(e)) return;
    if (e.key === "Enter") {
      // 回车=提交重命名并跳到正文；Shift+Enter 同样不换行（标题永远单行 value）。
      e.preventDefault();
      title.blur();
      host.focusBody();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const cur = host.current();
      if (cur) setLabel(cur.name);
      title.blur();
    }
  });
  title.addEventListener("blur", () => void commitRename());

  async function commitRename() {
    const cur = host.current();
    if (!cur || renaming) return;
    const stem = sanitizePieceStem(title.value);
    // 空 / 非法 / 未改名 → 还原，不落盘。
    if (!stem || stem === cur.name) {
      setLabel(cur.name);
      return;
    }
    renaming = true;
    try {
      const newPath = await renameNote(host.dir(), cur.name, stem);
      host.open({ name: stem, path: newPath });
    } catch {
      title.classList.add("rename-error");
      setTimeout(() => setLabel(cur.name), 1200);
    } finally {
      renaming = false;
    }
  }

  function closeMenu() {
    menuEl?.hide();
    menuEl = null;
  }

  let versionMenuEl: MenuHandle | null = null;
  let versionMenuGeneration = 0;
  let activePreview: VersionEntry | null = null;
  function closeVersionMenu() {
    versionMenuGeneration += 1;
    versionMenuEl?.hide();
    versionMenuEl = null;
  }

  function closePreview() {
    host.exitPreview();
    activePreview = null;
    title.readOnly = false;
    previewMount.replaceChildren();
    previewMount.hidden = true;
  }

  async function restoreEntry(target: NoteEntry, entry: VersionEntry) {
    try {
      await host.restore(target, entry.v);
    } catch (error) {
      reportVersionError("恢复版本", error);
      return;
    }
    activePreview = null;
    title.readOnly = false;
    previewMount.replaceChildren();
    previewMount.hidden = true;
    closeVersionMenu();
  }

  function showPreviewBar(entry: VersionEntry) {
    activePreview = entry;
    title.readOnly = true;
    const display = formatVersionEntry(entry);
    const info = document.createElement("span");
    info.className = "version-preview-info";
    info.textContent = `${display.title} · ${display.meta} · 只读`;
    const spacer = document.createElement("span");
    spacer.className = "version-preview-spacer";
    const exit = document.createElement("button");
    exit.className = "fn-btn fn-btn--ghost fn-btn--sm version-preview-exit";
    exit.textContent = "退出预览";
    exit.onclick = closePreview;
    const restore = document.createElement("button");
    restore.className = "fn-btn fn-btn--primary fn-btn--sm version-preview-restore";
    restore.textContent = "恢复此版本";
    const target = host.current();
    restore.disabled = !target;
    restore.onclick = () => {
      if (target) void restoreEntry(target, entry);
    };
    previewMount.replaceChildren(info, spacer, exit, restore);
    previewMount.hidden = false;
  }

  async function previewEntry(target: NoteEntry, entry: VersionEntry) {
    closeVersionMenu();
    let applied: boolean;
    try {
      applied = await host.preview(target, entry.v);
    } catch (error) {
      reportVersionError("预览版本", error);
      return;
    }
    if (!applied || host.current()?.path !== target.path) return;
    showPreviewBar(entry);
  }

  function makeVersionAction(label: string, icon: string, run: () => void, danger = false) {
    const item = document.createElement("button");
    item.className = "fn-menu__item version-action";
    if (danger) item.classList.add("fn-menu__item--danger");
    item.append(createIcon({ phosphor: `ph ${icon}`, size: 13 }), document.createTextNode(label));
    item.onclick = (event) => {
      event.stopPropagation();
      run();
    };
    return item;
  }

  async function openVersionMenu() {
    if (versionMenuEl) {
      closeVersionMenu();
      return;
    }
    const target = host.current();
    if (!target) return;
    const generation = ++versionMenuGeneration;
    let entries: VersionEntry[];
    try {
      entries = await host.loadVersions(target);
    } catch (error) {
      reportVersionError("加载版本", error);
      return;
    }
    if (generation !== versionMenuGeneration || host.current()?.path !== target.path) return;
    const handle = createMenu({
      anchor: versionBtn,
      placement: "down-right",
      onOutside: () => {
        versionMenuGeneration += 1;
        versionMenuEl = null;
      },
    });
    const items: HTMLElement[] = [];

    // 顶部一行：手动记录当前版本（与成品切换菜单顶部的「新建」行同构）。
    const snap = document.createElement("button");
    snap.className = "fn-menu__item version-item version-snap-row";
    snap.append(createIcon({ phosphor: "ph ph-camera", size: 12 }), document.createTextNode("记录当前版本"));
    snap.onclick = async (e) => {
      e.stopPropagation();
      closeVersionMenu();
      try {
        await host.snapshot(target);
      } catch (error) {
        reportVersionError("记录版本", error);
      }
    };
    items.push(snap);

    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "version-empty";
      empty.textContent = "暂无版本";
      items.push(empty);
    }
    for (const entry of [...entries].reverse()) {
      const row = document.createElement("div");
      row.className = "version-list-row";
      if (activePreview?.v === entry.v) row.classList.add("active");

      const main = document.createElement("button");
      main.className = "version-row-main";
      const display = formatVersionEntry(entry);
      const titleEl = document.createElement("span");
      titleEl.className = "version-item-title";
      titleEl.textContent = display.title;
      const meta = document.createElement("span");
      meta.className = "version-item-meta";
      meta.textContent = display.meta;
      main.append(titleEl, meta);
      main.onclick = () => void previewEntry(target, entry);

      const kebab = document.createElement("button");
      kebab.className = "version-row-kebab";
      kebab.title = "更多";
      kebab.setAttribute("aria-label", `${display.title}的更多操作`);
      kebab.setAttribute("aria-haspopup", "menu");
      kebab.setAttribute("aria-expanded", "false");
      kebab.append(createIcon({ phosphor: "ph ph-dots-three-vertical", size: 13 }));
      kebab.onclick = (event) => {
        event.stopPropagation();
        if (handle.isSubmenuOpenFor(kebab)) {
          handle.closeSubmenu();
          return;
        }
        const restore = makeVersionAction("恢复此版本", "ph-clock-counter-clockwise", () => {
          handle.closeSubmenu();
          void restoreEntry(target, entry);
        });
        const rename = makeVersionAction("重命名版本", "ph-pencil-simple", () => {
          handle.closeSubmenu();
          const input = document.createElement("input");
          input.className = "fn-control version-rename-input";
          input.value = display.title;
          main.replaceWith(input);
          input.focus();
          input.select();
          let submitting = false;
          const commit = async () => {
            if (submitting) return;
            const name = input.value.trim();
            if (!name || name === display.title) {
              input.replaceWith(main);
              return;
            }
            submitting = true;
            try {
              await host.renameVersion(target, entry.v, name);
              entry.summary = name;
              titleEl.textContent = name;
              input.replaceWith(main);
            } catch (error) {
              reportVersionError("重命名版本", error);
              input.replaceWith(main);
            }
          };
          input.onblur = () => void commit();
          input.onkeydown = (keyEvent) => {
            if (isImeComposing(keyEvent)) return;
            if (keyEvent.key === "Enter") {
              keyEvent.preventDefault();
              void commit();
            } else if (keyEvent.key === "Escape") {
              keyEvent.preventDefault();
              keyEvent.stopPropagation();
              input.replaceWith(main);
            }
          };
        });
        const remove = makeVersionAction("删除版本", "ph-trash", () => {
          handle.closeSubmenu();
          void (async () => {
            if (!(await confirmDialog(`删除「${formatVersionEntry(entry).title}」？此操作无法撤销。`))) return;
            try {
              await host.deleteVersion(target, entry.v);
            } catch (error) {
              reportVersionError("删除版本", error);
              return;
            }
            if (activePreview?.v === entry.v) closePreview();
            closeVersionMenu();
          })();
        }, true);
        handle.openSubmenu(kebab, [restore, rename, remove]);
      };
      row.append(main, kebab);
      items.push(row);
    }

    versionMenuEl = handle;
    handle.show(items);
  }

  async function openMenu() {
    if (menuEl) {
      closeMenu();
      return;
    }
    const dir = host.dir();
    if (!dir) return;
    const pieces = await listPieces(dir);
    const handle = createMenu({ anchor: crumb, onOutside: () => { menuEl = null; } });
    const items: HTMLElement[] = [];

    // 顶部：新建图标行。
    const newItem = document.createElement("button");
    newItem.className = "fn-menu__item piece-new-row";
    newItem.append(createIcon({ phosphor: "ph ph-plus", size: 13 }), document.createTextNode("新建"));
    newItem.onclick = async (e) => {
      e.stopPropagation();
      const entry = await createNote(host.dir(), "未命名作品");
      closeMenu();
      await host.open(entry);
      host.focusTitle?.();
    };
    items.push(newItem);

    const cur = host.current();
    for (const piece of pieces) {
      const row = document.createElement("div");
      row.className = "switch-row";
      if (cur && piece.path === cur.path) row.classList.add("active");

      const label = document.createElement("button");
      label.className = "switch-row-label";
      const labelName = document.createElement("span");
      labelName.className = "switch-row-name";
      labelName.textContent = piece.name;
      label.append(createIcon({ phosphor: "ph ph-file-text", size: 13 }), labelName);
      label.onclick = (e) => {
        e.stopPropagation();
        closeMenu();
        host.open(piece);
      };

      const del = document.createElement("button");
      del.className = "switch-row-action switch-row-delete";
      del.title = "删除";
      del.append(createIcon({ phosphor: "ph ph-trash", size: 13 }));
      del.onclick = async (e) => {
        e.stopPropagation();
        if (!(await confirmDialog(`删除「${piece.name}」？它会被移到废纸篓。`))) return;
        try {
          await deleteNote(host.dir(), piece.name);
        } catch (err) {
          console.error("delete piece failed", err);
          return;
        }
        closeMenu();
        // 删的是当前成品 → 切到下一个；没有则进入 NO_PIECE 空态（不再兜底建空文件）。
        if (cur && piece.path === cur.path) {
          const remaining = await listPieces(host.dir());
          if (remaining[0]) {
            host.open(remaining[0]);
          } else {
            host.onEmptied?.();
          }
        }
      };

      const actions = document.createElement("div");
      actions.className = "switch-row-actions";
      actions.appendChild(del);
      row.appendChild(label);
      row.appendChild(actions);
      items.push(row);
    }

    const rect = crumb.getBoundingClientRect();
    menuEl = handle;
    handle.showAt(rect.left, rect.bottom + 4, items);
  }

  previewMount.hidden = true;
  return {
    setLabel,
    focusTitle,
    refit: fit,
    closeMenu,
    closeVersionMenu,
    exitVersionPreview: closePreview,
  };
}
