import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import { WebClient } from "@slack/web-api";
import { withSlackRetry } from "./slack/retry.js";
import { processIncomingMessage } from "./orchestrator.js";
import { isHelpRequest, buildHelpMessage } from "./help/buildHelpMessage.js";
import { UserResolver } from "./slack/userResolver.js";
import { normalizeSlackText } from "./slack/normalize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Resolve channel ref (#name or C123) to channel ID for posting. Bot must be a member. */
async function resolveChannelForPost(client, channelRef) {
  if (!channelRef || !client) return null;
  const ref = String(channelRef).trim();
  if (ref.startsWith("C") && ref.length > 5) return ref;
  const name = ref.replace(/^#/, "");
  let cursor;
  do {
    const res = await client.conversations.list({
      types: "public_channel",
      limit: 200,
      exclude_archived: true,
      cursor
    });
    const ch = res.channels?.find((c) => c.name === name && c.is_member);
    if (ch) return ch.id;
    cursor = res.response_metadata?.next_cursor;
  } while (cursor);
  return null;
}

/** Slack limit for block element value is 2001 characters. Truncate action so JSON fits. */
function makeButtonValue(obj, maxLength = 2000) {
  let s = JSON.stringify(obj);
  if (s.length <= maxLength) return s;
  if (typeof obj.action === "string" && obj.action.length > 0) {
    const needToCut = s.length - maxLength + 30;
    const maxAction = Math.max(0, (obj.action?.length ?? 0) - needToCut);
    obj = { ...obj, action: obj.action.substring(0, maxAction) + (obj.action.length > maxAction ? "…" : "") };
    s = JSON.stringify(obj);
  }
  if (s.length > maxLength) {
    const { action: _a, ...rest } = obj;
    s = JSON.stringify(rest);
  }
  return s;
}

// Validate signing secret is set
if (!process.env.SLACK_SIGNING_SECRET) {
  console.error('❌ ERROR: SLACK_SIGNING_SECRET is not set in .env file');
  console.error('   Get it from: Slack App → Basic Information → App Credentials → Signing Secret');
  process.exit(1);
}

// Initialize Receiver to handle both Slack Events and Express Routes
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET.trim(),
});

const botToken = process.env.SLACK_BOT_TOKEN;
const authClient = botToken ? new WebClient(botToken) : null;

/** Run once at startup to verify token and surface real errors (Slack's internal_error masks token issues) */
async function validateSlackTokenAtStartup() {
  if (!botToken) return;
  const hint = (msg) => `[Slack] ${msg} Ensure GCP Secret Manager has the same token as local .env.`;
  try {
    const r = await authClient.auth.test({ token: botToken });
    console.log(`[Slack] Token OK: team=${r.team_id || r.team} user=${r.user_id} (bot_id=${r.bot_id})`);
  } catch (e) {
    const code = e?.data?.error || e?.code;
    const isPlaceholder = botToken.includes("replace-me") || botToken.includes("placeholder");
    if (isPlaceholder) {
      console.error(hint("SLACK_BOT_TOKEN is still placeholder. Update Secret Manager with real xoxb- token."));
    } else if (code === "invalid_auth" || code === "account_inactive") {
      console.error(hint(`Token invalid or revoked (${code}). Reinstall Slack app and update Secret Manager.`));
    } else if (code === "internal_error") {
      console.error(
        hint("Slack returned internal_error. Often means token/workspace mismatch. " +
          "Copy token from working .env to GCP: echo -n 'YOUR_TOKEN' | gcloud secrets versions add slack-bot-token --data-file=- --project=PROJECT")
      );
    } else {
      console.error("[Slack] auth.test failed:", code, e?.message);
    }
    throw e;
  }
}

