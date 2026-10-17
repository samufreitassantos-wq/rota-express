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
- `src/lib/geocode.js` — ORS se houver chave, senão Nominatim; cache no localStorage. Busca por RUA + NÚMERO + cidade (`queryVariants`): bairro/CEP fazem o Nominatim falhar; depois tenta o endereço completo e por fim só a rua (aproximada)
- `src/lib/planner.js` — ORS com fallback para otimização local. `planStreetRoute` (usado pelo app): agrupa por rua, otimiza a ordem das RUAS e percorre os números em sequência
- `src/lib/streets.js` — agrupamento por rua (nome normalizado; mesmo nome a > 3 km ou em outra cidade = outra rua), ordem dos números, trechos para a tela (`streetRuns`), mover/inverter rua (puro, testado). A aba Rota mostra ruas com seus números; `plan.order` continua sendo a lista de ids das paradas
- `src/lib/pdf.js` — texto de PDF via pdf.js (build **legacy**, necessária no Safari/iPad); páginas sem texto vão para OCR
- `src/lib/ocr.js` — Tesseract.js com arquivos em `public/ocr/` (gerados por `scripts/copy-ocr-assets.mjs` no predev/prebuild; não versionados)
- `src/lib/spreadsheet.js` — leitura de .xlsx/.ods (fflate + XML mínimo, com limites) e CSV/TSV; não usar o pacote `xlsx` do npm (vulnerável) (puro, testado; fixtures reais em `tests/fixtures/`)
- `src/lib/columns.js` — reconhece colunas por título (sinônimos pt/en, títulos cortados) ou conteúdo, monta endereço + `stop.ref` (cliente/pedido/telefone/complemento) (puro, testado). Mapeamento escolhido fica em `rx.sheetMaps` por assinatura dos títulos
- `src/lib/timeWindows.js` — janelas de horário (windowStart/windowEnd "HH:MM"), simulação de ETA e otimização local com janelas (puro, testado)
- `src/lib/navLinks.js` — links Google Maps/Waze pelo ENDEREÇO (OSM no Brasil raramente tem número; coordenadas viram o meio da rua). Coordenadas só com `stop.pinAdjusted`. `stop.precise=false` = geocodificação só achou a rua
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
- `src/lib/sanitize.js` — higienização de rotas vindas de fora (nuvem/backup/aparelho) contra XSS (puro, testado)
- `docs/SEGURANCA.md` — relatório de segurança, controles, riscos e checklist
- `src/main.js` — UI (abas: Importar, Paradas, Rota, Histórico, Ajustes)
- `public/sw.js`, `public/manifest.webmanifest` — PWA

## Regras
- Nunca commitar chaves de API. A chave ORS é digitada pelo usuário e fica só no localStorage do aparelho.
- Nenhum serviço pago obrigatório: o app precisa funcionar sem chave (Nominatim + otimização local).
- A rede deste contêiner bloqueia ORS/Nominatim/tiles: testes usam fetch simulado. Não afirmar que a integração real foi testada sem evidência.
- Interface e textos em português do Brasil; alvos de toque ≥ 44px.
- Nuvem: nunca usar a chave service_role/secret no app; regras de acesso sempre no banco (RLS). Mudou o schema? Mantenha-o idempotente e atualize `tests/rls.test.js`.
- Segurança: todo dado de rota vindo de fora passa por `sanitizeRoute`; todo texto/atributo em HTML usa `esc()`. CSV escapa fórmulas. CSP no build (`vite.config.js`): não use `fetch` em data: URLs, eval ou scripts inline. Atualize `docs/SEGURANCA.md` ao mudar controles.
- `[hidden]` tem `display:none !important` no CSS — não remova (vários componentes usam display próprio).
- Mudou o formato dos dados salvos? Escreva uma migração (ver `migrateStop`) — o usuário já tem rotas no aparelho.
