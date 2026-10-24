import type { Lang } from "@/engine";

type Pair = Record<Lang, string>;

/** Every UI string, in both languages. Each half of the screen renders in its own language. */
export const S = {
  appName: { en: "Puente Live", es: "Puente Live" },
  tapToSpeak: { en: "Tap to speak", es: "Toque para hablar" },
  starting: { en: "Starting…", es: "Iniciando…" },
  listening: { en: "Listening… tap to stop", es: "Escuchando… toque para detener" },
  translating: { en: "Translating…", es: "Traduciendo…" },
  waitOtherSpeaking: { en: "Please wait: the other person is speaking", es: "Espere: la otra persona está hablando" },
  waitOtherTranslating: { en: "Please wait: translating…", es: "Espere: traduciendo…" },
  secondsLeft: { en: "s left", es: "s restantes" },
  phrases: { en: "Phrases", es: "Frases" },
  closePhrases: { en: "Close", es: "Cerrar" },
  clear: { en: "Clear conversation", es: "Borrar conversación" },
  clearConfirm: { en: "Tap again to erase", es: "Toque otra vez para borrar" },
  emptyHint: {
    en: "Tap the button and speak. The translation appears on the other side.",
    es: "Toque el botón y hable. La traducción aparece en el otro lado.",
  },
  youSaid: { en: "You said", es: "Usted dijo" },
  shortDisclaimer: {
    en: "AI translation. Not for clinical, legal, or consent situations.",
    es: "Traducción con IA. No para situaciones clínicas, legales o de consentimiento.",
  },
  retry: { en: "Retry", es: "Reintentar" },
  phraseFailed: { en: "This part could not be translated.", es: "No se pudo traducir esta parte." },
  dismiss: { en: "Dismiss", es: "Cerrar aviso" },
  noSpeech: { en: "I didn't hear anything. Please try again.", es: "No escuché nada. Intente de nuevo." },
  autoStop: { en: "Stopped after 60 seconds.", es: "Se detuvo después de 60 segundos." },
  screenMayDim: {
    en: "The screen may turn off. Keep it awake in your device settings.",
    es: "La pantalla puede apagarse. Manténgala encendida en la configuración del dispositivo.",
  },
  // Entry screen
  welcomeTitle: { en: "Before you start", es: "Antes de comenzar" },
  disclaimerBody: {
    en: "This tool uses AI to translate general conversation and meetings. It is NOT a substitute for a qualified interpreter in clinical, legal, or consent situations. Translations can contain mistakes.",
    es: "Esta herramienta usa IA para traducir conversaciones y reuniones generales. NO sustituye a un intérprete calificado en situaciones clínicas, legales o de consentimiento. Las traducciones pueden contener errores.",
  },
  privacyNote: {
    en: "Nothing is saved. Audio is sent to speech and translation services while you talk, and the conversation disappears when you close or clear it.",
    es: "No se guarda nada. El audio se envía a servicios de voz y traducción mientras habla, y la conversación desaparece al cerrarla o borrarla.",
  },
  acknowledge: { en: "I understand", es: "Entiendo" },
} satisfies Record<string, Pair>;

export type ErrorKind =
  | "mic-denied"
  | "mic-missing"
  | "mic-failed"
  | "offline"
  | "token"
  | "stt"
  | "translate";

export const ERRORS: Record<ErrorKind, Pair> = {
  "mic-denied": {
    en: "The microphone is blocked. Allow it in your browser or device settings, then tap Retry.",
    es: "El micrófono está bloqueado. Permítalo en la configuración del navegador o del dispositivo y toque Reintentar.",
  },
  "mic-missing": {
    en: "No microphone was found. Connect one, then tap Retry.",
    es: "No se encontró ningún micrófono. Conecte uno y toque Reintentar.",
  },
  "mic-failed": {
    en: "The microphone could not start. Close other apps that use it, then tap Retry.",
    es: "No se pudo iniciar el micrófono. Cierre otras aplicaciones que lo usen y toque Reintentar.",
  },
  offline: {
    en: "No internet connection. Check your connection, then tap Retry.",
    es: "Sin conexión a internet. Revise su conexión y toque Reintentar.",
  },
  token: {
    en: "Could not start speech recognition. Tap Retry.",
    es: "No se pudo iniciar el reconocimiento de voz. Toque Reintentar.",
  },
  stt: {
    en: "Speech recognition was interrupted. Tap Retry and speak again.",
    es: "Se interrumpió el reconocimiento de voz. Toque Reintentar y hable de nuevo.",
  },
  translate: {
    en: "The translation failed. Tap Retry.",
    es: "Falló la traducción. Toque Reintentar.",
  },
};
