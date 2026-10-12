# Rota Express — Relatório de segurança

Auditoria de 12/10/2026, baseada em OWASP ASVS, OWASP Top 10 e OWASP API Security Top 10.
Todos os testes rodaram em ambiente local, com dados fictícios. O projeto Supabase de produção
não foi acessado: daqui não há acesso a ele.

> Nenhum sistema é invulnerável. Este documento lista o que foi verificado com evidência, o que
> não pôde ser verificado e os riscos que continuam.

## 1. Arquitetura

| Parte | Tecnologia | Onde roda |
|---|---|---|
| App (PWA) | Vite + JavaScript, Leaflet, pdf.js, Tesseract.js, jsPDF | Navegador; publicado no GitHub Pages (HTTPS) |
| Login | Supabase Auth: código de 6 dígitos (OTP) por e-mail, sem senhas | Supabase |
| Banco | Postgres (Supabase) com Row Level Security | Supabase |
| Fotos | Supabase Storage, bucket privado `photos` | Supabase |
| E-mail | SMTP próprio (Gmail com senha de app) | Google |
| Serviços externos | Nominatim/OpenStreetMap, OpenRouteService (chave do próprio usuário) | Terceiros |

Não há servidor próprio, funções de backend nem webhooks. As únicas regras confiáveis de acesso
estão **no banco** (RLS + funções `security definer`). O app é só a interface.

**Papéis:**

| Papel | Vê | Pode |
|---|---|---|
| Entregador | só as próprias rotas, fotos e perfil | criar, alterar e excluir as próprias rotas e fotos |
| Administrador | rotas, fotos e perfis de todos; lista de acesso; auditoria | liberar e remover e-mails, mudar o papel **de outras pessoas**, exportar |
| Visitante / e-mail não liberado | nada | nada (não consegue nem criar conta) |

O administrador **não** altera nem exclui dados de outras pessoas (privilégio mínimo) e não pode
mudar o próprio papel.

## 2. Vulnerabilidades encontradas

| # | Vulnerabilidade | Criticidade | Impacto | Situação |
|---|---|---|---|---|
| V1 | **XSS armazenado de entregador contra o administrador.** Campos da rota (id, status, horários etc.) entravam no HTML sem escape. | **Crítica** | Um entregador com acesso executaria código no aparelho do admin, leria a sessão e veria os dados de todos. **Comprovado** em teste (PoC). | Corrigida e verificada |
| V2 | **Injeção de fórmulas no CSV** (OWASP CSV Injection). Endereço ou observação começando com `=`, `+`, `-` ou `@` virava fórmula no Excel. | Média | Links maliciosos ou execução de fórmulas no computador de quem abre o CSV. | Corrigida e verificada |
| V3 | **Cadastro aberto.** Qualquer e-mail criava conta e recebia código. | Média | Uso do app para disparar e-mails a terceiros (gasta a cota do Gmail, risco de bloqueio); contas-lixo. | Corrigida no banco (testado localmente) |
| V4 | **Enumeração de e-mails liberados** (efeito colateral da correção V3). | Baixa | Descobrir quem trabalha na empresa. | Mensagem igual nos dois casos (verificada) |
| V5 | **Sem validação de formato e tamanho no servidor** (id, tamanho dos dados, quantidade de rotas). | Média | Base para V1; esgotar a cota gratuita do banco (500 MB). | Corrigida no banco |
| V6 | **Admin podia rebaixar a si mesmo** e deixar o app sem administrador. | Baixa | Indisponibilidade da gestão (recuperável por SQL). | Corrigida |
| V7 | **Sem registro de auditoria.** | Média | Sem rastreio de quem liberou acesso ou excluiu rotas. | Implementado |
| V8 | **Sem Content Security Policy.** | Média (camada extra) | Qualquer XSS futuro executaria livremente e poderia enviar dados para fora. | Implementada |
| V9 | **Foto de backup podia ser de qualquer tipo** (ex.: SVG). | Baixa | Conteúdo ativo vindo de backup adulterado. | Só JPEG/PNG/WebP |

## 3. Correções feitas

- **App** (`src/lib/sanitize.js`, `src/main.js`, `src/lib/sync.js`, `src/lib/backup.js`):
  - toda rota que entra (aparelho, nuvem, backup, aba Equipe) é higienizada: identificadores seguros, enums, horários `HH:MM`, números e datas válidos, textos com tamanho máximo;
  - todos os textos e atributos inseridos no HTML são escapados.
