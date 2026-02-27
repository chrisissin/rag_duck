# GCP Environment: singing-duck (Option 1 — Cloud Run)

This folder contains **Infrastructure as Code** and scripts to create the GCP environment for the Slack RAG Bot using **Architecture Option 1: Cloud Run (Serverless)** as described in [docs/GCP_ARCHITECTURE_OPTIONS.md](../../../docs/GCP_ARCHITECTURE_OPTIONS.md).

Project name: **singing-duck** (configurable via `project_id`).

**Architecture note:** The **web/Slack server** and the **MCP server** run in the **same Cloud Run service** (one container). The agent process spawns the MCP server as a child when needed. All services (agent, indexer, Ollama, DB) start or run automatically — no manual start. See [docs/CICD.md](../../../docs/CICD.md) for details.

## What Gets Created

| Component | Resource | Purpose |
|-----------|----------|---------|
| **Agent** | Cloud Run Service `slack-rag-bot` | Express + Slack Bolt app; Slack webhooks, Web UI |
| **Indexer** | Cloud Run Job `slack-rag-indexer` | Runs `sync_once.js` to sync Slack → Postgres |
| **Scheduler** | Cloud Scheduler `slack-rag-indexer-trigger` | Triggers indexer job every 5 minutes |
| **Database** | Cloud SQL for PostgreSQL | Postgres 15 + pgvector (private IP) |
| **Secrets** | Secret Manager | `slack-bot-token`, `slack-signing-secret`, `database-url` |
| **Network** | VPC connector + Private Service Access | Cloud Run → Cloud SQL over private IP |
| **Ollama** | Cloud Run Service `ollama` (optional) | LLM service; agent `OLLAMA_BASE_URL` points here when `create_ollama_service = true` |

## Prerequisites

- **gcloud** CLI installed and logged in (`gcloud auth login`)
- **Application Default Credentials** for Terraform: `gcloud auth application-default login`
- **Terraform** >= 1.0
- **psql** (PostgreSQL client) — required for `enable-pgvector.sh`:
  ```bash
  brew install libpq && export PATH="$(brew --prefix libpq)/bin:$PATH"
  ```
- A **GCP project** (e.g. `singing-duck`) with **billing enabled**
- Your account must have **Owner** or **Editor** on the project (or roles: `compute.networkViewer`, `run.admin`, `secretmanager.admin`, etc.)

## 1. Create the GCP Project and Apply Terraform (one script)

From the **repository root** or from `infra/gcp/singing-duck/scripts`:

```bash
cd infra/gcp/singing-duck/scripts
chmod +x create-project-and-apply.sh

# Option A: Create project + apply (you'll be prompted to link billing if needed)
./create-project-and-apply.sh singing-duck

# Option B: With billing account (no prompt)
BILLING_ACCOUNT_ID=XXXXX-XXXXX-XXXXX ./create-project-and-apply.sh singing-duck
```

The script will:
1. Create the GCP project if it doesn’t exist
2. Link billing if `BILLING_ACCOUNT_ID` is set (or prompt you)
3. Run `terraform init`, `plan`, and `apply`

**Or** create the project and apply Terraform manually:

```bash
# Create project
gcloud projects create singing-duck --name="Singing Duck"

# Link billing (required for Cloud SQL, Cloud Run)
gcloud billing accounts list
gcloud billing projects link singing-duck --billing-account=YOUR_BILLING_ACCOUNT_ID

# Set default project
gcloud config set project singing-duck
```

## 2. Apply Terraform (if not using the script above)

From the **repository root** or from `infra/gcp/singing-duck`:

```bash
cd infra/gcp/singing-duck

# Optional: copy and edit variables
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars if you want a different project_id or region

# Initialize and apply
terraform init -upgrade
terraform plan -var="project_id=singing-duck"
terraform apply
```

Or use the script:

```bash
GCP_PROJECT_ID=singing-duck ./scripts/terraform-apply.sh
```

**Note:** The first apply creates the Cloud Run service and job with a placeholder image so that Terraform can create the resources. You will replace the image in step 5.

## 3. Set Slack Secrets

Replace the placeholder secret values with your real Slack app credentials:

```bash
# Slack Bot Token (starts with xoxb-)
echo -n "xoxb-your-bot-token" | ./scripts/set-secrets.sh slack-bot-token
# Slack Signing Secret (from App Credentials)
echo -n "your-signing-secret" | ./scripts/set-secrets.sh slack-signing-secret
```

Or with gcloud directly:

```bash
echo -n "xoxb-..." | gcloud secrets versions add slack-bot-token --data-file=- --project=singing-duck
echo -n "..." | gcloud secrets versions add slack-signing-secret --data-file=- --project=singing-duck
echo -n "ghp_..." | gcloud secrets versions add github-token --data-file=- --project=singing-duck
```

## 4. Enable pgvector and Create Schema

