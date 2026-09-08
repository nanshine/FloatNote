/**
 * Canonical tag color palette, shared between the frontend tag picker and the
 * Rust Agent note-tagging tools mirror this exact palette. Both runtimes MUST see the same color
 * set — otherwise the agent could pick (or reject) a color the user never
 * sees in the picker, or vice versa.
 */

export interface Swatch {
  id: string;
  color: string;
}

/** Eight curated swatches spanning the common hues. */
export const PALETTE: Swatch[] = [
  { id: "red", color: "#e5484d" },
  { id: "orange", color: "#f5a623" },
  { id: "amber", color: "#f2c744" },
  { id: "green", color: "#3cb371" },
  { id: "teal", color: "#0d9488" },
  { id: "blue", color: "#3b82f6" },
  { id: "violet", color: "#8b5cf6" },
  { id: "pink", color: "#ec4899" },
];

/** Hex strings of palette colors not already in `used` (case-insensitive). */
export function freeColors(used: Set<string>): string[] {
  const usedLower = new Set([...used].map((c) => c.toLowerCase()));
  return PALETTE.map((s) => s.color).filter((c) => !usedLower.has(c.toLowerCase()));
}
