# Cloud DNS: point a subdomain to the Cloud Run agent via Load Balancer
# Requires: create_custom_domain = true, dns_zone_name set, and domain in the zone
# Enable Cloud DNS API: dns.googleapis.com (added in apis.tf when create_custom_domain)
# Enable Cloud DNS API when using custom domain
resource "google_project_service" "dns" {
  count           = var.create_custom_domain ? 1 : 0
  project         = var.project_id
  service         = "dns.googleapis.com"
  disable_on_destroy = false
}

# A record pointing to the Load Balancer's static IP
resource "google_dns_record_set" "agent" {
  count        = var.create_custom_domain && var.dns_zone_name != "" && var.custom_domain != "" ? 1 : 0
  name         = "${var.custom_domain}."
  type         = "A"
  ttl          = 300
  managed_zone = var.dns_zone_name
  rrdatas      = [google_compute_global_forwarding_rule.agent_https[0].ip_address]

  depends_on = [google_project_service.dns]
}
