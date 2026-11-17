CREATE TABLE tiktok_uploads (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  video_id BIGINT UNSIGNED NOT NULL,
  account_id VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  account_name VARCHAR(255) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii NOT NULL,
  active TINYINT NULL DEFAULT 1,
  upload_percent TINYINT UNSIGNED NULL,
  publish_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  message VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY active_upload (video_id, account_id, active),
  INDEX video_uploads (video_id, created_at)
) CHARACTER SET utf8mb4;
