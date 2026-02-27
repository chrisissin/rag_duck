# GCP project and region for singing-duck (Option 1: Cloud Run)
variable "project_id" {
  type        = string
  description = "GCP project ID (e.g. singing-duck-boso)"
  default     = "singing-duck-boso"
}

variable "region" {
  type        = string
  description = "Region for Cloud Run, Cloud SQL, and scheduler"
  default     = "us-central1"
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL instance tier"
  default     = "db-f1-micro"
}

variable "db_name" {
  type        = string
  description = "PostgreSQL database name"
  default     = "slack_rag"
}

variable "db_user" {
  type        = string
  description = "PostgreSQL user name (password stored in Secret Manager)"
  default     = "slack_rag_app"
}

variable "indexer_schedule" {
  type        = string
  description = "Cron schedule for indexer job (e.g. every 30 min; avoid overlaps with job timeout)"
  default     = "*/30 * * * *"
}

variable "cloud_run_agent_image" {
  type        = string
  description = "Container image for the agent (e.g. gcr.io/singing-duck/slack-rag-bot)"
  default     = ""
}

variable "cloud_run_job_image" {
  type        = string
  description = "Container image for the indexer job (usually same as agent)"
  default     = ""
}

variable "ollama_base_url" {
  type        = string
  description = "Ollama service URL (Cloud Run URL or VM internal URL). Leave empty to set after deploy."
  default     = ""
}

variable "create_ollama_service" {
  type        = bool
  description = "Create Ollama as a Cloud Run service and set agent OLLAMA_BASE_URL to it"
  default     = true
}

variable "ollama_image" {
  type        = string
  description = "Container image for Ollama (e.g. ollama/ollama)"
  default     = "ollama/ollama"
}

variable "ollama_cpu" {
  type        = string
  description = "CPU allocation for Ollama (4–8 for faster inference; Mac local often feels faster due to Apple Silicon)"
  default     = "8"
}

variable "ollama_memory" {
  type        = string
  description = "Memory for Ollama (8Gi recommended for faster inference; Cloud Run max 32Gi)"
  default     = "8Gi"
}

variable "ollama_num_parallel" {
  type        = string
  description = "Max parallel Ollama requests (default 6; helps avoid 429 when parser + embedding + chat run concurrently)"
  default     = "6"
}

variable "ollama_max_loaded_models" {
  type        = string
  description = "Max loaded models (default 2 for nomic-embed-text + tinyllama/llama)"
  default     = "2"
}

variable "agent_cpu" {
  type        = string
  description = "Agent Cloud Run CPU (2–4; bot is mostly I/O bound waiting on Ollama)"
  default     = "2"
}

variable "agent_memory" {
  type        = string
  description = "Agent Cloud Run memory"
  default     = "2Gi"
}

variable "agent_min_instances" {
  type        = number
  description = "Min agent instances (0=scale to zero, 1=always warm for faster first response)"
  default     = 1
}

variable "indexer_cpu" {
  type        = string
  description = "Indexer job CPU (bottleneck is Ollama, not local compute)"
  default     = "2"
}

variable "indexer_memory" {
  type        = string
  description = "Indexer job memory"
  default     = "2Gi"
}

variable "indexer_channel_delay_ms" {
  type        = string
  description = "Delay between Slack channel fetches (lower=faster, may hit rate limits)"
  default     = "6000"
}

variable "indexer_thread_delay_ms" {
  type        = string
  description = "Delay between Slack thread fetches (lower=faster)"
  default     = "1000"
}

variable "indexer_embed_concurrency" {
  type        = string
  description = "Parallel embedding requests per channel (4–6 when Ollama has OLLAMA_NUM_PARALLEL >= 4)"
  default     = "4"
}

# Custom domain (Load Balancer + Cloud DNS)
variable "create_custom_domain" {
  type        = bool
  description = "Create load balancer + static IP for custom domain. Set dns_zone_name to add Cloud DNS A record."
  default     = false
}

variable "custom_domain" {
  type        = string
  description = "Custom domain for the agent (e.g. bot.example.com). Required when create_custom_domain = true."
  default     = ""
}

variable "dns_zone_name" {
  type        = string
  description = "Name of existing Cloud DNS managed zone. When set with create_custom_domain, creates A record."
  default     = ""
}

variable "slack_team_id" {
  type        = string
  description = "Workspace ID (T-prefixed) for Enterprise Grid. Required when auth.test returns E-prefixed ID. e.g. T0G9PQBBK"
  default     = ""
}

# Agent feature flags (match env.example)
variable "enable_mcp" {
  type        = bool
  description = "Enable MCP server for GCP automation"
  default     = true
}

variable "disable_scaling_intent_detection" {
  type        = bool
  description = "Disable scaling intent detection in orchestrator"
  default     = false
}

variable "disable_add_memory_detection" {
  type        = bool
  description = "Disable add-memory intent detection"
  default     = false
}

variable "disable_approval_buttons" {
  type        = bool
  description = "Disable approval buttons globally"
  default     = false
}

variable "hide_gcloud_scale_up_ui" {
  type        = bool
  description = "For execute_gcloud_scale_up: show instruction only; hide gcloud command and Approve/Reject buttons"
  default     = false
}
