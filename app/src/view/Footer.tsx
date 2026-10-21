import { useState } from 'preact/hooks';
import { formatCredits, formatTokens, formatWork } from '../format';
import type { TaskPayload } from '../types';
import { BookIcon, Chevron, ClockIcon, CreditsIcon, TokensIcon } from './icons';

/** Two letters for a playbook badge: the first letters of its first two words. */
export function initials(name: string): string {
  const words = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const s = words.length > 1 ? words[0]![0]! + words[1]![0]! : (words[0] ?? '?').slice(0, 2);
  return s.toUpperCase();
}

/** Duration (the engine's work time), credits used, one total token number, and the skills the run used. */
export function Footer({ payload: p }: { payload: TaskPayload }) {
  const [open, setOpen] = useState(false);
  const { usage, work_ms } = p;
  const skills = p.skills ?? [];
  // The server's total follows the dashboard's Model mix rule; the plain sum is the fallback.
  const tokens = usage ? (usage.total_tokens ?? usage.input_tokens + usage.output_tokens) : null;
  const credits = typeof p.credits === 'number' ? p.credits : null;
  return (
    <>
      <footer class="fc-foot fc-mono">
        <span class="fc-meta"><ClockIcon />{formatWork(work_ms)}</span>
        {credits !== null ? (
          <span class="fc-meta" title="Credits used" aria-label={`Credits used: ${formatCredits(credits)}`}>
            <CreditsIcon />{formatCredits(credits)}
          </span>
        ) : null}
        {tokens !== null ? <span class="fc-meta"><TokensIcon />{formatTokens(tokens)}</span> : null}
        {skills.length ? (
          <button type="button" class="fc-skb" aria-expanded={open} aria-controls="fc-skills" onClick={() => setOpen(!open)}>
            <BookIcon />
            {skills.length === 1 ? '1 skill' : `${skills.length} skills`}
            <Chevron dir={open ? 'up' : 'down'} size={11} />
          </button>
        ) : null}
      </footer>
      {skills.length && open ? (
        <div id="fc-skills" class="fc-skills">
          <ul aria-label="Skills used">
            {skills.map((s, i) => (
              <li key={i} class="fc-skrow">
                <span class={`fc-pbg fc-pbg-${i % 2}`} aria-hidden="true">{initials(s.playbook || s.skill)}</span>
                {s.playbook ? <span class="fc-faint">{s.playbook}</span> : null}
                {s.playbook && s.skill ? <span class="fc-sep" aria-hidden="true">›</span> : null}
                {s.skill ? <span class="fc-skname">{s.skill}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
