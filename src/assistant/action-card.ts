import { TOOL_LABEL, type EditPreviewDetail } from "./permission-bubble";
import { fillMarkdown } from "../shared/markdown/render";
import type { Block } from "./render";
import { escapeHtml } from "../shared/escape";
import { createButton } from "../shared/ui/button";
import type { ToolCategory } from "../platform/agent";

/**
 * 流内动作卡（只读，Phase 1）。
 *
 * 数据来源：`permission://request` 流（Rust pending-edit）填充 action block 的
 * detail/oldContent/newContent/canSnapshot/requestId。允许/拒绝走
 * `resolve_permission`（与 dock 固定弹窗共用 requestId 幂等键）。
 *
 * 节点稳定性：`buildActionCard` 产出骨架（header/body 容器/footer），
 * `updateActionCard` 只更新内容与 class——不重建节点，避免动画重放。
 */

/** 工具名 → 卡片标题（沿用 permission-bubble 的语义化中文标签）。 */
function titleFor(tool: string): string {
  return TOOL_LABEL[tool] ?? tool;
}

/** 写入/标签工具：产出可交互 action 卡（detail 由 permission://request 填充）。
 *  其余工具（read/ls/find/grep/list_tags…）为只读，渲染为紧凑行。 */
function isReadonly(_tool: string): boolean {
  // 所有工具统一为不可展开的结果行；写入确认仅由 dock 气泡承载。
  return true;
}

/** SVG 图标（线性、stroke 1.5、与项目调性一致；aria-hidden）。 */
function toolIcon(tool: string, category?: ToolCategory): string {
  const semantic = category ?? legacyCategory(tool);
  return `<span class="chat-action-icon" data-tool-category="${semantic}" aria-hidden="true">${iconPath(semantic)}</span>`;
}

function legacyCategory(tool: string): ToolCategory {
  if (tool.startsWith("tag") || tool === "list_tags") return "tag";
  const categories: Partial<Record<string, ToolCategory>> = {
    ls: "document_list",
    read: "document_read",
    find: "document_find",
    grep: "document_search",
    edit: "document_write",
    write: "document_write",
    create_piece: "document_create",
    web_search: "web_search",
    web_fetch: "web_fetch",
  };
  return categories[tool] ?? "other";
}

function iconPath(category: ToolCategory): string {
  switch (category) {
    case "skill": return skillPath();
    case "document_read": return readPath();
    case "document_list": return listPath();
    case "document_find": return findPath();
    case "document_search": return searchPath();
    case "web_search": return webSearchPath();
    case "web_fetch": return webFetchPath();
    case "document_write": return editPath();
    case "document_create": return createPath();
    case "tag": return tagPath();
    case "other": return gearPath();
  }
}
function editPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>`;
}
function readPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 5a2 2 0 0 1 2-2h5a2 2 0 0 1 2 2v15a1 1 0 0 0-1-1H4a2 2 0 0 1-2-2Z"/><path d="M22 5a2 2 0 0 0-2-2h-5a2 2 0 0 0-2 2v15a1 1 0 0 1 1-1h6a2 2 0 0 0 2-2Z"/></svg>`;
}
function listPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13"/><path d="M8 12h13"/><path d="M8 18h13"/><path d="M3 6h.01"/><path d="M3 12h.01"/><path d="M3 18h.01"/></svg>`;
}
function tagPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20.59 13.41 13.42 20.6a2 2 0 0 1-2.83 0L3 13V3h10l7.59 7.59a2 2 0 0 1 0 2.82Z"/><circle cx="7.5" cy="7.5" r="1.2"/></svg>`;
}
function skillPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m12 3 1.35 4.15L17.5 8.5l-4.15 1.35L12 14l-1.35-4.15L6.5 8.5l4.15-1.35Z"/><path d="m19 14 .75 2.25L22 17l-2.25.75L19 20l-.75-2.25L16 17l2.25-.75Z"/><path d="m5 15 .6 1.4L7 17l-1.4.6L5 19l-.6-1.4L3 17l1.4-.6Z"/></svg>`;
}
function findPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h6l2 2h10v8"/><path d="M3 6v12h9"/><circle cx="16.5" cy="16.5" r="3.5"/><path d="m19 19 2 2"/></svg>`;
}
function searchPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 5 5"/><path d="M7.5 9h6M7.5 12h4"/></svg>`;
}
function webSearchPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="10" cy="10" r="7"/><path d="M3 10h14M10 3a12 12 0 0 1 0 14M10 3a12 12 0 0 0 0 14"/><path d="m15.5 15.5 5 5"/></svg>`;
}
function webFetchPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/><path d="m9 10 3 3 3-3"/></svg>`;
}
function createPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h5M9 14h6M12 11v6"/></svg>`;
}
function gearPath(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.06.06-2.83 2.83-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 .6 1.7 1.7 0 0 0-.4 1V21h-4v-.09A1.7 1.7 0 0 0 8.6 19.4a1.7 1.7 0 0 0-1.88.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-.6-1 1.7 1.7 0 0 0-1-.4H3v-4h.09A1.7 1.7 0 0 0 4.6 8.6a1.7 1.7 0 0 0-.34-1.88l-.06-.06 2.83-2.83.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-.6 1.7 1.7 0 0 0 .4-1V3h4v.09A1.7 1.7 0 0 0 15.4 4.6a1.7 1.7 0 0 0 1.88-.34l.06-.06 2.83 2.83-.06.06A1.7 1.7 0 0 0 19.4 9c.37.27.72.6 1 .98.25.34.4.76.4 1.19V13h-.09A1.7 1.7 0 0 0 19.4 15Z"/></svg>`;
}

