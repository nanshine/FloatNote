/**
 * Shared empty-state UI. All six empty-state surfaces (NO_PROJECT, PATH_ERROR,
 * NO_PIECE, switcher project section, switcher document section, and — via the
 * pieceEditor placeholder rather than this component — empty piece content)
 * route through here so the visuals stay consistent.
 *
 * Split into a pure `emptyStateMarkup` (string, unit-tested) and a thin
 * `renderEmptyState` that injects it into a target and wires button listeners.
 * The DOM wiring is trivial and covered by手测; the string shape is covered by
 * `empty-state.test.ts`, matching the repo's all-pure test style.
 *
 * All callers import this shared module directly and use the same `.fn-empty*`
 * contract from `components.css`.
 */

import { escapeHtml } from "../escape";

export interface EmptyStateAction {
  label: string;
  action: () => void;
}

export interface EmptyStateProps {
  title: string;
  /** Optional sub-line. May interpolate user data (e.g. project name) — it is
   * HTML-escaped before injection. */
  hint?: string;
  /** Optional emoji or short glyph shown above the title. */
  icon?: string;
  primary?: EmptyStateAction;
  secondary?: EmptyStateAction;
  tertiary?: EmptyStateAction;
}

/** Build the inner HTML for an empty-state card. Pure: no DOM, no I/O. */
export function emptyStateMarkup(props: EmptyStateProps): string {
  const icon = props.icon
    ? `<div class="fn-empty__icon">${escapeHtml(props.icon)}</div>`
    : "";
  const hint = props.hint
    ? `<p class="fn-empty__hint">${escapeHtml(props.hint)}</p>`
    : "";
  const primary = props.primary
    ? `<button class="fn-btn fn-btn--primary" data-action="primary">${escapeHtml(
        props.primary.label,
      )}</button>`
    : "";
  const secondary = props.secondary
    ? `<button class="fn-btn fn-btn--secondary" data-action="secondary">${escapeHtml(
        props.secondary.label,
      )}</button>`
    : "";
  const tertiary = props.tertiary
    ? `<button class="fn-btn fn-btn--secondary" data-action="tertiary">${escapeHtml(
        props.tertiary.label,
      )}</button>`
    : "";
  const actions = primary || secondary || tertiary ? `<div class="fn-empty__actions">${primary}${secondary}${tertiary}</div>` : "";
  return `${icon}<h2 class="fn-empty__title">${escapeHtml(
    props.title,
  )}</h2>${hint}${actions}`;
}

/** Render `props` into `target` and wire button clicks. Returns a cleanup that
 * clears the target and removes the `empty-state` class. Idempotent: calling
 * again replaces the previous content. */
export function renderEmptyState(
  target: HTMLElement,
  props: EmptyStateProps,
): () => void {
  target.innerHTML = "";
  target.classList.add("fn-empty");
  const inner = document.createElement("div");
  inner.className = "fn-empty__content";
  inner.innerHTML = emptyStateMarkup(props);
  const wire = (action: "primary" | "secondary" | "tertiary") => {
    const btn = inner.querySelector<HTMLButtonElement>(
      `button[data-action="${action}"]`,
    );
    if (btn) btn.addEventListener("click", () => props[action]?.action());
  };
  wire("primary");
  wire("secondary");
  wire("tertiary");
  target.appendChild(inner);
  return () => {
    target.classList.remove("fn-empty");
    target.innerHTML = "";
  };
}