- **CSV** (`src/lib/delivery.js`): textos que começam com `= + - @` recebem um apóstrofo na frente; números como `-23.5` ficam como estão.
- **CSP** (`vite.config.js`):
  - scripts só do próprio app (mais o WebAssembly do OCR) e conexões só para os serviços usados;
  - pdf.js sem `eval` (`isEvalSupported: false`);
  - fotos de backup decodificadas localmente, sem `fetch`.
- **Banco** (`supabase/schema.sql`, seção "Reforços de segurança (v2)"):
  - checagens de formato e tamanho nas rotas;
  - `server_updated_at` gravado pelo servidor e limite de 5.000 rotas por pessoa;
  - gatilho em `auth.users` que só permite cadastro de e-mails liberados;
  - `audit_log` (só gatilhos escrevem, só o admin lê, ninguém apaga);
  - admin não muda o próprio papel e só aceita papéis válidos;
  - funções auxiliares fechadas para visitantes sem login;
  - bucket de fotos limitado a 5 MB, apenas JPEG/PNG/WebP.
- **Login**: mesma mensagem para e-mail liberado ou não ("Se este e-mail tiver acesso…").
- **Aba Equipe**: mostra o registro de atividades.

## 4. Controles e estado

Legenda: **IV** implementado e verificado · **INT** implementado, não testado ·
**PAR** parcial · **NI** não implementado · **NV** não verificável daqui.

### Autenticação e sessão

| Controle | Estado | Evidência / onde |
|---|---|---|
| Autenticação nativa do provedor, sem senhas próprias | IV | Supabase Auth com OTP (`src/lib/cloud.js`); login testado no Supabase real pelo usuário |
| Armazenamento de senhas | N/A | Não há senhas (login só por código no e-mail) |
| Cadastro só de e-mails liberados | IV (local) | Gatilho `only_allowed_signup`; `tests/rls.test.js`; PoC: "Conta criada para e-mail não liberado = false" |
| Proteção contra enumeração | IV | Mensagem idêntica nos dois casos (PoC) |
| Limite de tentativas de código (força bruta) | NV | Limites nativos do Supabase Auth (por IP e por e-mail); configuração em Authentication › Rate Limits |
| Validade curta do código | NV | Padrão do Supabase: 1 hora. **Recomendado: 600 s** (passo manual) |
| MFA para administradores | NI | TOTP do Supabase é gratuito; proposto como próxima etapa (seção 7) |
| Sessão revogada ao sair | INT | `signOut()` (escopo global por padrão no supabase-js); limpeza local testada |
| Acesso removido vale imediatamente | IV | RLS confere `is_member()` a cada requisição (teste "acesso removido…") |
| Token fora de URLs e logs | IV | Token só no armazenamento local e no cabeçalho `Authorization` |
| Token protegido contra XSS | PAR | Fica no `localStorage` (padrão do supabase-js). Protegido por CSP + higienização, mas um XSS não detectado ainda poderia lê-lo |
| CSRF | N/A | Autenticação por cabeçalho `Bearer`, sem cookies |

### Autorização e banco

| Controle | Estado | Evidência / onde |
|---|---|---|
| RLS ligada em todas as tabelas expostas | IV (local) | `routes`, `profiles`, `allowed_emails`, `audit_log`, `storage.objects` |
| Cada pessoa vê só os próprios dados (IDOR/BOLA) | IV | `tests/rls.test.js` + app real: "Beto lendo a API direto: rotas visíveis = 0" |
| Não grava em nome de outro / não altera dados alheios | IV | Testes "não grava rota em nome de outra pessoa…" |
| Ninguém se promove a admin | IV | Gatilho `profiles_guard` + teste |
| Admin não muda o próprio papel | IV | Teste "admin não altera o próprio papel" |
| Admin vê tudo, mas não altera dados alheios | IV | Testes de RLS (políticas de update/delete só do dono) |
| Funções `security definer` com `search_path` fixo e checagem de papel | IV | `claim_access`, `admin_*`, `audit*` |
| SQL injection | IV | Sem SQL dinâmico; PostgREST e RPC com parâmetros tipados |
| Atribuição em massa | IV | `user_id` conferido pela RLS; papel/ativo protegidos por gatilho |
| Validação de formato e tamanho no servidor | IV (local) | Testes "servidor recusa id malicioso e dados gigantes" |
| Exportações respeitam permissões | IV | CSV/PDF usam só dados que a RLS já liberou |
| Regras aplicadas no Supabase de produção | **NV** | Depende de rodar o `schema.sql` atualizado (passo manual) |

