-- Adds tenant isolation columns to an existing BarberPro relational database.
-- Safe to run after database/schema.mysql.sql on MySQL 8+ / MariaDB versions that support IF NOT EXISTS.

CREATE TABLE IF NOT EXISTS tenants (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  name VARCHAR(140) NOT NULL,
  slug VARCHAR(120) NOT NULL UNIQUE,
  status ENUM('active', 'inactive', 'blocked') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO tenants (id, name, slug)
VALUES ('tenant_demo', 'BarberPro', 'barberpro');

ALTER TABLE units ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE users ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE barbers ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE clients ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE services ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE appointments ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE commissions ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE reviews ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE products ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tenant_id VARCHAR(60) NOT NULL DEFAULT 'tenant_demo' AFTER id;

SET @idx := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'appointments' AND index_name = 'idx_appointments_tenant_barber_date');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_appointments_tenant_barber_date ON appointments(tenant_id, barber_id, appointment_date, start_time)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'idx_users_tenant_email');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_users_tenant_email ON users(tenant_id, email)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'clients' AND index_name = 'idx_clients_tenant_name');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_clients_tenant_name ON clients(tenant_id, name)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'payments' AND index_name = 'idx_payments_tenant_status_paid_at');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_payments_tenant_status_paid_at ON payments(tenant_id, status, paid_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO schema_migrations (migration)
VALUES ('003_add_tenant_isolation');
