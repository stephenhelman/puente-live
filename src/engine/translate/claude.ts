import { loadDefaultGlossary, type Glossary } from "../glossary";
import { buildSystemPrompt, buildUserMessage, makeStartCaser } from "./prompt";
import type { TranslateRequest, TranslateResult, TranslateStreamEvent, Translator } from "./types";

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
    const res = await this.post(model, text, req, false);
    const body = (await res.json().catch(() => ({}))) as AnthropicResponse;
    const latencyMs = performance.now() - t0;
    if (!res.ok) {
      throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "request failed"}`);
    }
    const out = makeStartCaser(req.context)(
      (body.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("")
        .trim(),
    );
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

  private post(model: string, text: string, req: TranslateRequest, stream: boolean, signal?: AbortSignal) {
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        stream,
        // Spoken turns are short; allow generous headroom for a long monologue.
        max_tokens: Math.min(4096, Math.max(256, text.length * 2)),
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: buildUserMessage(text, req.direction.to, req.context) }],
      }),
    });
  }

  async *translateStream(req: TranslateRequest, opts?: { signal?: AbortSignal }): AsyncGenerator<TranslateStreamEvent> {
    const model = this.opts.model || DEFAULT_TRANSLATE_MODEL;
    const text = req.text.trim();
    if (!text) {
      yield { type: "done", result: { text: "", model, latencyMs: 0 } };
      return;
    }
    const t0 = performance.now();
    const res = await this.post(model, text, req, true, opts?.signal);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as AnthropicResponse;
      throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "request failed"}`);
    }

    const caser = makeStartCaser(req.context);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let full = "";
    let firstDeltaMs: number | undefined;
    let outModel = model;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    // Server-sent events: blocks separated by a blank line, each with "event:" and "data:" lines.
    const handle = function* (block: string): Generator<TranslateStreamEvent> {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) return;
      const ev = JSON.parse(dataLine.slice(5).trim()) as {
        type: string;
        message?: { model?: string; usage?: AnthropicResponse["usage"] };
        delta?: { type?: string; text?: string };
        usage?: AnthropicResponse["usage"];
        error?: { message?: string };
      };
      if (ev.type === "message_start") {
        outModel = ev.message?.model ?? outModel;
        usage.inputTokens = ev.message?.usage?.input_tokens ?? 0;
        usage.cacheReadTokens = ev.message?.usage?.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens = ev.message?.usage?.cache_creation_input_tokens ?? 0;
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta" && ev.delta.text) {
        firstDeltaMs ??= performance.now() - t0;
        const text = caser(ev.delta.text);
        full += text;
        yield { type: "delta", text };
      } else if (ev.type === "message_delta") {
        usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens;
      } else if (ev.type === "error") {
        throw new Error(`Anthropic stream error: ${ev.error?.message ?? "unknown"}`);
      }
    };

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          yield* handle(block);
        }
      }
      if (buf.trim()) yield* handle(buf);
    } finally {
      void reader.cancel().catch(() => {});
    }

    yield {
      type: "done",
      result: {
        text: full.trim(),
        model: outModel,
        latencyMs: performance.now() - t0,
        firstDeltaMs,
        usage,
      },
    };
  }
}
