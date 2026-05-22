import type { Bbox } from "./gemini";

export function expandBbox(
  bbox: Bbox,
  padTop = 8,
  padLeft = 8,
  padBottom = 8,
  padRight = 8,
): Bbox {
  const [ymin, xmin, ymax, xmax] = bbox;
  return [
    Math.max(0, ymin - padTop),
    Math.max(0, xmin - padLeft),
    Math.min(1000, ymax + padBottom),
    Math.min(1000, xmax + padRight),
  ];
}

export async function cropFromDataUrl(
  dataUrl: string,
  rawBbox: Bbox,
  imgW: number,
  imgH: number,
  pad = { top: 8, left: 8, bottom: 8, right: 8 },
): Promise<string> {
  const [ymin, xmin, ymax, xmax] = expandBbox(rawBbox, pad.top, pad.left, pad.bottom, pad.right);
  const x = Math.max(0, Math.floor((xmin / 1000) * imgW));
  const y = Math.max(0, Math.floor((ymin / 1000) * imgH));
  const w = Math.min(imgW - x, Math.ceil(((xmax - xmin) / 1000) * imgW));
  const h = Math.min(imgH - y, Math.ceil(((ymax - ymin) / 1000) * imgH));
  if (w <= 4 || h <= 4) throw new Error("Bounding box too small");

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = dataUrl;
  });
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(img, x, y, w, h, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

/**
 * Find where diagram content actually starts from the top of the image.
 * Used to strip question-text rows that Gemini included above the circuit.
 * Looks for the last significant empty gap in the top portion of the image.
 */
function findDiagramTopRow(data: Uint8ClampedArray, W: number, H: number): number {
  const SCAN_H   = Math.floor(H * 0.55);
  const MIN_DARK = Math.max(3, Math.floor(W * 0.01));
  const MIN_GAP  = 6;

  const hasContent = new Uint8Array(SCAN_H);
  for (let y = 0; y < SCAN_H; y++) {
    let dark = 0;
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 48) dark++;
    }
    hasContent[y] = dark >= MIN_DARK ? 1 : 0;
  }

  let lastGapEnd = 0;
  let gapStart   = -1;
  for (let y = 0; y < SCAN_H; y++) {
    if (!hasContent[y]) {
      if (gapStart < 0) gapStart = y;
    } else {
      if (gapStart >= 0) {
        if (y - gapStart >= MIN_GAP) lastGapEnd = y;
        gapStart = -1;
      }
    }
  }
  return lastGapEnd;
}

/**
 * Remove the background from a cropped diagram image.
 *
 * Strategy — global pixel threshold (works on any topology, including
 * enclosed white areas inside circuit component boxes):
 *
 *   1. Sample the four corners to estimate the background brightness.
 *      If the image is dark (e.g. dark-background photo), skip removal.
 *   2. Mark every pixel as transparent whose luminance is above the
 *      adaptive threshold — this removes the outer background AND all
 *      enclosed white fill inside circuit components in one pass.
 *   3. Optionally strip leading text rows (for option images where Gemini
 *      included question-stem text above the circuit).
 *   4. Auto-trim the result to the tight bounding box of remaining content.
 *
 * @param trimLeadingText  Pass true for option images to strip text that
 *                         bled in from the question stem above the circuit.
 */
export async function removeBackground(
  dataUrl: string,
  trimLeadingText = false,
): Promise<string> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const W = img.width;
      const H = img.height;
      const canvas = document.createElement("canvas");
      canvas.width = W;
      canvas.height = H;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(img, 0, 0);

      const imageData = ctx.getImageData(0, 0, W, H);
      const data = imageData.data;

      // ── 1. Measure corner brightness ──────────────────────────────────
      const bright = (px: number, py: number) => {
        const i = (py * W + px) * 4;
        return (data[i] + data[i + 1] + data[i + 2]) / 3;
      };
      const avgCorner =
        (bright(0, 0) + bright(W - 1, 0) + bright(0, H - 1) + bright(W - 1, H - 1)) / 4;

      if (avgCorner < 150) {
        // Dark background — do not modify
        resolve(dataUrl);
        return;
      }

      // Adaptive threshold: remove pixels this bright or brighter.
      // Set slightly below corner brightness to keep light-grey diagram lines.
      // Floor at 210 so we don't accidentally keep background on very dark scans.
      const THRESHOLD = Math.max(210, Math.min(250, avgCorner - 5));

      // ── 2. Global threshold pass ──────────────────────────────────────
      // Removes EVERY near-white pixel — outer background AND enclosed white
      // areas inside component boxes — in a single O(n) pass.
      for (let i = 0; i < W * H; i++) {
        const idx = i * 4;
        const r = data[idx];
        const g = data[idx + 1];
        const b = data[idx + 2];
        // Luminance of this pixel
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        if (lum >= THRESHOLD) {
          data[idx + 3] = 0; // fully transparent
        } else if (lum >= THRESHOLD - 20) {
          // Soft anti-alias fringe: fade out semi-white pixels smoothly
          data[idx + 3] = Math.round(((THRESHOLD - lum) / 20) * 255);
        }
      }

      ctx.putImageData(imageData, 0, 0);

      // ── 3. Optional: skip question-text rows above the diagram ────────
      const topRow = trimLeadingText ? findDiagramTopRow(data, W, H) : 0;

      // ── 4. Auto-trim to tight bounding box of non-transparent content ─
      let minX = W, maxX = 0, minY = H, maxY = 0;
      for (let y = topRow; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (data[(y * W + x) * 4 + 3] > 12) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX < minX || maxY < minY) {
        resolve(dataUrl);
        return;
      }

      const MARGIN = 5;
      const cx = Math.max(0, minX - MARGIN);
      const cy = Math.max(0, minY - MARGIN);
      const cw = Math.min(W, maxX + MARGIN + 1) - cx;
      const ch = Math.min(H, maxY + MARGIN + 1) - cy;

      const out = document.createElement("canvas");
      out.width = cw;
      out.height = ch;
      out.getContext("2d")!.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
      resolve(out.toDataURL("image/png"));
    };
    img.src = dataUrl;
  });
}
