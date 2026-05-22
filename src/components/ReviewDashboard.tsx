import { useEffect, useMemo, useRef, useState } from "react";
import type { PageResult } from "./ProcessingView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Pencil, Check, RefreshCw, Trash2, FileJson, FileCode } from "lucide-react";
import type { Question } from "@/lib/gemini";
import { regenerateDiagramBbox } from "@/lib/gemini";
import { cropFromDataUrl, removeBackground } from "@/lib/pdf-utils";

interface Props {
  results: PageResult[];
  apiKey: string;
  onUpdate: (results: PageResult[]) => void;
  onReset: () => void;
}

/**
 * Resolve the correct-answer index (0-based) from whatever format the AI returned.
 * Handles: "a"/"b"/"c"/"d", "(a)"/"(b)", "A"/"B", full option text, or index string "0"/"1".
 */
function resolveCorrectIndex(correctAnswer: string, options: string[]): number {
  if (!correctAnswer) return -1;
  const ca = correctAnswer.trim().toLowerCase().replace(/[().\s]/g, "");

  // Letter form: a, b, c, d → index 0,1,2,3
  if (/^[a-d]$/.test(ca)) return ca.charCodeAt(0) - 97;

  // Numeric index
  if (/^\d$/.test(ca)) {
    const n = parseInt(ca, 10);
    if (n >= 0 && n < options.length) return n;
  }

  // Exact option text match (case-insensitive, html-stripped)
  const strip = (s: string) => s.replace(/<[^>]+>/g, "").toLowerCase().trim();
  const strippedCA = strip(correctAnswer);
  const idx = options.findIndex((o) => strip(o) === strippedCA);
  return idx;
}

