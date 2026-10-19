// Rebuild after verifying the official PDF.js tarball recorded in UPSTREAM.json.
// Install esbuild@0.28.2 in a test/build environment, or set ESBUILD_MODULE.
import {fileURLToPath} from 'node:url';
const esbuild=await import(process.env.ESBUILD_MODULE || 'esbuild');
const base=fileURLToPath(new URL('../vendor/pdfjs/',import.meta.url));
for(const [input,output,globalName] of [['pdf.min.mjs','pdf.file.js','pdfjsLib'],['pdf.worker.min.mjs','pdf.worker.file.js','pdfjsWorker']]) {
 const identifier='__'+globalName+'BridgeSource';
 esbuild.buildSync({entryPoints:[base+input],outfile:base+output,bundle:true,format:'iife',globalName,minify:true,legalComments:'inline',target:'es2022',define:{'import.meta.url':identifier},banner:{js:'var '+identifier+' = document.currentScript.src;'}});
}
