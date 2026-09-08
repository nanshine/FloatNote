// Regenerate FloatNote platform icons from committed source art.
//
// - `app-icon.png` stays the pristine full-bleed master (see app-icon.test.mjs).
//   We inset it on a transparent canvas and round its corners into
//   `app-icon-rounded.png`, which `tauri icon` then expands into the .ico /
//   .icns / PNG set so Windows shows a floating rounded tile (subtle radius +
//   transparent margin per the Microsoft 48px-grid guidance) instead of a hard
//   full-bleed square.
// - The Windows tray icon is rebuilt from `tray-source.png` as a mid-slate
//   rounded tile with the robot silhouette in the app's warm-paper colour, so it
//   stays legible on both light tray panels and dark taskbars (the previous
//   pure-white glyph was not) while matching the brand palette.
// - macOS tray art (`tray.png`/`tray@2x.png`) is left untouched: it is a black
//   template image the OS recolours automatically.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { buildRoundedAppIcon, buildTrayTile, decodePng, encodePng } from "./icon-image.mjs";
import { runTauri } from "./tauri.mjs";

const iconPath = (name) => fileURLToPath(new URL(`../src-tauri/icons/${name}`, import.meta.url));

// Subtle exterior rounding with a transparent margin, per the Windows icon grid.
const APP_ICON_RADIUS_RATIO = 0.12;
const APP_ICON_PADDING_RATIO = 0.06;

function writePng(name, image) {
  writeFileSync(iconPath(name), encodePng(image.width, image.height, image.data));
  process.stdout.write(`wrote src-tauri/icons/${name} (${image.width}x${image.height})\n`);
}

export function generateIcons({ spawn = true } = {}) {
  const master = decodePng(readFileSync(iconPath("app-icon.png")));
  writePng(
    "app-icon-rounded.png",
    buildRoundedAppIcon(master, {
      radiusRatio: APP_ICON_RADIUS_RATIO,
      paddingRatio: APP_ICON_PADDING_RATIO,
    }),
  );

  const silhouette = decodePng(readFileSync(iconPath("tray-source.png")));
  writePng("tray-windows.png", buildTrayTile(silhouette, 32));
  writePng("tray-windows@2x.png", buildTrayTile(silhouette, 64));

  if (spawn) {
    const status = runTauri([
      "icon",
      "src-tauri/icons/app-icon-rounded.png",
      "-o",
      "src-tauri/icons",
    ]);
    if (status !== 0) {
      throw new Error(`tauri icon exited with status ${status}`);
    }
  }
}

const isDirectRun =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (isDirectRun) {
  try {
    generateIcons();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
