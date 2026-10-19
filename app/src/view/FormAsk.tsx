import { useMemo, useState } from 'preact/hooks';
import { initialValues, isFieldVisible, own, validateForm, valueOf, visibleValues, type FieldValue, type FormValues } from '../form';
import type { Field, FormSpec, OpenAsk } from '../types';
import { useSend, type SendProps } from './useSend';

const OTHER = '\u0000other';

/** Fold the Other free text into the values the task receives. */
function merged(spec: FormSpec, values: FormValues, otherOn: Record<string, boolean>, otherText: Record<string, string>): FormValues {
  const out: FormValues = { ...values };
  for (const s of spec.sections) {
    for (const f of s.fields) {
      const t = (own(otherText, f.id) ?? '').trim();
      if ((f.kind === 'radio' || f.kind === 'select') && own(otherOn, f.id)) out[f.id] = t;
      else if (f.kind === 'multi_select' && t) out[f.id] = [...((valueOf(values, f.id) as string[] | undefined) ?? []), t];
    }
  }
  return out;
}

const optionLabel = (f: Field, id: string) => f.options.find((o) => o.id === id)?.label ?? id;

/** One line per answered field, for the locked view after submit. */
export function formSummary(spec: FormSpec, values: FormValues): string {
  const parts: string[] = [];
  for (const s of spec.sections) {
    for (const f of s.fields) {
      if (!isFieldVisible(f, values)) continue;
      const v = valueOf(values, f.id);
      if (f.kind !== 'toggle' && (v === undefined || v === '' || (Array.isArray(v) && !v.length))) continue;
      let text: string;
      if (f.kind === 'toggle') text = v === true ? f.onLabel || 'Yes' : f.offLabel || 'No';
      else if (Array.isArray(v)) text = v.map((id) => optionLabel(f, id)).join(', ');
      else if (f.kind === 'select' || f.kind === 'radio') text = optionLabel(f, String(v));
      else text = `${v}${f.unit && typeof v === 'number' ? ` ${f.unit}` : ''}`;
      parts.push(`${f.label}: ${text}`);
    }
  }
  return parts.join('\n');
}

interface Ctl {
  field: Field;
  value: FieldValue | undefined;
  set: (v: FieldValue | undefined) => void;
  otherOn: boolean;
  setOtherOn: (on: boolean) => void;
  otherText: string;
  setOtherText: (t: string) => void;
  invalid: boolean;
  describedBy?: string;
  disabled: boolean;
}