/** 构建动作卡骨架（header + body 容器 + footer）。 */
export function buildActionCard(block: Extract<Block, { kind: "action" }>): HTMLElement {
  const el = document.createElement("div");
  el.className = "chat-action";
  el.dataset.blockId = block.id;

  const header = document.createElement("div");
  header.className = "chat-action-header";
  header.innerHTML = `${toolIcon(block.tool, block.category)}<span class="chat-action-title">${escapeHtml(titleFor(block.tool))}</span>`;
  el.appendChild(header);

  if (isReadonly(block.tool)) {
    // 只读工具：紧凑行（图标 + 标题 + 活跃 spinner），无 summary/body/footer。
    el.classList.add("chat-action-readonly");
    const spinner = document.createElement("span");
    spinner.className = "chat-action-spinner";
    spinner.setAttribute("aria-hidden", "true");
    header.appendChild(spinner);
    updateActionCard(el, block);
    return el;
  }

  const summary = document.createElement("div");
  summary.className = "chat-action-summary";
  el.appendChild(summary);

  const body = document.createElement("div");
  body.className = "chat-action-body";
  el.appendChild(body);

  const footer = document.createElement("div");
  footer.className = "chat-action-footer";
  const modeSelect = document.createElement("select");
  modeSelect.className = "chat-action-mode";
  const direct = document.createElement("option");
  direct.value = "direct";
  direct.textContent = "直接写入";
  modeSelect.appendChild(direct);
  const snap = document.createElement("option");
  snap.value = "snapshot";
  snap.textContent = "保存快照后写入";
  modeSelect.appendChild(snap);
  const allow = createButton({
    variant: "primary",
    label: "允许",
    onClick: () => {
      const requestId = el.dataset.requestId;
      if (!requestId) return;
      setCardControlsDisabled(el, true);
      el.dispatchEvent(
        new CustomEvent("chat:resolve", {
          bubbles: true,
          detail: { requestId, decision: "allow", writeMode: modeSelect.value },
        }),
      );
    },
  });
  const deny = createButton({
    variant: "secondary",
    label: "拒绝",
    onClick: () => {
      const requestId = el.dataset.requestId;
      if (!requestId) return;
      setCardControlsDisabled(el, true);
      el.dispatchEvent(
        new CustomEvent("chat:resolve", {
          bubbles: true,
          detail: { requestId, decision: "deny", writeMode: "direct" },
        }),
      );
    },
  });
  footer.append(modeSelect, allow, deny);
  el.appendChild(footer);

  updateActionCard(el, block);
  return el;
}

