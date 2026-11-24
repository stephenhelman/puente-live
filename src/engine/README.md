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
glossary/              profiles/{chapter,hemophilia}.json + loader/formatter
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

`glossary/profiles/<name>.json` (see "Glossary profiles" below): `{ context?, entries: [{ en, es, note?, soundsLike?, placeholder?, reviewed?, keyterms? }] }`. `soundsLike` lists known mishearings
(including Spanish speakers saying the English word: "bailos"/"bailes" = bylaws); they go into the translation prompt as
"often heard as" so the translator resolves them in context. Entries with `placeholder: true` (org name, website, people)
are ignored until filled in: edit `en`/`es`/`soundsLike` and delete the flag. `glossaryKeyterms()` turns the correct
spellings (never the mishearings) into Deepgram `keyterm` hints, capped at ~350 of Deepgram's 500 tokens. `ClaudeTranslator` accepts a `glossary` option, so a future
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

## Meeting mode (`/meeting`)

Two independent sources (the meeting's audio via `getDisplayMedia`, and optionally the mic), each with its own long-lived
Deepgram socket, `PhraseSegmenter` and translation context. Engine additions, all behind `@/engine`:

- `startContinuousStt(provider, opts)` (`stt/continuous.ts`): one stream that survives socket drops. On close it calls
  `onDrop` (the caller flushes open phrases, because the new socket's word clock restarts at 0), reconnects with backoff
  (300 ms to 8 s; the provider mints a fresh token on its retry, and `getToken` re-mints once the cached one ages out), keeps
  the last 20 s of audio and replays it. A watchdog reconnects if no result arrives for 15 s while audio flows (Deepgram sends
  empty results through silence, measured gaps <= 2 s). Gives up after 2 min down (`status: "failed"`). The first connect
  failing is thrown, not retried.
- `keepAliveMs` on `SttStartOptions`: the provider sends `{"type":"KeepAlive"}` when no audio went out for that long
  (Deepgram closes after ~10 s of neither). Audio normally flows continuously, so this is a safety net.
- `detectLang(words, text, fallback)`: majority of Deepgram's per-word `language` tags (English and Spanish only; other
  languages ignored). Tie or no tags: stopword/accent guess, then the previous phrase's language from the same source, then English.
  `directionFor(lang)` maps English to Spanish and Spanish to English.
- `PhraseSegmenter` now passes `PhraseInfo { words, endSec }` as a second callback argument (converse ignores it).

**Endpointing in continuous mode: unchanged** (400 ms, `pauseMs` 450, `quietMs` 900, 28 words / 8 s). Reasoning: it is a
conversation-style boundary already, the phrase boundary is driven by word-timestamp gaps rather than a push-to-talk
button, and I have no real-meeting measurements to justify a different value (the table above came from synthetic speech;
see the meeting numbers below). Tune in the field with the URL parameters in "Tuning parameters" below; `?mins=` sets the session cap in minutes
(default 180, warning 10 min before the end; it used to be `?max=`, which now means max words). Context sent to the translator is the last 6 phrases from the same source in
the same direction.

### Meeting measurements (synthetic speech, real Deepgram + Claude Haiku 5.5, two concurrent streams, one forced socket drop)

25 phrases, ~70 s per stream, played in real time. Lag is measured from the speaker's last word (Deepgram word end mapped to
the local clock). Excludes the browser-to-server hop, which is one extra request inside the same region.

| Stage | p50 | p95 |
|---|---|---|
| Phrase emitted by the segmenter | 0.60 s | 1.56 s |
| First translated text | 1.64 s | 3.43 s |
| Translation finished | 1.97 s | 3.55 s |

A second run (one stream, ending in 20 s of silence) gave 0.89 / 3.11 s emit and 2.02 / 4.58 s done, so p95 ranges 3.5-4.6 s and
n is small. Language detection used word tags for 25 of 26 phrases. The forced drop reconnected and continued (reconnects=1).
`/meeting?debug=1` shows the same percentiles live for a real session.

## Meeting quality fixes (first field test)

Root causes and changes, in the order they were reported:

