import 'leaflet/dist/leaflet.css';
import './styles/app.css';
import L from 'leaflet';
import { extractAddresses, normalizeAddress } from './lib/addressParser.js';
import { extractPdfText, extractImageText } from './lib/pdf.js';
import { geocode, buildQuery } from './lib/geocode.js';
import { planRoute } from './lib/planner.js';
import { googleMapsUrl, googleMapsMultiUrl, wazeUrl, MOBILE_MAX_WAYPOINTS } from './lib/navLinks.js';
import { load, save, remove } from './lib/storage.js';
import { orsDirections } from './lib/ors.js';
import { haversine } from './lib/geo.js';
import { FAIL_REASONS, OUTCOME_LABEL, migrateStop, routeStats, moveTo, moveBy, toCsv, routeFileName } from './lib/delivery.js';
import { getPhoto, putPhoto, deletePhotos, clearPhotos, compressImage, requestPersistence, blobToDataUrl, dataUrlToBlob } from './lib/photos.js';
import { stopWindow, hasWindows, simulate, fmtHHMM, nowMinutes, DEFAULTS as TIMING_DEFAULTS } from './lib/timeWindows.js';
import { summarize } from './lib/stats.js';
import { newTracking, ingestFix, observedSpeedKmh, observedServiceMin, isArrived, isFresh, distanceTo, fmtDistance, farFromStopM } from './lib/tracking.js';
import { buildBackup, parseBackup, mergeHistory, backupFileName, photoIds } from './lib/backup.js';
import { cloudConfigured, cloud, photoPath } from './lib/cloud.js';
import { syncOnce, newSyncMeta, pendingCount } from './lib/sync.js';
import { sanitizeRoute } from './lib/sanitize.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => Math.random().toString(36).slice(2, 10);
const HISTORY_MAX = 50;

const settings = load('settings', { orsKey: '', defaultCity: '' });
const configuredTiming = () => ({
  speedKmh: Number(settings.speedKmh) || TIMING_DEFAULTS.speedKmh,
  serviceMin: Number(settings.serviceMin ?? TIMING_DEFAULTS.serviceMin),
});
/** Velocidade e tempo por parada: reais (medidos pelo GPS nesta rota) quando já há dados suficientes. */
function timing() {
  const t = configuredTiming();
  const speed = observedSpeedKmh(route?.tracking);
  const service = observedServiceMin(route?.stops ?? []);
  return { speedKmh: speed ?? t.speedKmh, serviceMin: service ?? t.serviceMin, observedSpeed: speed, observedService: service };
}
// Tudo que vem do armazenamento passa pela higienização (tipos garantidos antes de chegar à tela).
let route = sanitizeRoute(load('current', null)) ?? newRoute();
let history = (Array.isArray(load('history', [])) ? load('history', []) : []).map(sanitizeRoute).filter(Boolean);
// Dados salvos pela versão anterior usavam delivered/deliveredAt.
route.stops.forEach(migrateStop);
history.forEach((h) => h.stops.forEach(migrateStop));

function newRoute() {
  const now = new Date();
  return {
    id: uid(),
    name: `Rota ${now.toLocaleDateString('pt-BR')} ${now.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`,
    createdAt: now.toISOString(),
    start: null,
    stops: [],
    plan: null,
    finishedAt: null,
  };
}

/** Salva no aparelho sem marcar alteração (ex.: leituras do GPS, dados vindos da nuvem). */
function saveLocal() {
  if (!save('current', route)) setStatus('#stops-status', 'Não foi possível salvar no aparelho (armazenamento cheio?).', 'error');
  $('#route-name').textContent = route.name;
}

/** Salva uma alteração da rota atual e agenda o envio para a nuvem (quando há conta). */
function persist(syncDelayMs = 15000) {
  if (route.stops.length) route.updatedAt = new Date().toISOString();
  saveLocal();
  scheduleSync(syncDelayMs);
}

function saveHistory() {
  save('history', history);
  scheduleSync(3000);
}

function setStatus(sel, msg, kind = '') {
  const el = $(sel);
  el.textContent = msg;
  el.className = `status ${kind}`;
}

const fmtKm = (m) => `${(m / 1000).toFixed(1)} km`;
const fmtDur = (s) => (s == null ? '—' : `${Math.floor(s / 3600)}h${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`);

// ---------- Navegação por abas ----------
function showTab(name) {
  document.querySelectorAll('.view').forEach((v) => (v.hidden = v.dataset.view !== name));
  document.querySelectorAll('.tabbar button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  if (name === 'stops') renderStops();
  if (name === 'route') renderRoute();
  if (name === 'history') renderHistory();
  if (name === 'team') renderTeam(true);
  if (name === 'settings') {
    renderAccount();
    $('#ors-key').value = settings.orsKey;
    $('#default-city').value = settings.defaultCity;
    $('#speed-kmh').value = settings.speedKmh ?? '';
    $('#service-min').value = settings.serviceMin ?? '';
    renderBackupInfo();
  }
}
document.querySelector('.tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});

// ---------- Importação ----------
$('#pdf-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const texts = [];
  let ocrUsed = false;
  for (const [i, f] of files.entries()) {
    const label = files.length > 1 ? `${f.name} (${i + 1}/${files.length})` : f.name;
    const onProgress = ({ page, pages, ocr, progress }) => setStatus('#import-status', ocr
      ? `Lendo texto da imagem — ${label}, página ${page}/${pages}: ${Math.round(progress * 100)}%`
      : `Lendo ${label}, página ${page}/${pages}...`);
    setStatus('#import-status', `Lendo ${label}...`);
    try {
      if (f.type.startsWith('image/')) {
        texts.push(await extractImageText(f, { onProgress }));
        ocrUsed = true;
      } else {
        const { text, ocrPages } = await extractPdfText(f, { onProgress });
        texts.push(text);
        ocrUsed ||= ocrPages > 0;
      }
    } catch (err) {
      setStatus('#import-status', `Erro ao ler ${f.name}: ${err.message}`, 'error');
      return;
    }
  }
  const text = texts.join('\n');
  $('#raw-text').value = text;
  if (!text.trim()) {
    setStatus('#import-status', 'Nenhum texto encontrado no arquivo.', 'error');
    return;
  }
  importAddresses(extractAddresses(text).map((a) => a.address), ocrUsed);
});

$('#btn-extract').addEventListener('click', () => {
  importAddresses(extractAddresses($('#raw-text').value).map((a) => a.address));
});
$('#btn-one-per-line').addEventListener('click', () => {
  const lines = $('#raw-text').value.split(/\r?\n/).map(normalizeAddress).filter(Boolean);
  importAddresses(lines);
});

function importAddresses(addresses, ocrUsed = false) {
  const existing = new Set(route.stops.map((s) => s.address.toLowerCase()));
  const fresh = addresses.filter((a) => !existing.has(a.toLowerCase()));
  if (!fresh.length) {
    setStatus('#import-status', 'Nenhum endereço novo encontrado. Tente "1 linha = 1 endereço" ou edite o texto.', 'error');
    return;
  }
  route.stops.push(...fresh.map((address) => ({ id: uid(), address, status: 'pending', outcome: null })));
  route.plan = null;
  persist();
  setStatus('#import-status', `${fresh.length} endereço(s) adicionados. Revise na aba Paradas.`, 'ok');
  showTab('stops');
  if (ocrUsed) setStatus('#stops-status', 'Texto lido de imagem (OCR): confira números e nomes de rua antes de otimizar.', 'warn');
}

// ---------- Paradas ----------
const STATUS_LABEL = { pending: '…', ok: '✓', notfound: '✗ não encontrado', error: '⚠ erro' };

function renderStops() {
  $('#stops-count').textContent = route.stops.length;
  $('#start-input').value = route.start?.input ?? '';
  $('#start-status').textContent = route.start?.lat != null
    ? `Partida: ${route.start.label ?? `${route.start.lat.toFixed(5)}, ${route.start.lng.toFixed(5)}`}`
    : 'Defina a partida (endereço ou GPS). Sem partida, a primeira parada é usada.';
  $('#stops-list').innerHTML = route.stops.map((s) => `
    <li data-id="${esc(s.id)}" class="stop ${esc(s.status)}">
      <input class="addr" value="${esc(s.address)}" aria-label="Endereço" />
      <div class="meta">
        <span class="tag ${esc(s.status)}">${STATUS_LABEL[s.status] ?? ''}</span>
        ${s.status === 'ok' && s.precise === false ? `<span class="tag approx" title="${esc(APPROX_HINT)}">≈ aproximada</span>` : ''}
        ${s.label ? `<span class="muted small">${esc(s.label)}</span>` : ''}
      </div>
      <button class="del" title="Remover">🗑</button>
      <details class="tw" ${stopWindow(s) ? 'open' : ''}>
        <summary>⏰ ${esc(windowLabel(s) ?? 'Horário livre')}</summary>
        <div class="tw-row">
          <label class="small">Das <input class="tw-start" type="time" value="${esc(s.windowStart ?? '')}" /></label>
          <label class="small">até <input class="tw-end" type="time" value="${esc(s.windowEnd ?? '')}" /></label>
          ${stopWindow(s) ? '<button class="tw-clear">Limpar</button>' : ''}
        </div>
      </details>
    </li>`).join('') || '<li class="muted">Nenhuma parada. Importe um PDF ou cole endereços.</li>';
}

function windowLabel(s) {
  if (!stopWindow(s)) return null;
  if (s.windowStart && s.windowEnd) return `${s.windowStart}–${s.windowEnd}`;
  return s.windowStart ? `a partir das ${s.windowStart}` : `até ${s.windowEnd}`;
}

function windowChanged() {
  // Rota já otimizada continua valendo; o aviso pede para otimizar de novo.
  if (route.plan) route.plan.windowsChanged = true;
  persist();
  renderStops();
  setStatus('#stops-status', 'Horário alterado. Toque em "Otimizar rota" para levar em conta.', 'warn');
}

$('#stops-list').addEventListener('change', (e) => {
  const cls = e.target.classList;
  if (cls.contains('tw-start') || cls.contains('tw-end')) {
    const stop = findStop(e.target.closest('li').dataset.id);
    stop[cls.contains('tw-start') ? 'windowStart' : 'windowEnd'] = e.target.value || undefined;
    if (stop.windowStart && stop.windowEnd && stop.windowStart > stop.windowEnd) {
      setStatus('#stops-status', 'O início do horário está depois do fim — confira.', 'error');
    }
    return windowChanged();
  }
  if (!cls.contains('addr')) return;
  const stop = route.stops.find((s) => s.id === e.target.closest('li').dataset.id);
  stop.address = normalizeAddress(e.target.value);
  Object.assign(stop, { status: 'pending', lat: undefined, lng: undefined, label: undefined, precise: undefined, pinAdjusted: undefined });
  route.plan = null;
  persist();
  renderStops();
});
$('#stops-list').addEventListener('click', (e) => {
  if (e.target.classList.contains('tw-clear')) {
    const stop = findStop(e.target.closest('li').dataset.id);
    stop.windowStart = stop.windowEnd = undefined;
    return windowChanged();
  }
  if (!e.target.classList.contains('del')) return;
  const id = e.target.closest('li').dataset.id;
  if (findStop(id)?.hasPhoto) deletePhotos([id]).catch(() => {});
  route.stops = route.stops.filter((s) => s.id !== id);
  route.plan = null;
  persist();
  renderStops();
});
$('#btn-add-stop').addEventListener('click', () => {
  route.stops.push({ id: uid(), address: '', status: 'pending', outcome: null });
  persist();
  renderStops();
  $('#stops-list li:last-child .addr')?.focus();
});

$('#start-input').addEventListener('change', (e) => {
  const input = e.target.value.trim();
  route.start = input ? { input } : null;
  route.plan = null;
  persist();
  renderStops();
});

$('#btn-start-gps').addEventListener('click', () => {
  if (!navigator.geolocation) return setStatus('#stops-status', 'GPS indisponível neste navegador.', 'error');
  setStatus('#stops-status', 'Obtendo localização...');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      route.start = { input: 'Minha localização', lat: pos.coords.latitude, lng: pos.coords.longitude, label: 'Minha localização (GPS)' };
      route.plan = null;
      persist();
      renderStops();
      setStatus('#stops-status', 'Partida definida pelo GPS.', 'ok');
    },
    (err) => setStatus('#stops-status', `Não foi possível obter a localização: ${err.message}`, 'error'),
    { enableHighAccuracy: true, timeout: 15000 },
  );
});

