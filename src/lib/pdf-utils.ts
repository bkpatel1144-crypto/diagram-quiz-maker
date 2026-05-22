import type { Bbox } from "./gemini";

/**
 * Expand a bbox by the given margins (0-1000 space), clamped to [0, 1000].
 * Kept small intentionally — the AI already provides some padding.
 * Large expansion causes neighbouring text to bleed into the crop.
 */
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
): Promise<string> {
  const bbox = expandBbox(rawBbox);
  const [ymin, xmin, ymax, xmax] = bbox;
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
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, x, y, w, h, 0, 0, w, h);
  return canvas.toDataURL("image/png");
}

/**
 * Remove white / near-white background from a PNG/JPEG data URL.
 * Uses BFS flood-fill from the four edges to remove connected background,
 * then auto-trims the result to the bounding box of remaining content.
 * Returns a transparent PNG data URL.
 */
export async function removeBackground(dataUrl: string): Promise<string> {
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

      // Sample corner brightness to confirm a light scanned background
      const bright = (px: number, py: number) => {
        const i = (py * W + px) * 4;
        return (data[i] + data[i + 1] + data[i + 2]) / 3;
      };
      const avgCorner = (bright(0, 0) + bright(W - 1, 0) + bright(0, H - 1) + bright(W - 1, H - 1)) / 4;
      if (avgCorner < 160) {
        // Dark/non-white background — don't modify
        resolve(dataUrl);
        return;
      }

      // Adaptive threshold: slightly below the corner brightness so we
      // remove the scanned-paper background but keep light-grey diagram lines.
      const THRESHOLD = Math.max(220, Math.min(248, avgCorner - 8));

      const isBackground = (idx: number): boolean =>
        data[idx] >= THRESHOLD &&
        data[idx + 1] >= THRESHOLD &&
        data[idx + 2] >= THRESHOLD;

      const visited = new Uint8Array(W * H);
      const queue: number[] = [];

      const enqueue = (px: number, py: number) => {
        if (px < 0 || px >= W || py < 0 || py >= H) return;
        const pos = py * W + px;
        if (visited[pos]) return;
        const idx = pos * 4;
        if (!isBackground(idx)) return;
        visited[pos] = 1;
        queue.push(px, py);
      };

      // Seed all four edges
      for (let x = 0; x < W; x++) { enqueue(x, 0); enqueue(x, H - 1); }
      for (let y = 0; y < H; y++) { enqueue(0, y); enqueue(W - 1, y); }

      // BFS flood-fill → set alpha to 0 for background pixels
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

      ctx.putImageData(imageData, 0, 0);

      // Auto-trim: find bounding box of non-transparent content
      const trimmed = ctx.getImageData(0, 0, W, H);
      const td = trimmed.data;
      let minX = W, maxX = 0, minY = H, maxY = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          if (td[(y * W + x) * 4 + 3] > 16) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }

      if (maxX < minX || maxY < minY) {
        // Nothing left — return original crop without bg removal
        resolve(dataUrl);
        return;
      }

      // Add a small content margin
      const MARGIN = 6;
      const cx = Math.max(0, minX - MARGIN);
      const cy = Math.max(0, minY - MARGIN);
      const cw = Math.min(W, maxX + MARGIN + 1) - cx;
      const ch = Math.min(H, maxY + MARGIN + 1) - cy;

      const out = document.createElement("canvas");
      out.width = cw;
      out.height = ch;
      const octx = out.getContext("2d")!;
      octx.drawImage(canvas, cx, cy, cw, ch, 0, 0, cw, ch);
      resolve(out.toDataURL("image/png"));
    };
    img.src = dataUrl;
  });
}
