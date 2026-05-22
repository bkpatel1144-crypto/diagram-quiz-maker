import * as pdfjsLib from "pdfjs-dist";
// @ts-ignore - vite worker import
import PdfWorker from "pdfjs-dist/build/pdf.worker.min.mjs?worker";

pdfjsLib.GlobalWorkerOptions.workerPort = new PdfWorker();

export interface RenderedPage {
  pageNumber: number;
  dataUrl: string; // jpeg data URL
  base64: string; // raw base64 (no prefix)
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
  return { pageNumber, dataUrl, base64 };
}
