// Servidor local que imita a API do Supabase usada pelo app, para testes sem internet.
// Usa o MESMO supabase/schema.sql num Postgres em memória (PGlite), então as regras de acesso
// (RLS) aplicadas são as reais. Cobre só o subconjunto da API que o app usa.
//
// Uso: node scripts/mock-supabase.mjs [porta] [email-admin]
//   O código de login de qualquer e-mail aparece no console e em GET /__test/code?email=...
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const PORT = Number(process.argv[2] ?? 54321);
const ADMIN_EMAIL = process.argv[3] ?? 'chefe@ex.com';

const STUB = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text unique);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
  create table storage.objects (id serial primary key, bucket_id text, name text, unique (bucket_id, name));
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema auth, storage, public to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant usage on sequence storage.objects_id_seq to authenticated;
  alter table storage.objects enable row level security;
`;

const db = new PGlite();
await db.exec(STUB);
await db.exec(readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
await db.exec(readFileSync(new URL('../supabase/admin.sql', import.meta.url), 'utf8').replaceAll('seu-email@exemplo.com', ADMIN_EMAIL));

const codes = new Map(); // email -> código
const files = new Map(); // caminho -> { type, bytes }
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

// Uma conexão só: requisições em fila.
let queue = Promise.resolve();
const serial = (fn) => (queue = queue.then(fn, fn));

async function asUser(uid, fn) {
  return serial(async () => {
    await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid ?? ''}', false); set role ${uid ? 'authenticated' : 'anon'};`);
    try {
      return await fn();
    } finally {
      await db.exec('reset role;');
    }
  });
}

