// Extração de texto de PDFs no próprio navegador (pdf.js).
// Páginas sem texto (PDF escaneado) são renderizadas e lidas com OCR.
// Build "legacy": inclui polyfills (ex.: Map.getOrInsertComputed) para Safari/iPad e navegadores mais antigos.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { recognize } from './ocr.js';

let pdfjs;
// Abaixo disso, a página é tratada como imagem escaneada.
export const MIN_TEXT_CHARS = 20;
const OCR_SCALE = 2;

/** Agrupa itens de texto por linha (mesma coordenada Y) e devolve o texto com quebras de linha. */
export function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str?.trim()) continue;
    const x = it.transform[4];
    const y = it.transform[5];
    let row = rows.find((r) => Math.abs(r.y - y) <= 2.5);
    if (!row) rows.push((row = { y, parts: [] }));
    row.parts.push({ x, str: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((r) => r.parts.sort((a, b) => a.x - b.x).map((p) => p.str.trim()).join(' ')).join('\n');
}

async function renderPage(page) {
  const viewport = page.getViewport({ scale: OCR_SCALE });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
  return canvas;
}

/**
 * @param onProgress ({ page, pages, ocr, progress }) — `ocr` indica que a página está sendo lida por OCR.
 * @returns {{ text: string, ocrPages: number }}
 */
export async function extractPdfText(file, { onProgress } = {}) {
  if (!pdfjs) {
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const pages = [];
    let ocrPages = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      onProgress?.({ page: n, pages: doc.numPages, ocr: false, progress: 0 });
      const page = await doc.getPage(n);
      let text = itemsToLines((await page.getTextContent()).items);
      if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
        ocrPages++;
        const canvas = await renderPage(page);
        text = await recognize(canvas, (progress) => onProgress?.({ page: n, pages: doc.numPages, ocr: true, progress }));
        canvas.width = canvas.height = 0;
      }
      pages.push(text);
    }
    return { text: pages.join('\n'), ocrPages };
  } finally {
    await task.destroy();
  }
}

/** Foto ou imagem de um romaneio impresso. */
export function extractImageText(file, { onProgress } = {}) {
  return recognize(file, (progress) => onProgress?.({ page: 1, pages: 1, ocr: true, progress }));
}
