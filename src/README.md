# Autoheal MVP

An intelligent alert parsing and auto-healing system that processes PagerDuty alerts, makes decisions, and can automatically execute remediation actions via MCP (Model Context Protocol).

## Features

- **Extensible Policy-Based Parsing**: Define alert parsing rules in JSON configuration
- **LLM Fallback**: Automatically falls back to local Ollama LLM when policy parsing fails
- **Multi-Alert Type Support**: Handles disk, CPU, and other alert types through configurable policies
- **MCP Integration**: Automatically executes remediation actions via Model Context Protocol
- **Human-Readable Configuration**: Easy to extend with new alert types without code changes

## Quick Start

### Prerequisites

For LLM fallback parsing, you'll need Ollama running locally:

```bash
# Install Ollama from https://ollama.ai
# Then pull a model (e.g., llama3)
ollama pull llama3
```

### Running the Application

```bash
npm install
npm run dev
```

Open http://localhost:3000

**Note**: The system works without Ollama - policy-based parsing will still function. LLM fallback is only used when policy parsing fails.

## Configuration

### Environment Variables

Create a `.env` file (optional):

```bash
# Policies Configuration
# Path to your policies.json file (optional, defaults to config/policies.json)
POLICIES_PATH=config/policies.json

# Ollama Configuration (for LLM fallback parsing)
# Defaults to http://localhost:11434 if not set
OLLAMA_URL=http://localhost:11434
# Default model is "llama3" if not set
OLLAMA_MODEL=llama3

# Enable MCP automation (set to "true" to enable)
ENABLE_MCP=false

# MCP Server Configuration
MCP_SERVER_URL=http://localhost:8080/mcp
MCP_AUTH_TOKEN=your-mcp-auth-token
```

### Policy Configuration

**Important**: Policies are separated from the core code to allow each organization to customize them without modifying the source code.

1. **Create your policies file**:
   ```bash
   cp config/policies.json.example config/policies.json
   ```

2. **Edit `config/policies.json`** to add or modify alert parsing rules for your organization:

```json
{
  "alert_type": "your_alert_type",
  "name": "Human Readable Name",
  "patterns": [
    {
      "type": "regex",
      "pattern": "your-regex-pattern",
      "capture_groups": {
        "field_name": 1
      }
    }
  ],
  "extraction_rules": {
    "alert_type": "your_alert_type",
    "confidence": 0.9,
    "parse_method": "policy"
  },
  "action_template": "gcloud command with {placeholders}",
  "summary_template": "Summary text with {placeholders}",
  "sample_texts": ["example alert text"]
}
```

## How It Works

1. **Policy-Based Parsing**: The system first tries to match the alert text against configured regex patterns in `policies.json`
2. **LLM Fallback**: If no policy matches, it uses local Ollama LLM to intelligently parse the alert (requires Ollama running locally)
3. **Decision Making**: The decision engine determines if the alert can be auto-healed or needs approval
4. **Action Execution**: If `AUTO_REPLACE` and MCP is enabled, the system executes the remediation action via MCP

## API

### POST `/api/analyze`

Analyze an alert and get a decision with potential auto-heal action.

**Request:**
```json
{
  "text": "Disk utilization for project-123 instance-456 threshold of 80.0 with a value of 65.5"
}
```

**Response:**
```json
{
  "parsed": {
    "alert_type": "disk_utilization_low",
    "project_id": "project-123",
    "instance_name": "instance-456",
    "threshold_percent": 80.0,
    "value_percent": 65.5,
    "confidence": 0.9,
    "parse_method": "policy"
  },
  "decision": {
    "decision": "AUTO_REPLACE"
  },
  "action": "gcloud compute instance-groups managed recreate-instances <MIG> --instances=instance-456 --zone=<ZONE> --project=project-123",
  "summary": "Disk utilization below threshold. gcloud compute...",
  "mcp_executed": false,
  "mcp_result": null
}
```

## Architecture

See [ARCHITECTURE.md](./ARCHITECTURE.md) for detailed architecture documentation.

## Extending the System

### Adding a New Alert Type

1. Edit `config/policies.json` (copy from `config/policies.json.example` if it doesn't exist)
2. Add a new policy entry to the `policies` array
3. Define regex patterns to extract relevant fields
4. Specify action and summary templates
5. No code changes required! The parser engine will automatically pick up your new policy.

**Note**: The `config/policies.json` file is excluded from git (see `.gitignore`) so each organization can maintain their own policies without conflicts.

### Customizing Decision Logic

Edit `src/decision/decide.js` to add custom decision rules based on alert type, parsed data, or policy configuration.

### MCP Server Setup

The MCP client expects a server that accepts POST requests with:
- `method`: "execute_action"
- `params.action`: The action command to execute
- `params.context`: Alert context and parsed data

See `src/report/mcpClient.js` for implementation details.
