export function buildRagPrompt({ question, contexts }) {
  const ctx = contexts
    .map((c, i) => `SOURCE ${i + 1} (ts ${c.start_ts}-${c.end_ts}):\n${c.text}`)
    .join("\n\n---\n\n");

  return `
You are a helpful Slack assistant.
Answer the user's question using ONLY the sources below.
If the sources don't contain enough information, say you don't know and ask a specific follow-up question.
Be concise and actionable. Use bullet points when helpful.

USER QUESTION:
${question}

SOURCES:
${ctx}
`.trim();
}
