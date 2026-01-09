# Policy Configuration

This directory contains organization-specific policy configurations for the alert parser.

## Setup

1. Copy the example file to create your policies:
   ```bash
   cp policies.json.example policies.json
   ```

2. Edit `policies.json` to add your organization's alert parsing rules.

## File Structure

- `policies.json.example` - Example policy configuration (included in repository)
- `policies.json` - Your organization's policies (excluded from git via `.gitignore`)

## Configuration

The policies file path can be configured via the `POLICIES_PATH` environment variable:

```bash
export POLICIES_PATH=/path/to/your/policies.json
```

If not set, it defaults to `config/policies.json` in the project root.

## Policy Format

Each policy in the `policies` array should have:

- `alert_type`: Unique identifier for the alert type
- `name`: Human-readable name
- `patterns`: Array of regex patterns with capture groups
- `extraction_rules`: Default values and metadata
- `action_template`: Template for generating remediation commands
- `summary_template`: Template for generating summary messages
- `sample_texts`: Example alert texts for testing

See `policies.json.example` for a complete example.

