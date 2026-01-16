/**
 * Decision Engine
 * Reads decision rules from policy configuration
 * Supports:
 * - default_decision: Default decision if no rules match
 * - decision_rules: Array of conditional rules
 *   - condition: Object with field conditions (e.g., { instance_name: { startsWith: "prefix" } })
 *   - decision: Decision to return if condition matches
 */
export function decide(parsed, policy = null) {
  // If no policy provided, return NO_ACTION
  if (!policy) {
    return { decision: "NO_ACTION" };
  }

  // Check if policy has decision_rules
  if (policy.decision_rules && Array.isArray(policy.decision_rules)) {
    // Evaluate each rule in order
    for (const rule of policy.decision_rules) {
      if (evaluateCondition(rule.condition, parsed)) {
        return { decision: rule.decision };
      }
    }
  }

  // Use default_decision from policy if available
  if (policy.default_decision) {
    return { decision: policy.default_decision };
  }

  // Fallback to NO_ACTION
  return { decision: "NO_ACTION" };
}

/**
 * Evaluate a condition against parsed data
 * Supports:
 * - startsWith: String field starts with value
 * - equals: Field equals value
 * - contains: String field contains value
 * - matches: String field matches regex pattern
 */
function evaluateCondition(condition, parsed) {
  if (!condition || typeof condition !== "object") {
    return false;
  }

  // Check each field condition
  for (const [field, fieldCondition] of Object.entries(condition)) {
    const fieldValue = parsed[field];
    
    if (fieldCondition === null || fieldCondition === undefined) {
      // Check if field is null/undefined
      if (fieldValue === null || fieldValue === undefined) {
        continue;
      } else {
        return false;
      }
    }

    if (typeof fieldCondition === "object") {
      // Handle object conditions (e.g., { startsWith: "prefix" })
      if (fieldCondition.startsWith) {
        if (!fieldValue || !String(fieldValue).startsWith(fieldCondition.startsWith)) {
          return false;
        }
      } else if (fieldCondition.equals) {
        if (fieldValue !== fieldCondition.equals) {
          return false;
        }
      } else if (fieldCondition.contains) {
        if (!fieldValue || !String(fieldValue).includes(fieldCondition.contains)) {
          return false;
        }
      } else if (fieldCondition.matches) {
        const regex = new RegExp(fieldCondition.matches);
        if (!fieldValue || !regex.test(String(fieldValue))) {
          return false;
        }
      } else {
        // Unknown condition type
        return false;
      }
    } else {
      // Simple equality check
      if (fieldValue !== fieldCondition) {
        return false;
      }
    }
  }

  return true;
}
