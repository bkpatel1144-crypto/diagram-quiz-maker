import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { ApiKeyGate } from "@/components/ApiKeyGate";
import { PdfUploader } from "@/components/PdfUploader";
import { ProcessingView, type PageResult } from "@/components/ProcessingView";
import { ReviewDashboard } from "@/components/ReviewDashboard";
import { Button } from "@/components/ui/button";
import { KeyRound, Sparkles } from "lucide-react";

export const Route = createFileRoute("/")({ component: Index });

type Stage = "upload" | "processing" | "review";

function Index() {
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>("upload");
  const [job, setJob] = useState<{ file: File; from: number; to: number } | null>(null);
  const [results, setResults] = useState<PageResult[]>([]);

  useEffect(() => {
    const k = typeof window !== "undefined" ? localStorage.getItem("gemini_api_key") : null;
    if (k) setApiKey(k);
  }, []);

  const saveKey = (k: string) => {
    localStorage.setItem("gemini_api_key", k);
    setApiKey(k);
  };

  const clearKey = () => {
    localStorage.removeItem("gemini_api_key");
    setApiKey(null);
  };

  if (!apiKey) return <ApiKeyGate onSave={saveKey} />;

  if (stage === "review") {
    return (
      <ReviewDashboard
        results={results}
        apiKey={apiKey}
        onUpdate={setResults}
        onReset={() => {
          setResults([]);
          setJob(null);
          setStage("upload");
        }}
      />
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <Sparkles className="h-5 w-5" />
            </div>
            <div>
              <h1 className="font-semibold leading-tight">AI PDF Quiz Converter</h1>
              <p className="text-xs text-muted-foreground">
                Physics & Maths · SVG diagrams · Gemini
              </p>
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={clearKey}>
            <KeyRound className="mr-1 h-4 w-4" /> Change API key
          </Button>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-6 py-10">
        {stage === "upload" && (
          <PdfUploader
            onReady={(file, from, to) => {
              setJob({ file, from, to });
              setStage("processing");
            }}
          />
        )}
        {stage === "processing" && job && (
          <ProcessingView
            file={job.file}
            from={job.from}
            to={job.to}
            apiKey={apiKey}
            onDone={(r) => {
              setResults(r);
              setStage("review");
            }}
          />
        )}
      </main>
    </div>
  );
}
