import { useEffect, useRef } from "react";
import { Progress } from "@/components/ui/progress";
import { loadPdf, renderPage, RenderedPage } from "@/lib/pdf";
import { callGemini, Question } from "@/lib/gemini";

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
  const [status, setStatus] = useStateImpl();

  useEffect(() => {
    if (ranRef.current) return;
    ranRef.current = true;
    (async () => {
      const pdf = await loadPdf(file);
      const total = to - from + 1;
      const results: PageResult[] = [];
      for (let i = 0; i < total; i++) {
        const pageNum = from + i;
        setStatus({ current: i, total, label: `Rendering page ${pageNum}...` });
        const page = await renderPage(pdf, pageNum);
        setStatus({ current: i, total, label: `Analyzing page ${pageNum} with AI...` });
        try {
          const questions = await callGemini(apiKey, page.base64);
          results.push({ page, questions });
        } catch (e: any) {
          results.push({ page, questions: [], error: e.message });
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

// Minimal local state helper to avoid extra import noise above
function useStateImpl() {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const React = require("react");
  return React.useState({ current: 0, total: 1, label: "Preparing..." }) as [
    { current: number; total: number; label: string },
    (s: { current: number; total: number; label: string }) => void,
  ];
}
