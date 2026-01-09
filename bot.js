import "dotenv/config";
import pkg from "@slack/bolt";
const { App } = pkg;
import { UserResolver } from "./slack/userResolver.js";
import { normalizeSlackTextBase, normalizeSlackText } from "./slack/normalize.js";
import { retrieveContexts } from "./rag/retrieve.js";
import { buildRagPrompt } from "./rag/prompt.js";
import { ollamaChat } from "./rag/ollama.js";

// Handle unhandled promise rejections (e.g., invalid_auth during startup with placeholder credentials)
process.on('unhandledRejection', (error) => {
  if (error.code === 'slack_webapi_platform_error' && error.data?.error === 'invalid_auth') {
    // Suppress invalid_auth errors - expected with placeholder credentials
    // The server is still running and can handle URL verification
    return;
  }
  // Log other unhandled rejections
  console.error('Unhandled promise rejection:', error);
});

// Validate signing secret is set
if (!process.env.SLACK_SIGNING_SECRET) {
  console.error('❌ ERROR: SLACK_SIGNING_SECRET is not set in .env file');
  console.error('   Get it from: Slack App → Basic Information → App Credentials → Signing Secret');
  process.exit(1);
}

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  signingSecret: process.env.SLACK_SIGNING_SECRET.trim(), // Trim any whitespace
});

// Handle authentication errors gracefully (for development with placeholder credentials)
app.error((error) => {
  if (error.code === 'slack_webapi_platform_error' && error.data?.error === 'invalid_auth') {
    // Suppress invalid_auth errors during development - they're expected with placeholder tokens
    // The server can still handle URL verification for Event Subscriptions
    return;
  }
  // Log other errors
  console.error('Slack app error:', error);
});

// Handle request verification errors (signature mismatch)
app.use(async ({ next, logger }) => {
  try {
    await next();
  } catch (error) {
    if (error.message && error.message.includes('signature mismatch')) {
      logger.warn('⚠️  Signature verification failed. Check your SLACK_SIGNING_SECRET in .env file.');
      logger.warn('   Make sure it matches the Signing Secret from: Slack App → Basic Information → App Credentials');
      logger.warn('   Ensure there are no extra spaces or quotes in your .env file.');
      // Don't throw - let the request continue (Slack will retry)
    } else {
      throw error;
    }
  }
});

function stripLeadingBotMention(text) {
  // Turn "<@BOTID> hello" into "hello" (after base normalization)
  const base = normalizeSlackTextBase(text);
  return base.replace(/^<@([A-Z0-9]+)>\s*/i, "").replace(/^@([A-Z0-9]+)\s*/i, "").trim();
}

app.event("app_mention", async ({ event, client, logger }) => {
  try {
    const channel_id = event.channel;
    const web = client; // Bolt provides WebClient instance here
    const resolver = new UserResolver(web);

    const rawText = event.text || "";
    const stripped = stripLeadingBotMention(rawText);
    const question = await normalizeSlackText(stripped, resolver);

    if (!question) {
      await client.chat.postMessage({
        channel: channel_id,
        thread_ts: event.ts,
        text: "What would you like me to look up?",
      });
      return;
    }

    // Safe v1: retrieve only from same channel.
    const contexts = await retrieveContexts({ channel_id, question });

    const prompt = buildRagPrompt({ question, contexts });
    const answer = await ollamaChat({ prompt });

    await client.chat.postMessage({
      channel: channel_id,
      thread_ts: event.ts,
      text: answer || "I couldn't generate a response. Try rephrasing the question.",
    });
  } catch (err) {
    logger.error(err);
    try {
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "Error while answering (check server logs).",
      });
    } catch {}
  }
});

(async () => {
  const port = process.env.PORT || 3000;
  await app.start(port);
  console.log(`⚡️ Slack RAG bot running on port ${port}`);
  
  // Check if credentials are set (basic validation)
  const signingSecret = process.env.SLACK_SIGNING_SECRET?.trim();
  const botToken = process.env.SLACK_BOT_TOKEN?.trim();
  
  if (!botToken || botToken.includes('placeholder')) {
    console.log('⚠️  Warning: Using placeholder SLACK_BOT_TOKEN. Update your .env file with real token.');
    console.log('   Get it from: Slack App → OAuth & Permissions → Bot User OAuth Token');
  }
  
  if (signingSecret) {
    console.log(`✅ Signing Secret is set (${signingSecret.substring(0, 8)}...)`);
    console.log('   If you see signature mismatch errors, verify the secret matches your Slack app.');
  }
})();
