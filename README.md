# BarberPro

Sistema full stack para barbearias com agenda inteligente, area do cliente, painel do barbeiro, administracao, estoque, custos, relatorios, promocoes, fidelidade, lembretes por WhatsApp e permissoes por perfil.

## Stack

- Frontend: React + Vite + CSS responsivo + Recharts + Lucide Icons.
- Backend: Node.js + Express.
- Persistencia local: arquivo JSON em `data/barberpro.json`, criado automaticamente no primeiro uso.
- Banco principal local/producao: MySQL/MariaDB, compativel com XAMPP.
- Schema PostgreSQL de referencia em `database/schema.postgres.sql`.
- Exportacao: CSV compativel com Excel e PDF.

## Como rodar

1. Instale as dependencias:

```bash
npm install
```

No PowerShell deste ambiente, se `npm` estiver bloqueado por politica de scripts, use:

```bash
npm.cmd install
```

2. Copie o arquivo de ambiente:

```bash
copy .env.example .env
```

3. Rode backend e frontend:

```bash
npm run dev
```

4. Abra:

```text
http://localhost:5173
```

API:

```text
http://localhost:3333/api/health
```

## Acessos de demonstracao local

Use estes acessos apenas em desenvolvimento. Antes de publicar o sistema, remova ou troque todos os usuarios de demonstracao e configure um `JWT_SECRET` forte.

Todos usam a senha `123456`.

| Perfil | E-mail |
| --- | --- |
| Administrador geral | `admin@barberpro.com` |
| Dono | `dono@barberpro.com` |
| Atendente | `atendente@barberpro.com` |
| Barbeiro | `barbeiro@barberpro.com` |
| Cliente | `cliente@barberpro.com` |

Os dados demonstrativos locais recebem datas relativas ao dia em que o servidor sobe. Se `data/barberpro.json` ou o estado MySQL ainda forem o seed original e ficarem antigos, o servidor renova a demo automaticamente. Em desenvolvimento, administradores e donos tambem podem usar **Configuracoes > Restaurar demo** ou `POST /api/demo/reset` com `{"confirm":"RESTAURAR DEMO"}` para recriar a base atual. A renovacao automatica pode ser desligada com `DEMO_AUTO_RENEW=false`.

## Funcionalidades

- Cadastro e login de cliente com senha criptografada.
- Agenda diaria, semanal e mensal com filtros por barbeiro, servico, data e status.
- Bloqueio de horarios ocupados e prevencao de conflitos no backend.
- Encaixe autorizado para perfis administrativos.
- Reagendamento, cancelamento e mudanca de status do atendimento.
- Painel do barbeiro com agenda do dia, metas, avaliacoes e bloqueios.
- Dashboard administrativo com clientes, barbeiros, servicos, produtos, promocoes e logs.
- Servicos com preco, duracao, icone e barbeiros habilitados.
- Receita estimada por atendimentos finalizados, sem modulo de cobranca.
- Controle de custos e despesas operacionais.
- Estoque com produto, categoria, quantidade, compra, venda, minimo e movimentacoes.
- Alertas de estoque baixo.
- Relatorios com faturamento estimado, ticket medio, cancelamento, nao comparecimento, servicos vendidos, barbeiros, clientes e horarios movimentados.
- Exportacao em PDF e CSV/Excel.
- Promocoes, combos, cupons e programa de fidelidade.
- Lembretes e mensagens operacionais por WhatsApp.
- QR Code para avaliacao.
- Backup do banco local em JSON.
- Modo escuro/claro.
- Suporte a multiplas unidades no modelo de dados.

## Estrutura

```text
.
|-- database/
|   |-- schema.mysql.sql
|   |-- schema.postgres.sql
|   `-- xampp-barberpro.sql
|-- server/
|   |-- adapters/
|   |-- services/
|   |-- validators/
|   |-- index.js
|   `-- store.js
|-- src/
|   |-- App.jsx
|   |-- main.jsx
|   `-- styles.css
|-- docker-compose.yml
|-- index.html
|-- package.json
`-- README.md
```

## Banco de dados

O projeto pode rodar com MySQL/MariaDB do XAMPP. O `.env` local ja esta configurado para:

```text
DB_DRIVER=mysql
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=root
DB_PASSWORD=
DB_NAME=barberpro
DB_CONNECT_TIMEOUT_MS=2000
DB_FALLBACK_TO_JSON=readonly
```

