# Contributing

## Architecture Philosophy

This project is designed with a **separation of concerns** between:

1. **Core Engine** (Open Source): The parser engine, decision engine, and report formatter are generic and can be open-sourced.
2. **Organization Policies** (Private): Each organization maintains their own `config/policies.json` file with their specific alert parsing rules.

## Policy Configuration

Policies are stored separately from the code to allow:

- **Open-sourcing** the core parser/decision engine without exposing organization-specific configurations
- **Easy customization** - organizations can add their own alert types without modifying source code
- **Version control** - each organization can maintain their own policies in their own repositories
- **Security** - sensitive patterns, project IDs, and action templates stay private

## File Structure

```
autoheal-mvp/
├── src/                    # Core engine (open source)
│   ├── parser/
│   │   ├── parserEngine.js  # Generic parser engine
│   │   └── schema.js        # Generic schema validation
│   ├── decision/
│   │   └── decide.js        # Generic decision engine
│   └── report/
│       └── formatReport.js  # Generic report formatter
├── config/                  # Organization-specific (not in git)
│   ├── policies.json        # Your organization's policies
│   └── policies.json.example # Example template
└── .gitignore              # Excludes config/policies.json
```

## For Open Source Maintainers

When open-sourcing the core engine:

1. The `src/` directory contains all generic, reusable code
2. `config/policies.json` is excluded from the repository (via `.gitignore`)
3. `config/policies.json.example` provides a template for users
4. The parser engine loads policies from a configurable path (via `POLICIES_PATH` env var)

## For Organizations Using This Code

1. Copy `config/policies.json.example` to `config/policies.json`
2. Customize the policies for your alert types
3. The core engine will automatically use your policies
4. Keep your `config/policies.json` in your own private repository

## Adding New Alert Types

No code changes needed! Just add a new policy entry to `config/policies.json`:

```json
{
  "alert_type": "your_alert_type",
  "name": "Your Alert Name",
  "patterns": [...],
  "extraction_rules": {...},
  "action_template": "...",
  "summary_template": "...",
  "sample_texts": [...]
}
```

The parser engine will automatically pick it up on the next request.