// Custom authorize with retry on internal_error (Slack transient failures during auth.test)
async function authorizeWithRetry(source, body) {
  if (!botToken) throw new Error("SLACK_BOT_TOKEN is not set");
  const result = await withSlackRetry(
    () => authClient.auth.test({ token: botToken }),
    { operation: "auth.test", maxAttempts: 5 }
  );
  return {
    botToken,
    botUserId: result.user_id,
    botId: result.bot_id,
    teamId: source.teamId,
    enterpriseId: source.enterpriseId,
  };
}

const app = new App({
  authorize: authorizeWithRetry,
  receiver: receiver
});

function isSlackInternalError(err) {
  return err?.code === 'slack_webapi_platform_error' && err?.data?.error === 'internal_error';
}

// Keep process alive on Slack transient errors (avoids Cloud Run exit on internal_error)
process.on('unhandledRejection', (error) => {
  if (error?.code === 'slack_webapi_platform_error') {
    const slackError = error.data?.error;
    if (slackError === 'invalid_auth') return;
    if (slackError === 'internal_error') {
      console.warn('[Slack] internal_error (transient). App continues. Check status.slack.com if persistent.');
      return;
    }
  }
  console.error('Unhandled promise rejection:', error);
});

process.on('uncaughtException', (err) => {
  if (isSlackInternalError(err)) {
    console.warn('[Slack] Uncaught internal_error. App continues.');
    return;
  }
  console.error('Uncaught exception:', err);
  process.exit(1);
});

// --- WEB INTERFACE ROUTES ---
receiver.app.use(express.json());
receiver.app.use(express.static(path.join(__dirname, "web")));

