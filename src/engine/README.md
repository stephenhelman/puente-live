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

## Phrase boundaries (live translation)

`/converse` translates while the speaker is still talking. `PhraseSegmenter` (`stt/segmenter.ts`) turns Deepgram results into
phrases; each phrase goes to `translateStream` with the earlier phrases of the same turn as `context` (source, plus the
translation already shown when it has arrived). Context is per turn, in memory, and is never stored. Nothing that was
displayed is ever rewritten, and the turn is not re-translated at the end.

| Setting | Value | Why |
|---|---|---|
| Deepgram `endpointing` | **400 ms** | Measured (below): 300 gave the lowest lag, 500+ was slower and less accurate. 400 avoids splitting on every 300 ms thinking pause in real speech. Override in the browser with `/converse?ep=300`. |
| `pauseMs` (word-gap split) | **450 ms** | A silence this long between two words, from Deepgram's word timestamps, ends a phrase. Needed because `speech_final` is unreliable. Override with `?pause=`. |
| `quietMs` | 900 ms | If nothing new was heard for this long and everything heard is final, emit the buffer. |
| `maxWords` / `maxAgeMs` | 28 words / 8 s | A non-stop talker is cut at the next final so latency stays bounded. |
| Merge rule | filler-only, or <= 2 words with no sentence ending | Held and merged into the next phrase (`holdMs` 2.5 s, or end of turn). "Yes." and "Sí." (with punctuation) are not held. |
| Context | last 6 phrases | Enough for pronouns, gender and tense; keeps the prompt small. |
| Stop tail | 300 ms | Keep capturing after the stop tap so the last syllable is not clipped. |

Capitalization after a finished sentence is applied in code (`makeStartCaser`), not by prompting: asking the model to
decide made it lowercase real sentence starts and drop pronouns.

### Measurements (synthetic speech, one run per cell; indicative, not statistical)

36 s English turn and 20 s Spanglish turn with deliberate 350-900 ms pauses, streamed in real time. Lag = time after the
phrase's last word until the phrase was emitted.

| endpointing | EN lag p50 / p95 | EN word error | ES lag p50 / p95 | ES word error |
|---|---|---|---|---|
| 300 ms | 0.53 s / 2.99 s | 2.4 % | 0.23 s / 0.42 s | 10.2 % |
| 400 ms | 0.61 s / 5.12 s | 3.7 % | 0.26 s / 4.34 s | 10.2 % |
| 500 ms | 0.74 s / 5.72 s | 6.1 % | 0.70 s / 5.17 s | 16.3 % |
| 600 ms | 0.80 s / 5.86 s | 3.7 % | 0.69 s / 5.76 s | 12.2 % |

Findings that shaped the design:

- Deepgram's `speech_final` fired only 2-5 times on turns with 7+ real pauses, so it is one signal among several, not the boundary.
- The p95 tail (3-6 s) comes from Deepgram holding a finalized result until the speaker resumes. Promoting stable
  *interim* words to a phrase was tried and rejected: interims can pause over a second mid-sentence, which produced
  fragments like "I want us" | "start with" and raised word error from ~4 % to 11 %.
- Synthetic voices have digital silence between sentences and mangle some words; re-measure with real speakers using `?ep=`.

## Deploying (Railway)

The app is one long-lived Next.js process (`pnpm build`, then `pnpm start`; see `railway.json`). Node 22.x, pnpm per
`packageManager`. The health check is `GET /api/health` (public, returns `{"status":"ok"}` and nothing else).
The in-memory passcode rate limiter is per process, so run exactly **one instance** (do not scale replicas above 1).

Variables to set on the host (purpose only; see `.env.example` for how to generate them):

| Variable | Required | Purpose |
|---|---|---|
| `DEEPGRAM_API_KEY` | yes | Server-side key (Member role or higher) used to mint short-lived browser STT tokens. Never sent to clients. |
| `ANTHROPIC_API_KEY` | yes | Server-side key for translation (Claude Haiku). |
| `CHAPTER_PASSCODE_HASH` | yes | `scrypt:<salt>:<hash>` of the chapter passcode. |
| `SESSION_SECRET` | yes | Signs the httpOnly session cookie. |
| `DEEPGRAM_TOKEN_TTL_SECONDS` | no | Token lifetime, default 60. |
| `TRANSLATE_MODEL` | no | Translation model id, default `claude-haiku-5-5`. |

`PORT` is injected by Railway. `NODE_ENV=production` is set by `next build`/`next start` and makes the session cookie `Secure`
(HTTPS only). Microphone access also requires HTTPS, which Railway's generated domain provides.
No variable is exposed to the browser: the app uses no `NEXT_PUBLIC_*` variables.
