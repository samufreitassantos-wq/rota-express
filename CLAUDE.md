# Rota Express — notas para o Claude

App web (PWA) de roteirização de entregas. Vite + JavaScript puro (ES modules), Leaflet, pdf.js. Sem backend.

## Comandos
- `npm test` — testes unitários (Vitest) em `tests/`
- `npm run build` — gera `dist/`
- `npm run preview -- --port 4173` — serve o build localmente (o usuário usa só tablet: valide com Playwright/Chromium e envie capturas de tela)

## Estrutura
- `src/lib/addressParser.js` — extração/normalização de endereços BR (puro, testado)
- `src/lib/geo.js` — haversine + vizinho mais próximo + 2-opt (puro, testado)
- `src/lib/ors.js` — cliente OpenRouteService (geocode, optimization, directions)
- `src/lib/geocode.js` — ORS se houver chave, senão Nominatim; cache no localStorage
- `src/lib/planner.js` — ORS com fallback para otimização local
- `src/lib/pdf.js` — texto de PDF via pdf.js (build **legacy**, necessária no Safari/iPad); páginas sem texto vão para OCR
- `src/lib/ocr.js` — Tesseract.js com arquivos em `public/ocr/` (gerados por `scripts/copy-ocr-assets.mjs` no predev/prebuild; não versionados)
- `src/lib/timeWindows.js` — janelas de horário (windowStart/windowEnd "HH:MM"), simulação de ETA e otimização local com janelas (puro, testado)
- `src/lib/delivery.js` — situação da entrega (outcome: delivered/failed), reordenação, CSV (puro, testado)
- `src/lib/reportPdf.js` — relatório PDF com jsPDF (não usar window.print: não funciona no app instalado no iOS)
- `src/lib/backup.js` — backup/restauração em JSON (sem a chave ORS; fotos como data URL; versão do formato em BACKUP_VERSION)
- `src/lib/photos.js` — fotos de comprovante no IndexedDB (chave = id da parada)
- `src/main.js` — UI (abas: Importar, Paradas, Rota, Histórico, Ajustes)
- `public/sw.js`, `public/manifest.webmanifest` — PWA

## Regras
- Nunca commitar chaves de API. A chave ORS é digitada pelo usuário e fica só no localStorage do aparelho.
- Nenhum serviço pago obrigatório: o app precisa funcionar sem chave (Nominatim + otimização local).
- A rede deste contêiner bloqueia ORS/Nominatim/tiles: testes usam fetch simulado. Não afirmar que a integração real foi testada sem evidência.
- Interface e textos em português do Brasil; alvos de toque ≥ 44px.
- Mudou o formato dos dados salvos? Escreva uma migração (ver `migrateStop`) — o usuário já tem rotas no aparelho.
