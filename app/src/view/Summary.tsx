import { useState } from 'preact/hooks';
import { Markdown } from '../markdown';
import { Chevron } from './icons';

/** Collapse gate. jsdom cannot measure layout, so the toggle is decided from the source: more than
 *  12 lines or 900 characters. The collapsed height is CSS (.fc-collapsed). */
export const COLLAPSE_CHARS = 900;
export const COLLAPSE_LINES = 12;
export const needsCollapse = (s: string): boolean => s.length > COLLAPSE_CHARS || s.split('\n').length > COLLAPSE_LINES;

export function Summary({ text, type }: { text: string; type: string }) {
  const [open, setOpen] = useState(false);
  const long = needsCollapse(text);
  return (
    <div class="fc-summary">
      <div class={long && !open ? 'fc-sum-body fc-collapsed' : 'fc-sum-body'}>
        {type === 'text' ? <p class="fc-md-p fc-plain">{text}</p> : <Markdown text={text} />}
      </div>
      {long ? (
        <button type="button" class="fc-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          {open ? 'Show less' : 'Show more'}
          <Chevron dir={open ? 'up' : 'down'} />
        </button>
      ) : null}
    </div>
  );
}
