// Higienização de rotas vindas de fora do código do app (nuvem, backup, armazenamento do aparelho).
// Os dados de uma rota são JSON livre controlado pelo cliente: outra pessoa (ou um arquivo de
// backup adulterado) pode colocar HTML/atributos em qualquer campo. Aqui cada campo é convertido
// para o tipo esperado ANTES de chegar à tela. As telas também escapam tudo (defesa em camadas).

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const OUTCOMES = new Set(['delivered', 'failed']);
const STATUSES = new Set(['pending', 'ok', 'notfound', 'error']);
const METHODS = new Set(['ors', 'local']);

export const isSafeId = (v) => typeof v === 'string' && ID_RE.test(v);
/** Identificador seguro para HTML/atributos/caminhos; caracteres fora do padrão são trocados por "_". */
export function safeId(v) {
  const s = String(v ?? '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return s || `id_${Math.random().toString(36).slice(2, 10)}`;
}
const str = (v, max = 500) => (v == null ? undefined : String(v).slice(0, max));
const num = (v, min = -Infinity, max = Infinity) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
};
const date = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v.slice(0, 40) : undefined);
const bool = (v) => (v === true ? true : undefined);
const tri = (v) => (v === true || v === false ? v : undefined);
const lat = (v) => num(v, -90, 90);
const lng = (v) => num(v, -180, 180);
const point = (p) => (p && lat(p.lat) != null && lng(p.lng) != null ? { lat: lat(p.lat), lng: lng(p.lng) } : undefined);
const fix = (f) => {
  const p = point(f);
  return p && { ...p, acc: num(f.acc, 0, 1e5) ?? 0, t: num(f.t, 0) ?? 0 };
};

function clean(obj) {
  for (const k of Object.keys(obj)) if (obj[k] === undefined) delete obj[k];
  return obj;
}

export function sanitizeStop(s) {
  if (!s || typeof s !== 'object') return null;
  return clean({
    id: safeId(s.id),
    address: str(s.address) ?? '',
    status: STATUSES.has(s.status) ? s.status : 'pending',
    lat: lat(s.lat),
    lng: lng(s.lng),
    label: str(s.label),
    error: str(s.error, 200),
    // Formato antigo (delivered/deliveredAt) é convertido aqui mesmo, para não perder entregas.
    outcome: OUTCOMES.has(s.outcome) ? s.outcome : s.outcome === undefined && s.delivered === true ? 'delivered' : null,
    outcomeAt: date(s.outcomeAt) ?? (s.outcome === undefined ? date(s.deliveredAt) : undefined),
    failReason: str(s.failReason, 100),
    note: str(s.note, 1000),
    precise: tri(s.precise),
    pinAdjusted: bool(s.pinAdjusted),
    hasPhoto: bool(s.hasPhoto),
    photoSynced: bool(s.photoSynced),
    windowStart: HHMM_RE.test(s.windowStart ?? '') ? s.windowStart : undefined,
    windowEnd: HHMM_RE.test(s.windowEnd ?? '') ? s.windowEnd : undefined,
    arrivedAt: date(s.arrivedAt),
    outcomeFix: s.outcomeFix ? clean({ ...point(s.outcomeFix), acc: num(s.outcomeFix.acc, 0, 1e5) }) : undefined,
    outcomeDistM: num(s.outcomeDistM, 0, 4e7),
  });
}

function sanitizePlan(p) {
  if (!p || typeof p !== 'object') return null;
  return clean({
    order: Array.isArray(p.order) ? p.order.slice(0, 1000).map(safeId) : [],
    geometry: Array.isArray(p.geometry)
      ? p.geometry.slice(0, 50000).filter((c) => Array.isArray(c) && lat(c[0]) != null && lng(c[1]) != null).map((c) => [c[0], c[1]])
      : [],
    distance: num(p.distance, 0, 1e8) ?? 0,
    duration: num(p.duration, 0, 1e7) ?? null,
    method: METHODS.has(p.method) ? p.method : 'local',
    roadGeometry: bool(p.roadGeometry) ?? false,
    manual: bool(p.manual),
    windowsChanged: bool(p.windowsChanged),
    warnings: Array.isArray(p.warnings) ? p.warnings.slice(0, 10).map((w) => str(w, 300)) : [],
    start: point(p.start),
  });
}

function sanitizeTracking(t) {
  if (!t || typeof t !== 'object') return undefined;
  return clean({
    active: bool(t.active) ?? false,
    meters: num(t.meters, 0, 1e8) ?? 0,
    movingMeters: num(t.movingMeters, 0, 1e8) ?? 0,
    movingSeconds: num(t.movingSeconds, 0, 1e8) ?? 0,
    last: t.last ? fix(t.last) ?? null : null,
    lastSeen: t.lastSeen ? fix(t.lastSeen) : undefined,
    startedAt: date(t.startedAt),
  });
}

/** Rota completa com tipos garantidos. Retorna null se não for uma rota. */
export function sanitizeRoute(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.stops)) return null;
  const start = r.start && typeof r.start === 'object'
    ? clean({ input: str(r.start.input, 300), label: str(r.start.label, 300), ...point(r.start) })
    : null;
  return clean({
    id: safeId(r.id),
    name: str(r.name, 120) ?? 'Rota',
    createdAt: date(r.createdAt) ?? new Date().toISOString(),
    updatedAt: date(r.updatedAt),
    finishedAt: date(r.finishedAt) ?? null,
    start,
    stops: r.stops.slice(0, 1000).map(sanitizeStop).filter(Boolean),
    plan: sanitizePlan(r.plan),
    tracking: sanitizeTracking(r.tracking),
    ownerId: isSafeId(r.ownerId) || /^[0-9a-f-]{36}$/i.test(r.ownerId ?? '') ? r.ownerId : undefined,
  });
}
