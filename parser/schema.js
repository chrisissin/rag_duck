import { z } from "zod";

export const ParsedAlertSchema = z.object({
  alert_type: z.string(),
  project_id: z.string().nullable(),
  instance_name: z.string().nullable(),
  metric_labels: z.record(z.string()),
  threshold_percent: z.number().nullable(),
  value_percent: z.number().nullable(),
  policy_name: z.string().nullable(),
  condition_name: z.string().nullable(),
  violation_started_raw: z.string().nullable(),
  gcp_alert_url: z.string().nullable(),
  confidence: z.number(),
  missing_fields: z.array(z.string()),
  parse_method: z.string()
});

// Keep backward compatibility
export const ParsedDiskAlertSchema = ParsedAlertSchema.extend({
  alert_type: z.literal("disk_utilization_low")
});

export function validateParsedAlert(o) {
  return ParsedAlertSchema.parse(o);
}

export function validateParsedDiskAlert(o) {
  return ParsedDiskAlertSchema.parse(o);
}
