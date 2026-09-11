// Dependency-free PNG helpers used to regenerate FloatNote platform icons.
//
// The repository intentionally avoids native image packages, so the small set
// of transforms we need (round the app-icon corners, build a Windows tray tile
// from the robot silhouette) is implemented directly on decoded pixel buffers.

import { deflateSync, inflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  }
  return (crc ^ -1) >>> 0;
}

function paeth(left, above, upperLeft) {
  const prediction = left + above - upperLeft;
  const dl = Math.abs(prediction - left);
  const da = Math.abs(prediction - above);
  const du = Math.abs(prediction - upperLeft);
  if (dl <= da && dl <= du) return left;
  return da <= du ? above : upperLeft;
}

/**
 * Decode an 8-bit PNG (grayscale, gray+alpha, RGB or RGBA, non-interlaced)
 * into an RGBA pixel buffer plus its dimensions.
 */
export function decodePng(buffer) {
  const png = buffer;
  if (png.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") {
    throw new Error("not a PNG file");
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let interlace = 0;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const data = png.subarray(offset + 8, offset + 8 + length);
    offset += length + 12;
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
      if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
  }
  if (interlace !== 0) throw new Error("interlaced PNGs are not supported");

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : colorType === 0 ? 1 : 0;
  if (channels === 0) throw new Error(`unsupported color type ${colorType}`);

  const stride = width * channels;
  const inflated = inflateSync(Buffer.concat(idat));
  const raw = Buffer.alloc(width * height * channels);
  let input = 0;
  let previous = Buffer.alloc(stride);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[input];
    input += 1;
    const encoded = inflated.subarray(input, input + stride);
    input += stride;
    const row = Buffer.alloc(stride);
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const above = previous[x];
      const upperLeft = x >= channels ? previous[x - channels] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = above;
      else if (filter === 3) predictor = (left + above) >> 1;
      else if (filter === 4) predictor = paeth(left, above, upperLeft);
      else if (filter !== 0) throw new Error(`unsupported PNG filter ${filter}`);
      row[x] = (encoded[x] + predictor) & 0xff;
    }
    row.copy(raw, y * stride);
    previous = row;
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    const s = i * channels;
    const d = i * 4;
    if (colorType === 0) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = raw[s];
      rgba[d + 3] = 255;
    } else if (colorType === 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = raw[s];
      rgba[d + 3] = raw[s + 1];
    } else if (colorType === 2) {
      rgba[d] = raw[s];
      rgba[d + 1] = raw[s + 1];
      rgba[d + 2] = raw[s + 2];
      rgba[d + 3] = 255;
    } else {
      rgba[d] = raw[s];
      rgba[d + 1] = raw[s + 1];
      rgba[d + 2] = raw[s + 2];
      rgba[d + 3] = raw[s + 3];
    }
  }
  return { width, height, data: rgba };
}

/** Encode an RGBA pixel buffer as a non-interlaced 8-bit PNG. */
export function encodePng(width, height, rgba) {
  const rowBytes = width * 4;
  const raw = Buffer.alloc(height * (rowBytes + 1));
  for (let y = 0; y < height; y += 1) {
    raw[y * (rowBytes + 1)] = 0; // filter: none
    rgba.copy(raw, y * (rowBytes + 1) + 1, y * rowBytes, (y + 1) * rowBytes);
  }
  const idat = deflateSync(raw, { level: 9 });

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);
  return Buffer.concat([length, typeBuffer, data, crc]);
}

/**
 * Anti-aliased coverage (0..1) of a full-frame rounded rectangle at a pixel
 * centre, using the standard rounded-box signed distance field.
 */
export function roundedCoverage(x, y, width, height, radius) {
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const halfW = (width - 1) / 2;
  const halfH = (height - 1) / 2;
  const qx = Math.abs(x - cx) - halfW + radius;
  const qy = Math.abs(y - cy) - halfH + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const sd = outside + inside - radius;
  return Math.min(1, Math.max(0, 0.5 - sd));
}

/** Bounding box of pixels whose alpha exceeds `threshold`. */
export function alphaBounds(image, threshold = 8) {
  const { width, height, data } = image;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  return { minX, minY, maxX, maxY };
}

/**
 * Area-average downscale of a single-channel alpha crop into `tw`x`th`.
 */
