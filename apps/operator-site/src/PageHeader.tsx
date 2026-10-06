import { useEffect, useRef } from "react";

/** Whether a page's heading takes focus when the page appears. */
export type FocusOnArrival = { focusHeading: boolean };

export function PageHeader({
  eyebrow,
  title,
  focusHeading,
}: { eyebrow: string; title: string } & FocusOnArrival) {
  const heading = useRef<HTMLHeadingElement>(null);
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