/** 增量更新动作卡（状态 class + body + footer 可见性），不重建节点。 */
export function updateActionCard(el: HTMLElement, block: Extract<Block, { kind: "action" }>): void {
  el.dataset.requestId = block.requestId ?? "";
  el.classList.toggle("chat-action-pending", block.execution === "running");
  el.classList.toggle("chat-action-approved", block.decision === "allowed");
  el.classList.toggle("chat-action-rejected", block.execution === "rejected");
  el.classList.toggle("chat-action-done", block.execution === "succeeded");
  el.classList.toggle("chat-action-failed", block.execution === "failed");
  el.classList.toggle("chat-action-incomplete", block.execution === "incomplete");

  const titleEl = el.querySelector<HTMLElement>(".chat-action-title");
  const iconEl = el.querySelector<HTMLElement>(".chat-action-icon");
  const category = block.category ?? legacyCategory(block.tool);
  if (iconEl && iconEl.dataset.toolCategory !== category) {
    iconEl.dataset.toolCategory = category;
    iconEl.innerHTML = iconPath(category);
  }
  const target = block.targets[0];
  if (titleEl) titleEl.textContent = block.label ?? (target ? `${titleFor(block.tool)} ${target}` : titleFor(block.tool));

  // 只读紧凑行：只切 done + spinner 可见性（无 summary/body/footer，无 ✓ 对勾）。
  if (el.classList.contains("chat-action-readonly")) {
    const spinner = el.querySelector<HTMLElement>(".chat-action-spinner");
    if (spinner) spinner.classList.toggle("is-active", block.execution === "running");
    let result = el.querySelector<HTMLElement>(".chat-action-result");
    if (!result) {
      result = document.createElement("div");
      result.className = "chat-action-result";
      el.appendChild(result);
    }
    result.textContent = block.execution === "incomplete"
      ? "未完成"
      : block.execution === "failed"
      ? `执行失败${block.resultSummary ? `：${block.resultSummary}` : ""}`
      : block.execution === "rejected"
        ? "已拒绝"
      : block.execution === "succeeded" && block.resultSummary
        ? block.resultSummary
        : "";
    result.classList.toggle("is-error", block.execution === "failed" || block.execution === "incomplete");
    result.classList.toggle("is-empty", !result.textContent);
    return;
  }

  const summaryEl = el.querySelector<HTMLElement>(".chat-action-summary");
  if (summaryEl) {
    summaryEl.textContent = block.summary ?? "";
    summaryEl.classList.toggle("is-empty", !block.summary);
  }

  const body = el.querySelector<HTMLElement>(".chat-action-body");
  if (body && block.detail && el.dataset.detailFilled !== "1") {
    body.replaceChildren(renderActionBody(block));
    el.dataset.detailFilled = "1";
  }

  // footer 仅在 pending 且已收到 requestId（可交互）时可见。
  const interactive = block.execution === "running" && block.decision === "pending" && Boolean(block.requestId);
  const footer = el.querySelector<HTMLElement>(".chat-action-footer");
  if (footer) footer.classList.toggle("is-hidden", !interactive);

  // 写入模式选项仅在 canSnapshot 时可选 snapshot。
  const snap = el.querySelector<HTMLOptionElement>('option[value="snapshot"]');
  if (snap) snap.hidden = !block.canSnapshot;

  let outcome = el.querySelector<HTMLElement>(".chat-action-outcome");
  if (!outcome) {
    outcome = document.createElement("div");
    outcome.className = "chat-action-outcome";
    el.appendChild(outcome);
  }
  outcome.textContent = actionOutcome(block);
  outcome.classList.toggle("is-hidden", !outcome.textContent);
  setCardControlsDisabled(el, !interactive);
}

function actionOutcome(block: Extract<Block, { kind: "action" }>): string {
  if (block.permissionError) return `权限操作失败：${block.permissionError}`;
  if (block.decision === "allowed" && block.execution === "running") return "已允许 · 正在写入";
  if (block.decision === "allowed" && block.execution === "succeeded") return "已允许 · 写入成功";
  if (block.decision === "allowed" && block.execution === "failed") return "已允许 · 写入失败";
  if (block.execution === "failed") return "执行失败";
  return "";
}

function setCardControlsDisabled(el: HTMLElement, disabled: boolean): void {
  for (const control of el.querySelectorAll<HTMLButtonElement | HTMLSelectElement>(".chat-action-footer button, .chat-action-footer select")) {
    control.disabled = disabled;
  }
}

/** 按 detail.kind + tool 渲染 body（只读）。 */
function renderActionBody(block: Extract<Block, { kind: "action" }>): HTMLElement {
  if (!block.detail) {
    const empty = document.createElement("div");
    empty.className = "chat-action-empty";
    empty.textContent = "AI 正在准备…";
    return empty;
  }
  const detail = block.detail;
  switch (detail.kind) {
    case "diff":
      return block.tool === "write"
        ? renderWriteNotePreview(block.newContent ?? "")
        : renderEditDiff(block.oldContent ?? "", block.newContent ?? "", detail);
    case "tag_assign":
      return renderTagAssign(detail);
    case "tag_create":
      return renderTagCreate(detail);
    case "tag_update":
      return renderTagUpdate(detail);
    case "note_create":
      return renderNoteCreate(detail);
    case "tag_delete":
      return renderTagDelete(detail);
  }
}

/** write：直接展示新版本全文（markdown 渲染，非代码样式）。 */
function renderWriteNotePreview(newContent: string): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "chat-diff chat-diff-newonly";
  fillMarkdown(panel, newContent);
  return panel;
}

/**
 * edit：左右并排旧/新，行级对齐标注差异。
 * diff 配色不用红绿：新增行淡蓝底，删除行中性灰 + 删除线。
 */
