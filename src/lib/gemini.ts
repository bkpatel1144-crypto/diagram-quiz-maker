export interface Question {
  id: string;
  question_text: string;
  options: string[];
  correct_answer: string;
  has_diagram: boolean;
  /** Bounding box of the diagram in Gemini's normalized 0-1000 coords: [ymin, xmin, ymax, xmax]. */
  diagram_bbox?: [number, number, number, number];
  /** Cropped diagram as PNG/JPEG data URL — filled in client-side after AI returns bbox. */
  diagram_image?: string;
  /** Legacy / optional SVG fallback. */
  diagram_svg_code: string;
}

// Accuracy-first prompt. Diagrams are returned as BOUNDING BOXES so we can crop the
// exact pixels from the source page — no AI redraw, 100% fidelity.
const SYSTEM_PROMPT = `You are a meticulous OCR + physics/maths tutor. From the page image, extract EVERY multiple-choice question with 100% fidelity.

CRITICAL RULES (no exceptions):
1. Copy question stems, numbers, units, subscripts/superscripts EXACTLY as on the page. Do NOT paraphrase.
2. Wrap every mathematical expression, variable, fraction, exponent, vector, Greek letter, or unit-with-symbol in LaTeX delimiters: inline \\( ... \\), display \\[ ... \\]. Examples: \\(V_{BE}\\), \\(\\frac{1}{r_i}\\), \\(E = mc^2\\), \\(3 \\times 10^8 \\, \\text{m/s}\\).
3. Options: extract ALL options shown (2, 3, 4, or more). Strip leading "(a)", "(A)", "1.", "i)" labels — keep ONLY the option content as one string each.
4. correct_answer: if the source marks/asterisks/bolds an answer, set it to the EXACT same string used in options. Otherwise return "".
5. has_diagram: true ONLY if THIS question has a figure, circuit, graph, ray-diagram, geometry, vector, or labelled drawing belonging to its stem.
6. diagram_bbox: when has_diagram is true, return the TIGHT bounding box around the diagram (NOT including the question text or options) in normalized image coordinates [ymin, xmin, ymax, xmax] with values 0–1000. Be precise — this region will be cropped pixel-for-pixel from the source page. Add ~10 units of padding so labels aren't clipped. If has_diagram is false, return null.
7. Skip section headings, instructions, answer keys, and worked solutions.
8. id: sequential "q1","q2",... in reading order.

OUTPUT FORMAT — return ONLY a JSON array (no prose, no fences). If no questions, return [].
Schema per item: {"id": string, "question_text": string, "options": string[], "correct_answer": string, "has_diagram": boolean, "diagram_bbox": [number,number,number,number] | null}`;

interface CallOptions {
  model?: string;
  thinking?: boolean;
}

async function geminiRequest(
  apiKey: string,
  imageBase64: string,
  prompt: string,
  opts: CallOptions = {},
): Promise<string> {
  const model = opts.model ?? "gemini-2.5-pro";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const body: any = {
    contents: [
      {
        role: "user",
        parts: [
          { text: prompt },
          { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0.05,
      topP: 0.9,
      maxOutputTokens: 32768,
      responseMimeType: "application/json",
    },
  };
  if (!opts.thinking) {
    body.generationConfig.thinkingConfig = { thinkingBudget: 0 };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 400)}`);
  }
  const data = await res.json();
  const finish = data?.candidates?.[0]?.finishReason;
  const text: string =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
  if (!text) throw new Error(`Empty response (finishReason: ${finish ?? "unknown"})`);
  return text;
}

function extractJsonArray(raw: string): any[] {
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  const start = s.indexOf("[");
  if (start === -1) {
    if (s.startsWith("{")) s = "[" + s + "]";
    else throw new Error("No JSON array found");
  } else {
    s = s.slice(start);
  }
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

function normalizeBbox(b: any): [number, number, number, number] | undefined {
  if (!Array.isArray(b) || b.length !== 4) return undefined;
  const [a, c, d, e] = b.map((n) => Number(n));
  if ([a, c, d, e].some((n) => !Number.isFinite(n))) return undefined;
  return [a, c, d, e];
}

function normalize(parsed: any[]): Question[] {
  return parsed.map((q: any, i: number) => ({
    id: typeof q?.id === "string" && q.id ? q.id : `q${i + 1}`,
    question_text: String(q?.question_text ?? "").trim(),
    options: Array.isArray(q?.options) ? q.options.map((o: any) => String(o ?? "")) : [],
    correct_answer: String(q?.correct_answer ?? ""),
    has_diagram: !!q?.has_diagram,
    diagram_bbox: normalizeBbox(q?.diagram_bbox),
    diagram_svg_code: String(q?.diagram_svg_code ?? ""),
  }));
}

export async function callGemini(
  apiKey: string,
  imageBase64: string,
  model = "gemini-2.5-pro",
): Promise<Question[]> {
  const raw = await geminiRequest(apiKey, imageBase64, SYSTEM_PROMPT, { model, thinking: true });
  return normalize(extractJsonArray(raw));
}

const BBOX_ONLY_PROMPT = (questionText: string) => `Look at the page image. Find this specific question:
"""
${questionText.replace(/<[^>]+>/g, " ").replace(/\\[()[\]]/g, "").slice(0, 500)}
"""

Return the TIGHT bounding box around its diagram (figure/circuit/graph/ray-diagram only — exclude the question text and the options) in normalized image coordinates [ymin, xmin, ymax, xmax] with values 0–1000. Add ~10 units of padding so labels aren't clipped.

Return ONLY JSON in this exact form: {"diagram_bbox":[ymin,xmin,ymax,xmax]}`;

export async function regenerateDiagramBbox(
  apiKey: string,
  imageBase64: string,
  questionText: string,
  model = "gemini-2.5-pro",
): Promise<[number, number, number, number]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [
        { text: BBOX_ONLY_PROMPT(questionText) },
        { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
      ]}],
      generationConfig: { temperature: 0.05, maxOutputTokens: 256, responseMimeType: "application/json", thinkingConfig: { thinkingBudget: 0 } },
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
