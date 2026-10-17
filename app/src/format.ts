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

export function formatEta(etaS: number): string {
  if (etaS < 45) return 'Less than a minute left';
  return `About ${Math.max(1, Math.round(etaS / 60))} min left`;
}
