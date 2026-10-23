import { staticUrl } from '../staticBase';
import type { Viewers } from '../../viewers/types';

type Name = 'sheet' | 'pdf' | 'docx';
const pending = new Map<Name, Promise<unknown>>();
const files = (): Record<Name, string> | null => (typeof __VIEWER_FILES__ === 'undefined' ? null : __VIEWER_FILES__);

export const viewersAvailable = (): boolean => !!files() && !!staticUrl('x');

export function loadViewer<K extends Name>(k: K, { timeoutMs = 30000 } = {}): Promise<NonNullable<Viewers[K]>> {
  const have = window.__frontierViewers?.[k];
  if (have) return Promise.resolve(have as NonNullable<Viewers[K]>);
  const prior = pending.get(k);
  if (prior) return prior as Promise<NonNullable<Viewers[K]>>;
  const file = files()?.[k];
  const src = file ? staticUrl(file) : null;
  if (!src) return Promise.reject(new Error('viewer unavailable'));
  const p = new Promise<NonNullable<Viewers[K]>>((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.dataset.viewer = k;
    const fail = () => { clearTimeout(t); s.remove(); pending.delete(k); reject(new Error('viewer unavailable')); };
    const t = setTimeout(fail, timeoutMs);
    s.addEventListener('load', () => {
      clearTimeout(t);
      const v = window.__frontierViewers?.[k];
      if (v) resolve(v as NonNullable<Viewers[K]>); else fail();
    });
    s.addEventListener('error', fail);
    document.head.appendChild(s);
  });
  pending.set(k, p);
  return p;
}
