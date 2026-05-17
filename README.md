# BarberPro

Sistema full stack para barbearias com agenda inteligente, área do cliente, painel do barbeiro, administração, pagamentos, estoque, relatórios, promoções, fidelidade, notificações e permissões por perfil.

## Stack

- Frontend: React + Vite + CSS responsivo + Recharts + Lucide Icons.
- Backend: Node.js + Express.
- Persistência local: arquivo JSON em `data/barberpro.json`, criado automaticamente no primeiro uso.
- Banco para produção: PostgreSQL, com schema em `database/schema.postgres.sql`.
- Exportação: CSV compatível com Excel e PDF.

## Como rodar

1. Instale as dependências:

```bash
npm install
```

No PowerShell deste ambiente, se `npm` estiver bloqueado por política de scripts, use:

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

## Acessos de demonstração local

Use estes acessos apenas em desenvolvimento. Antes de publicar o sistema, remova ou troque todos os usuários de demonstração e configure um `JWT_SECRET` forte.

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
- Agenda diária, semanal e mensal com filtros por barbeiro, serviço, data e status.
- Bloqueio de horários ocupados e prevenção de conflitos.
- Encaixe autorizado para perfis administrativos.
- Reagendamento, cancelamento e mudança de status do atendimento.
- Painel do barbeiro com agenda do dia, comissões, metas, avaliações e bloqueios.
- Dashboard administrativo com clientes, barbeiros, serviços, produtos, promoções e logs.
- Serviços com preço, duração, ícone e barbeiros habilitados.
- Pagamentos por dinheiro, cartão, Pix e online.
- Controle financeiro com status, comissão e relatórios.
- Estoque com produto, categoria, quantidade, compra, venda, mínimo e movimentações.
- Alertas de estoque baixo.
- Relatórios com faturamento, ticket médio, cancelamento, não comparecimento, serviços vendidos, barbeiros, clientes e horários movimentados.
- Exportação em PDF e CSV/Excel.
- Promoções, combos, cupons e programa de fidelidade.
- Notificações simuladas para WhatsApp, e-mail, SMS e sistema.
- QR Code para avaliação.
- Backup do banco local em JSON.
- Modo escuro/claro.
- Suporte a múltiplas unidades no modelo de dados.

## Estrutura

```text
.
├── database/
│   └── schema.postgres.sql
├── server/
│   ├── index.js
│   └── store.js
├── src/
│   ├── App.jsx
│   ├── main.jsx
│   └── styles.css
├── docker-compose.yml
├── index.html
├── package.json
└── README.md
```

## Banco de dados

O projeto agora pode rodar com MySQL/MariaDB do XAMPP. O `.env` local já está configurado para:

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

Com o MySQL do XAMPP ligado, o servidor cria automaticamente o banco `barberpro` e a tabela `app_state` no primeiro start. O arquivo `database/schema.mysql.sql` também cria a estrutura relacional alvo para a próxima etapa de migração, com tabelas reais para agenda, clientes, pagamentos, estoque e auditoria. Para criar manualmente pelo phpMyAdmin, importe:

```text
database/xampp-barberpro.sql
```

Ou rode no terminal:

```bash
C:\xampp\mysql\bin\mysql.exe -u root < database\xampp-barberpro.sql
```

Se o MySQL estiver desligado e `DB_FALLBACK_TO_JSON=readonly`, o sistema carrega `data/barberpro.json` apenas como snapshot de leitura. Escritas ficam bloqueadas com resposta `503` para impedir divergencia entre o MySQL e o JSON local. Depois de religar o MySQL do XAMPP, use `/api/health` ou o aviso da interface para confirmar que a persistencia voltou a ficar gravavel.

O projeto também mantém um schema PostgreSQL de referência em `database/schema.postgres.sql`.

Tabelas principais:

- `units`: filiais/unidades da barbearia.
- `users`: login e permissões dos perfis administrador, dono, barbeiro, atendente e cliente.
- `clients`: dados comerciais do cliente, histórico, aniversário, pontos e observações.
- `barbers`: dados dos barbeiros, comissão, metas, avaliação e especialidades.
- `barber_units`: relação entre barbeiros e unidades.
- `services`: serviços, descrição, preço, duração, ícone e status.
- `service_barbers`: barbeiros habilitados para cada serviço.
- `barber_time_blocks`: horários bloqueados por barbeiros ou administradores.
- `appointments`: agenda com cliente, barbeiro, serviço, unidade, data, horário, status e pagamento.
- `payments`: registros financeiros dos atendimentos.
- `commissions`: comissão calculada por atendimento finalizado.
- `reviews`: avaliações dos clientes.
- `products`: cadastro e saldo de produtos.
- `stock_movements`: histórico de compras, vendas, uso interno, perdas e ajustes.
- `expenses`: despesas para apuração de lucro.
- `promotions`: promoções e combos.
- `coupons`: cupons individuais, aniversário e fidelidade.
- `loyalty_rewards`: recompensas do programa de fidelidade.
- `referrals`: indicações feitas por clientes.
- `waitlist`: lista de espera.
- `notifications`: fila de mensagens automáticas.
- `barbershop_settings`: horários, feriados, segurança e integrações em JSONB.
- `audit_logs`: logs de ações importantes.

Relacionamentos relevantes:

- `appointments` referencia `clients`, `barbers`, `services` e `units`.
- `payments`, `commissions` e `reviews` referenciam `appointments`.
- `service_barbers` resolve o relacionamento N:N entre serviços e barbeiros.
- `barber_units` resolve o relacionamento N:N entre barbeiros e unidades.
- `stock_movements` referencia `products` e opcionalmente `users`.
- `coupons` referencia `clients` e opcionalmente `promotions`.

## Docker PostgreSQL

Para subir um PostgreSQL local com o schema:

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

## Segurança implementada

- Hash de senha com `bcryptjs`.
- JWT com expiração de 8 horas.
- Middleware de autenticação e autorização por perfil.
- Validação de dados obrigatórios nas principais rotas.
- Prevenção de conflito de agenda no backend.
- Logs de auditoria para login, cadastro, agendamento, cancelamento, estoque, configurações e backup.
- Schema PostgreSQL preparado para consultas parametrizadas e restrições de integridade.

Para produção, altere `JWT_SECRET`, configure HTTPS, mantenha sessão via cookie HttpOnly, registre consentimento LGPD, configure backup externo e integre gateways reais de pagamento/mensageria.

## Melhorias futuras

- Integração real com Mercado Pago, Stripe ou Pagar.me.
- WhatsApp Business Cloud API com webhooks.
- Envio real por e-mail/SMS.
- Prisma ou Knex para usar o PostgreSQL diretamente pela aplicação.
- Testes automatizados de API e componentes.
- Controle de caixa por turno.
- Aplicativo PWA com notificações push.
- Importação/exportação avançada em XLSX.
- Tela de comandas e venda balcão.
- Assinaturas ou planos mensais para clientes recorrentes.
