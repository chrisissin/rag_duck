import { parseAlert, getPolicyByAlertType } from "./parser/parserEngine.js";
import { decide } from "./decision/decide.js";
import { formatReport } from "./report/formatReport.js";
import { retrieveContexts } from "./rag/retrieve.js";
import { buildRagPrompt } from "./rag/prompt.js";
import { ollamaChat } from "./rag/ollama.js";

/**
 * Combined Logic:
 * 1. Run Parser and RAG retrieval in parallel (both can start immediately)
 * 2. Combine results when both complete
 *
 * @param {Object} opts
 * @param {string} opts.text - Message text
 * @param {string} [opts.channel_id] - Slack channel ID (for RAG and channel restriction)
 * @param {string} [opts.thread_ts] - Thread TS
 * @param {Function} [opts.getChannelName] - async (channelId) => channel name, for scalepr_request trigger_channel_only check
 */
export async function processIncomingMessage({ text, channel_id, thread_ts = null, getChannelName = null }) {
  // --- RUN PARSER + RAG RETRIEVAL IN PARALLEL (saves ~1–3s on first response) ---
  const [parseResult, contexts] = await Promise.all([
    parseAlert(text),
    retrieveContexts({ channel_id, question: text }),
  ]);

  let policyResult = null;
  if (parseResult.matched) {
    let usePolicy = parseResult.policy;
    let useParsed = parseResult.parsed;

    // scalepr_request with trigger_channel_only: only allow in specified channel; otherwise show scaling_intent_detected
    if (usePolicy?.alert_type === "scalepr_request" && usePolicy.trigger_channel_only) {
      let useFallback = false;
      if (!channel_id || channel_id === "nochannel-web-ui") {
        useFallback = true;
      } else if (getChannelName) {
        const allowed = (usePolicy.trigger_channel_only || "").replace(/^#/, "").toLowerCase();
        const current = await getChannelName(channel_id);
        const currentNorm = (current || "").toLowerCase();
        useFallback = currentNorm !== allowed;
      }
      if (useFallback) {
        const fallbackPolicy = getPolicyByAlertType("scaling_intent_detected");
        if (fallbackPolicy) {
          const targetChannel = usePolicy.trigger_channel_only || "#mcoc-server-scaling";
          usePolicy = fallbackPolicy;
          useParsed = {
            ...fallbackPolicy.extraction_rules,
            user_intent: `You've sent a scaling PR request. Please post this in ${targetChannel} to create the PR.`,
          };
          console.log(`[orchestrator] scalepr_request triggered outside ${targetChannel}, showing scaling_intent_detected`);
        }
      }
    }

    const decision = decide(useParsed, usePolicy);
    const report = await formatReport({
      parsed: useParsed,
      decision,
      policy: usePolicy,
      originalText: text,
    });
    policyResult = {
      source: "policy_engine",
      text: report.summary,
      data: report,
    };
  }

  let ragResult = null;
  
  if (contexts.length > 0) {
    const prompt = buildRagPrompt({ question: text, contexts });
    const answer = await ollamaChat({ prompt });
    
    ragResult = {
      source: "rag_history",
      text: answer || "I found history but couldn't generate a response.",
      data: null
    };
  }

  // --- COMBINE RESULTS ---
  // If both policy and RAG matched, combine them
  // Policy result comes first, then RAG history
  if (policyResult && ragResult) {
    return {
      source: "both",
      text: `${policyResult.text}\n\n*Additional Context from Slack History:*\n${ragResult.text}`,
      policy_result: policyResult,
      rag_result: ragResult,
      data: policyResult.data
    };
  }
  
  // If only policy matched
  if (policyResult) {
    return {
      ...policyResult,
      rag_result: null
    };
  }
  
  // If only RAG matched
  if (ragResult) {
    return {
      ...ragResult,
      policy_result: null
    };
  }

  // Neither matched
  return {
    source: "none",
    text: "I couldn't identify an action or find relevant history to answer that.",
    policy_result: null,
    rag_result: null,
    data: null
  };
}