function renderEditDiff(
  oldContent: string,
  newContent: string,
  detail: Extract<EditPreviewDetail, { kind: "diff" }>,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "chat-diff chat-diff-sbs";

  // 用 detail.hunks（unifiedDiff 产物：`+ /- /  ` 前缀）重建对齐行。
  const rows = alignDiffHunks(detail.hunks);
  // 兜底：若 hunks 为空，直接左右展示原始内容。
  const useRows = rows.length > 0 ? rows : splitFallback(oldContent, newContent);

  const leftCol = document.createElement("div");
  leftCol.className = "chat-diff-col chat-diff-old";
  const rightCol = document.createElement("div");
  rightCol.className = "chat-diff-col chat-diff-new";
  for (const r of useRows) {
    leftCol.appendChild(diffRow(r.left, r.kind === "del" || r.kind === "mod"));
    rightCol.appendChild(diffRow(r.right, r.kind === "add" || r.kind === "mod"));
  }
  const labels = document.createElement("div");
  labels.className = "chat-diff-labels";
  labels.innerHTML = `<span>原版本</span><span>新版本</span>`;
  wrap.append(labels, leftCol, rightCol);
  return wrap;
}

type AlignedRow = { left: string; right: string; kind: "ctx" | "add" | "del" | "mod" };

function alignDiffHunks(hunks: string): AlignedRow[] {
  const rows: AlignedRow[] = [];
  for (const raw of hunks.split("\n")) {
    if (raw === "") continue;
    const prefix = raw.slice(0, 1);
    const rest = raw.slice(2);
    if (prefix === "+") rows.push({ left: "", right: rest, kind: "add" });
    else if (prefix === "-") rows.push({ left: rest, right: "", kind: "del" });
    else rows.push({ left: rest, right: rest, kind: "ctx" });
  }
  return rows;
}

function splitFallback(oldContent: string, newContent: string): AlignedRow[] {
  const la = oldContent.split("\n");
  const lb = newContent.split("\n");
  const n = Math.max(la.length, lb.length);
  const rows: AlignedRow[] = [];
  for (let i = 0; i < n; i++) {
    // Line-by-line fallback (no hunk alignment). Differing lines are "mod" so
    // both the old (left) and new (right) sides highlight, like a real diff.
    rows.push({ left: la[i] ?? "", right: lb[i] ?? "", kind: la[i] === lb[i] ? "ctx" : "mod" });
  }
  return rows;
}

function diffRow(text: string, highlight: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "chat-diff-row";
  if (highlight) row.classList.add(text === "" ? "chat-diff-empty" : "chat-diff-mark");
  if (text === "") {
    row.innerHTML = "&nbsp;";
  } else {
    row.textContent = text;
  }
  return row;
}

function renderTagAssign(d: Extract<EditPreviewDetail, { kind: "tag_assign" }>): HTMLElement {
  const row = document.createElement("div");
  row.className = "chat-tag-row";
  const chip = document.createElement("span");
  chip.className = "tag-chip";
  chip.style.background = d.tagColor;
  chip.textContent = d.tagName;
  row.append(`${d.action === "add" ? "添加" : "移除"}「${d.textExcerpt}」→ `, chip, `（${d.annotationCount} 个标注）`);
  return row;
}

function renderTagCreate(d: Extract<EditPreviewDetail, { kind: "tag_create" }>): HTMLElement {
  const row = document.createElement("div");
  row.className = "chat-tag-row";
  const chip = document.createElement("span");
  chip.className = "tag-chip";
  chip.style.background = d.tagColor;
  chip.textContent = d.tagName;
  row.append("新建标签 ", chip);
  return row;
}

function renderTagDelete(d: Extract<EditPreviewDetail, { kind: "tag_delete" }>): HTMLElement {
  const row = document.createElement("div");
  row.className = "chat-tag-row";
  row.textContent = `删除标签「${d.tagName}」，${d.annotationCount} 个标注将清除`;
  return row;
}

function renderTagUpdate(d: Extract<EditPreviewDetail, { kind: "tag_update" }>): HTMLElement {
  const row = document.createElement("div");
  row.className = "chat-tag-row";
  row.textContent = `标签「${d.oldName}」→「${d.newName}」`;
  return row;
}

function renderNoteCreate(d: Extract<EditPreviewDetail, { kind: "note_create" }>): HTMLElement {
  const row = document.createElement("div");
  row.className = "chat-note-create";
  const title = document.createElement("strong");
  title.textContent = d.filename;
  const preview = document.createElement("pre");
  preview.textContent = d.contentPreview;
  row.append(title, preview);
  return row;
}
