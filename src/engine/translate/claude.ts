import { loadDefaultGlossary, type Glossary } from "../glossary";
import { LeakGuard, cleanTranslation } from "./leak";
import { JsonStringField } from "./partialJson";
import { TRANSLATION_TOOL, buildSystemPrompt, buildUserMessage, makeStartCaser } from "./prompt";
import type { TranslateRequest, TranslateResult, TranslateStreamEvent, Translator } from "./types";

export const DEFAULT_TRANSLATE_MODEL = "claude-haiku-5-5";

type Usage = NonNullable<TranslateResult["usage"]>;

interface AnthropicResponse {
  content?: { type: string; text?: string; input?: { translation?: unknown } }[];
  model?: string;
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
  error?: { message?: string };
}

/** What one upstream attempt produced. `complete` is false for anything that might be cut off. */
interface Attempt {
  raw: string;
  complete: boolean;
  stopReason?: string;
  model: string;
  usage: Usage;
  firstDeltaMs?: number;
}

const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });

/**
 * SERVER ONLY. Holds the Anthropic key. Uses fetch directly (no SDK) so the engine stays dependency-free.
 *
 * The model can only answer through the forced `submit_translation` tool, and only its `translation` field is ever
 * returned. A reply counts as complete only if the API reported a normal stop AND the tool input parsed as JSON; a
 * stream that merely ended (dropped connection, proxy cut) is retried once instead of being shown as a finished
 * translation.
 */
export class ClaudeTranslator implements Translator {
  private readonly system: string;

  constructor(
    private readonly opts: { apiKey: string; model?: string; glossary?: Glossary },
  ) {
    this.system = buildSystemPrompt(opts.glossary ?? loadDefaultGlossary());
  }

  private get model() {
    return this.opts.model || DEFAULT_TRANSLATE_MODEL;
  }

  private finish(req: TranslateRequest, a: Attempt, latencyMs: number, retried: boolean): TranslateResult {
    const previous = [...(req.context ?? [])].reverse().find((c) => c.translation)?.translation;
    const cleaned = cleanTranslation(a.raw, previous);
    const text = makeStartCaser(req.context)(cleaned.text).trim();
    return {
      text,
      model: a.model,
      latencyMs,
      firstDeltaMs: a.firstDeltaMs,
      leaks: cleaned.leaks.length ? cleaned.leaks : undefined,
      stopReason: a.stopReason,
      retried: retried || undefined,
      usage: a.usage,
    };
  }

  async translate(req: TranslateRequest): Promise<TranslateResult> {
    const text = req.text.trim();
    if (!text) return { text: "", model: this.model, latencyMs: 0 };
    const t0 = performance.now();
    let a = await this.attempt(req, text, 1);
    let retried = false;
    if (!a.complete) {
      retried = true;
      a = await this.attempt(req, text, 3);
      if (!a.complete) throw new Error(`Translation incomplete (stop_reason: ${a.stopReason ?? "unknown"})`);
    }
    return this.finish(req, a, performance.now() - t0, retried);
  }

