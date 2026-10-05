/**
 * Count the characters on each rendered line of an element's text, in the
 * browser, from the layout the reader sees. Spaces count; a space the browser
 * collapses at a line break does not.
 */
export function charactersPerLine(element: Element): number[] {
  const lines: { bottom: number; count: number }[] = [];
  const range = document.createRange();
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (let i = 0; i < text.length; i++) {
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = [...range.getClientRects()].find((r) => r.width > 0);
      if (!rect) continue;
      const line = lines.at(-1);
      // A glyph that starts below the current line's bottom opens a new line.
      if (line && rect.top < line.bottom - 1) {
        line.count++;
        line.bottom = Math.max(line.bottom, rect.bottom);
      } else {
        lines.push({ bottom: rect.bottom, count: 1 });
      }
    }
  }
  return lines.map((l) => l.count);
}

/** The range readers find comfortable for running text. */
export const comfortableLine = { min: 45, max: 75 } as const;

/**
 * Summarize a paragraph: the longest line, and the average of every line but
 * the last, which is usually short.
 */
export function measureReport(element: Element) {
  const counts = charactersPerLine(element);
  const full = counts.slice(0, -1);
  const longest = Math.max(0, ...counts);
  const average = full.length ? Math.round(full.reduce((a, b) => a + b, 0) / full.length) : longest;
  return {
    lines: counts.length,
    longest,
    average,
    ok: longest <= comfortableLine.max && (counts.length < 2 || average >= comfortableLine.min),
  };
}
