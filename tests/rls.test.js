// Testa o supabase/schema.sql num Postgres real (PGlite, em memória), simulando o ambiente do
// Supabase: esquema auth (auth.uid() a partir do JWT), papel "authenticated" e esquema storage.
import { describe, it, expect, beforeAll } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const SUPABASE_STUB = `
  create role anon nologin; create role authenticated nologin;
  create schema auth;
  create table auth.users (id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as
    $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  create schema storage;
  create table storage.buckets (id text primary key, name text, public boolean);
  create table storage.objects (id serial primary key, bucket_id text, name text);
  create function storage.foldername(name text) returns text[] language sql immutable as
    $$ select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1] $$;
  grant usage on schema auth, storage, public to authenticated, anon;
  grant execute on function auth.uid() to authenticated, anon;
  grant select, insert, update, delete on storage.objects to authenticated;
  grant usage on sequence storage.objects_id_seq to authenticated;
  alter table storage.objects enable row level security;
`;

const ADMIN = '00000000-0000-0000-0000-00000000000a';
const ANA = '00000000-0000-0000-0000-0000000000a1';
const BETO = '00000000-0000-0000-0000-0000000000b2';
const INTRUSO = '00000000-0000-0000-0000-0000000000ff';
let db;

/** Executa SQL como um usuário logado (papel authenticated + id no JWT). */
async function as(uid, sql, params) {
  await db.exec(`reset role; select set_config('request.jwt.claim.sub', '${uid}', false); set role authenticated;`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role;');
  }
}
const fails = async (p) => {
  try {
    await p;
    return false;
  } catch {
    return true;
  }
};

beforeAll(async () => {
  db = new PGlite();
  await db.exec(SUPABASE_STUB);
  const schema = readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');
  await db.exec(schema);
  await db.exec(schema); // idempotente
  await db.exec(readFileSync(new URL('../supabase/admin.sql', import.meta.url), 'utf8').replaceAll('seu-email@exemplo.com', 'chefe@ex.com'));
  await db.exec(`insert into auth.users values
    ('${ADMIN}', 'Chefe@ex.com'), ('${ANA}', 'ana@ex.com'), ('${BETO}', 'beto@ex.com'), ('${INTRUSO}', 'intruso@ex.com');`);
});

describe('acesso por convite', () => {
  it('admin entra; e-mail não liberado não recebe perfil', async () => {
    expect((await as(ADMIN, 'select role from claim_access()')).rows).toEqual([{ role: 'admin' }]);
    expect((await as(INTRUSO, 'select * from claim_access()')).rows).toEqual([]);
  });

  it('só admin libera e-mails', async () => {
    expect(await fails(as(ANA, `select admin_allow_email('ana@ex.com')`))).toBe(true);
    await as(ADMIN, `select admin_allow_email('Ana@ex.com', 'driver')`);
    await as(ADMIN, `select admin_allow_email('beto@ex.com')`);
    expect((await as(ANA, 'select email, role from claim_access()')).rows).toEqual([{ email: 'ana@ex.com', role: 'driver' }]);
    expect((await as(BETO, 'select role from claim_access()')).rows).toEqual([{ role: 'driver' }]);
  });

  it('ninguém se promove a admin por update direto', async () => {
    expect(await fails(as(ANA, `update profiles set role = 'admin' where id = '${ANA}'`))).toBe(true);
    await as(ANA, `update profiles set name = 'Ana Souza' where id = '${ANA}'`);
    expect((await as(ANA, 'select name, role from profiles')).rows).toEqual([{ name: 'Ana Souza', role: 'driver' }]);
  });
});

describe('rotas', () => {
  it('cada um grava e vê só as próprias rotas', async () => {
    await as(ANA, `insert into routes (id, name, data) values ('r-ana', 'Rota Ana', '{}')`);
    await as(BETO, `insert into routes (id, name, data) values ('r-beto', 'Rota Beto', '{}')`);
    expect((await as(ANA, 'select id from routes')).rows).toEqual([{ id: 'r-ana' }]);
    expect((await as(BETO, 'select id from routes')).rows).toEqual([{ id: 'r-beto' }]);
  });

  it('não grava rota em nome de outra pessoa nem altera a dos outros', async () => {
    expect(await fails(as(ANA, `insert into routes (id, user_id, data) values ('fake', '${BETO}', '{}')`))).toBe(true);
    await as(ANA, `update routes set name = 'hackeado' where id = 'r-beto'`);
    await as(ANA, `delete from routes where id = 'r-beto'`);
    expect((await as(BETO, `select name from routes where id = 'r-beto'`)).rows).toEqual([{ name: 'Rota Beto' }]);
  });

  it('admin vê as rotas de todos e a lista de pessoas', async () => {
    expect((await as(ADMIN, 'select id from routes order by id')).rows.map((r) => r.id)).toEqual(['r-ana', 'r-beto']);
    expect((await as(ADMIN, 'select email from profiles order by email')).rows.map((r) => r.email)).toEqual(['ana@ex.com', 'beto@ex.com', 'chefe@ex.com']);
    expect((await as(ANA, 'select email from profiles')).rows).toEqual([{ email: 'ana@ex.com' }]);
  });

  it('e-mail não liberado não lê nem grava nada', async () => {
    expect(await fails(as(INTRUSO, `insert into routes (id, data) values ('x', '{}')`))).toBe(true);
    expect((await as(INTRUSO, 'select id from routes')).rows).toEqual([]);
  });

  it('acesso removido bloqueia a pessoa, mas o admin ainda vê as rotas dela', async () => {
    expect(await fails(as(ADMIN, `select admin_revoke_email('chefe@ex.com')`))).toBe(true); // não remove a si mesmo
    await as(ADMIN, `select admin_revoke_email('beto@ex.com')`);
    expect((await as(BETO, 'select id from routes')).rows).toEqual([]);
    expect(await fails(as(BETO, `insert into routes (id, data) values ('r2', '{}')`))).toBe(true);
    expect((await as(BETO, 'select * from claim_access()')).rows).toEqual([]);
    expect((await as(ADMIN, `select id from routes where id = 'r-beto'`)).rows).toHaveLength(1);
    await as(ADMIN, `select admin_allow_email('beto@ex.com')`); // liberado de novo
    expect((await as(BETO, 'select id from routes')).rows).toEqual([{ id: 'r-beto' }]);
  });
});

describe('fotos (storage)', () => {
  it('pasta própria para gravar; admin lê todas', async () => {
    await as(ANA, `insert into storage.objects (bucket_id, name) values ('photos', '${ANA}/s1.jpg')`);
    expect(await fails(as(ANA, `insert into storage.objects (bucket_id, name) values ('photos', '${BETO}/x.jpg')`))).toBe(true);
    await as(BETO, `insert into storage.objects (bucket_id, name) values ('photos', '${BETO}/s2.jpg')`);
    expect((await as(ANA, 'select name from storage.objects')).rows).toEqual([{ name: `${ANA}/s1.jpg` }]);
    expect((await as(ADMIN, 'select name from storage.objects order by name')).rows).toHaveLength(2);
  });
});
