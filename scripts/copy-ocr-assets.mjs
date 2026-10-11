// Copia os arquivos do OCR (Tesseract) para public/ocr, para o app não depender de CDN.
import { cpSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const tessDir = dirname(require.resolve('tesseract.js/package.json'));
const coreDir = dirname(createRequire(join(tessDir, 'package.json')).resolve('tesseract.js-core/package.json'));
const langDir = join(dirname(require.resolve('@tesseract.js-data/por/package.json')), '4.0.0_best_int');
const out = new URL('../public/ocr/', import.meta.url).pathname;

const files = [
  [join(tessDir, 'dist/worker.min.js'), 'worker.min.js'],
  // Somente as variantes LSTM (o modo usado); o worker escolhe conforme o suporte a SIMD do aparelho.
  ...['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-relaxedsimd-lstm.wasm.js']
    .map((f) => [join(coreDir, f), `core/${f}`]),
  [join(langDir, 'por.traineddata.gz'), 'lang/por.traineddata.gz'],
];

for (const [src, dest] of files) {
  if (!existsSync(src)) throw new Error(`Arquivo do OCR não encontrado: ${src}`);
  mkdirSync(dirname(join(out, dest)), { recursive: true });
  cpSync(src, join(out, dest));
}
console.log(`OCR: ${files.length} arquivos copiados para public/ocr`);
