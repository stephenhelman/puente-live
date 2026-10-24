"use client";

import { useState } from "react";
import type { Lang } from "@/engine";
import { PHRASES, phraseText } from "./phrases";
import { ERRORS, S } from "./strings";
import type { WakeLockStatus } from "./useWakeLock";
import { COUNTDOWN_FROM_SECONDS, type Conversation } from "./useConversation";
import styles from "./converse.module.css";

const VISIBLE_TURNS = 4;

/** One person's half of the screen, rendered entirely in that person's language. */
export default function Half({ lang, conv, wake }: { lang: Lang; conv: Conversation; wake: WakeLockStatus }) {
  const { phase, side, turns, interim, error, notice, secondsLeft } = conv;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const t = (k: keyof typeof S) => S[k][lang];

  const mine = side === lang;
  const idle = phase === "idle";
  const recordingMine = phase === "recording" && mine;

  const { label, disabled } = talkState();

  function talkState(): { label: string; disabled: boolean } {
    if (idle) return { label: t("tapToSpeak"), disabled: false };
    if (mine && phase === "starting") return { label: t("starting"), disabled: true };
    if (recordingMine) {
      const warn = secondsLeft <= COUNTDOWN_FROM_SECONDS;
      return { label: warn ? `${t("listening")} (${secondsLeft}${t("secondsLeft")})` : t("listening"), disabled: false };
    }
    if (mine) return { label: t("translating"), disabled: true };
    return { label: phase === "processing" ? t("waitOtherTranslating") : t("waitOtherSpeaking"), disabled: true };
  }

  const visible = turns.slice(-VISIBLE_TURNS);
  const showError = error !== null;
  const showHint = turns.length === 0 && !interim;

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
    <section lang={lang} className={`${styles.half} ${lang === "en" ? styles.en : styles.es}`}>
      {/* Bar sits at the seam on both halves (DOM top; the Spanish half is rotated 180°). */}
      <div className={styles.bar}>
        <p className={styles.disclaimer}>{t("shortDisclaimer")}</p>
        <button type="button" className={styles.small} onClick={onClear} disabled={turns.length === 0 && !error}>
          {confirmClear ? t("clearConfirm") : t("clear")}
        </button>
      </div>

      {(wake === "unsupported" || wake === "failed") && <p className={styles.notice}>{t("screenMayDim")}</p>}
      {notice && <p className={styles.notice}>{notice === "no-speech" ? t("noSpeech") : t("autoStop")}</p>}
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

      <div className={styles.history} aria-live="polite">
        {showHint && <p className={styles.hint}>{t("emptyHint")}</p>}
        {visible.map((turn, i) => {
          const age = visible.length - 1 - i; // 0 = newest
          const own = turn.speaker === lang;
          const cls = `${styles.item} ${age > 0 ? styles.older : ""}`;
          if (own) {
            return (
              <p key={turn.id} className={`${cls} ${styles.own}`}>
                <span className={styles.tag}>{t("youSaid")}: </span>
                {turn.transcript}
              </p>
            );
          }
          return (
            <p key={turn.id} className={`${cls} ${styles.theirs}`}>
              {turn.translation || (turn.status === "translating" ? "…" : "")}
              {turn.status === "translating" && turn.translation && <span className={styles.caret} aria-hidden />}
            </p>
          );
        })}
        {recordingMine && interim && <p className={`${styles.item} ${styles.own} ${styles.live}`}>{interim}</p>}

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