receiver.app.post("/api/analyze", async (req, res) => {
  try {
    const { text } = req.body;
    const timestamp = new Date().toISOString();
    const queryPreview = text?.length > 100 ? text.substring(0, 100) + "..." : text;
    console.log(`[${timestamp}] 📥 Query received from Web UI: "${queryPreview}"`);

    if (isHelpRequest(text)) {
      const helpText = await buildHelpMessage({ channel_id: "nochannel-web-ui" });
      return res.json({ source: "help", text: helpText, policy_result: null, rag_result: null, data: null });
    }

    // Map Web UI calls to a generic channel_id or specific 'web' context
    const result = await processIncomingMessage({ text, channel_id: "nochannel-web-ui" });
    
    const outputTimestamp = new Date().toISOString();
    const outputPreview = result.text?.length > 100 ? result.text.substring(0, 100) + "..." : result.text;
    console.log(`[${outputTimestamp}] 📤 Response sent to Web UI (source: ${result.source}): "${outputPreview}"`);
    
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// --- SLACK INTERFACE ---
app.event("app_mention", async ({ event, client, logger }) => {
  try {
    const web = client;
    const resolver = new UserResolver(web);

    // Clean up the slack text (remove bot mention)
    const rawText = event.text || "";
    const stripped = rawText.replace(/<@[A-Z0-9]+>/g, "").trim();
    const cleanText = await normalizeSlackText(stripped, resolver);

    if (!cleanText) {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "What would you like me to analyze or look up?",
      });
      return;
    }

    const timestamp = new Date().toISOString();
    const queryPreview = cleanText.length > 100 ? cleanText.substring(0, 100) + "..." : cleanText;
    console.log(`[${timestamp}] 📥 Query received from Slack (channel: ${event.channel}): "${queryPreview}"`);

    // Immediate feedback: add duck reaction (requires reactions:write scope)
    client.reactions.add({ channel: event.channel, timestamp: event.ts, name: "duck" }).catch((err) => {
      if (err?.data?.error === "missing_scope") {
        console.warn("[reactions] Add reactions:write to your Slack app scopes for reaction feedback");
      } else {
        console.warn("[reactions] Failed:", err?.message || err);
      }
    });

    if (isHelpRequest(cleanText)) {
      const helpText = await buildHelpMessage({ channel_id: event.channel });
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: helpText,
      });
      return;
    }

    // Use thread_ts for conversation state tracking
    const threadTs = event.thread_ts || event.ts;

    const result = await processIncomingMessage({
      text: cleanText,
      channel_id: event.channel,
      thread_ts: threadTs,
      getChannelName: async (channelId) => {
        if (!channelId || channelId === "nochannel-web-ui") return null;
        try {
          const r = await client.conversations.info({ channel: channelId });
          return r.channel?.name ?? null;
        } catch {
          return null;
        }
      },
    });

    const outputTimestamp = new Date().toISOString();
    const outputPreview = result.text?.length > 100 ? result.text.substring(0, 100) + "..." : result.text;
    const sourceInfo = result.source === "both" ? "policy_engine + rag_history" : result.source;
    console.log(`[${outputTimestamp}] 📤 Response sent to Slack (channel: ${event.channel}, source: ${sourceInfo}): "${outputPreview}"`);

    // Format message for Slack - if both results, use a cleaner format
    // Policy result should come first, then RAG history
    let messageText = result.text || "I couldn't process that request.";
    if (result.source === "both" && result.policy_result && result.rag_result) {
      messageText = `*Policy Engine Result:*\n${result.policy_result.text}\n\n*Additional Context from Slack History:*\n${result.rag_result.text}`;
    } else if (result.source === "both" && result.rag_result && result.policy_result) {
      // Ensure policy result comes first even if order is different
      messageText = `*Policy Engine Result:*\n${result.policy_result.text}\n\n*Additional Context from Slack History:*\n${result.rag_result.text}`;
    }

    // Show "Search All Channels" when user asked from a Slack channel (we search channel first, they can expand)
    const searchedChannelOnly = event.channel && event.channel !== "nochannel-web-ui";

    // Guard clause: when no result.data (RAG-only or no match), send message and optionally add Search All Channels
    if (!result.data) {
      const blocks = [{ type: "section", text: { type: "mrkdwn", text: messageText } }];
      if (searchedChannelOnly) {
        blocks.push({
          type: "actions",
          elements: [{
            type: "button",
            text: { type: "plain_text", text: "🔍 Search All Channels" },
            style: "primary",
            value: JSON.stringify({
              original_text: cleanText,
              original_message_ts: event.ts,
              searched_channel: event.channel
            }),
            action_id: "search_all_channels"
          }]
        });
      }
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: messageText,
        blocks: blocks.length > 1 ? blocks : undefined
      });
      return;
    }
    
    // Check if approval is needed
    const needsApproval = result.data.decision?.decision === "NEEDS_APPROVAL" && result.data.action;
    
    // Helper function to check if action is valid (not an error message)
    const isActionValid = (action) => {
      if (!action) return false;
      const actionStr = String(action);
      // Check for common error message patterns
      const errorPatterns = [
        /^Missing required parameters/i,
        /^Failed to generate/i,
        /^Error generating/i,
        /^MCP tool:/i  // Generic MCP tool placeholder
      ];
      return !errorPatterns.some(pattern => pattern.test(actionStr));
    };
    
    const actionIsValid = needsApproval && result.data.action && isActionValid(result.data.action);
    const disableApprovalButtons = process.env.DISABLE_APPROVAL_BUTTONS === "true";
    const hasMultipleOptions = result.data.actionOptions && Array.isArray(result.data.actionOptions) && result.data.actionOptions.length > 0;
    
    if (needsApproval) {
      // Build blocks for the message
      // If we have both policy and RAG results, split them so policy comes first
      let policyText = messageText;
      let ragText = null;
      
      if (result.source === "both" && result.policy_result && result.rag_result) {
        // Use policy result text only (without RAG) for the main message
        policyText = result.policy_result.text;
        ragText = result.rag_result.text;
      }
      
      // Helper function to split long text into multiple blocks (Slack limit is 3000 chars per block)
      const splitIntoBlocks = (text, maxLength = 2900) => {
        if (!text || text.length <= maxLength) {
          return [{ type: "section", text: { type: "mrkdwn", text } }];
        }
        
        const blocks = [];
        let remaining = text;
        
        while (remaining.length > 0) {
          if (remaining.length <= maxLength) {
            blocks.push({
              type: "section",
              text: { type: "mrkdwn", text: remaining }
            });
            break;
          }
          
          // Try to split at a newline near the limit
          const chunk = remaining.substring(0, maxLength);
          const lastNewline = chunk.lastIndexOf('\n');
          const splitPoint = lastNewline > maxLength * 0.8 ? lastNewline + 1 : maxLength;
          
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: remaining.substring(0, splitPoint) }
          });
          
          remaining = remaining.substring(splitPoint);
        }
        
        return blocks;
      };
      
      // Split policy text into blocks if it's too long
      const blocks = splitIntoBlocks(policyText);
      
      // If we have multiple action options, show them separately
      if (hasMultipleOptions && !disableApprovalButtons) {
        // Add each action option as a separate section with its own button
        for (let idx = 0; idx < result.data.actionOptions.length; idx++) {
          const option = result.data.actionOptions[idx];
          const optionIsValid = isActionValid(option.action);

          // Add section for this option (when hideApproveButton, show instruction only—no gcloud command)
          const optionText = option.hideApproveButton
            ? `*${option.label}*\n${option.description || ""}`
            : `*${option.label}*\n${option.description ? `${option.description}\n` : ""}${option.action.substring(0, 500)}${option.action.length > 500 ? "..." : ""}`;
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: optionText }
          });

          // Add approve button for this option (skip if hideApproveButton)
          if (optionIsValid && !option.hideApproveButton) {
            blocks.push({
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: `✅ Approve: ${option.label}`
                  },
                  style: "primary",
                  value: makeButtonValue({
                    action: option.action,
                    actionTemplate: option.template,
                    actionLabel: option.label,
                    gcloudCommandTemplate: option.gcloudCommandTemplate || null,
                    githubOwner: option.githubOwner ?? result.data.policy?.github_owner ?? null,
                    githubRepo: option.githubRepo ?? result.data.policy?.github_repo ?? null,
                    prNotifyChannel: result.data.policy?.pr_notify_channel ?? null,
                    prNotifyTemplate: result.data.policy?.pr_notify_template ?? null,
                    jiraBaseUrl: result.data.policy?.jira_base_url ?? null,
                    parsed: result.data.parsed,
                    decision: result.data.decision,
                    message_ts: event.ts,
                    optionIndex: idx
                  }),
                  action_id: "approve_action"
                }
              ]
            });
          }
        }

        // Add Reject All only when at least one option has an Approve button (skip if all options have hideApproveButton)
        const anyOptionHasApprove = result.data.actionOptions.some((opt) => !opt.hideApproveButton && isActionValid(opt.action));
        if (anyOptionHasApprove) {
          blocks.push({
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "❌ Reject All"
                },
                style: "danger",
                value: JSON.stringify({
                  parsed: result.data.parsed,
                  message_ts: event.ts
                }),
                action_id: "reject_action"
              }
            ]
          });
        }
      }
      // Single action (legacy format)
      else {
        if (result.data.action) {
          blocks.push({
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Action:* \`${result.data.action.substring(0, 200)}${result.data.action.length > 200 ? '...' : ''}\``
            }
          });
        }
        
        // Only add approval buttons if action is valid AND approval buttons are not disabled
        if (actionIsValid && !disableApprovalButtons) {
          blocks.push({
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "✅ Approve & Execute"
                },
                style: "primary",
                value: makeButtonValue({
                  action: result.data.action,
                  actionTemplate: result.data.policy?.action_template || null,
                  actionLabel: "Execute Action",
                  gcloudCommandTemplate: result.data.policy?.gcloud_command_template || null,
                  githubOwner: result.data.policy?.github_owner || null,
                  githubRepo: result.data.policy?.github_repo || null,
                  prNotifyChannel: result.data.policy?.pr_notify_channel ?? null,
                  prNotifyTemplate: result.data.policy?.pr_notify_template ?? null,
                  jiraBaseUrl: result.data.policy?.jira_base_url ?? null,
                  parsed: result.data.parsed,
                  decision: result.data.decision,
                  message_ts: event.ts
                }),
                action_id: "approve_action"
              },
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "❌ Reject"
                },
                style: "danger",
                value: makeButtonValue({
                  action: result.data.action,
                  parsed: result.data.parsed,
                  message_ts: event.ts
                }),
                action_id: "reject_action"
              }
            ]
          });
        }
      }
      
      // Add RAG history at the end (after all action options)
      if (ragText) {
        const ragBlocks = splitIntoBlocks(`*Additional Context from Slack History:*\n${ragText}`);
        blocks.push(...ragBlocks);
      }
      
      // Send message with or without approval buttons
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: messageText,
        blocks
      });
      
      // Also add search all channels button if RAG was used
      if (searchedChannelOnly) {
        await client.chat.postMessage({
          channel: event.channel,
          thread_ts: event.ts,
          text: "🔍 Want to search across all channels?",
          blocks: [
            {
              type: "actions",
              elements: [
                {
                  type: "button",
                  text: {
                    type: "plain_text",
                    text: "🔍 Search All Channels"
                  },
                  style: "primary",
                  value: JSON.stringify({
                    original_text: cleanText,
                    original_message_ts: event.ts,
                    searched_channel: event.channel
                  }),
                  action_id: "search_all_channels"
                }
              ]
            }
          ]
        });
      }
    } else {
      // Regular message - add button to search all channels if RAG was used
      // Helper function to split long text into multiple blocks (Slack limit is 3000 chars per block)
      const splitIntoBlocks = (text, maxLength = 2900) => {
        if (!text || text.length <= maxLength) {
          return [{ type: "section", text: { type: "mrkdwn", text } }];
        }
        
        const blocks = [];
        let remaining = text;
        
        while (remaining.length > 0) {
          if (remaining.length <= maxLength) {
            blocks.push({
              type: "section",
              text: { type: "mrkdwn", text: remaining }
            });
            break;
          }
          
          // Try to split at a newline near the limit
          const chunk = remaining.substring(0, maxLength);
          const lastNewline = chunk.lastIndexOf('\n');
          const splitPoint = lastNewline > maxLength * 0.8 ? lastNewline + 1 : maxLength;
          
          blocks.push({
            type: "section",
            text: { type: "mrkdwn", text: remaining.substring(0, splitPoint) }
          });
          
          remaining = remaining.substring(splitPoint);
        }
        
        return blocks;
      };
      
      const blocks = splitIntoBlocks(messageText);

      // Add button to search all channels if RAG was used and we searched only this channel
      if (searchedChannelOnly) {
        blocks.push({
          type: "actions",
          elements: [
            {
              type: "button",
              text: {
                type: "plain_text",
                text: "🔍 Search All Channels"
              },
              style: "primary",
              value: JSON.stringify({
                original_text: cleanText,
                original_message_ts: event.ts,
                searched_channel: event.channel
              }),
              action_id: "search_all_channels"
            }
          ]
        });
      }

      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: messageText,
        blocks: blocks.length > 1 ? blocks : undefined
      });
    }
  } catch (err) {
    logger.error(err);
    const isSlackInternal = err.code === 'slack_webapi_platform_error' && err.data?.error === 'internal_error';
    const userMessage = isSlackInternal
      ? "Slack had a temporary hiccup. Please try again in a moment."
      : "Error while processing (check server logs).";
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: userMessage,
      });
    } catch {}
  }
});

