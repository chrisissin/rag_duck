# Autoheal MVP Architecture

## System Architecture Diagram

```mermaid
graph TB
    subgraph "Client Layer"
        UI[Web UI<br/>index.html]
    end
    
    subgraph "API Layer"
        Server[Express Server<br/>server.js]
        API[/api/analyze<br/>POST endpoint]
    end
    
    subgraph "Configuration (External)"
        Policies[Policy Config<br/>config/policies.json<br/>Organization-specific]
        PolicyExample[Example Config<br/>config/policies.json.example]
    end
    
    subgraph "Processing Pipeline"
        ParserEngine[Parser Engine<br/>parserEngine.js]
        PolicyParser[Policy Parser<br/>Regex Matching]
        LLMParser[LLM Parser<br/>Ollama Fallback]
        Schema[Schema Validator<br/>schema.js]
        Decision[Decision Engine<br/>decide.js]
        Report[Report Formatter<br/>formatReport.js]
        MCP[MCP Client<br/>mcpClient.js]
    end
    
    subgraph "External Services"
        Ollama[Ollama Server<br/>Local LLM]
        MCPServer[MCP Server<br/>Automation]
    end
    
    UI -->|POST /api/analyze<br/>JSON: text| API
    API -->|parseAlert| ParserEngine
    Policies -->|load from config| ParserEngine
    PolicyExample -.->|copy to create| Policies
    ParserEngine -->|try policy match| PolicyParser
    PolicyParser -->|if no match| LLMParser
    LLMParser -->|API call| Ollama
    PolicyParser -->|validated data| Schema
    LLMParser -->|validated data| Schema
    Schema -->|parsed alert| Decision
    Decision -->|decision + policy| Report
    Report -->|if AUTO_REPLACE| MCP
    MCP -->|execute action| MCPServer
    Report -->|formatted report| API
    API -->|JSON response| UI
    
    style UI fill:#e1f5ff
    style Server fill:#fff4e1
    style API fill:#fff4e1
    style Policies fill:#fff9c4
    style ParserEngine fill:#e8f5e9
    style PolicyParser fill:#e8f5e9
    style LLMParser fill:#e8f5e9
    style Schema fill:#e8f5e9
    style Decision fill:#f3e5f5
    style Report fill:#f3e5f5
    style MCP fill:#ffebee
    style Ollama fill:#e3f2fd
    style MCPServer fill:#e3f2fd
```

## Component Details

### Client Layer
- **Web UI** (`src/web/index.html`): Simple HTML interface with textarea for alert input and button to trigger analysis

### API Layer
- **Express Server** (`src/server.js`): 
  - Serves static web files
  - Exposes `/api/analyze` POST endpoint
  - Handles JSON request/response
  - Error handling for parsing failures

### Configuration Layer
- **Policy Configuration** (`config/policies.json`):
  - **Separated from core code** to allow open-sourcing the parser/decision engine
  - Each organization/project maintains their own policies file
  - Configurable via `POLICIES_PATH` environment variable (defaults to `config/policies.json`)
  - Example file provided: `config/policies.json.example`
  - Each policy defines:
    - `alert_type`: Type of alert (e.g., "disk_utilization_low", "cpu_utilization_high")
    - `patterns`: Array of regex patterns with capture groups
    - `extraction_rules`: Default values and metadata
    - `action_template`: Template for generating action commands
    - `summary_template`: Template for generating summary messages
    - `sample_texts`: Example alert texts for reference
  - Human-editable, allows easy extension for new alert types
  - Excluded from git (via `.gitignore`) so each organization can customize without conflicts

### Processing Pipeline

1. **Parser Engine** (`src/parser/parserEngine.js`):
   - Main entry point for alert parsing
   - Orchestrates policy-based and LLM parsing
   - **Policy Parser**: 
     - Loads policies from JSON configuration
     - Attempts to match alert text against regex patterns
     - Extracts structured data using capture groups
     - Fast and deterministic
   - **LLM Parser** (Fallback):
     - Invoked when policy parsing fails
     - Uses local Ollama LLM for intelligent parsing
     - Handles novel alert formats not covered by policies
     - Returns structured data matching the schema
     - Configurable via `OLLAMA_URL` and `OLLAMA_MODEL` environment variables
   - Returns parsed alert with matched policy (if applicable)

