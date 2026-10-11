-- Torna você o primeiro administrador.
-- 1) Troque o e-mail abaixo pelo SEU e-mail (em minúsculas).
-- 2) Execute no Supabase › SQL Editor.
-- 3) No app, entre com esse e-mail. Os demais usuários você libera pelo próprio app (aba Equipe).
insert into public.allowed_emails (email, role) values ('seu-email@exemplo.com', 'admin')
on conflict (email) do update set role = 'admin';
update public.profiles set role = 'admin', active = true where email = 'seu-email@exemplo.com';
