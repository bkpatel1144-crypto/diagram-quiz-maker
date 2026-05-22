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

/**
 * Crop a region from a page data URL using Gemini-style normalized bbox
 * [ymin, xmin, ymax, xmax] in 0-1000 coords. Returns a PNG data URL.
 */
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
 * After background removal, scan from the top of the image to find where
 * "real diagram content" begins — skipping any question-text rows that bled
 * in because Gemini's ymin was too high.
 *
 * Strategy:
 *   1. Mark each row as "has content" (≥ MIN_DARK non-transparent pixels).
 *   2. Find the LAST significant empty gap (≥ MIN_GAP consecutive empty rows)
 *      in the top SCAN_FRAC of the image.
 *   3. Return the first content row after that gap — the diagram truly starts there.
 *
 * If no qualifying gap is found, returns 0 (no trimming).
 */
function findDiagramTopRow(data: Uint8ClampedArray, W: number, H: number): number {
  const SCAN_H    = Math.floor(H * 0.55); // only look at top 55 %
  const MIN_DARK  = Math.max(3, Math.floor(W * 0.01)); // ≥1 % of width must be dark
  const MIN_GAP   = 6;  // gap must be ≥ 6 rows to count as a separator

  const hasContent = new Uint8Array(SCAN_H);
  for (let y = 0; y < SCAN_H; y++) {
    let dark = 0;
    for (let x = 0; x < W; x++) {
      if (data[(y * W + x) * 4 + 3] > 48) dark++;
    }
    hasContent[y] = dark >= MIN_DARK ? 1 : 0;
  }

  // Walk through, recording the end-row of the last significant gap
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
 * Remove white / near-white background from a data URL using BFS flood-fill
 * from all four edges, then auto-trim to the bounding box of remaining content.
 *
 * @param trimLeadingText  When true (used for option images), also strip rows of
 *                         question-text that bleed in above the diagram.
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

      // ── 1. Detect background brightness from corners ───────────────────
      const bright = (px: number, py: number) => {
        const i = (py * W + px) * 4;
        return (data[i] + data[i + 1] + data[i + 2]) / 3;
      };
      const avgCorner =
        (bright(0, 0) + bright(W - 1, 0) + bright(0, H - 1) + bright(W - 1, H - 1)) / 4;

      if (avgCorner < 160) {
        // Dark background — don't attempt removal
        resolve(dataUrl);
        return;
      }

      // Adaptive threshold: slightly below corner brightness so we keep
      // light-grey diagram lines while removing the page background.
      const THRESHOLD = Math.max(218, Math.min(248, avgCorner - 6));

      const isBackground = (idx: number) =>
        data[idx] >= THRESHOLD &&
        data[idx + 1] >= THRESHOLD &&
        data[idx + 2] >= THRESHOLD;

      // ── 2. BFS flood-fill from all four edges ─────────────────────────
      const visited = new Uint8Array(W * H);
      const queue: number[] = [];

      const enqueue = (px: number, py: number) => {
        if (px < 0 || px >= W || py < 0 || py >= H) return;
        const pos = py * W + px;
        if (visited[pos]) return;
        if (!isBackground(pos * 4)) return;
        visited[pos] = 1;
        queue.push(px, py);
      };

      for (let x = 0; x < W; x++) { enqueue(x, 0); enqueue(x, H - 1); }
      for (let y = 0; y < H; y++) { enqueue(0, y); enqueue(W - 1, y); }

      let head = 0;
      while (head < queue.length) {
        const px = queue[head++];
        const py = queue[head++];
        data[(py * W + px) * 4 + 3] = 0;
        enqueue(px + 1, py);
        enqueue(px - 1, py);
        enqueue(px, py + 1);
        enqueue(px, py - 1);
      }

      // ── 3. Strip any residual pure-white pixels (enclosed areas) ──────
      for (let i = 0; i < W * H; i++) {
        const idx = i * 4;
        if (data[idx + 3] === 0) continue;
        if (data[idx] > 250 && data[idx + 1] > 250 && data[idx + 2] > 250) {
          data[idx + 3] = 0;
        }
      }

      ctx.putImageData(imageData, 0, 0);

      // ── 4. Optional: find where diagram actually starts (skip text rows) ─
      const topRow = trimLeadingText ? findDiagramTopRow(data, W, H) : 0;

      // ── 5. Auto-trim to bounding box of non-transparent content ───────
      let minX = W, maxX = 0, minY = H, maxY = 0;
      for (let y = topRow; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (data[(y * W + x) * 4 + 3] > 16) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX < minX || maxY < minY) {
        resolve(dataUrl); // nothing visible — return original
        return;
      }

      const MARGIN = 6;
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
