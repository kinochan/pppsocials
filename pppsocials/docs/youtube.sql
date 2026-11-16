CREATE TABLE youtube_channels (
  channel_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  encrypted_refresh_token TEXT NOT NULL
) CHARACTER SET utf8mb4;
