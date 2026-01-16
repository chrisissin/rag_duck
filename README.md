# Slack RAG Bot (Node + Postgres/pgvector + Ollama)

This starter project builds a Slack bot that:
- listens for `@mentions` (`app_mention`)
- retrieves relevant Slack history from a **local Postgres + pgvector** index (RAG)
- answers using a **local LLM via Ollama**
- stays safe by retrieving only from the **same channel** as the mention (v1 default)

It also includes:
- **Backfill**: index **all public channels the bot is a member of**
- **Incremental sync**: updates the index using `slack_channel_cursors` (run once or in a loop)

---

## Usage & Workflow

The following diagram illustrates how the system works for both on-call engineers and platform engineers:

![On-Call Engineer Workflow and Platform Engineer Role](docs/workflow.png)

**On-Call Engineer Workflow:**
1. Ask a question in Slack by mentioning the bot
2. The bot uses Local LLM + RAG (no external data) to respond with chat history context
3. If a policy is triggered, the bot suggests an action and asks for permission via MCP
4. If no policy is triggered, the bot provides a standard response

**Platform Engineer Role:**
1. Write policies that parse queries using regex patterns
2. Define suggested actions when policies are triggered
3. Optionally write MCP definitions to execute approved actions

> **Security Note**: All processing happens locally - no data is sent to external LLM APIs, ensuring your internal data remains private.

---

## Why bot token (not your personal user token)?

For the starter: **use a Slack bot token** (`xoxb-...`).
- It's the recommended Slack model and matches event subscriptions (`app_mention`).
- Indexing is limited to channels the bot is in, which is a good safety boundary.

Could you use your own user token? Sometimes in dev you *can* get a user token, but Slack policies and org settings often restrict it, and it's easier to accidentally over-index private data. Start with the bot token. Later, if you need "index what a user can see", you'll build a real permission model.

---

## Quick Start

**First time setup?** Follow these steps in order:

1. **Prerequisites**: Install Node.js 18+, Docker, and Ollama
2. **Pull Ollama models**: `ollama pull nomic-embed-text && ollama pull llama3.1`
3. **Start database**: `docker compose up -d`
4. **Create schema**: `psql "postgres://postgres:postgres@localhost:5432/slack_rag" -f sql/schema.sql`
5. **Create Slack app** (see detailed instructions below) - you'll need:
   - Bot token (starts with `xoxb-`)
   - Signing secret
6. **Create `.env` file** with your Slack credentials
7. **Install dependencies**: `npm i`
8. **Start ngrok tunnel**: `ngrok http 3000` (in a separate terminal)
9. **Start the bot**: `npm run bot`
10. **Index channels**: `npm run backfill:all` (in another terminal)

Then mention your bot in a channel: `@yourbot what did we discuss about X?`

---

## Requirements

- Node.js 18+
- Docker (for Postgres)
- Ollama installed and running locally

Pull models:
```bash
ollama pull nomic-embed-text
ollama pull llama3.1
```

> This project assumes `nomic-embed-text` embeddings output **768** dims and the DB schema uses `vector(768)`.
> If you change embedding models and the vector length differs, update `sql/schema.sql`.

---

## Setup

### 1) Start Postgres (pgvector)
```bash
docker compose up -d
```

### 2) Create DB schema

