export function formatWork(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export function formatTokens(n: number): string {
  // 999_950 is where one decimal of k would round up to "1000.0k".
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M tokens`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k tokens`;
  return `${n} tokens`;
}

export function formatCredits(n: number): string {
  // Credits are what we bill in: exact (with a separator) below 10k, then the token rule's k/M.
  if (n >= 999_950) return `${(n / 1_000_000).toFixed(1)}M credits`;
  if (n >= 10_000) return `${(n / 1000).toFixed(1)}k credits`;
  return n === 1 ? '1 credit' : `${n.toLocaleString('en-US')} credits`;
}

export function formatEta(etaS: number): string {
  if (etaS < 45) return 'Less than a minute left';
  return `About ${Math.max(1, Math.round(etaS / 60))} min left`;
}

/** The task card's root class: `fc-card--embedded` drops its own outer border, radius and shadow
 * while the host's frame is already drawn around it, so the edges are not doubled. */
export function cardClass(embedded: boolean): string {
  return embedded ? 'fc-card fc-card--embedded' : 'fc-card';
}
