/**
 * Slack fetch helpers with basic rate-limit handling.
 */
import { withSlackRetry } from "../slack/retry.js";

export { withSlackRetry };

export async function listAllPublicChannels(web, team_id) {
  let cursor = undefined;
  const channels = [];
  const baseParams = {
    limit: 200,
    types: "public_channel",
    exclude_archived: true
  };
  // Pass team_id only when it's a workspace ID (T-prefixed). Enterprise install returns E-prefixed
  // IDs that cause team_access_not_granted, so we omit team_id for those.
  if (team_id && team_id.startsWith("T")) {
    baseParams.team_id = team_id;
  }
  while (true) {
    const res = await withSlackRetry(() => web.conversations.list({
      ...baseParams,
      cursor
    }), { operation: "conversations.list" });
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
    }), { operation: "conversations.history" });
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
  }), { operation: "conversations.replies" });
  // replies returns oldest->newest
  return res?.messages || [];
}
