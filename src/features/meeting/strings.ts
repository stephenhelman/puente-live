import type { MeetingErrorKind } from "./useMeeting";

export interface Bi {
  en: string;
  es: string;
}

export const M = {
  alreadyEn: { en: "(already in English)", es: "(ya está en inglés)" },
  alreadyEs: { en: "(already in Spanish)", es: "(ya está en español)" },
  untranslated: { en: "(untranslated)", es: "(sin traducir)" },
  throttled: {
    en: "Captions may have paused: this window was slowed down by the browser. Keep this window visible (side by side with Zoom, not behind it).",
    es: "Los subtítulos pudieron pausarse: el navegador ralentizó esta ventana. Mantenga esta ventana visible (junto a Zoom, no detrás).",
  },
  title: { en: "Meeting translation", es: "Traducción de reuniones" },
  start: { en: "Start", es: "Comenzar" },
  starting: { en: "Starting…", es: "Iniciando…" },
  stop: { en: "Stop", es: "Detener" },
  stopping: { en: "Stopping…", es: "Deteniendo…" },
  useMic: { en: "Include my microphone", es: "Incluir mi micrófono" },
  headphones: {
    en: "Use headphones: otherwise the meeting audio from your speakers is picked up by your microphone and captioned twice.",
    es: "Use audífonos: de lo contrario el micrófono capta el audio de la reunión por los altavoces y lo subtitula dos veces.",
  },
  howTitle: { en: "Before you start", es: "Antes de comenzar" },
  howTab: {
    en: "Zoom in a Chrome tab: choose the Chrome Tab, pick that tab, and turn on “Also share tab audio”.",
    es: "Zoom en una pestaña de Chrome: elija Pestaña de Chrome, seleccione esa pestaña y active «Compartir también el audio de la pestaña».",
  },
  howScreen: {
    en: "Zoom desktop app: choose Entire Screen and turn on “Also share system audio”.",
    es: "Aplicación de Zoom: elija Pantalla completa y active «Compartir también el audio del sistema».",
  },
  howMacOld: {
    en: "This Chrome is older than 141: on a Mac, the Zoom desktop app's audio cannot be captured. Update Chrome, or use Zoom in a browser tab.",
    es: "Este Chrome es anterior a la versión 141: en Mac no se puede capturar el audio de la aplicación de Zoom. Actualice Chrome o use Zoom en una pestaña del navegador.",
  },
  unsupportedBrowser: {
    en: "This browser cannot share audio. Use Chrome on a laptop.",
    es: "Este navegador no puede compartir audio. Use Chrome en una computadora portátil.",
  },
  privacy: {
    en: "Nothing is stored on the server. Captions stay in this window; download the transcript if you want to keep it. Tell participants the meeting is being translated by AI.",
    es: "No se guarda nada en el servidor. Los subtítulos quedan en esta ventana; descargue la transcripción si desea conservarla. Avise a los participantes que la reunión se traduce con IA.",
  },
  empty: {
    en: "Press Start. Captions appear here as people speak.",
    es: "Presione Comenzar. Los subtítulos aparecen aquí mientras se habla.",
  },
  listening: { en: "Listening…", es: "Escuchando…" },
  jump: { en: "Jump to live", es: "Ir al presente" },
  present: { en: "Presentation view", es: "Vista de presentación" },
  exitPresent: { en: "Exit", es: "Salir" },
  download: { en: "Download transcript", es: "Descargar transcripción" },
  clear: { en: "Clear captions", es: "Borrar subtítulos" },
  clearConfirm: { en: "Not downloaded. Tap again to erase", es: "Sin descargar. Toque otra vez para borrar" },
  clearSure: { en: "Tap again to erase", es: "Toque otra vez para borrar" },
  unsaved: { en: "Transcript not downloaded", es: "Transcripción sin descargar" },
  you: { en: "You", es: "Usted" },
  meeting: { en: "Meeting", es: "Reunión" },
  reconnecting: { en: "Reconnecting…", es: "Reconectando…" },
  failed: { en: "Connection lost", es: "Conexión perdida" },
  retry: { en: "Retry", es: "Reintentar" },
  dismiss: { en: "Dismiss", es: "Cerrar aviso" },
  phraseFailed: { en: "Could not translate this.", es: "No se pudo traducir esto." },
  warnSoon: {
    en: "This session ends soon (time limit). Stop and start again to continue.",
    es: "Esta sesión terminará pronto (límite de tiempo). Detenga y comience de nuevo para continuar.",
  },
  limitReached: { en: "Session limit reached.", es: "Se alcanzó el límite de la sesión." },
  earlier: { en: "Earlier captions are kept for the transcript.", es: "Los subtítulos anteriores se conservan para la transcripción." },
  disclaimer: {
    en: "AI translation. Not for clinical, legal, or consent situations.",
    es: "Traducción con IA. No para situaciones clínicas, legales o de consentimiento.",
  },
  reshare: { en: "Share meeting audio again", es: "Compartir de nuevo el audio de la reunión" },
} satisfies Record<string, Bi>;

export const E: Record<MeetingErrorKind, Bi> = {
  "no-audio": {
    en: "No audio was shared. Choose again and turn on “Also share tab audio” (for a Chrome tab) or “Also share system audio” (for Entire Screen) in Chrome's window.",
    es: "No se compartió audio. Elija de nuevo y active «Compartir también el audio de la pestaña» (para una pestaña de Chrome) o «Compartir también el audio del sistema» (para Pantalla completa) en la ventana de Chrome.",
  },
  cancelled: {
    en: "Sharing was cancelled. Press Start and choose what to share.",
    es: "Se canceló el uso compartido. Presione Comenzar y elija qué compartir.",
  },
  unsupported: {
    en: "This browser cannot share audio. Use Chrome on a laptop.",
    es: "Este navegador no puede compartir audio. Use Chrome en una computadora portátil.",
  },
  "mic-denied": {
    en: "The microphone is blocked, so only the meeting is being captioned. Allow it in Chrome's site settings, then Stop and Start.",
    es: "El micrófono está bloqueado, así que solo se subtitula la reunión. Permítalo en la configuración del sitio de Chrome, luego Detenga y Comience.",
  },
  "mic-missing": {
    en: "No microphone found, so only the meeting is being captioned.",
    es: "No se encontró micrófono, así que solo se subtitula la reunión.",
  },
  "mic-failed": {
    en: "The microphone stopped, so it is no longer captioned.",
    es: "El micrófono se detuvo y ya no se subtitula.",
  },
  offline: {
    en: "No internet connection. Check your connection, then Retry.",
    es: "Sin conexión a internet. Revise su conexión y toque Reintentar.",
  },
  token: {
    en: "Could not start speech recognition. Retry.",
    es: "No se pudo iniciar el reconocimiento de voz. Reintente.",
  },
  stt: {
    en: "Speech recognition was interrupted and could not reconnect. Stop and Start again; captions so far are kept.",
    es: "Se interrumpió el reconocimiento de voz y no pudo reconectarse. Detenga y comience de nuevo; los subtítulos anteriores se conservan.",
  },
};

/** Shown when the meeting's audio track ends mid-session (the user pressed Chrome's "Stop sharing"). */
export const MEETING_ENDED: Bi = {
  en: "Meeting audio stopped (sharing ended).",
  es: "Se detuvo el audio de la reunión (se terminó de compartir).",
};