Run once to create the `vector` extension and app tables (`slack_chunks`, `slack_channel_cursors`):

```bash
./scripts/enable-pgvector.sh
```

This uses Cloud SQL Proxy + psql to:
- Create the pgvector extension
- Apply `sql/schema.sql` (creates tables)
- Grant privileges to the app user

## 5. Build and Deploy the App

From the **repository root**:

```bash
# Build container and deploy to Cloud Run (service + job)
GCP_PROJECT_ID=singing-duck ./infra/gcp/singing-duck/scripts/deploy.sh
```

This will:

1. Build the Docker image via Cloud Build and push to `gcr.io/singing-duck/slack-rag-bot`
2. Update the Cloud Run service **slack-rag-bot** with the new image
3. Update the Cloud Run job **slack-rag-indexer** with the new image
4. Pull Ollama models (nomic-embed-text, tinyllama) when `create_ollama_service = true` — Cloud Run has ephemeral storage, so models are pulled after each deploy. Use `SKIP_OLLAMA_PULL=1` to skip if models are already loaded.

## 6. Configure Slack App

1. Open [Slack API](https://api.slack.com/apps) → your app → **Event Subscriptions**.
2. Enable Events and set **Request URL** to:
   - `https://<agent-url>/slack/events`
   - The agent URL is printed by the deploy script, or run:
     ```bash
     gcloud run services describe slack-rag-bot --region=us-central1 --format='value(status.url)'
     ```
3. Subscribe to the bot events you need (e.g. `message.channels`, `app_mention`).
4. Install the app to your workspace if not already done.

## 7. Ollama — Pull Models (Required for RAG)

When **`create_ollama_service = true`** (default), Terraform creates a Cloud Run service **ollama** and sets the agent’s `OLLAMA_BASE_URL` to it. The image is `ollama/ollama`; you can tune CPU/memory via `ollama_cpu` and `ollama_memory` in `terraform.tfvars`. **Models are pulled automatically during `deploy.sh`** (Cloud Run has ephemeral storage; models are lost when the Ollama container is replaced). If you skip the pull or it fails, run manually:

```bash
./infra/gcp/singing-duck/scripts/pull-ollama-models.sh
```

Pulls **tinyllama** (chat) and **nomic-embed-text** (embeddings for RAG).

To use an **external** Ollama (e.g. your own VM), set `create_ollama_service = false` and `ollama_base_url = "https://..."` in `terraform.tfvars`, then re-apply.

## Terraform Files Reference

| File | Purpose |
|------|---------|
| `main.tf` | Provider, project data, locals |
| `variables.tf` | Input variables (project_id, region, db_*, etc.) |
| `apis.tf` | Enable GCP APIs (Run, SQL, Secret Manager, Scheduler, VPC Access, etc.) |
| `vpc.tf` | Private IP range, Private Service Access, VPC connector |
| `cloud_sql.tf` | Cloud SQL instance, database, user, random password |
| `secrets.tf` | Secret Manager secrets (Slack tokens, database URL) |
| `iam.tf` | Service accounts and IAM bindings |
| `cloud_run.tf` | Cloud Run service (agent) |
| `cloud_run_job.tf` | Cloud Run job (indexer) |
| `scheduler.tf` | Cloud Scheduler job to trigger indexer |
| `ollama.tf` | Ollama Cloud Run service (when `create_ollama_service = true`) |
| `outputs.tf` | Outputs (URLs, connection name, next steps) |

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/create-project-and-apply.sh` | Create GCP project (if needed), link billing, then Terraform init + plan + apply |
| `scripts/terraform-apply.sh` | Init + plan + apply Terraform (project must already exist) |
| `scripts/deploy.sh` | Build image and update Cloud Run service + job |
| `scripts/set-secrets.sh` | Add secret version from stdin |
| `scripts/enable-pgvector.sh` | Run `CREATE EXTENSION vector` and app schema in Cloud SQL |
| `scripts/pull-ollama-models.sh` | Pull chat + embedding models on Ollama Cloud Run service |

## Performance Tuning (vs local Mac)

GCP Cloud Run can feel slower than running locally. To speed up:

| Component | Variable | Default | Tip |
|-----------|----------|---------|-----|
| **Ollama** | `ollama_cpu` | 8 | More CPU = faster inference (tinyllama, nomic-embed-text) |
| **Ollama** | `ollama_memory` | 8Gi | 8Gi recommended; max 32Gi |
| **Agent** | `agent_min_instances` | 0 | Set to 1 for always-warm (no cold start) |
| **Indexer** | `indexer_channel_delay_ms` | 6000 | Lower = faster (watch Slack rate limits) |
| **Indexer** | `indexer_embed_concurrency` | 4 | Parallel embeddings per channel |

In `terraform.tfvars`:
```hcl
ollama_cpu    = "8"
ollama_memory = "8Gi"
agent_min_instances = 1
indexer_channel_delay_ms = "6000"
indexer_embed_concurrency = "4"
```

## Custom Domain + Cloud DNS (Optional)

To keep a stable URL (e.g. `bot.example.com`) instead of the default `*.run.app` URL:

1. **Create a Cloud DNS managed zone** (if you don't have one) for your domain (e.g. example.com) in GCP Console → Network Services → Cloud DNS.

2. **Set in `terraform.tfvars`**:
   ```hcl
   create_custom_domain = true
   custom_domain       = "bot.example.com"   # Subdomain for the agent
   dns_zone_name      = "my-zone"            # Name of your Cloud DNS managed zone
   ```

3. **Run `terraform apply`** — Creates:
   - Load balancer in front of Cloud Run (with managed SSL cert)
   - Static IP for the LB
   - A record: `bot.example.com` → LB IP

4. **Update Slack** — Set Event Subscriptions Request URL to `https://bot.example.com/slack/events`.

5. **SSL cert provisioning** — Managed cert can take 15–60 minutes. Traffic works once it's active.

| Variable | Description |
|----------|-------------|
| `create_custom_domain` | Set `true` to create LB + static IP |
| `custom_domain` | Full domain (e.g. bot.example.com) |
| `dns_zone_name` | Cloud DNS zone name (creates A record when set) |

## Enterprise Grid (Slack)

When your Slack app is org-installed (`is_enterprise_install: true`), `auth.test` returns an E-prefixed ID. The indexer needs a T-prefixed workspace ID for `conversations.list`. Set in `terraform.tfvars`:

```hcl
slack_team_id = "T0G9PQBBK"  # Your workspace ID from auth.teams.list or Slack admin
```

## Cost (Approximate)

- Cloud Run: ~$20–50/month (traffic-dependent)
- Cloud SQL (db-f1-micro): ~$7/month
- Cloud Scheduler: ~$0.10/month
- Cloud Run Jobs: ~$5–10/month  
**Total: ~$32–67/month**

## Troubleshooting

- **"psql not found" when running enable-pgvector.sh** — Install the PostgreSQL client: `brew install libpq && export PATH="$(brew --prefix libpq)/bin:$PATH"`. Add that export to your shell profile for persistence.
- **SSL connection errors after enabling require_ssl** — The `database-url` secret includes `sslmode=require`. Re-run `terraform apply` and redeploy the app so Cloud Run picks up the new secret version. The `enable-pgvector.sh` script uses Cloud SQL Proxy (which uses encrypted connections) and does not need changes.
- **"connection requires a valid client certificate"** — Cloud SQL may be in strict SSL mode. Terraform sets `ssl_mode = "ENCRYPTED_ONLY"` to avoid client-cert requirement. Run `terraform apply` and check GCP Console → SQL → your instance → Connections: ensure it's not set to "Trusted client certificate required".
- **"Ollama embeddings failed: 429 Rate exceeded"** — The app now retries automatically (3 attempts with backoff). If it persists, the single Ollama instance may be overloaded. Increase `max_instance_request_concurrency` in `ollama.tf` (e.g. to 6) and redeploy, or run during lower-traffic periods.
- **"model nomic-embed-text not found"** or **"model tinyllama not found"** or **"retrieveContexts failed"** — Run `./scripts/pull-ollama-models.sh` to pull both models (tinyllama + nomic-embed-text). Both are required. First pull can take several minutes. See step 7.
- **"user does not have permission to access Project"** — Run `gcloud auth application-default login` and ensure your account has Owner or Editor on the project. Ensure `gcloud config set project YOUR_PROJECT_ID` matches your project.
- **"Compute Engine API has not been used... or it is disabled"** — The `create-project-and-apply.sh` script enables required APIs before Terraform. If running Terraform manually, run `gcloud services enable compute.googleapis.com run.googleapis.com vpcaccess.googleapis.com servicenetworking.googleapis.com --project=singing-duck`, wait 60s, then `terraform apply`.
- **API 403 "SERVICE_DISABLED" during apply** — APIs were enabled but hadn't propagated. Enable all APIs via gcloud (see above), wait 60–90s, then run `terraform plan -out=tfplan` and `terraform apply tfplan` again.
- **"Cannot modify allocated ranges in CreateConnection. Please use UpdateConnection. Existing allocated IP ranges: [default-ip-range]"** — A service networking connection already exists. Import it first: `terraform import google_service_networking_connection.private_vpc_connection projects/YOUR_PROJECT_ID/global/networks/default:servicenetworking.googleapis.com` then `terraform apply`.
- **"CloudSQL doesn't support IPv6" when running enable-pgvector.sh** — The script now uses `gcloud beta sql connect` (Cloud SQL Proxy). If you still hit this, ensure the beta components are installed: `gcloud components install beta`.

## Destroying

From `infra/gcp/singing-duck`:

```bash
terraform destroy
```

Answer `yes` when prompted. This removes Cloud Run, Cloud SQL, secrets, scheduler, and related resources.
