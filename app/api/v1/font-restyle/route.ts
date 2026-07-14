import { createStandaloneImages, jsonCors, optionsResponse, requireVideoToken } from "../_lib/visual-api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Style-matched lettering replacement:
// takes one reference image that contains designed lettering/typography and a
// `new_text` string, then re-renders the same type design with the new text.
export async function POST(request: Request) {
  const authError = requireVideoToken(request);
  if (authError) return authError;

  let payload: Record<string, unknown>;
  try {
    payload = (await request.json()) as Record<string, unknown>;
  } catch {
    return jsonCors({ detail: "invalid JSON body" }, { status: 400 });
  }

  const lineEdits = (Array.isArray(payload.line_edits) ? payload.line_edits : [])
    .map((item) => {
      const record = item as { from?: unknown; to?: unknown };
      return { from: String(record.from || "").trim(), to: String(record.to || "").trim() };
    })
    .filter((item) => item.from && item.to && item.from !== item.to);
  const newText = String(payload.new_text || payload.text || "").trim() || lineEdits.map((item) => item.to).join(" / ");
  if (!newText && !lineEdits.length) return jsonCors({ detail: "new_text or line_edits is required" }, { status: 400 });
  const hasReference =
    Boolean(payload.image_b64) ||
    (Array.isArray(payload.reference_images) && payload.reference_images.length > 0);
  if (!hasReference) {
    return jsonCors({ detail: "image_b64 or reference_images is required" }, { status: 400 });
  }

  const styleNote = String(payload.style_note || payload.note || "").trim();
  const replacementDirective = lineEdits.length
    ? `Replace ONLY these text lines, keeping every other line exactly as-is: ${lineEdits
        .map((item) => `"${item.from}" -> "${item.to}"`)
        .join("; ")}.`
    : `Re-render the exact same lettering design, but replace the text content with: "${newText}".`;
  const rawPrompt = [
    "The reference image contains custom designed lettering / typography.",
    replacementDirective,
    "Precisely preserve every visual property of the original type design:",
    "letterform skeleton, stroke weight and contrast, serifs and terminals, texture,",
    "material, bevels, outlines, drop shadows, color and gradients, lighting,",
    "perspective, layout and spacing rhythm.",
    "Keep the same background and decorative elements unchanged.",
    "Do not add watermarks, extra text, or new elements.",
    styleNote ? `Extra direction: ${styleNote}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const data = await createStandaloneImages(
      {
        ...payload,
        prompt: `font-restyle: ${newText}`,
        raw_prompt: rawPrompt,
        n: Math.max(1, Math.min(4, Number(payload.n || payload.count || 1))),
      },
      request,
    );
    return jsonCors({ status: 200, message: "success", data: { ...data, kind: "font-restyle", new_text: newText } });
  } catch (error) {
    return jsonCors({ detail: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}

export async function OPTIONS() {
  return optionsResponse();
}
