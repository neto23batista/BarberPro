# BarberPro - hardening e deploy de producao

Data: 2026-05-17

## Bloco 1 - correcoes criticas aplicadas

[SEVERIDADE: CRITICA]
[BLOQUEIA PRODUCAO: SIM]
Arquivo: `server/index.js` | rota `GET /api/backup`
Problema: o backup retornava o estado completo, incluindo `passwordHash`.
Impacto real: vazamento de credenciais de todos os usuarios em um arquivo administrativo.
Correcao: `GET /api/backup` agora chama `sanitizeBackupData(data)` antes de serializar; campos como `passwordHash`, `passwordResetToken`, `sessionToken`, `jwtSecret`, `apiKey` e `secret` sao removidos recursivamente. Codigo completo em `server/services/sanitizers.js`.

[SEVERIDADE: CRITICA]
[BLOQUEIA PRODUCAO: SIM]
Arquivo: `server/index.js` | bootstrap
Problema: havia fallback para segredo JWT de desenvolvimento.
Impacto real: qualquer token assinado com segredo conhecido poderia acessar a API.
Correcao: `JWT_SECRET` agora e obrigatorio; em `NODE_ENV=production` precisa ter pelo menos 48 caracteres e nao pode conter placeholders. `CORS_ORIGIN` tambem e obrigatorio em producao.

[SEVERIDADE: ALTA]
[BLOQUEIA PRODUCAO: SIM]
Arquivo: `server/index.js` | auth/rate limit
Problema: rate limit era parcial.
Impacto real: criacao automatizada de contas e abuso de endpoints caros.
Correcao: `app.use('/api/auth', authLimiter)` cobre todos os endpoints de auth; `heavyReadLimiter` foi aplicado em `/api/dashboard`, `/api/reports/summary` e `/api/reports/export`.

[SEVERIDADE: CRITICA]
[BLOQUEIA PRODUCAO: SIM]
Arquivo: `server/index.js` | `POST /api/appointments`
Problema: a janela de corrida ocorre quando duas requisicoes fazem `readData()`, validam o mesmo slot, e so depois entram na fila de escrita.
Impacto real: dois clientes podem pagar/reservar o mesmo barbeiro no mesmo horario.
Correcao: a validacao e o `data.appointments.push()` ficam dentro do mesmo `mutateData()`, que usa `runSerialized()`. Para MySQL real, o adapter `server/adapters/mysqlAppointments.js` implementa transacao + `SELECT ... FOR UPDATE` antes do insert.

Exemplo do bug antigo:
1. Req A le agenda 10:00 livre.
2. Req B le agenda 10:00 livre antes de A gravar.
3. A grava 10:00.
4. B grava 10:00.

Fluxo corrigido:
1. Req A entra em `mutateData()`, valida e grava.
2. Req B so entra depois; valida contra o estado ja atualizado e recebe 409.

[SEVERIDADE: ALTA]
[BLOQUEIA PRODUCAO: SIM]
Arquivo: `.env.production.example`
Problema: variaveis criticas de producao nao estavam documentadas.
Impacto real: deploy inseguro por segredo fraco, CORS aberto, DB fallback e backup ausente.
Correcao: criado `.env.production.example` com JWT forte, cookies, CORS, MySQL, backup, health, cache, logs e demo reset desligado.

## Bloco 2 - refatoracao inicial implementada

Estrutura adicionada:

```txt
server/
  adapters/mysqlAppointments.js
  middleware/auth.js
  routes/appointments.js
  services/alerts.js
  services/automaticBackup.js
  services/health.js
  services/logger.js
  services/reportCache.js
  services/sanitizers.js
  services/scheduler.js
  validators/appointment.js

src/
  context/AuthContext.jsx
  context/DashboardContext.jsx
  hooks/useAuth.js
  hooks/useDashboard.js
  hooks/useToast.js
  pages/BookingPage.jsx
  services/api.js
```

O monolito ainda permanece operavel. A migracao total de `server/index.js` e `src/App.jsx` deve ser feita por rotas/paginas, uma de cada vez, usando estes modulos como alvo.

## Bloco 3 - persistencia real

