// Resumo de desempenho por período (hoje / 7 dias / 30 dias) a partir das rotas salvas.

export const PERIODS = { today: 'Hoje', week: '7 dias', month: '30 dias' };
const DAYS = { today: 1, week: 7, month: 30 };

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Lista de dias (YYYY-MM-DD, horário local) do período, do mais antigo ao mais recente. */
export function periodDays(period, now = new Date()) {
  const n = DAYS[period] ?? 7;
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (n - 1 - i));
    return dayKey(d);
  });
}

/** Minutos entre a primeira e a última entrega registrada (tempo efetivo na rua). */
function workMinutes(stops) {
  const times = stops.map((s) => Date.parse(s.outcomeAt)).filter(Number.isFinite);
  return times.length > 1 ? (Math.max(...times) - Math.min(...times)) / 60000 : 0;
}

/**
 * Cada parada conta no dia em que recebeu a situação (outcomeAt); a distância da rota
 * conta no dia da rota (finalizada ou criada).
 */
export function summarize(routes, period = 'week', now = new Date()) {
  const days = periodDays(period, now);
  const inPeriod = new Set(days);
  const perDay = Object.fromEntries(days.map((d) => [d, { date: d, delivered: 0, failed: 0, km: 0 }]));
  const reasons = {};
  let delivered = 0;
  let failed = 0;
  let km = 0;
  let minutes = 0;
  let routeCount = 0;

  for (const r of routes) {
    const routeDay = dayKey(new Date(r.finishedAt ?? r.createdAt));
    let counted = false;
    for (const s of r.stops) {
      if (!s.outcome || !s.outcomeAt) continue;
      const d = dayKey(new Date(s.outcomeAt));
      if (!inPeriod.has(d)) continue;
      counted = true;
      if (s.outcome === 'delivered') {
        delivered++;
        perDay[d].delivered++;
      } else if (s.outcome === 'failed') {
        failed++;
        perDay[d].failed++;
        const why = s.failReason || 'Sem motivo';
        reasons[why] = (reasons[why] ?? 0) + 1;
      }
    }
    if (inPeriod.has(routeDay) && r.plan?.distance) {
      km += r.plan.distance / 1000;
      perDay[routeDay].km += r.plan.distance / 1000;
      counted = true;
    }
    if (counted) {
      routeCount++;
      minutes += workMinutes(r.stops.filter((s) => s.outcomeAt && inPeriod.has(dayKey(new Date(s.outcomeAt)))));
    }
  }

  const done = delivered + failed;
  const activeDays = Object.values(perDay).filter((d) => d.delivered + d.failed > 0).length;
  return {
    period,
    days: Object.values(perDay),
    routes: routeCount,
    delivered,
    failed,
    successRate: done ? delivered / done : null,
    km,
    workMinutes: minutes,
    activeDays,
    perActiveDay: activeDays ? delivered / activeDays : null,
    reasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]),
  };
}