// Handle button interactions (approval/rejection)
app.action("approve_action", async ({ ack, body, client, logger }) => {
  await ack();
  
  try {
    const value = JSON.parse(body.actions[0].value);
    const { action, actionTemplate, actionLabel, parsed, decision, githubOwner, githubRepo, prNotifyChannel, prNotifyTemplate, jiraBaseUrl } = value;
    
    // Debug: Log action template for troubleshooting
    if (!actionTemplate) {
      console.warn(`[Approval Handler] actionTemplate is missing. Value keys: ${Object.keys(value).join(', ')}`);
    }
    
    // Execute the action via MCP
    const { executeMCPGcloudCommand, executeGcloudScaleUp } = await import("./report/mcpClient.js");
    let executionResult;
    
    try {
      // Check action template to determine which MCP tool to use
      if (actionTemplate === "MCP:execute_gcloud_scale_up") {
        // Execute GCP scale-up command
        const { gcloudCommandTemplate } = value;
        if (!gcloudCommandTemplate) {
          throw new Error("gcloud_command_template is required in policy");
        }
        executionResult = await executeGcloudScaleUp({
          serviceName: parsed.service_name || parsed.serviceName || null,
          gcloudCommand: gcloudCommandTemplate
        });
        
        // If we got a command, execute it via gcloud
        if (executionResult.success && executionResult.command) {
          // Extract the actual gcloud command and execute it
          const gcloudCmd = executionResult.command;
          executionResult = await executeMCPGcloudCommand(gcloudCmd);
        }
      } 
      else if (actionTemplate === "MCP:generate_terragrunt_autoscaler_diff") {
        // Git PR option - show "under development" message
        await client.chat.update({
          channel: body.channel.id,
          ts: body.message.ts,
          text: body.message.text,
          blocks: [
            {
              type: "section",
              text: {
                type: "mrkdwn",
                text: `✅ *Action Approved*\n\n*Option Selected:* ${actionLabel || "Git PR"}\n\n🚧 *Under Development*\n\nThis feature is currently under development. Git PR scaling will be available soon.`
              }
            }
          ]
        });
        return; // Exit early since we've handled it
      }
      // else if (actionTemplate === "MCP:generate_scaling_schedule_yaml_diff") {
      //   // Execute the scaling schedule script (bash)
      //   const { generateScalingScheduleYamlDiff } = await import("./report/mcpClient.js");
      //   ...
      // }
      else if (actionTemplate === "MCP:create_scaling_schedule_pr") {
        // Create PR via GitHub API
        const { createScalingSchedulePR } = await import("./report/mcpClient.js");

        const schedule = parsed.schedule || parsed.start || null;
        const duration = parsed.duration || parsed.duration_sec || null;
        const ticketNumber = parsed.ticket_number || parsed.name || parsed.schedule_name || null;

        if (!schedule || !duration || !ticketNumber) {
          await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: body.message.text,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `❌ *Execution Failed*\n\nMissing required parameters: schedule, duration, ticket_number`
                }
              }
            ]
          });
          return;
        }

        if (!githubOwner || !githubRepo) {
          await client.chat.update({
            channel: body.channel.id,
            ts: body.message.ts,
            text: body.message.text,
            blocks: [
              {
                type: "section",
                text: {
                  type: "mrkdwn",
                  text: `❌ *Execution Failed*\n\nPolicy must include github_owner and github_repo`
                }
              }
            ]
          });
          return;
        }

        try {
          executionResult = await createScalingSchedulePR({
            schedule,
            duration: parseInt(duration, 10),
            name: ticketNumber,
            owner: githubOwner,
            repo: githubRepo
          });
          if (executionResult.success && executionResult.prUrl) {
            executionResult.output = `PR created: ${executionResult.prUrl} please get @mcoc-release to review, approve, and atlantis apply the PR`;

            // Post to notify channel if configured
            if (prNotifyChannel && prNotifyTemplate) {
              try {
                const channelId = await resolveChannelForPost(client, prNotifyChannel);
                if (channelId) {
                  const ticketNumber = parsed.ticket_number || parsed.name || parsed.schedule_name || "";
                  const jiraUrl = jiraBaseUrl && ticketNumber
                    ? `${jiraBaseUrl.replace(/\/$/, "")}/${encodeURIComponent(ticketNumber.trim())}`
                    : "";
                  const notifyText = prNotifyTemplate
                    .replace(/\{ticket_number\}/g, ticketNumber)
                    .replace(/\{pr_url\}/g, executionResult.prUrl)
                    .replace(/\{jira_url\}/g, jiraUrl)
                    .replace(/\{repo_name\}/g, githubRepo || "")
                    .replace(/\{github_owner\}/g, githubOwner || "");
                  await client.chat.postMessage({
                    channel: channelId,
                    text: notifyText,
                    blocks: [{ type: "section", text: { type: "mrkdwn", text: notifyText } }]
                  });
                  console.log(`[PR notify] Posted to #${prNotifyChannel.replace(/^#/, "")}`);
                } else {
                  console.warn(`[PR notify] Channel not found or bot not a member: ${prNotifyChannel}`);
                }
              } catch (err) {
                console.warn("[PR notify] Failed to post:", err?.message || err);
              }
            }
          }
        } catch (error) {
          executionResult = {
            success: false,
            error: error.message
          };
        }
      }
      else if (action && action.trim().startsWith("gcloud")) {
        // Direct gcloud command execution
        executionResult = await executeMCPGcloudCommand(action);
      }
      else {
        // No valid action handler found
        // Try to provide helpful error message
        const actionType = actionTemplate ? `action template: ${actionTemplate}` : 
                          (action ? `action: ${action.substring(0, 50)}...` : 'unknown action');
        executionResult = {
          success: false,
          error: `No execution handler found for ${actionType}. Please check the action template configuration.`
        };
      }
      
      // Format the response message
      const actionLabelText = actionLabel ? `*Option:* ${actionLabel}\n\n` : '';
      const actionText = action ? `*Action:* \`${action.substring(0, 100)}${action.length > 100 ? '...' : ''}\`\n\n` : '';
      let resultText = `✅ *Action Approved and Executed*\n\n${actionLabelText}${actionText}*Result:* ${executionResult.success ? "✅ Success" : "❌ Failed"}`;
      
      if (executionResult.output) {
        // Truncate long output for Slack (max ~3000 chars per block)
        const output = executionResult.output.length > 2000 
          ? executionResult.output.substring(0, 2000) + "\n... (truncated)"
          : executionResult.output;
        resultText += `\n\n*Output:*\n\`\`\`${output}\`\`\``;
      } else if (executionResult.result) {
        resultText += `\n\n*Details:*\n\`\`\`${JSON.stringify(executionResult.result, null, 2)}\`\`\``;
      }
      
      if (executionResult.error) {
        resultText += `\n\n*Error:* ${executionResult.error}`;
      }
      
      if (executionResult.command) {
        resultText += `\n\n*Command Executed:*\n\`\`\`${executionResult.command}\`\`\``;
      }
      
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: body.message.text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: resultText
            }
          }
        ]
      });
    } catch (error) {
      const actionLabelText = actionLabel ? `*Option:* ${actionLabel}\n\n` : '';
      const actionText = action ? `*Action:* \`${action}\`\n\n` : '';
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: body.message.text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ *Action Approved but Execution Failed*\n\n${actionLabelText}${actionText}*Error:* ${error.message}`
            }
          }
        ]
      });
    }
  } catch (err) {
    logger.error(err);
    await client.chat.postMessage({
      channel: body.channel.id,
      thread_ts: body.message.ts,
      text: "Error processing approval. Check server logs.",
    });
  }
});

app.action("reject_action", async ({ ack, body, client, logger }) => {
  await ack();
  
  try {
    const value = JSON.parse(body.actions[0].value);
    const { action } = value;
    
    console.log(`[${new Date().toISOString()}] ❌ Action rejected by ${body.user.name}: ${action}`);
    
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: body.message.text,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: `❌ *Action Rejected*\n\n*Action:* \`${action}\`\n\nAction was rejected and will not be executed.`
          }
        }
      ]
    });
  } catch (err) {
    logger.error(err);
  }
});

