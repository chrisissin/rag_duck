import "dotenv/config";
import { slackClient } from "../slack/client.js";
import { UserResolver } from "../slack/userResolver.js";
import { listAllPublicChannels, fetchHistory, fetchThreadReplies } from "./slackFetch.js";
import { buildThreadChunk, buildWindows } from "./chunker.js";
import { ollamaEmbed } from "../rag/ollama.js";
import { upsertChunk, getCursor, setCursor } from "../db/slackChunksRepo.js";

/**
 * Incremental sync:
 * - Ensure all public channels the bot is a member of have a cursor row
 * - For each channel, fetch history since latest_ts and index new content
 *
 * Safe default: still indexes only what the bot can see.
 */
async function main() {
  const web = slackClient();
  const resolver = new UserResolver(web);

  const auth = await web.auth.test();
  const team_id = auth.team_id;

  const limit = parseInt(process.env.HISTORY_PAGE_LIMIT || "200", 10);
  const maxMessages = parseInt(process.env.MAX_MESSAGES_PER_WINDOW || "20", 10);
  const maxMinutes = parseInt(process.env.MAX_WINDOW_MINUTES || "10", 10);

  const channels = await listAllPublicChannels(web);
  console.log(`Syncing ${channels.length} channels...`);

  for (const ch of channels) {
    const channel_id = ch.id;
    const channel_name = ch.name;

    const cursor = await getCursor({ team_id, channel_id });

    // If no cursor yet, initialize cursor to "now" (don't backfill unexpectedly)
    if (!cursor) {
      // Use the latest message ts as baseline
      const recent = await fetchHistory(web, channel_id, { oldest: undefined, limit: 10 });
      const latest = recent[recent.length - 1]?.ts;
      if (latest) await setCursor({ team_id, channel_id, latest_ts: latest });
      console.log(`Initialized cursor for #${channel_name} to ${latest || "n/a"}`);
      continue;
    }

    // Fetch messages after cursor. Slack 'oldest' is inclusive; add a tiny epsilon by string math isn't safe.
    // We'll dedupe via chunk_key anyway, so inclusive is OK.
    const newMessages = await fetchHistory(web, channel_id, { oldest: cursor, limit });

    if (!newMessages.length) {
      // nothing new
      continue;
    }

    console.log(`#${channel_name}: ${newMessages.length} new-ish messages since ${cursor}`);

    const threadRoots = new Set();
    const nonThread = [];

    for (const m of newMessages) {
      if (!m?.text) continue;
      if (m.thread_ts) {
        threadRoots.add(m.thread_ts);
        continue;
      }
      nonThread.push(m);
    }

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
    }

    const windows = await buildWindows({
      team_id,
      channel: channel_id,
      channel_name,
      messages: nonThread,
      resolver,
      maxMessages,
      maxMinutes
    });

    for (const w of windows) {
      if (!w.text?.trim()) continue;
      const embedding = await ollamaEmbed(w.text);
      await upsertChunk({ ...w, embedding });
    }

    const latest_ts = newMessages[newMessages.length - 1]?.ts;
    if (latest_ts) {
      await setCursor({ team_id, channel_id, latest_ts });
      console.log(`#${channel_name}: cursor -> ${latest_ts}`);
    }
  }

  console.log("Sync once complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