function Control(c: Ctl) {
  const { field: f, value, set, invalid, describedBy, disabled } = c;
  const aria = { 'aria-invalid': invalid ? ('true' as const) : undefined, 'aria-describedby': describedBy };
  const cls = invalid ? 'fc-ctl fc-bad' : 'fc-ctl';
  const str = typeof value === 'string' ? value : '';
  switch (f.kind) {
    case 'short_text':
    case 'email':
    case 'url':
    case 'phone': {
      const type = f.kind === 'short_text' ? 'text' : f.kind === 'phone' ? 'tel' : f.kind;
      return (
        <input id={`f-${f.id}`} class={`${cls} fc-wide`} type={type} disabled={disabled} placeholder={f.placeholder} maxLength={f.maxLength ?? 2000}
          value={str} onInput={(e) => set((e.target as HTMLInputElement).value)} {...aria} />
      );
    }
    case 'long_text':
      return (
        <textarea id={`f-${f.id}`} class={`${cls} fc-area fc-wide`} disabled={disabled} rows={Math.min(Math.max(f.rows ?? 3, 2), 8)} placeholder={f.placeholder}
          maxLength={f.maxLength ?? 4000} value={str} onInput={(e) => set((e.target as HTMLTextAreaElement).value)} {...aria} />
      );
    case 'number':
      return (
        <div class="fc-inline">
          <input id={`f-${f.id}`} class={`${cls} fc-num`} type="number" disabled={disabled} min={f.min} max={f.max} step={f.step} placeholder={f.placeholder}
            value={typeof value === 'number' ? String(value) : ''}
            onInput={(e) => {
              const raw = (e.target as HTMLInputElement).value;
              const n = Number(raw);
              set(raw === '' ? undefined : Number.isFinite(n) ? n : raw);
            }} {...aria} />
          {f.unit ? <span class="fc-unit">{f.unit}</span> : null}
        </div>
      );
    case 'date':
      return <input id={`f-${f.id}`} class={`${cls} fc-date`} type="date" disabled={disabled} min={f.minDate} max={f.maxDate} value={str} onInput={(e) => set((e.target as HTMLInputElement).value)} {...aria} />;
    case 'select':
      return (
        <div class="fc-stack">
          <select id={`f-${f.id}`} class={`${cls} fc-select`} disabled={disabled} value={c.otherOn ? OTHER : str}
            onChange={(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v === OTHER) c.setOtherOn(true);
              else { c.setOtherOn(false); set(v || undefined); }
            }} {...aria}>
            <option value="">Choose…</option>
            {f.options.map((o, i) => <option key={o.id ?? i} value={o.id ?? ''}>{o.label ?? o.id}</option>)}
            {f.allowOther ? <option value={OTHER}>Something else…</option> : null}
          </select>
          {c.otherOn ? (
            <input class="fc-ctl fc-wide" type="text" disabled={disabled} aria-label={`${f.label}, other`} placeholder="Type your own answer" maxLength={2000}
              value={c.otherText} onInput={(e) => c.setOtherText((e.target as HTMLInputElement).value)} />
          ) : null}
        </div>
      );
    case 'radio':
    case 'multi_select': {
      const multi = f.kind === 'multi_select';
      const picked = Array.isArray(value) ? value : [];
      return (
        <div class="fc-stack">
          <div class="fc-chips">
            {f.options.map((o, i) => {
              const id = o.id ?? '';
              const on = multi ? picked.includes(id) : !c.otherOn && value === id;
              return (
                <label key={o.id ?? i} class={on ? 'fc-chip fc-chip-on' : 'fc-chip'} title={o.description}>
                  <input type={multi ? 'checkbox' : 'radio'} name={`f-${f.id}`} disabled={disabled} checked={on}
                    onChange={() => {
                      if (multi) set(on ? picked.filter((x) => x !== id) : [...picked, id]);
                      else { c.setOtherOn(false); set(id); }
                    }} />
                  {o.label ?? o.id}
                </label>
              );
            })}
            {f.allowOther && !multi ? (
              <label class={c.otherOn ? 'fc-chip fc-chip-on' : 'fc-chip'}>
                <input type="radio" name={`f-${f.id}`} disabled={disabled} checked={c.otherOn} onChange={() => c.setOtherOn(true)} />
                Other…
              </label>
            ) : null}
          </div>
          {f.allowOther && (multi || c.otherOn) ? (
            <input class="fc-ctl fc-wide" type="text" disabled={disabled} aria-label={`${f.label}, other`} placeholder={multi ? 'Something else (optional)' : 'Type your own answer'}
              maxLength={2000} value={c.otherText} onInput={(e) => c.setOtherText((e.target as HTMLInputElement).value)} />
          ) : null}
        </div>
      );
    }
    case 'slider': {
      const min = f.min ?? 0;
      const max = f.max ?? 100;
      const cur = typeof value === 'number' ? value : min;
      return (
        <div class="fc-inline">
          <input id={`f-${f.id}`} class="fc-range" type="range" disabled={disabled} min={min} max={max} step={f.step ?? 1} value={String(cur)}
            onInput={(e) => set(Number((e.target as HTMLInputElement).value))} {...aria} />
          <span class="fc-unit fc-strong">{`${cur}${f.unit ? ` ${f.unit}` : ''}`}</span>
        </div>
      );
    }
    case 'toggle': {
      const on = value === true;
      return (
        <div class="fc-inline">
          <button id={`f-${f.id}`} type="button" class={on ? 'fc-switch fc-switch-on' : 'fc-switch'} role="switch" aria-checked={on}
            aria-labelledby={`f-${f.id}-l`} disabled={disabled} onClick={() => set(!on)} {...aria}>
            <span class="fc-knob" />
          </button>
          <span class="fc-unit">{on ? f.onLabel || 'Yes' : f.offLabel || 'No'}</span>
        </div>
      );
    }
    case 'rating': {
      const max = Math.min(Math.max(f.max ?? 5, 2), 10);
      const cur = typeof value === 'number' ? value : 0;
      return (
        <div class="fc-chips" role="group" aria-labelledby={`f-${f.id}-l`}>
          {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
            <button key={n} type="button" class={n <= cur ? 'fc-chip fc-chip-on fc-rate' : 'fc-chip fc-rate'} aria-pressed={n === cur}
              aria-label={`${n} of ${max}`} disabled={disabled} onClick={() => set(n)}>
              {n}
            </button>
          ))}
        </div>
      );
    }
    default:
      return null;
  }
}

