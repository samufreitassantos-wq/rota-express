// Links de navegação externos (não exigem chave de API).
//
// Por padrão o destino vai como ENDEREÇO escrito: o Google Maps/Waze têm a numeração das casas
// no Brasil muito mais completa que o OpenStreetMap (que muitas vezes só conhece a rua e devolve
// o meio dela). Coordenadas só são usadas quando o pino foi ajustado à mão (posição confirmada)
// ou quando não há endereço.
const fmt = ({ lat, lng }) => `${Number(lat.toFixed(6))},${Number(lng.toFixed(6))}`;

/** Texto/coordenada de destino de uma parada. `query` = endereço completo para busca. */
export function navDestination(stop, query) {
  const text = String(query ?? stop.address ?? '').replace(/[|\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (stop.pinAdjusted || !text) return stop.lat != null ? fmt(stop) : text;
  return text;
}

export function googleMapsUrl(stop, query) {
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(navDestination(stop, query))}&travelmode=driving`;
}

export function wazeUrl(stop, query) {
  const dest = navDestination(stop, query);
  // Waze: "ll" para coordenadas, "q" para buscar o endereço.
  return stop.pinAdjusted || !String(query ?? stop.address ?? '').trim()
    ? `https://waze.com/ul?ll=${dest}&navigate=yes`
    : `https://waze.com/ul?q=${encodeURIComponent(dest)}&navigate=yes`;
}

// O Google Maps aceita no máximo 3 paradas intermediárias quando o link abre no celular/tablet.
export const MOBILE_MAX_WAYPOINTS = 3;

/**
 * Rota no Google Maps passando pelas próximas paradas (origem = localização atual do aparelho).
 * `queryOf(stop)` devolve o endereço completo de cada parada.
 */
export function googleMapsMultiUrl(stops, queryOf = (s) => s.address, maxWaypoints = MOBILE_MAX_WAYPOINTS) {
  const pts = stops.slice(0, maxWaypoints + 1);
  if (!pts.length) return null;
  const dests = pts.map((s) => navDestination(s, queryOf(s)));
  const dest = dests.at(-1);
  const via = dests.slice(0, -1).join('|');
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(dest)}${via ? `&waypoints=${encodeURIComponent(via)}` : ''}&travelmode=driving`;
}
