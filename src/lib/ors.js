// Cliente do OpenRouteService (plano gratuito). A chave é fornecida pelo usuário
// nas Configurações e fica apenas no armazenamento local do aparelho.

const BASE = 'https://api.openrouteservice.org';
// Limite conservador de pontos por requisição de rota (o plano gratuito tem limites por chamada).
export const DIRECTIONS_CHUNK = 50;

async function orsFetch(path, { key, body, fetchImpl = fetch, params } = {}) {
  if (!key) throw new Error('Chave do OpenRouteService não configurada.');
  const url = new URL(BASE + path);
  if (params) for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetchImpl(url.toString(), {
    method: body ? 'POST' : 'GET',
    headers: {
      Authorization: key,
      Accept: 'application/json, application/geo+json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = j?.error?.message || j?.error || j?.message || '';
    } catch { /* corpo não-JSON */ }
    throw new Error(`OpenRouteService ${res.status}${detail ? `: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  }
  return res.json();
}

/** Geocodifica um endereço no Brasil. Retorna {lat, lng, label, confidence} ou null. */
export async function orsGeocode(text, { key, fetchImpl, focus } = {}) {
  const params = { text, 'boundary.country': 'BR', size: '1' };
  if (focus) Object.assign(params, { 'focus.point.lat': focus.lat, 'focus.point.lon': focus.lng });
  const data = await orsFetch('/geocode/search', { key, fetchImpl, params });
  const f = data?.features?.[0];
  if (!f) return null;
  const [lng, lat] = f.geometry.coordinates;
  return { lat, lng, label: f.properties?.label ?? text, confidence: f.properties?.confidence ?? null };
}

/**
 * Otimiza a ordem de visita (VROOM via ORS). `start` = {lat,lng}; `stops` = [{lat,lng}].
 * Retorna índices de `stops` na ordem otimizada, seguidos dos não atribuídos.
 */
export async function orsOptimize(start, stops, { key, fetchImpl } = {}) {
  const body = {
    jobs: stops.map((s, i) => ({ id: i + 1, location: [s.lng, s.lat] })),
    vehicles: [{ id: 1, profile: 'driving-car', start: [start.lng, start.lat] }],
  };
  const data = await orsFetch('/optimization', { key, fetchImpl, body });
  const steps = data?.routes?.[0]?.steps ?? [];
  const order = steps.filter((s) => s.type === 'job').map((s) => (s.job ?? s.id) - 1);
  const missing = stops.map((_, i) => i).filter((i) => !order.includes(i));
  return [...order, ...missing];
}

/** Calcula a geometria da rota passando pelos pontos, em blocos. */
export async function orsDirections(points, { key, fetchImpl } = {}) {
  const coords = [];
  let distance = 0;
  let duration = 0;
  for (let i = 0; i < points.length - 1; i += DIRECTIONS_CHUNK - 1) {
    const chunk = points.slice(i, i + DIRECTIONS_CHUNK);
    if (chunk.length < 2) break;
    const data = await orsFetch('/v2/directions/driving-car/geojson', {
      key,
      fetchImpl,
      body: { coordinates: chunk.map((p) => [p.lng, p.lat]) },
    });
    const f = data?.features?.[0];
    if (!f) throw new Error('OpenRouteService não retornou rota.');
    const line = f.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
    coords.push(...(coords.length ? line.slice(1) : line));
    distance += f.properties?.summary?.distance ?? 0;
    duration += f.properties?.summary?.duration ?? 0;
  }
  return { coords, distance, duration };
}
