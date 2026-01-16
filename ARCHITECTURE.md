# Architecture Overview

## Entry Point: `server.js`

The project now uses `src/server.js` as the unified entry point that handles:

1. **Slack Bot Events** - Receives and processes Slack mentions
2. **Web UI** - Serves a web interface and API endpoints
3. **Parse-Decide-Action Pipeline** - Processes alerts and makes decisions
4. **RAG Chat History** - Falls back to searching Slack history

## Architecture Flow

```
┌─────────────────────────────────────────────────────────┐
│                    server.js                            │
│  (ExpressReceiver + Slack Bolt App)                     │
└──────────────┬──────────────────────┬──────────────────┘
               │                      │
               │                      │
    ┌──────────▼──────────┐  ┌───────▼──────────┐
    │  Slack Events       │  │  Web API         │
    │  (app_mention)      │  │  (/api/analyze)  │
    │  channel_id: C123   │  │  channel_id: null│
    └──────────┬──────────┘  └───────┬──────────┘
               │                      │
               └──────────┬───────────┘
                          │
               ┌──────────▼──────────┐
               │  orchestrator.js    │
               │  processIncomingMessage() │
               └──────────┬──────────┘
                          │
        ┌─────────────────┴─────────────────┐
        │                                     │
┌───────▼────────┐                  ┌───────▼────────┐
│  Parser Engine │                  │  RAG System     │
│  (parseAlert)  │                  │  (retrieveContexts) │
│                │                  │                 │
│  ┌──────────┐  │                  │  Slack: Filter │
│  │ Policies │  │                  │  by channel_id │
│  │ (Pluggable│  │                  │  Web UI: All   │
│  │  per org)│  │                  │  channels      │
│  └────┬─────┘  │                  └───────┬────────┘
│       │        │                          │
│       │ Load from                        │
│       │ config/policies.json             │
│       │ (org-specific)                   │
│       │                                  │
└───────┼────────┘                  ┌───────▼────────┐
        │                           │  Build Prompt  │
        │ (if matched)              │  + Ollama Chat │
        │                           └────────────────┘
┌───────▼────────┐
│  Decision      │
│  (decide)      │
└───────┬────────┘
        │
        ├── AUTO_REPLACE ──► Execute via MCP (if enabled)
        │
        ├── NEEDS_APPROVAL ──► Slack: Request Approval
        │                      │
        │                      ├── User Approves ──► Execute via MCP
        │                      │
        │                      └── User Rejects ──► Cancel Action
        │
        └── NO_ACTION ──► Return message, no action taken
┌───────▼────────┐
│  Format Report │
│  (formatReport)│
└───────┬────────┘
        │
┌───────▼────────┐
│  MCP Client    │
│  (mcpClient)   │
│  ┌──────────┐  │
│  │ GCP MCP  │  │
│  │ Server   │  │
│  └──────────┘  │
└────────────────┘
```

### Key Architecture Features

**1. Pluggable Policies for Different Organizations**
- Policies are stored in `config/policies.json` (configurable via `POLICIES_PATH` env var)
- Each organization can maintain their own policies file without modifying core code
- Policies are excluded from git (via `.gitignore`) to allow organization-specific customization
- The parser engine automatically loads and applies policies at runtime
- No code changes needed to add new alert types - just update the JSON configuration

**2. RAG Behavior Differences**

**Slack Interface:**
- Provides RAG with **relevant channel history only**
- Filters chunks by `channel_id` matching the event's channel
- Ensures users only see context from channels they have access to
- Safe default: no cross-channel data leakage

**Web UI:**
- Combines **all history across all channels**
- Uses `channel_id: null` to search across all indexed chunks
- Provides comprehensive context for analysis
- Useful for cross-channel research and analysis

## Security & Privacy: Internal-Only Ecosystem

**Important**: This architecture is designed to keep all data processing internal and private:

- **All components run internally** - No external LLM APIs (OpenAI, Anthropic, etc.)
- **Local Ollama** - All LLM processing uses local Ollama instance (no data leaves your infrastructure)
- **Internal Database** - Postgres with pgvector runs locally/internally
- **Only Slack Interface is External** - The Slack API is the only external service (required for Slack integration)
- **No Data Training** - Internal data never reaches public models or external training systems
- **Privacy-First Design** - Ensures sensitive internal conversations and alerts remain within your organization

This design addresses concerns about:
- Internal data being used to train public models
- Data leakage to external services
- Compliance with data privacy regulations
- Control over sensitive organizational information

## Key Components

### 1. `server.js` (Entry Point)
- Uses `ExpressReceiver` from Slack Bolt to handle both Slack events and Express routes
- Serves web UI from `src/web/` directory
- Provides `/api/analyze` endpoint for web interface
- Handles Slack `app_mention` events

