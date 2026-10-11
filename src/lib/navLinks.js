// Links de navegação externos (não exigem chave de API).
const fmt = ({ lat, lng }) => `${Number(lat.toFixed(6))},${Number(lng.toFixed(6))}`;

export function googleMapsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${fmt(p)}&travelmode=driving`;
}

export function wazeUrl(p) {
  return `https://waze.com/ul?ll=${fmt(p)}&navigate=yes`;
}

// O Google Maps aceita no máximo 3 paradas intermediárias quando o link abre no celular/tablet.
export const MOBILE_MAX_WAYPOINTS = 3;

/** Rota no Google Maps passando pelas próximas paradas (origem = localização atual do aparelho). */
export function googleMapsMultiUrl(points, maxWaypoints = MOBILE_MAX_WAYPOINTS) {
  const pts = points.slice(0, maxWaypoints + 1);
  if (!pts.length) return null;
  const dest = pts[pts.length - 1];
  const via = pts.slice(0, -1).map(fmt).join('|');
  return `https://www.google.com/maps/dir/?api=1&destination=${fmt(dest)}${via ? `&waypoints=${encodeURIComponent(via)}` : ''}&travelmode=driving`;
}
