import { useEffect, useRef, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { callGemini, Question } from "@/lib/gemini";
import type { RenderedPage } from "@/lib/pdf";

export interface PageResult {
  page: RenderedPage;
  questions: Question[];
  error?: string;
}

interface Props {
  file: File;
  from: number;
  to: number;
  apiKey: string;
  onDone: (results: PageResult[]) => void;
}

export function ProcessingView({ file, from, to, apiKey, onDone }: Props) {
  const ranRef = useRef(false);
  const [status, setStatus] = useState({ current: 0, total: to - from + 1, label: "Preparing..." });

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    (async () => {
      const { loadPdf, renderPage, cropFromDataUrl } = await import("@/lib/pdf");
      const pdf = await loadPdf(file);
      const total = to - from + 1;
      const results: PageResult[] = [];
      for (let i = 0; i < total; i++) {
        const pageNum = from + i;
        setStatus({ current: i, total, label: `Rendering page ${pageNum}...` });
        const page = await renderPage(pdf, pageNum);
        setStatus({ current: i, total, label: `Analyzing page ${pageNum} with Gemini...` });
        try {
          const questions = await callGemini(apiKey, page.base64);
          // Crop diagrams from the source page using AI-returned bounding boxes
          for (const q of questions) {
            if (q.has_diagram && q.diagram_bbox) {
              try {
                q.diagram_image = await cropFromDataUrl(page.dataUrl, q.diagram_bbox, page.width, page.height);
              } catch {
                // ignore — fallback UI handles missing image
              }
            }
          }
          results.push({ page, questions });
        } catch (e: any) {
          results.push({ page, questions: [], error: e?.message ?? String(e) });
        }
      }
      setStatus({ current: total, total, label: "Done" });
      onDone(results);
    })();
  }, [file, from, to, apiKey, onDone]);

  const pct = status.total ? (status.current / status.total) * 100 : 0;

  return (
    <div className="mx-auto max-w-xl py-16 text-center space-y-4">
      <h2 className="text-xl font-semibold">{status.label}</h2>
      <p className="text-sm text-muted-foreground">
        Page {Math.min(status.current + 1, status.total)} of {status.total}
      </p>
      <Progress value={pct} />
    </div>
  );
}