function session(user) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: user.id, email: user.email, role: 'authenticated', aud: 'authenticated', exp })}.sig`;
  return {
    access_token: token, token_type: 'bearer', expires_in: 3600, expires_at: exp, refresh_token: `r-${user.id}`,
    user: { id: user.id, email: user.email, aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
  };
}
function uidFrom(req) {
  const tok = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  try {
    return JSON.parse(Buffer.from(tok.split('.')[1], 'base64url').toString()).sub ?? null;
  } catch {
    return null;
  }
}
// Datas como o PostgREST devolve ("+00:00"), para testar o app com o formato real.
const pgJson = (rows) => JSON.parse(JSON.stringify(rows, (k, v) => (typeof v === 'string' && /^\d{4}-\d\d-\d\dT.*Z$/.test(v) ? v.replace(/(\.\d+)?Z$/, (m, f) => `${f && f !== '.000' ? f : ''}+00:00`) : v)));

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS,HEAD,PUT',
    'Access-Control-Expose-Headers': '*',
    ...(body != null ? { 'Content-Type': type } : {}),
  });
  res.end(body == null ? undefined : Buffer.isBuffer(body) ? body : typeof body === 'string' ? body : JSON.stringify(body));
}
const readBody = (req) => new Promise((ok) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => ok(Buffer.concat(chunks)));
});

/** Extrai o arquivo de um corpo multipart (upload do storage-js com Blob). */
function fileFromMultipart(buf, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType ?? '')?.[1];
  if (!boundary) return { type: contentType, bytes: buf };
  const sep = Buffer.from(`--${boundary}`);
  let start = 0;
  const parts = [];
  for (let i = buf.indexOf(sep); i !== -1; i = buf.indexOf(sep, start)) {
    if (start) parts.push(buf.subarray(start, i - 2));
    start = i + sep.length + 2;
  }
  for (const p of parts) {
    const headEnd = p.indexOf('\r\n\r\n');
    const head = p.subarray(0, headEnd).toString();
    if (/filename=|Content-Type: image/i.test(head)) {
      return { type: /Content-Type: (.+)/i.exec(head)?.[1]?.trim() ?? 'application/octet-stream', bytes: p.subarray(headEnd + 4) };
    }
  }
  return { type: contentType, bytes: buf };
}

function parseFilters(params) {
  const where = [];
  const values = [];
  for (const [k, v] of params) {
    if (['select', 'order', 'on_conflict', 'columns', 'limit'].includes(k)) continue;
    const m = /^(eq|gte|lte|gt|lt)\.(.*)$/.exec(v);
    if (!m) continue;
    const op = { eq: '=', gte: '>=', lte: '<=', gt: '>', lt: '<' }[m[1]];
    values.push(m[2]);
    where.push(`"${k}" ${op} $${values.length}`);
  }
  return { where: where.length ? `where ${where.join(' and ')}` : '', values };
}

async function rest(req, res, url, uid) {
  const [, , , name, fn] = url.pathname.split('/'); // /rest/v1/<tabela> | /rest/v1/rpc/<função>
  const body = await readBody(req);
  try {
    if (name === 'rpc') {
      const args = body.length ? JSON.parse(body) : {};
      const keys = Object.keys(args);
      const sql = `select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')})`;
      const r = await asUser(uid, () => db.query(sql, keys.map((k) => args[k])));
      const rows = r.fields.length === 1 && r.fields[0].name === fn ? [] : r.rows;
      return send(res, 200, pgJson(rows));
    }
    const params = url.searchParams;
    if (req.method === 'GET') {
      const cols = (params.get('select') ?? '*').split(',').map((c) => (c === '*' ? '*' : `"${c}"`)).join(',');
      const { where, values } = parseFilters(params);
      const order = params.get('order') ? `order by "${params.get('order').split('.')[0]}" ${params.get('order').includes('.desc') ? 'desc' : 'asc'}` : '';
      const limit = Number(params.get('limit')) > 0 ? `limit ${Number(params.get('limit'))}` : '';
      const r = await asUser(uid, () => db.query(`select ${cols} from public.${name} ${where} ${order} ${limit}`, values));
      return send(res, 200, pgJson(r.rows));
    }
    if (req.method === 'POST') {
      const rows = [].concat(JSON.parse(body));
      await asUser(uid, async () => {
        for (const row of rows) {
          const cols = Object.keys(row);
          const vals = cols.map((c) => (row[c] !== null && typeof row[c] === 'object' ? JSON.stringify(row[c]) : row[c]));
          const upsert = (req.headers.prefer ?? '').includes('merge-duplicates')
            ? `on conflict (id) do update set ${cols.filter((c) => c !== 'id').map((c) => `"${c}" = excluded."${c}"`).join(', ')}` : '';
          await db.query(`insert into public.${name} (${cols.map((c) => `"${c}"`).join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) ${upsert}`, vals);
        }
      });
      return send(res, 201, null);
    }
    if (req.method === 'DELETE') {
      const { where, values } = parseFilters(params);
      await asUser(uid, () => db.query(`delete from public.${name} ${where}`, values));
      return send(res, 204, null);
    }
  } catch (err) {
    return send(res, err.message.includes('row-level security') ? 403 : 400, { message: err.message, code: err.code });
  }
  return send(res, 404, { message: 'não suportado' });
}

