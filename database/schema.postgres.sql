CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE user_role AS ENUM ('admin', 'owner', 'barber', 'attendant', 'client');
CREATE TYPE user_status AS ENUM ('active', 'inactive', 'blocked');
CREATE TYPE appointment_status AS ENUM ('scheduled', 'confirmed', 'in_service', 'finished', 'cancelled', 'no_show');
CREATE TYPE payment_method AS ENUM ('cash', 'card', 'pix', 'online');
CREATE TYPE payment_status AS ENUM ('pending', 'paid', 'cancelled', 'refunded');
CREATE TYPE stock_movement_type AS ENUM ('purchase', 'sale', 'usage', 'loss', 'adjustment');
CREATE TYPE commission_status AS ENUM ('pending', 'available', 'paid', 'cancelled');
CREATE TYPE notification_channel AS ENUM ('whatsapp', 'email', 'sms', 'system');

-- Unidades/filiais da barbearia. Permite agenda e estoque por unidade.
CREATE TABLE units (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(140) NOT NULL,
  phone VARCHAR(32),
  whatsapp VARCHAR(32),
  email VARCHAR(160),
  address TEXT,
  status user_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Usuários de todos os perfis. Senhas devem ser gravadas com hash forte, nunca em texto puro.
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
  role user_role NOT NULL,
  name VARCHAR(140) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  phone VARCHAR(32),
  password_hash TEXT NOT NULL,
  status user_status NOT NULL DEFAULT 'active',
  avatar_url TEXT,
  birth_date DATE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Perfil comercial do cliente, separado de users para permitir clientes sem acesso ao portal.
CREATE TABLE clients (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  preferred_barber_id UUID,
  name VARCHAR(140) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  email VARCHAR(180),
  birth_date DATE,
  loyalty_points INTEGER NOT NULL DEFAULT 0,
  visits INTEGER NOT NULL DEFAULT 0,
  no_shows INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  tags TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Perfil do barbeiro, metas, comissão e agenda individual.
CREATE TABLE barbers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID UNIQUE REFERENCES users(id) ON DELETE SET NULL,
  name VARCHAR(140) NOT NULL,
  phone VARCHAR(32),
  email VARCHAR(180),
  bio TEXT,
  specialties TEXT[] NOT NULL DEFAULT '{}',
  commission_rate NUMERIC(5,4) NOT NULL DEFAULT 0.4000,
  rating NUMERIC(3,2) NOT NULL DEFAULT 5.00,
  goal_monthly NUMERIC(12,2) NOT NULL DEFAULT 0,
  status user_status NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE clients
  ADD CONSTRAINT fk_clients_preferred_barber
  FOREIGN KEY (preferred_barber_id) REFERENCES barbers(id) ON DELETE SET NULL;

-- Relação N:N entre barbeiros e filiais.
CREATE TABLE barber_units (
  barber_id UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  unit_id UUID NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  PRIMARY KEY (barber_id, unit_id)
);

-- Serviços vendidos pela barbearia.
CREATE TABLE services (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(120) NOT NULL,
  description TEXT,
  price NUMERIC(12,2) NOT NULL CHECK (price >= 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  icon VARCHAR(80),
  color VARCHAR(20),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Relação N:N entre serviços e barbeiros habilitados.
CREATE TABLE service_barbers (
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  barber_id UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, barber_id)
);

-- Bloqueios de horários por barbeiro ou administrador.
CREATE TABLE barber_time_blocks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  barber_id UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  block_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  reason VARCHAR(220),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (start_time < end_time)
);

-- Agenda principal. O índice parcial abaixo ajuda a evitar conflitos em horários ativos.
CREATE TABLE appointments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code VARCHAR(32) NOT NULL UNIQUE,
  unit_id UUID NOT NULL REFERENCES units(id) ON DELETE RESTRICT,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  barber_id UUID NOT NULL REFERENCES barbers(id) ON DELETE RESTRICT,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE RESTRICT,
  appointment_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status appointment_status NOT NULL DEFAULT 'scheduled',
  payment_status payment_status NOT NULL DEFAULT 'pending',
  payment_method payment_method NOT NULL DEFAULT 'pix',
  notes TEXT,
  internal_notes TEXT,
  cancellation_reason TEXT,
  is_fit_in BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (start_time < end_time)
);

CREATE INDEX idx_appointments_barber_date ON appointments(barber_id, appointment_date);
CREATE INDEX idx_appointments_client_date ON appointments(client_id, appointment_date DESC);
CREATE INDEX idx_appointments_status ON appointments(status);

-- Pagamentos por atendimento, incluindo referência de gateway externo.
CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id UUID NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  barber_id UUID NOT NULL REFERENCES barbers(id) ON DELETE RESTRICT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  method payment_method NOT NULL,
  status payment_status NOT NULL DEFAULT 'pending',
  gateway_reference VARCHAR(180),
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Comissões calculadas a partir de atendimentos finalizados.
CREATE TABLE commissions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id UUID NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  barber_id UUID NOT NULL REFERENCES barbers(id) ON DELETE RESTRICT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  rate NUMERIC(5,4) NOT NULL,
  status commission_status NOT NULL DEFAULT 'pending',
  commission_date DATE NOT NULL,
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Avaliações dos clientes.
CREATE TABLE reviews (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  appointment_id UUID NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  barber_id UUID NOT NULL REFERENCES barbers(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Produtos vendidos ou consumidos na operação.
CREATE TABLE products (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
  name VARCHAR(140) NOT NULL,
  category VARCHAR(100) NOT NULL,
  sku VARCHAR(80) UNIQUE,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  purchase_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  sale_price NUMERIC(12,2) NOT NULL DEFAULT 0,
  min_stock INTEGER NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Histórico de entradas, vendas, uso interno, perdas e ajustes de estoque.
CREATE TABLE stock_movements (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  type stock_movement_type NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  unit_value NUMERIC(12,2) NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Despesas da operação para cálculo de lucro estimado.
CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  unit_id UUID REFERENCES units(id) ON DELETE SET NULL,
  category VARCHAR(100) NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  due_date DATE,
  status payment_status NOT NULL DEFAULT 'pending',
  paid_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Promoções e combos comerciais.
CREATE TABLE promotions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  title VARCHAR(140) NOT NULL,
  description TEXT,
  code VARCHAR(50) NOT NULL UNIQUE,
  discount_type VARCHAR(20) NOT NULL CHECK (discount_type IN ('percent', 'fixed')),
  discount_value NUMERIC(12,2) NOT NULL CHECK (discount_value >= 0),
  starts_at DATE NOT NULL,
  ends_at DATE NOT NULL,
  audience VARCHAR(80) NOT NULL DEFAULT 'all',
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (starts_at <= ends_at)
);

-- Cupons individuais, incluindo aniversário e fidelidade.
CREATE TABLE coupons (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  promotion_id UUID REFERENCES promotions(id) ON DELETE SET NULL,
  client_id UUID REFERENCES clients(id) ON DELETE CASCADE,
  code VARCHAR(50) NOT NULL UNIQUE,
  discount_value NUMERIC(12,2) NOT NULL CHECK (discount_value >= 0),
  expires_at DATE,
  used_at TIMESTAMPTZ,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Regras e recompensas do programa de fidelidade.
CREATE TABLE loyalty_rewards (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name VARCHAR(140) NOT NULL,
  points INTEGER NOT NULL CHECK (points > 0),
  discount_value NUMERIC(12,2),
  service_id UUID REFERENCES services(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE
);

-- Indicações feitas por clientes.
CREATE TABLE referrals (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  referrer_client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  referred_client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  points_awarded INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Lista de espera para horários disputados.
CREATE TABLE waitlist (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  service_id UUID NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  barber_id UUID REFERENCES barbers(id) ON DELETE SET NULL,
  preferred_date DATE,
  period VARCHAR(80),
  status VARCHAR(30) NOT NULL DEFAULT 'waiting',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fila de mensagens automáticas. Integrações reais podem consumir esta tabela.
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  channel notification_channel NOT NULL,
  title VARCHAR(160) NOT NULL,
  message TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'queued',
  scheduled_for TIMESTAMPTZ,
  sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Configurações globais: horários, feriados, regras de sessão, LGPD e integrações.
CREATE TABLE barbershop_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key VARCHAR(100) NOT NULL UNIQUE,
  value JSONB NOT NULL,
  updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Logs de auditoria para ações sensíveis.
CREATE TABLE audit_logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action VARCHAR(120) NOT NULL,
  entity VARCHAR(80) NOT NULL,
  entity_id VARCHAR(120),
  details TEXT,
  ip_address INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_payments_status ON payments(status);
CREATE INDEX idx_products_low_stock ON products(quantity, min_stock);
CREATE INDEX idx_reviews_barber ON reviews(barber_id, created_at DESC);
CREATE INDEX idx_notifications_status ON notifications(status, scheduled_for);
CREATE INDEX idx_audit_logs_created_at ON audit_logs(created_at DESC);

-- Exemplo de consulta segura para buscar horários conflitantes.
-- Use parâmetros preparados ($1, $2, $3, $4) na aplicação para evitar SQL Injection.
-- SELECT id FROM appointments
-- WHERE barber_id = $1
--   AND appointment_date = $2
--   AND status IN ('scheduled', 'confirmed', 'in_service')
--   AND start_time < $4
--   AND end_time > $3;
