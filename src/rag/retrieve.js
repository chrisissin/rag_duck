import { ollamaEmbed } from "./ollama.js";
import { searchSimilar } from "../db/slackChunksRepo.js";

export async function retrieveContexts({ channel_id, question }) {
  const topK = parseInt(process.env.TOP_K || "8", 10);
  const embedding = await ollamaEmbed(question);
  const rows = await searchSimilar({ channel_id, queryEmbedding: embedding, topK });

  const maxChars = parseInt(process.env.MAX_CONTEXT_CHARS || "12000", 10);
  let total = 0;
  const contexts = [];
  for (const r of rows) {
    const t = r.text || "";
    if (total + t.length > maxChars) break;
    total += t.length;
    contexts.push(r);
  }
  return contexts;
}
