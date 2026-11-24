"use client";

import { useEffect, useRef, useState } from "react";
import type { Lang } from "@/engine";
import type { GlossaryProfile } from "@/engine";
import { paneRole } from "./focus";
import { PHRASES, phraseText } from "./phrases";
import { autoStopText, ERRORS, S } from "./strings";
import type { WakeLockStatus } from "./useWakeLock";
import type { Conversation, ConvTurn, Segment } from "./useConversation";
import styles from "./converse.module.css";

const VISIBLE_TURNS = 4;

/**
 * What the listener may see of a turn. Translations appear strictly in spoken order: a phrase is hidden until
 * every earlier phrase has finished (or failed), so a fast later translation can never show up above a slow one.
 */
function visibleSegments(segments: Segment[]): Segment[] {
  const out: Segment[] = [];
  for (const s of segments) {
    out.push(s);
    if (s.status === "translating") break;
  }
  return out;
}

type Shown = { turn: ConvTurn; own: true; text: string; tail: string } | { turn: ConvTurn; own: false; segs: Segment[] };

function shownFor(turn: ConvTurn, lang: Lang): Shown | null {
  if (turn.speaker === lang) {
    const text = turn.segments.map((s) => s.source).join(" ");
    return text || turn.tail ? { turn, own: true, text, tail: turn.tail } : null;
  }
  const segs = visibleSegments(turn.segments);
  return segs.length ? { turn, own: false, segs } : null;
}

/** The glossary setting: one profile for the whole conversation, shared by both halves. */
export interface ProfileSetting {
  value: GlossaryProfile;
  /** ?profile= in the address decides it: the control is shown but cannot be changed. */
  locked: boolean;
  onChange: (p: GlossaryProfile) => void;
}

