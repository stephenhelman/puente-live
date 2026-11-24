import { Fragment } from "react";
import type { CaptionView } from "./captionView";
import styles from "./present.module.css";

/**
 * The caption area, and nothing else. Its ONLY data input is a CaptionView (captions plus the live interim): it has no prop
 * through which an error, a status or a debug value could reach the broadcast. The strip's height is fixed by CSS, so it
 * never reflows whatever the view holds.
 */
export default function CaptionStrip({ view }: { view: CaptionView }) {
  const on = view.lines.length > 0 || view.original !== null;
  return (
    <section className={`${styles.strip} ${on ? styles.on : ""}`} aria-hidden="true">
      <p className={styles.orig} lang={view.original?.lang ?? undefined}>
        {view.original?.lang && <span className={styles.tag}>{view.original.lang.toUpperCase()}</span>}
        {view.original?.text ?? " "}
      </p>
      <div className={styles.trans}>
        <p>
          {view.lines.map((l) => (
            <Fragment key={l.id}>
              {l.tag && <span className={styles.tag}>{l.lang.toUpperCase()}</span>}
              <span className={styles.box} lang={l.lang}>{l.text} </span>
            </Fragment>
          ))}
        </p>
      </div>
    </section>
  );
}