### 2. `orchestrator.js` (Core Logic)
- **Phase 1**: Tries to parse incoming text as an alert using `parseAlert()`
  - If matched → goes to decision engine
  - Always runs RAG in parallel (even if policy matched)
- **Phase 2**: Always searches Slack history using RAG
  - **Slack**: Filters by `channel_id` to get relevant channel history only
  - **Web UI**: Uses `channel_id: null` to search across all channels
  - Retrieves relevant context from indexed messages
  - Generates answer using Ollama
- **Phase 3**: Combines results
  - If both policy and RAG matched → returns both results
  - If only one matched → returns that result
  - Provides comprehensive response with policy actions and historical context

### 3. Parser Engine (`parser/parserEngine.js`)
- **Policy-based parsing** (regex patterns)
  - Loads policies from `config/policies.json` (organization-specific)
  - Each organization can customize policies without code changes
  - Policies are pluggable via `POLICIES_PATH` environment variable
  - Supports multiple alert types with pattern matching and extraction rules
- **LLM-based parsing** (fallback)
  - Uses Ollama when policy parsing fails
  - Handles novel alert formats not covered by policies
- Returns structured alert data

### 4. Decision Engine (`decision/decide.js`)
- Makes decisions based on parsed alerts
- Returns `AUTO_REPLACE`, `NEEDS_APPROVAL`, or `NO_ACTION`
- **AUTO_REPLACE**: Action is executed immediately via MCP (if enabled)
- **NEEDS_APPROVAL**: Slack bot requests user approval with interactive buttons
- **NO_ACTION**: No action is taken, message is returned to user

### 5. Report Formatter (`report/formatReport.js`)
- Formats the final report/action
- Executes MCP actions automatically if decision is `AUTO_REPLACE` and MCP is enabled
- For `NEEDS_APPROVAL`, returns action details for Slack approval UI

### 6. Approval Flow (Slack Integration)
- When decision is `NEEDS_APPROVAL`, Slack bot posts message with approval buttons
- User can click "✅ Approve & Execute" or "❌ Reject"
- On approval, action is executed via MCP client
- On rejection, action is cancelled and message is updated

### 7. MCP Client & Server (`report/mcpClient.js`, `services/automation/gcpMcpServer.js`)
- **MCP Client**: Communicates with MCP server to execute actions
- **MCP Server**: GCP automation server running as a local service
  - Tool: `discover_instance_metadata` - Finds zone and MIG for an instance
  - Tool: `execute_recreate_instance` - Recreates instance in Managed Instance Group
- Server runs via stdio transport and can be started with `npm run mcp:server`

### 6. RAG System (`rag/`)
- `retrieve.js` - Searches indexed chunks
  - **Slack**: Filters by `channel_id` for channel-specific context
  - **Web UI**: Searches all channels when `channel_id` is null
- `prompt.js` - Builds prompts for LLM
- `ollama.js` - Interfaces with Ollama

**RAG Channel Filtering:**
- The `searchSimilar()` function in `db/slackChunksRepo.js` handles channel filtering
- When `channel_id` is provided (Slack), it filters: `WHERE channel_id = $2`
- When `channel_id` is null/undefined (Web UI), it searches all: no WHERE clause
- This ensures Slack users only see relevant channel history, while Web UI provides comprehensive cross-channel context

## Running the Server

```bash
# Start the unified server (handles both Slack and Web)
npm start
# or
npm run server

# Legacy: Run old bot.js (Slack only)
npm run bot

# Indexing (unchanged)
npm run backfill:all
npm run sync:once
```

## Endpoints

- **Slack Events**: `POST /slack/events` (handled by Slack Bolt)
- **Web UI**: `GET /` (serves `src/web/index.html`)
- **API**: `POST /api/analyze` (accepts `{ text: "..." }`)

## Environment Variables

Required:
- `SLACK_BOT_TOKEN` - Bot token from Slack
- `SLACK_SIGNING_SECRET` - Signing secret from Slack

Optional:
- `PORT` - Server port (default: 3000)
- `OLLAMA_BASE_URL` - Ollama URL (default: http://localhost:11434)
  - **Note**: Should point to internal/local Ollama instance, not external APIs
- `OLLAMA_EMBED_MODEL` - Embedding model (default: nomic-embed-text)
- `OLLAMA_CHAT_MODEL` - Chat model (default: llama3.1)
- `ENABLE_MCP` - Enable MCP actions (default: false)

**Data Privacy Note**: All LLM operations use local Ollama. No data is sent to external LLM services (OpenAI, Anthropic, etc.) to ensure internal data privacy and prevent training of public models with your organization's data.
