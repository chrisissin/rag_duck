# Cloud Run service (agent) and job (indexer)
locals {
  # Placeholder image so Terraform can create resources before app is built; deploy script updates image
  placeholder_image     = "us-docker.pkg.dev/cloudrun/container/hello"
  agent_image_for_deploy = local.agent_image != "" ? local.agent_image : local.placeholder_image
  job_image_for_deploy   = local.job_image != "" ? local.job_image : local.agent_image_for_deploy
}

resource "google_cloud_run_v2_service" "agent" {
  name     = "slack-rag-bot"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"
  depends_on = [
    google_project_service.run,
    google_vpc_access_connector.connector,
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.slack_bot_token_placeholder,
    google_secret_manager_secret_version.slack_signing_secret_placeholder,
    google_secret_manager_secret_version.github_token_placeholder,
  ]

  template {
    service_account = google_service_account.agent.email
    scaling {
      min_instance_count = var.agent_min_instances
      max_instance_count = 10
    }
    max_instance_request_concurrency = 80
    timeout                          = "300s"

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.agent_image_for_deploy

      ports {
        container_port = 8080
      }

      # PORT is set automatically by Cloud Run
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      env {
        name  = "OLLAMA_BASE_URL"
        value = local.ollama_base_url
      }
      env {
        name  = "OLLAMA_CHAT_MODEL"
        value = "tinyllama"
      }
      env {
        name  = "OLLAMA_EMBED_MODEL"
        value = "nomic-embed-text"
      }
      env {
        name  = "OLLAMA_MODEL"
        value = "tinyllama"
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
        name = "SLACK_BOT_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.slack_bot_token.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "SLACK_SIGNING_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.slack_signing_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "GITHUB_TOKEN"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.github_token.secret_id
            version = "latest"
          }
        }
      }

      env {
        name  = "ENABLE_MCP"
        value = tostring(var.enable_mcp)
      }
      env {
        name  = "DISABLE_SCALING_INTENT_DETECTION"
        value = tostring(var.disable_scaling_intent_detection)
      }
      env {
        name  = "DISABLE_ADD_MEMORY_DETECTION"
        value = tostring(var.disable_add_memory_detection)
      }
      env {
        name  = "DISABLE_APPROVAL_BUTTONS"
        value = tostring(var.disable_approval_buttons)
      }
      env {
        name  = "HIDE_GCLOUD_SCALE_UP_UI"
        value = tostring(var.hide_gcloud_scale_up_ui)
      }

      resources {
        limits = {
          cpu    = var.agent_cpu
          memory = var.agent_memory
        }
        cpu_idle          = true
        startup_cpu_boost = true  # Faster cold start when scaling from zero
      }

      startup_probe {
        http_get {
          path = "/"
          port = 8080
        }
        initial_delay_seconds = 5
        timeout_seconds       = 3
        period_seconds        = 10
        failure_threshold     = 3
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }
}

# Allow unauthenticated so Slack can reach the webhook (or use IAP if you prefer)
resource "google_cloud_run_v2_service_iam_member" "agent_public" {
  name     = google_cloud_run_v2_service.agent.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}
