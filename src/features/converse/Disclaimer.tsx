"use client";

import { S } from "./strings";
import styles from "./converse.module.css";

/** Entry screen: both languages at once, acknowledged once per browser session. */
export default function Disclaimer({ onAcknowledge }: { onAcknowledge: () => void }) {
  return (
    <main className={styles.welcome}>
      <div className={styles.welcomeCard}>
        <h1>
          {S.welcomeTitle.en} / {S.welcomeTitle.es}
        </h1>
        <section lang="en">
          <p className={styles.warn}>{S.disclaimerBody.en}</p>
          <p>{S.privacyNote.en}</p>
        </section>
        <section lang="es">
          <p className={styles.warn}>{S.disclaimerBody.es}</p>
          <p>{S.privacyNote.es}</p>
        </section>
        <button type="button" className={styles.ack} onClick={onAcknowledge}>
          {S.acknowledge.en} / {S.acknowledge.es}
        </button>
      </div>
    </main>
  );
}
