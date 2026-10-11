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
- `src/lib/pdf.js` — texto de PDF via pdf.js (sem OCR)
- `src/main.js` — UI (abas: Importar, Paradas, Rota, Histórico, Ajustes)
- `public/sw.js`, `public/manifest.webmanifest` — PWA

## Regras
- Nunca commitar chaves de API. A chave ORS é digitada pelo usuário e fica só no localStorage do aparelho.
- Nenhum serviço pago obrigatório: o app precisa funcionar sem chave (Nominatim + otimização local).
- A rede deste contêiner bloqueia ORS/Nominatim/tiles: testes usam fetch simulado. Não afirmar que a integração real foi testada sem evidência.
- Interface e textos em português do Brasil; alvos de toque ≥ 44px.
