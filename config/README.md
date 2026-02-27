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

## Help Triggers

The top-level `help_triggers` array defines regex patterns that show the bot's usage manual. When a user says `--help`, `who are you`, `man`, or similar, the bot responds with:

- Description of what it can do
- RAG history summary for the current channel (when in Slack)
- Currently supported policies (scaling intent for now)
- Note about adding more policies with platform engineers

Example:
```json
"help_triggers": [
  {"type": "regex", "pattern": "^(?:--help|-h|help)$"},
  {"type": "regex", "pattern": "who are you"},
  {"type": "regex", "pattern": "^(?:man|manual)$"},
  {"type": "regex", "pattern": "what can you do"}
]
```

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

## Scale PR Notify (scalepr_request)

For policies that create GitHub PRs (e.g. `action_template: "MCP:create_scaling_schedule_pr"`), you can optionally post a message to another Slack channel when the PR is created:

- `pr_notify_channel`: Channel to post to (e.g. `"#mcoc-be-pr"` or channel ID). Bot must be a member.
- `pr_notify_template`: Message template with placeholders: `{ticket_number}`, `{pr_url}`, `{jira_url}`, `{repo_name}`, `{github_owner}`
- `jira_base_url`: Base URL for Jira browse links (e.g. `"https://yourorg.atlassian.net/browse/"`). Used to build `{jira_url}`.

Example:
```json
"pr_notify_channel": "#mcoc-be-pr",
"pr_notify_template": "{ticket_number} scaling {repo_name}\nPR: {pr_url}\nJira: {jira_url}\nplease get @mcoc-release to review",
"jira_base_url": "https://explodingbarrel.atlassian.net/browse/"
```

You can include `@usergroup` or `@channel` in the template; Slack typically auto-parses valid mentions in posted messages.

### Channel Restriction (trigger_channel_only)

For `scalepr_request`, you can restrict PR creation to a specific channel. If a user sends SCALEPRREQUEST from another channel, they'll see the `scaling_intent_detected` output (prompt to use the format in the correct channel) instead:

```json
"trigger_channel_only": "#mcoc-server-scaling"
```

Omit this field or leave it empty to allow SCALEPRREQUEST from any channel.

