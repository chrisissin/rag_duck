export function decide(parsed, policy = null) {
  // Decision logic can be enhanced based on alert type and policy
  if (parsed.instance_name?.startsWith("-")) {
    return { decision: "AUTO_REPLACE" };
  }
  
  // Future: Add more sophisticated decision logic based on policy rules
  // For example, policy could have decision_rules field
  
  return { decision: "NEEDS_APPROVAL" };
}