Arquivos:
- SQL relacional existente: `database/schema.mysql.sql`
- Migracao incremental para isolamento multiempresa: `database/migrations/003_add_tenant_isolation.mysql.sql`
- Migracao JSON -> MySQL: `scripts/migrate-json-to-mysql.js`
- Adapters criticos: `server/adapters/mysqlAppointments.js`

Comandos:

```bash
npm run db:migrate:mysql
```

Para bancos relacionais existentes, rode antes:

```bash
mysql -u "$DB_USER" -p"$DB_PASSWORD" "$DB_NAME" < database/migrations/003_add_tenant_isolation.mysql.sql
```

O store JSON agora normaliza `tenantId` automaticamente e a API escopa dashboard, agenda, clientes, servicos, produtos, promocoes, relatorios e backup pelo tenant do usuario autenticado.

Criacao de novas barbearias para SaaS:

```http
POST /api/tenants
Authorization: Bearer <token-admin>
Content-Type: application/json

{
  "name": "Barbearia Mercado",
  "slug": "barbearia-mercado",
  "ownerName": "Dono Mercado",
  "ownerEmail": "dono@barbeariamercado.com",
  "ownerPhone": "5511999999999",
  "ownerPassword": "SenhaForte123!"
}
```

Operacoes criticas cobertas no adapter:
- `createAppointment(pool, appointment)`: transacao, locks e conflito atomico.
- `listDaySchedule(pool, date, barberId)`: agenda do dia indexada.
- `monthlyReport(pool, month)`: KPIs mensais por SQL.

Cache de relatorios:
- Arquivo: `server/services/reportCache.js`
- TTL: `REPORT_CACHE_TTL_MS`, padrao 60s.
- Invalidacao: criacao, status, remarcacao e cancelamento de agendamento; servicos/produtos/movimentos tambem invalidam.

Backup automatico:
- Arquivo: `server/services/automaticBackup.js`
- Intervalo padrao: 6h.
- Retencao: 7 backups.
- MySQL: usa `mysqldump`.
- JSON: exporta backup sanitizado.
- Falha: registra audit log e chama stub de notificacao.

## Bloco 4 - seguranca

Sanitizacao:
- `sanitizeUser()` agora remove `passwordHash`, reset tokens e session tokens.
- `GET /api/backup` usa sanitizacao profunda.
- Retornos de auth usam `sanitizeUser`.
- Dashboard usa `req.authUser` sanitizado e nao retorna `data.users`.

Validacao:
- Preco de servico limitado por `MAX_SERVICE_PRICE`.
- Produto e estoque limitados por `MAX_STOCK_QUANTITY` e `MAX_PRODUCT_PRICE`.
- `notes` e `internalNotes` de agendamento rejeitam mais de 500 caracteres.
- Data de agendamento precisa estar entre hoje e `MAX_APPOINTMENT_DAYS_AHEAD` dias.
- Reset demo exige `DEMO_RESET_ENABLED=true` e header `X-Demo-Reset-Key`; em producao segue bloqueado.

Headers:
- Helmet com HSTS preload em producao.
- CSP sem `unsafe-inline` em producao.
- `Referrer-Policy: no-referrer`.
- `X-Content-Type-Options: nosniff`.

## Bloco 5 - deploy

Arquivos:
- `Dockerfile`
- `docker-compose.yml`
- `nginx/default.conf`
- `.env.production.example`

### Railway

1. Criar projeto a partir do repo.
2. Criar servico Node com build `npm ci && npm run build` e start `npm start`.
3. Adicionar MySQL no Railway ou conectar MySQL externo.
4. Configurar variaveis de `.env.production.example`.
5. Setar `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`.
6. Rodar `npm run db:migrate:mysql` no ambiente com acesso ao banco.
7. Verificar `/api/health` retornando 200.
8. Criar dominio customizado e atualizar `CORS_ORIGIN` e `VITE_PUBLIC_APP_URL`.

### VPS Ubuntu

```bash
sudo apt update
sudo apt install -y nginx mysql-server certbot python3-certbot-nginx
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
sudo npm install -g pm2
```

Banco:

```sql
CREATE DATABASE barberpro CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'barberpro_app'@'localhost' IDENTIFIED BY 'SENHA_FORTE';
GRANT ALL PRIVILEGES ON barberpro.* TO 'barberpro_app'@'localhost';
FLUSH PRIVILEGES;
```

Deploy:

```bash
git pull
npm ci
npm run build
npm run db:migrate:mysql
pm2 start server/index.js --name barberpro
pm2 save
pm2 startup
```

Nginx:

```nginx
server {
  server_name app.seudominio.com.br;
  location / {
    proxy_pass http://127.0.0.1:3333;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto https;
  }
}
```

SSL:

```bash
sudo certbot --nginx -d app.seudominio.com.br
```

Script de deploy:

```bash
#!/usr/bin/env bash
set -euo pipefail
cd /var/www/barberpro
git pull --ff-only
npm ci
npm run build
npm run db:migrate:mysql
pm2 reload barberpro
curl -fsS https://app.seudominio.com.br/api/health
```

## Variaveis obrigatorias

Valide antes do deploy:

```bash
npm run check:prod-env
```

| Nome | Obrigatoria | Exemplo seguro | Como gerar |
| --- | --- | --- | --- |
| `NODE_ENV` | sim | `production` | fixo |
| `JWT_SECRET` | sim | 64 bytes base64url | `node -e "console.log(require('crypto').randomBytes(64).toString('base64url'))"` |
| `SESSION_COOKIE` | sim | `barberpro_session` | fixo |
| `CORS_ORIGIN` | sim | `https://app.seudominio.com.br` | dominio final |
| `VITE_PUBLIC_APP_URL` | sim | `https://app.seudominio.com.br` | dominio final |
| `DB_DRIVER` | sim | `mysql` | fixo |
| `DB_HOST` | sim | `db` ou `127.0.0.1` | host do banco |
| `DB_PORT` | sim | `3306` | porta do banco |
| `DB_USER` | sim | `barberpro_app` | usuario MySQL |
| `DB_PASSWORD` | sim | senha forte | password manager |
| `DB_NAME` | sim | `barberpro` | fixo |
| `DB_FALLBACK_TO_JSON` | sim | `false` | fixo em producao |
| `AUTO_BACKUP_ENABLED` | sim | `true` | fixo |
| `BACKUP_DIR` | sim | `/app/backups` | volume persistente |
| `LOG_LEVEL` | nao | `info` | fixo |
| `DEMO_RESET_ENABLED` | sim | `false` | fixo em producao |

## Checklist go-live

Seguranca obrigatoria:
- `JWT_SECRET` forte e sem placeholder.
- `CORS_ORIGIN` HTTPS final.
- `FIRST_ADMIN_EMAIL` e `FIRST_ADMIN_PASSWORD` definidos para seed inicial de producao sem usuarios demo.
- Depois do primeiro acesso real, remova `FIRST_ADMIN_PASSWORD` e defina `PRODUCTION_BOOTSTRAP_DONE=true`.
- `DEFAULT_TENANT_ID` e `DEFAULT_TENANT_NAME` definidos.
- `DEMO_RESET_ENABLED=false`.
- `/api/backup` validado sem `passwordHash`.
- Helmet ativo em `NODE_ENV=production`.

Banco:
- MySQL 8/MariaDB com usuario sem root.
- `npm run db:migrate:mysql` executado.
- Backup automatico gerando arquivo.
- Restore testado em banco limpo.

Servidor:
- PM2 ou Docker com restart policy.
- `/api/health` 200.
- Logs JSON coletados.
- Disco com alerta.

Dominio e SSL:
- DNS apontado.
- TLS valido.
- HSTS habilitado.

Monitoramento:
- Health externo a cada 1 min.
- Alertas de erro critico conectados.
- Retencao de logs definida.

Primeiro admin:
- Trocar senha seed.
- Criar dono real.
- Desativar usuarios demo.
- Conferir unidades, barbeiros, servicos e horarios.

## Bloco 6 - monitoramento