/** A form from the task, filled in the card. Submit sends {values}; "Not now" sends {deferred: true}. */
export function FormAsk({ ask, canSend, send, onSent }: { ask: OpenAsk } & SendProps) {
  const spec: FormSpec = ask.form ?? { sections: [] };
  const [values, setValues] = useState<FormValues>(() => initialValues(spec));
  const [otherOn, setOtherOn] = useState<Record<string, boolean>>({});
  const [otherText, setOtherText] = useState<Record<string, string>>({});
  const [tried, setTried] = useState(false);
  const { busy, error, submit } = useSend({ send, onSent }, ask.ask_id ?? '');
  const all = useMemo(() => merged(spec, values, otherOn, otherText), [spec, values, otherOn, otherText]);
  const errors = tried ? validateForm(spec, all) : {};
  const nErr = Object.keys(errors).length;
  const anyRequired = spec.sections.some((s) => s.fields.some((f) => f.required && f.kind !== 'toggle'));
  const disabled = !canSend || busy;
  const title = spec.title || 'A few details';

  const onSubmit = (e: Event) => {
    e.preventDefault();
    if (!canSend || busy) return;
    setTried(true);
    if (Object.keys(validateForm(spec, all)).length) return;
    const out = visibleValues(spec, all);
    void submit({ values: out }, { items: [{ prompt: title, options: [], text: formSummary(spec, out) || 'Submitted' }], label: 'Submitted' });
  };
  const onDefer = () => void submit({ deferred: true }, { items: [{ prompt: title, options: [] }], label: 'Not now' });

  return (
    <form class="fc-form" aria-label={title} onSubmit={onSubmit} noValidate>
      <div class="fc-form-body">
        <div>
          <h3 class="fc-form-title">{title}</h3>
          {spec.description || anyRequired ? (
            <p class="fc-form-desc">
              {spec.description}
              {spec.description && anyRequired ? ' ' : ''}
              {anyRequired ? <>Fields marked <span class="fc-req">*</span> are required.</> : null}
            </p>
          ) : null}
        </div>
        {spec.sections.map((s) => {
          const shown = s.fields.filter((f) => isFieldVisible(f, all));
          if (!shown.length) return null;
          return (
            <section key={s.id} class="fc-sec" aria-label={s.title || undefined}>
              {s.title || s.description ? (
                <div class="fc-sech">
                  {s.title ? <h4 class="fc-sect">{s.title}</h4> : null}
                  {s.description ? <p class="fc-secd">{s.description}</p> : null}
                </div>
              ) : null}
              {shown.map((f) => {
                const err = own(errors, f.id);
                const helpId = f.help ? `f-${f.id}-h` : undefined;
                const errId = err ? `f-${f.id}-e` : undefined;
                const describedBy = [errId, helpId].filter(Boolean).join(' ') || undefined;
                const grouped = f.kind === 'radio' || f.kind === 'multi_select' || f.kind === 'rating';
                const label = (
                  <>
                    {f.label || f.id}
                    {f.required && f.kind !== 'toggle' ? <span class="fc-req" aria-hidden="true">*</span> : null}
                    {!f.required && f.kind !== 'toggle' ? <span class="fc-opt-tag">optional</span> : null}
                  </>
                );
                const ctl = (
                  <Control field={f} value={valueOf(values, f.id)} disabled={disabled} invalid={!!err} describedBy={describedBy}
                    set={(v) => {
                      const next = { ...values };
                      if (v === undefined) delete next[f.id];
                      else next[f.id] = v;
                      setValues(next);
                    }}
                    otherOn={!!own(otherOn, f.id)} setOtherOn={(on) => setOtherOn({ ...otherOn, [f.id]: on })}
                    otherText={own(otherText, f.id) ?? ''} setOtherText={(t) => setOtherText({ ...otherText, [f.id]: t })} />
                );
                return (
                  <div key={f.id} class={f.visibleWhen ? 'fc-fld fc-dep' : 'fc-fld'}>
                    {grouped ? (
                      <span id={`f-${f.id}-l`} class="fc-lbl" role="heading" aria-level={5}>{label}</span>
                    ) : f.kind === 'toggle' ? (
                      <span id={`f-${f.id}-l`} class="fc-lbl">{label}</span>
                    ) : (
                      <label for={`f-${f.id}`} id={`f-${f.id}-l`} class="fc-lbl">{label}</label>
                    )}
                    {grouped ? <div role="group" aria-labelledby={`f-${f.id}-l`} aria-describedby={describedBy}>{ctl}</div> : ctl}
                    {f.help ? <p id={helpId} class="fc-help">{f.help}</p> : null}
                    {err ? <p id={errId} class="fc-err">{err}</p> : null}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>
      <div class="fc-form-foot">
        {canSend ? (
          <>
            {spec.allowDefer ? <button type="button" class="fc-quiet" disabled={busy} onClick={onDefer}>Not now</button> : null}
            <span class={nErr ? 'fc-foot-note fc-foot-err' : 'fc-foot-note'} role={nErr ? 'alert' : undefined}>
              {nErr ? `${nErr} ${nErr === 1 ? 'field needs' : 'fields need'} attention` : 'Or reply in the chat'}
            </span>
            <button type="submit" class="fc-primary" disabled={busy}>{busy ? 'Sending…' : spec.submitLabel || 'Submit'}</button>
          </>
        ) : (
          <span class="fc-foot-note fc-foot-solo">Reply in the chat with the details.</span>
        )}
      </div>
      {error ? <p class="fc-err fc-form-err" role="alert">{error}</p> : null}
    </form>
  );
}
