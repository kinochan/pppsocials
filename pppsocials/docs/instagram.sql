CREATE TABLE instagram_connection (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  business_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  accounts LONGTEXT NOT NULL,
  encrypted_token LONGTEXT NOT NULL
) CHARACTER SET utf8mb4;
