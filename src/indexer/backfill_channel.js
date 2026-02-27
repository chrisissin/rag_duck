import "dotenv/config";
import { slackClient } from "../slack/client.js";
import { UserResolver } from "../slack/userResolver.js";
import { listAllPublicChannels, fetchHistory, fetchThreadReplies } from "./slackFetch.js";
import { buildThreadChunk, buildWindows } from "./chunker.js";
import { ollamaEmbed } from "../rag/ollama.js";
import { upsertChunk, setCursor } from "../db/slackChunksRepo.js";

/**
 * Backfill a single channel by ID or name.
 * Usage: node src/indexer/backfill_channel.js <channel_id_or_name>
 */
async function main() {
  const channelArg = process.argv[2];
  if (!channelArg) {
    console.error("Usage: node src/indexer/backfill_channel.js <channel_id_or_name>");
    console.error("Example: node src/indexer/backfill_channel.js C1234567890");
    console.error("Example: node src/indexer/backfill_channel.js general");
    process.exit(1);
  }

  const web = slackClient();
  const resolver = new UserResolver(web);

  const auth = await web.auth.test();
  let team_id = process.env.SLACK_TEAM_ID || auth.team_id;
  if (!team_id || team_id.startsWith("E")) {
    const teamsRes = await web.auth.teams.list();
    const teams = teamsRes?.teams || [];
    if (teams.length > 0) team_id = teams[0].id;
  }
  if (!team_id) throw new Error("Could not determine workspace (team_id). Set SLACK_TEAM_ID for Enterprise Grid.");

  const limit = parseInt(process.env.HISTORY_PAGE_LIMIT || "200", 10);
  const maxMessages = parseInt(process.env.MAX_MESSAGES_PER_WINDOW || "20", 10);
  const maxMinutes = parseInt(process.env.MAX_WINDOW_MINUTES || "10", 10);

  // Find the channel by ID or name
  let channel_id = channelArg;
  let channel_name = channelArg;

  // If it doesn't look like a channel ID (starts with C), try to find by name
  if (!channelArg.startsWith("C")) {
    const channels = await listAllPublicChannels(web, team_id);
    const found = channels.find(c => c.name === channelArg || c.name === `#${channelArg}`);
    if (!found) {
      console.error(`Channel "${channelArg}" not found. Available channels:`);
      channels.slice(0, 20).forEach(c => console.error(`  - ${c.name} (${c.id})`));
      if (channels.length > 20) console.error(`  ... and ${channels.length - 20} more`);
      process.exit(1);
    }
    channel_id = found.id;
    channel_name = found.name;
  } else {
    // Verify channel exists and get its name
    try {
      const info = await web.conversations.info({ channel: channel_id });
      if (!info.channel) {
        console.error(`Channel ${channel_id} not found or bot is not a member.`);
        process.exit(1);
      }
      channel_name = info.channel.name;
    } catch (e) {
      console.error(`Error fetching channel info: ${e.message}`);
      process.exit(1);
    }
  }

  console.log(`Backfilling #${channel_name} (${channel_id})...`);

  // Optional: support BACKFILL_OLDEST_TS env var to limit how far back to go
  const oldest_ts = process.env.BACKFILL_OLDEST_TS || undefined;
  if (oldest_ts) {
    console.log(`Limiting backfill to messages after ${oldest_ts}`);
  }

  const messages = await fetchHistory(web, channel_id, { oldest: oldest_ts, limit });

  if (!messages.length) {
    console.log(`No messages found in #${channel_name}`);
    process.exit(0);
  }

  console.log(`Fetched ${messages.length} messages`);

  // Identify thread roots from messages that have thread_ts
  const threadRoots = new Set();
  const nonThread = [];

  for (const m of messages) {
    if (!m?.text) continue;
    if (m.thread_ts) {
      threadRoots.add(m.thread_ts);
      continue;
    }
    nonThread.push(m);
  }

  console.log(`Found ${threadRoots.size} thread roots and ${nonThread.length} non-thread messages`);

  // Index threads
  let threadCount = 0;
  for (const thread_ts of threadRoots) {
    const threadMsgs = await fetchThreadReplies(web, channel_id, thread_ts, { limit });
    if (!threadMsgs?.length) continue;

    const chunk = await buildThreadChunk({
      team_id,
      channel: channel_id,
      channel_name,
      thread_ts,
      messages: threadMsgs,
      resolver
    });

    if (!chunk.text?.trim()) continue;
    const embedding = await ollamaEmbed(chunk.text);
    await upsertChunk({ ...chunk, embedding });
    threadCount++;
  }

  // Index windows for non-thread msgs
  const windows = await buildWindows({
    team_id,
    channel: channel_id,
    channel_name,
    messages: nonThread,
    resolver,
    maxMessages,
    maxMinutes
  });

  let windowCount = 0;
  for (const w of windows) {
    if (!w.text?.trim()) continue;
    const embedding = await ollamaEmbed(w.text);
    await upsertChunk({ ...w, embedding });
    windowCount++;
  }

  // Set cursor to newest message ts (if any) so incremental sync can start
  const latest_ts = messages[messages.length - 1]?.ts;
  if (latest_ts) {
    await setCursor({ team_id, channel_id, latest_ts });
  }

  console.log(`\nBackfill complete for #${channel_name}:`);
  console.log(`  - Indexed ${threadCount} threads`);
  console.log(`  - Indexed ${windowCount} windows`);
  console.log(`  - Cursor set to ${latest_ts || "n/a"}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
