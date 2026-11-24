import { CaptureError } from "./capture";

export interface AudioInputInfo {
  deviceId: string;
  /** Empty when the browser hides labels (no permission yet, or an embedded browser that never exposes them). */
  label: string;
}

/** The device the operator picked from the list (used only when the URL names no device). */
export const SAVED_DEVICE_KEY = "puente.present.deviceId";

const ALIASES = new Set(["default", "communications"]);

/**
 * The input whose label contains `part` (case-insensitive). An exact label beats a prefix, which beats a substring; the
 * browser's "default" / "communications" aliases are only used when nothing else matches (they point at whatever the system
 * default is, which may be a microphone).
 */
export function matchDevice(list: AudioInputInfo[], part: string): AudioInputInfo | null {
  const want = part.trim().toLowerCase();
  if (!want) return null;
  const labelled = list.filter((d) => d.label);
  const score = (d: AudioInputInfo) => {
    const l = d.label.toLowerCase();
    return l === want ? 3 : l.startsWith(want) ? 2 : l.includes(want) ? 1 : 0;
  };
  const real = labelled.filter((d) => !ALIASES.has(d.deviceId) && score(d) > 0).sort((a, b) => score(b) - score(a));
  if (real[0]) return real[0];
  return labelled.filter((d) => score(d) > 0).sort((a, b) => score(b) - score(a))[0] ?? null;
}

/** Audio inputs, with labels when the page already holds (or just got) microphone permission. */
export async function listAudioInputs(): Promise<AudioInputInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) throw new CaptureError("unsupported");
  const read = async () =>
    (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput").map((d) => ({ deviceId: d.deviceId, label: d.label }));
  let list = await read();
  if (list.length > 0 && list.every((d) => !d.label)) {
    // Labels stay hidden until the page has used the microphone once. Open the default input and close it right away.
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach((t) => t.stop());
      list = await read();
    } catch {
      /* permission denied: the caller sees an unlabelled list */
    }
  }
  return list;
}

/**
 * Opens one specific input, raw: a virtual cable already carries processed meeting audio, and echo cancellation or noise
 * suppression would only damage it. Two channels are requested; the capture worklet averages them.
 */
export async function openInput(deviceId: string): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { deviceId: { exact: deviceId }, channelCount: { ideal: 2 }, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") throw new CaptureError("mic-denied");
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") throw new CaptureError("mic-missing");
    throw new CaptureError("mic-failed");
  }
}
