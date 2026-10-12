// Regras de entrega: situação de cada parada, estatísticas, reordenação e exportação CSV.

export const FAIL_REASONS = [
  'Cliente ausente',
  'Recusado',
  'Endereço não encontrado',
  'Local fechado',
  'Endereço incorreto',
  'Outro',
];

export const OUTCOME_LABEL = { delivered: 'Entregue', failed: 'Problema' };

/** Converte paradas salvas no formato antigo (delivered/deliveredAt) para outcome/outcomeAt. */
export function migrateStop(s) {
  if (s.outcome === undefined) {
    s.outcome = s.delivered ? 'delivered' : null;
    s.outcomeAt = s.deliveredAt;
  }
  delete s.delivered;
  delete s.deliveredAt;
  return s;
}

export function routeStats(stops) {
  const delivered = stops.filter((s) => s.outcome === 'delivered').length;
  const failed = stops.filter((s) => s.outcome === 'failed').length;
  return { total: stops.length, delivered, failed, pending: stops.length - delivered - failed };
}

/** Move `id` dentro de `order` para a posição `to` (limitada aos extremos). Retorna nova lista. */
export function moveTo(order, id, to) {
  const from = order.indexOf(id);
  if (from < 0) return order.slice();
  const next = order.slice();
  next.splice(from, 1);
  next.splice(Math.max(0, Math.min(to, next.length)), 0, id);
  return next;
}

export const moveBy = (order, id, delta) => moveTo(order, id, order.indexOf(id) + delta);

const csvCell = (v) => {
  let s = String(v ?? '');
  // Injeção de fórmulas (OWASP "CSV Injection"): texto começando com = + - @ ou tab/CR vira
  // fórmula no Excel/Sheets. Prefixa com apóstrofo; números (ex.: -23.5) ficam como estão.
  if (typeof v !== 'number' && /^[=+\-@\t\r]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = `'${s}`;
  return /[;"\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString('pt-BR') : '');

/**
 * CSV com ";" (padrão do Excel em pt-BR) e BOM UTF-8.
 * `stops` deve estar na ordem de visita.
 */
export function toCsv(route, stops) {
  const header = ['Ordem', 'Endereço', 'Situação', 'Motivo', 'Observação', 'Chegada (GPS)', 'Horário', 'Distância do ponto (m)', 'Foto', 'Latitude', 'Longitude'];
  const rows = stops.map((s, i) => [
    i + 1,
    s.address,
    OUTCOME_LABEL[s.outcome] ?? 'Pendente',
    s.outcome === 'failed' ? s.failReason ?? '' : '',
    s.note ?? '',
    fmtTime(s.arrivedAt),
    fmtTime(s.outcomeAt),
    s.outcomeDistM ?? '',
    s.hasPhoto ? 'sim' : '',
    s.lat != null ? s.lat.toFixed(6) : '',
    s.lng != null ? s.lng.toFixed(6) : '',
  ]);
  return '﻿' + [header, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

export function routeFileName(route, ext) {
  const d = new Date(route.finishedAt ?? route.createdAt);
  const pad = (n) => String(n).padStart(2, '0');
  return `rota-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.${ext}`;
}
