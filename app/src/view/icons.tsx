/** Inline SVG icons drawn from the card design. Colours come from CSS custom properties. */

/** The Frontier mark (three skewed bars), theme-aware through --mark-bg / --mark-fg. */
export function Mark() {
  return (
    <svg class="fc-logo" width="28" height="28" viewBox="0 0 100 100" role="img" aria-label="Frontier">
      <rect width="100" height="100" rx="22" fill="var(--mark-bg)" />
      <g transform="translate(0 20.2) skewY(-22)" fill="var(--mark-fg)">
        <rect x="30.5" y="22.75" width="39" height="13.5" />
        <rect x="23" y="43.25" width="54" height="13.5" />
        <rect x="30.5" y="63.75" width="39" height="13.5" />
      </g>
    </svg>
  );
}

export function DoneDot({ size = 18, label = 'Done' }: { size?: number; label?: string | null }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}>
      <circle cx="9" cy="9" r="9" fill="var(--ok)" />
      <path d="M5.4 9.2l2.4 2.3 4.8-4.9" fill="none" stroke="var(--on-ok)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function ChosenDot() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" role="img" aria-label="Your answer">
      <circle cx="9" cy="9" r="9" fill="var(--fg)" />
      <path d="M5.4 9.2l2.4 2.3 4.8-4.9" fill="none" stroke="var(--card)" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function QueuedDot({ size = 18, label = 'Queued' }: { size?: number; label?: string | null }) {
  return (
    <svg width={size} height={size} viewBox="0 0 18 18" {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}>
      <circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--rule)" stroke-width="1.5" />
    </svg>
  );
}

export function NotRunDot() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" role="img" aria-label="Not run">
      <circle cx="9" cy="9" r="7.5" fill="none" stroke="var(--rule)" stroke-width="1.5" />
      <path d="M6 9h6" stroke="var(--faint)" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  );
}

export function PausedDot() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" role="img" aria-label="Paused, waiting for you">
      <circle cx="9" cy="9" r="8" fill="var(--warn-bg)" stroke="var(--warn-dot)" stroke-width="1.4" />
      <path d="M7.2 6v6M10.8 6v6" stroke="var(--warn-ink)" stroke-width="1.6" stroke-linecap="round" />
    </svg>
  );
}

export function FailedDot() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" role="img" aria-label="Failed here">
      <circle cx="9" cy="9" r="8" fill="var(--bad-bg)" stroke="var(--bad)" stroke-width="1.4" />
      <path d="M6.6 6.6l4.8 4.8M11.4 6.6l-4.8 4.8" stroke="var(--bad)" stroke-width="1.5" stroke-linecap="round" />
    </svg>
  );
}

/** Three small dots: the stand-in for collapsed steps. */
export function Ellipsis({ done }: { done: boolean }) {
  const fill = done ? 'var(--ok)' : 'var(--rule)';
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="5" cy="9" r="1.5" fill={fill} />
      <circle cx="9" cy="9" r="1.5" fill={fill} />
      <circle cx="13" cy="9" r="1.5" fill={fill} />
    </svg>
  );
}

/** The live "now" marker: a solid core with a soft pulsing halo. */
export function Now({ small = false, label = 'In progress' }: { small?: boolean; label?: string | null }) {
  return (
    <span class={small ? 'fc-now fc-now-sm' : 'fc-now'} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': 'true' })}>
      <span class="fc-halo" />
      <span class="fc-core" />
    </span>
  );
}

export function Chevron({ dir = 'down', size = 12 }: { dir?: 'down' | 'up' | 'right'; size?: number }) {
  const rot = dir === 'up' ? 180 : dir === 'right' ? -90 : 0;
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style={rot ? { transform: `rotate(${rot}deg)` } : undefined}>
      <path d="M3 4.5l3 3 3-3" />
    </svg>
  );
}

export function TreeChevron({ open }: { open: boolean }) {
  return (
    <svg class="fc-tchev" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--faint)" stroke-width="1.6" aria-hidden="true" style={open ? { transform: 'rotate(90deg)' } : undefined}>
      <path d="M5 3l4 4-4 4" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function FolderIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--muted)" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true" style={{ flex: 'none' }}>
      <path d="M1.8 4.2a1 1 0 011-1h3.3l1.5 1.6h5.6a1 1 0 011 1v6.5a1 1 0 01-1 1H2.8a1 1 0 01-1-1z" />
    </svg>
  );
}

export function CloudIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="var(--muted)" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
      <path d="M4.5 12.5h7.2a2.8 2.8 0 00.4-5.6A3.8 3.8 0 004.8 6a3.3 3.3 0 00-.3 6.5z" />
    </svg>
  );
}

export function DownloadIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
      <path d="M7 2v7M4 6.5L7 9.5l3-3M2.5 11.5h9" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function ClockIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--faint-ink)" stroke-width="1.4" aria-hidden="true">
      <circle cx="7" cy="7" r="5.5" />
      <path d="M7 4v3.2l2 1.3" stroke-linecap="round" />
    </svg>
  );
}

export function TokensIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--faint-ink)" stroke-width="1.4" aria-hidden="true">
      <path d="M2 4.5h10M2 7h10M2 9.5h6" stroke-linecap="round" />
    </svg>
  );
}

export function CreditsIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--faint-ink)" stroke-width="1.4" aria-hidden="true">
      <circle cx="7" cy="7" r="5.2" />
      <path d="M7 4.6v4.8M5.6 5.8h2.1a.9.9 0 0 1 0 1.2H6.3a.9.9 0 0 0 0 1.2h2.1" stroke-linecap="round" stroke-linejoin="round" />
    </svg>
  );
}

export function BookIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="var(--faint-ink)" stroke-width="1.4" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.5 2.5h3.2A1.8 1.8 0 017 4.3v7.2a1.4 1.4 0 00-1.4-1.4H2.5zM11.5 2.5H8.3A1.8 1.8 0 007 4.3v7.2a1.4 1.4 0 011.4-1.4h3.1z" />
    </svg>
  );
}

export function QuestionIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--warn-ink)" stroke-width="1.6" aria-hidden="true">
      <circle cx="9" cy="9" r="7.5" />
      <path d="M7 7.1a2 2 0 013.9.6c0 1.3-1.9 1.6-1.9 2.8" />
      <circle cx="9" cy="12.9" r=".6" fill="var(--warn-ink)" stroke="none" />
    </svg>
  );
}

export function FileIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--warn-ink)" stroke-width="1.6" aria-hidden="true">
      <path d="M5 2h6l3 3v11H5z" stroke-linejoin="round" />
      <path d="M11 2v3h3" />
    </svg>
  );
}

export function ArrowIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M3 7h8M7.5 3.5L11 7l-3.5 3.5" />
    </svg>
  );
}

export function TickIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="var(--ok)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M2.5 7.3l2.6 2.6 6.2-6.3" />
    </svg>
  );
}

export function AlertIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="var(--bad)" stroke-width="1.6" aria-hidden="true" style={{ flex: 'none', marginTop: '1px' }}>
      <circle cx="9" cy="9" r="7.5" />
      <path d="M9 5.2v4.6" stroke-linecap="round" />
      <circle cx="9" cy="12.6" r=".7" fill="var(--bad)" stroke="none" />
    </svg>
  );
}
