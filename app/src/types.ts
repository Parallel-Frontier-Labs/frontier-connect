import { SOURCES, type Source } from './list';
export const STATUSES = ['starting', 'running', 'waiting_for_answer', 'waiting_for_you', 'done', 'error', 'stopped'] as const;
export type Status = (typeof STATUSES)[number];
export interface Section { id: string; title: string; done: boolean; outcome: string | null }
export interface PlanStep { title: string; status: 'queued' | 'in_progress' | 'done' }
export interface Option { id?: string; label?: string; description?: string }
export const QUESTION_KINDS = ['text', 'single_select', 'multi_select', 'confirm'] as const;
export interface Question {
  id?: string; kind?: string; prompt?: string; subPrompt?: string; placeholder?: string;
  allowOther?: boolean; optional?: boolean; confirmLabel?: string; denyLabel?: string; options?: Option[];
}
export const FIELD_KINDS = [
  'short_text', 'long_text', 'email', 'url', 'phone', 'number', 'date', 'select', 'radio', 'multi_select',
  'slider', 'toggle', 'rating',
] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
export type Scalar = string | number | boolean;
export interface VisibleWhen { field: string; equals?: Scalar; oneOf?: (string | number)[]; truthy?: boolean }
export interface Field {
  id: string; kind: FieldKind; label: string; help?: string; required?: boolean; placeholder?: string;
  options: Option[]; allowOther?: boolean; min?: number; max?: number; step?: number; unit?: string;
  maxLength?: number; rows?: number; onLabel?: string; offLabel?: string; default?: Scalar | Scalar[];
  /** date: bounds as YYYY-MM-DD. */
  minDate?: string; maxDate?: string;
  visibleWhen?: VisibleWhen;
}
export interface FormSection { id: string; title?: string; description?: string; fields: Field[] }
export interface FormSpec { title?: string; description?: string; submitLabel?: string; allowDefer?: boolean; sections: FormSection[] }
export interface OpenAsk { ask_id: string | null; kind: 'question' | 'files' | 'form'; questions?: Question[]; text?: string; form?: FormSpec | null }
export interface Usage { input_tokens: number; cached_input_tokens: number; output_tokens: number; total_tokens?: number }
export interface View { token: string; expires_in_s: number; url: string }
export interface Deliverable { name: string; path: string }
export interface Skill { playbook: string; skill: string }
/** A digest event, reduced to what the card reads: narration/activity lines and the end reason. */
export interface TaskEvent { seq: number; kind: string; text: string; code?: string }
/** Where the plugin's helper saved the delivered files: a folder name and an ISO time. */
export interface Saved { dir: string; at: string }
export const BROWSER_STATES = ['live', 'waiting', 'ended'] as const;
/** The task's cloud browser: driving (`live`), paused for the user (`waiting`) or closed. `site` is
 * the hostname it shows, when known. */
export interface BrowserInfo {
  state: (typeof BROWSER_STATES)[number]; site: string | null;
  /** The wait is a form in the task's browser (typed answers), not a sign-in: no takeover. */
  form?: true;
}

export interface TaskPayload {
  task_id: string; status: Status; title: string; plan: PlanStep[]; sections: Section[]; live: string | null;
  estimate: { eta_s: number } | null; open_ask: OpenAsk | null; deliverables: Deliverable[];
  result: { summary: string; summary_type: string; takeaway: string | null } | null; work_ms: number;
  /** Credits used so far, computed by the backend; null or absent when unknown (an older server). */
  credits?: number | null;
  usage: Usage | null; events: TaskEvent[]; cursor: number; more: boolean; view?: View | null;
  /** The organization the connection runs tasks in (header line). */
  org?: string | null;
  /** Turns on the task: 1, plus one per follow-up (header line "Follow-up · turn N"). */
  turn?: number;
  /** Where the task was started (the list's source enum); null when unknown. */
  source?: Source | null;
  /** Playbook skills the run used (terminal states only). */
  skills?: Skill[];
  /** The delivered files were saved to the user's computer by the Frontier plugin's helper, into
   * the folder named `dir` (a folder name, never a path); null when not, or not for this turn. */
  saved?: Saved | null;
  /** The task's cloud browser, when it uses one; null when it has none (or the task ended), absent
   * when the payload does not say (older servers, some tool results). */
  browser?: BrowserInfo | null;
  /** Set on frontier_answer / frontier_steer / frontier_continue_task results only. */
  accepted?: boolean;
  reason?: string | null;
}
export const TERMINAL: ReadonlySet<Status> = new Set(['done', 'error', 'stopped']);
export function isPayload(v: unknown): v is TaskPayload {
  return !!v && typeof v === 'object' && typeof (v as TaskPayload).task_id === 'string' && typeof (v as TaskPayload).status === 'string';
}

