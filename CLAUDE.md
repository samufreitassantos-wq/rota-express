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
- `src/lib/tracking.js` — GPS: km/velocidade reais, chegada (raio 50 m), tempo real por parada; `route.tracking`, `stop.arrivedAt/outcomeFix/outcomeDistM` (puro, testado). iOS só envia GPS com o app aberto; usamos Wake Lock
- `src/lib/stats.js` — resumo por período (hoje/7/30 dias): entregas, sucesso, km, tempo na rua, motivos (puro, testado)
- `src/lib/backup.js` — backup/restauração em JSON (sem a chave ORS; fotos como data URL; versão do formato em BACKUP_VERSION)
- `src/lib/photos.js` — fotos de comprovante no IndexedDB (chave = id da parada)
- `src/lib/cloud.js` — adaptador Supabase (login por código OTP, rotas, fotos, funções de admin); só ativo com VITE_SUPABASE_URL/ANON_KEY no build
- `src/lib/sync.js` — sincronização aparelho↔nuvem (vence o updatedAt mais recente; compara instantes, não texto) (puro, testado)
- `supabase/schema.sql` — tabelas + RLS (testado em `tests/rls.test.js` com PGlite); `supabase/admin.sql` — 1º admin
- `scripts/mock-supabase.mjs` — imita a API do Supabase sobre PGlite com o schema real, para testar o app com login sem internet (`npm run mock:supabase`; build com VITE_SUPABASE_URL=http://localhost:54321)
- `docs/CONFIGURAR-NUVEM.md` — passo a passo do usuário (tablet)
- `src/main.js` — UI (abas: Importar, Paradas, Rota, Histórico, Ajustes)
- `public/sw.js`, `public/manifest.webmanifest` — PWA

## Regras
- Nunca commitar chaves de API. A chave ORS é digitada pelo usuário e fica só no localStorage do aparelho.
- Nenhum serviço pago obrigatório: o app precisa funcionar sem chave (Nominatim + otimização local).
- A rede deste contêiner bloqueia ORS/Nominatim/tiles: testes usam fetch simulado. Não afirmar que a integração real foi testada sem evidência.
- Interface e textos em português do Brasil; alvos de toque ≥ 44px.
- Nuvem: nunca usar a chave service_role/secret no app; regras de acesso sempre no banco (RLS). Mudou o schema? Mantenha-o idempotente e atualize `tests/rls.test.js`.
- `[hidden]` tem `display:none !important` no CSS — não remova (vários componentes usam display próprio).
- Mudou o formato dos dados salvos? Escreva uma migração (ver `migrateStop`) — o usuário já tem rotas no aparelho.