**Option A: Using Docker (if you don't have psql installed)**
```bash
docker exec -i slack_rag_pg psql -U postgres -d slack_rag -f - < sql/schema.sql
```

**Option B: Using local psql (if you have PostgreSQL client installed)**
```bash
psql "postgres://postgres:postgres@localhost:5432/slack_rag" -f sql/schema.sql
```

Both methods will create the necessary tables (`slack_chunks` and `slack_channel_cursors`) with pgvector support.

### 3) Configure environment
Create a `.env` file in the project root:
```bash
# Create .env file
cat > .env << EOF
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here
PORT=3000
SYNC_INTERVAL_SECONDS=300
EOF
```

Then edit `.env` and replace the placeholder values with your actual Slack credentials (see "Slack App Configuration" section below for how to get these).

### 4) Install deps
```bash
npm i
```

---

## Slack App Configuration

### Step-by-Step: Creating Your Slack App

1. **Go to https://api.slack.com/apps** and click **"Create New App"**
   - Choose **"From scratch"**
   - Give it a name (e.g., "My RAG Bot")
   - Select your workspace

2. **Configure Bot Token Scopes** (OAuth & Permissions)
   - Go to **"OAuth & Permissions"** in the left sidebar
   - Scroll to **"Scopes"** → **"Bot Token Scopes"**
   - Add these 4 scopes (click "Add an OAuth Scope" for each):
     - `app_mentions:read` - To receive @mentions
     - `channels:read` - To list channels the bot is in
     - `channels:history` - To read message history for indexing
     - `chat:write` - To post responses

3. **Set Up ngrok Tunnel (Required for Event Subscriptions)**
   - Install ngrok if you haven't: `brew install ngrok` (Mac) or download from https://ngrok.com
   - In a terminal, run: `ngrok http 3000`
   - Copy the HTTPS URL shown (e.g., `https://abc123.ngrok.io`)
   - **Keep ngrok running** - you'll need this URL in the next step
   - Note: Free ngrok URLs change each time you restart it. For development, this is fine.

4. **Get Your Signing Secret (Needed for Bot)**
   - Go to **"Basic Information"** in the left sidebar
   - Scroll to **"App Credentials"**
   - Copy the **"Signing Secret"** - you'll need this for your bot
   - Click "Show" if it's hidden, then copy it

5. **Prepare Your Bot for URL Verification**
   - Create a `.env` file in your project root:
     ```bash
     SLACK_BOT_TOKEN=xoxb-placeholder-will-update-later
     SLACK_SIGNING_SECRET=your-signing-secret-from-step-4
     PORT=3000
     ```
   - Install dependencies if you haven't: `npm i`
   - **Start your bot**: `npm run bot` (in a terminal - keep it running)
   - You should see: `⚡️ Slack RAG bot running on port 3000`
   - **Important**: The bot must be running for Slack to verify the URL

6. **Enable Event Subscriptions**
   - Go to **"Event Subscriptions"** in the left sidebar
   - Toggle **"Enable Events"** to ON (if not already on)
   - In the **"Request URL"** field, enter: `https://your-ngrok-url.ngrok.io/slack/events`
     - Replace `your-ngrok-url.ngrok.io` with your actual ngrok URL from step 3
     - Make sure it ends with `/slack/events`
   - **Click away from the field** or press Tab - Slack will automatically verify the URL
   - Wait for the green checkmark ✅ - this means Slack successfully verified your endpoint
   - If you see an error, check:
     - ✅ Your bot is running (`npm run bot` in another terminal)
     - ✅ ngrok is still running and showing the same URL
     - ✅ The URL format is correct: `https://xxx.ngrok.io/slack/events`
     - ✅ No firewall blocking the connection
   - Once verified, scroll down to **"Subscribe to bot events"**
   - Click **"Add Bot User Event"**
   - Type and select: `app_mentions`
   - Click **"Save Changes"** at the bottom of the page

7. **Enable Interactivity & Shortcuts** (Required for Button Actions)
   - Go to **"Interactivity & Shortcuts"** in the left sidebar
   - Toggle **"Interactivity"** to ON
   - In the **"Request URL"** field, enter: `https://your-ngrok-url.ngrok.io/slack/events`
     - Use the same ngrok URL from step 3 (same as Event Subscriptions)
     - Make sure it ends with `/slack/events`
   - **Click away from the field** or press Tab - Slack will automatically verify the URL
   - Wait for the green checkmark ✅ - this means Slack successfully verified your endpoint
   - If you see an error, check:
     - ✅ Your bot is running (`npm run bot` in another terminal)
     - ✅ ngrok is still running and showing the same URL
     - ✅ The URL format is correct: `https://xxx.ngrok.io/slack/events`
   - Click **"Save Changes"** at the bottom of the page
   - **Note**: This enables interactive buttons (like "Search All Channels" and approval buttons)

8. **Install App to Workspace**
   
   **Option A: Install from OAuth & Permissions page**
   - Go back to **"OAuth & Permissions"**
   - Scroll to **"OAuth Tokens for Your Workspace"** section
   - Click the green **"Install to Workspace"** button
   - **Important**: If a modal appears asking for a "reason" or "submit request", close it - you want the direct install, not a submission for review
   - Review the permissions and click **"Allow"** on the OAuth approval page
   
   **Option B: Install from Install App page (alternative)**
   - Go to **"Install App"** in the left sidebar (under Settings)
   - Click **"Install to Workspace"** button
   - Review permissions and click **"Allow"**
   
   After installation (either method):
   - Go back to **"OAuth & Permissions"** page
   - You'll see your **"Bot User OAuth Token"** (starts with `xoxb-`) in the "OAuth Tokens for Your Workspace" section
   - Copy this token - this is your `SLACK_BOT_TOKEN` for your `.env` file

8. **Update Your .env File with Bot Token**
   - Now that you have your `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, update your `.env` file:
     ```bash
     SLACK_BOT_TOKEN=xoxb-your-actual-token-here
     SLACK_SIGNING_SECRET=your-actual-signing-secret-here
     PORT=3000
     ```
   - Restart your bot: Stop it (Ctrl+C) and run `npm run bot` again
   - Your bot should now be fully configured and ready to receive events

9. **Invite Bot to Channels**
   - In Slack, go to any channel where you want the bot to work
   - Type `/invite @YourBotName` or add it via channel settings
   - The bot needs to be a member of channels to index them

### Environment Variables

Create a `.env` file in the project root:
```bash
# Required: Slack credentials
SLACK_BOT_TOKEN=xoxb-your-bot-token-here
SLACK_SIGNING_SECRET=your-signing-secret-here

# Optional: Server configuration
PORT=3000

# Optional: Sync configuration
SYNC_INTERVAL_SECONDS=300  # For sync:cron, seconds between syncs

# Optional: Ollama configuration (defaults shown)
OLLAMA_BASE_URL=http://localhost:11434
OLLAMA_EMBED_MODEL=nomic-embed-text
OLLAMA_CHAT_MODEL=llama3.1

# Optional: Indexing configuration
HISTORY_PAGE_LIMIT=200           # Messages per API call
MAX_MESSAGES_PER_WINDOW=20       # Max messages in a window chunk
MAX_WINDOW_MINUTES=10            # Max time span for a window chunk
BACKFILL_OLDEST_TS=              # Unix timestamp: only index messages after this (optional)
```

Then edit `.env` and replace the placeholder values with your actual Slack credentials (see "Slack App Configuration" section below for how to get these).

> **Note**: Keep your `.env` file private and never commit it to git!

---

## Run

### Start the bot
```bash
npm run bot
```

In a public channel where the bot is a member, try:
```
@yourbot what did we decide about deploys?
```

---

## Indexing (Fetching & Storing Chat History)

Before the bot can answer questions, you need to index (fetch and store) chat history from Slack channels into your local database.

### Prerequisites for Indexing

1. **Ollama must be running** with the embedding model:
   ```bash
   # Check if Ollama is running
   ollama list
   
   # If not running, start it (usually runs as a service)
   # Make sure you've pulled the models:
   ollama pull nomic-embed-text
   ollama pull llama3.1
   ```

2. **Database must be set up** (see Setup section above):
   - Postgres container running: `docker compose up -d`
   - Schema created: `psql "postgres://postgres:postgres@localhost:5432/slack_rag" -f sql/schema.sql`

3. **Bot must be invited to channels** you want to index:
   - In Slack, go to each channel
   - Type `/invite @YourBotName`
   - The bot can only index channels it's a member of

### How Indexing Works

The indexing process:
1. **Lists all public channels** the bot is a member of
2. **Fetches message history** from each channel (via Slack API)
3. **Groups messages** into chunks:
   - **Threads**: All messages in a thread become one chunk
   - **Windows**: Non-thread messages grouped by time (default: 20 messages or 10 minutes)
4. **Generates embeddings** using Ollama (`nomic-embed-text` model)
5. **Stores in database** with vector embeddings for similarity search
6. **Sets cursors** to track the last indexed message per channel

### Backfill ALL Channels (First Time)

This indexes **all historical messages** from all public channels the bot is in:

```bash
npm run backfill:all
```

**What happens:**
- Fetches complete message history from each channel
- Creates embeddings for each chunk (this can be slow for large channels)
- Stores everything in `slack_chunks` table
- Sets initial cursors in `slack_channel_cursors` table

**Output example:**
```
Found 5 public channels bot is a member of.

Backfilling #general (C1234567890)...
Indexed #general: 12 threads, 45 windows. Cursor=1234567890.123456

Backfilling #random (C0987654321)...
Indexed #random: 8 threads, 32 windows. Cursor=1234567890.654321

Backfill complete.
```

> ⚠️ **Warning**: Backfilling large channels can take a long time. For very active channels, consider limiting the date range by setting `BACKFILL_OLDEST_TS` in your `.env` file (Unix timestamp).

### Verify Indexing Worked

Check your database to see indexed chunks:

```bash
psql "postgres://postgres:postgres@localhost:5432/slack_rag" -c "SELECT channel_name, COUNT(*) as chunks, SUM(message_count) as total_messages FROM slack_chunks GROUP BY channel_name;"
```

You should see output like:
```
 channel_name | chunks | total_messages 
--------------+--------+----------------
 general      |     57 |            234
 random       |     40 |            189
```

### Optional: Limit Backfill Date Range

To only index recent messages (e.g., last 30 days), add to your `.env`:

```bash
# Only index messages from the last 30 days
BACKFILL_OLDEST_TS=$(date -v-30d +%s)  # Mac
# or
BACKFILL_OLDEST_TS=$(date -d '30 days ago' +%s)  # Linux
```

Then modify `backfill_all.js` to use this value in the `fetchHistory` call.

### Incremental Sync (After Initial Backfill)

Once you've done the initial backfill, use incremental sync to keep the index updated with new messages.

#### One-Time Sync

Fetches and indexes only **new messages** since the last sync (uses cursors from `slack_channel_cursors`):

```bash
npm run sync:once
```

**What happens:**
- Checks each channel's cursor (last indexed message timestamp)
- Fetches messages posted after that timestamp
- Indexes new threads and message windows
- Updates the cursor to the newest message

**Output example:**
```
Syncing 5 channels...
#general: 3 new-ish messages since 1234567890.123456
#general: cursor -> 1234567890.789012
#random: 0 new messages
Sync once complete.
```

#### Continuous Sync (Development)

Runs sync in a loop every `SYNC_INTERVAL_SECONDS` (default: 300 seconds = 5 minutes):

```bash
npm run sync:cron
```

This keeps running and will sync every 5 minutes. Press `Ctrl+C` to stop.

**Configure interval** in `.env`:
```bash
SYNC_INTERVAL_SECONDS=60  # Sync every minute
```

#### Production Sync (Recommended)

For production, use system cron instead of the Node.js loop:

```bash
# Add to crontab (runs every 5 minutes)
*/5 * * * * cd /path/to/slack-rag-bot && /usr/bin/node src/indexer/sync_once.js >> sync.log 2>&1
```

Or use Kubernetes CronJob, systemd timer, etc.

### Indexing Workflow Summary

1. **First time**: Run `npm run backfill:all` to index all historical messages
2. **Ongoing**: Run `npm run sync:once` periodically (or use cron) to index new messages
3. **Development**: Use `npm run sync:cron` for continuous syncing during development

---

## Safety model (v1)

Retrieval is filtered to `channel_id == event.channel`.

That means:
- public channel mention -> bot only searches that channel’s indexed chunks
- no cross-channel leakage in v1

If/when you want cross-channel search, you must add a permission check:
- verify the requesting user is a member of the channel you're retrieving from
- do not return content from private channels they can't access

---

## Extending normalization

We resolve `<@U123>` into `@username` using `users.info` with an in-memory cache:
- `src/slack/userResolver.js`
- `src/slack/normalize.js`

You can expand to resolve:
- links
- files
- message attachments
- display_name vs real_name preferences

---

## Troubleshooting

### Installation Error: "internal_error" when installing app

If you see `internal_error` when trying to install your app, try these solutions:

**1. Install Directly (Not Submit for Review)**
- For **development/personal use**, you should **"Install to Workspace"** directly
- Do NOT use "Submit Request" or "Submit to Slack Marketplace" 
- The "Install to Workspace" button should be in the **"OAuth & Permissions"** page, in the **"OAuth Tokens for Your Workspace"** section
- If you see a modal asking for a reason, that's for workspace approval - try closing it and using the direct install button instead

**2. Check Required Configuration First**
Before installing, make sure you've completed:
- ✅ Added all 4 required bot scopes (see step 2 in Slack App Configuration)
- ✅ Enabled Event Subscriptions (even if URL isn't set yet)
- ✅ Added `app_mentions` bot event

**3. Workspace Approval Required**
Some workspaces require admin approval for app installations:
- If your workspace has app approval enabled, you may need to:
  - Contact your Slack workspace admin
  - Or use a personal/development workspace for testing
  - The error might be because the approval request failed

**4. Try Alternative Installation Method**
- Go to **"Install App"** in the left sidebar (under Settings)
- Try installing from there instead of OAuth & Permissions page
- Or try the direct install URL: `https://api.slack.com/apps/YOUR_APP_ID/oauth`

**5. Check App Status**
- Make sure your app is not in "restricted" mode
- Go to **"Basic Information"** → Check if there are any warnings or restrictions
- Verify the app is set to "Development" mode (not "Distribution")

**6. Clear and Retry**
- Wait a few minutes and try again (Slack API might be temporarily unavailable)
- Try refreshing the page and attempting installation again
- Check Slack Status page: https://status.slack.com

**7. Verify Scopes Are Saved**
- Make sure you clicked "Save Changes" after adding scopes
- The scopes should appear in the list under "Bot Token Scopes"
- If scopes aren't saved, installation will fail

### Embedding dimension mismatch
If inserts fail with vector dimension errors:
- your embedding model output dim != DB schema `vector(N)`
Fix: update `sql/schema.sql` and recreate table (or make a new table).

### Slack rate limits
There is basic retry/backoff in `src/indexer/slackFetch.js`. For large workspaces, you may still need stronger throttling.

### Event Subscriptions won't enable or verify

**Issue: Can't enable Event Subscriptions or URL won't verify**

**1. Request URL Verification Fails**
- Make sure your bot is running: `npm run bot` (should show "⚡️ Slack RAG bot running on port 3000")
- Verify ngrok is running: Check the terminal where you ran `ngrok http 3000`
- Ensure the URL format is correct: `https://your-url.ngrok.io/slack/events`
- The URL must be HTTPS (not HTTP)
- Wait a few seconds after entering the URL - Slack needs time to verify
- Check your bot's terminal for any error messages

**2. URL Verification Error Messages**
- **"Invalid response"**: Your bot isn't running or isn't responding correctly
- **"Connection refused"**: ngrok isn't running or the URL is wrong
- **"Timeout"**: Your bot might be slow to respond - make sure it's running

**3. Can't Toggle "Enable Events"**
- You need to set a Request URL first before the toggle will work
- Enter a valid URL in the Request URL field
- Wait for it to verify (green checkmark)
- Then you can add bot events

**4. Can't Add Bot Events**
- Make sure "Enable Events" toggle is ON
- Make sure Request URL is verified (green checkmark)
- Try refreshing the page
- Make sure you click "Save Changes" after adding events

**5. URL Changes After Restarting ngrok**
- Free ngrok URLs change each time you restart
- If you restart ngrok, update the Request URL in Slack with the new URL
- Or use ngrok's paid plan for a static URL

**6. Testing Your Endpoint Manually**
You can test if your bot endpoint is working:
```bash
# In another terminal, test the endpoint
curl -X POST https://your-ngrok-url.ngrok.io/slack/events \
  -H "Content-Type: application/json" \
  -d '{"type":"url_verification","challenge":"test123"}'
```
This should return: `{"challenge":"test123"}`

### Bot not responding to mentions
- Check that Event Subscriptions Request URL is set and verified (green checkmark)
- Verify the bot is running: `npm run bot`
- Check that ngrok tunnel is active (if using local development)
- Verify bot is invited to the channel: `/invite @YourBotName`
- Check server logs for errors
- Make sure `app_mentions` event is added under "Subscribe to bot events"

### "Missing scope" errors
If you see scope errors when running indexing:
- Verify all 4 scopes are added: `app_mentions:read`, `channels:read`, `channels:history`, `chat:write`
- After adding scopes, you may need to **reinstall the app** to your workspace
- Go to OAuth & Permissions → Click "Reinstall to Workspace"

---

## License
MIT (do whatever you want).
