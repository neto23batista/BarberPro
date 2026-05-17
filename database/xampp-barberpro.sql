-- BarberPro para XAMPP / MySQL / MariaDB
-- Importe este arquivo no phpMyAdmin ou rode:
-- C:\xampp\mysql\bin\mysql.exe -u root < database\xampp-barberpro.sql

CREATE DATABASE IF NOT EXISTS barberpro
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_unicode_ci;

USE barberpro;

-- A aplicação usa esta tabela como fonte de verdade do estado operacional.
-- Esse formato permite ativar o MySQL sem reescrever todos os módulos agora.
CREATE TABLE IF NOT EXISTS app_state (
  id VARCHAR(60) NOT NULL PRIMARY KEY,
  data LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Tabela opcional para registrar migrações futuras.
CREATE TABLE IF NOT EXISTS schema_migrations (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  migration VARCHAR(180) NOT NULL UNIQUE,
  executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO schema_migrations (migration)
VALUES ('001_create_barberpro_app_state');
