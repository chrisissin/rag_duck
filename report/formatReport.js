import { executeMCPAction } from "./mcpClient.js";

function formatActionTemplate(template, parsed) {
  if (!template) {
    return null;
  }
  
  let action = template;
  // Replace placeholders with actual values
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null && value !== undefined) {
      action = action.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
    }
  }
  return action;
}

function formatSummaryTemplate(template, action, parsed) {
  if (!template) {
    return action || "No action template available";
  }
  
  let summary = template.replace("{action}", action || "No action");
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null && value !== undefined) {
      summary = summary.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
    }
  }
  return summary;
}

export async function formatReport({ parsed, decision, policy = null }) {
  const action = policy?.action_template 
    ? formatActionTemplate(policy.action_template, parsed)
    : null;
  
  const summary = policy?.summary_template
    ? formatSummaryTemplate(policy.summary_template, action, parsed)
    : (action || "Approval required");
  
  const report = {
    parsed,
    decision,
    action,
    summary,
    mcp_executed: false,
    mcp_result: null
  };
  
  // Execute MCP action if decision is AUTO_REPLACE and MCP is enabled
  if (decision.decision === "AUTO_REPLACE" && action && process.env.ENABLE_MCP === "true") {
    try {
      const mcpResult = await executeMCPAction(action, parsed);
      report.mcp_executed = true;
      report.mcp_result = mcpResult;
    } catch (error) {
      report.mcp_executed = false;
      report.mcp_error = error.message;
    }
  }
  
  return report;
}
