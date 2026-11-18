CREATE TABLE youtube_publications (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  video_id BIGINT UNSIGNED NOT NULL,
  channel_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  channel_title VARCHAR(255) NOT NULL,
  status VARCHAR(32) CHARACTER SET ascii NOT NULL,
  requested_privacy VARCHAR(16) CHARACTER SET ascii NOT NULL,
  actual_privacy VARCHAR(16) CHARACTER SET ascii NULL,
  upload_percent TINYINT UNSIGNED NULL,
  active TINYINT NULL DEFAULT 1,
  youtube_video_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  message VARCHAR(255) NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY active_publication (video_id, channel_id, active),
  INDEX video_publications (video_id, created_at)
) CHARACTER SET utf8mb4;
