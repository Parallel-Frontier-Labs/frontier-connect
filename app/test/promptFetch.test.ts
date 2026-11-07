import { describe, expect, it, vi } from 'vitest';
import { fetchPrompt, promptUrl } from '../src/promptFetch';

describe('promptFetch', () => {
  it('accepts only an https prompt route', () => {
    expect(promptUrl('https://api.example.com/v1/runs/t1/prompt')).toBe('https://api.example.com/v1/runs/t1/prompt');
    expect(promptUrl('http://api.example.com/v1/runs/t1/prompt')).toBeNull();
    expect(promptUrl('https://api.example.com/v1/runs/t1/view')).toBeNull();
    expect(promptUrl('not a url')).toBeNull();
  });

  it('sends the view token, keeps only a string prompt, and maps 404 to gone', async () => {
    const view = { url: 'https://api.example.com/v1/runs/t1/prompt', token: 'tok' };
    const f = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ prompt: 'Review Q3', truncated: true }) }) as unknown as Response);
    expect(await fetchPrompt(view, f)).toEqual({ kind: 'ok', prompt: 'Review Q3', truncated: true });
    expect(f).toHaveBeenCalledWith('https://api.example.com/v1/runs/t1/prompt', expect.objectContaining({ headers: { Authorization: 'Bearer tok' }, credentials: 'omit' }));
    const bad = vi.fn(async () => ({ status: 200, ok: true, json: async () => ({ prompt: { a: 1 } }) }) as unknown as Response);
    expect(await fetchPrompt(view, bad)).toEqual({ kind: 'failed' });
    const gone = vi.fn(async () => ({ status: 404, ok: false, json: async () => null }) as unknown as Response);
    expect(await fetchPrompt(view, gone)).toEqual({ kind: 'gone' });
    const err = vi.fn(async () => { throw new Error('blocked'); });
    expect(await fetchPrompt(view, err)).toEqual({ kind: 'failed' });
    expect(await fetchPrompt(null, f)).toEqual({ kind: 'failed' });
  });
});
