import { generateTerragruntAutoscalerDiff, generateMachineTypeDiff } from "./mcpClient.js";

async function formatActionTemplate(template, parsed, originalText = null, isGitPR = false, gcloudCommandTemplate = null, policy = null, actionDescription = null) {
  if (!template) {
    return null;
  }
  
  // Check if this is an MCP action template
  if (template.startsWith("MCP:")) {
    const mcpTool = template.substring(4); // Remove "MCP:" prefix
    
    // For git PR option, return templated request text
    if (isGitPR && mcpTool === "generate_terragrunt_autoscaler_diff") {
      return `I need the following information in this format to make you a PR for scaling up
-----
SCALEPRREQUEST
Start: mm hh dd MM * YYYY (eq "30 17 4 02 * 2026" for 17:30 Feb 2nd 2026) (UTC zone)
Duration: seconds (eq 7200 for 2 hours)
name: scale up name (eq big sale)
------`;
    }
    
    if (mcpTool === "execute_gcloud_scale_up") {
      const hideGcloudUi = process.env.HIDE_GCLOUD_SCALE_UP_UI === "true";
      if (hideGcloudUi) {
        // Show instruction only; hide gcloud command. Server.js will hide Approve/Reject via hideApproveButton.
        return actionDescription || null;
      }
      // For GCP command scale-up, format the command for display
      if (!gcloudCommandTemplate) {
        return `*GCP Scale-Up Command:*\n\n❌ No gcloud command template found in policy. Please add \`gcloud_command_template\` to the action template.`;
      }
      return `*GCP Scale-Up Command:*\n\`\`\`\n${gcloudCommandTemplate.trim()}\n\`\`\`\n\n✅ Ready to execute when approved`;
    }
    
    if (mcpTool === "generate_terragrunt_autoscaler_diff") {
      // Extract parameters from parsed data or use defaults
      const params = {
        serviceName: parsed.service_name || parsed.serviceName || "api",
        scheduleName: parsed.schedule_name || parsed.scheduleName || `scale-up-${Date.now()}`,
        scheduleExpression: parsed.schedule_expression || parsed.scheduleExpression || "s(local.sch_1730_utc) 12 $(local.sch_jan_2026)",
        durationSec: parsed.duration_sec || parsed.durationSec || "local.sch_02_hours",
        minReplicas: parsed.min_replicas || parsed.minReplicas || "local.sch_moderate_high",
        timeZone: parsed.time_zone || parsed.timeZone || "Etc/UTC"
      };
      
      try {
        const result = await generateTerragruntAutoscalerDiff(params);
        if (result.success && result.diff) {
          return `Generated terragrunt autoscaler configuration diff:\n\n\`\`\`diff\n${result.diff}\`\`\``;
        } else {
          return `Failed to generate autoscaler diff: ${result.error || "Unknown error"}`;
        }
      } catch (error) {
        return `Error generating autoscaler diff: ${error.message}`;
      }
    }
    
    if (mcpTool === "generate_machine_type_diff") {
      // Extract parameters from parsed data or use defaults
      let serviceName = parsed.service_name || parsed.serviceName || null;
      
      // Normalize service name: if it's in format like "mcoc-qaprod-mmakerd-drb", try to extract the service part
      // Pattern: {project}-{env}-{service-parts} -> extract {service-parts} and convert dashes to underscores
      if (serviceName && serviceName.includes('-')) {
        const parts = serviceName.split('-');
        // If it looks like "mcoc-qaprod-mmakerd-drb" (3+ parts), extract service part
        // Common patterns: "mcoc-qaprod-matchmakerd-drb" -> "matchmakerd_drb"
        //                  "mcoc-qaprod-mmakerd-drb" -> "mmakerd_drb" (might need manual fix)
        if (parts.length >= 3) {
          // Take the service parts (everything after project-env) and convert dashes to underscores
          const serviceParts = parts.slice(2).join('-');
          serviceName = serviceParts.replace(/-/g, '_');
        } else if (parts.length === 2) {
          // If it's just two parts, might be "env-service", take the service part
          serviceName = parts[1].replace(/-/g, '_');
        }
        // If it's a single part or already normalized, keep as-is
      }
      
      const params = {
        environment: parsed.environment || parsed.env || "qaprod",
        serviceName: serviceName,
        currentMachineType: parsed.current_machine_type || parsed.currentMachineType || null,
        targetMachineType: parsed.target_machine_type || parsed.targetMachineType || null
      };
      
      // Validate required parameters
      if (!params.serviceName || !params.currentMachineType || !params.targetMachineType) {
        return `Missing required parameters for machine type change. Need: service_name, current_machine_type, target_machine_type. Current values: ${JSON.stringify(params)}`;
      }
      
      try {
        const result = await generateMachineTypeDiff(params);
        if (result.success && result.diff) {
          return `Generated machine type change diff:\n\n\`\`\`diff\n${result.diff}\`\`\``;
        } else {
          return `Failed to generate machine type diff: ${result.error || "Unknown error"}`;
        }
      } catch (error) {
        return `Error generating machine type diff: ${error.message}`;
      }
    }
    
    if (mcpTool === "generate_scaling_schedule_yaml_diff") {
      // Extract parameters from parsed data
      const schedule = parsed.schedule || parsed.start || null;
      const duration = parsed.duration || parsed.duration_sec || null;
      const name = parsed.ticket_number || parsed.name || parsed.schedule_name || null;
      
      // Validate required parameters
      if (!schedule || !duration || !name) {
        return `Missing required parameters for scaling schedule. Need: schedule (mm hh dd MM * YYYY), duration (seconds), ticket_number. Current values: schedule=${schedule}, duration=${duration}, ticket_number=${name}`;
      }
      
      // Instead of executing, prepare and display the script that will be executed
      try {
        const { readFileSync } = await import("fs");
        const { join, dirname } = await import("path");
        const { fileURLToPath } = await import("url");
        
        const __filename = fileURLToPath(import.meta.url);
        const __dirname = dirname(__filename);
        const scriptPath = join(__dirname, "../../config/scale_pr.sh");
        let scriptContent = readFileSync(scriptPath, "utf-8");
        
        // Replace placeholders with user input (for preview)
        const ticketNumber = name.trim();
        const scheduleString = schedule.trim();
        const durationString = String(duration);
        
        scriptContent = scriptContent.replace(/REPLACEWITHSCHEDULENAME/g, ticketNumber);
        scriptContent = scriptContent.replace(/REPLACEWITHUSERINPUTSCHEDULE/g, scheduleString);
        scriptContent = scriptContent.replace(/REPLACEWITHUSERINPUTDURATION/g, durationString);
        scriptContent = scriptContent.replace(/# big sale/g, `# ${ticketNumber}`);
        scriptContent = scriptContent.replace(/feat: append big sale scaling schedule/g, `feat: append ${ticketNumber} scaling schedule`);
        
        // Return preview of the script that will be executed
        return `*Script that will be executed:*\n\n\`\`\`bash\n${scriptContent}\`\`\`\n\n*Parameters:*\n- Ticket Number: ${ticketNumber}\n- Schedule: ${scheduleString}\n- Duration: ${durationString} seconds`;
      } catch (error) {
        return `Error preparing scaling schedule script: ${error.message}`;
      }
    }

    if (mcpTool === "create_scaling_schedule_pr") {
      // Preview the YAML diff that will be added via GitHub API
      const schedule = parsed.schedule || parsed.start || null;
      const duration = parsed.duration || parsed.duration_sec || null;
      const name = parsed.ticket_number || parsed.name || parsed.schedule_name || null;

      if (!schedule || !duration || !name) {
        return `Missing required parameters. Need: schedule (mm hh dd MM * YYYY), duration (seconds), ticket_number. Current: schedule=${schedule}, duration=${duration}, ticket_number=${name}`;
      }

      const ticketNumber = String(name).trim();
      const scheduleString = String(schedule).trim();
      const filePath = "production/scaling_schedules/api_disconnect_gacha_login_tmt.yaml";
      const owner = policy?.github_owner || "?";
      const repo = policy?.github_repo || "?";

      const yamlBlock = `# ${ticketNumber}
- name                  : ${ticketNumber}
  schedule              : ${scheduleString}
  duration_sec          : ${duration}
  min_required_replicas : \${sch_high}
  time_zone             : Etc/UTC`;

      return `*PR that will be created (via GitHub API):*\n\n*Repo:* \`${owner}/${repo}\`\n*File:* \`${filePath}\`\n*Commit:* \`feat: append ${ticketNumber} scaling schedule\`\n\n*YAML to append:*\n\n\`\`\`yaml\n${yamlBlock}\n\`\`\`\n\n*Parameters:*\n- Name: ${ticketNumber}\n- Schedule: \`${scheduleString}\`\n- Duration: ${duration} seconds\n\n✅ Click *Approve & Execute* to create the PR`;
    }
    
    // For other MCP tools, return the tool name for now
    return `MCP tool: ${mcpTool}`;
  }
  
  // Regular template replacement
  let action = template;
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null && value !== undefined) {
      action = action.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
    }
  }
  return action;
}

