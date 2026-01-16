import "dotenv/config";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import { processIncomingMessage } from "./orchestrator.js";
import { UserResolver } from "./slack/userResolver.js";
import { normalizeSlackText } from "./slack/normalize.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver: receiver
});

// Handle unhandled promise rejections (e.g., invalid_auth during startup)
process.on('unhandledRejection', (error) => {
  if (error.code === 'slack_webapi_platform_error' && error.data?.error === 'invalid_auth') {
    // Suppress invalid_auth errors - expected with placeholder credentials
    return;
  }
  console.error('Unhandled promise rejection:', error);
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

    const result = await processIncomingMessage({ 
      text: cleanText, 
      channel_id: event.channel 
    });

    const outputTimestamp = new Date().toISOString();
    const outputPreview = result.text?.length > 100 ? result.text.substring(0, 100) + "..." : result.text;
    const sourceInfo = result.source === "both" ? "policy_engine + rag_history" : result.source;
    console.log(`[${outputTimestamp}] 📤 Response sent to Slack (channel: ${event.channel}, source: ${sourceInfo}): "${outputPreview}"`);

    // Format message for Slack - if both results, use a cleaner format
    let messageText = result.text || "I couldn't process that request.";
    if (result.source === "both" && result.policy_result && result.rag_result) {
      messageText = `*Policy Engine Result:*\n${result.policy_result.text}\n\n*Additional Context from Slack History:*\n${result.rag_result.text}`;
    }

    // Check if we should offer to search all channels (if RAG was used and we searched only this channel)
    const hasRagResult = result.rag_result || result.source === "rag_history" || result.source === "both";
    const searchedChannelOnly = event.channel && hasRagResult && event.channel !== "nochannel-web-ui";

    // Check if approval is needed
    const needsApproval = result.data?.decision?.decision === "NEEDS_APPROVAL" && result.data?.action;
    
    if (needsApproval) {
      // Send message with approval buttons
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: messageText,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: messageText
            }
          },
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `*Action:* \`${result.data.action}\``
            }
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: {
                  type: "plain_text",
                  text: "✅ Approve & Execute"
                },
                style: "primary",
                value: JSON.stringify({
                  action: result.data.action,
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
                value: JSON.stringify({
                  action: result.data.action,
                  parsed: result.data.parsed,
                  message_ts: event.ts
                }),
                action_id: "reject_action"
              }
            ]
          }
        ]
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
      const blocks = [
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: messageText
          }
        }
      ];

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
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "Error while processing (check server logs).",
      });
    } catch {}
  }
});

// Handle button interactions (approval/rejection)
app.action("approve_action", async ({ ack, body, client, logger }) => {
  await ack();
  
  try {
    const value = JSON.parse(body.actions[0].value);
    const { action, parsed, decision } = value;
    
    
    // Execute the action via MCP
    const { executeMCPAction } = await import("./report/mcpClient.js");
    let executionResult;
    
    try {
      executionResult = await executeMCPAction(action, parsed);
      
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: body.message.text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ *Action Approved and Executed*\n\n*Action:* \`${action}\`\n\n*Result:* ${executionResult.success ? "✅ Success" : "❌ Failed"}\n${executionResult.result ? `\n\`\`\`${JSON.stringify(executionResult.result, null, 2)}\`\`\`` : ""}`
            }
          }
        ]
      });
    } catch (error) {
      await client.chat.update({
        channel: body.channel.id,
        ts: body.message.ts,
        text: body.message.text,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `✅ *Action Approved but Execution Failed*\n\n*Action:* \`${action}\`\n\n*Error:* ${error.message}`
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
    const port = process.env.PORT || 3000;
    await app.start(port);
    console.log(`⚡️ Combined Bot & Web UI running on port ${port}`);
    console.log(`   - Slack Events: http://localhost:${port}/slack/events`);
    console.log(`   - Web UI: http://localhost:${port}/`);
    console.log(`   - API: http://localhost:${port}/api/analyze`);
    
    // Check if credentials are set (basic validation)
    const botToken = process.env.SLACK_BOT_TOKEN?.trim();
    if (!botToken || botToken.includes('placeholder')) {
      console.log('⚠️  Warning: Using placeholder SLACK_BOT_TOKEN. Update your .env file with real token.');
    }
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(`❌ Port ${process.env.PORT || 3000} is already in use.`);
      console.error('   Stop the existing process or use a different PORT.');
    } else {
      console.error('Failed to start server:', error);
    }
    process.exit(1);
  }
})();