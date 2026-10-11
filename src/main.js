import 'leaflet/dist/leaflet.css';
import './styles/app.css';
import L from 'leaflet';
import { extractAddresses, normalizeAddress } from './lib/addressParser.js';
import { extractPdfText } from './lib/pdf.js';
import { geocode } from './lib/geocode.js';
import { planRoute } from './lib/planner.js';
import { googleMapsUrl, wazeUrl } from './lib/navLinks.js';
import { load, save, remove } from './lib/storage.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => Math.random().toString(36).slice(2, 10);
const HISTORY_MAX = 50;

const settings = load('settings', { orsKey: '', defaultCity: '' });
let route = load('current', null) ?? newRoute();
let history = load('history', []);

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

function persist() {
  if (!save('current', route)) setStatus('#stops-status', 'Não foi possível salvar no aparelho (armazenamento cheio?).', 'error');
  $('#route-name').textContent = route.name;
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
  if (name === 'settings') {
    $('#ors-key').value = settings.orsKey;
    $('#default-city').value = settings.defaultCity;
  }
}
document.querySelector('.tabbar').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) showTab(b.dataset.tab);
});

// ---------- Importação ----------
$('#pdf-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  setStatus('#import-status', `Lendo ${files.length} PDF(s)...`);
  const texts = [];
  for (const f of files) {
    try {
      texts.push(await extractPdfText(f));
    } catch (err) {
      setStatus('#import-status', `Erro ao ler ${f.name}: ${err.message}`, 'error');
      return;
    }
  }
  const text = texts.join('\n');
  $('#raw-text').value = text;
  e.target.value = '';
  if (!text.trim()) {
    setStatus('#import-status', 'Nenhum texto encontrado. O PDF pode ser uma imagem escaneada.', 'error');
    return;
  }
  importAddresses(extractAddresses(text).map((a) => a.address));
});

$('#btn-extract').addEventListener('click', () => {
  importAddresses(extractAddresses($('#raw-text').value).map((a) => a.address));
});
$('#btn-one-per-line').addEventListener('click', () => {
  const lines = $('#raw-text').value.split(/\r?\n/).map(normalizeAddress).filter(Boolean);
  importAddresses(lines);
});

