/** The faces the card draws with (build.mjs emits them as static files beside the card). */
export const CARD_FONTS = ['400 14px "Public Sans"', '600 14px "Public Sans"', '700 14px "Public Sans"', '400 12px "IBM Plex Mono"'];

/** How long the loading skeleton waits for the fonts before showing the card in system fonts. */
export const FONT_WAIT_MS = 1500;

export type FontsOutcome = 'loaded' | 'timeout';

/**
 * Starts loading the card's fonts now, instead of when text first uses them, and tells the card when
 * to show itself: 'loaded' once they are in (or failed: the system fonts then stay), 'timeout' after
 * `ms`; it never rejects. Null when there is nothing to wait for (no font API, or every face already
 * loaded). The fonts stay static files, not inlined: four base64 faces would push the card past its
 * 512 KB budget.
 */
export function startFonts(doc: Document = document, ms = FONT_WAIT_MS): Promise<FontsOutcome> | null {
  const fonts = (doc as { fonts?: FontFaceSet }).fonts;
  if (!fonts || typeof fonts.load !== 'function') return null;
  try {
    if (CARD_FONTS.every((f) => fonts.check(f))) return null;
  } catch {
    // check() throws on a malformed descriptor in some engines: just load.
  }
  const loads = CARD_FONTS.map((f) => {
    try {
      return Promise.resolve(fonts.load(f)).then(() => undefined, () => undefined);
    } catch {
      return Promise.resolve();
    }
  });
  return new Promise<FontsOutcome>((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    void Promise.all(loads).then(() => {
      clearTimeout(t);
      resolve('loaded');
    });
  });
}