// Handle "Search All Channels" button click
app.action("search_all_channels", async ({ ack, body, client, logger, action }) => {
  // Always ack immediately to prevent exclamation mark
  try {
    await ack();
  } catch (ackErr) {
    console.error(`[${new Date().toISOString()}] ❌ Failed to ack action:`, ackErr);
    return; // Can't proceed without ack
  }
  
  try {
    if (!body.actions || body.actions.length === 0) {
      throw new Error("No action data found");
    }
    
    const value = JSON.parse(body.actions[0].value);
    const { original_text, original_message_ts, searched_channel } = value;
    
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] 🔍 User ${body.user?.name || 'unknown'} requested search across all channels for: "${original_text}"`);
    
    // Update message to show we're searching
    try {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: body.message.text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${body.message.text}\n\n🔍 *Searching across all channels...*`
            }
          }
        ]
      });
    } catch (updateErr) {
      console.error(`[${new Date().toISOString()}] ⚠️  Failed to update message (will continue anyway):`, updateErr.message);
    }

    // Re-query with channel_id = null to search all channels
    const result = await processIncomingMessage({ 
      text: original_text, 
      channel_id: null  // Search all channels
    });

    const outputTimestamp = new Date().toISOString();
    const outputPreview = result.text?.length > 100 ? result.text.substring(0, 100) + "..." : result.text;
    console.log(`[${outputTimestamp}] 📤 Response sent to Slack (all channels search, source: ${result.source}): "${outputPreview}"`);

    // Format the result
    let messageText = result.text || "I couldn't find relevant information across all channels.";
    if (result.source === "both" && result.policy_result && result.rag_result) {
      messageText = `*Policy Engine Result:*\n${result.policy_result.text}\n\n*Additional Context from All Channels:*\n${result.rag_result.text}`;
    } else if (result.rag_result) {
      messageText = `*Results from All Channels:*\n\n${result.rag_result.text}`;
    }

    // Update the message with the new result
    await client.chat.update({
      channel: body.channel.id,
      ts: body.message.ts,
      text: messageText,
      blocks: [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: messageText
          }
        }
      ]
    });
  } catch (err) {
    logger.error("Error in search_all_channels handler:", err);
    console.error(`[${new Date().toISOString()}] ❌ Error searching all channels:`, err);
    console.error(`[${new Date().toISOString()}] ❌ Error stack:`, err.stack);
    
    try {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: body.message.text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${body.message.text}\n\n❌ Error searching all channels: ${err.message}\n\nCheck server logs for details.`
            }
          }
        ]
      });
    } catch (updateErr) {
      console.error("Failed to update message with error:", updateErr);
      // Try posting a new message instead
      try {
        await client.chat.postMessage({
          channel: body.channel.id,
          thread_ts: body.message.ts,
          text: `❌ Error searching all channels: ${err.message}. Check server logs.`
        });
      } catch (postErr) {
        console.error("Failed to post error message:", postErr);
      }
    }
  }
});


(async () => {
  try {
    await validateSlackTokenAtStartup();
    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ Combined Bot & Web UI running on port ${port}`);
    console.log(`   - Slack Events: http://localhost:${port}/slack/events`);
    console.log(`   - Web UI: http://localhost:${port}/`);
    console.log(`   - API: http://localhost:${port}/api/analyze`);
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${process.env.PORT || 3000} is already in use.`);
      console.error('   Stop the existing process or use a different PORT.');
    } else if (error?.data?.error || error?.code === 'slack_webapi_platform_error') {
      // Slack auth error - message already logged by validateSlackTokenAtStartup
      console.error('❌ Slack token validation failed. See above for fix.');
    } else {
      console.error('Failed to start server:', error);
    }
    process.exit(1);
  }
})();