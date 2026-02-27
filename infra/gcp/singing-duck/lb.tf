# Load Balancer + Custom Domain for Cloud Run agent (optional)
# When create_custom_domain = true: creates LB, SSL cert, and reserves static IP for DNS A record
# Use with dns.tf to add a Cloud DNS A record pointing to this LB
# Requires custom_domain (e.g. bot.example.com) when create_custom_domain = true

# Serverless NEG for Cloud Run agent
resource "google_compute_region_network_endpoint_group" "agent_neg" {
  count                 = var.create_custom_domain ? 1 : 0
  name                  = "slack-rag-agent-neg"
  network_endpoint_type = "SERVERLESS"
  region                = var.region

  cloud_run {
    service = google_cloud_run_v2_service.agent.name
    url_mask = "/*"
  }
}

# Backend service
resource "google_compute_backend_service" "agent_backend" {
  count       = var.create_custom_domain ? 1 : 0
  name        = "slack-rag-agent-backend"
  protocol    = "HTTP"
  timeout_sec = 30

  backend {
    group = google_compute_region_network_endpoint_group.agent_neg[0].id
  }
}

# URL map
resource "google_compute_url_map" "agent_lb" {
  count           = var.create_custom_domain ? 1 : 0
  name            = "slack-rag-agent-lb"
  default_service = google_compute_backend_service.agent_backend[0].id
}

# Managed SSL certificate (provisioning takes 15-60 min)
resource "google_compute_managed_ssl_certificate" "agent_cert" {
  count   = var.create_custom_domain && var.custom_domain != "" ? 1 : 0
  name    = "slack-rag-agent-cert"
  managed {
    domains = [var.custom_domain]
  }
}

# HTTPS proxy
resource "google_compute_target_https_proxy" "agent_proxy" {
  count            = var.create_custom_domain ? 1 : 0
  name             = "slack-rag-agent-https-proxy"
  url_map          = google_compute_url_map.agent_lb[0].id
  ssl_certificates = var.custom_domain != "" ? [google_compute_managed_ssl_certificate.agent_cert[0].id] : []
}

# Global forwarding rule (reserves static IP)
resource "google_compute_global_forwarding_rule" "agent_https" {
  count                  = var.create_custom_domain ? 1 : 0
  name                   = "slack-rag-agent-https"
  target                 = google_compute_target_https_proxy.agent_proxy[0].id
  port_range             = "443"
  load_balancing_scheme = "EXTERNAL"
}
