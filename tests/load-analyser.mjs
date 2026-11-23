// tests/load-analyser.mjs
// The Korean analyser kept in src/vendor/garu-ko, loaded in Node for the
// tests (the app loads the same files in the browser through
// src/utils/koreanAnalyser.js).
//
//   const analyse = await loadAnalyser();
//   analyse('내일 비가 와요.') -> [{ text, pos, start, end }, ...]

import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const vendor = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'vendor', 'garu-ko');

export async function loadAnalyser() {
  const glue = await import('../src/vendor/garu-ko/garu_wasm.js');
  glue.initSync({ module: await readFile(join(vendor, 'garu_wasm_bg.wasm')) });
  const engine = new glue.GaruWasm(new Uint8Array(await readFile(join(vendor, 'base.gmdl'))), false);
  return (text) => (text ? engine.analyze(text).tokens : []);
}
