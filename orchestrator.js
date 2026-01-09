import { parseAlert } from "./parser/parserEngine.js";
import { decide } from "./decision/decide.js";
import { formatReport } from "./report/formatReport.js";
import { retrieveContexts } from "./rag/retrieve.js";
import { buildRagPrompt } from "./rag/prompt.js";
import { ollamaChat } from "./rag/ollama.js";

/**
 * Combined Logic: 
 * 1. Try Parser (Regex/LLM Policy)
 * 2. If matched, get Decision & Format Action
 * 3. If no match, fallback to RAG Chat History
 */
export async function processIncomingMessage({ text, channel_id }) {
  // --- PHASE 1: PARSER ENGINE ---
  // Uses your existing parserEngine.js logic 
  const parseResult = await parseAlert(text);

  if (parseResult.matched) {
    // Make decision (AUTO_REPLACE vs NEEDS_APPROVAL)
    const decision = decide(parseResult.parsed, parseResult.policy);
    
    // Format the remediation report/action
    const report = await formatReport({ 
      parsed: parseResult.parsed, 
      decision, 
      policy: parseResult.policy 
    });
    
    return {
      source: "policy_engine",
      text: report.summary,
      data: report
    };
  }

  // --- PHASE 2: RAG FALLBACK ---
  // If text isn't an alert, look through Slack history
  const contexts = await retrieveContexts({ channel_id, question: text });
  
  if (contexts.length > 0) {
    const prompt = buildRagPrompt({ question: text, contexts });
    const answer = await ollamaChat({ prompt });
    
    return {
      source: "rag_history",
      text: answer || "I found history but couldn't generate a response.",
      data: null
    };
  }

  return {
    source: "none",
    text: "I couldn't identify an action or find relevant history to answer that.",
    data: null
  };
}
