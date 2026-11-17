CREATE TABLE facebook_publications (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  video_id BIGINT UNSIGNED NOT NULL,
  page_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  page_name VARCHAR(255) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii NOT NULL,
  upload_percent TINYINT UNSIGNED NULL,
  active TINYINT NULL DEFAULT 1,
  meta_video_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  post_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  message VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY active_publication (video_id, page_id, active),
  INDEX video_publications (video_id, created_at)
) CHARACTER SET utf8mb4;
