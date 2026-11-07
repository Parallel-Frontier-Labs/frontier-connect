import type { PromptOutcome } from './bridge';

/** The prompt route, if `url` is one: https, path ending in /prompt. */
export function promptUrl(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /\/prompt$/.test(u.pathname) ? u.toString() : null;
  } catch {
    return null;
  }
}

/** The task's prompt over its prompt key (from the tool result's `_meta`), straight from the card to
 * the server (spec 2026-11-07): the prompt never goes through the host. A host that blocks the
 * card's own requests, or a result without the key, simply gets no prompt section. */
export async function fetchPrompt(
  view: { url: string; token: string } | null | undefined,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<PromptOutcome> {
  const url = view ? promptUrl(view.url) : null;
  if (!view || !url) return { kind: 'failed' };
  try {
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${view.token}` }, credentials: 'omit', cache: 'no-store' });
    if (r.status === 404) return { kind: 'gone' };
    if (!r.ok) return { kind: 'failed' };
    const body = (await r.json()) as { prompt?: unknown; truncated?: unknown } | null;
    if (typeof body?.prompt !== 'string') return { kind: 'failed' };
    return { kind: 'ok', prompt: body.prompt.slice(0, 20_000), truncated: body.truncated === true };
  } catch {
    return { kind: 'failed' };
  }
}