  /** `tokenFactor` scales the output budget (a retry gets more room). Non-streaming. */
  private async attempt(req: TranslateRequest, text: string, tokenFactor: number): Promise<Attempt> {
    const res = await this.post(text, req, false, tokenFactor);
    const body = (await res.json().catch(() => ({}))) as AnthropicResponse;
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "request failed"}`);
    const tool = (body.content ?? []).find((b) => b.type === "tool_use");
    const value = tool?.input?.translation;
    return {
      raw: typeof value === "string" ? value : "",
      complete: body.stop_reason === "tool_use" && typeof value === "string",
      stopReason: body.stop_reason,
      model: body.model ?? this.model,
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
        cacheReadTokens: body.usage?.cache_read_input_tokens ?? 0,
        cacheWriteTokens: body.usage?.cache_creation_input_tokens ?? 0,
      },
    };
  }

  private post(text: string, req: TranslateRequest, stream: boolean, tokenFactor: number, signal?: AbortSignal) {
    return fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": this.opts.apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: this.model,
        stream,
        // Generous: the budget is a ceiling, not a target, and a cut-off translation is the worst outcome. The tool
        // call's JSON wrapper and Spanish (~1.3x the tokens of English) both need headroom.
        max_tokens: Math.min(8192, Math.max(1024, text.length * 3) * tokenFactor),
        system: [{ type: "text", text: this.system, cache_control: { type: "ephemeral" } }],
        tools: [TRANSLATION_TOOL],
        tool_choice: { type: "tool", name: TRANSLATION_TOOL.name },
        messages: [{ role: "user", content: buildUserMessage(text, req.direction.to, req.context) }],
      }),
    });
  }

  /** One streaming attempt. Yields display deltas; the generator's return value says whether it finished cleanly. */
  private async *streamAttempt(req: TranslateRequest, text: string, signal?: AbortSignal): AsyncGenerator<string, Attempt> {
    const t0 = performance.now();
    const res = await this.post(text, req, true, 1, signal);
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => ({}))) as AnthropicResponse;
      throw new Error(`Anthropic ${res.status}: ${body.error?.message ?? "request failed"}`);
    }

    const caser = makeStartCaser(req.context);
    const guard = new LeakGuard();
    const field = new JsonStringField("translation");
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let json = "";
    let firstDeltaMs: number | undefined;
    let model = this.model;
    let stopReason: string | undefined;
    let sawStop = false;
    const usage = emptyUsage();

    // Server-sent events: blocks separated by a blank line, each with "event:" and "data:" lines.
    const handle = function* (block: string): Generator<string> {
      const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
      if (!dataLine) return;
      const ev = JSON.parse(dataLine.slice(5).trim()) as {
        type: string;
        message?: { model?: string; usage?: AnthropicResponse["usage"] };
        delta?: { type?: string; partial_json?: string; stop_reason?: string };
        usage?: AnthropicResponse["usage"];
        error?: { message?: string };
      };
      if (ev.type === "message_start") {
        model = ev.message?.model ?? model;
        usage.inputTokens = ev.message?.usage?.input_tokens ?? 0;
        usage.cacheReadTokens = ev.message?.usage?.cache_read_input_tokens ?? 0;
        usage.cacheWriteTokens = ev.message?.usage?.cache_creation_input_tokens ?? 0;
      } else if (ev.type === "content_block_delta" && ev.delta?.type === "input_json_delta") {
        const frag = ev.delta.partial_json ?? "";
        json += frag;
        const shown = guard.push(field.push(frag));
        if (shown) {
          firstDeltaMs ??= performance.now() - t0;
          yield caser(shown);
        }
      } else if (ev.type === "message_delta") {
        usage.outputTokens = ev.usage?.output_tokens ?? usage.outputTokens;
        stopReason = ev.delta?.stop_reason ?? stopReason;
      } else if (ev.type === "message_stop") {
        sawStop = true;
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

    const tail = guard.flush();
    if (tail) yield caser(tail);

    let raw = "";
    let parsed = false;
    try {
      const v = (JSON.parse(json) as { translation?: unknown }).translation;
      if (typeof v === "string") {
        raw = v;
        parsed = true;
      }
    } catch {
      /* incomplete JSON: the stream was cut */
    }
    return { raw, complete: sawStop && parsed && stopReason === "tool_use", stopReason, model, usage, firstDeltaMs };
  }

  async *translateStream(req: TranslateRequest, opts?: { signal?: AbortSignal }): AsyncGenerator<TranslateStreamEvent> {
    const text = req.text.trim();
    if (!text) {
      yield { type: "done", result: { text: "", model: this.model, latencyMs: 0 } };
      return;
    }
    const t0 = performance.now();
    const it = this.streamAttempt(req, text, opts?.signal);
    let a: Attempt;
    for (;;) {
      const n = await it.next();
      if (n.done) {
        a = n.value;
        break;
      }
      yield { type: "delta", text: n.value };
    }
    if (a.complete) {
      yield { type: "done", result: this.finish(req, a, performance.now() - t0, false) };
      return;
    }
    // Cut off (dropped upstream stream, max_tokens, refusal...). Whatever was streamed is replaced by the retry's
    // text in the "done" event, which clients treat as authoritative. A cut-off translation is never reported as done.
    if (opts?.signal?.aborted) throw new Error("aborted");
    const retry = await this.attempt(req, text, 3);
    if (!retry.complete) throw new Error(`Translation incomplete (stop_reason: ${retry.stopReason ?? a.stopReason ?? "unknown"})`);
    yield { type: "done", result: this.finish(req, retry, performance.now() - t0, true) };
  }
}
