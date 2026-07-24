export const DEFAULT_EDITOR_FONT_SIZE = 15;
export const MIN_EDITOR_FONT_SIZE = 12;
export const MAX_EDITOR_FONT_SIZE = 24;
export const EDITOR_FONT_SIZE_STORAGE_KEY = "floatnote.editor-font-size";

function clampEditorFontSize(value: number): number {
  return Math.min(MAX_EDITOR_FONT_SIZE, Math.max(MIN_EDITOR_FONT_SIZE, value));
}

function readPersistedFontSize(): number {
  try {
    const value = Number.parseInt(localStorage.getItem(EDITOR_FONT_SIZE_STORAGE_KEY) ?? "", 10);
    return Number.isFinite(value) ? clampEditorFontSize(value) : DEFAULT_EDITOR_FONT_SIZE;
  } catch {
    return DEFAULT_EDITOR_FONT_SIZE;
  }
}

function applyEditorFontSize(value: number): number {
  const size = clampEditorFontSize(value);
  document.documentElement.style.setProperty("--editor-font", `${size}px`);
  try {
    localStorage.setItem(EDITOR_FONT_SIZE_STORAGE_KEY, String(size));
  } catch {
    // The font size still applies for this session when storage is unavailable.
  }
  return size;
}

function currentEditorFontSize(): number {
  const value = Number.parseInt(
    document.documentElement.style.getPropertyValue("--editor-font"),
    10,
  );
  return Number.isFinite(value) ? clampEditorFontSize(value) : readPersistedFontSize();
}

export function initializeEditorFontSize(): number {
  const size = readPersistedFontSize();
  document.documentElement.style.setProperty("--editor-font", `${size}px`);
  return size;
}

export function adjustEditorFontSize(delta: -1 | 1): number {
  return applyEditorFontSize(currentEditorFontSize() + delta);
}

export function resetEditorFontSize(): number {
  return applyEditorFontSize(DEFAULT_EDITOR_FONT_SIZE);
}
