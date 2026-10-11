// Links de navegação externos (não exigem chave de API).
const fmt = ({ lat, lng }) => `${Number(lat.toFixed(6))},${Number(lng.toFixed(6))}`;

export function googleMapsUrl(p) {
  return `https://www.google.com/maps/dir/?api=1&destination=${fmt(p)}&travelmode=driving`;
}

export function wazeUrl(p) {
  return `https://waze.com/ul?ll=${fmt(p)}&navigate=yes`;
}
