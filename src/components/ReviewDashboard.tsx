import { useEffect, useMemo, useRef, useState } from "react";
import type { PageResult } from "./ProcessingView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Pencil, Check, RefreshCw, Trash2, FileJson, FileCode, Crop, CheckCircle2,
} from "lucide-react";
import type { Question, Bbox } from "@/lib/gemini";
import { regenerateDiagramBbox } from "@/lib/gemini";
import { cropFromDataUrl, removeBackground } from "@/lib/pdf-utils";
import { DiagramCropEditor, type CropTarget } from "@/components/DiagramCropEditor";

function sanitizeDisplay(raw: string): string {
  return raw
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/\\\[([^]*?)\\\]/g, "\\($1\\)")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[ \u00a0]{2,}/g, " ")
    .trim();
}

const CHECKER_BG = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='8' height='8' fill='%23d0d0d0'/%3E%3Crect x='8' y='8' width='8' height='8' fill='%23d0d0d0'/%3E%3C/svg%3E") #fff`;

interface Props {
  results: PageResult[];
  apiKey: string;
  onUpdate: (results: PageResult[]) => void;
  onReset: () => void;
}

function resolveCorrectIndex(correctAnswer: string, options: string[]): number {
  if (!correctAnswer) return -1;
  const ca = correctAnswer.trim().toLowerCase().replace(/[().\s]/g, "");
  if (/^[a-d]$/.test(ca)) return ca.charCodeAt(0) - 97;
  if (/^\d$/.test(ca)) {
    const n = parseInt(ca, 10);
    if (n >= 0 && n < options.length) return n;
  }
  const strip = (s: string) => s.replace(/<[^>]+>/g, "").toLowerCase().trim();
  return options.findIndex((o) => strip(o) === strip(correctAnswer));
}

