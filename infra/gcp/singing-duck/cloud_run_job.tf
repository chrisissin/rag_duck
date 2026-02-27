# Cloud Run Job: indexer (sync_once.js)
resource "google_cloud_run_v2_job" "indexer" {
  name     = "slack-rag-indexer"
  location = var.region
  depends_on = [
    google_project_service.run,
    google_vpc_access_connector.connector,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.slack_bot_token_placeholder,
  ]

  template {
    task_count = 1

    template {
      service_account = google_service_account.indexer.email
      max_retries     = 0
      timeout         = "1800s"

      vpc_access {
        connector = google_vpc_access_connector.connector.id
        egress    = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image   = local.job_image_for_deploy
        command = ["node"]
        args    = ["src/indexer/sync_once.js"]

        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "OLLAMA_BASE_URL"
          value = local.ollama_base_url
        }
        env {
          name  = "OLLAMA_EMBED_MODEL"
          value = "nomic-embed-text"
        }
        env {
          name  = "INDEXER_EMBED_CONCURRENCY"
          value = var.indexer_embed_concurrency
        }
        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.database_url.secret_id
              version = "latest"
            }
          }
        }
        env {
          name  = "SLACK_CHANNEL_DELAY_MS"
          value = var.indexer_channel_delay_ms
        }
        env {
          name  = "SLACK_THREAD_DELAY_MS"
          value = var.indexer_thread_delay_ms
        }
        dynamic "env" {
          for_each = var.slack_team_id != "" ? [1] : []
          content {
            name  = "SLACK_TEAM_ID"
            value = var.slack_team_id
          }
        }
        env {
          name = "SLACK_BOT_TOKEN"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.slack_bot_token.secret_id
              version = "latest"
            }
          }
        }

        resources {
          limits = {
            cpu    = var.indexer_cpu
            memory = var.indexer_memory
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
    ]
  }
}

output "indexer_job_name" {
  value       = google_cloud_run_v2_job.indexer.name
  description = "Cloud Run Job name for indexer (used by scheduler and deploy script)"
}
