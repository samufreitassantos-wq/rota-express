# Configurar login e equipe (Supabase)

Tudo pelo navegador do tablet. Leva uns 20 minutos. Enquanto não terminar, o app continua
funcionando como antes (só no aparelho).

## 1. Criar o projeto no Supabase (gratuito, sem cartão)

1. Acesse <https://supabase.com> › **Start your project** › entre com o GitHub.
2. **New project**:
   - Name: `rota-express`
   - Database Password: gere uma e guarde (não vai no app).
   - Region: **South America (São Paulo)**.
3. Aguarde o projeto ficar pronto (1–2 min).

> Plano gratuito: o projeto **pausa após 7 dias sem nenhum uso**. Com uso diário isso não
> acontece; se pausar, entre no painel e clique em **Restore**.

## 2. Criar as tabelas e regras de acesso

1. No GitHub, abra o arquivo `supabase/schema.sql` deste repositório › botão **Raw** › selecione tudo e copie.
2. No Supabase: **SQL Editor** › **New query** › cole › **Run**. Deve aparecer "Success".
3. Abra `supabase/admin.sql` (Raw), copie, cole numa nova query, **troque
   `seu-email@exemplo.com` pelo seu e-mail** (nas duas linhas, em minúsculas) e **Run**.
   Isso faz de você o administrador.

## 3. Envio de e-mails (SMTP) — faça antes do passo 4

O envio padrão do Supabase permite **pouquíssimos e-mails por hora** e serve só para teste, e
**o Supabase só deixa editar o modelo do e-mail (passo 4) depois que o SMTP próprio estiver
configurado** (aviso "Set up custom SMTP to edit templates"). Ligue um envio próprio, gratuito:

**Opção A — Gmail (mais simples):**
1. Na conta Google que vai enviar: ative a **verificação em duas etapas**
   (myaccount.google.com › Segurança).
2. Em myaccount.google.com › Segurança › **Senhas de app**, crie uma senha "Rota Express".
3. No Supabase: **Authentication** › **Emails** › **SMTP Settings** › **Enable Custom SMTP**:
   - Sender email: o seu Gmail · Sender name: `Rota Express`
   - Host: `smtp.gmail.com` · Port: `465`
   - Username: o seu Gmail · Password: a senha de app (16 letras)
4. Save. (Limite do Gmail: ~500 e-mails/dia — sobra para logins.)

**Opção B — Brevo:** conta grátis em brevo.com (300 e-mails/dia) › SMTP & API › use host
`smtp-relay.brevo.com`, porta `587` e as credenciais SMTP mostradas lá.

Cada pessoa só recebe código quando entra pela primeira vez num aparelho (ou depois de "Sair").

## 4. Login por código de 6 dígitos

O app pede um **código** em vez de um link: no iPhone/iPad, o link abriria no Safari e o app
instalado na tela inicial continuaria deslogado.

O Supabase usa **dois modelos**: **Confirm signup** no primeiro acesso de cada e-mail e
**Magic link or OTP** nos seguintes. Os dois precisam mostrar o código (os campos só ficam
editáveis depois do passo 3).

1. **Authentication** › **Emails** › **Confirm signup**. Troque o conteúdo por (no Body, toque em
   **Source** antes de colar):
   - Subject: `Seu código do Rota Express`
   - Body: `<p>Seu código para entrar no Rota Express: <strong>{{ .Token }}</strong></p><p>Ele vale por alguns minutos.</p>`
   - **Save**.
2. **Authentication** › **Emails** › **Magic link or OTP**: o mesmo Subject e Body. **Save**.
3. **Authentication** › **URL Configuration** › **Site URL**:
   `https://<seu-usuario>.github.io/rota-express/` › **Save**. (Sem isso, links em e-mails do
   Supabase apontam para `localhost:3000`.)
4. **Authentication** › **Sign In / Providers** › **Email**: deixe **Enable Email provider** ligado
   e confira **Email OTP Length = 6**. Salve.

> Se um e-mail chegar com **link** em vez de código ("Confirm your email address"), é porque o
> modelo **Confirm signup** ainda está no padrão. Ajuste-o e peça um novo código no app.

## 5. Ligar o app ao Supabase

1. No Supabase: **Project Settings** › **API Keys** (ou **API**). Copie:
   - **Project URL** (ex.: `https://abcd1234.supabase.co`)
   - a chave **anon public** / **publishable** (começa com `eyJ...` ou `sb_publishable_...`).
   - ⚠️ **Nunca** use a chave `service_role` / `secret`. O app recusa essa chave.
2. No GitHub: repositório › **Settings** › **Secrets and variables** › **Actions** › aba
   **Variables** › **New repository variable**:
   - `SUPABASE_URL` = Project URL
   - `SUPABASE_ANON_KEY` = chave anon/publishable
3. **Actions** › **Publicar no GitHub Pages** › **Run workflow** (branch `main`).

A chave anon é pública por natureza (fica no app de qualquer forma); quem protege os dados
são as regras de acesso do passo 2.

## 6. Primeiro acesso

1. Abra o app (feche e abra de novo para atualizar). Aparece a tela **"Seu e-mail"**.
2. Entre com o e-mail de administrador e o código recebido.
3. As rotas que já estavam no aparelho são enviadas para a sua conta.
4. Aba **Equipe** › **Acesso ao app**: digite o e-mail de cada entregador › **Liberar acesso**.
5. Cada entregador instala o app, entra com o próprio e-mail e o código.

## Como funciona o acesso

| Quem | Vê | Pode |
|---|---|---|
| Entregador | só as próprias rotas, histórico e fotos | criar e registrar as próprias rotas |
| Administrador | as rotas, históricos e fotos de todos (últimos 30 dias na aba Equipe) | liberar/remover acessos, exportar CSV/PDF de qualquer pessoa |
| E-mail não liberado | nada | só vê o aviso "ainda não tem acesso" |

As regras ficam no banco (Row Level Security), não só na tela: mesmo chamando a API
diretamente, uma pessoa não consegue ler dados de outra.

Remover o acesso de alguém bloqueia a pessoa na próxima abertura do app; as rotas dela continuam
guardadas e visíveis para o administrador.
