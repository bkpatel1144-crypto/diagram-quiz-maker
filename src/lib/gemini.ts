export interface Question {
  id: string;
  question_text: string;
  options: string[];
  correct_answer: string;
  has_diagram: boolean;
  diagram_svg_code: string;
}

// Accuracy-first prompt. We force a strict schema and explicit rules.
const SYSTEM_PROMPT = `You are a meticulous OCR + physics/maths tutor. From the page image, extract EVERY multiple-choice question with 100% fidelity.

CRITICAL RULES (no exceptions):
1. Copy question stems, numbers, units, subscripts/superscripts EXACTLY as on the page. Do NOT paraphrase.
2. Wrap every mathematical expression, variable, fraction, exponent, vector, Greek letter, or unit-with-symbol in LaTeX delimiters: inline \\( ... \\), display \\[ ... \\]. Examples: \\(V_{BE}\\), \\(\\frac{1}{r_i}\\), \\(E = mc^2\\), \\(3 \\times 10^8 \\, \\text{m/s}\\).
3. Options: extract ALL options shown (could be 2, 3, 4, or more). Strip the leading "(a)", "(A)", "1.", "i)" labels — keep ONLY the option content. Each option is one string.
4. correct_answer: if the source marks/asterisks/bolds an answer, set it to the EXACT same string used in options. Otherwise return "".
5. has_diagram: true ONLY if THIS question has a figure, circuit, graph, ray-diagram, geometry, vector arrow, or labelled drawing belonging to its stem (not a generic page header).
6. diagram_svg_code: when has_diagram is true, produce a faithful, clean, self-contained SVG that reproduces the diagram with correct topology and labels.
   - Use <svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg"> ... </svg>
   - Reproduce: resistors as zigzags, cells/batteries as long+short lines, capacitors as parallel plates, inductors as humps, ammeters/voltmeters as circles with A/V, switches, arrows for vectors/currents, axes with tick labels for graphs, angle arcs with degree labels, dashed normals for ray optics.
   - Include ALL text labels exactly as in source (R₁, V, +, −, θ, etc.). Use <text> elements.
   - stroke="#000" stroke-width="1.5" fill="none" by default; use fill="#000" for arrowheads/text.
   - If a diagram is too complex to reproduce confidently, still attempt it but keep topology accurate over decoration.
7. Skip section headings, instructions, answer keys, and worked solutions. Extract questions ONLY.
8. id: sequential "q1","q2",... in reading order.

OUTPUT FORMAT — return ONLY a JSON array (no prose, no \`\`\` fences, no trailing text). If no questions on this page, return [].
Schema per item: {"id": string, "question_text": string, "options": string[], "correct_answer": string, "has_diagram": boolean, "diagram_svg_code": string}`;

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
  if (!text) {
    throw new Error(`Empty response (finishReason: ${finish ?? "unknown"})`);
  }
  return text;
}

/**
 * Robust JSON extraction: strips fences, finds outer array/object,
 * fixes trailing commas / control chars, attempts to close a truncated array.
 */
function extractJsonArray(raw: string): any[] {
  let s = raw.trim();
  // Strip code fences
  s = s.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  // Find the outermost array
  const start = s.indexOf("[");
  if (start === -1) {
    // Maybe the model returned a single object — wrap it.
    if (s.startsWith("{")) s = "[" + s + "]";
    else throw new Error("No JSON array found");
  } else {
    s = s.slice(start);
  }
  // Try direct parse
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [v];
  } catch {}
  // Clean control characters (except \n\r\t inside strings will still be fine after this is escaped — but JSON disallows raw control chars)
  s = s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "");
  // Remove trailing commas
  s = s.replace(/,(\s*[}\]])/g, "$1");
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [v];
  } catch {}
  // Attempt to recover from truncation: keep complete top-level objects only
  const objects: string[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let buf = "";
  let started = false;
  for (let i = 1; i < s.length; i++) {
    const c = s[i];
    if (esc) {
      buf += c;
      esc = false;
      continue;
    }
    if (c === "\\") {
      buf += c;
      esc = true;
      continue;
    }
    if (c === '"') {
      inStr = !inStr;
      buf += c;
      continue;
    }
    if (inStr) {
      buf += c;
      continue;
    }
    if (c === "{") {
      if (depth === 0) {
        buf = "";
        started = true;
      }
      depth++;
      buf += c;
      continue;
    }
    if (c === "}") {
      depth--;
      buf += c;
      if (depth === 0 && started) {
        objects.push(buf);
        buf = "";
        started = false;
      }
      continue;
    }
    if (started) buf += c;
  }
  if (objects.length === 0) throw new Error("Could not recover any JSON objects");
  const recovered = "[" + objects.join(",") + "]";
  return JSON.parse(recovered);
}

function normalize(parsed: any[]): Question[] {
  return parsed.map((q: any, i: number) => ({
    id: typeof q?.id === "string" && q.id ? q.id : `q${i + 1}`,
    question_text: String(q?.question_text ?? "").trim(),
    options: Array.isArray(q?.options) ? q.options.map((o: any) => String(o ?? "")) : [],
    correct_answer: String(q?.correct_answer ?? ""),
    has_diagram: !!q?.has_diagram,
    diagram_svg_code: String(q?.diagram_svg_code ?? ""),
  }));
}

export async function callGemini(
  apiKey: string,
  imageBase64: string,
  model = "gemini-2.5-pro",
): Promise<Question[]> {
  const raw = await geminiRequest(apiKey, imageBase64, SYSTEM_PROMPT, {
    model,
    thinking: true, // enable reasoning for max accuracy
  });
  const arr = extractJsonArray(raw);
  return normalize(arr);
}

const DIAGRAM_PROMPT = (questionText: string) => `Look at the page image. Find this specific question:
"""
${questionText.replace(/<[^>]+>/g, " ").replace(/\\[()[\]]/g, "").slice(0, 500)}
"""

Reproduce its diagram as ONE clean, accurate, self-contained SVG.
Requirements:
- <svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg"> ... </svg>
- Topology must match the source EXACTLY (which components connect to which nodes, direction of arrows, position of labels).
- Use standard symbols: resistor zigzag, battery long+short lines, capacitor parallel plates, inductor humps, ammeter/voltmeter circle with A/V, switch with break, ground triangle, lens biconvex/concave shape, mirror with hashed back, ray arrows.
- Include ALL labels from source verbatim (R₁, 5Ω, V, θ=30°, etc.) using <text>.
- stroke="#000" stroke-width="1.5" fill="none"; fill="#000" for arrowheads and <text>.

Return ONLY the SVG markup. No commentary, no fences, no JSON.`;

export async function regenerateDiagram(
  apiKey: string,
  imageBase64: string,
  questionText: string,
  model = "gemini-2.5-pro",
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: DIAGRAM_PROMPT(questionText) },
            { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 8192,
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json();
  const text: string =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).filter(Boolean).join("") ?? "";
  const match = text.match(/<svg[\s\S]*?<\/svg>/i);
  return match ? match[0] : text.trim();
}