export function ReviewDashboard({ results, apiKey, onUpdate, onReset }: Props) {
  const [active, setActive] = useState(0);
  const current = results[active];
  const rightPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if ((window as any).MathJax) return;
    (window as any).MathJax = { tex: { inlineMath: [["\\(", "\\)"]], displayMath: [["\\[", "\\]"]] }, svg: { fontCache: "global" } };
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-svg.js";
    s.async = true;
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    const mj = (window as any).MathJax;
    if (mj?.typesetPromise && rightPanelRef.current) mj.typesetPromise([rightPanelRef.current]).catch(() => {});
  }, [results, active]);

  const updateQuestion = (idx: number, q: Question) => {
    const next = [...results];
    next[active] = { ...current, questions: current.questions.map((x, i) => (i === idx ? q : x)) };
    onUpdate(next);
  };
  const deleteQuestion = (idx: number) => {
    const next = [...results];
    next[active] = { ...current, questions: current.questions.filter((_, i) => i !== idx) };
    onUpdate(next);
  };

  const allQuestions = useMemo(() => results.flatMap((r) => r.questions), [results]);

  return (
    <div className="flex h-screen flex-col bg-background">
      <header className="flex items-center justify-between border-b bg-card px-6 py-3">
        <div>
          <h1 className="font-semibold tracking-tight">Review & Edit</h1>
          <p className="text-xs text-muted-foreground">{allQuestions.length} questions across {results.length} pages</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => exportJSON(allQuestions)}><FileJson className="mr-1 h-4 w-4" /> JSON</Button>
          <Button variant="outline" size="sm" onClick={() => exportHTML(allQuestions)}><FileCode className="mr-1 h-4 w-4" /> HTML</Button>
          <Button variant="ghost" size="sm" onClick={onReset}>New PDF</Button>
        </div>
      </header>

      <div className="border-b bg-muted/30 px-6 py-2">
        <Tabs value={String(active)} onValueChange={(v) => setActive(+v)}>
          <TabsList>
            {results.map((r, i) => (
              <TabsTrigger key={i} value={String(i)}>
                Page {r.page.pageNumber}
                <Badge variant="secondary" className="ml-2">{r.questions.length}</Badge>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>

      <div className="grid flex-1 grid-cols-2 overflow-hidden">
        <ScrollArea className="border-r bg-muted/10">
          <div className="p-4">
            <img src={current.page.dataUrl} alt={`Page ${current.page.pageNumber}`} className="w-full rounded-lg border shadow-sm" />
          </div>
        </ScrollArea>

        <ScrollArea>
          <div ref={rightPanelRef}>
            <div className="space-y-5 p-5">
              {current.error && <Card className="border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">{current.error}</Card>}
              {current.questions.length === 0 && !current.error && (
                <Card className="p-8 text-center text-sm text-muted-foreground">No questions detected on this page.</Card>
              )}
              {current.questions.map((q, i) => (
                <QuestionEditor key={q.id + i} question={q} page={current.page} apiKey={apiKey}
                  onChange={(nq) => updateQuestion(i, nq)} onDelete={() => deleteQuestion(i)} index={i} />
              ))}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function QuestionEditor({ question, page, apiKey, onChange, onDelete, index }: {
  question: Question; page: import("@/lib/pdf").RenderedPage; apiKey: string;
  onChange: (q: Question) => void; onDelete: () => void; index: number;
}) {
  const [editing, setEditing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const handleRegen = async () => {
    setRegenerating(true);
    try {
      const bbox = await regenerateDiagramBbox(apiKey, page.base64, question.question_text);
      const cropped = await cropFromDataUrl(page.dataUrl, bbox, page.width, page.height);
      const img = await removeBackground(cropped);
      onChange({ ...question, diagram_bbox: bbox, diagram_image: img, has_diagram: true });
    } catch (e: any) {
      alert("Re-crop failed: " + e.message);
    } finally { setRegenerating(false); }
  };

  const hasOptionImages = !!question.option_images?.some((x) => !!x);
  const correctIdx = resolveCorrectIndex(question.correct_answer, question.options);

  const setCorrectByIndex = (i: number) => {
    onChange({ ...question, correct_answer: String.fromCharCode(97 + i) });
  };

  return (
    <Card className="overflow-hidden border-border/60 shadow-sm">
      <div className="flex items-center justify-between border-b bg-muted/40 px-4 py-2">
        <div className="flex items-center gap-2">
          <Badge variant="default" className="font-mono">Q{index + 1}</Badge>
          <span className="text-xs text-muted-foreground">{question.id}</span>
          {correctIdx >= 0 && (
            <Badge variant="outline" className="text-xs text-emerald-600 border-emerald-300">
              ✓ {String.fromCharCode(65 + correctIdx)}
            </Badge>
          )}
        </div>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
            {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}><Trash2 className="h-4 w-4 text-destructive" /></Button>
        </div>
      </div>

      <div className="space-y-4 p-4">
        {editing ? (
          <Textarea value={question.question_text} onChange={(e) => onChange({ ...question, question_text: e.target.value })} rows={4} className="font-mono text-xs" />
        ) : (
          <div className="prose prose-sm max-w-none text-[15px] leading-relaxed text-foreground" dangerouslySetInnerHTML={{ __html: question.question_text }} />
        )}

        {question.has_diagram && question.diagram_image && (
          <figure className="rounded-md border p-3" style={{ background: "repeating-conic-gradient(#d4d4d4 0% 25%, #ffffff 0% 50%) 0 0 / 14px 14px" }}>
            <img src={question.diagram_image} alt="Question diagram" className="mx-auto max-h-72 object-contain drop-shadow-sm" />
          </figure>
        )}

        {hasOptionImages ? (
          <div className="grid grid-cols-2 gap-3">
            {question.options.map((opt, i) => {
              const img = question.option_images?.[i];
              const letter = String.fromCharCode(97 + i);
              const isCorrect = i === correctIdx;
              return (
                <button key={i} onClick={() => setCorrectByIndex(i)}
                  className={`group flex flex-col items-center gap-2 rounded-lg border-2 p-3 transition hover:border-primary ${isCorrect ? "border-primary ring-2 ring-primary/20" : "border-border"}`}>
                  <div className="flex w-full items-center justify-between">
                    <Badge variant={isCorrect ? "default" : "outline"} className="font-mono">{String.fromCharCode(65 + i)}</Badge>
                    {isCorrect && <span className="text-[10px] font-semibold uppercase text-primary">Correct</span>}
                  </div>
                  {img ? (
                    <div className="w-full rounded" style={{ background: "repeating-conic-gradient(#d4d4d4 0% 25%, #ffffff 0% 50%) 0 0 / 14px 14px" }}>
                      <img src={img} alt={`Option ${letter}`} className="max-h-40 w-full object-contain drop-shadow-sm" />
                    </div>
                  ) : (
                    <div className="flex h-24 items-center justify-center text-xs text-muted-foreground">no image</div>
                  )}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="space-y-2">
            {question.options.map((opt, i) => {
              const isCorrect = i === correctIdx;
              return (
                <div key={i} className="flex items-start gap-2">
                  <Badge variant={isCorrect ? "default" : "outline"} className="mt-0.5 shrink-0 font-mono">{String.fromCharCode(65 + i)}</Badge>
                  {editing ? (
                    <Input value={opt} onChange={(e) => { const n = [...question.options]; n[i] = e.target.value; onChange({ ...question, options: n }); }} />
                  ) : (
                    <button onClick={() => setCorrectByIndex(i)}
                      className={`flex-1 rounded px-2 py-1 text-left text-sm transition hover:bg-muted ${isCorrect ? "bg-primary/5 font-medium" : ""}`}
                      dangerouslySetInnerHTML={{ __html: opt }} />
                  )}
                </div>
              );
            })}
          </div>
        )}

        {question.has_diagram && (
          <div className="flex justify-end">
            <Button size="sm" variant="ghost" onClick={handleRegen} disabled={regenerating} className="text-xs">
              <RefreshCw className={`mr-1 h-3 w-3 ${regenerating ? "animate-spin" : ""}`} /> Re-crop diagram
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportJSON(questions: Question[]) {
  download("questions.json", JSON.stringify(questions, null, 2), "application/json");
}

function exportHTML(questions: Question[]) {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Question Set</title>
<script>window.MathJax={tex:{inlineMath:[['\\\\(','\\\\)']],displayMath:[['\\\\[','\\\\]']]}};</script>
<script src="https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-mml-chtml.js"></script>
<style>
:root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--primary:#0f766e;--bg:#fff}
*{box-sizing:border-box}body{font-family:ui-sans-serif,system-ui,-apple-system;max-width:820px;margin:2rem auto;padding:0 1.25rem;color:var(--ink);background:#fafafa}
h1{font-size:1.5rem;margin-bottom:1.5rem}
.q{border:1px solid var(--line);border-radius:14px;padding:1.25rem 1.5rem;margin-bottom:1.25rem;background:var(--bg);box-shadow:0 1px 2px rgba(0,0,0,.03)}
.q-head{display:flex;align-items:center;gap:.5rem;margin-bottom:.75rem;color:var(--muted);font-size:.75rem;font-weight:600;letter-spacing:.05em;text-transform:uppercase}
.q-stem{font-size:1rem;line-height:1.6;margin-bottom:1rem}
.diagram{margin:1rem auto;padding:.75rem;background:transparent;border:1px solid var(--line);border-radius:10px;text-align:center;max-width:520px}
.diagram img{max-width:100%;height:auto}
.opts{list-style:none;padding:0;margin:0;display:grid;gap:.5rem}
.opts.visual{grid-template-columns:1fr 1fr}
.opt{display:flex;gap:.6rem;align-items:flex-start;padding:.6rem .75rem;border:1px solid var(--line);border-radius:8px;background:#fff}
.opt.visual{flex-direction:column;align-items:center}
.opt.correct{border-color:var(--primary);background:#f0fdfa}
.opt-label{display:inline-flex;align-items:center;justify-content:center;min-width:1.5rem;height:1.5rem;padding:0 .4rem;border-radius:6px;background:#f1f5f9;font-weight:700;font-size:.75rem;font-family:ui-monospace,monospace}
.opt.correct .opt-label{background:var(--primary);color:#fff}
.opt-img{max-width:100%;max-height:160px;object-fit:contain}
@media print{body{background:#fff}.q{break-inside:avoid;box-shadow:none}}
</style></head><body>
<h1>Question Set</h1>
${questions.map((q, i) => {
  const visual = !!q.option_images?.some(Boolean);
  const correctIdx = resolveCorrectIndex(q.correct_answer, q.options);
  return `<div class="q">
<div class="q-head">Question ${i + 1}</div>
<div class="q-stem">${q.question_text}</div>
${q.has_diagram && q.diagram_image ? `<div class="diagram"><img src="${q.diagram_image}" alt="Diagram"/></div>` : ""}
<ul class="opts ${visual ? "visual" : ""}">${q.options.map((o, j) => {
  const isC = j === correctIdx;
  const label = String.fromCharCode(65 + j);
  const img = q.option_images?.[j];
  return `<li class="opt ${visual ? "visual" : ""} ${isC ? "correct" : ""}"><span class="opt-label">${label}</span>${img ? `<img class="opt-img" src="${img}" alt="Option ${label}"/>` : `<span>${o}</span>`}</li>`;
}).join("")}</ul>
</div>`;
}).join("\n")}
</body></html>`;
  download("questions.html", html, "text/html");
}
