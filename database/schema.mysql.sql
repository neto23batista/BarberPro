-- BarberPro relational schema for XAMPP / MySQL / MariaDB.
-- This schema is the target structure for replacing the current app_state JSON store.

CREATE DATABASE IF NOT EXISTS barberpro
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE barberpro;

CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  migration VARCHAR(180) NOT NULL UNIQUE,
  executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS units (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  name VARCHAR(140) NOT NULL,
  phone VARCHAR(32),
  whatsapp VARCHAR(32),
  email VARCHAR(180),
  address TEXT,
  status ENUM('active', 'inactive', 'blocked') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  unit_id VARCHAR(60),
  role ENUM('admin', 'owner', 'barber', 'attendant', 'client') NOT NULL,
  name VARCHAR(140) NOT NULL,
  email VARCHAR(180) NOT NULL UNIQUE,
  phone VARCHAR(32),
  password_hash TEXT NOT NULL,
  status ENUM('active', 'inactive', 'blocked') NOT NULL DEFAULT 'active',
  avatar_url TEXT,
  birth_date DATE,
  last_login_at DATETIME,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_users_unit FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS barbers (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  user_id VARCHAR(60) UNIQUE,
  name VARCHAR(140) NOT NULL,
  phone VARCHAR(32),
  email VARCHAR(180),
  bio TEXT,
  commission_rate DECIMAL(6,4) NOT NULL DEFAULT 0.4000,
  rating DECIMAL(3,2) NOT NULL DEFAULT 5.00,
  goal_monthly DECIMAL(12,2) NOT NULL DEFAULT 0,
  status ENUM('active', 'inactive', 'blocked') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_barbers_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS barber_specialties (
  barber_id VARCHAR(60) NOT NULL,
  specialty VARCHAR(80) NOT NULL,
  PRIMARY KEY (barber_id, specialty),
  CONSTRAINT fk_barber_specialties_barber FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS barber_units (
  barber_id VARCHAR(60) NOT NULL,
  unit_id VARCHAR(60) NOT NULL,
  PRIMARY KEY (barber_id, unit_id),
  CONSTRAINT fk_barber_units_barber FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE,
  CONSTRAINT fk_barber_units_unit FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS clients (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  user_id VARCHAR(60) UNIQUE,
  preferred_barber_id VARCHAR(60),
  name VARCHAR(140) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  email VARCHAR(180),
  birth_date DATE,
  loyalty_points INT NOT NULL DEFAULT 0,
  visits INT NOT NULL DEFAULT 0,
  no_shows INT NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_clients_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CONSTRAINT fk_clients_preferred_barber FOREIGN KEY (preferred_barber_id) REFERENCES barbers(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS client_tags (
  client_id VARCHAR(60) NOT NULL,
  tag VARCHAR(40) NOT NULL,
  PRIMARY KEY (client_id, tag),
  CONSTRAINT fk_client_tags_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS services (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  description TEXT,
  price DECIMAL(12,2) NOT NULL,
  duration_minutes INT NOT NULL,
  icon VARCHAR(80),
  color VARCHAR(20),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CHECK (price >= 0),
  CHECK (duration_minutes > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS service_barbers (
  service_id VARCHAR(60) NOT NULL,
  barber_id VARCHAR(60) NOT NULL,
  PRIMARY KEY (service_id, barber_id),
  CONSTRAINT fk_service_barbers_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE,
  CONSTRAINT fk_service_barbers_barber FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS barber_time_blocks (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  barber_id VARCHAR(60) NOT NULL,
  created_by VARCHAR(60),
  block_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  reason VARCHAR(220),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_time_blocks_barber FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE,
  CONSTRAINT fk_time_blocks_user FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (start_time < end_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS appointments (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  unit_id VARCHAR(60) NOT NULL,
  client_id VARCHAR(60) NOT NULL,
  barber_id VARCHAR(60) NOT NULL,
  service_id VARCHAR(60) NOT NULL,
  appointment_date DATE NOT NULL,
  start_time TIME NOT NULL,
  end_time TIME NOT NULL,
  status ENUM('scheduled', 'confirmed', 'in_service', 'finished', 'cancelled', 'no_show') NOT NULL DEFAULT 'scheduled',
  payment_status ENUM('pending', 'paid', 'cancelled', 'refunded') NOT NULL DEFAULT 'pending',
  payment_method ENUM('cash', 'card', 'pix', 'online') NOT NULL DEFAULT 'pix',
  notes TEXT,
  internal_notes TEXT,
  cancellation_reason TEXT,
  is_fit_in BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_appointments_unit FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE RESTRICT,
  CONSTRAINT fk_appointments_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT,
  CONSTRAINT fk_appointments_barber FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE RESTRICT,
  CONSTRAINT fk_appointments_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE RESTRICT,
  CHECK (start_time < end_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE INDEX idx_appointments_barber_date ON appointments(barber_id, appointment_date);
CREATE INDEX idx_appointments_client_date ON appointments(client_id, appointment_date);
CREATE INDEX idx_appointments_status ON appointments(status);

CREATE TABLE IF NOT EXISTS payments (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  appointment_id VARCHAR(60) NOT NULL UNIQUE,
  client_id VARCHAR(60) NOT NULL,
  barber_id VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  method ENUM('cash', 'card', 'pix', 'online') NOT NULL,
  status ENUM('pending', 'paid', 'cancelled', 'refunded') NOT NULL DEFAULT 'pending',
  gateway_reference VARCHAR(180),
  paid_at DATETIME,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_payments_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_payments_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT,
  CONSTRAINT fk_payments_barber FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE RESTRICT,
  CHECK (amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS commissions (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  appointment_id VARCHAR(60) NOT NULL UNIQUE,
  barber_id VARCHAR(60) NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  rate DECIMAL(6,4) NOT NULL,
  status ENUM('pending', 'available', 'paid', 'cancelled') NOT NULL DEFAULT 'pending',
  commission_date DATE NOT NULL,
  paid_at DATETIME,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_commissions_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_commissions_barber FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE RESTRICT,
  CHECK (amount >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS reviews (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  appointment_id VARCHAR(60) NOT NULL UNIQUE,
  client_id VARCHAR(60) NOT NULL,
  barber_id VARCHAR(60) NOT NULL,
  rating INT NOT NULL,
  comment TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_reviews_appointment FOREIGN KEY (appointment_id) REFERENCES appointments(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_client FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE,
  CONSTRAINT fk_reviews_barber FOREIGN KEY (barber_id) REFERENCES barbers(id) ON DELETE CASCADE,
  CHECK (rating BETWEEN 1 AND 5)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  unit_id VARCHAR(60),
  name VARCHAR(140) NOT NULL,
  category VARCHAR(100) NOT NULL,
  sku VARCHAR(80) UNIQUE,
  quantity INT NOT NULL DEFAULT 0,
  purchase_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  sale_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  min_stock INT NOT NULL DEFAULT 1,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT fk_products_unit FOREIGN KEY (unit_id) REFERENCES units(id) ON DELETE SET NULL,
  CHECK (quantity >= 0),
  CHECK (purchase_price >= 0),
  CHECK (sale_price >= 0),
  CHECK (min_stock >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_movements (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  product_id VARCHAR(60) NOT NULL,
  user_id VARCHAR(60),
  type ENUM('purchase', 'sale', 'usage', 'loss', 'adjustment') NOT NULL,
  quantity INT NOT NULL,
  unit_value DECIMAL(12,2) NOT NULL DEFAULT 0,
  reason TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_stock_movements_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE,
  CONSTRAINT fk_stock_movements_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  CHECK (quantity > 0),
  CHECK (unit_value >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS audit_logs (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  user_id VARCHAR(60),
  action VARCHAR(100) NOT NULL,
  entity VARCHAR(80) NOT NULL,
  entity_id VARCHAR(80),
  details TEXT,
  ip VARCHAR(80),
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_logs_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (migration)
VALUES ('002_create_relational_mysql_schema');
