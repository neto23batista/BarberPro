-- Production hardening for existing BarberPro MySQL databases.
-- Adds tenant foreign keys, security indexes and the email notification channel.

ALTER TABLE notifications
  MODIFY channel ENUM('system', 'email', 'whatsapp', 'sms') NOT NULL DEFAULT 'system';

SET @idx := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'users' AND index_name = 'idx_users_tenant_status_role');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_users_tenant_status_role ON users(tenant_id, status, role)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND index_name = 'idx_audit_logs_tenant_created');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_audit_logs_tenant_created ON audit_logs(tenant_id, created_at)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @idx := (SELECT COUNT(1) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'clients' AND index_name = 'idx_clients_tenant_email');
SET @sql := IF(@idx = 0, 'CREATE INDEX idx_clients_tenant_email ON clients(tenant_id, email)', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'units' AND constraint_name = 'fk_units_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE units ADD CONSTRAINT fk_units_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'users' AND constraint_name = 'fk_users_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE users ADD CONSTRAINT fk_users_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'clients' AND constraint_name = 'fk_clients_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE clients ADD CONSTRAINT fk_clients_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'barbers' AND constraint_name = 'fk_barbers_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE barbers ADD CONSTRAINT fk_barbers_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'services' AND constraint_name = 'fk_services_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE services ADD CONSTRAINT fk_services_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'appointments' AND constraint_name = 'fk_appointments_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE appointments ADD CONSTRAINT fk_appointments_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'coupons' AND constraint_name = 'fk_coupons_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE coupons ADD CONSTRAINT fk_coupons_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'waitlist' AND constraint_name = 'fk_waitlist_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE waitlist ADD CONSTRAINT fk_waitlist_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'notifications' AND constraint_name = 'fk_notifications_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE notifications ADD CONSTRAINT fk_notifications_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @fk := (SELECT COUNT(1) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND table_name = 'audit_logs' AND constraint_name = 'fk_audit_logs_tenant');
SET @sql := IF(@fk = 0, 'ALTER TABLE audit_logs ADD CONSTRAINT fk_audit_logs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE RESTRICT', 'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

INSERT IGNORE INTO schema_migrations (migration)
VALUES ('004_production_hardening');