let busy = false;
async function geocodeAll() {
  const opts = { key: settings.orsKey, defaultCity: settings.defaultCity };
  if (route.start?.input && route.start.lat == null) {
    try {
      const r = await geocode(route.start.input, opts);
      if (r) route.start = { ...route.start, ...r };
      else setStatus('#stops-status', 'Endereço de partida não encontrado.', 'error');
    } catch (err) {
      setStatus('#stops-status', `Erro na partida: ${err.message}`, 'error');
    }
  }
  const pending = route.stops.filter((s) => s.address && s.status !== 'ok');
  let done = 0;
  for (const s of pending) {
    setStatus('#stops-status', `Localizando ${++done}/${pending.length}...`);
    try {
      const r = await geocode(s.address, { ...opts, focus: route.start?.lat != null ? route.start : undefined });
      if (r) Object.assign(s, { lat: r.lat, lng: r.lng, label: r.label, status: 'ok', precise: r.precise, pinAdjusted: undefined });
      else s.status = 'notfound';
    } catch (err) {
      s.status = 'error';
      s.error = err.message;
    }
    persist();
    renderStops();
  }
  const bad = route.stops.filter((s) => s.status !== 'ok').length;
  setStatus('#stops-status', bad ? `${bad} endereço(s) precisam de correção (edite e localize de novo).` : 'Todos os endereços localizados.', bad ? 'error' : 'ok');
}

$('#btn-geocode').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try { await geocodeAll(); } finally { busy = false; }
});

$('#btn-optimize').addEventListener('click', async () => {
  if (busy) return;
  busy = true;
  try {
    if (route.stops.some((s) => s.status !== 'ok') || (route.start?.input && route.start.lat == null)) await geocodeAll();
    const located = route.stops.filter((s) => s.status === 'ok');
    if (located.length < 2) return setStatus('#stops-status', 'São necessárias ao menos 2 paradas localizadas.', 'error');
    const start = route.start?.lat != null ? route.start : located[0];
    setStatus('#stops-status', `Otimizando ${located.length} paradas...`);
    const startMin = nowMinutes();
    const plan = await planRoute(start, located, {
      key: settings.orsKey,
      windows: located.map(stopWindow),
      startMin,
      timing: timing(),
    });
    route.plan = {
      order: plan.order.map((i) => located[i].id),
      geometry: plan.geometry,
      distance: plan.distance,
      duration: plan.duration,
      method: plan.method,
      roadGeometry: plan.roadGeometry,
      warnings: plan.warnings,
      start: { lat: start.lat, lng: start.lng },
    };
    persist();
    const skipped = route.stops.length - located.length;
    setStatus('#stops-status', `Rota pronta${skipped ? ` (${skipped} parada(s) sem localização ficaram de fora)` : ''}.`, 'ok');
    showTab('route');
  } catch (err) {
    setStatus('#stops-status', `Erro ao otimizar: ${err.message}`, 'error');
  } finally {
    busy = false;
  }
});

// ---------- Rota e mapa ----------
let map;
let layer;
let fittedPlan = null;
let reorderMode = false;
let thumbUrls = [];