| Problem | Root cause | Change |
|---|---|---|
| Reasoning text in translations ("Wait, the target language is...") | Free-text output, and the target language was named in both the system prompt and the user message in different words, so the model reconciled them aloud | The model can only answer through a forced `submit_translation` tool; only its `translation` field is read. The target language appears once, in `<target_language>`. Defensive filter in `translate/leak.ts` strips known meta patterns and reports each one (`result.leaks`, `?debug=1`). Streamed text that opens like a leak is withheld, not flashed |
| Blank translations | English text labelled Spanish (or the reverse) made the model "translate" into the language it was already in and return nothing; no fallback existed | `isAlreadyIn` (words outrank the vendor tag) shows the original as "(already in X)" with no API call. Empty answers retry once, then show the original marked "(untranslated)". Never blank |
| Phantom languages | `language=multi` tags short fillers as Telugu, Hebrew, Hungarian... `language_hint` biases but does **not** restrict | `classifyPhrase` drops non-Latin words, drops phrases tagged only with other languages unless the words are plainly en/es, and makes 1-2 word phrases inherit the previous phrase's language. `language_hint=en&language_hint=es` is also sent |
| Caption stalls and bursts | See below | See below |
| Truncated / duplicated translations | The stream was never validated: a clean-closed upstream stream was reported as "done" whatever it contained (no `stop_reason` / `message_stop` check). Duplicates: earlier translations were interleaved with the new text as plain prose | A reply is complete only with `message_stop`, `stop_reason: tool_use` and parseable JSON; otherwise one retry (bigger budget), never "done". `max_tokens` is now >= 1024. Context is a separate `<context>` field, and a repeated copy of the previous translation is stripped |
| Mishearings | No vocabulary | Glossary + `keyterm` hints (verified against Deepgram: keyterms work with Nova-3 `language=multi`) |

**Caption stalls.** Phrases are emitted by the segmenter, and its "quiet" and "hold" emission ran on `setTimeout`. A hidden or
occluded window (Puente behind Zoom) has timers throttled to 1/s and, after 5 minutes, about 1/min, so phrases waited for the
next vendor message and then flushed together. Timestamps came from `Date.now()` at emission, so a burst got one time.
Changes: segmenter/reconnect timers run in a Worker (not throttled); the segmenter also enforces both deadlines on every
vendor message (they arrive through silence); the AudioContext is resumed if Chrome suspends it; captions are timestamped
from the vendor's first-word start time and the transcript is ordered by it. Audio capture was already an AudioWorklet. Translation
was already parallel (one request and one slot per phrase); a stalled request (no progress for 20 s) is now abandoned and retried
so it cannot hold a connection. `?debug=1` shows max speech-end-to-caption delay, throttling events, worst audio-chunk and vendor
gaps, and a warning banner when the heartbeat ran more than 3 s late.

## Tuning parameters

All the numbers that decide caption speed live in `src/engine/tuning.ts` (`DEFAULT_TUNING`, `TUNING_PARAMS`,
`applyTuningParams`). Any page can pass its own defaults (`getTuning(base)`, `getMeetingTuning(base)`) and the URL still overrides
them. Defaults are exactly the values in the table above; a test pins them. Out-of-range numbers are clamped, junk is ignored.
Works on `/meeting` and `/converse`.

| Param | Controls | Range | Default |
|---|---|---|---|
| `ep` | Deepgram endpointing | 100-1500 ms | 400 |
| `pause` | word-gap pause that ends a phrase | 150-1500 ms | 450 |
| `max` | max words in a phrase (cut at the next vendor final) | 4-80 | 28 |
| `age` | max age of a phrase (cut at the next vendor final) | 1000-30000 ms | 8000 |
| `quiet` | nothing new heard for this long ends a phrase | 200-3000 ms | 900 |
| `hold` | how long a one/two-word fragment waits to be joined | 200-5000 ms | 2500 |
| `fin` | forced Finalize: longest interim text may go without a final (0 = off) | 1000-15000 ms, or 0 | 0 (off) |
| `ctx` | earlier phrases sent to the translator | 0-6 | 6 |
| `mins` | session length cap (`/meeting` only) | 1-600 min | 180 |
| `profile` | glossary profile | chapter, hemophilia | page default |

