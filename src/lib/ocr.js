// OCR no próprio aparelho (Tesseract.js). Os arquivos ficam em ./ocr/ (copiados no build),
// então nada é enviado para servidores. Carregado só quando necessário (~5 MB na 1ª vez).
let workerPromise;
let progressCb = null;

function getWorker() {
  workerPromise ??= (async () => {
    const { createWorker } = await import('tesseract.js');
    const base = new URL('ocr/', document.baseURI).href;
    return createWorker('por', 1, {
      workerPath: `${base}worker.min.js`,
      corePath: `${base}core`,
      langPath: `${base}lang`,
      workerBlobURL: false,
      logger: (m) => progressCb?.(m),
    });
  })().catch((err) => {
    workerPromise = undefined;
    throw err;
  });
  return workerPromise;
}

/** Reconhece o texto de uma imagem/canvas. `onProgress(fração 0..1, etapa)`. */
export async function recognize(image, onProgress) {
  progressCb = (m) => onProgress?.(m.progress ?? 0, m.status);
  try {
    const worker = await getWorker();
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    progressCb = null;
  }
}
