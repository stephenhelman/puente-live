/** Why a capture could not start. The UI maps each to bilingual guidance. */
export type CaptureFailure = "cancelled" | "no-audio" | "unsupported" | "mic-denied" | "mic-missing" | "mic-failed";

export class CaptureError extends Error {
  constructor(readonly kind: CaptureFailure) {
    super(kind);
  }
}

export function displayCaptureSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.mediaDevices?.getDisplayMedia;
}

/** Major Chrome version from the user agent, or null for other browsers. */
export function chromeMajor(): number | null {
  const m = /\bChrome\/(\d+)/.exec(navigator.userAgent);
  return m && !/\b(Edg|OPR)\//.test(navigator.userAgent) ? Number(m[1]) : null;
}

export function isMac(): boolean {
  return /Mac/.test(navigator.platform) && !/iPhone|iPad/.test(navigator.userAgent);
}

/**
 * Meeting audio: the user shares a tab ("Also share tab audio") or the whole screen ("Also share system audio").
 * The video track is stopped right away; only audio is used. Returns an audio-only stream.
 */
export async function captureMeetingAudio(): Promise<MediaStream> {
  if (!displayCaptureSupported()) throw new CaptureError("unsupported");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: true, // required by the API; dropped below
      // Raw audio: Zoom already processed it, and echo cancellation would try to remove it as "speaker output".
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      systemAudio: "include",
      selfBrowserSurface: "exclude",
    } as DisplayMediaStreamOptions);
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    throw new CaptureError(name === "NotAllowedError" || name === "AbortError" ? "cancelled" : "unsupported");
  }
  stream.getVideoTracks().forEach((t) => t.stop());
  const audio = stream.getAudioTracks();
  if (audio.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new CaptureError("no-audio");
  }
  return new MediaStream(audio);
}

/** Your microphone, with the browser's echo cancellation and noise suppression. */
export async function captureMic(): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") throw new CaptureError("mic-denied");
    if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") throw new CaptureError("mic-missing");
    throw new CaptureError("mic-failed");
  }
}
