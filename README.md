# Rota Express

Aplicativo web (PWA) de roteirização de entregas, pensado para celular e tablet.

## Funcionalidades (v0.1)

- **Importar PDFs** com endereços (texto lido no próprio aparelho com pdf.js) ou colar texto.
- **Extração e correção** de endereços brasileiros: expande abreviações (R., Av., Al., Tv...), formata CEP, junta linhas de bairro/cidade/CEP, remove duplicados. Cada endereço pode ser editado, removido ou adicionado.
- **Localização (geocodificação)**: OpenRouteService quando há chave; sem chave, Nominatim (OpenStreetMap, gratuito, 1 req/s). Resultados ficam em cache no aparelho.
- **Otimização de rota** (30–60 paradas): OpenRouteService (VROOM) quando há chave; caso contrário ou em caso de falha, heurística local (vizinho mais próximo + 2-opt) em distância de linha reta.
- **Mapa interativo** (Leaflet + OpenStreetMap) com pinos numerados; arraste um pino para corrigir a posição.
- **Botões Google Maps e Waze** para navegar até cada parada.
- **Registro de entregas** com horário, barra de progresso e destaque da próxima parada.
- **Histórico** de rotas finalizadas (reusar endereços / excluir).
- **PWA instalável** com funcionamento offline da interface.

Tudo fica salvo no `localStorage` do aparelho. Não há servidor próprio.

## Chave do OpenRouteService (opcional, gratuita)

1. Crie uma conta em <https://openrouteservice.org/dev/#/signup> e gere um token (plano gratuito).
2. No app, abra **Ajustes**, cole a chave e toque em **Salvar**.

A chave **não** vai para o repositório: ela fica só no navegador do seu aparelho e é enviada apenas para `api.openrouteservice.org`.

## Desenvolvimento

```bash
npm install
npm test          # testes unitários
npm run dev       # servidor de desenvolvimento
npm run build     # gera dist/
```

## Publicação (GitHub Pages)

O workflow `.github/workflows/deploy.yml` publica o app a cada push na branch `main`.
Configuração única (pelo navegador do tablet): **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Endereço resultante: `https://<usuario>.github.io/rota-express/`.

## Limitações conhecidas

- PDFs escaneados (imagem) não são lidos — não há OCR ainda.
- Sem chave ORS, a otimização usa distância em linha reta (não considera ruas/mão).
- O plano gratuito do ORS tem limites diários e por requisição; se a otimização falhar, o app usa o modo local e mostra um aviso.
