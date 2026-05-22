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
1. Copy question stems, numbers, units, subscripts, superscripts EXACTLY. NEVER paraphrase, NEVER summarize.
2. Wrap EVERY mathematical symbol, variable, fraction, exponent, vector, Greek letter, or unit expression in LaTeX: inline \\( ... \\), display \\[ ... \\]. Examples: \\(V_{BE}\\), \\(\\frac{1}{r_i}\\), \\(3 \\times 10^8\\,\\text{m/s}\\).
3. Strip leading labels "(a)", "(A)", "1.", "i)" from options — keep only the option content as one string.
4. correct_answer: exact string from options if the source marks one; else "".
5. id: "q1","q2",... in reading order.
6. Skip headings, instructions, answer keys, worked solutions.

DIAGRAM HANDLING — read carefully:

CASE A — Text options (a/b/c/d are words/numbers/formulas):
  - If the QUESTION has a figure (circuit/graph/ray/geometry) above or beside the stem, set has_diagram=true and return diagram_bbox as a TIGHT box around ONLY the figure. DO NOT include the question text, the number "Q.2", or the options inside the box. Add ~8 units padding. Coordinates are normalized 0–1000 as [ymin, xmin, ymax, xmax].
  - options = the text strings. option_bboxes = null (omit).

CASE B — Visual options (a/b/c/d are themselves diagrams/circuits/graphs/figures):
  - This is critical: when each option is a picture, DO NOT lump them into diagram_bbox.
  - Set has_diagram=false, diagram_bbox=null.
  - options = ["(a)","(b)","(c)","(d)"] placeholder labels (one per option in order).
  - option_bboxes = array of TIGHT bboxes, one per option, each around ONLY that option's figure (exclude the "(a)"/"(b)" label and exclude neighboring options). Same length & order as options.

CASE C — Mixed (question has its OWN figure AND options are figures): use diagram_bbox for the stem's figure AND option_bboxes for the option figures.

OUTPUT — return ONLY a JSON array (no prose, no fences). Schema:
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

function normalize(parsed: any[]): Question[] {
  return parsed.map((q: any, i: number) => {
    const options = Array.isArray(q?.options) ? q.options.map((o: any) => String(o ?? "")) : [];
    const obbRaw = Array.isArray(q?.option_bboxes) ? q.option_bboxes : null;
    const option_bboxes = obbRaw ? obbRaw.map((b: any) => normalizeBbox(b) ?? null) : undefined;
    return {
      id: typeof q?.id === "string" && q.id ? q.id : `q${i + 1}`,
      question_text: String(q?.question_text ?? "").trim(),
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
