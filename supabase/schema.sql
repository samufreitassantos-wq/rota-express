-- Rota Express — banco de dados no Supabase.
-- Execute este arquivo inteiro uma vez em: Supabase › SQL Editor › New query › colar › Run.
-- Pode ser executado de novo com segurança (idempotente).
-- Depois, rode supabase/admin.sql (com o SEU e-mail) para se tornar administrador.

-- ===================== Tabelas =====================

-- E-mails liberados para usar o app (gerenciado pelo administrador no app).
create table if not exists public.allowed_emails (
  email text primary key check (email = lower(email)),
  role text not null default 'driver' check (role in ('driver', 'admin')),
  added_at timestamptz not null default now()
);

-- Perfil de cada pessoa com acesso. Criado por claim_access() quando o e-mail está liberado.
create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  name text,
  role text not null default 'driver' check (role in ('driver', 'admin')),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Rotas (em andamento e finalizadas). `data` guarda a rota completa como o app usa.
create table if not exists public.routes (
  id text primary key,
  user_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name text,
  created_at timestamptz,
  finished_at timestamptz,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
create index if not exists routes_user_updated on public.routes (user_id, updated_at desc);

-- ===================== Funções =====================

-- Pessoa logada tem acesso ativo?
create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active);
$$;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and active and role = 'admin');
$$;

-- Chamada pelo app após o login: cria/atualiza o perfil se o e-mail estiver liberado.
-- Retorna o perfil, ou nada se o e-mail não foi liberado.
create or replace function public.claim_access() returns setof public.profiles
language plpgsql security definer set search_path = public as $$
declare
  v_email text;
  v_role text;
begin
  select lower(email) into v_email from auth.users where id = auth.uid();
  if v_email is null then return; end if;
  select role into v_role from public.allowed_emails where email = v_email;
  if v_role is null then
    -- E-mail removido da lista: desativa o acesso.
    update public.profiles set active = false where id = auth.uid();
    return;
  end if;
  insert into public.profiles (id, email, role, active)
  values (auth.uid(), v_email, v_role, true)
  on conflict (id) do update set email = excluded.email, active = true;
  return query select * from public.profiles where id = auth.uid();
end;
$$;

-- Administrador libera um e-mail (e ajusta o papel de quem já tem perfil).
create or replace function public.admin_allow_email(p_email text, p_role text default 'driver') returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Somente administradores'; end if;
  insert into public.allowed_emails (email, role) values (lower(trim(p_email)), p_role)
  on conflict (email) do update set role = excluded.role;
  update public.profiles set role = p_role, active = true where email = lower(trim(p_email));
end;
$$;

-- Administrador remove o acesso de um e-mail (as rotas dessa pessoa continuam guardadas).
create or replace function public.admin_revoke_email(p_email text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then raise exception 'Somente administradores'; end if;
  if lower(trim(p_email)) = (select email from public.profiles where id = auth.uid()) then
    raise exception 'Você não pode remover o seu próprio acesso';
  end if;
  delete from public.allowed_emails where email = lower(trim(p_email));
  update public.profiles set active = false where email = lower(trim(p_email));
end;
$$;

revoke all on function public.admin_allow_email(text, text) from public, anon;
revoke all on function public.admin_revoke_email(text) from public, anon;
revoke all on function public.claim_access() from public, anon;
grant execute on function public.admin_allow_email(text, text) to authenticated;
grant execute on function public.admin_revoke_email(text) to authenticated;
grant execute on function public.claim_access() to authenticated;

-- ===================== Regras de acesso (RLS) =====================

alter table public.allowed_emails enable row level security;
alter table public.profiles enable row level security;
alter table public.routes enable row level security;

drop policy if exists "admin lê lista" on public.allowed_emails;
create policy "admin lê lista" on public.allowed_emails for select to authenticated using (public.is_admin());

drop policy if exists "vê o próprio perfil ou admin vê todos" on public.profiles;
create policy "vê o próprio perfil ou admin vê todos" on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin());
drop policy if exists "atualiza o próprio nome" on public.profiles;
-- Nome pode ser alterado pela própria pessoa; papel e ativo só via funções de admin (ver gatilho abaixo).
create policy "atualiza o próprio nome" on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Impede que alguém mude o próprio papel/ativo/e-mail com um update direto.
create or replace function public.profiles_guard() returns trigger
language plpgsql as $$
begin
  if current_user = 'authenticated' and (new.role is distinct from old.role or new.active is distinct from old.active or new.email is distinct from old.email) then
    raise exception 'Alteração não permitida';
  end if;
  return new;
end;
$$;
drop trigger if exists profiles_guard on public.profiles;
create trigger profiles_guard before update on public.profiles for each row execute function public.profiles_guard();

drop policy if exists "vê as próprias rotas ou admin vê todas" on public.routes;
create policy "vê as próprias rotas ou admin vê todas" on public.routes for select to authenticated
  using ((user_id = auth.uid() and public.is_member()) or public.is_admin());
drop policy if exists "cria as próprias rotas" on public.routes;
create policy "cria as próprias rotas" on public.routes for insert to authenticated
  with check (user_id = auth.uid() and public.is_member());
drop policy if exists "altera as próprias rotas" on public.routes;
create policy "altera as próprias rotas" on public.routes for update to authenticated
  using (user_id = auth.uid() and public.is_member()) with check (user_id = auth.uid());
drop policy if exists "apaga as próprias rotas" on public.routes;
create policy "apaga as próprias rotas" on public.routes for delete to authenticated
  using (user_id = auth.uid() and public.is_member());

grant select, insert, update, delete on public.routes to authenticated;
grant select, update on public.profiles to authenticated;
grant select on public.allowed_emails to authenticated;

-- ===================== Fotos (Storage) =====================
-- Bucket privado "photos"; cada pessoa grava em photos/<seu id>/...; admin lê todas.

insert into storage.buckets (id, name, public) values ('photos', 'photos', false)
on conflict (id) do nothing;

drop policy if exists "fotos: dono lê ou admin" on storage.objects;
create policy "fotos: dono lê ou admin" on storage.objects for select to authenticated
  using (bucket_id = 'photos' and (((storage.foldername(name))[1] = auth.uid()::text and public.is_member()) or public.is_admin()));
drop policy if exists "fotos: dono envia" on storage.objects;
create policy "fotos: dono envia" on storage.objects for insert to authenticated
  with check (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_member());
drop policy if exists "fotos: dono substitui" on storage.objects;
create policy "fotos: dono substitui" on storage.objects for update to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_member());
drop policy if exists "fotos: dono apaga" on storage.objects;
create policy "fotos: dono apaga" on storage.objects for delete to authenticated
  using (bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text and public.is_member());
