import { afterEach, describe, expect, it } from 'vitest';
import { staticBase, staticUrl } from '../src/staticBase';

afterEach(() => { delete document.documentElement.dataset.static; });

describe('staticBase', () => {
  it('reads the base the server filled in', () => {
    document.documentElement.dataset.static = 'https://api.example.com/v1/connect/static';
    expect(staticBase()).toBe('https://api.example.com/v1/connect/static');
    expect(staticUrl('viewer-sheet.abc.js')).toBe('https://api.example.com/v1/connect/static/viewer-sheet.abc.js');
  });
  it('is null while the placeholder is unreplaced, or missing, or not https', () => {
    for (const v of ['__FRONTIER_STATIC__', '', 'http://api.example.com/x', 'javascript:alert(1)']) {
      document.documentElement.dataset.static = v;
      expect(staticBase(), v).toBeNull();
      expect(staticUrl('a.js')).toBeNull();
    }
    delete document.documentElement.dataset.static;
    expect(staticBase()).toBeNull();
  });
});
