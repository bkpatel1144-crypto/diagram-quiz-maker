import { useMemo, useState } from "react";
import type { PageResult } from "./ProcessingView";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Pencil, Check, RefreshCw, Trash2, Download, FileJson, FileCode } from "lucide-react";
import type { Question } from "@/lib/gemini";
import { regenerateDiagram } from "@/lib/gemini";

interface Props {
  results: PageResult[];
  apiKey: string;
  onUpdate: (results: PageResult[]) => void;
  onReset: () => void;
}

export function ReviewDashboard({ results, apiKey, onUpdate, onReset }: Props) {
  const [active, setActive] = useState(0);
  const current = results[active];

  const updateQuestion = (idx: number, q: Question) => {
    const next = [...results];
    next[active] = {
      ...current,
      questions: current.questions.map((x, i) => (i === idx ? q : x)),
    };
    onUpdate(next);
  };

  const deleteQuestion = (idx: number) => {
    const next = [...results];
    next[active] = {
      ...current,
      questions: current.questions.filter((_, i) => i !== idx),
    };
    onUpdate(next);
  };

  const allQuestions = useMemo(() => results.flatMap((r) => r.questions), [results]);

  return (
    <div className="flex h-screen flex-col">
      <header className="flex items-center justify-between border-b bg-card px-6 py-3">
        <div>
          <h1 className="font-semibold">Review & Edit</h1>
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
          <Button variant="ghost" size="sm" onClick={onReset}>
            New PDF
          </Button>
        </div>
      </header>

      <div className="border-b bg-muted/30 px-6 py-2">
        <Tabs value={String(active)} onValueChange={(v) => setActive(+v)}>
          <TabsList>
            {results.map((r, i) => (
              <TabsTrigger key={i} value={String(i)}>
                Page {r.page.pageNumber}
                <Badge variant="secondary" className="ml-2">
                  {r.questions.length}
                </Badge>
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
          <div className="space-y-4 p-4">
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
                pageBase64={current.page.base64}
                apiKey={apiKey}
                onChange={(nq) => updateQuestion(i, nq)}
                onDelete={() => deleteQuestion(i)}
              />
            ))}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}

function QuestionEditor({
  question,
  pageBase64,
  apiKey,
  onChange,
  onDelete,
}: {
  question: Question;
  pageBase64: string;
  apiKey: string;
  onChange: (q: Question) => void;
  onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [regenerating, setRegenerating] = useState(false);

  const handleRegen = async () => {
    setRegenerating(true);
    try {
      const svg = await regenerateDiagram(apiKey, pageBase64, question.question_text);
      onChange({ ...question, diagram_svg_code: svg, has_diagram: true });
    } catch (e: any) {
      alert("Regenerate failed: " + e.message);
    } finally {
      setRegenerating(false);
    }
  };

  return (
    <Card className="p-4 space-y-3">
      <div className="flex items-start justify-between gap-2">
        <Badge variant="outline">{question.id}</Badge>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" onClick={() => setEditing(!editing)}>
            {editing ? <Check className="h-4 w-4" /> : <Pencil className="h-4 w-4" />}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDelete}>
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {editing ? (
        <Textarea
          value={question.question_text}
          onChange={(e) => onChange({ ...question, question_text: e.target.value })}
          rows={4}
          className="font-mono text-xs"
        />
      ) : (
        <div
          className="prose prose-sm max-w-none text-sm"
          dangerouslySetInnerHTML={{ __html: question.question_text }}
        />
      )}

      <div className="space-y-2">
        {question.options.map((opt, i) => (
          <div key={i} className="flex items-center gap-2">
            <Badge
              variant={opt === question.correct_answer ? "default" : "outline"}
              className="shrink-0"
            >
              {String.fromCharCode(65 + i)}
            </Badge>
            {editing ? (
              <Input
                value={opt}
                onChange={(e) => {
                  const next = [...question.options];
                  next[i] = e.target.value;
                  onChange({ ...question, options: next });
                }}
              />
            ) : (
              <button
                onClick={() => onChange({ ...question, correct_answer: opt })}
                className="flex-1 text-left text-sm hover:text-primary"
                dangerouslySetInnerHTML={{ __html: opt }}
              />
            )}
          </div>
        ))}
      </div>

      {question.has_diagram && (
        <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs uppercase tracking-wide text-muted-foreground">
              Diagram
            </Label>
            <Button size="sm" variant="ghost" onClick={handleRegen} disabled={regenerating}>
              <RefreshCw className={`mr-1 h-3 w-3 ${regenerating ? "animate-spin" : ""}`} />
              Regenerate
            </Button>
          </div>
          <div
            className="mx-auto flex max-w-sm justify-center bg-white p-2 rounded [&_svg]:max-h-64"
            dangerouslySetInnerHTML={{ __html: question.diagram_svg_code }}
          />
          {editing && (
            <Textarea
              value={question.diagram_svg_code}
              onChange={(e) => onChange({ ...question, diagram_svg_code: e.target.value })}
              rows={6}
              className="font-mono text-xs"
            />
          )}
        </div>
      )}
    </Card>
  );
}

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
body{font-family:ui-sans-serif,system-ui;max-width:780px;margin:2rem auto;padding:0 1rem;color:#111}
.q{border:1px solid #e5e7eb;border-radius:12px;padding:1.25rem;margin-bottom:1rem;background:#fff}
.opts{margin:.5rem 0 0;padding-left:1.25rem}
.opts li{margin:.25rem 0}
.opts li.correct{font-weight:600;color:#15803d}
svg{max-width:100%;height:auto}
.diagram{margin-top:.75rem;padding:.75rem;background:#fafafa;border-radius:8px;text-align:center}
@media print{.q{break-inside:avoid}}
</style></head><body>
<h1>Question Set</h1>
${questions
  .map(
    (q, i) => `<div class="q"><strong>Q${i + 1}.</strong> ${q.question_text}
<ol type="A" class="opts">${q.options
      .map(
        (o) =>
          `<li class="${o === q.correct_answer ? "correct" : ""}">${o}</li>`,
      )
      .join("")}</ol>
${q.has_diagram ? `<div class="diagram">${q.diagram_svg_code}</div>` : ""}</div>`,
  )
  .join("\n")}
</body></html>`;
  download("questions.html", html, "text/html");
}
