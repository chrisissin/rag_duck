import { withClient } from "./pool.js";

/**
 * Upsert chunk by chunk_key (idempotent).
 * embedding: number[] (must match pgvector dimension)
 */
export async function upsertChunk(chunk) {
  const {
    team_id,
    channel_id,
    channel_name,
    is_thread,
    thread_ts,
    start_ts,
    end_ts,
    text,
    chunk_key,
    embedding,
    message_count,
  } = chunk;

  return withClient(async (client) => {
    const q = `
      INSERT INTO slack_chunks (
        team_id, channel_id, channel_name,
        is_thread, thread_ts,
        start_ts, end_ts,
        text, chunk_key,
        embedding, message_count,
        updated_at
      )
      VALUES (
        $1, $2, $3,
        $4, $5,
        $6, $7,
        $8, $9,
        $10::vector, $11,
        now()
      )
      ON CONFLICT (chunk_key) DO UPDATE SET
        text = EXCLUDED.text,
        embedding = EXCLUDED.embedding,
        message_count = EXCLUDED.message_count,
        end_ts = EXCLUDED.end_ts,
        updated_at = now()
      RETURNING id;
    `;

    const embeddingStr = `[${embedding.join(",")}]`;

    const res = await client.query(q, [
      team_id,
      channel_id,
      channel_name ?? null,
      is_thread,
      thread_ts ?? null,
      start_ts,
      end_ts,
      text,
      chunk_key,
      embeddingStr,
      message_count ?? 0,
    ]);

    return res.rows[0]?.id;
  });
}

/**
 * Search similar chunks, filtered by channel_id (safe default).
 */
export async function searchSimilar({ channel_id, queryEmbedding, topK }) {
  return withClient(async (client) => {
    const embeddingStr = `[${queryEmbedding.join(",")}]`;
    const q = `
      SELECT
        id, text, channel_id, channel_name, thread_ts, start_ts, end_ts,
        1 - (embedding <=> $1::vector) AS similarity
      FROM slack_chunks
      WHERE channel_id = $2
      ORDER BY embedding <=> $1::vector
      LIMIT $3;
    `;
    const res = await client.query(q, [embeddingStr, channel_id, topK]);
    return res.rows;
  });
}

/**
 * Cursor helpers
 */
export async function getCursor({ team_id, channel_id }) {
  return withClient(async (client) => {
    const res = await client.query(
      `SELECT latest_ts FROM slack_channel_cursors WHERE team_id=$1 AND channel_id=$2`,
      [team_id, channel_id]
    );
    return res.rows[0]?.latest_ts || null;
  });
}

export async function setCursor({ team_id, channel_id, latest_ts }) {
  return withClient(async (client) => {
    await client.query(
      `
      INSERT INTO slack_channel_cursors(team_id, channel_id, latest_ts)
      VALUES($1,$2,$3)
      ON CONFLICT(team_id, channel_id) DO UPDATE SET latest_ts=EXCLUDED.latest_ts
      `,
      [team_id, channel_id, latest_ts]
    );
  });
}