function ensureMap() {
  if (map) return;
  map = L.map('map', { zoomControl: true }).setView([-15.78, -47.93], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
}

const orderedStops = (r = route) => (r.plan?.order ?? []).map((id) => r.stops.find((s) => s.id === id)).filter(Boolean);
const findStop = (id) => route.stops.find((s) => s.id === id);
const fmtHour = (iso) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/**
 * Previsão ao vivo: das paradas pendentes, a partir de agora e do último ponto concluído
 * (ou da partida). Recalcula a cada atualização da tela, inclusive após reordenar.
 */
function liveSchedule(stops) {
  const done = stops.filter((s) => s.outcome).sort((a, b) => Date.parse(a.outcomeAt) - Date.parse(b.outcomeAt));
  const fix = route.tracking?.active && route.tracking.last;
  const from = isFresh(fix) ? fix : done.at(-1) ?? route.plan.start;
  const pending = stops.filter((s) => !s.outcome);
  if (!from || !pending.length) return { byId: {}, end: null, lateCount: 0 };
  const sim = simulate([from, ...pending], [null, ...pending.map(stopWindow)], nowMinutes(), timing());
  const byId = {};
  pending.forEach((s, i) => (byId[s.id] = sim.stops[i]));
  return { byId, end: sim.end, lateCount: sim.lateCount };
}

function etaLine(s, eta) {
  const win = windowLabel(s);
  if (!eta && !win) return '';
  const parts = [];
  if (eta) parts.push(`Previsão ~${fmtHHMM(eta.arrival)}`);
  if (win) parts.push(`⏰ ${esc(win)}`);
  let cls = 'muted';
  if (eta?.late > 0) {
    cls = 'fail-text';
    parts.push(`⚠ atraso de ~${Math.round(eta.late)} min`);
  } else if (eta?.wait >= 5) {
    parts.push(`espera ~${Math.round(eta.wait)} min`);
  }
  return `<div class="small ${cls}">${parts.join(' · ')}</div>`;
}

/** Endereço completo usado na navegação (acrescenta a cidade padrão quando falta). */
const navQuery = (s) => buildQuery(s.address, settings.defaultCity);

const APPROX_HINT = '≈ posição aproximada no mapa (número não encontrado). A navegação usa o endereço; se quiser, arraste o pino até a casa.';

function outcomeLine(s) {
  const arrived = s.arrivedAt ? `Chegou às ${fmtHour(s.arrivedAt)} · ` : '';
  const far = s.outcomeDistM > farFromStopM(s)
    ? `<div class="small warn">📍 Marcado a ${fmtDistance(s.outcomeDistM)} do endereço</div>` : '';
  if (s.outcome === 'delivered') return `<div class="muted small">${arrived}Entregue às ${fmtHour(s.outcomeAt)}</div>${far}`;
  if (s.outcome === 'failed') return `<div class="small fail-text">${arrived}Problema às ${fmtHour(s.outcomeAt)}</div>${far}`;
  return s.arrivedAt ? `<div class="small ok-text">📍 Chegou às ${fmtHour(s.arrivedAt)}</div>` : '';
}

function stopItem(s, i, next, openIds, eta) {
  const pending = !s.outcome;
  if (reorderMode) {
    return `<li data-id="${esc(s.id)}" class="rstop ${esc(s.outcome ?? '')} ${s === next ? 'next' : ''}">
      <div class="num">${i + 1}</div>
      <div class="body">
        <div class="addr">${esc(s.address)}</div>
        ${pending ? `<div class="actions">
          <button class="mv-up" aria-label="Subir">▲</button>
          <button class="mv-down" aria-label="Descer">▼</button>
          ${s === next ? '' : '<button class="mv-next">Fazer a seguir</button>'}
        </div>${etaLine(s, eta)}` : outcomeLine(s)}
      </div>
    </li>`;
  }
  const extras = [s.note ? '📝' : '', s.hasPhoto ? '📷' : ''].join('');
  return `<li data-id="${esc(s.id)}" class="rstop ${esc(s.outcome ?? '')} ${s === next ? 'next' : ''}">
    <div class="num">${i + 1}</div>
    <div class="body">
      <div class="addr">${esc(s.address)}</div>
      ${!s.outcome && s.precise === false ? `<div class="small muted">${esc(APPROX_HINT)}</div>` : ''}
      ${s.outcome ? outcomeLine(s) : outcomeLine(s) + etaLine(s, eta)}
      <div class="actions">
        <a class="btn" href="${esc(googleMapsUrl(s, navQuery(s)))}" target="_blank" rel="noopener">Google Maps</a>
        <a class="btn" href="${esc(wazeUrl(s, navQuery(s)))}" target="_blank" rel="noopener">Waze</a>
        ${pending
          ? '<button class="set-delivered primary">✓ Entregue</button><button class="set-failed danger">✗ Problema</button>'
          : '<button class="undo">Desfazer</button>'}
      </div>
      ${s.outcome === 'failed' ? `<label class="small">Motivo
        <select class="reason">${FAIL_REASONS.map((r) => `<option ${r === s.failReason ? 'selected' : ''}>${esc(r)}</option>`).join('')}</select>
      </label>` : ''}
      <details class="extra" ${openIds.has(s.id) ? 'open' : ''}>
        <summary>Observação e foto ${extras}</summary>
        <textarea class="note" rows="2" placeholder="Ex.: deixado com o porteiro">${esc(s.note ?? '')}</textarea>
        <div class="actions">
          <label class="btn">📷 ${s.hasPhoto ? 'Trocar foto' : 'Tirar foto'}
            <input class="photo-input" type="file" accept="image/*" capture="environment" hidden />
          </label>
          ${s.hasPhoto ? '<button class="photo-del">Remover foto</button>' : ''}
        </div>
        ${s.hasPhoto ? `<img class="thumb" data-photo="${esc(s.id)}" alt="Foto do comprovante" />` : ''}
      </details>
    </div>
  </li>`;
}

function renderRoute() {
  ensureMap();
  setTimeout(() => map.invalidateSize(), 0);
  layer.clearLayers();
  const stops = orderedStops();
  if (!route.plan || !stops.length) {
    $('#route-summary').innerHTML = 'Nenhuma rota otimizada ainda. Vá em <b>Paradas</b> e toque em <b>Otimizar rota</b>.';
    $('#route-list').innerHTML = '';
    return;
  }
  const st = routeStats(stops);
  const sched = liveSchedule(stops);
  const pendingStops = stops.filter((s) => !s.outcome);
  const next = pendingStops[0];
  const p = route.plan;
  const multi = googleMapsMultiUrl(pendingStops, navQuery);
  $('#route-summary').innerHTML = `
    <div><b>${st.delivered}/${st.total}</b> entregues${st.failed ? ` · <span class="fail-text">${st.failed} com problema</span>` : ''} · ${fmtKm(p.distance)} · ${fmtDur(p.duration)}</div>
    <div class="progress"><span style="width:${(st.delivered / st.total) * 100}%"></span><span class="failed" style="width:${(st.failed / st.total) * 100}%"></span></div>
    ${sched.end != null ? `<div>Término previsto ~<b>${fmtHHMM(sched.end)}</b>${sched.lateCount ? ` · <span class="fail-text">⚠ ${sched.lateCount} parada(s) com atraso previsto</span>` : ''}</div>` : ''}
    <div id="gps-status" class="small"></div>
    ${p.windowsChanged ? '<div class="warn">Horários mudaram depois da otimização: em Paradas, toque em "Otimizar rota" de novo.</div>' : ''}
    <div class="muted">Otimização: ${p.method === 'ors' ? 'OpenRouteService' : 'local (linha reta)'}${p.manual ? ' · ordem ajustada manualmente' : ''}${p.roadGeometry ? '' : ' · traçado aproximado'}</div>
    ${(p.warnings ?? []).map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
    <div class="actions">
      ${reorderMode ? '' : route.tracking?.active
        ? '<button id="btn-gps-stop">⏸ Pausar GPS</button><button id="btn-gps-center">📍 Onde estou</button>'
        : '<button id="btn-gps-start" class="accent">▶ Iniciar rota (GPS)</button>'}
      ${multi && !reorderMode ? `<a class="btn primary" href="${esc(multi)}" target="_blank" rel="noopener">Google Maps: próximas ${Math.min(pendingStops.length, MOBILE_MAX_WAYPOINTS + 1)}</a>` : ''}
      <button id="btn-reorder" class="${reorderMode ? 'accent' : ''}">${reorderMode ? 'Concluir reordenação' : '↕ Reordenar'}</button>
      ${!p.roadGeometry && settings.orsKey && !reorderMode ? '<button id="btn-redraw">Recalcular traçado</button>' : ''}
      ${reorderMode ? '' : '<button id="btn-export-csv">Exportar CSV</button><button id="btn-report">Relatório PDF</button>'}
    </div>`;

  const openIds = new Set([...document.querySelectorAll('#route-list details[open]')].map((d) => d.closest('li').dataset.id));
  $('#route-list').innerHTML = stops.map((s, i) => stopItem(s, i, next, openIds, sched.byId[s.id])).join('');
  loadThumbs();

  if (p.start) L.circleMarker([p.start.lat, p.start.lng], { radius: 8, color: '#1d4ed8', fillOpacity: 0.9 }).bindTooltip('Partida').addTo(layer);
  setTimeout(updateGpsView, 0);
  L.polyline(p.geometry, { color: '#0f766e', weight: 4, opacity: 0.8, dashArray: p.roadGeometry ? null : '6 6' }).addTo(layer);
  stops.forEach((s, i) => {
    const icon = L.divIcon({ className: `pin ${s.outcome === 'delivered' ? 'done' : s.outcome === 'failed' ? 'failed' : ''} ${s === next ? 'next' : ''}`, html: `<span>${i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    const m = L.marker([s.lat, s.lng], { icon, draggable: true }).addTo(layer);
    m.bindPopup(`<b>${i + 1}.</b> ${esc(s.address)}<br><small>${s.precise === false ? '≈ Posição aproximada (só a rua). ' : ''}Arraste o pino para corrigir a posição.</small>`);
    m.on('dragend', () => {
      const { lat, lng } = m.getLatLng();
      // Posição confirmada à mão: navegação passa a usar estas coordenadas.
      Object.assign(s, { lat, lng, label: 'Ajustado manualmente', pinAdjusted: true, precise: true });
      persist();
    });
  });
  if (fittedPlan !== p) {
    // Enquadra só quando a rota muda, para não perder o zoom ao marcar entregas.
    fittedPlan = p;
    const bounds = L.latLngBounds(stops.map((s) => [s.lat, s.lng]));
    if (p.start) bounds.extend([p.start.lat, p.start.lng]);
    setTimeout(() => map.fitBounds(bounds, { padding: [30, 30] }), 0);
  }
}

async function loadThumbs() {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  for (const img of document.querySelectorAll('#route-list img[data-photo]')) {
    try {
      const blob = await getPhotoAny(img.dataset.photo, route.ownerId);
      if (!blob) continue;
      const url = URL.createObjectURL(blob);
      thumbUrls.push(url);
      img.src = url;
    } catch { /* foto indisponível */ }
  }
}

/** Depois de mudar a ordem manualmente, o traçado vira linhas retas até ser recalculado. */
function applyManualOrder(order) {
  const p = route.plan;
  p.order = order;
  const pts = [p.start, ...orderedStops()].filter(Boolean);
  p.geometry = pts.map((x) => [x.lat, x.lng]);
  p.distance = pts.slice(1).reduce((d, x, i) => d + haversine(pts[i], x), 0);
  p.duration = null;
  p.roadGeometry = false;
  p.manual = true;
  persist();
  renderRoute();
}

$('#route-summary').addEventListener('click', async (e) => {
  const id = e.target.id;
  if (id === 'btn-gps-start') {
    startGps();
  } else if (id === 'btn-gps-stop') {
    stopGps();
  } else if (id === 'btn-gps-center') {
    const fix = route.tracking?.last;
    if (isFresh(fix)) map.setView([fix.lat, fix.lng], 16);
    else toast('Ainda sem posição do GPS.');
  } else if (id === 'btn-reorder') {
    reorderMode = !reorderMode;
    renderRoute();
  } else if (id === 'btn-export-csv') {
    exportCsv(route);
  } else if (id === 'btn-report') {
    exportPdf(route, e.target);
  } else if (id === 'btn-redraw') {
    e.target.disabled = true;
    e.target.textContent = 'Calculando...';
    try {
      const p = route.plan;
      const d = await orsDirections([p.start, ...orderedStops()].filter(Boolean), { key: settings.orsKey });
      Object.assign(p, { geometry: d.coords, distance: d.distance, duration: d.duration, roadGeometry: true });
      persist();
    } catch (err) {
      alert(`Não foi possível recalcular: ${err.message}`);
    }
    renderRoute();
  }
});

$('#route-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const s = findStop(li.dataset.id);
  const cls = e.target.classList;
  const order = route.plan.order;
  if (cls.contains('set-delivered') || cls.contains('set-failed')) {
    s.outcome = cls.contains('set-delivered') ? 'delivered' : 'failed';
    s.outcomeAt = new Date().toISOString();
    if (s.outcome === 'failed') s.failReason ??= FAIL_REASONS[0];
    const fix = route.tracking?.active && route.tracking.lastSeen;
    if (isFresh(fix)) {
      s.outcomeFix = { lat: fix.lat, lng: fix.lng, acc: fix.acc };
      s.outcomeDistM = Math.round(distanceTo(fix, s));
      if (!s.arrivedAt && isArrived(fix, s)) s.arrivedAt = s.outcomeAt;
    }
    persist();
    renderRoute();
  } else if (cls.contains('undo')) {
    s.outcome = null;
    s.outcomeAt = s.outcomeFix = s.outcomeDistM = undefined;
    persist();
    renderRoute();
  } else if (cls.contains('mv-up') || cls.contains('mv-down')) {
    applyManualOrder(moveBy(order, s.id, cls.contains('mv-up') ? -1 : 1));
  } else if (cls.contains('mv-next')) {
    const firstPending = order.findIndex((id) => !findStop(id)?.outcome);
    applyManualOrder(moveTo(order, s.id, firstPending));
  } else if (cls.contains('photo-del')) {
    if (!confirm('Remover a foto desta parada?')) return;
    await deletePhotos([s.id]);
    s.hasPhoto = false;
    persist();
    renderRoute();
  } else if (!e.target.closest('a,button,details,select,label')) {
    map.setView([s.lat, s.lng], 16);
  }
});

$('#route-list').addEventListener('change', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const s = findStop(li.dataset.id);
  const cls = e.target.classList;
  if (cls.contains('reason')) {
    s.failReason = e.target.value;
    persist();
  } else if (cls.contains('note')) {
    s.note = e.target.value.trim();
    persist();
    li.querySelector('summary').textContent = `Observação e foto ${[s.note ? '📝' : '', s.hasPhoto ? '📷' : ''].join('')}`;
  } else if (cls.contains('photo-input')) {
    const file = e.target.files[0];
    if (!file) return;
    try {
      await putPhoto(s.id, await compressImage(file));
      requestPersistence();
      s.hasPhoto = true;
      s.photoSynced = false;
      persist(3000);
    } catch (err) {
      alert(`Não foi possível salvar a foto: ${err.message}`);
    }
    renderRoute();
  }
});

// ---------- GPS ----------
let watchId = null;
let wakeLock = null;
let gpsMarker = null;
let gpsCircle = null;
let gpsError = '';
let lastSave = 0;
let lastRender = 0;

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (el.hidden = true), 5000);
}

async function keepScreenOn() {
  try {
    if (navigator.wakeLock && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    }
  } catch { /* não suportado ou recusado */ }
}

function startGps({ resume = false } = {}) {
  if (!navigator.geolocation) {
    gpsError = 'GPS indisponível neste navegador.';
    return renderRoute();
  }
  route.tracking = { ...newTracking(), ...route.tracking, active: true };
  route.tracking.startedAt ??= new Date().toISOString();
  persist();
  if (watchId == null) {
    watchId = navigator.geolocation.watchPosition(onFix, onGpsError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  }
  keepScreenOn();
  if (!resume) renderRoute();
}

function stopGps({ silent = false } = {}) {
  if (watchId != null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
  if (route.tracking) route.tracking.active = false;
  persist();
  if (!silent) renderRoute();
}

function onGpsError(err) {
  gpsError = err.code === 1
    ? 'Localização bloqueada. No iPhone/iPad: Ajustes › Privacidade › Serviços de Localização › Safari (ou Sites do Safari) › "Ao Usar o App". Depois toque em Iniciar de novo.'
    : `Sem sinal de GPS (${err.message}). Continuando a tentar...`;
  if (err.code === 1) stopGps({ silent: true });
  if (!$('#view-route').hidden) renderRoute();
}

function onFix(pos) {
  if (!route.tracking?.active) return stopGps({ silent: true }); // rota trocada/finalizada
  const fix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: Math.round(pos.coords.accuracy), t: pos.timestamp || Date.now() };
  gpsError = '';
  route.tracking = ingestFix(route.tracking ?? newTracking(), fix);
  // Chegada: qualquer parada pendente dentro do raio (o entregador pode mudar a ordem).
  const arrivedNow = [];
  for (const s of orderedStops()) {
    if (!s.outcome && !s.arrivedAt && isArrived(fix, s)) {
      s.arrivedAt = new Date(fix.t).toISOString();
      arrivedNow.push(s);
    }
  }
  const now = Date.now();
  if (arrivedNow.length) {
    persist(3000); // chegada é uma alteração real: sobe logo
    lastSave = now;
  } else if (now - lastSave > 15000) {
    saveLocal(); // leituras do GPS só ficam no aparelho até a próxima alteração
    lastSave = now;
  }
  if (arrivedNow.length) {
    const pos = route.plan.order.indexOf(arrivedNow[0].id) + 1;
    toast(`📍 Chegou na parada ${pos}: ${arrivedNow[0].address}`);
  }
  if ($('#view-route').hidden) return;
  // A lista (previsões) é redesenhada no máximo a cada 30 s; o ponto no mapa, a cada leitura.
  if (arrivedNow.length || now - lastRender > 30000) {
    lastRender = now;
    renderRoute();
  } else {
    updateGpsView();
  }
}

function updateGpsView() {
  const t = route.tracking;
  const el = $('#gps-status');
  if (el) {
    const tm = timing();
    const parts = [];
    if (t?.active) {
      const seen = t.lastSeen;
      parts.push(seen ? `📍 GPS ativo · precisão ${seen.acc} m${seen.acc > 60 ? ' (sinal fraco)' : ''}` : '📍 GPS ativo · aguardando sinal...');
    }
    if (t?.meters > 0) parts.push(`${fmtDistance(t.meters)} rodados`);
    if (tm.observedSpeed) parts.push(`velocidade real ${Math.round(tm.observedSpeed)} km/h`);
    if (tm.observedService) parts.push(`~${Math.round(tm.observedService)} min por parada`);
    el.innerHTML = [parts.join(' · '), gpsError && `<span class="fail-text">${esc(gpsError)}</span>`].filter(Boolean).join('<br>');
  }
  if (!map) return;
  const fix = route.tracking?.active && route.tracking.last;
  if (!isFresh(fix)) {
    gpsMarker?.remove();
    gpsCircle?.remove();
    gpsMarker = gpsCircle = null;
    return;
  }
  const ll = [fix.lat, fix.lng];
  if (!gpsMarker) {
    gpsCircle = L.circle(ll, { radius: fix.acc, color: '#1d4ed8', weight: 1, fillOpacity: 0.12 }).addTo(map);
    gpsMarker = L.circleMarker(ll, { radius: 8, color: '#fff', weight: 3, fillColor: '#1d4ed8', fillOpacity: 1 }).bindTooltip('Você').addTo(map);
  } else {
    gpsMarker.setLatLng(ll);
    gpsCircle.setLatLng(ll).setRadius(fix.acc);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && route.tracking?.active) keepScreenOn();
});

// ---------- Exportação ----------
/** No tablet/celular abre o menu de compartilhar (Arquivos, WhatsApp, e-mail...); senão baixa o arquivo. */
async function shareOrDownload(file) {
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: file.name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function exportCsv(r) {
  return shareOrDownload(new File([toCsv(r, orderedStops(r))], routeFileName(r, 'csv'), { type: 'text/csv' }));
}

async function exportPdf(r, button) {
  const label = button?.textContent;
  if (button) {
    button.disabled = true;
    button.textContent = 'Gerando PDF...';
  }
  try {
    const stops = orderedStops(r);
    const photos = {};
    for (const s of stops.filter((x) => x.hasPhoto)) {
      const blob = await getPhotoAny(s.id, r.ownerId).catch(() => null);
      if (blob) photos[s.id] = await blobToDataUrl(blob);
    }
    const { buildReportPdf } = await import('./lib/reportPdf.js');
    await shareOrDownload(new File([buildReportPdf(r, stops, photos)], routeFileName(r, 'pdf'), { type: 'application/pdf' }));
  } catch (err) {
    alert(`Não foi possível gerar o PDF: ${err.message}`);
  } finally {
    if (button?.isConnected) {
      button.disabled = false;
      button.textContent = label;
    }
  }
}

function archive(r) {
  // Não guardamos o traçado completo no histórico para economizar espaço.
  const copy = structuredClone(r);
  if (copy.plan) copy.plan.geometry = [];
  copy.updatedAt = new Date().toISOString();
  history = [copy, ...history.filter((h) => h.id !== r.id)].slice(0, HISTORY_MAX);
  saveHistory();
}

$('#btn-finish').addEventListener('click', () => {
  if (!route.plan) return;
  if (!confirm('Finalizar a rota e salvá-la no histórico?')) return;
  route.finishedAt = new Date().toISOString();
  stopGps({ silent: true });
  archive(route);
  route = newRoute();
  reorderMode = false;
  persist();
  showTab('history');
});

// ---------- Histórico ----------
const BACKUP_REMIND_DAYS = 7;
let summaryPeriod = load('summaryPeriod', 'week');
let summaryDay = null;

const fmtNum = (n, digits = 1) => n.toLocaleString('pt-BR', { maximumFractionDigits: digits });
const fmtWork = (min) => (min >= 60 ? `${Math.floor(min / 60)}h${String(Math.round(min % 60)).padStart(2, '0')}` : `${Math.round(min)} min`);
const fmtDay = (key, opts) => new Date(`${key}T12:00:00`).toLocaleDateString('pt-BR', opts);

function renderSummary() {
  document.querySelectorAll('#summary [data-period]').forEach((b) => {
    b.classList.toggle('active', b.dataset.period === summaryPeriod);
    b.setAttribute('aria-pressed', b.dataset.period === summaryPeriod);
  });
  // Rota em andamento também conta (entregas de hoje ainda não finalizadas).
  const all = [route, ...history.filter((h) => h.id !== route.id)];
  const s = summarize(all, summaryPeriod);
  const tiles = [
    ['Entregas', s.delivered],
    ['Sucesso', s.successRate == null ? '—' : `${Math.round(s.successRate * 100)}%`],
    ['Problemas', s.failed],
    ['Distância', `${fmtNum(s.km)} km`],
    ['Tempo na rua', s.workMinutes ? fmtWork(s.workMinutes) : '—'],
    ...(summaryPeriod === 'today' ? [] : [['Média por dia trabalhado', s.perActiveDay == null ? '—' : fmtNum(s.perActiveDay)]]),
  ];
  let chart = '';
  if (summaryPeriod !== 'today') {
    const max = Math.max(1, ...s.days.map((d) => d.delivered));
    const week = summaryPeriod === 'week';
    const sel = s.days.find((d) => d.date === summaryDay);
    chart = `
      <h3 class="chart-title">Entregas por dia</h3>
      <div class="bars ${week ? 'week' : 'month'}">
        ${s.days.map((d, i) => {
          const label = week ? fmtDay(d.date, { weekday: 'short' }).replace('.', '') : (i % 5 === 4 || i === s.days.length - 1 ? fmtDay(d.date, { day: 'numeric' }) : '');
          return `<button class="bar ${d.date === summaryDay ? 'sel' : ''}" data-day="${d.date}"
            aria-label="${fmtDay(d.date, { day: '2-digit', month: '2-digit' })}: ${d.delivered} entregas, ${d.failed} problemas">
            <span class="col"><span class="fill" style="height:${(d.delivered / max) * 100}%"></span></span>
            <span class="lbl">${label}</span>
          </button>`;
        }).join('')}
      </div>
      <p class="small muted bar-detail">${sel
        ? `<b>${fmtDay(sel.date, { weekday: 'long', day: '2-digit', month: '2-digit' })}</b>: ${sel.delivered} entregues · ${sel.failed} com problema · ${fmtNum(sel.km)} km`
        : 'Toque em uma barra para ver o dia.'}</p>`;
  }
  const reasons = s.reasons.length
    ? `<h3 class="chart-title">Problemas por motivo</h3>
       <ul class="reasons">${s.reasons.map(([r, n]) => `<li><span>${esc(r)}</span><b>${n}</b></li>`).join('')}</ul>`
    : '';
  $('#summary-body').innerHTML = s.delivered + s.failed + s.km === 0
    ? '<p class="muted small">Nenhuma entrega registrada neste período.</p>'
    : `<div class="tiles">${tiles.map(([k, v]) => `<div class="tile"><span class="v">${v}</span><span class="k">${k}</span></div>`).join('')}</div>${chart}${reasons}`;
}

$('#summary').addEventListener('click', (e) => {
  const p = e.target.closest('[data-period]');
  const bar = e.target.closest('[data-day]');
  if (p) {
    summaryPeriod = p.dataset.period;
    summaryDay = null;
    save('summaryPeriod', summaryPeriod);
  } else if (bar) {
    summaryDay = bar.dataset.day === summaryDay ? null : bar.dataset.day;
  } else return;
  renderSummary();
});

function renderHistory() {
  renderSummary();
  const last = settings.lastBackupAt ? Date.parse(settings.lastBackupAt) : 0;
  const overdue = history.length > 0 && Date.now() - last > BACKUP_REMIND_DAYS * 864e5;
  $('#backup-reminder').hidden = !overdue;
  if (overdue) {
    $('#backup-reminder-text').textContent = last
      ? `Último backup em ${new Date(last).toLocaleDateString('pt-BR')}. Faça um novo para não perder rotas e fotos.`
      : 'Você ainda não fez backup. Se o navegador apagar os dados, o histórico e as fotos se perdem.';
  }
  $('#history-list').innerHTML = history.map((h) => {
    const st = routeStats(h.plan ? orderedStops(h) : h.stops);
    return `<li data-id="${esc(h.id)}" class="card">
      <div><b>${esc(h.name)}</b></div>
      <div class="muted small">${st.delivered}/${st.total} entregues${st.failed ? ` · ${st.failed} com problema` : ''} · ${h.plan ? fmtKm(h.plan.distance) : '—'} · finalizada ${h.finishedAt ? new Date(h.finishedAt).toLocaleString('pt-BR') : '—'}</div>
      <div class="row">
        <button class="csv">Exportar CSV</button>
        <button class="report">Relatório PDF</button>
        <button class="reuse">Reusar endereços</button>
        <button class="del danger">Excluir</button>
      </div>
    </li>`;
  }).join('') || '<li class="muted">Nenhuma rota finalizada ainda.</li>';
}

$('#history-list').addEventListener('click', async (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const h = history.find((x) => x.id === li.dataset.id);
  const cls = e.target.classList;
  if (cls.contains('csv')) {
    exportCsv(h);
  } else if (cls.contains('report')) {
    exportPdf(h, e.target);
  } else if (cls.contains('del')) {
    if (!confirm('Excluir esta rota do histórico (inclusive as fotos)?')) return;
    history = history.filter((x) => x.id !== h.id);
    queueCloudDelete(h);
    saveHistory();
    await deletePhotos(h.stops.filter((s) => s.hasPhoto).map((s) => s.id)).catch(() => {});
    renderHistory();
  } else if (cls.contains('reuse')) {
    if (route.stops.length && !confirm('Substituir as paradas da rota atual?')) return;
    await discardCurrentPhotos();
    stopGps({ silent: true });
    route = newRoute();
    route.start = h.start;
    route.stops = h.stops.map(({ id, outcome, outcomeAt, failReason, note, hasPhoto, arrivedAt, outcomeFix, outcomeDistM, ...rest }) => ({ ...rest, id: uid(), outcome: null }));
    persist();
    showTab('stops');
  }
});

/** Apaga as fotos da rota atual (usado quando ela é descartada sem ir para o histórico). */
function discardCurrentPhotos() {
  return deletePhotos(route.stops.filter((s) => s.hasPhoto).map((s) => s.id)).catch(() => {});
}

// ---------- Ajustes ----------
$('#btn-save-settings').addEventListener('click', () => {
  settings.orsKey = $('#ors-key').value.trim();
  settings.defaultCity = $('#default-city').value.trim();
  const num = (sel, min, max) => {
    const v = $(sel).value.trim();
    return v === '' ? undefined : Math.min(max, Math.max(min, Number(v)));
  };
  settings.speedKmh = num('#speed-kmh', 5, 120);
  settings.serviceMin = num('#service-min', 0, 60);
  save('settings', settings);
  setStatus('#settings-status', 'Ajustes salvos neste aparelho.', 'ok');
});
$('#btn-clear-cache').addEventListener('click', () => {
  remove('geocache');
  setStatus('#settings-status', 'Cache de endereços limpo.', 'ok');
});
// ---------- Backup ----------
function renderBackupInfo() {
  $('#backup-info').textContent = settings.lastBackupAt
    ? `Último backup: ${new Date(settings.lastBackupAt).toLocaleString('pt-BR')}`
    : 'Nenhum backup feito ainda.';
}

async function makeBackup(button) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Preparando...';
  try {
    const photos = {};
    for (const id of photoIds(route, history)) {
      const blob = await getPhotoAny(id).catch(() => null);
      if (blob) photos[id] = await blobToDataUrl(blob);
    }
    const data = buildBackup({ settings, current: route, history, photos });
    const file = new File([JSON.stringify(data)], backupFileName(), { type: 'application/json' });
    await shareOrDownload(file);
    settings.lastBackupAt = data.exportedAt;
    save('settings', settings);
    renderBackupInfo();
    if (!$('#view-history').hidden) renderHistory();
    setStatus('#backup-status', `Backup gerado (${history.length} rota(s), ${Object.keys(photos).length} foto(s), ${(file.size / 1024).toFixed(0)} KB). Guarde o arquivo em Arquivos/Drive.`, 'ok');
  } catch (err) {
    setStatus('#backup-status', `Erro ao gerar backup: ${err.message}`, 'error');
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

$('#btn-backup').addEventListener('click', (e) => makeBackup(e.target));
$('#btn-backup-reminder').addEventListener('click', (e) => makeBackup(e.target));

$('#restore-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const b = parseBackup(await file.text());
    const { history: merged, added } = mergeHistory(history, b.history, HISTORY_MAX);
    const when = b.exportedAt ? ` de ${new Date(b.exportedAt).toLocaleString('pt-BR')}` : '';
    const hasCurrent = b.current?.stops.length > 0 && b.current.id !== route.id;
    if (!confirm(`Restaurar backup${when}?\n\n• ${added} rota(s) nova(s) no histórico\n• ${b.history.length - added} já existiam (mantidas)${hasCurrent ? `\n• rota em andamento com ${b.current.stops.length} parada(s)` : ''}`)) return;

    let replaceCurrent = false;
    if (hasCurrent) {
      replaceCurrent = !route.stops.length || confirm('Substituir a rota atual deste aparelho pela rota em andamento do backup?');
    }
    // Fotos só das rotas que realmente entram no aparelho.
    const keptIds = new Set(photoIds(replaceCurrent ? b.current : null, merged));
    let restoredPhotos = 0;
    for (const [id, url] of Object.entries(b.photos)) {
      if (!keptIds.has(id)) continue;
      await putPhoto(id, dataUrlToBlob(url));
      restoredPhotos++;
    }
    if (restoredPhotos) requestPersistence();
    history = merged;
    save('history', history);
    if (replaceCurrent) {
      await discardCurrentPhotos();
      stopGps({ silent: true });
      route = b.current;
      fittedPlan = null;
      persist();
    }
    if (!settings.defaultCity && b.settings.defaultCity) {
      settings.defaultCity = b.settings.defaultCity;
      save('settings', settings);
      $('#default-city').value = settings.defaultCity;
    }
    setStatus('#backup-status', `Backup restaurado: ${added} rota(s) adicionada(s), ${restoredPhotos} foto(s)${replaceCurrent ? ', rota atual substituída' : ''}.`, 'ok');
  } catch (err) {
    setStatus('#backup-status', err.message, 'error');
  }
});

$('#btn-new-route').addEventListener('click', async () => {
  if (route.stops.length && !confirm('Descartar a rota atual (não finalizada)?')) return;
  queueCloudDelete(route);
  await discardCurrentPhotos();
  stopGps({ silent: true });
  route = newRoute();
  reorderMode = false;
  persist();
  $('#raw-text').value = '';
  showTab('import');
});

// ---------- Conta, sincronização e equipe (somente com nuvem configurada) ----------
let account = null; // { userId, email, profile }
let syncMeta = load('syncMeta', newSyncMeta());
let syncTimer = null;
let syncing = null;
let lastSyncAt = null;
let syncError = '';

/** Foto do aparelho; se não estiver aqui, busca na nuvem (outro aparelho/administrador) e guarda. */
async function getPhotoAny(stopId, ownerId = account?.userId) {
  const local = await getPhoto(stopId).catch(() => null);
  if (local || !account || !ownerId) return local;
  try {
    const blob = await cloud.downloadPhoto(photoPath(ownerId, stopId));
    if (blob) await putPhoto(stopId, blob).catch(() => {});
    return blob;
  } catch {
    return null;
  }
}

function queueCloudDelete(r) {
  if (!account || !(r.id in syncMeta.synced)) return;
  syncMeta.deleted.push({ id: r.id, photoIds: r.stops.filter((s) => s.hasPhoto).map((s) => s.id) });
  save('syncMeta', syncMeta);
}

function scheduleSync(ms = 15000) {
  if (!account) return;
  renderSyncBadge();
  const at = Date.now() + ms;
  if (syncTimer && syncTimer.at <= at) return;
  clearTimeout(syncTimer?.id);
  syncTimer = { at, id: setTimeout(() => { syncTimer = null; syncNow(); }, ms) };
}

async function syncNow() {
  if (!account) return;
  if (syncing) return syncing;
  syncing = (async () => {
    renderSyncBadge(true);
    try {
      const res = await syncOnce({
        adapter: cloud,
        userId: account.userId,
        state: { current: route, history },
        meta: syncMeta,
        getPhoto: (id) => getPhoto(id).catch(() => null),
        historyMax: HISTORY_MAX,
      });
      syncMeta = res.meta;
      save('syncMeta', syncMeta);
      const changed = res.pulled || res.removed || res.photosUp;
      history = res.state.history;
      save('history', history);
      if (res.state.current !== route) {
        route = res.state.current;
        route.stops.forEach(migrateStop);
        fittedPlan = null;
      }
      if (route.finishedAt) {
        // Rota finalizada em outro aparelho: aqui começa uma nova.
        stopGps({ silent: true });
        route = newRoute();
      }
      saveLocal();
      lastSyncAt = new Date();
      syncError = '';
      if (changed) refreshVisibleTab();
      if (res.adoptedCurrent) toast('Rota em andamento recuperada da sua conta.');
    } catch (err) {
      syncError = navigator.onLine ? err.message : 'sem internet';
    } finally {
      syncing = null;
      renderSyncBadge();
      if (!$('#view-settings').hidden) renderAccount();
    }
  })();
  return syncing;
}

function refreshVisibleTab() {
  const visible = document.querySelector('.view:not([hidden])')?.dataset.view;
  // Não redesenha a aba de Paradas para não atrapalhar quem está digitando.
  if (visible && visible !== 'stops' && visible !== 'import') showTab(visible);
}

function renderSyncBadge(inProgress = false) {
  const el = $('#sync-badge');
  if (!account) {
    el.hidden = true;
    return;
  }
  const pending = pendingCount({ current: route, history }, syncMeta);
  el.hidden = false;
  el.textContent = inProgress ? '☁️ ⟳' : syncError ? `☁️ ${pending || '!'}` : pending ? `☁️ ${pending}` : '☁️ ✓';
  el.title = inProgress ? 'Sincronizando...' : syncError ? `Sem sincronizar (${syncError})` : pending ? `${pending} alteração(ões) a enviar` : 'Tudo sincronizado';
  el.classList.toggle('warn', Boolean(syncError));
}

function renderAccount() {
  const card = $('#account-card');
  card.hidden = !account;
  if (!account) return;
  const role = account.profile.role === 'admin' ? 'Administrador' : 'Entregador';
  $('#account-info').innerHTML = `Conectado como <b>${esc(account.email)}</b> · ${role}`;
  const pending = pendingCount({ current: route, history }, syncMeta);
  $('#sync-info').textContent = [
    lastSyncAt ? `Última sincronização: ${lastSyncAt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}` : 'Ainda não sincronizado',
    pending ? `${pending} alteração(ões) aguardando envio` : 'tudo enviado',
    syncError && `erro: ${syncError}`,
  ].filter(Boolean).join(' · ');
}

// ---- Tela de login ----
function showAuth(step, msg = '', kind = '') {
  $('#auth').hidden = false;
  document.body.classList.add('locked');
  for (const id of ['email', 'code', 'denied']) $(`#auth-step-${id}`).hidden = id !== step;
  setStatus('#auth-status', msg, kind);
  if (step === 'email') setTimeout(() => $('#auth-email').focus(), 50);
  if (step === 'code') setTimeout(() => $('#auth-code').focus(), 50);
}

function hideAuth() {
  $('#auth').hidden = true;
  document.body.classList.remove('locked');
}

$('#auth-form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#auth-email').value.trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) return setStatus('#auth-status', 'Digite um e-mail válido.', 'error');
  const btn = $('#btn-send-code');
  btn.disabled = true;
  setStatus('#auth-status', 'Enviando código...');
  // Mesma resposta para e-mail liberado ou não: não revela quem tem acesso (enumeração de contas).
  const generic = () => {
    $('#auth-email-shown').textContent = email;
    showAuth('code', 'Se este e-mail tiver acesso, você receberá um código em instantes. Confira também a caixa de spam.', 'ok');
  };
  try {
    await cloud.sendCode(email);
    generic();
  } catch (err) {
    if (/rate|seconds|security purposes/i.test(err.message)) setStatus('#auth-status', 'Aguarde um minuto antes de pedir outro código.', 'error');
    else if (/database error|not allowed|signups/i.test(err.message)) generic(); // e-mail não liberado
    else setStatus('#auth-status', 'Não foi possível enviar o código. Verifique a internet e tente de novo.', 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#auth-form-code').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('#auth-code').value.replace(/\D/g, '');
  if (code.length < 6) return setStatus('#auth-status', 'Digite o código de 6 dígitos do e-mail.', 'error');
  const btn = $('#btn-verify');
  btn.disabled = true;
  setStatus('#auth-status', 'Verificando...');
  try {
    const session = await cloud.verifyCode($('#auth-email-shown').textContent, code);
    await enterAccount(session);
  } catch (err) {
    setStatus('#auth-status', /expired|invalid/i.test(err.message) ? 'Código inválido ou expirado. Peça um novo.' : `Não foi possível entrar: ${err.message}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('#btn-auth-back').addEventListener('click', () => {
  $('#auth-code').value = '';
  showAuth('email');
});
$('#btn-denied-retry').addEventListener('click', async () => {
  const session = await cloud.session().catch(() => null);
  if (session) await enterAccount(session);
  else showAuth('email');
});
$('#btn-denied-logout').addEventListener('click', () => logout({ force: true }));

/** Depois do login: confere o acesso, separa os dados do aparelho por pessoa e sincroniza. */
async function enterAccount(session) {
  const userId = session.user.id;
  const email = session.user.email;
  let profile;
  try {
    profile = await cloud.claimAccess();
    if (profile) save('profile', profile);
  } catch {
    const cached = load('profile', null); // sem internet: usa o último acesso conhecido
    profile = cached?.id === userId ? cached : null;
    if (!profile) return showAuth('denied', 'Sem internet para confirmar seu acesso. Conecte-se e toque em "Tentar de novo".', 'error');
  }
  if (!profile) {
    $('#auth-denied-email').textContent = email;
    return showAuth('denied');
  }

  const owner = load('owner', null);
  if (owner && owner !== userId) {
    // Dados de outra pessoa ficaram neste aparelho: não podem aparecer para esta conta.
    await clearLocalData();
  } else if (!owner && (history.length || route.stops.length)) {
    toast('As rotas que já estavam neste aparelho serão guardadas na sua conta.');
  }
  save('owner', userId);
  account = { userId, email, profile };
  route.ownerId = undefined;
  hideAuth();
  $('[data-tab=team]').hidden = profile.role !== 'admin';
  renderSyncBadge();
  await syncNow();
  showTab(document.querySelector('.view:not([hidden])')?.dataset.view ?? (route.plan ? 'route' : 'import'));
}

async function clearLocalData() {
  stopGps({ silent: true });
  for (const k of ['current', 'history', 'syncMeta', 'profile']) remove(k);
  await clearPhotos().catch(() => {});
  route = newRoute();
  history = [];
  syncMeta = newSyncMeta();
  fittedPlan = null;
  saveLocal();
}

async function logout({ force = false } = {}) {
  if (account && !force) {
    await syncNow();
    const pending = pendingCount({ current: route, history }, syncMeta);
    if (pending && !confirm(`Há ${pending} alteração(ões) que ainda não foram enviadas (sem internet?). Se sair agora, elas serão perdidas neste aparelho. Sair mesmo assim?`)) return;
    if (!pending && !confirm('Sair da conta? Os dados ficam guardados na nuvem e voltam quando você entrar de novo.')) return;
  }
  await cloud.signOut().catch(() => {});
  // Só apaga dados que pertencem a uma conta. Rotas de antes do primeiro login (sem dono)
  // ficam no aparelho até alguém com acesso entrar — evita perder dados por um e-mail digitado errado.
  if (load('owner', null)) await clearLocalData();
  remove('owner');
  location.reload();
}

$('#btn-logout').addEventListener('click', () => logout());
$('#btn-sync').addEventListener('click', async (e) => {
  e.target.disabled = true;
  await syncNow();
  e.target.disabled = false;
});
$('#sync-badge').addEventListener('click', () => showTab('settings'));
window.addEventListener('online', () => scheduleSync(1000));
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') scheduleSync(2000);
});
setInterval(() => scheduleSync(0), 120000);

// ---- Equipe (administrador) ----
let team = { profiles: [], allowed: [], routes: [], audit: [], loadedAt: 0, person: null, period: 'today' };
const AUDIT_LABEL = { acesso_liberado: 'Acesso liberado', acesso_removido: 'Acesso removido', papel_alterado: 'Papel alterado', rota_excluida: 'Rota excluída' };

async function loadTeam() {
  const [profiles, allowed, rows, audit] = await Promise.all([
    cloud.listProfiles(), cloud.listAllowed(), cloud.fetchTeamRoutes(30), cloud.listAudit(30).catch(() => []),
  ]);
  // Dados de outras pessoas: higienizados antes de qualquer exibição (proteção contra XSS armazenado).
  const routes = rows.map((row) => sanitizeRoute({ ...row.data, id: row.id, ownerId: row.user_id, updatedAt: row.updated_at })).filter(Boolean);
  routes.forEach((r) => r.stops.forEach(migrateStop));
  team = { ...team, profiles, allowed, routes, audit, loadedAt: Date.now() };
}

async function renderTeam(reload = false) {
  if (account?.profile.role !== 'admin') return;
  const body = $('#team-body');
  if (reload || !team.loadedAt) {
    body.innerHTML = '<p class="muted">Carregando dados da equipe...</p>';
    try {
      await loadTeam();
    } catch (err) {
      body.innerHTML = `<p class="status error">Não foi possível carregar (${esc(err.message)}). Verifique a internet e toque em Atualizar.</p>`;
      return;
    }
  }
  document.querySelectorAll('#view-team [data-period]').forEach((b) => b.classList.toggle('active', b.dataset.period === team.period));
  $('#team-updated').textContent = `Atualizado às ${new Date(team.loadedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;
  if (team.person) return renderPerson(team.person);

  const byUser = (id) => team.routes.filter((r) => r.ownerId === id);
  const rows = team.profiles.map((p) => {
    const routes = byUser(p.id);
    const s = summarize(routes, team.period);
    const live = routes.find((r) => !r.finishedAt && r.stops.length);
    const last = routes[0]?.updatedAt;
    return { p, s, live, last };
  });
  const total = summarize(team.routes, team.period);
  const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)}%`);
  body.innerHTML = `
    <div class="tiles">
      <div class="tile"><span class="v">${total.delivered}</span><span class="k">Entregas da equipe</span></div>
      <div class="tile"><span class="v">${pct(total.successRate)}</span><span class="k">Sucesso</span></div>
      <div class="tile"><span class="v">${fmtNum(total.km)} km</span><span class="k">Distância</span></div>
    </div>
    <div class="table-wrap"><table class="team">
      <thead><tr><th>Pessoa</th><th>Entregas</th><th>Sucesso</th><th>Km</th><th>Agora</th></tr></thead>
      <tbody>${rows.map(({ p, s, live, last }) => {
        const st = live && routeStats(orderedStops(live));
        return `<tr data-person="${esc(p.id)}" class="${p.active ? '' : 'inactive'}">
          <td><b>${esc(p.name || p.email)}</b>${p.name ? `<br><span class="small muted">${esc(p.email)}</span>` : ''}${p.role === 'admin' ? ' <span class="tag-role">admin</span>' : ''}${p.active ? '' : ' <span class="small fail-text">sem acesso</span>'}</td>
          <td>${s.delivered}${s.failed ? ` <span class="small fail-text">+${s.failed}✗</span>` : ''}</td>
          <td>${pct(s.successRate)}</td>
          <td>${fmtNum(s.km)}</td>
          <td class="small">${live ? `Em rota: ${st.delivered + st.failed}/${st.total}` : last ? `Atualizou ${new Date(last).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : '—'}</td>
        </tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="small muted">Toque em uma pessoa para ver as rotas, exportar CSV ou PDF.</p>
    <h3 class="chart-title">Acesso ao app</h3>
    <form id="allow-form" class="row">
      <input id="allow-email" type="email" placeholder="email@exemplo.com" required />
      <select id="allow-role"><option value="driver">Entregador</option><option value="admin">Administrador</option></select>
      <button class="primary">Liberar acesso</button>
    </form>
    <p id="allow-status" class="status"></p>
    <ul class="reasons">${team.allowed.map((a) => {
      const p = team.profiles.find((x) => x.email === a.email);
      return `<li><span>${esc(a.email)} · ${a.role === 'admin' ? 'Administrador' : 'Entregador'}${p ? '' : ' · <span class="muted">ainda não entrou</span>'}</span>
        ${a.email === account.email ? '<span class="muted small">você</span>' : `<button class="revoke danger" data-email="${esc(a.email)}">Remover</button>`}</li>`;
    }).join('')}</ul>
    <details class="extra">
      <summary>Registro de atividades (últimas ${team.audit.length})</summary>
      <ul class="reasons">${team.audit.map((ev) => `<li><span><b>${esc(AUDIT_LABEL[ev.action] ?? ev.action)}</b> · ${esc(ev.target ?? '')}<br>
        <span class="small muted">${new Date(ev.at).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })} · ${esc(ev.actor_email ?? 'sistema')}</span></span></li>`).join('') || '<li class="muted">Nenhum evento registrado.</li>'}</ul>
    </details>`;
}

function renderPerson(personId) {
  const p = team.profiles.find((x) => x.id === personId);
  const routes = team.routes.filter((r) => r.ownerId === personId);
  const s = summarize(routes, team.period);
  $('#team-body').innerHTML = `
    <button id="team-back">← Equipe</button>
    <h3>${esc(p?.name || p?.email || 'Pessoa')}</h3>
    <div class="tiles">
      <div class="tile"><span class="v">${s.delivered}</span><span class="k">Entregas</span></div>
      <div class="tile"><span class="v">${s.successRate == null ? '—' : `${Math.round(s.successRate * 100)}%`}</span><span class="k">Sucesso</span></div>
      <div class="tile"><span class="v">${fmtNum(s.km)} km</span><span class="k">Distância</span></div>
    </div>
    <ul class="list">${routes.map((r) => {
      const st = routeStats(r.plan ? orderedStops(r) : r.stops);
      return `<li class="card" data-route="${esc(r.id)}">
        <div><b>${esc(r.name)}</b> ${r.finishedAt ? '' : '<span class="tag-role">em andamento</span>'}</div>
        <div class="small muted">${st.delivered}/${st.total} entregues${st.failed ? ` · ${st.failed} com problema` : ''} · atualizada ${new Date(r.updatedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</div>
        <div class="row"><button class="t-csv">Exportar CSV</button><button class="t-pdf">Relatório PDF</button><button class="t-stops">Ver paradas</button></div>
        <ol class="t-stop-list" hidden>${(r.plan ? orderedStops(r) : r.stops).map((x) => `<li>${esc(x.address)} — ${OUTCOME_LABEL[x.outcome] ?? 'Pendente'}${x.outcomeAt ? ` às ${fmtHour(x.outcomeAt)}` : ''}${x.outcome === 'failed' && x.failReason ? ` (${esc(x.failReason)})` : ''}${x.outcomeDistM > farFromStopM(x) ? ` · <span class="warn">📍 a ${fmtDistance(x.outcomeDistM)}</span>` : ''}</li>`).join('')}</ol>
      </li>`;
    }).join('') || '<li class="muted">Nenhuma rota nos últimos 30 dias.</li>'}</ul>`;
}

$('#view-team').addEventListener('click', async (e) => {
  const t = e.target;
  if (t.closest('[data-period]')) {
    team.period = t.closest('[data-period]').dataset.period;
    return renderTeam();
  }
  if (t.id === 'btn-team-refresh') return renderTeam(true);
  if (t.id === 'team-back') {
    team.person = null;
    return renderTeam();
  }
  const personRow = t.closest('[data-person]');
  if (personRow) {
    team.person = personRow.dataset.person;
    return renderTeam();
  }
  if (t.classList.contains('revoke')) {
    if (!confirm(`Remover o acesso de ${t.dataset.email}? As rotas dessa pessoa continuam guardadas.`)) return;
    try {
      await cloud.revokeEmail(t.dataset.email);
      await renderTeam(true);
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const card = t.closest('[data-route]');
  if (!card) return;
  const r = team.routes.find((x) => x.id === card.dataset.route);
  if (t.classList.contains('t-csv')) exportCsv(r);
  if (t.classList.contains('t-pdf')) exportPdf(r, t);
  if (t.classList.contains('t-stops')) card.querySelector('.t-stop-list').hidden ^= true;
});

$('#view-team').addEventListener('submit', async (e) => {
  if (e.target.id !== 'allow-form') return;
  e.preventDefault();
  const email = $('#allow-email').value.trim().toLowerCase();
  try {
    await cloud.allowEmail(email, $('#allow-role').value);
    await renderTeam(true);
    setStatus('#allow-status', `${email} liberado. A pessoa já pode entrar com esse e-mail.`, 'ok');
  } catch (err) {
    setStatus('#allow-status', err.message, 'error');
  }
});

// ---------- PWA ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

saveLocal();
showTab(route.plan ? 'route' : route.stops.length ? 'stops' : 'import');
// Rota com GPS ligado quando o app foi fechado: retoma (a permissão já foi dada).
if (route.tracking?.active) startGps({ resume: true });

// Com nuvem configurada, é preciso entrar na conta (a sessão fica salva no aparelho).
if (cloudConfigured) {
  cloud.session()
    .then((session) => (session ? enterAccount(session) : showAuth('email')))
    .catch(() => showAuth('email', 'Não foi possível verificar a sessão. Confira a internet.', 'error'));
}
