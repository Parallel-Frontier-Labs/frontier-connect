import { isDay, type Field, type FormSpec, type Scalar } from './types';

/**
 * Form logic for the card's compact form renderer. The visibility and validation rules mirror the
 * form spec the task's agents use, so the card refuses what the task would refuse; the server
 * validates again before the task sees the answer.
 */
export type FieldValue = string | number | boolean | string[];
export type FormValues = Record<string, FieldValue>;

/** An own property only: a key like `toString` never reads Object.prototype. */
export const own = <T,>(o: Record<string, T>, k: string): T | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);

/** A value by field id, own properties only: an id like `toString` never reads Object.prototype. */
export const valueOf = (values: FormValues, id: string): FieldValue | undefined =>
  Object.hasOwn(values, id) ? values[id] : undefined;


export function isFieldVisible(field: Field, values: FormValues): boolean {
  const cond = field.visibleWhen;
  if (!cond) return true;
  const other = valueOf(values, cond.field);
  if (cond.truthy !== undefined) {
    const isTruthy = Array.isArray(other) ? other.length > 0 : !!other;
    return cond.truthy ? isTruthy : !isTruthy;
  }
  if (cond.oneOf !== undefined) {
    return Array.isArray(other)
      ? other.some((o) => cond.oneOf!.includes(o))
      : cond.oneOf.includes(other as string | number);
  }
  if (cond.equals !== undefined) return other === cond.equals;
  return true;
}

function isBlank(val: FieldValue | undefined): boolean {
  if (val === undefined || val === null) return true;
  if (typeof val === 'string') return val.trim().length === 0;
  if (Array.isArray(val)) return val.length === 0;
  return false;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_ALLOWED = /^[+()\-.\s\d]+$/;

/** fieldId -> error message. Empty means submittable. Hidden fields are skipped. */
export function validateForm(spec: FormSpec, values: FormValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const section of spec.sections) {
    for (const field of section.fields) {
      if (!isFieldVisible(field, values)) continue;
      const val = valueOf(values, field.id);
      const req = field.required === true;
      if (field.kind === 'toggle') {
        if (req && val !== true) errors[field.id] = 'Required';
        continue;
      }
      if (isBlank(val)) {
        if (req) errors[field.id] = 'Required';
        else if (field.kind === 'multi_select' && field.min && field.min > 0) errors[field.id] = `Choose at least ${field.min}`;
        continue;
      }
      switch (field.kind) {
        case 'email':
          if (typeof val === 'string' && !EMAIL_RE.test(val)) errors[field.id] = 'Enter a valid email';
          break;
        case 'url':
          if (typeof val === 'string' && !/^https?:\/\/.+/.test(val)) errors[field.id] = 'Enter a valid URL (http/https)';
          break;
        case 'phone':
          if (typeof val === 'string') {
            const digits = (val.match(/\d/g) ?? []).length;
            if (!PHONE_ALLOWED.test(val) || digits < 7 || digits > 15) errors[field.id] = 'Enter a valid phone number';
          }
          break;
        case 'short_text':
        case 'long_text':
          if (typeof val === 'string' && field.maxLength && val.length > field.maxLength) errors[field.id] = `Max ${field.maxLength} characters`;
          break;
        case 'date':
          // The form sets noValidate, so the bounds are checked here, not by the browser.
          if (!isDay(val)) errors[field.id] = 'Enter a valid date';
          else if (field.minDate && val < field.minDate) errors[field.id] = `On or after ${field.minDate}`;
          else if (field.maxDate && val > field.maxDate) errors[field.id] = `On or before ${field.maxDate}`;
          break;
        case 'number':
        case 'slider':
          if (typeof val === 'number') {
            if (field.min !== undefined && val < field.min) errors[field.id] = `Minimum ${field.min}`;
            else if (field.max !== undefined && val > field.max) errors[field.id] = `Maximum ${field.max}`;
          } else errors[field.id] = 'Enter a number';
          break;
        case 'multi_select':
          if (Array.isArray(val)) {
            if (field.min !== undefined && val.length < field.min) errors[field.id] = `Choose at least ${field.min}`;
            else if (field.max !== undefined && val.length > field.max) errors[field.id] = `Choose at most ${field.max}`;
          }
          break;
        default:
          break;
      }
    }
  }
  return errors;
}

const asValue = (d: Scalar | Scalar[] | undefined, field: Field): FieldValue | undefined => {
  if (d === undefined) return undefined;
  if (field.kind === 'multi_select') return Array.isArray(d) ? d.map(String) : [String(d)];
  if (Array.isArray(d)) return undefined;
  if (field.kind === 'number' || field.kind === 'slider' || field.kind === 'rating') return typeof d === 'number' ? d : undefined;
  if (field.kind === 'toggle') return d === true;
  return typeof d === 'string' ? d : String(d);
};

export function initialValues(spec: FormSpec): FormValues {
  const out: FormValues = {};
  for (const section of spec.sections) {
    for (const field of section.fields) {
      const v = asValue(field.default, field);
      if (field.kind === 'toggle') out[field.id] = v === true;
      else if (v !== undefined) out[field.id] = v;
    }
  }
  return out;
}

/** The values the task receives: only fields visible right now, with something in them. */
export function visibleValues(spec: FormSpec, values: FormValues): FormValues {
  const out: FormValues = {};
  for (const section of spec.sections) {
    for (const field of section.fields) {
      const v = valueOf(values, field.id);
      if (isFieldVisible(field, values) && v !== undefined) out[field.id] = v;
    }
  }
  return out;
}
