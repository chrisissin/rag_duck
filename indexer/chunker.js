import { normalizeSlackText, formatUserLine } from "../slack/normalize.js";

/**
 * Build one chunk for a full thread (messages must be oldest->newest).
 */
export async function buildThreadChunk({ team_id, channel, channel_name, thread_ts, messages, resolver }) {
  const lines = [];
  for (const m of messages) {
    const text = await normalizeSlackText(m.text, resolver);
    if (!text) continue;
    const username = m.user ? await resolver.getUsername(m.user) : "unknown";
    lines.push(formatUserLine(username, text));
  }

  const text = lines.join("\n");
  const start_ts = messages[0]?.ts;
  const end_ts = messages[messages.length - 1]?.ts;

  return {
    team_id,
    channel_id: channel,
    channel_name,
    is_thread: true,
    thread_ts,
    start_ts,
    end_ts,
    text,
    chunk_key: `${team_id}:${channel}:thread:${thread_ts}`,
    message_count: messages.length,
  };
}

/**
 * Build rolling window chunks for non-thread messages.
 * messages must be oldest->newest
 */
export async function buildWindows({ team_id, channel, channel_name, messages, resolver, maxMessages = 20, maxMinutes = 10 }) {
  const chunks = [];
  let buf = [];
  let start = null;

  const toMillis = (ts) => Math.floor(parseFloat(ts) * 1000);

  const flush = async () => {
    if (!buf.length) return;

    const lines = [];
    for (const m of buf) {
      const text = await normalizeSlackText(m.text, resolver);
      if (!text) continue;
      const username = m.user ? await resolver.getUsername(m.user) : "unknown";
      lines.push(formatUserLine(username, text));
    }

    const text = lines.join("\n");
    const start_ts = buf[0].ts;
    const end_ts = buf[buf.length - 1].ts;

    if (text.trim().length > 0) {
      chunks.push({
        team_id,
        channel_id: channel,
        channel_name,
        is_thread: false,
        thread_ts: null,
        start_ts,
        end_ts,
        text,
        chunk_key: `${team_id}:${channel}:window:${start_ts}-${end_ts}`,
        message_count: buf.length,
      });
    }

    buf = [];
    start = null;
  };

  for (const m of messages) {
    if (!m?.text) continue;

    if (!buf.length) {
      buf.push(m);
      start = m.ts;
      continue;
    }

    buf.push(m);
    const spanMinutes = (toMillis(m.ts) - toMillis(start)) / 60000;

    if (buf.length >= maxMessages || spanMinutes >= maxMinutes) {
      await flush();
    }
  }

  await flush();
  return chunks;
}
