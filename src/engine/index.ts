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
  type CutReason,
} from "./stt/segmenter";
export { detectLang, directionFor, normalizeLang, classifyPhrase, isAlreadyIn, textScores, type PhraseVerdict } from "./stt/language";
export {
  DEFAULT_TUNING,
  TUNING_PARAMS,
  applyTuningParams,
  describeTuning,
  type Tuning,
  type TuningParam,
} from "./tuning";
export { CutRepair } from "./stt/cutrepair";
export { ForcedFinalizer, type ForcedFinalizerOptions } from "./stt/finalizer";
export { GLOBAL_TIMERS, type Timers } from "./stt/timers";
export {
  startContinuousStt,
  type ContinuousSttOptions,
  type ContinuousSttSession,
  type ContinuousStatus,
} from "./stt/continuous";
export { DeepgramSttProvider, mintDeepgramToken, buildListenUrl } from "./stt/deepgram";
export type { Translator, TranslateRequest, TranslateResult, ContextPair, TranslateStreamEvent, SourceLang } from "./translate/types";
export { ClaudeTranslator, DEFAULT_TRANSLATE_MODEL } from "./translate/claude";
export { cleanTranslation, stripLeaks, stripRepeatedPrefix, type Cleaned } from "./translate/leak";
export type { Glossary, GlossaryEntry, GlossaryProfile } from "./glossary";
export {
  loadDefaultGlossary,
  loadGlossary,
  parseProfile,
  glossaryKeyterms,
  keytermTokens,
  GLOSSARY_PROFILES,
  DEFAULT_PROFILE,
  KEYTERM_SELF_CAP,
} from "./glossary";
