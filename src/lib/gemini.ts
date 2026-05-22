export type Bbox = [number, number, number, number]; // [ymin, xmin, ymax, xmax] in 0-1000

export interface Question {
  id: string;
  question_text: string;
  options: string[];
  /** Per-option bounding boxes — populated ONLY when options are figures (circuits/graphs/diagrams). Same length as options. */
  option_bboxes?: (Bbox | null)[];
  /** Per-option cropped images (PNG data URLs) — filled client-side after AI returns bboxes. */
  option_images?: (string | null)[];
  correct_answer: string;
  has_diagram: boolean;
  /** Bbox of the QUESTION's own diagram (NOT the options). [ymin, xmin, ymax, xmax] in 0-1000. */
  diagram_bbox?: Bbox;
  /** Cropped diagram image. */
  diagram_image?: string;
  /** Legacy SVG fallback. */
  diagram_svg_code?: string;
}

const SYSTEM_PROMPT = `You are a meticulous OCR engine for physics/maths MCQ books. Extract EVERY multiple-choice question from the page image with 100% fidelity.

STRICT RULES:
1. Copy question stems EXACTLY as one continuous string — NO line breaks, NO splitting on sub-expressions. Merge the full sentence into a single flowing line.
2. Wrap EVERY mathematical symbol, variable, fraction, exponent, vector, Greek letter, or unit in LaTeX: inline \\( ... \\). Examples: \\(R_T\\), \\(G_1\\), \\(V_{BE}\\), \\(3 \\times 10^8\\,\\text{m/s}\\).
3. Strip leading labels "(a)", "(A)", "1.", "i)" from options — keep only the option content.
4. correct_answer: use lowercase letter "a"/"b"/"c"/"d" matching the correct option index (0-based: a=first, b=second…). If not marked, use "".
5. id: "q1","q2",... in reading order.
6. Skip headings, instructions, answer keys, worked solutions.

BOUNDING BOX RULES — read very carefully:
- Coordinates are 0–1000 normalized [ymin, xmin, ymax, xmax] relative to the full page image.
- A bbox must fully enclose the diagram including ALL lines, labels, arrows, axes, and component symbols. Never clip any part.
- Measure to the OUTERMOST visible element of the diagram, then add exactly 6 units on every side.
- DO NOT include question text, question number, or option labels inside the bbox.
- Each option bbox must contain ONLY that option's figure — not neighbouring figures and not the question text above.

CASE A — Text options (a/b/c/d are words/numbers/formulas):
  - If the question has its own figure, set has_diagram=true and diagram_bbox = tight box around ONLY that figure.
  - options = the text strings. option_bboxes omitted.

CASE B — Visual options (a/b/c/d are themselves diagrams/circuits/graphs):
  - CRITICAL: scan the FULL vertical and horizontal extent of each option figure before setting its bbox.
  - Set has_diagram=false, diagram_bbox=null.
  - options = ["(a)","(b)","(c)","(d)"] (placeholder labels, one per option).
  - option_bboxes = array of TIGHT bboxes, one per option. Each bbox must wrap the COMPLETE circuit/graph for that option from top-most element to bottom-most element. Include every wire, component, and label that belongs to that option.

CASE C — Mixed (question has its own figure AND options are figures): use diagram_bbox for the stem figure AND option_bboxes for each option figure.

OUTPUT — return ONLY a JSON array (no prose, no markdown fences). Schema:
{"id":string,"question_text":string,"options":string[],"option_bboxes":([number,number,number,number]|null)[]|null,"correct_answer":string,"has_diagram":boolean,"diagram_bbox":[number,number,number,number]|null}`;

async function geminiRequest(apiKey: string, imageBase64: string, prompt: string, model = "gemini-2.5-pro"): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: prompt },
        { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
      ]}],
      generationConfig: {
        temperature: 0.05,
        topP: 0.9,
        maxOutputTokens: 32768,
        responseMimeType: "application/json",
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${(await res.text()).slice(0, 400)}`);
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
  if (!text) throw new Error(`Empty response (finishReason: ${data?.candidates?.[0]?.finishReason ?? "unknown"})`);
  return text;
}

function extractJsonArray(raw: string): any[] {
  let s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = s.indexOf("[");
  if (start === -1) { if (s.startsWith("{")) s = "[" + s + "]"; else throw new Error("No JSON array found"); }
  else s = s.slice(start);
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : [v]; } catch {}
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/,(\s*[}\]])/g, "$1");
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : [v]; } catch {}
  const objects: string[] = [];
  let depth = 0, inStr = false, esc = false, buf = "", started = false;
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (esc) { buf += c; esc = false; continue; }
    if (c === "\\") { buf += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; buf += c; continue; }
    if (inStr) { buf += c; continue; }
    if (c === "{") { if (depth === 0) { buf = ""; started = true; } depth++; buf += c; continue; }
    if (c === "}") { depth--; buf += c; if (depth === 0 && started) { objects.push(buf); buf = ""; started = false; } continue; }
    if (started) buf += c;
  }
  if (objects.length === 0) throw new Error("Could not recover any JSON objects");
  return JSON.parse("[" + objects.join(",") + "]");
}

function normalizeBbox(b: any): Bbox | undefined {
  if (!Array.isArray(b) || b.length !== 4) return undefined;
  const n = b.map((x) => Number(x));
  if (n.some((v) => !Number.isFinite(v))) return undefined;
  return [n[0], n[1], n[2], n[3]];
}

/** Clean question text: collapse newlines into spaces, trim runs of whitespace */
function cleanText(raw: string): string {
  return raw
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

function normalize(parsed: any[]): Question[] {
  return parsed.map((q: any, i: number) => {
    const options = Array.isArray(q?.options) ? q.options.map((o: any) => cleanText(String(o ?? ""))) : [];
    const obbRaw = Array.isArray(q?.option_bboxes) ? q.option_bboxes : null;
    const option_bboxes = obbRaw ? obbRaw.map((b: any) => normalizeBbox(b) ?? null) : undefined;
    return {
      id: typeof q?.id === "string" && q.id ? q.id : `q${i + 1}`,
      question_text: cleanText(String(q?.question_text ?? "")),
      options,
      option_bboxes,
      correct_answer: String(q?.correct_answer ?? ""),
      has_diagram: !!q?.has_diagram,
      diagram_bbox: normalizeBbox(q?.diagram_bbox),
    };
  });
}

export async function callGemini(apiKey: string, imageBase64: string, model = "gemini-2.5-pro"): Promise<Question[]> {
  return normalize(extractJsonArray(await geminiRequest(apiKey, imageBase64, SYSTEM_PROMPT, model)));
}

const BBOX_ONLY_PROMPT = (q: string) => `Find this question on the page:
"""${q.replace(/<[^>]+>/g, " ").replace(/\\[()[\]]/g, "").slice(0, 500)}"""

Return a TIGHT bbox around ONLY its diagram (exclude question text, number, options). 0–1000 normalized [ymin,xmin,ymax,xmax]. JSON ONLY: {"diagram_bbox":[ymin,xmin,ymax,xmax]}`;

export async function regenerateDiagramBbox(apiKey: string, imageBase64: string, questionText: string, model = "gemini-2.5-pro"): Promise<Bbox> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: BBOX_ONLY_PROMPT(questionText) },
        { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
      ]}],
      generationConfig: { temperature: 0.05, maxOutputTokens: 512, responseMimeType: "application/json" },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text: string = data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
  const parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim());
  const bbox = normalizeBbox(parsed?.diagram_bbox);
  if (!bbox) throw new Error("AI did not return a valid bounding box");
  return bbox;
}
