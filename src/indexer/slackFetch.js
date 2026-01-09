/**
 * Slack fetch helpers with basic rate-limit handling.
 */
export async function withSlackRetry(fn, logger = console) {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (e) {
      // Slack Web API errors sometimes include data.response_metadata or "Retry-After" via e.data
      const status = e?.data?.status || e?.status || null;
      const retryAfter = parseInt(e?.data?.headers?.["retry-after"] || e?.data?.retry_after || 0, 10);

      if (status === 429 || retryAfter) {
        const waitMs = (retryAfter ? retryAfter : Math.min(5 * (2 ** attempt), 60)) * 1000;
        logger.warn?.(`Slack rate limited. Waiting ${waitMs}ms...`);
        await new Promise(r => setTimeout(r, waitMs));
        attempt++;
        continue;
      }
      throw e;
    }
  }
}

export async function listAllPublicChannels(web) {
  let cursor = undefined;
  const channels = [];
  while (true) {
    const res = await withSlackRetry(() => web.conversations.list({
      limit: 200,
      cursor,
      types: "public_channel",
      exclude_archived: true
    }));
    if (res?.channels?.length) channels.push(...res.channels);
    cursor = res?.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  // Only channels bot is a member of
  return channels.filter(c => c?.is_member);
}

export async function fetchHistory(web, channel, { oldest, limit = 200 }) {
  let cursor = undefined;
  const all = [];
  while (true) {
    const res = await withSlackRetry(() => web.conversations.history({
      channel,
      limit,
      cursor,
      oldest
    }));
    if (res?.messages?.length) all.push(...res.messages);
    cursor = res?.response_metadata?.next_cursor;
    if (!cursor) break;
  }
  // Slack returns newest->oldest; reverse to oldest->newest
  return all.reverse();
}

export async function fetchThreadReplies(web, channel, thread_ts, { limit = 200 }) {
  const res = await withSlackRetry(() => web.conversations.replies({
    channel,
    ts: thread_ts,
    limit
  }));
  // replies returns oldest->newest
  return res?.messages || [];
}