2. **Schema Validator** (`src/parser/schema.js`):
   - Uses Zod for schema validation
   - Generic `ParsedAlertSchema` supporting multiple alert types
   - Ensures parsed data matches expected structure
   - Validates types and required fields
   - Backward compatible with `ParsedDiskAlertSchema`

3. **Decision Engine** (`src/decision/decide.js`):
   - Makes auto-heal decision based on parsed data
   - Can use policy-specific decision rules (future enhancement)
   - Returns `AUTO_REPLACE` if instance_name starts with "-"
   - Returns `NEEDS_APPROVAL` otherwise
   - Extensible for more sophisticated decision logic

4. **Report Formatter** (`src/report/formatReport.js`):
   - Combines parsed data, decision, and policy
   - Formats action command using policy's `action_template`
   - Formats summary using policy's `summary_template`
   - Integrates with MCP client for automation
   - Returns comprehensive report with execution status

5. **MCP Client** (`src/report/mcpClient.js`):
   - Model Context Protocol integration for automation
   - Executes actions when decision is `AUTO_REPLACE`
   - Sends action commands and context to MCP server
   - Returns execution results and status
   - Enabled via `ENABLE_MCP=true` environment variable

## Data Flow

```
User Input (Alert Text)
    ↓
POST /api/analyze
    ↓
parseAlert()
    ↓
┌─────────────────────────────────┐
│ Try Policy-Based Parsing        │
│ - Load policies.json            │
│ - Match regex patterns          │
│ - Extract structured data       │
└─────────────────────────────────┘
    ↓ (if no match)
┌─────────────────────────────────┐
│ Try LLM Parsing (Fallback)      │
│ - Call Ollama API               │
│ - Use local LLM model           │
│ - Extract structured data       │
└─────────────────────────────────┘
    ↓
validateParsedAlert() → Zod validation
    ↓
decide() → Decision logic
    ↓
formatReport()
    ↓
┌─────────────────────────────────┐
│ If AUTO_REPLACE & MCP enabled:  │
│ - Format action from template   │
│ - Execute via MCP client        │
│ - Get execution result          │
└─────────────────────────────────┘
    ↓
JSON Response → { 
  parsed, 
  decision, 
  action, 
  summary, 
  mcp_executed, 
  mcp_result 
}
```

## Environment Variables

- `POLICIES_PATH`: Path to policies.json file (default: `config/policies.json`)
- `OLLAMA_URL`: URL of the Ollama server (default: `http://localhost:11434`)
- `OLLAMA_MODEL`: Model name to use for LLM parsing (default: `llama3`)
- `ENABLE_MCP`: Set to `"true"` to enable MCP automation
- `MCP_SERVER_URL`: URL of the MCP server endpoint
- `MCP_AUTH_TOKEN`: Optional authentication token for MCP server

## Dependencies

- **express**: Web server framework
- **zod**: Schema validation library

**Note**: LLM fallback requires Ollama to be running locally. Install from [ollama.ai](https://ollama.ai) and pull a model (e.g., `ollama pull llama3`).

## Extensibility

### Adding New Alert Types

1. Edit `config/policies.json` (copy from `config/policies.json.example` if needed):
   ```json
   {
     "alert_type": "memory_utilization_high",
     "name": "Memory Utilization High Alert",
     "patterns": [...],
     "extraction_rules": {...},
     "action_template": "...",
     "summary_template": "...",
     "sample_texts": [...]
   }
   ```

2. The parser engine will automatically pick it up (no code changes needed)

### Customizing Decision Logic

- Modify `src/decision/decide.js` to add policy-specific rules
- Future: Add `decision_rules` field to policies.json for declarative decision logic

### MCP Server Integration

- Configure MCP server URL and authentication
- MCP server should implement `execute_action` method
- Receives action command and parsed alert context
- Returns execution result

