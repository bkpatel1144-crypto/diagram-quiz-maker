import * as pdfjsLib from "pdfjs-dist";
// @ts-ignore - vite worker import
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

export interface RenderedPage {
  pageNumber: number;
  dataUrl: string; // jpeg data URL
  base64: string; // raw base64 (no prefix)
  width: number;
  height: number;
}

export async function loadPdf(file: File) {
  const buf = await file.arrayBuffer();
  return await pdfjsLib.getDocument({ data: buf }).promise;
}

export async function renderPage(
  pdf: any,
  pageNumber: number,
  scale = 2.5,
): Promise<RenderedPage> {
  const page = await pdf.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d")!;
  await page.render({ canvasContext: ctx, viewport, canvas }).promise;
  const dataUrl = canvas.toDataURL("image/jpeg", 0.92);
  const base64 = dataUrl.split(",")[1];
  return { pageNumber, dataUrl, base64, width: canvas.width, height: canvas.height };
}

/**
 * Crop a region from a page data URL using Gemini-style normalized bbox
 * [ymin, xmin, ymax, xmax] in 0-1000 coords. Returns a PNG data URL.
 */
export async function cropFromDataUrl(
  dataUrl: string,
  bbox: [number, number, number, number],
  imgW: number,
  imgH: number,
): Promise<string> {
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
