import "dotenv/config";
import { slackClient } from "../slack/client.js";
import { UserResolver } from "../slack/userResolver.js";
import { listAllPublicChannels, fetchHistory, fetchThreadReplies } from "./slackFetch.js";
import { buildThreadChunk, buildWindows } from "./chunker.js";
import { ollamaEmbed } from "../rag/ollama.js";
import { upsertChunk, setCursor } from "../db/slackChunksRepo.js";

async function main() {
  const web = slackClient();
  const resolver = new UserResolver(web);

  const auth = await web.auth.test();
  const team_id = auth.team_id;

  const limit = parseInt(process.env.HISTORY_PAGE_LIMIT || "200", 10);
  const maxMessages = parseInt(process.env.MAX_MESSAGES_PER_WINDOW || "20", 10);
  const maxMinutes = parseInt(process.env.MAX_WINDOW_MINUTES || "10", 10);

  const channels = await listAllPublicChannels(web);
  console.log(`Found ${channels.length} public channels bot is a member of.`);

  for (const ch of channels) {
    const channel_id = ch.id;
    const channel_name = ch.name;

    console.log(`\nBackfilling #${channel_name} (${channel_id})...`);

    // Full history can be huge; start conservative:
    // - For big channels, consider adding a BACKFILL_OLDEST_TS env to cap.
    const messages = await fetchHistory(web, channel_id, { oldest: undefined, limit });

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

    // Index threads
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

    for (const w of windows) {
      if (!w.text?.trim()) continue;
      const embedding = await ollamaEmbed(w.text);
      await upsertChunk({ ...w, embedding });
    }

    // Set cursor to newest message ts (if any) so incremental sync can start
    const latest_ts = messages[messages.length - 1]?.ts;
    if (latest_ts) {
      await setCursor({ team_id, channel_id, latest_ts });
    }

    console.log(`Indexed #${channel_name}: ${threadRoots.size} threads, ${windows.length} windows. Cursor=${latest_ts || "n/a"}`);
  }

  console.log("\nBackfill complete.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