### App, dados e arquivos

| Controle | Estado | Evidência / onde |
|---|---|---|
| XSS (V1) | IV | PoC antes: script executou no admin; depois: `false` em lista, CSV e PDF |
| CSP | IV | Teste: script inline e `onerror` bloqueados; envio para domínio externo bloqueado; app funciona com CSP |
| CSV injection (V2) | IV | Teste unitário + PoC ("fórmula neutralizada = true") |
| Chave secreta fora do app | IV | App recusa `service_role`/`sb_secret_`; varredura do repositório e do histórico sem segredos |
| Chave publicável no app | IV (por design) | Pública por natureza; a proteção está na RLS |
| HTTPS | INT | GitHub Pages (`github.io`) e Supabase usam HTTPS |
| Criptografia em repouso (nuvem) | NV | Informada pelo Supabase para o disco; não verificável daqui |
| Dados no aparelho | PAR | `localStorage`/IndexedDB **sem criptografia do app**; dependem do bloqueio do aparelho (senha/biometria) |
| Fotos: bucket privado, pasta por pessoa | IV (local) | Teste de storage |
| Fotos: limite de tamanho e tipo | INT | Configuração do bucket (aplicada pelo servidor de Storage do Supabase; o PGlite não a executa) |
| Dependências | IV | `npm audit`: 0 vulnerabilidades (12/10/2026) |
| SSRF, webhooks, injeção de comandos | N/A | Não há backend próprio |

### Auditoria, disponibilidade e recuperação

| Controle | Estado | Evidência / onde |
|---|---|---|
| Registro de ações administrativas e exclusões | IV (local) | `audit_log` + aba Equipe; testes de leitura e de proteção contra escrita |
| Registro de logins | NV | Logs de Auth do painel do Supabase (retenção curta no plano gratuito) |
| Alertas em tempo real | NI | Não há detecção em tempo real |
| Rate limiting na API de dados (REST/Storage) | NI | Plano gratuito sem limite por usuário; mitigado por limites de tamanho e quantidade + remoção de acesso |
| Backup do banco de nuvem | **NI** | Plano gratuito do Supabase **sem backup baixável**. Existe só o backup por aparelho (Ajustes › Fazer backup) |
| Teste de restauração | IV (backup do aparelho) | Teste com dois aparelhos (restaura rotas, fotos e ajustes; não duplica) |

## 5. Passos manuais obrigatórios (Supabase)

1. **Rodar de novo o `supabase/schema.sql`** inteiro no SQL Editor (seguro: é idempotente).
   **Sem isso, os reforços do banco (V3, V5, V6, V7 e limites de fotos) não valem em produção.**
   A correção principal (V1) funciona mesmo assim, porque está no app.
2. **Authentication › Sign In / Providers › Email › Email OTP Expiration: `600`** (10 min).
3. **Authentication › Rate Limits**: conferir os limites de envio de e-mail e de verificação de código (os padrões são razoáveis).
4. Manter o **bloqueio de tela** (senha/biometria) nos aparelhos dos entregadores.

## 6. Riscos que continuam

- **Provas de entrega declaradas pelo aparelho**: horários, GPS e fotos vêm do aparelho e podem ser forjados por quem tiver conhecimento técnico. O `server_updated_at` e a auditoria de exclusões dão uma linha do tempo confiável, mas não autenticam o conteúdo.
- **Sessão no `localStorage`**: um XSS que escape da higienização e da CSP poderia lê-la.
- **Sem backup do banco de nuvem** no plano gratuito, nem MFA para o admin (ver seção 7).
- **Sem limite de requisições por pessoa** na API de dados. Um membro mal-intencionado poderia consumir a cota gratuita, dentro dos limites de 5.000 rotas, 2 MB por rota e 5 MB por foto. A ação é remover o acesso dele.
- **Projeto gratuito pausa após 7 dias sem uso** (indisponibilidade, não perda de dados).
- **LGPD**: o app trata dados pessoais de **clientes** (endereços, observações, fotos) e de **entregadores** (e-mail, localização no momento da entrega, km). Não há política de retenção automática nem termo de ciência para a equipe. Isto **não** é uma avaliação de conformidade legal.

