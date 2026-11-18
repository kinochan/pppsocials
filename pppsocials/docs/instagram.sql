CREATE TABLE instagram_connection (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  business_id TEXT NOT NULL,
  config_id TEXT NOT NULL,
  accounts LONGTEXT NOT NULL,
  encrypted_token LONGTEXT NOT NULL
) CHARACTER SET utf8mb4;

CREATE TABLE instagram_accounts (
  account_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  username VARCHAR(255) NOT NULL,
  encrypted_token LONGTEXT NOT NULL
) CHARACTER SET utf8mb4;
