import type { SttWord } from "@/engine";

/** Synthetic words (no real meeting text). `lang` is the vendor tag; times are 0.4 s apart unless given. */
export function words(text: string, lang?: string, startAt = 0): SttWord[] {
  return text.split(/\s+/).map((w, i) => ({
    word: w,
    start: startAt + i * 0.4,
    end: startAt + i * 0.4 + 0.3,
    confidence: 0.9,
    language: lang,
  }));
}

/** Patterns of reasoning text seen leaking into translations in the first field test. */
export const LEAK_FIXTURES = [
  {
    raw: "Wait, the target language is English, so I translate into English. We need to review the bylaws before the vote.",
    clean: "We need to review the bylaws before the vote.",
  },
  {
    raw: "Wait, the target language is Spanish per the system rules… Actually the user message says to translate into English.\nHola a todos, gracias por venir.",
    clean: "Hola a todos, gracias por venir.",
  },
  { raw: "Translating only the new text: Vamos a revisar los estatutos.", clean: "Vamos a revisar los estatutos." },
  {
    raw: "Wait, the input seems garbled. The word might have meant IRS, or possibly the chapter. I will translate it as best I can.\nThe form is due on Friday.",
    clean: "The form is due on Friday.",
  },
  { raw: "Espera, el idioma de destino es inglés. Necesitamos las actas de la reunión.", clean: "Necesitamos las actas de la reunión." },
] as const;

/** Anthropic SSE for a forced tool call, split into the fragments the real API sends. */
export function toolStream(translation: string, opts: { stopReason?: string; cutAfter?: number; noStop?: boolean } = {}): string {
  const json = JSON.stringify({ translation });
  const frags = json.match(/.{1,7}/g) ?? [];
  const keep = opts.cutAfter === undefined ? frags : frags.slice(0, opts.cutAfter);
  const ev = (type: string, data: object) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  let out = ev("message_start", { message: { model: "m", usage: { input_tokens: 10 } } });
  out += ev("content_block_start", { index: 0, content_block: { type: "tool_use", name: "submit_translation" } });
  for (const f of keep) out += ev("content_block_delta", { index: 0, delta: { type: "input_json_delta", partial_json: f } });
  if (opts.cutAfter === undefined) {
    out += ev("content_block_stop", { index: 0 });
    out += ev("message_delta", { delta: { stop_reason: opts.stopReason ?? "tool_use" }, usage: { output_tokens: 5 } });
    if (!opts.noStop) out += ev("message_stop", {});
  }
  return out;
}
