import { loadDefaultGlossary, type Glossary } from "../glossary";
import { buildSystemPrompt, buildUserMessage } from "./prompt";
import type { TranslateRequest, TranslateResult, Translator } from "./types";

export const DEFAULT_TRANSLATE_MODEL = "claude-haiku-5-5";

interface AnthropicResponse {
  content?: { type: string; text?: string }[];
  model?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { message?: string };
}

/**
 * SERVER ONLY. Holds the Anthropic key. Uses fetch directly (no SDK) so the engine stays dependency-free.
 */
export class ClaudeTranslator implements Translator {
  private readonly system: string;

  constructor(
    private readonly opts: { apiKey: string; model?: string; glossary?: Glossary },
  ) {
    this.system = buildSystemPrompt(opts.glossary ?? loadDefaultGlossary());
  }

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const model = this.opts.model || DEFAULT_TRANSLATE_MODEL;
    const text = req.text.trim();
    if (!text) return { text: "", model, latencyMs: 0 };

    const t0 = performance.now();
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        // Spoken turns are short; allow generous headroom for a long monologue.
        max_tokens: Math.min(4096, Math.max(256, text.length * 2)),
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildUserMessage(text, req.direction.to) }],
      }),
    });
    const body = (await res.json().catch(() => ({}))) as AnthropicResponse;
    const latencyMs = performance.now() - t0;
    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "request failed"}`);
    }
    const out = (body.content ?? [])
      .filter((b) => b.type === "text")
      .map((b) => b.text ?? "")
      .join("")
      .trim();
    return {
      text: out,
      model: body.model ?? model,
      latencyMs,
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
        cacheReadTokens: body.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: body.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }
}
