CREATE EXTENSION IF NOT EXISTS vector;

-- NOTE: vector dimension must match your embeddings model output.
-- nomic-embed-text is typically 768 dims.
CREATE TABLE IF NOT EXISTS slack_chunks (
  id BIGSERIAL PRIMARY KEY,

  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  channel_name TEXT,

  is_thread BOOLEAN NOT NULL DEFAULT FALSE,
  thread_ts TEXT,

  start_ts TEXT NOT NULL,
  end_ts TEXT NOT NULL,

  text TEXT NOT NULL,

  chunk_key TEXT NOT NULL UNIQUE,

  embedding vector(768),

  message_count INT NOT NULL DEFAULT 0,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_slack_chunks_channel ON slack_chunks(channel_id);
CREATE INDEX IF NOT EXISTS idx_slack_chunks_thread  ON slack_chunks(channel_id, thread_ts);

CREATE TABLE IF NOT EXISTS slack_channel_cursors (
  team_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  latest_ts TEXT NOT NULL,
  PRIMARY KEY (team_id, channel_id)
);