// Runtime sanitising. The payload comes from a network response or the host, so nothing in it is
// trusted: every field the card renders as text is forced to a string (and capped), and anything
// else is dropped (blank) rather than handed to the renderer. Numbers are kept only when finite.
const str = (v: unknown, cap = 2000): string => (typeof v === 'string' ? v.slice(0, cap) : '');
const strOrNull = (v: unknown, cap = 2000): string | null => (typeof v === 'string' ? v.slice(0, cap) : null);
const optStr = (v: unknown, cap = 2000): string | undefined => (typeof v === 'string' ? v.slice(0, cap) : undefined);
const optNum = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const optBool = (v: unknown): boolean | undefined => (typeof v === 'boolean' ? v : undefined);
const num = (v: unknown, d = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const obj = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const list = (v: unknown, cap = 200): Record<string, unknown>[] =>
  Array.isArray(v) ? v.slice(0, cap).map(obj).filter((o): o is Record<string, unknown> => o !== null) : [];
const isScalar = (v: unknown): v is Scalar =>
  typeof v === 'string' || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v));
const scalar = (v: unknown): Scalar | undefined => (isScalar(v) ? (typeof v === 'string' ? v.slice(0, 2000) : v) : undefined);
/** Drop keys that would reach Object.prototype when used as a lookup key. */
const safeKey = (v: unknown, cap = 64): string | undefined => {
  const s = optStr(v, cap);
  return s && s !== '__proto__' && s !== 'constructor' && s !== 'prototype' ? s : undefined;
};

/** A real calendar day written as YYYY-MM-DD (the only date form the card accepts). */
export function isDay(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** The engine's host-safe failure codes; anything else is dropped. */
export const ERROR_CODES = ['sandbox_unavailable', 'run_timeout', 'connection_lost'] as const;

const PLAN_STATUS = ['queued', 'in_progress', 'done'] as const;
const ASK_KIND = ['question', 'files', 'form'] as const;

const cleanOptions = (v: unknown): Option[] =>
  list(v, 20)
    .map((o) => ({ id: safeKey(o.id), label: optStr(o.label, 300), description: optStr(o.description) }))
    .filter((o) => o.id !== undefined || o.label !== undefined);

function cleanVisibleWhen(v: unknown): VisibleWhen | undefined {
  const w = obj(v);
  const field = w ? safeKey(w.field) : undefined;
  if (!w || !field) return undefined;
  const out: VisibleWhen = { field };
  const eq = scalar(w.equals);
  if (eq !== undefined) out.equals = eq;
  if (Array.isArray(w.oneOf)) {
    out.oneOf = w.oneOf.slice(0, 50).filter((x): x is string | number => typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)));
  }
  if (typeof w.truthy === 'boolean') out.truthy = w.truthy;
  return out;
}

