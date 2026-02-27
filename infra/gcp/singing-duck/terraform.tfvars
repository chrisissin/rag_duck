# Copy to terraform.tfvars and adjust.
# project_id must match your GCP project (e.g. singing-duck).

project_id = "sparx-sandbox"
region     = "us-central1"
db_tier    = "db-f1-micro"
db_name    = "slack_rag"
db_user    = "slack_rag_app"

# After first apply, set image and re-apply (or use deploy script to update image):
# cloud_run_agent_image = "gcr.io/singing-duck/slack-rag-bot"
# cloud_run_job_image   = "gcr.io/singing-duck/slack-rag-bot"

# Ollama: create managed Ollama Cloud Run service (default true)
create_ollama_service = true
# ollama_image            = "ollama/ollama"
# ollama_cpu              = "8"   # 8 = faster inference (default); Cloud Run max 8
# ollama_memory           = "8Gi" # 8Gi recommended for tinyllama + nomic-embed-text
# ollama_num_parallel     = "6"
# ollama_max_loaded_models = "2"

# Agent (slack-rag-bot): faster first response with min_instances=1 (costs more)
# agent_cpu    = "2"
# agent_memory = "2Gi"
# agent_min_instances = 1  # 0 = scale to zero (cold start ~5-10s on first request)

# Indexer job: lower delays = faster sync (watch Slack rate limits)
# indexer_cpu             = "2"
# indexer_memory          = "2Gi"
# indexer_channel_delay_ms  = "6000"  # Default 6s; was 12s (Slack tier 2: 20+ req/min)
# indexer_thread_delay_ms   = "1000"  # Default 1s; was 2s
# indexer_embed_concurrency = "4"     # Parallel embeddings per channel (faster indexer)

# If you use an external Ollama instead, set create_ollama_service = false and:
# ollama_base_url = "https://your-ollama-service-xxxx.run.app"

# Every 30 min (slack rate limits; job needs ~15-25 min with channel delays)
indexer_schedule = "*/30 * * * *"

# Custom domain: stable URL instead of *.run.app (requires Cloud DNS managed zone)
# create_custom_domain = true
# custom_domain       = "bot.example.com"
# dns_zone_name      = "my-zone"  # Creates A record when set

# Enterprise Grid: workspace ID (T-prefixed) when auth.test returns E-prefixed. Get from auth.teams.list or Slack admin.
# slack_team_id = "ERTQ7T98W"T015X06654Y ERTQ7T98W
slack_team_id = "ERTQ7T98W"