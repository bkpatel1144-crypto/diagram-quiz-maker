import type { Bbox } from "./gemini";

/**
 * Expand a bbox by the given margins (0-1000 space), clamped to [0, 1000].
 * Extra bottom/right bias because AI bboxes tend to under-shoot those edges.
 */
export function expandBbox(
  bbox: Bbox,
  padTop = 18,
  padLeft = 18,
  padBottom = 28,
  padRight = 28,
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
 * Automatically expands bbox by a small margin so edges are fully included.
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
 * Remove white / near-white background from a PNG data URL using canvas pixel manipulation.
 * Flood-fills from the four edges, making all connected background pixels transparent.
 * Returns a PNG data URL with transparent background.
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

      // Sample corner pixels to confirm the background is light
      const sampleBrightness = (px: number, py: number) => {
        const idx = (py * W + px) * 4;
        return (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      };
      const avgCorner = (
        sampleBrightness(0, 0) + sampleBrightness(W - 1, 0) +
        sampleBrightness(0, H - 1) + sampleBrightness(W - 1, H - 1)
      ) / 4;

      // Only attempt removal for light (scanned page) backgrounds
      if (avgCorner < 180) {
        resolve(dataUrl);
        return;
      }

      const BG_THRESHOLD = 235;
      const isBackground = (idx: number): boolean =>
        data[idx] >= BG_THRESHOLD &&
        data[idx + 1] >= BG_THRESHOLD &&
        data[idx + 2] >= BG_THRESHOLD;

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

      // BFS flood-fill
      let head = 0;
      while (head < queue.length) {
        const px = queue[head++];
        const py = queue[head++];
        data[(py * W + px) * 4 + 3] = 0; // transparent
        enqueue(px + 1, py);
        enqueue(px - 1, py);
        enqueue(px, py + 1);
        enqueue(px, py - 1);
      }

      // Second pass: knock out any isolated pure-white pixels inside the diagram
      for (let i = 0; i < W * H; i++) {
        const idx = i * 4;
        if (data[idx + 3] === 0) continue;
        if (data[idx] > 248 && data[idx + 1] > 248 && data[idx + 2] > 248) {
          data[idx + 3] = 0;
        }
      }

      ctx.putImageData(imageData, 0, 0);
      resolve(canvas.toDataURL("image/png"));
    };
    img.src = dataUrl;
  });
}
