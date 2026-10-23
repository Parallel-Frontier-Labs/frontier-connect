import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const common = { absWorkingDir: root, bundle: true, minify: true, write: false, logLevel: 'warning' };

// The host SDK pulls in zod, which is far larger than the card needs when bundled whole.
// Trim what the card never uses: every non-English locale (~300 KB minified), the optional
// JIT schema compiler and the JSON-Schema-to-zod converter. The card only validates host
// messages with the default parser, so these paths are never reached.
const zodDir = String.raw`zod[\\/]v4[\\/]`;
const stubs = [
  [new RegExp(zodDir + String.raw`locales[\\/]index\.js$`), `export { default as en } from './en.js';`],
  [
    new RegExp(zodDir + String.raw`core[\\/]compile\.js$`),
    `export const INVALID = Symbol.for('zod.compile.invalid');
export class ZodCompileAsyncError extends Error {}
export class ZodCompileUnsupportedError extends Error {}
const off = () => { throw new Error('schema compiler is not bundled in the task card'); };
export const compile = off, withParser = off, compileFn = off;`,
  ],
  [
    new RegExp(zodDir + String.raw`classic[\\/]from-json-schema\.js$`),
    `export const fromJSONSchema = () => { throw new Error('not bundled in the task card'); };`,
  ],
  // JSON Schema export is a server-side concern; the card never asks a schema for its JSON form.
  [new RegExp(zodDir + String.raw`core[\\/]json-schema-processors\.js$`), `export const allProcessors = {}, toJSONSchema = () => { throw new Error("not bundled in the task card"); };`],
  [
    new RegExp(zodDir + String.raw`core[\\/]to-json-schema\.js$`),
    `const off = () => { throw new Error('JSON Schema export is not bundled in the task card'); };
export const createToJSONSchemaMethod = () => off, createStandardJSONSchemaMethod = () => off;
export const extractDefs = off, finalize = off, initializeContext = off, processSchema = off, handleUnrepresentable = off;`,
  ],
];
const trimZod = {
  name: 'trim-zod',
  setup(b) {
    for (const [filter, contents] of stubs) {
      b.onLoad({ filter }, (a) => ({ contents, resolveDir: dirname(a.path), loader: 'js' }));
    }
    // zod probes the user agent of one hosting platform before enabling its JIT path. The card
    // never uses the JIT path, so drop the probe (and the vendor name it embeds) from the bundle.
    b.onLoad({ filter: new RegExp(zodDir + String.raw`core[\\/]util\.js$`) }, (a) => {
      const src = readFileSync(a.path, 'utf8');
      const probe = /navigator\?\.userAgent\?\.includes\("[A-Za-z]+"\)/;
      if (!probe.test(src)) throw new Error('trim-zod: the user-agent probe moved; update scripts/build.mjs');
      return { contents: src.replace(probe, 'false'), resolveDir: dirname(a.path), loader: 'js' };
    });
  },
};

const js = await build({
  ...common,
  plugins: [trimZod],
  entryPoints: ['app/src/main.tsx'],
  format: 'iife',
  target: 'es2022',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const css = await build({ ...common, entryPoints: ['app/src/card.css'] });

// Fonts are separate hashed files in dist/static, loaded from the static base the serving side
// fills in (see app/src/staticBase.ts): Public Sans 400/600/700 and IBM Plex
// Mono 400, latin subset, woff2, from the @fontsource packages. They are under the SIL Open Font
// License 1.1, which every copy must carry: LICENSES/OFL-1.1.txt (the copyright lines and the
// license text, verbatim) is written in full into a comment next to the faces.
const FONTS = [
  ['Public Sans', 400, '@fontsource/public-sans/files/public-sans-latin-400-normal.woff2'],
  ['Public Sans', 600, '@fontsource/public-sans/files/public-sans-latin-600-normal.woff2'],
  ['Public Sans', 700, '@fontsource/public-sans/files/public-sans-latin-700-normal.woff2'],
  ['IBM Plex Mono', 400, '@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2'],
];
// The latin subset's range, as @fontsource publishes it.
const LATIN =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const STATIC = '__FRONTIER_STATIC__';
const staticDir = join(root, 'dist/static');
mkdirSync(staticDir, { recursive: true });
const manifest = {};
/** Write `bytes` into dist/static as `<name>.<sha256:12>.<ext>` and record it in the manifest. */
function emitStatic(name, ext, bytes) {
  const file = `${name}.${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${ext}`;
  writeFileSync(join(staticDir, file), bytes);
  manifest[name] = file;
  return file;
}
const FONT_NAMES = ['public-sans-400', 'public-sans-600', 'public-sans-700', 'ibm-plex-mono-400'];
const oflText = readFileSync(join(root, 'LICENSES/OFL-1.1.txt'));
emitStatic('OFL-1.1', 'txt', oflText);
const fontCss =
  `/*!\nFonts: Public Sans and IBM Plex Mono, served next to this card under the license below.\n\n${oflText.toString('utf8').replaceAll('*/', '* /')}*/` +
  FONTS.map(([family, weight, file], i) => {
    const out = emitStatic(FONT_NAMES[i], 'woff2', readFileSync(join(root, 'node_modules', file)));
    return `@font-face{font-family:'${family}';font-style:normal;font-weight:${weight};font-display:swap;src:url(${STATIC}/${out}) format('woff2');unicode-range:${LATIN}}`;
  }).join('');

const jsText = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const cssText = (fontCss + css.outputFiles[0].text).replace(/<\/style/gi, '<\\/style');
const html = readFileSync(join(root, 'app/index.html'), 'utf8')
  .replace('<!--CSS-->', () => `<style>${cssText}</style>`)
  .replace('<!--JS-->', () => `<script>${jsText}</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist/task-card.html');
// Write then rename so a concurrent reader never sees a half-written file.
const tmp = `${out}.${process.pid}.tmp`;
writeFileSync(tmp, html);
renameSync(tmp, out);
writeFileSync(join(staticDir, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`dist/task-card.html ${Buffer.byteLength(html)} bytes; static files: ${Object.values(manifest).join(', ')}`);
