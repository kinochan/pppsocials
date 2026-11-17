CREATE TABLE tiktok_accounts (
  open_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL PRIMARY KEY,
  display_name VARCHAR(255) NOT NULL,
  encrypted_tokens LONGTEXT NOT NULL
) CHARACTER SET utf8mb4;