Implementado:
- `server/services/logger.js`: Pino JSON com `timestamp`, `level`, `requestId`, `userId`, `route`, `statusCode`, `responseTimeMs`.
- `server/services/health.js`: banco, disco, memoria e ultima escrita.
- `server/services/alerts.js`: captura `uncaughtException` e `unhandledRejection`.

## Bloco 7 - testes

Arquivos:
- `tests/unit/business.test.js`
- `tests/integration/routes.test.js`

Comando:

```bash
npm test
```

Cobertura minima:
- `validateSchedule`
- `calculateReports`
- `reconcileOperationalData`
- `sanitizeUser`
- `overlaps`
- Login valido/invalido/rate-limit
- Criacao de agendamento, conflito, sem auth
- Mudanca de status valida/invalida

## Bloco 8 - diferenciais pos-lancamento

| Item | Esforco | Impacto | Arquitetura |
| --- | ---: | ---: | --- |
| Link publico por barbeiro `/agendar/:slug` | 12-18h | 9/10 | tabela `barber_public_links`, rota publica, slots por barbeiro, criacao sem login |
| WhatsApp SIM/NAO 2h antes | 10-16h | 8/10 | job de lembretes, provider `notifications`, webhook de resposta |
| Planos mensais | 32-48h | 9/10 | tabelas `subscriptions`, `subscription_credits`, gateway Stripe/Mercado Pago |
| Score de churn | 8-12h | 7/10 | batch diario calculando dias desde ultima visita, frequencia e no-shows |
| Fechamento de caixa diario | 18-28h | 8/10 | tabela `cash_closings`, resumo de pagamentos, despesas, comissoes e impressao |

## Ordem de execucao

1. Segredo JWT/CORS/env production - 1h.
2. Backup sanitizado - 1h.
3. Rate limit auth/dashboard - 1h.
4. Atomicidade de agendamento - 2h JSON, 6h MySQL.
5. Validacoes de preco, estoque, notas e datas - 3h.
6. Health/logs/alertas - 4h.
7. Backup automatico - 4h.
8. Migracao MySQL e adapter - 12h.
9. Docker/Nginx/env - 6h.
10. Testes minimos - 8h.
11. Refatoracao completa de rotas - 20-32h.
12. Refatoracao completa do App.jsx - 32-48h.
13. Diferenciais comerciais - 80-120h.

## Cronograma

Fase 1 - bloqueios criticos, maximo 3 dias:
- Itens 1 a 7 da ordem.
- Deploy staging com MySQL.
- Restore de backup testado.

Fase 2 - producao segura, primeira semana:
- Docker/VPS ou Railway final.
- Testes de integracao no CI.
- Logs externos e alerta real.
- Migracao gradual de rotas para `server/routes`.

Fase 3 - produto completo, 30 dias:
- Refatoracao do frontend.
- MySQL relacional como store principal.
- Fechamento de caixa.
- WhatsApp.
- Autoagendamento publico.

## Pontuacao

| Area | Atual antes | Apos fase 1 | Apos fase 2 | Apos fase 3 |
| --- | ---: | ---: | ---: | ---: |
| Seguranca | 4/10 | 8/10 | 9/10 | 9/10 |
| Arquitetura | 3/10 | 5/10 | 7/10 | 8/10 |
| Performance | 4/10 | 6/10 | 7/10 | 8/10 |
| Producao | 3/10 | 7/10 | 8/10 | 9/10 |
| Testes | 0/10 | 5/10 | 7/10 | 8/10 |

## Custo mensal estimado

Estimativas para app Node + banco + backups pequenos. Valores variam por trafego e armazenamento.

| Escala | Railway | Render | VPS |
| --- | ---: | ---: | ---: |
| Ate 10 barbearias | US$20-35 | US$51-70 | US$24-40 |
| Ate 50 barbearias | US$35-70 | US$100-140 | US$48-80 |
| Ate 200 barbearias | US$90-160 | US$225-350 | US$96-180 |

Observacoes:
- Railway cobra assinatura + uso de CPU/RAM/storage/egress.
- Render e simples, mas este projeto usa MySQL; Render gerencia Postgres, entao MySQL exige container proprio ou banco externo.
- VPS e mais barato, mas exige operacao: backup, patch, firewall, restore e monitoramento.
