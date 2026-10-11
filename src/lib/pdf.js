// Extração de texto de PDFs no próprio navegador (pdf.js). PDFs escaneados (imagem) não têm texto.
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

let pdfjs;

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

export async function extractPdfText(file) {
  if (!pdfjs) {
    pdfjs = await import('pdfjs-dist');
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const content = await page.getTextContent();
      pages.push(itemsToLines(content.items));
    }
    return pages.join('\n');
  } finally {
    await task.destroy();
  }
}
