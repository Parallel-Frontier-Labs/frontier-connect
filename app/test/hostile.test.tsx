import { cleanup, render } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';
import { Card } from '../src/view/Card';
import { parsePayload } from '../src/types';

afterEach(cleanup);

const evil = '<img src=x onerror=alert(1)>';
const base = { task_id: 't', status: 'running', cursor: 0, more: false, events: [] };
const cardOf = (over: Record<string, unknown>) => {
  const p = parsePayload({ ...base, ...over });
  expect(p).not.toBeNull();
  return render(<Card payload={p!} />);
};
const noMarkup = (c: { container: Element }) => {
  expect(c.container.querySelector('img')).toBeNull();
  expect(c.container.innerHTML).not.toContain('onerror');
  expect(c.container.textContent).not.toContain('[object Object]');
};

describe('hostile payloads', () => {
  it('status strings outside the enum fall back safely and never crash the label lookup', () => {
    for (const status of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'arbitrary-status', '', 'RUNNING']) {
      const p = parsePayload({ ...base, status, plan: [{ title: 'a', status }] });
      expect(p?.status).toBe('starting');
      const c = render(<Card payload={p!} />);
      noMarkup(c);
      expect(c.container.querySelector('.fc-pill')?.textContent).toBe('Starting');
      expect(c.container.querySelector('.fc-pill')?.className).toBe('fc-pill fc-pill-starting');
      cleanup();
    }
  });

  it('object-valued and array-valued titles render as the default, never markup', () => {
    for (const title of [{ toString: evil, __html: evil }, [evil], { html: evil }, 42, null]) {
      const c = cardOf({ title });
      noMarkup(c);
      expect(c.container.querySelector('.fc-title')?.textContent).toBe('Frontier task');
      cleanup();
    }
  });

  it('non-string text in every rendered field is blanked or dropped', () => {
    const o = { x: evil };
    const c = cardOf({
      status: 'done',
      live: o,
      plan: [{ title: o, status: 'bogus' }, 'junk', null],
      sections: [{ id: o, title: [evil], done: true, outcome: o }, { id: 5, title: 7, done: 'yes', outcome: [1] }],
      open_ask: {
        kind: 'question', ask_id: o, text: o,
        questions: [{ id: o, prompt: o, subPrompt: [evil], options: [{ id: o, label: o, description: [evil] }, 3] }, 'x'],
      },
      deliverables: [{ name: o }, { name: [evil] }, { name: 'report.pdf' }],
      result: { summary: o, summary_type: o, takeaway: [evil] },
      work_ms: o,
      usage: { input_tokens: o, output_tokens: '5', cached_input_tokens: null },
      estimate: { eta_s: o },
    });
    noMarkup(c);
    expect(c.container.textContent).toContain('report.pdf');
    expect(c.container.querySelectorAll('.fc-files li').length).toBe(1);
  });

  it('form and files asks with object text render nothing for it', () => {
    for (const ask of [
      { kind: 'form', form: { title: { a: evil }, description: [evil] } },
      { kind: 'files', text: { a: evil } },
    ]) {
      const c = cardOf({ open_ask: ask });
      noMarkup(c);
      cleanup();
    }
  });

  it('numbers render only when finite numbers', () => {
    const c = cardOf({ status: 'done', work_ms: 'NaN', usage: { input_tokens: Infinity, output_tokens: 10, cached_input_tokens: 0 }, estimate: { eta_s: '9' } });
    expect(c.container.textContent).toContain('0s');
    expect(c.container.textContent).toContain('10 tokens');
    expect(c.container.textContent).not.toMatch(/NaN|Infinity/);
  });

  it('structurally wrong collections do not crash the card', () => {
    const c = cardOf({ plan: 'x', sections: { a: 1 }, deliverables: 7, open_ask: 'x', result: 'x', usage: 3, view: 'x', events: 'x' });
    noMarkup(c);
  });

  it('parsePayload rejects non-payloads', () => {
    expect(parsePayload(null)).toBeNull();
    expect(parsePayload({ task_id: 1, status: 'running' })).toBeNull();
    expect(parsePayload('x')).toBeNull();
  });
});
