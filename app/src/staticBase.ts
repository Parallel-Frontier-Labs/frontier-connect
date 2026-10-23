/** Where the card's static files (fonts, file viewers) live. The built card carries the literal
 * placeholder; the server that serves the card replaces it with its own origin's static path. */
const PLACEHOLDER_PREFIX = '__';

export function staticBase(): string | null {
  const v = document.documentElement.dataset.static ?? '';
  if (!v || v.startsWith(PLACEHOLDER_PREFIX)) return null;
  try {
    return new URL(v).protocol === 'https:' ? v.replace(/\/+$/, '') : null;
  } catch {
    return null;
  }
}

export function staticUrl(file: string): string | null {
  const base = staticBase();
  return base ? `${base}/${file}` : null;
}
