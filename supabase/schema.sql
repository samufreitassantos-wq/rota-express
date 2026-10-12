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
  if p_role not in ('driver', 'admin') then raise exception 'Papel inválido'; end if;
  if lower(trim(p_email)) = (select email from public.profiles where id = auth.uid()) then
    raise exception 'Você não pode alterar o seu próprio papel';
  end if;
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

revoke all on function public.is_member() from public, anon;
revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_member() to authenticated;
grant execute on function public.is_admin() to authenticated;
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

-- ===================== Reforços de segurança (v2) =====================

-- Validações no servidor (NOT VALID: não falha em dados antigos, vale para tudo que entrar).
alter table public.routes drop constraint if exists routes_id_format;
alter table public.routes add constraint routes_id_format check (id ~ '^[A-Za-z0-9_-]{1,64}$') not valid;
alter table public.routes drop constraint if exists routes_data_size;
alter table public.routes add constraint routes_data_size check (pg_column_size(data) <= 2000000) not valid;
alter table public.routes drop constraint if exists routes_name_len;
alter table public.routes add constraint routes_name_len check (char_length(coalesce(name, '')) <= 200) not valid;
alter table public.profiles drop constraint if exists profiles_name_len;
alter table public.profiles add constraint profiles_name_len check (char_length(coalesce(name, '')) <= 120) not valid;

-- Horário do servidor em cada gravação (não controlado pelo aparelho) + limite de rotas por pessoa.
alter table public.routes add column if not exists server_updated_at timestamptz not null default now();
create or replace function public.routes_before_write() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.server_updated_at := now();
  if tg_op = 'INSERT' and (select count(*) from public.routes where user_id = new.user_id) >= 5000 then
    raise exception 'Limite de rotas atingido para esta conta';
  end if;
  return new;
end;
$$;
drop trigger if exists routes_before_write on public.routes;
create trigger routes_before_write before insert or update on public.routes for each row execute function public.routes_before_write();

-- Registro de auditoria: só o banco escreve (gatilhos/funções); só administradores leem.
create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  actor uuid default auth.uid(),
  actor_email text,
  action text not null,
  target text,
  details jsonb
);
alter table public.audit_log enable row level security;
revoke all on public.audit_log from public, anon, authenticated;
grant select on public.audit_log to authenticated;
drop policy if exists "admin lê auditoria" on public.audit_log;
create policy "admin lê auditoria" on public.audit_log for select to authenticated using (public.is_admin());

create or replace function public.audit(p_action text, p_target text, p_details jsonb default null) returns void
language sql security definer set search_path = public as $$
  insert into public.audit_log (actor, actor_email, action, target, details)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()), p_action, p_target, p_details);
$$;
revoke all on function public.audit(text, text, jsonb) from public, anon, authenticated;

create or replace function public.audit_allowed_emails() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'DELETE' then perform public.audit('acesso_removido', old.email, null);
  elsif tg_op = 'INSERT' then perform public.audit('acesso_liberado', new.email, jsonb_build_object('papel', new.role));
  elsif new.role is distinct from old.role then perform public.audit('papel_alterado', new.email, jsonb_build_object('de', old.role, 'para', new.role));
  end if;
  return null;
end;
$$;
drop trigger if exists audit_allowed_emails on public.allowed_emails;
create trigger audit_allowed_emails after insert or update or delete on public.allowed_emails for each row execute function public.audit_allowed_emails();

create or replace function public.audit_routes_delete() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.audit('rota_excluida', old.id, jsonb_build_object('dono', old.user_id, 'nome', old.name, 'finalizada', old.finished_at));
  return null;
end;
$$;
drop trigger if exists audit_routes_delete on public.routes;
create trigger audit_routes_delete after delete on public.routes for each row execute function public.audit_routes_delete();

-- Cadastro só para e-mails liberados: impede criar contas (e disparar e-mails de código) para
-- qualquer endereço. Contas já existentes não são afetadas.
create or replace function public.only_allowed_signup() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.allowed_emails where email = lower(new.email)) then
    raise exception 'Cadastro não permitido';
  end if;
  return new;
end;
$$;
drop trigger if exists only_allowed_signup on auth.users;
create trigger only_allowed_signup before insert on auth.users for each row execute function public.only_allowed_signup();

-- Fotos: até 5 MB, somente imagens comuns (o app envia JPEG comprimido de ~100–300 KB).
update storage.buckets set file_size_limit = 5242880, allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp']
where id = 'photos';
