/**
 * Public surface of the engine. UI code must import from "@/engine" only (enforced by ESLint).
 * Browser-safe: types, SttProvider/DeepgramSttProvider, Direction helpers.
 * Server-only: ClaudeTranslator, mintDeepgramToken (they take secret keys).
 */
export * from "./types";
export type { SttProvider, SttSession, SttStartOptions, SttResult, SttWord } from "./stt/types";
export {
  PhraseSegmenter,
  DEFAULT_SEGMENTER_OPTIONS,
  isHoldable,
  type SegmenterOptions,
  type PhraseInfo,
} from "./stt/segmenter";
export { detectLang, directionFor, normalizeLang } from "./stt/language";
export {
  startContinuousStt,
  type ContinuousSttOptions,
  type ContinuousSttSession,
  type ContinuousStatus,
} from "./stt/continuous";
export { DeepgramSttProvider, mintDeepgramToken, buildListenUrl } from "./stt/deepgram";
export type { Translator, TranslateRequest, TranslateResult, ContextPair, TranslateStreamEvent } from "./translate/types";
export { ClaudeTranslator, DEFAULT_TRANSLATE_MODEL } from "./translate/claude";
export type { Glossary, GlossaryEntry } from "./glossary";
export { loadDefaultGlossary } from "./glossary";
