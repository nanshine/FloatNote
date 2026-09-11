import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { inflateSync } from "node:zlib";

import { buildRoundedAppIcon, buildTrayTile } from "./icon-image.mjs";

const iconUrl = new URL("../src-tauri/icons/app-icon.png", import.meta.url);
const roundedIconUrl = new URL("../src-tauri/icons/app-icon-rounded.png", import.meta.url);
const windowsTrayUrl = new URL("../src-tauri/icons/tray-windows.png", import.meta.url);
const supersededSvgUrl = new URL(
  "../src-tauri/icons/app-icon.svg",
  import.meta.url,
);
const packageUrl = new URL("../package.json", import.meta.url);

function paethPredictor(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  if (leftDistance <= aboveDistance && leftDistance <= upperLeftDistance) {
    return left;
  }
  return aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function decodePng(url) {
  const png = readFileSync(url);
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");

  let offset = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const imageData = [];

  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;

    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") {
      imageData.push(data);
    } else if (type === "IEND") {
      break;
    }
  }

  assert.equal(bitDepth, 8);
  assert.ok(colorType === 2 || colorType === 6, `unsupported color type ${colorType}`);
  assert.equal(interlace, 0);

  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(imageData));
  const pixels = Buffer.alloc(width * height * channels);
  let inputOffset = 0;
  let previousRow = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = inflated[inputOffset];
    inputOffset += 1;
    const encoded = inflated.subarray(inputOffset, inputOffset + stride);
    inputOffset += stride;
    const row = Buffer.alloc(stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const above = previousRow[x];
      const upperLeft = x >= channels ? previousRow[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = Math.floor((left + above) / 2);
      else if (filter === 4) predictor = paethPredictor(left, above, upperLeft);
      else assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
      row[x] = (encoded[x] + predictor) & 0xff;
    }

    row.copy(pixels, y * stride);
    previousRow = row;
  }

  return {
    width,
    height,
    pixel(x, y) {
      const start = (y * width + x) * channels;
      return {
        red: pixels[start],
        green: pixels[start + 1],
        blue: pixels[start + 2],
        alpha: channels === 4 ? pixels[start + 3] : 255,
      };
    },
  };
}

test("conservative app icon repair removes only the outer white canvas", () => {
  assert.equal(existsSync(iconUrl), true, "expected repaired PNG icon source");
  assert.equal(
    existsSync(supersededSvgUrl),
    false,
    "scheme C SVG must not remain as a competing icon source",
  );

  const image = decodePng(iconUrl);
  assert.deepEqual([image.width, image.height], [1024, 1024]);

  const corners = [
    image.pixel(0, 0),
    image.pixel(1023, 0),
    image.pixel(0, 1023),
    image.pixel(1023, 1023),
  ];
  for (const corner of corners) {
    assert.equal(corner.alpha, 255);
    assert.ok(
      Math.max(corner.red, corner.green, corner.blue) < 240,
      `expected blue-gray full-bleed background, got ${JSON.stringify(corner)}`,
    );
  }

  const paperCenter = image.pixel(512, 512);
  assert.ok(
    paperCenter.red > 225 &&
      paperCenter.green > 215 &&
      paperCenter.blue > 205,
    `expected the original warm-white paper at center, got ${JSON.stringify(paperCenter)}`,
  );
});

test("package regenerates platform icons from the repaired PNG source", () => {
  const packageJson = JSON.parse(readFileSync(packageUrl, "utf8"));
  assert.equal(
    packageJson.scripts?.["icon:generate"],
    "node ./scripts/app-icon.mjs",
  );
});

test("buildRoundedAppIcon insets the artwork on a transparent margin and rounds it", () => {
  const size = 100;
  const data = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 4] = 247;
    data[i * 4 + 1] = 241;
    data[i * 4 + 2] = 234;
    data[i * 4 + 3] = 255;
  }
  const out = buildRoundedAppIcon(
    { width: size, height: size, data },
    { radiusRatio: 0.12, paddingRatio: 0.06 },
  );
  const alpha = (x, y) => out.data[(y * size + x) * 4 + 3];
  // paddingRatio 0.06 -> content spans [6,93]; the outer margin is transparent
  assert.equal(alpha(0, 0), 0, "outer margin must be transparent");
  assert.equal(alpha(3, 3), 0, "inside the transparent margin must be clear");
  assert.ok(alpha(6, 6) < 128, "content corner must be rounded away");
  assert.equal(alpha(size >> 1, size >> 1), 255, "centre must stay opaque");
  assert.equal(alpha(size >> 1, 12), 255, "content edge midpoint must stay opaque");
});

test("rounded app icon output on disk has transparent corners and the warm paper centre", () => {
  assert.equal(existsSync(roundedIconUrl), true, "expected generated rounded icon");
  const image = decodePng(roundedIconUrl);
  assert.deepEqual([image.width, image.height], [1024, 1024]);
  assert.ok(image.pixel(0, 0).alpha < 8, "rounded icon corner must be transparent");
  const centre = image.pixel(512, 512);
  assert.equal(centre.alpha, 255);
  assert.ok(
    centre.red > 225 && centre.green > 215 && centre.blue > 205,
    `expected the warm-white paper at centre, got ${JSON.stringify(centre)}`,
  );
});

test("buildTrayTile renders a mid-tone tile with a lighter glyph", () => {
  const size = 64;
  const data = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const inside = Math.hypot(x - size / 2, y - size / 2) < size * 0.3;
      const s = (y * size + x) * 4;
      data[s] = data[s + 1] = data[s + 2] = 0;
      data[s + 3] = inside ? 255 : 0;
    }
  }
  const tile = buildTrayTile({ width: size, height: size, data }, size);
  let opaque = 0;
  let lumaSum = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < size * size; i += 1) {
    const a = tile.data[i * 4 + 3];
    if (a > 128) {
      opaque += 1;
      const luma =
        0.299 * tile.data[i * 4] + 0.587 * tile.data[i * 4 + 1] + 0.114 * tile.data[i * 4 + 2];
      lumaSum += luma;
      if (luma < min) min = luma;
      if (luma > max) max = luma;
    }
  }
  assert.ok(opaque / (size * size) > 0.5, "tile must be mostly filled");
  const mean = lumaSum / opaque;
  assert.ok(mean > 60 && mean < 210, `tile mean luma should be mid-tone, got ${mean}`);
  assert.ok(max - min > 60, "glyph must be clearly lighter than the tile");
});

test("Windows tray icon on disk is a legible coloured tile, not white", () => {
  assert.equal(existsSync(windowsTrayUrl), true, "expected generated Windows tray icon");
  const image = decodePng(windowsTrayUrl);
  assert.equal(image.width, image.height, "tray icon must be square");
  assert.ok(image.pixel(0, 0).alpha < 8, "tray tile corners must be transparent");

  let opaque = 0;
  let lumaSum = 0;
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const p = image.pixel(x, y);
      if (p.alpha > 128) {
        opaque += 1;
        lumaSum += 0.299 * p.red + 0.587 * p.green + 0.114 * p.blue;
      }
    }
  }
  assert.ok(opaque > 0, "tray icon must draw something");
  const mean = lumaSum / opaque;
  assert.ok(
    mean > 60 && mean < 210,
    `tray tile must be mid-tone so it shows on light panels and dark taskbars, got mean luma ${mean}`,
  );
});