export function downscaleAlpha(image, box, tw, th) {
  const { width, data } = image;
  const cw = box.maxX - box.minX + 1;
  const chh = box.maxY - box.minY + 1;
  const out = new Float64Array(tw * th);
  for (let ty = 0; ty < th; ty += 1) {
    const y0 = box.minY + (ty * chh) / th;
    const y1 = box.minY + ((ty + 1) * chh) / th;
    for (let tx = 0; tx < tw; tx += 1) {
      const x0 = box.minX + (tx * cw) / tw;
      const x1 = box.minX + ((tx + 1) * cw) / tw;
      let sum = 0;
      let count = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy <= box.maxY; sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx <= box.maxX; sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          sum += data[(sy * width + sx) * 4 + 3] * wx * wy;
          count += wx * wy;
        }
      }
      out[ty * tw + tx] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/** Area-average resize of an RGBA image (premultiplied so edges stay clean). */
export function resizeRGBA(image, tw, th) {
  const { width: sw, height: sh, data } = image;
  const out = Buffer.alloc(tw * th * 4);
  for (let ty = 0; ty < th; ty += 1) {
    const y0 = (ty * sh) / th;
    const y1 = ((ty + 1) * sh) / th;
    for (let tx = 0; tx < tw; tx += 1) {
      const x0 = (tx * sw) / tw;
      const x1 = ((tx + 1) * sw) / tw;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let wsum = 0;
      for (let sy = Math.floor(y0); sy < Math.ceil(y1) && sy < sh; sy += 1) {
        const wy = Math.min(sy + 1, y1) - Math.max(sy, y0);
        if (wy <= 0) continue;
        for (let sx = Math.floor(x0); sx < Math.ceil(x1) && sx < sw; sx += 1) {
          const wx = Math.min(sx + 1, x1) - Math.max(sx, x0);
          if (wx <= 0) continue;
          const w = wx * wy;
          const s = (sy * sw + sx) * 4;
          const af = data[s + 3] / 255;
          r += data[s] * af * w;
          g += data[s + 1] * af * w;
          b += data[s + 2] * af * w;
          a += data[s + 3] * w;
          wsum += w;
        }
      }
      const d = (ty * tw + tx) * 4;
      const aOut = wsum > 0 ? a / wsum : 0;
      const af = aOut / 255;
      out[d] = af > 0 ? Math.round(r / wsum / af) : 0;
      out[d + 1] = af > 0 ? Math.round(g / wsum / af) : 0;
      out[d + 2] = af > 0 ? Math.round(b / wsum / af) : 0;
      out[d + 3] = Math.round(aOut);
    }
  }
  return { width: tw, height: th, data: out };
}

/**
 * Build the app icon that `tauri icon` consumes: the full-bleed master is
 * inset by `paddingRatio` on a transparent canvas and its outer square is
 * rounded with `radiusRatio`, following the Windows 48px-grid guidance
 * (subtle exterior rounding plus transparent margin so the tile floats).
 */
export function buildRoundedAppIcon(image, options = {}) {
  const radiusRatio = options.radiusRatio ?? 0.12;
  const paddingRatio = options.paddingRatio ?? 0.06;
  const width = image.width;
  const height = image.height;
  const content = Math.round(Math.min(width, height) * (1 - 2 * paddingRatio));
  const resized = resizeRGBA(image, content, content);
  const radius = Math.round(content * radiusRatio);
  const offsetX = Math.round((width - content) / 2);
  const offsetY = Math.round((height - content) / 2);
  const out = Buffer.alloc(width * height * 4);
  for (let y = 0; y < content; y += 1) {
    for (let x = 0; x < content; x += 1) {
      const coverage = roundedCoverage(x, y, content, content, radius);
      const s = (y * content + x) * 4;
      const d = ((y + offsetY) * width + (x + offsetX)) * 4;
      out[d] = resized.data[s];
      out[d + 1] = resized.data[s + 1];
      out[d + 2] = resized.data[s + 2];
      out[d + 3] = Math.round((resized.data[s + 3] / 255) * coverage * 255);
    }
  }
  return { width, height, data: out };
}

/**
 * Build a Windows tray icon: a mid-slate rounded tile (visible on both light
 * tray panels and dark taskbars) with the robot silhouette centred on it. The
 * glyph uses the app icon's warm-paper colour so the tray matches the brand.
 */
export function buildTrayTile(silhouette, size, options = {}) {
  const tile = options.tile ?? [108, 121, 141];
  const glyph = options.glyph ?? [247, 241, 234];
  const radiusRatio = options.radiusRatio ?? 0.22;
  const glyphFraction = options.glyphFraction ?? 0.72;

  const bounds = alphaBounds(silhouette);
  const cw = bounds.maxX - bounds.minX + 1;
  const chh = bounds.maxY - bounds.minY + 1;
  const target = Math.round(size * glyphFraction);
  const scale = Math.min(target / cw, target / chh);
  const gw = Math.max(1, Math.round(cw * scale));
  const gh = Math.max(1, Math.round(chh * scale));
  const mask = downscaleAlpha(silhouette, bounds, gw, gh);
  const offsetX = Math.round((size - gw) / 2);
  const offsetY = Math.round((size - gh) / 2);
  const radius = Math.round(size * radiusRatio);

  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coverage = roundedCoverage(x, y, size, size, radius);
      const gx = x - offsetX;
      const gy = y - offsetY;
      const glyphAlpha =
        gx >= 0 && gy >= 0 && gx < gw && gy < gh ? mask[gy * gw + gx] / 255 : 0;
      const d = (y * size + x) * 4;
      out[d] = Math.round(tile[0] * (1 - glyphAlpha) + glyph[0] * glyphAlpha);
      out[d + 1] = Math.round(tile[1] * (1 - glyphAlpha) + glyph[1] * glyphAlpha);
      out[d + 2] = Math.round(tile[2] * (1 - glyphAlpha) + glyph[2] * glyphAlpha);
      out[d + 3] = Math.round(coverage * 255);
    }
  }
  return { width: size, height: size, data: out };
}
