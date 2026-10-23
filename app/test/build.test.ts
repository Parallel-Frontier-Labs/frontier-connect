import { readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('single-file build', () => {
  it('produces one self-contained HTML file within the size budget', () => {
    const f = 'dist/task-card.html';
    const html = readFileSync(f, 'utf8');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(statSync(f).size).toBeLessThanOrEqual(524288);
    expect(html).not.toMatch(/<script[^>]*\ssrc/i);
    expect(html).not.toMatch(/<link\s/i);
    expect(html).toContain('id="root"');
  });

  it('loads the fonts from the static base, keeps the font notice, and writes the font files', () => {
    const html = readFileSync('dist/task-card.html', 'utf8');
    expect(html).not.toMatch(/data:font\//);
    expect(html).toContain('data-static="__FRONTIER_STATIC__"');
    const manifest = JSON.parse(readFileSync('dist/static/manifest.json', 'utf8')) as Record<string, string>;
    for (const [name, w] of [['public-sans-400', 400], ['public-sans-600', 600], ['public-sans-700', 700]] as const) {
      expect(manifest[name]).toMatch(new RegExp(`^${name}\\.[0-9a-f]{12}\\.woff2$`));
      expect(html).toMatch(new RegExp(`font-family:'Public Sans';font-style:normal;font-weight:${w};[^}]*url\\(__FRONTIER_STATIC__/${manifest[name]!.replace(/\./g, '\\.')}\\)`));
      expect(statSync(`dist/static/${manifest[name]}`).size).toBeGreaterThan(1000);
    }
    expect(manifest['ibm-plex-mono-400']).toMatch(/^ibm-plex-mono-400\.[0-9a-f]{12}\.woff2$/);
    expect(manifest['OFL-1.1']).toMatch(/^OFL-1\.1\.[0-9a-f]{12}\.txt$/);
    const ofl = readFileSync('LICENSES/OFL-1.1.txt', 'utf8');
    expect(html).toContain(ofl.split('\n')[0]);
    // OFL 1.1 condition 2: every copy carries the copyright lines and the license text.
    expect(html).toContain(ofl);
    expect(html).toContain('SIL OPEN FONT LICENSE Version 1.1');
    expect(html).toContain('PERMISSION & CONDITIONS');
    expect(html).toContain('Copyright 2015 The Public Sans Project Authors');
    expect(html).toContain('Copyright 2017 IBM Corp.');
    const css = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!;
    expect(css).not.toMatch(/url\((?!__FRONTIER_STATIC__\/)/);
  });

  // Any new runtime URL (a new dependency, a hard-coded endpoint) must be reviewed and added here.
  it('contains only the known library URL constants', () => {
    const html = readFileSync('dist/task-card.html', 'utf8');
    const found = [...new Set(html.match(/https?:\/\/[^"'`\\\s)<>,;]*/g) ?? [])].sort();
    expect(found).toEqual([
      'http://[${e}]',
      'http://json-schema.org/draft/2019-09/schema',
      'http://www.w3.org/1998/Math/MathML',
      'http://www.w3.org/1999/xhtml',
      'http://www.w3.org/2000/svg',
      'https://*.example.com',
      'https://github.com/cfworker',
      'https://github.com/uswds/public-sans',
      'https://json-schema.org/draft/2019-09/schema',
      'https://openfontlicense.org',
    ]);
  });

  // The browser frame feed and the host report derive their URLs from the task's view url: the
  // route paths are in the bundle, no host is (the whitelist above stays unchanged).
  it('builds the browser and host-report URLs from the view url, with no hard-coded host', () => {
    const html = readFileSync('dist/task-card.html', 'utf8');
    expect(html).toContain('/browser/frame');
    expect(html).toContain('/v1/connect/host-report');
    expect(html).not.toMatch(/https:\/\/[a-z0-9.-]*parallelfrontier/i);
  });
});
