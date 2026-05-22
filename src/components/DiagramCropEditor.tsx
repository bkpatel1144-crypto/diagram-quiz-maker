import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Crop, X, ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import type { Bbox } from "@/lib/gemini";
import { cropFromDataUrl, removeBackground } from "@/lib/pdf-utils";

type Rect = { x: number; y: number; w: number; h: number };
type Handle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "move" | "draw";

const HANDLE_PX = 10;
const MIN_PX = 24;
const CHECKER = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23e0e0e0'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23e0e0e0'/%3E%3C/svg%3E") #f8f8f8`;

const CURSOR: Record<Handle, string> = {
  nw: "nw-resize", n: "n-resize", ne: "ne-resize",
  e: "e-resize", se: "se-resize", s: "s-resize",
  sw: "sw-resize", w: "w-resize", move: "move", draw: "crosshair",
};

export interface CropTarget {
  type: "diagram" | "option";
  optionIndex?: number;
  label: string;
}

interface Props {
  pageDataUrl: string;
  pageWidth: number;
  pageHeight: number;
  initialBbox?: Bbox;
  target: CropTarget;
  onApply: (dataUrl: string, bbox: Bbox) => void;
  onClose: () => void;
}

function bboxToRect(bbox: Bbox, dw: number, dh: number): Rect {
  const [ymin, xmin, ymax, xmax] = bbox;
  return {
    x: (xmin / 1000) * dw,
    y: (ymin / 1000) * dh,
    w: ((xmax - xmin) / 1000) * dw,
    h: ((ymax - ymin) / 1000) * dh,
  };
}

function rectToBbox(r: Rect, dw: number, dh: number): Bbox {
  return [
    Math.max(0, Math.min(1000, Math.round((r.y / dh) * 1000))),
    Math.max(0, Math.min(1000, Math.round((r.x / dw) * 1000))),
    Math.max(0, Math.min(1000, Math.round(((r.y + r.h) / dh) * 1000))),
    Math.max(0, Math.min(1000, Math.round(((r.x + r.w) / dw) * 1000))),
  ];
}

function clampRect(r: Rect, dw: number, dh: number): Rect {
  const w = Math.max(MIN_PX, Math.min(dw, r.w));
  const h = Math.max(MIN_PX, Math.min(dh, r.h));
  return { x: Math.max(0, Math.min(dw - w, r.x)), y: Math.max(0, Math.min(dh - h, r.y)), w, h };
}

function hitHandle(mx: number, my: number, r: Rect): Handle | null {
  const ht = HANDLE_PX + 4;
  const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
  const near = (px: number, py: number) => Math.abs(mx - px) <= ht && Math.abs(my - py) <= ht;
  if (near(r.x, r.y))              return "nw";
  if (near(cx, r.y))               return "n";
  if (near(r.x + r.w, r.y))       return "ne";
  if (near(r.x + r.w, cy))        return "e";
  if (near(r.x + r.w, r.y + r.h)) return "se";
  if (near(cx, r.y + r.h))        return "s";
  if (near(r.x, r.y + r.h))       return "sw";
  if (near(r.x, cy))               return "w";
  if (mx >= r.x && mx <= r.x + r.w && my >= r.y && my <= r.y + r.h) return "move";
  return null;
}

function applyDrag(mode: Handle, dx: number, dy: number, init: Rect, dw: number, dh: number): Rect {
  let { x, y, w, h } = init;
  if (mode === "move")  { x += dx; y += dy; }
  else if (mode === "se") { w = Math.max(MIN_PX, w + dx); h = Math.max(MIN_PX, h + dy); }
  else if (mode === "sw") { const nw = Math.max(MIN_PX, w - dx); x += w - nw; w = nw; h = Math.max(MIN_PX, h + dy); }
  else if (mode === "ne") { w = Math.max(MIN_PX, w + dx); const nh = Math.max(MIN_PX, h - dy); y += h - nh; h = nh; }
  else if (mode === "nw") { const nw = Math.max(MIN_PX, w - dx); x += w - nw; w = nw; const nh = Math.max(MIN_PX, h - dy); y += h - nh; h = nh; }
  else if (mode === "n")  { const nh = Math.max(MIN_PX, h - dy); y += h - nh; h = nh; }
  else if (mode === "s")  { h = Math.max(MIN_PX, h + dy); }
  else if (mode === "e")  { w = Math.max(MIN_PX, w + dx); }
  else if (mode === "w")  { const nw = Math.max(MIN_PX, w - dx); x += w - nw; w = nw; }
  return clampRect({ x, y, w, h }, dw, dh);
}

