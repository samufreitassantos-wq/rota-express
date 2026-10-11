// Backup/restauração: um único arquivo JSON com rota atual, histórico, fotos e ajustes.
import { migrateStop } from './delivery.js';

export const BACKUP_APP = 'rota-express';
export const BACKUP_VERSION = 1;

/**
 * @param photos { [stopId]: dataUrl }
 * A chave do OpenRouteService NÃO entra no backup: o arquivo pode ser compartilhado (WhatsApp, e-mail...).
 */
export function buildBackup({ settings = {}, current = null, history = [], photos = {} }, now = new Date()) {
  const { orsKey, ...safeSettings } = settings;
  return {
    app: BACKUP_APP,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    settings: safeSettings,
    current,
    history,
    photos,
  };
}

const isRoute = (r) => r && typeof r === 'object' && typeof r.id === 'string' && Array.isArray(r.stops);

/** Valida e normaliza o conteúdo de um arquivo de backup. Lança Error com mensagem para o usuário. */
export function parseBackup(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('O arquivo não é um backup válido (JSON inválido).');
  }
  if (data?.app !== BACKUP_APP) throw new Error('Este arquivo não é um backup do Rota Express.');
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) {
    throw new Error('Backup criado por uma versão mais nova do app. Atualize o app e tente de novo.');
  }
  const history = (Array.isArray(data.history) ? data.history : []).filter(isRoute);
  const current = isRoute(data.current) ? data.current : null;
  for (const r of [current, ...history].filter(Boolean)) r.stops.forEach(migrateStop);
  const photos = {};
  for (const [id, url] of Object.entries(data.photos ?? {})) {
    if (typeof url === 'string' && url.startsWith('data:image/')) photos[id] = url;
  }
  const settings = data.settings && typeof data.settings === 'object' ? { ...data.settings } : {};
  delete settings.orsKey;
  return { exportedAt: data.exportedAt ?? null, settings, current, history, photos };
}

/**
 * Junta o histórico do aparelho com o do backup (sem duplicar rotas pelo id),
 * do mais recente para o mais antigo. Retorna também quantas rotas eram novas.
 */
export function mergeHistory(local, incoming, max = Infinity) {
  const ids = new Set(local.map((r) => r.id));
  const added = incoming.filter((r) => !ids.has(r.id));
  const time = (r) => Date.parse(r.finishedAt ?? r.createdAt) || 0;
  const merged = [...local, ...added].sort((a, b) => time(b) - time(a)).slice(0, max);
  return { history: merged, added: added.length };
}

export function backupFileName(now = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `rota-express-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.json`;
}

/** Ids de paradas com foto (rota atual + histórico). */
export function photoIds(current, history) {
  return [current, ...history].filter(Boolean).flatMap((r) => r.stops.filter((s) => s.hasPhoto).map((s) => s.id));
}
