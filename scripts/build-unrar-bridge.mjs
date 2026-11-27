// Rebuild the CBR (RAR) browser bridge from the vendored node-unrar-js ESM
// sources recorded in vendor/UPSTREAM.json, plus the official wasm bytes.
//
//   npm i --no-save esbuild@0.28.2
//   node scripts/build-unrar-bridge.mjs
//
// Inputs (verbatim from the official npm tarball node-unrar-js@2.0.2, esm/):
//   vendor/unrar/index.esm.js          entry point (createExtractorFromData)
//   vendor/unrar/unrar.js              Emscripten module factory
//   vendor/unrar/unrar.wasm            official prebuilt wasm bytes
// Outputs:
//   vendor/unrar/unrar.file.js         IIFE bridge, global LLLUnrar. The wasm is
//                                      inlined as base64 so a single classic
//                                      script is enough under file://.
//   vendor/unrar/unrar.mjs             ESM entry for the http(s) path.
//
// Why the wasm bytes are inlined: the Emscripten output deliberately avoids
// fetch() for file: URIs (isFileURI), so it cannot load unrar.wasm on its own
// from a file:// page. Handing the bytes to
// createExtractorFromData({ data, wasmBinary }) is the documented option and
// needs no network request at all.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const esbuild = await import(process.env.ESBUILD_MODULE || 'esbuild');
const base = fileURLToPath(new URL('../vendor/unrar/', import.meta.url));

// The tarball ships extensionless ESM specifiers ('./js/ExtractorData'), which
// no browser bundler can resolve. Rewrite them to the vendored filenames.
const specifierRewrites = {
  './js/ExtractorData': './ExtractorData.js',
  './js/unrar.singleton': './unrar.singleton.js',
  './js/Extractor': './Extractor.js',
  './ExtractorData.helper': './ExtractorData.helper.js',
  './Extractor': './Extractor.js',
  './unrar': './unrar.js',
};

function rewriteSpecifiers(contents) {
  return contents.replace(
    /(from\s*)(['"])([^'"]+)\2/g,
    function (whole, from, quote, spec) {
      const mapped = specifierRewrites[spec];
      return mapped ? from + quote + mapped + quote : whole;
    },
  );
}

const rewritePlugin = {
  name: 'node-unrar-js-extensionless-specifiers',
  setup(build) {
    build.onLoad({ filter: /\.js$/ }, function (args) {
      return { contents: rewriteSpecifiers(readFileSync(args.path, 'utf8')), loader: 'js' };
    });
  },
};

const WASM_NAMESPACE = 'unrar-wasm-b64';
const b64Plugin = {
  name: 'unrar-wasm-b64',
  setup(build) {
    build.onResolve({ filter: /^unrar-wasm:b64$/ }, function () {
      return { path: 'unrar.wasm', namespace: WASM_NAMESPACE };
    });
    build.onLoad({ filter: /.*/, namespace: WASM_NAMESPACE }, function () {
      const b64 = readFileSync(base + 'unrar.wasm').toString('base64');
      return { contents: 'export default ' + JSON.stringify(b64) + ';', loader: 'js' };
    });
  },
};

const ENTRY = [
  "import { createExtractorFromData as createUnrarExtractor, UnrarError } from './index.esm.js';",
  "import wasmBase64 from 'unrar-wasm:b64';",
  'export function decodeWasm(b64) {',
  '  const binary = atob(b64);',
  '  const bytes = new Uint8Array(binary.length);',
  '  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);',
  '  return bytes.buffer;',
  '}',
  'export const wasmBinary = decodeWasm(wasmBase64);',
  'export function createExtractorFromData(options) {',
  '  return createUnrarExtractor(Object.assign({ wasmBinary: wasmBinary }, options));',
  '}',
  'export { UnrarError };',
].join('\n');

// esbuild resolves stdin specifiers against resolveDir, so the entry never has
// to land inside vendor/ (the vendor tree stays byte-for-byte verifiable).
const entryOptions = {
  stdin: { contents: ENTRY, resolveDir: base, sourcefile: 'unrar-entry.js', loader: 'js' },
  bundle: true,
  target: 'es2022',
  legalComments: 'none',
};

// Plugins are not allowed in the synchronous API, so this build is async.
await esbuild.build(
  Object.assign({}, entryOptions, {
    plugins: [rewritePlugin, b64Plugin],
    format: 'iife',
    globalName: 'LLLUnrar',
    outfile: base + 'unrar.file.js',
  }),
);

await esbuild.build(
  Object.assign({}, entryOptions, {
    plugins: [rewritePlugin, b64Plugin],
    format: 'esm',
    outfile: base + 'unrar.mjs',
  }),
);

console.log('wrote', base + 'unrar.file.js');
console.log('wrote', base + 'unrar.mjs');