async function storage(req, res, url, uid) {
  // /storage/v1/object/<bucket>/<caminho>
  const parts = decodeURIComponent(url.pathname).split('/').slice(4);
  const bucket = parts[0];
  const path = parts.slice(1).join('/');
  const body = await readBody(req);
  try {
    if (req.method === 'POST' || req.method === 'PUT') {
      await asUser(uid, async () => {
        const exists = (await db.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, path])).rows.length;
        if (exists) await db.query('update storage.objects set name = name where bucket_id = $1 and name = $2', [bucket, path]);
        else await db.query('insert into storage.objects (bucket_id, name) values ($1, $2)', [bucket, path]);
      });
      files.set(`${bucket}/${path}`, fileFromMultipart(body, req.headers['content-type']));
      return send(res, 200, { Key: `${bucket}/${path}`, Id: randomUUID() });
    }
    if (req.method === 'GET') {
      const ok = await asUser(uid, async () => (await db.query('select 1 from storage.objects where bucket_id = $1 and name = $2', [bucket, path])).rows.length);
      const f = files.get(`${bucket}/${path}`);
      if (!ok || !f) return send(res, 400, { statusCode: '404', error: 'not_found', message: 'Object not found' });
      return send(res, 200, f.bytes, f.type);
    }
    if (req.method === 'DELETE') {
      const { prefixes } = JSON.parse(body);
      const deleted = await asUser(uid, async () => (await db.query('delete from storage.objects where bucket_id = $1 and name = any($2) returning name', [bucket, prefixes])).rows);
      for (const d of deleted) files.delete(`${bucket}/${d.name}`);
      return send(res, 200, deleted);
    }
  } catch (err) {
    return send(res, 400, { statusCode: '403', error: 'Unauthorized', message: err.message });
  }
  return send(res, 404, { message: 'não suportado' });
}

async function authApi(req, res, url) {
  const body = await readBody(req);
  const json = body.length ? JSON.parse(body) : {};
  const route = url.pathname.replace('/auth/v1/', '');
  if (route === 'otp') {
    const email = json.email.toLowerCase();
    // Como o Supabase: o usuário é criado no pedido do código; gatilhos em auth.users podem recusar.
    try {
      await serial(async () => {
        const found = (await db.query('select 1 from auth.users where email = $1', [email])).rows.length;
        if (!found) await db.query('insert into auth.users (id, email) values ($1, $2)', [randomUUID(), email]);
      });
    } catch {
      return send(res, 500, { code: 500, error_code: 'unexpected_failure', msg: 'Database error saving new user' });
    }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    codes.set(email, code);
    console.log(`[mock-supabase] código de ${email}: ${code}`);
    return send(res, 200, {});
  }
  if (route === 'verify') {
    const email = json.email.toLowerCase();
    if (codes.get(email) !== json.token) return send(res, 403, { code: 'otp_expired', error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
    codes.delete(email);
    const user = await serial(async () => (await db.query('select id, email from auth.users where email = $1', [email])).rows[0]);
    if (!user) return send(res, 403, { code: 'otp_expired', error_code: 'otp_expired', msg: 'Token has expired or is invalid' });
    return send(res, 200, session(user));
  }
  if (route.startsWith('token')) {
    const id = String(json.refresh_token ?? '').replace(/^r-/, '');
    const user = await serial(async () => (await db.query('select id, email from auth.users where id = $1', [id])).rows[0]);
    return user ? send(res, 200, session(user)) : send(res, 400, { error: 'invalid_grant' });
  }
  if (route === 'user') {
    const id = uidFrom(req);
    const user = await serial(async () => (await db.query('select id, email from auth.users where id = $1', [id])).rows[0]);
    return user ? send(res, 200, session(user).user) : send(res, 401, { msg: 'invalid' });
  }
  if (route === 'logout') return send(res, 204, null);
  return send(res, 404, { msg: 'não suportado' });
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (req.method === 'OPTIONS') return send(res, 204, null);
  if (url.pathname === '/__test/code') return send(res, 200, { code: codes.get(url.searchParams.get('email')) ?? null });
  if (url.pathname === '/__test/sql') {
    const r = await serial(() => db.query(url.searchParams.get('q')));
    return send(res, 200, pgJson(r.rows));
  }
  if (url.pathname.startsWith('/auth/v1/')) return authApi(req, res, url);
  const uid = uidFrom(req);
  if (url.pathname.startsWith('/rest/v1/')) return rest(req, res, url, uid);
  if (url.pathname.startsWith('/storage/v1/object/')) return storage(req, res, url, uid);
  return send(res, 404, { message: 'não suportado' });
}).listen(PORT, () => console.log(`[mock-supabase] ouvindo em http://localhost:${PORT} (admin: ${ADMIN_EMAIL})`));