Com o MySQL do XAMPP ligado, o servidor cria automaticamente o banco `barberpro` e a tabela `app_state` no primeiro start. O arquivo `database/schema.mysql.sql` cria a estrutura relacional para agenda, clientes, custos, estoque, notificacoes e auditoria. Para criar manualmente pelo phpMyAdmin, importe:

```text
database/xampp-barberpro.sql
```

Ou rode no terminal:

```bash
C:\xampp\mysql\bin\mysql.exe -u root < database\xampp-barberpro.sql
```

Se o MySQL estiver desligado e `DB_FALLBACK_TO_JSON=readonly`, o sistema carrega `data/barberpro.json` apenas como snapshot de leitura. Escritas ficam bloqueadas com resposta `503` para impedir divergencia entre o MySQL e o JSON local. Depois de religar o MySQL do XAMPP, use `/api/health` ou o aviso da interface para confirmar que a persistencia voltou a ficar gravavel.

Tabelas principais:

- `units`: filiais/unidades da barbearia.
- `users`: login e permissoes dos perfis administrador, dono, barbeiro, atendente e cliente.
- `clients`: dados comerciais do cliente, historico, aniversario, pontos e observacoes.
- `barbers`: dados dos barbeiros, metas, avaliacao, comissao operacional e especialidades.
- `barber_units`: relacao entre barbeiros e unidades.
- `services`: servicos, descricao, preco, duracao, icone e status.
- `service_barbers`: barbeiros habilitados para cada servico.
- `barber_time_blocks`: horarios bloqueados por barbeiros ou administradores.
- `appointments`: agenda com cliente, barbeiro, servico, unidade, data, horario e status.
- `commissions`: comissao operacional calculada por atendimento finalizado.
- `reviews`: avaliacoes dos clientes.
- `products`: cadastro e saldo de produtos.
- `stock_movements`: historico de compras, vendas, uso interno, perdas e ajustes.
- `expenses`: despesas para apuracao de resultado.
- `promotions`: promocoes e combos.
- `coupons`: cupons individuais, aniversario e fidelidade.
- `loyalty_rewards`: recompensas do programa de fidelidade.
- `referrals`: indicacoes feitas por clientes.
- `waitlist`: lista de espera.
- `notifications`: fila de mensagens automaticas por WhatsApp e sistema.
- `barbershop_settings`: horarios, feriados, seguranca e integracoes em JSON.
- `audit_logs`: logs de acoes importantes.

Relacionamentos relevantes:

- `appointments` referencia `clients`, `barbers`, `services` e `units`.
- `commissions` e `reviews` referenciam `appointments`.
- `service_barbers` resolve o relacionamento N:N entre servicos e barbeiros.
- `barber_units` resolve o relacionamento N:N entre barbeiros e unidades.
- `stock_movements` referencia `products` e opcionalmente `users`.
- `coupons` referencia `clients` e opcionalmente `promotions`.

Observacao de compatibilidade: schemas antigos ainda podem conter tabela/colunas de cobranca. O produto atual nao cria cobrancas, nao exibe cobrancas e nao calcula relatorios a partir de cobrancas.

## Docker PostgreSQL

Para subir um PostgreSQL local com o schema de referencia:

```bash
docker compose up -d
```

Banco:

```text
host: localhost
port: 5432
database: barberpro
user: barberpro
password: barberpro_dev
```

## Seguranca implementada

- Hash de senha com `bcryptjs`.
- JWT com expiracao de 8 horas.
- Middleware de autenticacao e autorizacao por perfil.
- Validacao de dados obrigatorios nas principais rotas.
- Prevencao de conflito de agenda no backend.
- Logs de auditoria para login, cadastro, agendamento, cancelamento, estoque, configuracoes e backup.
- Consultas MySQL parametrizadas nos fluxos transacionais.

Para producao, altere `JWT_SECRET`, configure HTTPS, mantenha sessao via cookie HttpOnly, registre consentimento LGPD, configure backup externo e integre WhatsApp Business Cloud API ou provedor equivalente para envio real das mensagens.

## Melhorias futuras

- WhatsApp Business Cloud API com webhooks e status de entrega.
- Templates aprovados para lembrete, confirmacao, remarcacao e recuperacao de acesso.
- Prisma ou Knex para consolidar as migracoes relacionais.
- Testes automatizados de componentes.
- Controle de caixa por turno sem cobranca integrada.
- Aplicativo PWA com notificacoes push.
- Importacao/exportacao avancada em XLSX.
- Tela de comandas e venda balcao sem cobranca online.
- Assinaturas ou planos mensais para clientes recorrentes, caso a regra de negocio volte a exigir cobranca integrada.