`/meeting?debug=1` shows the values in force, then rolling p50/p95/max over the last 200 phrases, measured **in the browser**
(so they include the browser to server to Anthropic round trip): speech end to phrase emitted, emitted to first translated text,
emitted to done, and the two end-to-end sums. It also shows which rule cut each phrase (`final`, `pause`, `quiet`, `maxWords`,
`maxAge`, `hold`, `flush`), the prompt-cache read tokens of each request, and the last 8 phrases. "copy stats" copies the same
numbers and the tuning as plain text (never any transcript text).

Finding from the first runs (50 s of presenter-style speech, synthetic voice): `max` and `age` only act when Deepgram delivers a
final result, and in continuous speech Deepgram can hold its first final for ~13 s. The first phrase (spoken at 0-4.5 s) was
emitted at 13.4 s with defaults and with `max=14&age=4000`. Tuning the segmenter alone cannot fix that; see the panel's `cut` column.

## Forced Finalize (`?fin=`)

Deepgram only finalizes at pauses or on its own schedule, and in continuous speech it can hold the first final for ~13 s. The
segmenter cuts only on finals, so `max` and `age` cannot act until one arrives. `ForcedFinalizer` (`stt/finalizer.ts`, owned by
`startContinuousStt` so every caller gets it) watches the results: when interim text has been pending `fin` ms without a final it
sends the vendor's `Finalize` message, and a final arrives at a moment we choose.

- The clock starts at the first interim text after a final and **resets on every final** (natural or forced).
- At the limit it finalizes at once only if the newest interim is **stable**: the same length and last word as the previous one.
  Otherwise it waits up to 500 ms for that, then finalizes anyway.
- **A shrinking interim is not stable.** When words disappear from the interim the recognizer is reconsidering (typically at an
  English to Spanish switch); finalizing then commits undecoded audio. After a shrink we wait 1500 ms without another one, and
  never more than 3500 ms past the limit.
- **A stale interim is not stable.** If the interim has not changed for 2000 ms while audio flows, the recognizer is stuck (again
  deciding on a language), not settled. We do not finalize it; we wait for it to change, then apply the rules above.
- At most one Finalize per interval; a new interim starts the next one. Timers are the injected (Worker) timers, and the
  deadlines are also enforced from the clock on each vendor result.
- The resulting text goes through the segmenter's rules unchanged. A cut at a final that came from our Finalize
  (`from_finalize`) is reported as cut `forced` in the debug panel (the vendor flags those results `speech_final` too).
- **Off by default** (`fin=0`) on `/meeting` and `/converse`.