/** One person's half of the screen, rendered entirely in that person's language. */
export default function Half({ lang, conv, wake, profile }: { lang: Lang; conv: Conversation; wake: WakeLockStatus; profile: ProfileSetting }) {
  const { phase, side, turns, error, notice, silenceLeft, idleSec } = conv;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const pinned = useRef(true); // follow the newest text unless the reader scrolled back up
  const t = (k: keyof typeof S) => S[k][lang];

  const mine = side === lang;
  const role = paneRole(side, lang);
  const idle = phase === "idle";
  const recordingMine = phase === "recording" && mine;

  const { label, disabled } = talkState();

  function talkState(): { label: string; disabled: boolean } {
    if (idle) return { label: t("tapToSpeak"), disabled: false };
    if (mine && phase === "starting") return { label: t("starting"), disabled: true };
    if (recordingMine) {
      // The only limit is silence: when nobody has spoken for a while, say how long until the turn stops by itself.
      const warn = silenceLeft !== null;
      return { label: warn ? `${t("silenceWarn")} ${silenceLeft}${t("secondsShort")}` : t("listening"), disabled: false };
    }
    if (mine) return { label: t("translating"), disabled: true };
    return { label: phase === "processing" ? t("waitOtherTranslating") : t("waitOtherSpeaking"), disabled: true };
  }

  const visible = turns.map((t) => shownFor(t, lang)).filter((x): x is Shown => x !== null).slice(-VISIBLE_TURNS);
  const showError = error !== null;
  const showHint = visible.length === 0;

  // Keep the newest text in view as phrases stream in, but never yank the view while someone reads older text.
  useEffect(() => {
    const el = historyRef.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  });
  // The half grows and shrinks when a turn starts and ends. A reader who is following the newest text stays glued to it
  // through the animation (the scroll position is re-applied on every size change); a reader who scrolled back up keeps
  // exactly what they were reading, because their scroll position is never touched.
  useEffect(() => {
    const el = historyRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => {
      if (pinned.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function onClear() {
    if (!confirmClear) {
      setConfirmClear(true);
      window.setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setConfirmClear(false);
    conv.clear();
  }

  return (
    <section
      lang={lang}
      data-role={role}
      className={`${styles.half} ${lang === "en" ? styles.en : styles.es} ${role === "speaker" ? styles.speaker : role === "listener" ? styles.listener : ""}`}
    >
      {/* Bar sits at the seam on both halves (DOM top; the Spanish half is rotated 180°). It folds away on the speaking half. */}
      <div className={styles.bar} aria-hidden={role === "speaker"}>
        <p className={styles.disclaimer}>{t("shortDisclaimer")}</p>
        <label className={styles.profile} title={profile.locked ? t("profileLocked") : undefined}>
          <select
            aria-label={t("glossary")}
            value={profile.value}
            disabled={!idle || profile.locked}
            onChange={(e) => profile.onChange(e.target.value as GlossaryProfile)}
          >
            <option value="hemophilia">{t("profileHemophilia")}</option>
            <option value="chapter">{t("profileChapter")}</option>
          </select>
        </label>
        <button type="button" className={styles.small} onClick={onClear} disabled={turns.length === 0 && !error}>
          {confirmClear ? t("clearConfirm") : t("clear")}
        </button>
      </div>

      {(wake === "unsupported" || wake === "failed") && <p className={styles.notice}>{t("screenMayDim")}</p>}
      {notice && <p className={styles.notice}>{notice === "no-speech" ? t("noSpeech") : autoStopText(lang, idleSec)}</p>}
      {showError && error && (
        <div className={styles.error} role="alert">
          <p>{ERRORS[error.kind][lang]}</p>
          <div className={styles.errorActions}>
            <button type="button" onClick={conv.retry}>
              {t("retry")}
            </button>
            <button type="button" className={styles.ghost} onClick={conv.dismissError}>
              {t("dismiss")}
            </button>
          </div>
        </div>
      )}

      <div
        ref={historyRef}
        className={styles.history}
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        {showHint && <p className={styles.hint}>{t("emptyHint")}</p>}
        {visible.map((shown, i) => {
          const age = visible.length - 1 - i; // 0 = newest
          const cls = `${styles.item} ${age > 0 ? styles.older : ""}`;
          if (shown.own) {
            return (
              <p key={shown.turn.id} className={`${cls} ${styles.own}`}>
                <span className={styles.tag}>{t("youSaid")}: </span>
                {shown.turn.segments.map((seg) => (
                  <span key={seg.id} data-src={seg.id}>
                    {seg.source}{" "}
                  </span>
                ))}
                {shown.tail && (
                  <span className={styles.tail}>{shown.tail}</span>
                )}
              </p>
            );
          }
          const last = shown.segs[shown.segs.length - 1]!;
          return (
            <p key={shown.turn.id} className={`${cls} ${styles.theirs}`}>
              {shown.segs.map((seg) =>
                seg.status === "error" ? (
                  <span key={seg.id} className={styles.segError} role="alert">
                    {t("phraseFailed")}{" "}
                    <button type="button" onClick={() => conv.retrySegment(shown.turn.id, seg.id)} disabled={phase === "recording" || phase === "starting"}>
                      {t("retry")}
                    </button>{" "}
                  </span>
                ) : (
                  <span key={seg.id} data-seg={seg.id}>
                    {seg.translation || "…"}{" "}
                  </span>
                ),
              )}
              {last.status === "translating" && last.translation && <span className={styles.caret} aria-hidden />}
            </p>
          );
        })}

      </div>

      <div className={styles.controls}>
        <button type="button" className={styles.phrasesBtn} onClick={() => setDrawerOpen((o) => !o)} disabled={!idle}>
          {t("phrases")}
        </button>
        <button
          type="button"
          className={`${styles.talk} ${recordingMine ? styles.recording : ""}`}
          disabled={disabled}
          onClick={() => {
            setDrawerOpen(false);
            conv.toggle(lang);
          }}
        >
          <span className={styles.dot} aria-hidden />
          {label}
        </button>
      </div>
      {drawerOpen && (
        <div className={styles.drawer} role="dialog" aria-label={t("phrases")}>
          <ul>
            {PHRASES.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  disabled={!idle}
                  onClick={() => {
                    conv.sayPhrase(lang, p.id);
                    setDrawerOpen(false);
                  }}
                >
                  {phraseText(p, lang)}
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className={styles.drawerClose} onClick={() => setDrawerOpen(false)}>
            {t("closePhrases")}
          </button>
        </div>
      )}
    </section>
  );
}
