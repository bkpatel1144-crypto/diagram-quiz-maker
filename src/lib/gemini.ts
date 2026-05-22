export interface Question {
  id: string;
  question_text: string;
  options: string[];
  correct_answer: string;
  has_diagram: boolean;
  diagram_svg_code: string;
}

const SYSTEM_PROMPT = `You are an expert at extracting physics and mathematics multiple-choice questions from textbook page images.

Analyze the provided page image and extract EVERY multiple-choice question you find. For each question, return a JSON object with these exact fields:
- id: string like "q1", "q2", ...
- question_text: HTML string. Wrap LaTeX math in \\( \\) for inline or \\[ \\] for display. Preserve subscripts/superscripts.
- options: array of 4 strings (the choice text only, no "A)" prefix). If fewer/more options exist, use the actual count.
- correct_answer: the string of the correct option exactly as it appears in options (if not indicated, return "").
- has_diagram: true if the question has any circuit, graph, geometric figure, or physics diagram.
- diagram_svg_code: if has_diagram is true, produce a clean, accurate, self-contained <svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg"> ... </svg> reproducing the diagram (resistors, wires, axes, vectors, angles, labels). Use stroke="currentColor" or black, fill="none" where appropriate. If no diagram, return "".

Output STRICTLY a JSON array of these objects with no markdown fences, no commentary. If no questions exist, return [].`;

export async function callGemini(
  apiKey: string,
  imageBase64: string,
  model = "gemini-2.5-flash",
): Promise<Question[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: SYSTEM_PROMPT },
            { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.2,
        responseMimeType: "application/json",
        thinkingConfig: { thinkingBudget: 0 },
      },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = await res.json();
  const text: string =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "[]";
  const cleaned = text.replace(/^```json\s*|\s*```$/g, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((q: any, i: number) => ({
      id: q.id || `q${i + 1}`,
      question_text: q.question_text || "",
      options: Array.isArray(q.options) ? q.options : [],
      correct_answer: q.correct_answer || "",
      has_diagram: !!q.has_diagram,
      diagram_svg_code: q.diagram_svg_code || "",
    })) as Question[];
  } catch (e) {
    throw new Error("Failed to parse AI JSON response. Raw: " + cleaned.slice(0, 200));
  }
}

export async function regenerateDiagram(
  apiKey: string,
  imageBase64: string,
  questionText: string,
  model = "gemini-2.5-flash",
): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const prompt = `Look at the page image and find this question: "${questionText.replace(/<[^>]+>/g, " ").slice(0, 300)}".
Produce ONLY a single clean, accurate self-contained <svg viewBox="0 0 400 300" xmlns="http://www.w3.org/2000/svg">...</svg> of its diagram. No commentary, no code fences.`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            { inline_data: { mime_type: "image/jpeg", data: imageBase64 } },
          ],
        },
      ],
      generationConfig: { temperature: 0.3 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini error ${res.status}`);
  const data = await res.json();
  const text: string =
    data?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join("") ?? "";
  const match = text.match(/<svg[\s\S]*<\/svg>/);
  return match ? match[0] : text.trim();
}
