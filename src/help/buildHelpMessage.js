import { readFileSync, existsSync } from "fs";
import { join, resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { retrieveContexts } from "../rag/retrieve.js";
import { buildRagPrompt } from "../rag/prompt.js";
import { ollamaChat } from "../rag/ollama.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

let helpTriggersCache = null;

function getHelpTriggers() {
  if (helpTriggersCache) return helpTriggersCache;
  const policiesPath = process.env.POLICIES_PATH || resolve(__dirname, "../../config/policies.json");
  if (!existsSync(policiesPath)) {
    helpTriggersCache = [
      { type: "regex", pattern: "^(?:--help|-h|help)$" },
      { type: "regex", pattern: "who are you" },
      { type: "regex", pattern: "^(?:man|manual)$" },
    ];
    return helpTriggersCache;
  }
  try {
    const data = JSON.parse(readFileSync(policiesPath, "utf-8"));
    helpTriggersCache = data.help_triggers || [
      { type: "regex", pattern: "^(?:--help|-h|help)$" },
      { type: "regex", pattern: "who are you" },
      { type: "regex", pattern: "^(?:man|manual)$" },
    ];
    return helpTriggersCache;
  } catch {
    helpTriggersCache = [
      { type: "regex", pattern: "^(?:--help|-h|help)$" },
      { type: "regex", pattern: "who are you" },
      { type: "regex", pattern: "^(?:man|manual)$" },
    ];
    return helpTriggersCache;
  }
}

export function isHelpRequest(text) {
  if (!text || typeof text !== "string") return false;
  const trimmed = text.trim().toLowerCase();
  const triggers = getHelpTriggers();
  for (const t of triggers) {
    if (t.type === "regex") {
      const re = new RegExp(t.pattern, "i");
      if (re.test(trimmed)) return true;
    }
  }
  return false;
}

function getSupportedPoliciesSummary() {
  const policiesPath = process.env.POLICIES_PATH || resolve(__dirname, "../../config/policies.json");
  if (!existsSync(policiesPath)) {
    return ["• Scaling intent detection"];
  }
  try {
    const data = JSON.parse(readFileSync(policiesPath, "utf-8"));
    const policies = data.policies || [];
    // Only include policies we actually support (scaling intent for now; others may be disabled)
    const supported = policies.filter((p) => {
      const type = p.alert_type;
      return type === "scaling_intent_detected" || type === "scalepr_request";
    });
    return supported.map((p) => `• ${p.name || p.alert_type}`);
  } catch {
    return ["• Scaling intent detection"];
  }
}

export async function buildHelpMessage({ channel_id }) {
  const policiesSummary = getSupportedPoliciesSummary();
  const intro = `📖 *Slack RAG Bot – Usage Manual*

I'm a RAG-powered assistant that helps your team by:
• Searching Slack history (this channel and optionally all channels) to answer questions
• Detecting scaling intents and helping with scaling PRs (schedules, scale-up commands)`;

  const policiesSection = `*Currently supported policies:*
${policiesSummary.join("\n")}

_More policies (e.g. disk/CPU alerts, memory changes) can be added with platform engineers._`;

  let ragSection = "";
  if (channel_id && channel_id !== "nochannel-web-ui") {
    try {
      const contexts = await retrieveContexts({
        channel_id,
        question: "Short Summarize recent discussions and decisions",
      });
      if (contexts.length > 0) {
        const prompt = buildRagPrompt({
          question: "Summarize the most relevant recent discussions in 2-3 sentences.",
          contexts,
        });
        const summary = await ollamaChat({ prompt });
        ragSection = summary
          ? `\n*Things has been discussed in this channel recently:*\n${summary}`
          : `\n*Things has been discussed in this channel recently:*\nI have indexed ${contexts.length} chunk(s) from this channel. Ask me anything to search them.`;
      } else {
        ragSection = `\n*RAG history for this channel:*\nNo indexed messages in this channel yet. History will appear after the indexer runs.`;
      }
    } catch (err) {
      console.warn("[buildHelpMessage] RAG section failed:", err?.message);
      ragSection = `\n*RAG history for this channel:*\nUnable to fetch channel history right now.`;
    }
  } else {
    ragSection = `\n*RAG history:*\nYou're using the web UI. In Slack, I search channel history by default.`;
  }

  return `${intro}\n\n${policiesSection}${ragSection}`;
}
