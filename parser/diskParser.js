import { validateParsedDiskAlert } from "./schema.js";

export async function parseDiskAlert(text) {
  const instance = text.match(/Disk utilization for\s+([a-z0-9\-]+)\s+([a-z0-9\-]+)/i);
  const tv = text.match(/threshold of\s+(\d+(?:\.\d+)?)\s+with a value of\s+(\d+(?:\.\d+)?)/i);

  return validateParsedDiskAlert({
    alert_type: "disk_utilization_low",
    project_id: instance?.[1] || null,
    instance_name: instance?.[2] || null,
    metric_labels: {},
    threshold_percent: tv ? Number(tv[1]) : null,
    value_percent: tv ? Number(tv[2]) : null,
    policy_name: null,
    condition_name: null,
    violation_started_raw: null,
    gcp_alert_url: null,
    confidence: 0.9,
    missing_fields: ["zone", "mig_name"],
    parse_method: "regex"
  });
}
