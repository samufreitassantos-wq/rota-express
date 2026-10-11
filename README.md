# Rota Express

Aplicativo web (PWA) de roteirização de entregas, pensado para celular e tablet.

## Funcionalidades (v0.1)

- **Importar PDFs** com endereços (texto lido no próprio aparelho com pdf.js), colar texto ou **foto do romaneio**. PDFs escaneados e fotos são lidos com **OCR no aparelho** (Tesseract.js, português) — nenhum arquivo sai do aparelho.
- **Extração e correção** de endereços brasileiros: expande abreviações (R., Av., Al., Tv...), formata CEP, junta linhas de bairro/cidade/CEP, remove duplicados. Cada endereço pode ser editado, removido ou adicionado.
- **Localização (geocodificação)**: OpenRouteService quando há chave; sem chave, Nominatim (OpenStreetMap, gratuito, 1 req/s). Resultados ficam em cache no aparelho.
- **Otimização de rota** (30–60 paradas): OpenRouteService (VROOM) quando há chave; caso contrário ou em caso de falha, heurística local (vizinho mais próximo + 2-opt) em distância de linha reta.
- **Mapa interativo** (Leaflet + OpenStreetMap) com pinos numerados; arraste um pino para corrigir a posição.
- **Botões Google Maps e Waze** para navegar até cada parada.
- **Registro de entregas**: "Entregue" ou "Problema" (com motivo: ausente, recusado, local fechado...), horário, observação e **foto de comprovante** (comprimida e guardada no aparelho).
- **Horário de entrega por parada** (ex.: das 14:00 às 16:00) considerado na otimização (ORS ou local), com **previsão de chegada** ao vivo, término previsto e alerta de atraso. Velocidade média e tempo por parada ajustáveis.
- **Reordenar paradas** manualmente (▲▼ ou "Fazer a seguir").
- **Google Maps com as próximas 4 paradas** em um único link.
- **Histórico** de rotas finalizadas: exportar **CSV** (abre no Excel) e **relatório em PDF** gerado no aparelho (com fotos), pelo menu de compartilhar, reusar endereços, excluir.
- **Resumo do dia, 7 e 30 dias**: entregas, taxa de sucesso, km, tempo na rua, média por dia, gráfico de entregas por dia e problemas por motivo.
- **Backup e restauração** de histórico, rota em andamento e fotos em um arquivo (para trocar de aparelho ou se o navegador apagar os dados), com lembrete semanal. A chave do ORS não entra no backup.
- **PWA instalável** com funcionamento offline da interface.

Tudo fica salvo no aparelho (`localStorage`; fotos no IndexedDB). Não há servidor próprio — por isso, faça backup em **Ajustes → Fazer backup**.

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

- O OCR baixa ~5 MB do próprio app na primeira vez (depois fica em cache). A qualidade depende da foto/scan: sempre confira os endereços lidos.
- Sem chave ORS, a otimização usa distância em linha reta (não considera ruas/mão).
- O plano gratuito do ORS tem limites diários e por requisição; se a otimização falhar, o app usa o modo local e mostra um aviso.