function cleanField(f: Record<string, unknown>): Field | null {
  const id = safeKey(f.id);
  const kind = FIELD_KINDS.find((k) => k === f.kind);
  if (!id || !kind) return null;
  let dflt: Scalar | Scalar[] | undefined = scalar(f.default);
  if (dflt === undefined && Array.isArray(f.default)) dflt = f.default.slice(0, 50).filter(isScalar).map((x) => scalar(x)!);
  const field: Field = {
    id, kind, label: str(f.label, 300), help: optStr(f.help), required: f.required === true,
    placeholder: optStr(f.placeholder), options: cleanOptions(f.options), allowOther: f.allowOther === true,
    min: optNum(f.min), max: optNum(f.max), step: optNum(f.step), unit: optStr(f.unit, 40),
    maxLength: optNum(f.maxLength), rows: optNum(f.rows), onLabel: optStr(f.onLabel, 300), offLabel: optStr(f.offLabel, 300),
    default: dflt, visibleWhen: cleanVisibleWhen(f.visibleWhen),
  };
  // Patterns are never taken from the payload: a task-supplied regex could hang the card.
  if (kind === 'date') {
    // The raw payload says min/max; an already-parsed payload says minDate/maxDate (parsing twice keeps them).
    const lo = isDay(f.minDate) ? f.minDate : isDay(f.min) ? f.min : undefined;
    const hi = isDay(f.maxDate) ? f.maxDate : isDay(f.max) ? f.max : undefined;
    if (lo) field.minDate = lo;
    if (hi) field.maxDate = hi;
  }
  return field;
}

function cleanForm(v: unknown): FormSpec | null {
  const form = obj(v);
  if (!form) return null;
  let taken = 0;
  const sections = list(form.sections, 20).map((s, i) => {
    const fields = list(s.fields, 60).map(cleanField).filter((f): f is Field => f !== null).slice(0, Math.max(0, 60 - taken));
    taken += fields.length;
    return { id: optStr(s.id, 64) ?? String(i), title: optStr(s.title, 300), description: optStr(s.description), fields };
  });
  return {
    title: optStr(form.title, 300), description: optStr(form.description), submitLabel: optStr(form.submitLabel, 60),
    allowDefer: form.allowDefer === true, sections,
  };
}

function cleanAsk(v: unknown): OpenAsk | null {
  const a = obj(v);
  if (!a) return null;
  const kind = ASK_KIND.find((k) => k === a.kind);
  if (!kind) return null;
  return {
    ask_id: strOrNull(a.ask_id, 200),
    kind,
    text: optStr(a.text),
    form: cleanForm(a.form),
    questions: list(a.questions, 20).map((q) => ({
      id: safeKey(q.id),
      kind: optStr(q.kind, 64),
      prompt: optStr(q.prompt),
      subPrompt: optStr(q.subPrompt),
      placeholder: optStr(q.placeholder),
      allowOther: optBool(q.allowOther),
      optional: optBool(q.optional),
      confirmLabel: optStr(q.confirmLabel, 300),
      denyLabel: optStr(q.denyLabel, 300),
      options: cleanOptions(q.options),
    })),
  };
}

/** A relative display path: `/`-separated, no empty, `.` or `..` segments, at most 300 characters,
 *  ending in the file's own name (the backend's rule); anything else shows the name alone. */
export function cleanPath(path: unknown, name: string): string {
  if (typeof path !== 'string' || path.length > 300) return name;
  const segs = path.replace(/\\/g, '/').split('/').filter((s) => s && s !== '.');
  if (!segs.length || segs.includes('..') || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(path) || /^[/~]/.test(path)) return name;
  if (segs[segs.length - 1] !== name) return name;
  return segs.join('/');
}

function cleanEvents(v: unknown): TaskEvent[] {
  return list(v, 500)
    .filter((e) => typeof e.seq === 'number' && Number.isFinite(e.seq) && typeof e.kind === 'string')
    .map((e) => {
      const d = obj(e.data);
      const out: TaskEvent = { seq: e.seq as number, kind: (e.kind as string).slice(0, 32), text: str(e.text, 2000) };
      // The raw payload nests the code in data; an already-parsed event carries it flat.
      const code = d?.code ?? e.code;
      const known = ERROR_CODES.find((c) => c === code);
      if (known) out.code = known;
      return out;
    });
}

/** `saved` only with a non-empty folder name (one segment, capped) and a time string. */
function cleanSaved(v: unknown): Saved | null {
  const o = obj(v);
  const dir = o ? str(o.dir, 80).trim() : '';
  if (!o || !dir || /[/\\]/.test(dir) || typeof o.at !== 'string') return null;
  return { dir, at: o.at.slice(0, 40) };
}

