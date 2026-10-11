// Acesso ao Supabase (login por código no e-mail, rotas, fotos e funções de administrador).
// Só é usado quando o app foi publicado com VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY.
// A chave "anon"/"publishable" é pública por natureza: quem protege os dados são as regras
// de acesso do banco (supabase/schema.sql). Nunca use a chave service_role/secret no app.

const URL_ = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Recusa chaves secretas por engano (service_role / sb_secret_). */
export function isSecretKey(key) {
  if (!key) return false;
  if (key.startsWith('sb_secret_')) return true;
  try {
    return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role === 'service_role';
  } catch {
    return false;
  }
}

export const cloudConfigured = Boolean(URL_ && KEY) && !isSecretKey(KEY);
if (URL_ && KEY && isSecretKey(KEY)) console.error('Rota Express: chave SECRETA do Supabase detectada no app. Use a chave anon/publishable.');

let client;
async function sb() {
  if (!client) {
    const { createClient } = await import('@supabase/supabase-js');
    client = createClient(URL_, KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'rx.auth' },
    });
  }
  return client;
}

const check = ({ data, error }) => {
  if (error) throw new Error(error.message || String(error));
  return data;
};

export { photoPath } from './cloudPaths.js';
const ROUTE_COLS = 'id,user_id,name,created_at,finished_at,updated_at,data';

export const cloud = {
  async session() {
    return check(await (await sb()).auth.getSession()).session;
  },
  async onAuthChange(cb) {
    (await sb()).auth.onAuthStateChange((_event, session) => cb(session));
  },
  async sendCode(email) {
    check(await (await sb()).auth.signInWithOtp({ email, options: { shouldCreateUser: true } }));
  },
  async verifyCode(email, token) {
    return check(await (await sb()).auth.verifyOtp({ email, token, type: 'email' })).session;
  },
  async signOut() {
    await (await sb()).auth.signOut();
  },
  /** Perfil da pessoa logada, ou null se o e-mail não estiver liberado. */
  async claimAccess() {
    const rows = check(await (await sb()).rpc('claim_access'));
    return rows?.[0] ?? null;
  },

  async upsertRoutes(rows) {
    if (rows.length) check(await (await sb()).from('routes').upsert(rows));
  },
  async fetchMyRoutes(userId) {
    return check(await (await sb()).from('routes').select(ROUTE_COLS).eq('user_id', userId).order('updated_at', { ascending: false }));
  },
  async deleteRoute(id) {
    check(await (await sb()).from('routes').delete().eq('id', id));
  },

  async uploadPhoto(path, blob) {
    check(await (await sb()).storage.from('photos').upload(path, blob, { upsert: true, contentType: 'image/jpeg' }));
  },
  async downloadPhoto(path) {
    return check(await (await sb()).storage.from('photos').download(path));
  },
  async removePhotos(paths) {
    if (paths.length) check(await (await sb()).storage.from('photos').remove(paths));
  },

  // ---- Administrador ----
  async listProfiles() {
    return check(await (await sb()).from('profiles').select('id,email,name,role,active').order('email'));
  },
  async listAllowed() {
    return check(await (await sb()).from('allowed_emails').select('email,role,added_at').order('email'));
  },
  async allowEmail(email, role) {
    check(await (await sb()).rpc('admin_allow_email', { p_email: email, p_role: role }));
  },
  async revokeEmail(email) {
    check(await (await sb()).rpc('admin_revoke_email', { p_email: email }));
  },
  /** Rotas de todos atualizadas nos últimos `days` dias (as regras do banco garantem que só admin vê tudo). */
  async fetchTeamRoutes(days = 30) {
    const since = new Date(Date.now() - days * 864e5).toISOString();
    return check(await (await sb()).from('routes').select(ROUTE_COLS).gte('updated_at', since).order('updated_at', { ascending: false }));
  },
};
