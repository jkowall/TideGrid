import { type RefObject, useEffect, useRef } from "react";

/** Whether a page's heading takes focus when the page appears. */
export type FocusOnArrival = { focusHeading: boolean };

export function PageHeader({
  eyebrow,
  title,
  focusHeading,
  headingRef,
}: {
  eyebrow: string;
  title: string;
  /**
   * The heading element, for a page that hands focus back to it later, such
   * as after Try again works and its button is gone (G2.12b).
   */
  headingRef?: RefObject<HTMLHeadingElement | null>;
} & FocusOnArrival) {
  const own = useRef<HTMLHeadingElement>(null);
  const heading = headingRef ?? own;
  // Mount only: the first render decides. Each page mounts afresh (the shell
  // keys it on the path), so this runs on every page change, and on the first
  // page when the shell replaced a screen the person acted on.
  useEffect(() => {
    if (focusHeading) heading.current?.focus();
  }, []);
  return (
    <header className="console-page-header">
      <p className="tg-eyebrow">{eyebrow}</p>
      <h1 ref={heading} tabIndex={-1}>
        {title}
      </h1>
    </header>
  );
}