/** A bare hostname (letters, digits, dots, hyphens; at most 253 characters), else null. */
export function cleanSite(v: unknown): string | null {
  return typeof v === 'string' && v.length <= 253 && /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(v) ? v : null;
}

function cleanBrowser(v: unknown): BrowserInfo | null {
  const o = obj(v);
  const state = o ? BROWSER_STATES.find((s) => s === o.state) : undefined;
  if (!o || !state) return null;
  const out: BrowserInfo = { state, site: cleanSite(o.site) };
  if (state === 'waiting' && o.form === true) out.form = true;
  return out;
}

/** Validate and sanitise an untrusted payload; null when it is not a task payload at all. */
export function parsePayload(v: unknown): TaskPayload | null {
  if (!isPayload(v)) return null;
  const r = v as unknown as Record<string, unknown>;
  const est = obj(r.estimate);
  const res = obj(r.result);
  const use = obj(r.usage);
  const view = obj(r.view);
  const out: TaskPayload = {
    task_id: str(r.task_id, 200),
    // Anything outside the enum (including "__proto__" or "constructor") falls back to the initial state.
    status: STATUSES.find((s) => s === r.status) ?? 'starting',
    title: str(r.title, 300),
    plan: list(r.plan, 30).map((p) => ({
      title: str(p.title, 300),
      status: PLAN_STATUS.find((s) => s === p.status) ?? 'queued',
    })),
    sections: list(r.sections).map((s, i) => ({
      id: typeof s.id === 'string' ? s.id.slice(0, 64) : String(i),
      title: str(s.title, 300),
      done: s.done === true,
      outcome: strOrNull(s.outcome, 300),
    })),
    live: strOrNull(r.live, 300),
    estimate: est && typeof est.eta_s === 'number' && Number.isFinite(est.eta_s) ? { eta_s: est.eta_s } : null,
    open_ask: cleanAsk(r.open_ask),
    deliverables: list(r.deliverables, 200)
      .map((d) => {
        const name = str(d.name, 255);
        return { name, path: cleanPath(d.path, name) };
      })
      .filter((d) => d.name !== ''),
    result: res ? { summary: str(res.summary, 20000), summary_type: str(res.summary_type, 20), takeaway: strOrNull(res.takeaway) } : null,
    work_ms: num(r.work_ms),
    usage: use
      ? {
          input_tokens: num(use.input_tokens),
          cached_input_tokens: num(use.cached_input_tokens),
          output_tokens: num(use.output_tokens),
          ...(typeof use.total_tokens === 'number' && Number.isFinite(use.total_tokens) && use.total_tokens >= 0
            ? { total_tokens: use.total_tokens }
            : {}),
        }
      : null,
    credits: typeof r.credits === 'number' && Number.isFinite(r.credits) && r.credits >= 0 && r.credits <= Number.MAX_SAFE_INTEGER ? Math.round(r.credits) : null,
    events: cleanEvents(r.events),
    cursor: num(r.cursor),
    more: r.more === true,
    org: typeof r.org === 'string' && r.org ? r.org.slice(0, 80) : null,
    source: SOURCES.find((s) => s === r.source) ?? null,
    turn: typeof r.turn === 'number' && Number.isInteger(r.turn) && r.turn >= 1 ? Math.min(r.turn, 10_000) : 1,
    skills: list(r.skills, 20)
      .map((s) => ({ playbook: str(s.playbook, 80), skill: str(s.skill, 80) }))
      .filter((s) => s.playbook !== '' || s.skill !== ''),
    saved: cleanSaved(r.saved),
  };
  if (typeof r.accepted === 'boolean') out.accepted = r.accepted;
  if (typeof r.reason === 'string') out.reason = r.reason.slice(0, 300);
  if (r.browser !== undefined) out.browser = cleanBrowser(r.browser);
  if (r.view !== undefined) {
    out.view =
      view && typeof view.token === 'string' && typeof view.url === 'string'
        ? { token: view.token, expires_in_s: num(view.expires_in_s), url: view.url }
        : null;
  }
  return out;
}