`CutRepair` (`stt/cutrepair.ts`, active only when `fin` is set) puts back words the vendor itself returned and then dropped:
the leading word(s) of the next segment when its first interim had them and the final does not (guarded: the final's first word
must match the interim's next word, and the restored words must start after the previous final ended), and the whole last interim
when our Finalize is answered with an empty `from_finalize` final. It never adds a word the vendor did not return.

The Deepgram keep-alive runs on the same injected timers (it used plain `setInterval`, which a hidden window throttles).

### Where words are lost at a forced cut (investigation)

Synthetic run-on speech, logged Deepgram messages around every Finalize (about 100 cuts over ~15 runs). **None of the losses were
in our segmenter, de-duplication or phrase merging: the words are absent from the vendor's own finals.** Two of the cases were our
"stable" rule being wrong (fixed above); the rest are vendor behavior:

1. **A word being spoken at the instant of the cut is clipped** (about one word per six cuts: "treatment", "given", "schedule",
   "will"). Half of those were returned in the first interim after the cut and then dropped from the final (restored by
   `CutRepair`); half were never returned by any message (the cut fell inside a short word) and cannot be recovered.
2. **The vendor answers Finalize with an empty final** and discards a whole pending segment its own interim had shown (16 words).
   Restored by promoting that interim.
3. **After a forced Finalize the vendor sometimes returns empty interims for 3-5 s while speech continues**, then an empty final.
   Those words are never returned. It also happens (less often) with no forcing at all.
4. **English to Spanish switch:** the vendor shows nothing for the new language for 2-3 s. A Finalize inside that window loses the
   Spanish clause (~10 words). With forcing off only the first 2-3 words are lost.

Measured over sequential single-stream runs of 50 s of run-on speech: `fin=3000` cuts speech-end to first-text from ~2.3 s to
~1.2 s p50 (worst case 9.8 s to ~3.7 s) at the price of about +5 points of word error rate (10-11 % against 4-9 % unforced). `fin=8000`
never fired in that audio. Real speakers pause more than synthetic speech, so forcing will fire less and cost less; test with a
real presenter before turning it on by default.

## Glossary profiles

Two bundled profiles, `chapter` (the original chapter-admin terms) and `hemophilia`. Each has its own entries, its own
Deepgram `keyterm` list and its own system prompt, so each gets its own prompt-cache entry. `GLOSSARY_PROFILES` /
`parseProfile()` / `loadGlossary(name)` live in `glossary/index.ts` and are exported from `@/engine`.

- **Request:** `/api/translate` takes `profile` (default `chapter`; an unknown or non-string value is a 400, never a silent
  fallback). `ClaudeTranslator` builds each profile's prompts once. A `glossary` constructor option still overrides all profiles.
- **Recognizer:** `glossaryKeyterms(loadGlossary(profile))`. `useMeeting(defaultProfile)` resolves the profile when a session
  starts: the page default (`/meeting`: `chapter`; `/present` will pass `hemophilia`), overridden by `?profile=` (unknown names
  are ignored). The profile is stored with each phrase, so a retry uses the profile the phrase was spoken under.
- **Prompt wording:** `context` (optional) replaces "chapter business, taxes, mail, finances, governance" in the glossary
  paragraph; the chapter prompt is byte-for-byte what it was before profiles.
- **Keyterms:** an entry may list its own `keyterms` (e.g. the spoken "factor eight" / "factor ocho"); `[]` opts everyday words
  out ("bleed", "port", "carrier") so the recognizer is not biased toward them. Mishearings never go to Deepgram.
  Estimated cost (chars/3 + 1 per term, self-cap 350 of Deepgram's 500): chapter 25 terms / 126 tokens, hemophilia 29 terms / 147 tokens.
- **Clinical review:** every medical entry in `hemophilia.json` is `reviewed: false`. Nothing is blocked on it, but **a
  clinician should review these renderings (and the choice of "sangrado articular" over "hemartrosis" for "joint bleed", and
  "portadora"/"puerto") before a public event**, then flip the flag.

## Translation direction in meeting mode (auto mode)

The recognizer's language tag is no longer what decides the direction. `/api/translate` accepts `{ auto: true, hint }` instead of
a fixed `direction`; `ClaudeTranslator` then uses a separate system prompt and tool (`AUTO_TRANSLATION_TOOL`) whose fields,
in order, are `source_language` (`en` | `es` | `mixed`), `target_language`, `translation`. The model decides what was spoken and
translates into the other language (mixed: into the language with fewer words in the input). The tag Deepgram produced is sent
only as `<transcriber_hint>`. The stream emits `{"t":"source","lang":...}` as soon as `source_language` is parsed, so the pipeline
updates the entry's language tag before the first text; the `done` event repeats it as the authoritative value.

- No phrase is passed through any more. The only unchanged output is a name or acronym ("NBDC"). `isAlreadyIn` survives only as
  a `?debug=1` counter ("already-hint"), and a translation identical to its original is counted as "unchanged".
- The `target_language` field exists because without it code-switched input came back as a hybrid ("Les dije que we need more
  time...") in live checks. Forcing the model to commit to one output language before writing fixed it.
- `/converse` and `/debug` keep the fixed side-based `direction`, the old prompt and the old tool (byte-for-byte unchanged).
- Live check (off by default, a few cents): `set -a; . ./.env; set +a; LIVE_ANTHROPIC=1 pnpm vitest run src/engine/translate/claude.live.test.ts`.

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