export function DiagramCropEditor({ pageDataUrl, pageWidth, pageHeight, initialBbox, target, onApply, onClose }: Props) {
  const imgRef     = useRef<HTMLImageElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  const [imgReady, setImgReady]             = useState(false);
  const [rect, setRect]                     = useState<Rect>({ x: 40, y: 40, w: 160, h: 120 });
  const [preview, setPreview]               = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [applying, setApplying]             = useState(false);
  const [zoom, setZoom]                     = useState(1);

  const dragRef = useRef<{ mode: Handle; sx: number; sy: number; init: Rect } | null>(null);
  const drawRef = useRef<{ sx: number; sy: number } | null>(null);

  const getDispDims = useCallback(() => {
    const img = imgRef.current;
    if (!img) return null;
    return { dw: img.offsetWidth, dh: img.offsetHeight };
  }, []);

  useEffect(() => {
    if (!imgReady) return;
    const dims = getDispDims();
    if (!dims) return;
    const { dw, dh } = dims;
    setRect(initialBbox ? bboxToRect(initialBbox, dw, dh) : { x: dw * 0.1, y: dh * 0.1, w: dw * 0.8, h: dh * 0.8 });
  }, [imgReady, initialBbox, getDispDims]);

  useEffect(() => {
    if (!imgReady) return;
    const dims = getDispDims();
    if (!dims) return;
    const { dw, dh } = dims;
    const t = setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const bbox = rectToBbox(rect, dw, dh);
        const cropped = await cropFromDataUrl(pageDataUrl, bbox, pageWidth, pageHeight, { top: 0, left: 0, bottom: 0, right: 0 });
        setPreview(await removeBackground(cropped, false));
      } catch {
        setPreview(null);
      } finally {
        setPreviewLoading(false);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [rect, pageDataUrl, pageWidth, pageHeight, imgReady, getDispDims]);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const dims = getDispDims();
      if (!dims) return;
      const { dw, dh } = dims;
      const overlay = overlayRef.current;
      if (!overlay) return;
      const ob = overlay.getBoundingClientRect();

      if (drawRef.current) {
        const mx = Math.max(0, Math.min(dw, e.clientX - ob.left));
        const my = Math.max(0, Math.min(dh, e.clientY - ob.top));
        const { sx, sy } = drawRef.current;
        setRect(clampRect({ x: Math.min(mx, sx), y: Math.min(my, sy), w: Math.max(MIN_PX, Math.abs(mx - sx)), h: Math.max(MIN_PX, Math.abs(my - sy)) }, dw, dh));
        return;
      }
      if (!dragRef.current) return;
      const { mode, sx, sy, init } = dragRef.current;
      setRect(applyDrag(mode, e.clientX - sx, e.clientY - sy, init, dw, dh));
    };
    const onUp = () => { dragRef.current = null; drawRef.current = null; };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
  }, [getDispDims]);

  const handleOverlayMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ob = overlay.getBoundingClientRect();
    const mx = e.clientX - ob.left, my = e.clientY - ob.top;
    const handle = hitHandle(mx, my, rect);
    if (handle) {
      dragRef.current = { mode: handle, sx: e.clientX, sy: e.clientY, init: { ...rect } };
    } else {
      drawRef.current = { sx: mx, sy: my };
      setRect({ x: mx, y: my, w: MIN_PX, h: MIN_PX });
    }
  };

  const handleOverlayMouseMove = (e: React.MouseEvent) => {
    if (dragRef.current || drawRef.current) return;
    const overlay = overlayRef.current;
    if (!overlay) return;
    const ob = overlay.getBoundingClientRect();
    const handle = hitHandle(e.clientX - ob.left, e.clientY - ob.top, rect);
    overlay.style.cursor = CURSOR[handle ?? "draw"];
  };

  const handleApply = async () => {
    const dims = getDispDims();
    if (!dims) return;
    setApplying(true);
    try {
      const bbox = rectToBbox(rect, dims.dw, dims.dh);
      const cropped = await cropFromDataUrl(pageDataUrl, bbox, pageWidth, pageHeight, { top: 0, left: 0, bottom: 0, right: 0 });
      onApply(await removeBackground(cropped, false), bbox);
    } catch (e: any) {
      alert("Crop failed: " + (e?.message ?? "unknown error"));
    } finally {
      setApplying(false);
    }
  };

  const resetSelection = () => {
    const dims = getDispDims();
    if (!dims) return;
    setRect(initialBbox ? bboxToRect(initialBbox, dims.dw, dims.dh) : { x: dims.dw * 0.1, y: dims.dh * 0.1, w: dims.dw * 0.8, h: dims.dh * 0.8 });
  };

  const HANDLES: { id: Handle; lx: number; ly: number }[] = [
    { id: "nw", lx: rect.x,              ly: rect.y              },
    { id: "n",  lx: rect.x + rect.w / 2, ly: rect.y              },
    { id: "ne", lx: rect.x + rect.w,     ly: rect.y              },
    { id: "e",  lx: rect.x + rect.w,     ly: rect.y + rect.h / 2 },
    { id: "se", lx: rect.x + rect.w,     ly: rect.y + rect.h     },
    { id: "s",  lx: rect.x + rect.w / 2, ly: rect.y + rect.h     },
    { id: "sw", lx: rect.x,              ly: rect.y + rect.h     },
    { id: "w",  lx: rect.x,              ly: rect.y + rect.h / 2 },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm">
      <div className="flex h-[92vh] w-[96vw] max-w-7xl flex-col overflow-hidden rounded-2xl shadow-2xl" style={{ background: "#18181b" }}>

        {/* Header */}
        <div className="flex shrink-0 items-center justify-between border-b border-white/10 px-5 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500/20">
              <Crop className="h-4 w-4 text-sky-400" />
            </div>
            <div>
              <span className="font-semibold text-white">Crop — {target.label}</span>
              <span className="ml-3 text-xs text-zinc-500">Drag to move · handles to resize · click empty area to redraw</span>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-zinc-400 hover:text-white"
              onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.2).toFixed(1)))}>
              <ZoomOut className="h-4 w-4" />
            </Button>
            <span className="min-w-[3rem] text-center text-xs text-zinc-400">{Math.round(zoom * 100)}%</span>
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-zinc-400 hover:text-white"
              onClick={() => setZoom((z) => Math.min(3, +(z + 0.2).toFixed(1)))}>
              <ZoomIn className="h-4 w-4" />
            </Button>
            <div className="mx-2 h-5 w-px bg-white/10" />
            <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-zinc-400 hover:text-white" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1">
          {/* Page + selection */}
          <div className="relative min-w-0 flex-1 overflow-auto bg-zinc-950 p-4">
            <div className="relative inline-block origin-top-left" style={{ transform: `scale(${zoom})`, transformOrigin: "top left" }}>
              <img
                ref={imgRef}
                src={pageDataUrl}
                className="block select-none"
                style={{ width: "100%", maxWidth: "none", minWidth: 400 }}
                draggable={false}
                onLoad={() => setImgReady(true)}
                alt="PDF page"
              />
              {imgReady && (
                <div
                  ref={overlayRef}
                  className="absolute inset-0"
                  style={{ cursor: "crosshair" }}
                  onMouseDown={handleOverlayMouseDown}
                  onMouseMove={handleOverlayMouseMove}
                >
                  {/* Darkened backdrop */}
                  <div style={{
                    position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h,
                    boxShadow: "0 0 0 9999px rgba(0,0,0,0.52)",
                    border: "1.5px solid #38bdf8", borderRadius: 2, pointerEvents: "none",
                  }} />
                  {/* Size readout */}
                  <div style={{ position: "absolute", left: rect.x, top: rect.y + rect.h + 4, pointerEvents: "none" }}
                    className="rounded bg-sky-500 px-1.5 py-0.5 text-[10px] font-mono font-semibold text-white shadow">
                    {Math.round((rect.w / (imgRef.current?.offsetWidth ?? 1)) * 1000)}
                    {" × "}
                    {Math.round((rect.h / (imgRef.current?.offsetHeight ?? 1)) * 1000)}
                    <span className="ml-1 font-normal opacity-70">/ 1000</span>
                  </div>
                  {/* 8 resize handles */}
                  {HANDLES.map(({ id, lx, ly }) => (
                    <div key={id}
                      onMouseDown={(e) => {
                        e.preventDefault(); e.stopPropagation();
                        dragRef.current = { mode: id, sx: e.clientX, sy: e.clientY, init: { ...rect } };
                      }}
                      style={{
                        position: "absolute", left: lx - HANDLE_PX / 2, top: ly - HANDLE_PX / 2,
                        width: HANDLE_PX, height: HANDLE_PX,
                        background: "#fff", border: "2px solid #0ea5e9", borderRadius: 2,
                        cursor: CURSOR[id], boxShadow: "0 1px 4px rgba(0,0,0,.5)", zIndex: 10,
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Preview panel */}
          <div className="flex w-64 shrink-0 flex-col gap-4 border-l border-white/10 p-4" style={{ background: "#1c1c1f" }}>
            <div>
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-400">Live Preview</p>
              <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-xl border border-white/10"
                style={{ background: previewLoading ? "#27272a" : CHECKER }}>
                {previewLoading ? (
                  <p className="animate-pulse text-xs text-zinc-500">Processing…</p>
                ) : preview ? (
                  <img src={preview} className="max-h-60 max-w-full object-contain p-2" alt="Cropped preview" />
                ) : (
                  <p className="text-xs text-zinc-600">Draw a selection</p>
                )}
              </div>
            </div>
            <div className="mt-auto space-y-2">
              <Button size="sm" variant="ghost"
                className="w-full justify-center gap-2 border border-white/10 text-zinc-400 hover:bg-zinc-800 hover:text-white"
                onClick={resetSelection}>
                <RotateCcw className="h-3.5 w-3.5" /> Reset Selection
              </Button>
              <Button className="w-full bg-sky-600 font-semibold text-white hover:bg-sky-500"
                onClick={handleApply} disabled={applying || !preview}>
                {applying ? "Applying…" : "Apply Crop"}
              </Button>
              <Button variant="ghost" className="w-full text-zinc-400 hover:bg-zinc-800 hover:text-white" onClick={onClose}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
