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

// Evil text that is shown on purpose must arrive as text: escaped, never an element.
const asText = (c: { container: Element }) => {
  expect(c.container.querySelector('img')).toBeNull();
  expect(c.container.innerHTML).not.toMatch(/<img/i);
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

  it('hostile credits never render NaN, Infinity or a negative figure', () => {
    for (const credits of ['9', NaN, Infinity, -5, 1e300, {}, [3]]) {
      const c = cardOf({ status: 'done', credits });
      expect(c.container.textContent).not.toMatch(/credit|NaN|Infinity|-\d/);
      c.unmount?.();
    }
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

  it('deliverable paths: absolute, drive, url, parent and overlong paths fall back to the name', () => {
    const p = parsePayload({
      ...base, status: 'done',
      deliverables: [
        { name: 'a.pdf', path: '/root/x/a.pdf' }, { name: 'b.pdf', path: 'C:\\x\\b.pdf' }, { name: 'c.pdf', path: 'https://e.test/c.pdf' },
        { name: 'd.pdf', path: '../../d.pdf' }, { name: 'e.pdf', path: 'x/'.repeat(200) + 'e.pdf' }, { name: 'f.pdf', path: { a: 1 } },
        { name: 'g.pdf', path: 'Review\\./g.pdf' }, { name: 'h.pdf', path: '~/h.pdf' }, { name: '', path: 'z' },
        { name: 'i.pdf', path: 'Review/other.pdf' },
      ],
    })!;
    // A path whose last segment is not the file's name shows the name alone (the backend's rule).
    expect(p.deliverables.map((d) => d.path)).toEqual(['a.pdf', 'b.pdf', 'c.pdf', 'd.pdf', 'e.pdf', 'f.pdf', 'Review/g.pdf', 'h.pdf', 'i.pdf']);
    const c = render(<Card payload={p} />);
    noMarkup(c);
    expect(c.container.querySelector('a')).toBeNull();
  });

  it('deliverables and skills are capped, skills are plain strings', () => {
    const p = parsePayload({
      ...base,
      deliverables: Array.from({ length: 300 }, (_, i) => ({ name: `f${i}.md`, path: `f${i}.md` })),
      skills: [...Array.from({ length: 30 }, () => ({ playbook: 'P'.repeat(200), skill: 'S' })), { playbook: { x: evil }, skill: [evil] }],
    })!;
    expect(p.deliverables.length).toBe(200);
    expect(p.skills!.length).toBe(20);
    expect(p.skills![0]!.playbook.length).toBe(80);
    const q = parsePayload({ ...base, status: 'done', skills: [{ playbook: { x: evil }, skill: [evil] }, 'x', { playbook: evil, skill: 'ok' }] })!;
    expect(q.skills).toEqual([{ playbook: evil, skill: 'ok' }]);
    const c = render(<Card payload={q} />);
    noMarkup(c);
  });

  it('question content is sanitised: unknown kinds stay unanswerable, ids cannot reach the prototype', () => {
    const p = parsePayload({
      ...base, status: 'waiting_for_answer',
      open_ask: {
        kind: 'question', ask_id: 'ask_1',
        questions: [
          { id: '__proto__', kind: 'single_select', prompt: 'P', options: [{ id: 'constructor', label: evil }, { id: { a: 1 } }] },
          ...Array.from({ length: 30 }, (_, i) => ({ id: `q${i}`, kind: 'text', prompt: 'x' })),
        ],
      },
    })!;
    const q = p.open_ask!.questions!;
    expect(q.length).toBe(20);
    expect(q[0]!.id).toBeUndefined();
    expect(q[0]!.options).toEqual([{ id: undefined, label: evil, description: undefined }]);
    const c = render(<Card payload={p} answer={{ enabled: true, send: async () => ({ kind: 'accepted', payload: null }) }} />);
    asText(c);
    expect(c.queryByRole('button', { name: 'Send answer' })).toBeNull();
  });

  it('form content is sanitised: bad fields dropped, the 60-field cap holds, visibleWhen keeps known keys', () => {
    const p = parsePayload({
      ...base, status: 'waiting_for_you',
      open_ask: {
        kind: 'form', ask_id: 'ask_f',
        form: {
          title: [evil], allowDefer: 'yes',
          sections: [
            { id: 's', fields: [
              { id: 'ok', kind: 'short_text', label: evil, default: { x: 1 }, visibleWhen: { field: '__proto__', equals: 1 } },
              { id: 'n', kind: 'number', label: 'N', min: 'x', max: Infinity, default: [1, { a: 1 }, 'b'] },
              { id: 'bad', kind: 'script', label: 'x' },
              { id: { a: 1 }, kind: 'short_text' },
              { id: 'v', kind: 'toggle', label: 'V', visibleWhen: { field: 'ok', oneOf: ['a', { b: 1 }, 2], truthy: 'yes', html: evil } },
            ] },
            { id: 't', fields: Array.from({ length: 80 }, (_, i) => ({ id: `f${i}`, kind: 'short_text', label: 'x' })) },
          ],
        },
      },
    })!;
    const f = p.open_ask!.form!;
    expect(f.title).toBeUndefined();
    expect(f.allowDefer).toBe(false);
    const [s1, s2] = f.sections;
    expect(s1!.fields.map((x) => x.id)).toEqual(['ok', 'n', 'v']);
    expect(s1!.fields[0]!.default).toBeUndefined();
    expect(s1!.fields[0]!.visibleWhen).toBeUndefined();
    expect(s1!.fields[1]!.min).toBeUndefined();
    expect(s1!.fields[1]!.max).toBeUndefined();
    expect(s1!.fields[1]!.default).toEqual([1, 'b']);
    expect(s1!.fields[2]!.visibleWhen).toEqual({ field: 'ok', oneOf: ['a', 2] });
    expect(s1!.fields.length + s2!.fields.length).toBe(60);
    const c = render(<Card payload={p} answer={{ enabled: true, send: async () => ({ kind: 'accepted', payload: null }) }} />);
    asText(c);
  });

  it('events keep only seq, kind, text and a string code', () => {
    const p = parsePayload({
      ...base,
      events: [{ seq: 1, kind: 'narration', text: evil, data: { code: 5 } }, { seq: 'x', kind: 'narration', text: 'a' }, { seq: 2, kind: 'error', text: { a: 1 }, data: { code: 'run_timeout', extra: evil } }, 7],
    })!;
    expect(p.events).toEqual([{ seq: 1, kind: 'narration', text: evil }, { seq: 2, kind: 'error', text: '', code: 'run_timeout' }]);
    const c = render(<Card payload={p} />);
    asText(c);
    expect(c.container.textContent).toContain(evil);
  });

  it('accepted and reason are kept only with the right types', () => {
    expect(parsePayload({ ...base, accepted: 'true', reason: { a: 1 } })).not.toHaveProperty('accepted');
    const p = parsePayload({ ...base, accepted: false, reason: 'r'.repeat(500) })!;
    expect(p.accepted).toBe(false);
    expect(p.reason!.length).toBe(300);
  });

  it('pattern is never kept; date bounds only as real YYYY-MM-DD days', () => {
    const p = parsePayload({ ...base, open_ask: { kind: 'form', ask_id: 'a', form: { sections: [{ id: 's', fields: [
      { id: 'a', kind: 'short_text', label: 'A', pattern: '^(a+)+$' },
      { id: 'd', kind: 'date', label: 'D', min: '2026-01-01', max: '2026-02-30' },
      { id: 'e', kind: 'date', label: 'E', min: 5, max: { a: 1 } },
      { id: 'f', kind: 'number', label: 'F', min: '2026-01-01' },
    ] }] } } })!;
    const [a, d, e, f] = p.open_ask!.form!.sections[0]!.fields;
    expect(a).not.toHaveProperty('pattern');
    expect([d!.minDate, d!.maxDate]).toEqual(['2026-01-01', undefined]);
    expect([e!.minDate, e!.maxDate]).toEqual([undefined, undefined]);
    expect(f!.minDate).toBeUndefined();
  });

  it('parsing is idempotent: the host bridge and the poller both parse, nothing is lost the second time', () => {
    const raw = {
      ...base, status: 'error', org: 'Acme', turn: 2,
      events: [{ seq: 3, kind: 'error', text: 'x', data: { code: 'connection_lost' } }, { seq: 4, kind: 'narration', text: 'n' }],
      deliverables: [{ name: 'a.md', path: 'R/a.md' }], skills: [{ playbook: 'P', skill: 'S' }],
      open_ask: { kind: 'form', ask_id: 'f', form: { title: 'T', allowDefer: true, sections: [{ id: 's', fields: [
        { id: 'd', kind: 'date', label: 'D', min: '2026-01-01', max: '2026-12-31', default: '2026-05-05' },
        { id: 'n', kind: 'number', label: 'N', min: 1, max: 9, visibleWhen: { field: 'd', truthy: true } },
      ] }] } },
      usage: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 3, total_tokens: 6 },
    };
    const once = parsePayload(raw)!;
    expect(parsePayload(once)).toEqual(once);
    expect(once.events[0]!.code).toBe('connection_lost');
  });

  it('only known error codes are carried, through both passes, and the friendly line renders', () => {
    const p = parsePayload(parsePayload({ ...base, status: 'error', events: [
      { seq: 1, kind: 'error', text: 'raw internal text', data: { code: 'sandbox_unavailable' } },
    ] }))!;
    expect(p.events[0]!.code).toBe('sandbox_unavailable');
    const c = render(<Card payload={p} />);
    c.getByText("The task's workspace wasn't available.");
    expect(c.container.textContent).not.toContain('raw internal text');
    cleanup();
    const q = parsePayload({ ...base, events: [{ seq: 1, kind: 'error', text: 't', data: { code: 'made_up' } }, { seq: 2, kind: 'error', text: 't', code: 'run_timeout' }] })!;
    expect(q.events.map((e) => e.code)).toEqual([undefined, 'run_timeout']);
  });
});
