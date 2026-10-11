import 'leaflet/dist/leaflet.css';
import './styles/app.css';
import L from 'leaflet';
import { extractAddresses, normalizeAddress } from './lib/addressParser.js';
import { extractPdfText, extractImageText } from './lib/pdf.js';
import { geocode } from './lib/geocode.js';
import { planRoute } from './lib/planner.js';
import { googleMapsUrl, googleMapsMultiUrl, wazeUrl, MOBILE_MAX_WAYPOINTS } from './lib/navLinks.js';
import { load, save, remove } from './lib/storage.js';
import { orsDirections } from './lib/ors.js';
import { haversine } from './lib/geo.js';
import { FAIL_REASONS, OUTCOME_LABEL, migrateStop, routeStats, moveTo, moveBy, toCsv, csvFileName } from './lib/delivery.js';
import { getPhoto, putPhoto, deletePhotos, compressImage, requestPersistence, blobToDataUrl } from './lib/photos.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const uid = () => Math.random().toString(36).slice(2, 10);
const HISTORY_MAX = 50;

const settings = load('settings', { orsKey: '', defaultCity: '' });
let route = load('current', null) ?? newRoute();
let history = load('history', []);
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

function outcomeLine(s) {
  if (s.outcome === 'delivered') return `<div class="muted small">Entregue às ${fmtHour(s.outcomeAt)}</div>`;
  if (s.outcome === 'failed') return `<div class="small fail-text">Problema às ${fmtHour(s.outcomeAt)}</div>`;
  return '';
}

