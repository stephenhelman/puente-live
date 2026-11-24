import type { LightKey } from "./status";

export interface Bi {
  en: string;
  es: string;
}

/** The operator's words (control bar only; none of this is ever drawn in the caption area). */
export const T = {
  pause: { en: "Pause", es: "Pausar" },
  resume: { en: "Resume", es: "Reanudar" },
  clear: { en: "Clear", es: "Borrar" },
  transcript: { en: "Transcript", es: "Transcripción" },
  signIn: { en: "Sign in", es: "Iniciar sesión" },
  pickInput: { en: "Pick the audio input that carries the meeting (virtual cable):", es: "Elija la entrada de audio que lleva la reunión (cable virtual):" },
  noInputs: { en: "No audio inputs found. Install the virtual cable and route the meeting to it.", es: "No hay entradas de audio. Instale el cable virtual y envíe la reunión a él." },
  unnamed: { en: "Audio input", es: "Entrada de audio" },
  notFound: { en: "No input matches the device name in the URL.", es: "Ninguna entrada coincide con el nombre del dispositivo en la URL." },
  hotkeys: { en: "P pause · C clear", es: "P pausar · C borrar" },
} satisfies Record<string, Bi>;

export const LIGHT: Record<LightKey, Bi> = {
  listening: { en: "Listening", es: "Escuchando" },
  paused: { en: "Paused", es: "En pausa" },
  starting: { en: "Starting…", es: "Iniciando…" },
  reconnecting: { en: "Reconnecting…", es: "Reconectando…" },
  "no-device": { en: "No audio input", es: "Sin entrada de audio" },
  "signed-out": { en: "Signed out", es: "Sesión cerrada" },
  failed: { en: "Speech service down, retrying", es: "Servicio de voz caído, reintentando" },
  offline: { en: "No internet", es: "Sin internet" },
};
