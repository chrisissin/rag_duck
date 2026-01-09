# Testing Your Slack RAG Bot

## Quick Database View

View what's indexed in your database:
```bash
./scripts/view_db.sh
```

Or manually query:
```bash
# Summary
docker exec -i slack_rag_pg psql -U postgres -d slack_rag -c "SELECT channel_name, COUNT(*) as chunks, SUM(message_count) as total_messages FROM slack_chunks GROUP BY channel_name;"

# See sample chunks
docker exec -i slack_rag_pg psql -U postgres -d slack_rag -c "SELECT id, channel_name, is_thread, message_count, LEFT(text, 100) as preview FROM slack_chunks ORDER BY created_at DESC LIMIT 5;"
```

## Testing the Bot

### Prerequisites
1. ✅ Bot is running: `npm run bot` (should show "⚡️ Slack RAG bot running on port 3000")
2. ✅ Bot is installed to your workspace
3. ✅ Bot is invited to the channel: `/invite @YourBotName`
4. ✅ Data is indexed: Run `npm run backfill:all` first
5. ✅ Ollama is running with both models:
   - `nomic-embed-text` (for embeddings)
   - `llama3.1` (for chat responses)

### Test in Slack

1. **Go to a channel where:**
   - The bot is a member
   - You've indexed messages (run `backfill:all`)

2. **Mention your bot:**
   ```
   @YourBotName what did we discuss about deployments?
   ```
   or
   ```
   @YourBotName what was the last code change?
   ```

3. **The bot should:**
   - Retrieve relevant context from indexed messages
   - Generate an answer using Ollama
   - Reply in a thread

### Troubleshooting

**Bot doesn't respond:**
- Check bot is running: `npm run bot`
- Check Event Subscriptions URL is verified in Slack app settings
- Check bot is invited to the channel
- Check server logs for errors

**Bot responds but with errors:**
- Check Ollama is running: `curl http://localhost:11434/api/tags`
- Check you have `llama3.1` model: `ollama list`
- If missing: `ollama pull llama3.1`

**Bot says "no context found":**
- Make sure you ran `npm run backfill:all` to index messages
- Check database has chunks: `./scripts/view_db.sh`
- Make sure you're asking in a channel that was indexed

**Database is empty:**
- Run `npm run backfill:all` to index historical messages
- Or wait for new messages and run `npm run sync:once`

## Understanding the Data

**Chunks are stored as:**
- **Threads**: All messages in a Slack thread become one chunk
- **Windows**: Non-thread messages grouped by time (20 messages or 10 minutes)

**Each chunk contains:**
- `text`: The actual message content
- `embedding`: Vector representation for semantic search
- `channel_id`: Which channel it's from
- `start_ts` / `end_ts`: Timestamp range
- `message_count`: How many messages in this chunk

