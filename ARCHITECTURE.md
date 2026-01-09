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
│  Parser Engine │                  │  RAG Fallback  │
│  (parseAlert)  │                  │  (retrieveContexts) │
└───────┬────────┘                  └───────┬────────┘
        │                                   │
        │ (if matched)                      │ (if no match)
        │                                   │
┌───────▼────────┐                  ┌───────▼────────┐
│  Decision      │                  │  Build Prompt  │
│  (decide)      │                  │  + Ollama Chat  │
└───────┬────────┘                  └────────────────┘
        │
        │
┌───────▼────────┐
│  Format Report │
│  (formatReport)│
└────────────────┘
```

## Key Components

### 1. `server.js` (Entry Point)
- Uses `ExpressReceiver` from Slack Bolt to handle both Slack events and Express routes
- Serves web UI from `src/web/` directory
- Provides `/api/analyze` endpoint for web interface
- Handles Slack `app_mention` events

### 2. `orchestrator.js` (Core Logic)
- **Phase 1**: Tries to parse incoming text as an alert using `parseAlert()`
  - If matched → goes to decision engine
  - If not matched → falls back to RAG
- **Phase 2**: If not an alert, searches Slack history using RAG
  - Retrieves relevant context from indexed messages
  - Generates answer using Ollama

### 3. Parser Engine (`parser/parserEngine.js`)
- Policy-based parsing (regex patterns)
- LLM-based parsing (fallback)
- Returns structured alert data

### 4. Decision Engine (`decision/decide.js`)
- Makes decisions based on parsed alerts
- Returns `AUTO_REPLACE` or `NEEDS_APPROVAL`

### 5. Report Formatter (`report/formatReport.js`)
- Formats the final report/action
- Can execute MCP actions if enabled

### 6. RAG System (`rag/`)
- `retrieve.js` - Searches indexed chunks
- `prompt.js` - Builds prompts for LLM
- `ollama.js` - Interfaces with Ollama

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
- `OLLAMA_EMBED_MODEL` - Embedding model (default: nomic-embed-text)
- `OLLAMA_CHAT_MODEL` - Chat model (default: llama3.1)
- `ENABLE_MCP` - Enable MCP actions (default: false)

