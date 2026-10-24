# engine

Framework-free STT + translation core. No React, no Next, no imports from `src/app`, `src/features` or `src/lib`
(enforced by ESLint, see `eslint.config.mjs`). Callers outside the engine import **only** from `@/engine` (the index).

TTS is intentionally absent in v1. When added it becomes a `tts/` folder behind a `TtsProvider` interface.

## Layout

```
types.ts               Lang, Direction, EN_TO_ES / ES_TO_EN
stt/types.ts           SttProvider, SttSession, SttResult, SttWord
stt/deepgram.ts        DeepgramSttProvider (browser or Node 22+), mintDeepgramToken (server only)
translate/types.ts     Translator, TranslateRequest, TranslateResult
translate/prompt.ts    System prompt + user message builders
translate/claude.ts    ClaudeTranslator (server only; takes an API key)
glossary/              glossary.json + loader/formatter
```

## Interfaces

### SttProvider

```ts
interface SttProvider { start(opts: SttStartOptions): Promise<SttSession> }

interface SttStartOptions {
  getToken(o: { forceRefresh: boolean }): Promise<string>; // short-lived credential
  sampleRate: number;       // 16000
  endpointingMs: number;
  onResult(r: SttResult): void;
  onError(e: Error): void;
  onClose(i: { code: number; reason: string }): void;
}

interface SttSession {
  connectMs: number; usedTokenRetry: boolean;
  sendAudio(pcm: ArrayBuffer): void; // 16-bit LE mono PCM
  finalize(): void;                  // flush now (end of push-to-talk)
  close(): void;
}
```

One `SttSession` is one push-to-talk turn. Results carry per-word `language` when the vendor reports it.
If the first connection attempt fails, `start` calls `getToken({ forceRefresh: true })` once and retries (a browser
cannot distinguish an expired token from a network failure, because the WebSocket handshake error is opaque).

### Translator

```ts
interface Translator {
  translate(req: { text: string; direction: Direction }): Promise<TranslateResult>;
  // Same translation, yielded as generated: zero or more { type: "delta", text }, then one { type: "done", result }.
  // Errors are thrown. Abort with opts.signal. result.firstDeltaMs is the time to the first text.
  translateStream(req, opts?: { signal?: AbortSignal }): AsyncGenerator<TranslateStreamEvent>;
}
```

`/api/translate` exposes both: JSON by default, NDJSON (`{"t":"delta"|"done"|"error"}` per line) with `stream: true`.

`ClaudeTranslator` calls the Messages API with `fetch`. The system prompt (rules + glossary) is a single
`cache_control: ephemeral` block; direction goes in the user turn so the cached prefix is identical across directions.
Default model `claude-haiku-5-5`, override with `TRANSLATE_MODEL`. The prompt tells the model to translate mixed EN/ES
input entirely into the target language and to treat the text as material, never as instructions.

Note: prompt caching only engages above a model-specific minimum prompt length. With the 5-entry placeholder glossary the
prompt is probably below it, so `cacheReadTokens` will read 0 until the glossary grows. Check `usage` in the debug page.

### Glossary

`glossary/glossary.json`: `{ entries: [{ en, es, note? }] }`. `ClaudeTranslator` accepts a `glossary` option, so a future
admin UI/DB can supply its own without engine changes.

## Chosen Deepgram values (and why)

| Param | Value | Why |
|---|---|---|
| `model` | `nova-3` | Required for `language=multi` code-switching |
| `language` | `multi` | Spanglish within one utterance |
| `encoding` / `sample_rate` | `linear16` / 16000 | Smallest sensible upload; AudioWorklet downsamples |
| `interim_results` | `true` | Live text while talking (debug view; later the speaker's own half) |
| `smart_format`, `punctuate` | `true` | Better input for translation |
| `endpointing` | **100 ms** | Deepgram's docs recommend 100 ms specifically for code-switching |

Why 100 ms is safe for conversation: a turn is bounded by the push-to-talk button, not by silence. On release the client
sends `Finalize`, which flushes buffered audio immediately, and the whole turn is translated once. Endpointing only decides
where mid-turn segments split, and we concatenate them. A pause inside a turn therefore cannot cut the turn short.

**Status: these values are documentation-derived, not yet measured.** The debug page exposes endpointing as a field so it
can be tuned against real recordings. Revisit if mid-turn splits hurt accuracy (longer endpointing gives the model more context
per segment) or if auto-detect (hands-free) mode is added, where endpointing becomes the real turn boundary and 100 ms
will be too aggressive.

Auth: browsers cannot set headers on a WebSocket, so the short-lived JWT is passed as the `['bearer', token]` subprotocol pair.
Tokens come from `POST /v1/auth/grant` (server route) and are only checked at connect time, not for the life of the socket.