function stopItem(s, i, next, openIds) {
  const pending = !s.outcome;
  if (reorderMode) {
    return `<li data-id="${s.id}" class="rstop ${s.outcome ?? ''} ${s === next ? 'next' : ''}">
      <div class="num">${i + 1}</div>
      <div class="body">
        <div class="addr">${esc(s.address)}</div>
        ${pending ? `<div class="actions">
          <button class="mv-up" aria-label="Subir">▲</button>
          <button class="mv-down" aria-label="Descer">▼</button>
          ${s === next ? '' : '<button class="mv-next">Fazer a seguir</button>'}
        </div>` : outcomeLine(s)}
      </div>
    </li>`;
  }
  const extras = [s.note ? '📝' : '', s.hasPhoto ? '📷' : ''].join('');
  return `<li data-id="${s.id}" class="rstop ${s.outcome ?? ''} ${s === next ? 'next' : ''}">
    <div class="num">${i + 1}</div>
    <div class="body">
      <div class="addr">${esc(s.address)}</div>
      ${outcomeLine(s)}
      <div class="actions">
        <a class="btn" href="${googleMapsUrl(s)}" target="_blank" rel="noopener">Google Maps</a>
        <a class="btn" href="${wazeUrl(s)}" target="_blank" rel="noopener">Waze</a>
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
        ${s.hasPhoto ? `<img class="thumb" data-photo="${s.id}" alt="Foto do comprovante" />` : ''}
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
  const pendingStops = stops.filter((s) => !s.outcome);
  const next = pendingStops[0];
  const p = route.plan;
  const multi = googleMapsMultiUrl(pendingStops);
  $('#route-summary').innerHTML = `
    <div><b>${st.delivered}/${st.total}</b> entregues${st.failed ? ` · <span class="fail-text">${st.failed} com problema</span>` : ''} · ${fmtKm(p.distance)} · ${fmtDur(p.duration)}</div>
    <div class="progress"><span style="width:${(st.delivered / st.total) * 100}%"></span><span class="failed" style="width:${(st.failed / st.total) * 100}%"></span></div>
    <div class="muted">Otimização: ${p.method === 'ors' ? 'OpenRouteService' : 'local (linha reta)'}${p.manual ? ' · ordem ajustada manualmente' : ''}${p.roadGeometry ? '' : ' · traçado aproximado'}</div>
    ${(p.warnings ?? []).map((w) => `<div class="warn">${esc(w)}</div>`).join('')}
    <div class="actions">
      ${multi && !reorderMode ? `<a class="btn primary" href="${multi}" target="_blank" rel="noopener">Google Maps: próximas ${Math.min(pendingStops.length, MOBILE_MAX_WAYPOINTS + 1)}</a>` : ''}
      <button id="btn-reorder" class="${reorderMode ? 'accent' : ''}">${reorderMode ? 'Concluir reordenação' : '↕ Reordenar'}</button>
      ${!p.roadGeometry && settings.orsKey && !reorderMode ? '<button id="btn-redraw">Recalcular traçado</button>' : ''}
      ${reorderMode ? '' : '<button id="btn-export-csv">Exportar CSV</button><button id="btn-report">Relatório (PDF)</button>'}
    </div>`;

  const openIds = new Set([...document.querySelectorAll('#route-list details[open]')].map((d) => d.closest('li').dataset.id));
  $('#route-list').innerHTML = stops.map((s, i) => stopItem(s, i, next, openIds)).join('');
  loadThumbs();

  if (p.start) L.circleMarker([p.start.lat, p.start.lng], { radius: 8, color: '#1d4ed8', fillOpacity: 0.9 }).bindTooltip('Partida').addTo(layer);
  L.polyline(p.geometry, { color: '#0f766e', weight: 4, opacity: 0.8, dashArray: p.roadGeometry ? null : '6 6' }).addTo(layer);
  stops.forEach((s, i) => {
    const icon = L.divIcon({ className: `pin ${s.outcome === 'delivered' ? 'done' : s.outcome ?? ''} ${s === next ? 'next' : ''}`, html: `<span>${i + 1}</span>`, iconSize: [28, 28], iconAnchor: [14, 14] });
    const m = L.marker([s.lat, s.lng], { icon, draggable: true }).addTo(layer);
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

async function loadThumbs() {
  thumbUrls.forEach((u) => URL.revokeObjectURL(u));
  thumbUrls = [];
  for (const img of document.querySelectorAll('#route-list img[data-photo]')) {
    try {
      const blob = await getPhoto(img.dataset.photo);
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
  if (id === 'btn-reorder') {
    reorderMode = !reorderMode;
    renderRoute();
  } else if (id === 'btn-export-csv') {
    exportCsv(route);
  } else if (id === 'btn-report') {
    printReport(route);
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
    persist();
    renderRoute();
  } else if (cls.contains('undo')) {
    s.outcome = null;
    s.outcomeAt = undefined;
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
      persist();
    } catch (err) {
      alert(`Não foi possível salvar a foto: ${err.message}`);
    }
    renderRoute();
  }
});

// ---------- Exportação ----------
async function exportCsv(r) {
  const name = csvFileName(r);
  const file = new File([toCsv(r, orderedStops(r))], name, { type: 'text/csv' });
  // No tablet/celular, o menu de compartilhar permite salvar em Arquivos, WhatsApp, e-mail etc.
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

async function printReport(r) {
  const stops = orderedStops(r);
  const st = routeStats(stops);
  const photos = {};
  for (const s of stops.filter((x) => x.hasPhoto)) {
    try {
      const blob = await getPhoto(s.id);
      if (blob) photos[s.id] = await blobToDataUrl(blob);
    } catch { /* sem foto */ }
  }
  const report = $('#print-report');
  report.innerHTML = `
    <h1>${esc(r.name)}</h1>
    <p>${st.delivered} entregues · ${st.failed} com problema · ${st.pending} pendentes · ${r.plan ? fmtKm(r.plan.distance) : ''}
    ${r.finishedAt ? ` · finalizada em ${new Date(r.finishedAt).toLocaleString('pt-BR')}` : ''}</p>
    <table>
      <thead><tr><th>#</th><th>Endereço</th><th>Situação</th><th>Horário</th><th>Observação</th></tr></thead>
      <tbody>${stops.map((s, i) => `<tr>
        <td>${i + 1}</td>
        <td>${esc(s.address)}</td>
        <td>${OUTCOME_LABEL[s.outcome] ?? 'Pendente'}${s.outcome === 'failed' ? `<br><small>${esc(s.failReason ?? '')}</small>` : ''}</td>
        <td>${s.outcomeAt ? new Date(s.outcomeAt).toLocaleString('pt-BR') : ''}</td>
        <td>${esc(s.note ?? '')}${photos[s.id] ? `<br><img src="${photos[s.id]}" alt="">` : ''}</td>
      </tr>`).join('')}</tbody>
    </table>
    <p class="small">Gerado pelo Rota Express em ${new Date().toLocaleString('pt-BR')}</p>`;
  await Promise.all([...report.querySelectorAll('img')].map((img) => img.decode().catch(() => {})));
  window.print();
}

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
  reorderMode = false;
  persist();
  showTab('history');
});

// ---------- Histórico ----------
function renderHistory() {
  $('#history-list').innerHTML = history.map((h) => {
    const st = routeStats(h.plan ? orderedStops(h) : h.stops);
    return `<li data-id="${h.id}" class="card">
      <div><b>${esc(h.name)}</b></div>
      <div class="muted small">${st.delivered}/${st.total} entregues${st.failed ? ` · ${st.failed} com problema` : ''} · ${h.plan ? fmtKm(h.plan.distance) : '—'} · finalizada ${h.finishedAt ? new Date(h.finishedAt).toLocaleString('pt-BR') : '—'}</div>
      <div class="row">
        <button class="csv">Exportar CSV</button>
        <button class="report">Relatório (PDF)</button>
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
    printReport(h);
  } else if (cls.contains('del')) {
    if (!confirm('Excluir esta rota do histórico (inclusive as fotos)?')) return;
    history = history.filter((x) => x.id !== h.id);
    save('history', history);
    await deletePhotos(h.stops.filter((s) => s.hasPhoto).map((s) => s.id)).catch(() => {});
    renderHistory();
  } else if (cls.contains('reuse')) {
    if (route.stops.length && !confirm('Substituir as paradas da rota atual?')) return;
    await discardCurrentPhotos();
    route = newRoute();
    route.start = h.start;
    route.stops = h.stops.map(({ id, outcome, outcomeAt, failReason, note, hasPhoto, ...rest }) => ({ ...rest, id: uid(), outcome: null }));
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
  save('settings', settings);
  setStatus('#settings-status', 'Ajustes salvos neste aparelho.', 'ok');
});
$('#btn-clear-cache').addEventListener('click', () => {
  remove('geocache');
  setStatus('#settings-status', 'Cache de endereços limpo.', 'ok');
});
$('#btn-new-route').addEventListener('click', async () => {
  if (route.stops.length && !confirm('Descartar a rota atual (não finalizada)?')) return;
  await discardCurrentPhotos();
  route = newRoute();
  reorderMode = false;
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
