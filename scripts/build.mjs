import { build } from 'esbuild';
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

const jsText = js.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const cssText = css.outputFiles[0].text.replace(/<\/style/gi, '<\\/style');
const html = readFileSync(join(root, 'app/index.html'), 'utf8')
  .replace('<!--CSS-->', () => `<style>${cssText}</style>`)
  .replace('<!--JS-->', () => `<script>${jsText}</script>`);

mkdirSync(join(root, 'dist'), { recursive: true });
const out = join(root, 'dist/task-card.html');
// Write then rename so a concurrent reader never sees a half-written file.
const tmp = `${out}.${process.pid}.tmp`;
writeFileSync(tmp, html);
renameSync(tmp, out);
console.log(`dist/task-card.html ${Buffer.byteLength(html)} bytes`);