export function ReviewDashboard({ results, apiKey, onUpdate, onReset }: Props) {
  const [active, setActive] = useState(0);
  const current = results[active];
  const rightPanelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if ((window as any).MathJax) return;
    (window as any).MathJax = {
      tex: { inlineMath: [["\\(", "\\)"]], displayMath: [] },
      chtml: { scale: 1, mathmlSpacing: false },
      options: { skipHtmlTags: ["script", "noscript", "style", "textarea", "pre"] },
    };
    const s = document.createElement("script");
    s.src = "https://cdn.jsdelivr.net/npm/mathjax@3/es5/tex-chtml.js";
    s.async = true;
    document.head.appendChild(s);
  }, []);

  useEffect(() => {
    const mj = (window as any).MathJax;
    if (mj?.typesetPromise && rightPanelRef.current)
      mj.typesetPromise([rightPanelRef.current]).catch(() => {});
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
          <p className="text-xs text-muted-foreground">
            {allQuestions.length} questions across {results.length} pages
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => exportJSON(allQuestions)}>
            <FileJson className="mr-1 h-4 w-4" /> JSON
          </Button>
          <Button variant="outline" size="sm" onClick={() => exportHTML(allQuestions)}>
            <FileCode className="mr-1 h-4 w-4" /> HTML
          </Button>
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
            <img
              src={current.page.dataUrl}
              alt={`Page ${current.page.pageNumber}`}
              className="w-full rounded-lg border shadow-sm"
            />
          </div>
        </ScrollArea>
        <ScrollArea>
          <div ref={rightPanelRef}>
            <div className="space-y-5 p-5">
              {current.error && (
                <Card className="border-destructive/50 bg-destructive/5 p-4 text-sm text-destructive">
                  {current.error}
                </Card>
              )}
              {current.questions.length === 0 && !current.error && (
                <Card className="p-8 text-center text-sm text-muted-foreground">
                  No questions detected on this page.
                </Card>
              )}
              {current.questions.map((q, i) => (
                <QuestionEditor
                  key={q.id + i}
                  question={q}
                  page={current.page}
                  apiKey={apiKey}
                  onChange={(nq) => updateQuestion(i, nq)}
                  onDelete={() => deleteQuestion(i)}
                  index={i}
                />
              ))}
            </div>
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

/* ───────────────────────────── QuestionEditor ───────────────────── */

function QuestionEditor({
  question, page, apiKey, onChange, onDelete, index,
}: {
  question: Question;
  page: import("@/lib/pdf").RenderedPage;
  apiKey: string;
  onChange: (q: Question) => void;
  onDelete: () => void;
  index: number;
}) {
  const [editing, setEditing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [cropState, setCropState] = useState<{
    target: CropTarget;
    initialBbox?: Bbox;
  } | null>(null);

  const correctIdx = resolveCorrectIndex(question.correct_answer, question.options);
  const hasOptionImages = !!question.option_images?.some(Boolean);

  const setCorrectByIndex = (i: number) =>
    onChange({ ...question, correct_answer: String.fromCharCode(97 + i) });

  /* AI re-crop for main diagram */
  const handleAiRegen = async () => {
    setRegenerating(true);
    try {
      const bbox = await regenerateDiagramBbox(apiKey, page.base64, question.question_text);
      const cropped = await cropFromDataUrl(page.dataUrl, bbox, page.width, page.height);
      const img = await removeBackground(cropped);
      onChange({ ...question, diagram_bbox: bbox, diagram_image: img, has_diagram: true });
    } catch (e: any) {
      alert("AI re-crop failed: " + e.message);
    } finally {
      setRegenerating(false);
    }
  };

  /* Apply result from crop editor */
  const handleCropApply = (dataUrl: string, bbox: Bbox) => {
    if (!cropState) return;
    if (cropState.target.type === "diagram") {
      onChange({ ...question, diagram_bbox: bbox, diagram_image: dataUrl, has_diagram: true });
    } else {
      const imgs = [...(question.option_images ?? question.options.map(() => null))];
      imgs[cropState.target.optionIndex!] = dataUrl;
      onChange({ ...question, option_images: imgs });
    }
    setCropState(null);
  };

  return (
    <>
      <Card className="overflow-hidden border-border/60 shadow-sm">
        {/* ── Card header ── */}
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
            <Button size="sm" variant="ghost" onClick={() => setEditing((v) => !v)}>
              {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDelete}>
              <Trash2 className="h-4 w-4 text-destructive" />
            </Button>
          </div>
        </div>

        <div className="space-y-4 p-4">
          {/* Question stem */}
          {editing ? (
            <Textarea
              value={question.question_text}
              onChange={(e) => onChange({ ...question, question_text: e.target.value })}
              rows={4}
              className="font-mono text-xs"
            />
          ) : (
            <div
              className="prose prose-sm max-w-none text-[15px] leading-relaxed text-foreground"
              dangerouslySetInnerHTML={{ __html: sanitizeDisplay(question.question_text) }}
            />
          )}

          {/* Main question diagram */}
          {question.has_diagram && question.diagram_image && (
            <figure className="rounded-md border p-3" style={{ background: CHECKER_BG }}>
              <img
                src={question.diagram_image}
                alt="Question diagram"
                className="mx-auto max-h-72 object-contain"
              />
              {/* Crop button shown only in edit mode */}
              {editing && (
                <div className="mt-2 flex justify-center">
                  <Button
                    size="sm"
                    variant="outline"
                    className="gap-1.5 text-xs"
                    onClick={() =>
                      setCropState({
                        target: { type: "diagram", label: `Q${index + 1} — main diagram` },
                        initialBbox: question.diagram_bbox as Bbox | undefined,
                      })
                    }
                  >
                    <Crop className="h-3 w-3" /> Crop diagram
                  </Button>
                </div>
              )}
            </figure>
          )}

          {/* Option images */}
          {hasOptionImages ? (
            <div className="grid grid-cols-2 gap-3">
              {question.options.map((_, i) => {
                const img = question.option_images?.[i];
                const isCorrect = i === correctIdx;
                const letter = String.fromCharCode(65 + i);

                return (
                  /* plain div — no accidental correct-answer toggle on image click */
                  <div
                    key={i}
                    className={`flex flex-col gap-2 rounded-lg border-2 p-3 transition-colors ${
                      isCorrect ? "border-primary bg-primary/5" : "border-border"
                    }`}
                  >
                    {/* Option header row */}
                    <div className="flex items-center justify-between">
                      <Badge
                        variant={isCorrect ? "default" : "outline"}
                        className="font-mono"
                      >
                        {letter}
                      </Badge>

                      <div className="flex items-center gap-1">
                        {/* Mark correct button */}
                        <button
                          title={isCorrect ? "Marked correct" : "Mark as correct"}
                          onClick={() => setCorrectByIndex(i)}
                          className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold transition ${
                            isCorrect
                              ? "bg-primary text-primary-foreground"
                              : "bg-muted text-muted-foreground hover:bg-muted/80 hover:text-foreground"
                          }`}
                        >
                          <CheckCircle2 className="h-3 w-3" />
                          {isCorrect ? "Correct" : "Mark correct"}
                        </button>

                        {/* Crop button — always visible in edit mode, hover-only otherwise */}
                        {img ? (
                          editing ? (
                            <button
                              title="Crop this option"
                              onClick={() =>
                                setCropState({
                                  target: {
                                    type: "option",
                                    optionIndex: i,
                                    label: `Q${index + 1} — Option ${letter}`,
                                  },
                                })
                              }
                              className="flex items-center gap-1 rounded bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground transition hover:bg-muted/80 hover:text-foreground"
                            >
                              <Crop className="h-3 w-3" /> Crop
                            </button>
                          ) : null
                        ) : null}
                      </div>
                    </div>

                    {/* Image area */}
                    {img ? (
                      <div className="w-full rounded p-1" style={{ background: CHECKER_BG }}>
                        <img
                          src={img}
                          alt={`Option ${letter}`}
                          className="max-h-44 w-full object-contain"
                        />
                      </div>
                    ) : (
                      <div className="flex h-24 flex-col items-center justify-center gap-2 rounded border border-dashed border-border text-xs text-muted-foreground">
                        <span>no image</span>
                        <button
                          onClick={() =>
                            setCropState({
                              target: {
                                type: "option",
                                optionIndex: i,
                                label: `Q${index + 1} — Option ${letter}`,
                              },
                            })
                          }
                          className="flex items-center gap-1 rounded px-2 py-1 text-xs font-medium text-primary hover:underline"
                        >
                          <Crop className="h-3 w-3" /> Crop from page
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            /* Text options */
            <div className="space-y-2">
              {question.options.map((opt, i) => {
                const isCorrect = i === correctIdx;
                return (
                  <div key={i} className="flex items-start gap-2">
                    <Badge
                      variant={isCorrect ? "default" : "outline"}
                      className="mt-0.5 shrink-0 font-mono"
                    >
                      {String.fromCharCode(65 + i)}
                    </Badge>
                    {editing ? (
                      <Input
                        value={opt}
                        onChange={(e) => {
                          const n = [...question.options];
                          n[i] = e.target.value;
                          onChange({ ...question, options: n });
                        }}
                      />
                    ) : (
                      <button
                        onClick={() => setCorrectByIndex(i)}
                        className={`flex-1 rounded px-2 py-1 text-left text-sm transition hover:bg-muted ${
                          isCorrect ? "bg-primary/5 font-medium" : ""
                        }`}
                        dangerouslySetInnerHTML={{ __html: sanitizeDisplay(opt) }}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Diagram toolbar — only in edit mode */}
          {editing && question.has_diagram && (
            <div className="flex items-center justify-end gap-2 border-t pt-2">
              {!question.diagram_image && (
                <Button
                  size="sm"
                  variant="outline"
                  className="gap-1.5 text-xs"
                  onClick={() =>
                    setCropState({
                      target: { type: "diagram", label: `Q${index + 1} — main diagram` },
                      initialBbox: question.diagram_bbox as Bbox | undefined,
                    })
                  }
                >
                  <Crop className="h-3 w-3" /> Crop diagram
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                onClick={handleAiRegen}
                disabled={regenerating}
                className="gap-1.5 text-xs"
              >
                <RefreshCw className={`h-3 w-3 ${regenerating ? "animate-spin" : ""}`} />
                AI re-crop
              </Button>
            </div>
          )}
        </div>
      </Card>

      {/* Crop editor modal */}
      {cropState && (
        <DiagramCropEditor
          pageDataUrl={page.dataUrl}
          pageWidth={page.width}
          pageHeight={page.height}
          initialBbox={cropState.initialBbox}
          target={cropState.target}
          onApply={handleCropApply}
          onClose={() => setCropState(null)}
        />
      )}
    </>
  );
}

/* ───────────────────────────── Export helpers ───────────────────── */

function download(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
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