## 7. Próximas etapas recomendadas

1. **MFA (TOTP) para administradores**: gratuito no Supabase. A RLS passaria a exigir o segundo fator para ações de admin.
2. **Backup automático e criptografado do banco**: GitHub Actions semanal (`pg_dump` cifrado com AES-256), guardado como artefato privado. Exige cadastrar a senha do banco como *secret* no GitHub.
3. **Retenção de dados**: apagar rotas e fotos com mais de N dias (ex.: 180), com aviso.
4. **CAPTCHA gratuito** (Cloudflare Turnstile) no pedido de código, se houver abuso.
5. **Termo de uso e privacidade** para os entregadores (dados coletados, finalidade e prazo).

## 8. Checklist de produção

- [x] Autenticação nativa e segura (OTP do Supabase; sem senhas próprias)
- [x] Hash de senhas: não aplicável (sem senhas)
- [ ] Limite de tentativas: nativo do Supabase, **conferir no painel** (passo 5.3)
- [x] Recuperação de senha: não aplicável
- [x] Sessões e tokens: escopo, revogação e expiração do provedor; parcial quanto a XSS (ver riscos)
- [x] Papéis e permissões documentados (seção 1)
- [x] Operações administrativas protegidas no banco (RLS e funções)
- [x] Todas as tabelas e o bucket auditados
- [ ] RLS e reforços **aplicados em produção** (passo 5.1)
- [x] Isolamento entre pessoas verificado (localmente, com o schema real)
- [x] Nenhuma chave secreta no app
- [x] Validação de entradas e escape na interface
- [x] Exportações protegidas (CSV injection)
- [x] Dependências sem vulnerabilidades conhecidas
- [x] Logs sem segredos (auditoria guarda só e-mail, ação e alvo)
- [ ] Backup do banco de nuvem (**pendente**, seção 7.2)
- [ ] MFA para administradores (**pendente**, seção 7.1)
- [x] Riscos que continuam e limitações do plano gratuito documentados

**Conclusão:** depois do passo 5.1, o sistema fica adequado para uso pela equipe, com os riscos que
continuam (seção 6) aceitos conscientemente. Para tratar o app como "produção segura" completa,
faltam **backup da nuvem** e **MFA do administrador** (seção 7).

## 8.1 Verificação em produção (12/10/2026, conector Supabase, somente leitura)

- **Schema v2 aplicado:** RLS ligada nas 4 tabelas; checagens `routes_id_format`, `routes_data_size` e `routes_name_len`; os gatilhos `only_allowed_signup`, `routes_before_write`, `audit_*` e `profiles_guard`; `server_updated_at`; bucket `photos` privado, com 5 MB e só JPEG/PNG/WebP; `anon` sem execução de `is_admin`.
- **Auditoria funcionando:** registrou a primeira exclusão real de rota, feita pelo próprio administrador.
- **Sincronização funcionando:** gravações com resposta 200/201 nos registros da API.
- **Security Advisor do Supabase:**
  - `function_search_path_mutable` (`profiles_guard`): **corrigido** no schema;
  - funções de **gatilho** executáveis por `anon`/`authenticated` via `/rpc`: **corrigido** (acesso fechado; os gatilhos continuam ativos, conforme os testes);
  - `admin_*`, `claim_access`, `is_admin` e `is_member` executáveis por usuários logados: **aceito**, porque são a API do app e cada uma confere o papel internamente;
  - "Leaked password protection": **não se aplica** (o app não usa senhas).

## 9. Manutenção

- **Mensal:** `npm audit` (o CI roda os testes a cada mudança) e revisão do registro de atividades na aba Equipe.
- **A cada mudança no banco:** manter o `schema.sql` idempotente e atualizar `tests/rls.test.js`.
- **A cada tela nova:** dados de fora passam por `sanitizeRoute` e todo texto inserido em HTML usa `esc()`.
- **Trimestral:** revisar a lista de acesso (remover quem saiu) e testar a restauração de um backup.