function formatSummaryTemplate(template, actionOptions, parsed) {
  if (!template) {
    return actionOptions || "No action template available";
  }
  
  let summary = template.replace("{action_options}", actionOptions || "No actions available");
  for (const [key, value] of Object.entries(parsed)) {
    if (value !== null && value !== undefined) {
      summary = summary.replace(new RegExp(`\\{${key}\\}`, "g"), String(value));
    }
  }
  // Also support legacy {action} for backward compatibility
  if (template.includes("{action}") && actionOptions) {
    summary = summary.replace("{action}", actionOptions);
  }
  return summary;
}

export async function formatReport({ parsed, decision, policy = null, originalText = null }) {
  let action = null;
  let actionOptions = null;
  const actionList = [];
  
  // Handle multiple action templates (new format)
  if (policy?.action_templates && Array.isArray(policy.action_templates)) {
    for (const actionTemplate of policy.action_templates) {
      // Check if this is the git PR option (for scaling intent detection)
      // It's the git PR option if the label mentions "git pr" or if it uses terragrunt_autoscaler_diff for scaling
      const isGitPR = policy.alert_type === "scaling_intent_detected" && 
                     (actionTemplate.label?.toLowerCase().includes("git pr") || 
                      (actionTemplate.template?.includes("terragrunt_autoscaler_diff") && 
                       !actionTemplate.template?.includes("execute_gcloud")));
      const formattedAction = await formatActionTemplate(
        actionTemplate.template,
        parsed,
        originalText,
        isGitPR,
        actionTemplate.gcloud_command_template || null,
        policy,
        actionTemplate.description || null
      );

      if (formattedAction) {
        const hideGcloudUi = process.env.HIDE_GCLOUD_SCALE_UP_UI === "true";
        const isGcloudScaleUp = actionTemplate.template?.includes("execute_gcloud_scale_up");
        actionList.push({
          label: actionTemplate.label || "Action",
          description: actionTemplate.description || "",
          template: actionTemplate.template,
          gcloudCommandTemplate: actionTemplate.gcloud_command_template || null,
          action: formattedAction,
          hideApproveButton: hideGcloudUi && isGcloudScaleUp
        });
      }
    }
    
    // Format action options for summary
    if (actionList.length > 0) {
      actionOptions = actionList.map((opt, idx) => {
        return `*Option ${idx + 1}: ${opt.label}*\n${opt.description ? `${opt.description}\n` : ''}${opt.action}`;
      }).join('\n\n');
    }
    
    // For backward compatibility, set action to first option or combined
    action = actionOptions || actionList[0]?.action || null;
  } 
  // Handle single action template (legacy format)
  else if (policy?.action_template) {
    action = await formatActionTemplate(policy.action_template, parsed, originalText, false, null, policy);
    actionOptions = action;
  }
  
  // If we have multiple action options, don't include them in the summary
  // (they'll be displayed separately in the UI with individual buttons)
  const hasMultipleOptions = actionList.length > 0;
  let summaryTemplate = policy?.summary_template;
  if (hasMultipleOptions && summaryTemplate) {
    // Remove {action_options} from template when we have multiple options
    // They'll be shown as separate sections with buttons
    summaryTemplate = summaryTemplate.replace(/\{action_options\}/g, '');
    // Also remove {action} if present
    summaryTemplate = summaryTemplate.replace(/\{action\}/g, '');
  }
  
  const summary = summaryTemplate
    ? formatSummaryTemplate(summaryTemplate, hasMultipleOptions ? null : (actionOptions || action), parsed)
    : (hasMultipleOptions ? null : (actionOptions || action || "Approval required"));
  
  const report = {
    parsed,
    decision,
    action,
    actionOptions: actionList.length > 0 ? actionList : null, // Array of action options
    summary,
    policy, // Include policy so actionTemplate is available in button values
    mcp_executed: false,
    mcp_result: null
  };
  
  // Execute MCP action if decision is AUTO_REPLACE and MCP is enabled
  // if (decision.decision === "AUTO_REPLACE" && action && process.env.ENABLE_MCP === "true") {
  //   try {
  //     const mcpResult = await executeMCPAction(action, parsed);
  //     report.mcp_executed = true;
  //     report.mcp_result = mcpResult;
  //   } catch (error) {
  //     report.mcp_executed = false;
  //     report.mcp_error = error.message;
  //   }
  // }
  
  return report;
}