function importAddresses(addresses) {
  const existing = new Set(route.stops.map((s) => s.address.toLowerCase()));
  const fresh = addresses.filter((a) => !existing.has(a.toLowerCase()));
  if (!fresh.length) {
    setStatus('#import-status', 'Nenhum endereço novo encontrado. Tente "1 linha = 1 endereço" ou edite o texto.', 'error');
    return;
  }
  route.stops.push(...fresh.map((address) => ({ id: uid(), address, status: 'pending', delivered: false })));
  route.plan = null;
  persist();
  setStatus('#import-status', `${fresh.length} endereço(s) adicionados. Revise na aba Paradas.`, 'ok');
  showTab('stops');
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
    <li data-id="${s.id}" class="stop ${s.status}">
      <input class="addr" value="${esc(s.address)}" aria-label="Endereço" />
      <div class="meta">
        <span class="tag ${s.status}">${STATUS_LABEL[s.status] ?? ''}</span>
        ${s.label ? `<span class="muted small">${esc(s.label)}</span>` : ''}
      </div>
      <button class="del" title="Remover">🗑</button>
    </li>`).join('') || '<li class="muted">Nenhuma parada. Importe um PDF ou cole endereços.</li>';
}

$('#stops-list').addEventListener('change', (e) => {
  if (!e.target.classList.contains('addr')) return;
  const stop = route.stops.find((s) => s.id === e.target.closest('li').dataset.id);
  stop.address = normalizeAddress(e.target.value);
  Object.assign(stop, { status: 'pending', lat: undefined, lng: undefined, label: undefined });
  route.plan = null;
  persist();
  renderStops();
});
$('#stops-list').addEventListener('click', (e) => {
  if (!e.target.classList.contains('del')) return;
  route.stops = route.stops.filter((s) => s.id !== e.target.closest('li').dataset.id);
  route.plan = null;
  persist();
  renderStops();
});
$('#btn-add-stop').addEventListener('click', () => {
  route.stops.push({ id: uid(), address: '', status: 'pending', delivered: false });
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
      if (r) Object.assign(s, { lat: r.lat, lng: r.lng, label: r.label, status: 'ok' });
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
    const plan = await planRoute(start, located, { key: settings.orsKey });
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

function ensureMap() {
  if (map) return;
  map = L.map('map', { zoomControl: true }).setView([-15.78, -47.93], 4);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  layer = L.layerGroup().addTo(map);
}

const orderedStops = () => (route.plan?.order ?? []).map((id) => route.stops.find((s) => s.id === id)).filter(Boolean);

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
  const delivered = stops.filter((s) => s.delivered).length;
  const next = stops.find((s) => !s.delivered);
  const p = route.plan;
  $('#route-summary').innerHTML = `
    <div><b>${delivered}/${stops.length}</b> entregues · ${fmtKm(p.distance)} · ${fmtDur(p.duration)}</div>
    <div class="progress"><span style="width:${(delivered / stops.length) * 100}%"></span></div>
    <div class="muted">Otimização: ${p.method === 'ors' ? 'OpenRouteService' : 'local (linha reta)'}${p.roadGeometry ? '' : ' · traçado aproximado'}${route.finishedAt ? ' · finalizada' : ''}</div>
    ${(p.warnings ?? []).map((w) => `<div class="warn">${esc(w)}</div>`).join('')}`;

  $('#route-list').innerHTML = stops.map((s, i) => `
    <li data-id="${s.id}" class="rstop ${s.delivered ? 'done' : ''} ${s === next ? 'next' : ''}">
      <div class="num">${i + 1}</div>
      <div class="body">
        <div class="addr">${esc(s.address)}</div>
        ${s.deliveredAt ? `<div class="muted small">Entregue às ${new Date(s.deliveredAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}</div>` : ''}
        <div class="actions">
          <a class="btn" href="${googleMapsUrl(s)}" target="_blank" rel="noopener">Google Maps</a>
          <a class="btn" href="${wazeUrl(s)}" target="_blank" rel="noopener">Waze</a>
          <button class="toggle ${s.delivered ? '' : 'primary'}">${s.delivered ? 'Desfazer' : '✓ Entregue'}</button>
        </div>
      </div>
    </li>`).join('');

  if (p.start) L.circleMarker([p.start.lat, p.start.lng], { radius: 8, color: '#1d4ed8', fillOpacity: 0.9 }).bindTooltip('Partida').addTo(layer);
  L.polyline(p.geometry, { color: '#0f766e', weight: 4, opacity: 0.8, dashArray: p.roadGeometry ? null : '6 6' }).addTo(layer);
  stops.forEach((s, i) => {
    const icon = L.divIcon({ className: `pin ${s.delivered ? 'done' : ''} ${s === next ? 'next' : ''}`, html: `<span>${i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    const m = L.marker([s.lat, s.lng], { icon, draggable: !route.finishedAt }).addTo(layer);
    m.bindPopup(`<b>${i + 1}.</b> ${esc(s.address)}<br><small>Arraste o pino para corrigir a posição.</small>`);
    m.on('dragend', () => {
      const { lat, lng } = m.getLatLng();
      Object.assign(s, { lat, lng, label: 'Ajustado manualmente' });
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

$('#route-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  if (e.target.classList.contains('toggle')) {
    const s = route.stops.find((x) => x.id === li.dataset.id);
    s.delivered = !s.delivered;
    s.deliveredAt = s.delivered ? new Date().toISOString() : undefined;
    persist();
    renderRoute();
  } else if (!e.target.closest('a,button')) {
    const s = route.stops.find((x) => x.id === li.dataset.id);
    map.setView([s.lat, s.lng], 16);
  }
});

function archive(r) {
  // Não guardamos o traçado completo no histórico para economizar espaço.
  const copy = structuredClone(r);
  if (copy.plan) copy.plan.geometry = [];
  history = [copy, ...history.filter((h) => h.id !== r.id)].slice(0, HISTORY_MAX);
  save('history', history);
}

$('#btn-finish').addEventListener('click', () => {
  if (!route.plan) return;
  if (!confirm('Finalizar a rota e salvá-la no histórico?')) return;
  route.finishedAt = new Date().toISOString();
  archive(route);
  route = newRoute();
  persist();
  showTab('history');
});

// ---------- Histórico ----------
function renderHistory() {
  $('#history-list').innerHTML = history.map((h) => {
    const total = h.plan?.order?.length ?? h.stops.length;
    const done = h.stops.filter((s) => s.delivered).length;
    return `<li data-id="${h.id}" class="card">
      <div><b>${esc(h.name)}</b></div>
      <div class="muted small">${done}/${total} entregues · ${h.plan ? fmtKm(h.plan.distance) : '—'} · finalizada ${h.finishedAt ? new Date(h.finishedAt).toLocaleString('pt-BR') : '—'}</div>
      <div class="row"><button class="reuse">Reusar endereços</button><button class="del danger">Excluir</button></div>
    </li>`;
  }).join('') || '<li class="muted">Nenhuma rota finalizada ainda.</li>';
}

$('#history-list').addEventListener('click', (e) => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  const h = history.find((x) => x.id === li.dataset.id);
  if (e.target.classList.contains('del')) {
    if (!confirm('Excluir esta rota do histórico?')) return;
    history = history.filter((x) => x.id !== h.id);
    save('history', history);
    renderHistory();
  } else if (e.target.classList.contains('reuse')) {
    if (route.stops.length && !confirm('Substituir as paradas da rota atual?')) return;
    route = newRoute();
    route.start = h.start;
    route.stops = h.stops.map((s) => ({ ...s, id: uid(), delivered: false, deliveredAt: undefined }));
    persist();
    showTab('stops');
  }
});

// ---------- Ajustes ----------
$('#btn-save-settings').addEventListener('click', () => {
  settings.orsKey = $('#ors-key').value.trim();
  settings.defaultCity = $('#default-city').value.trim();
  save('settings', settings);
  setStatus('#settings-status', 'Ajustes salvos neste aparelho.', 'ok');
});
$('#btn-clear-cache').addEventListener('click', () => {
  remove('geocache');
  setStatus('#settings-status', 'Cache de endereços limpo.', 'ok');
});
$('#btn-new-route').addEventListener('click', () => {
  if (route.stops.length && !confirm('Descartar a rota atual (não finalizada)?')) return;
  route = newRoute();
  persist();
  $('#raw-text').value = '';
  showTab('import');
});

// ---------- PWA ----------
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

persist();
showTab(route.plan ? 'route' : route.stops.length ? 'stops' : 'import');
