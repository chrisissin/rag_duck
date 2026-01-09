export async function ollamaEmbed(text) {
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const model = process.env.OLLAMA_EMBED_MODEL || "nomic-embed-text";

  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, prompt: text }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama embeddings failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  if (!data?.embedding?.length) throw new Error("No embedding returned from Ollama");
  return data.embedding;
}

export async function ollamaChat({ prompt }) {
  const baseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
  const model = process.env.OLLAMA_CHAT_MODEL || "llama3.1";

  const res = await fetch(`${baseUrl}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama generate failed: ${res.status} ${body}`);
  }

  const data = await res.json();
  return (data?.response || "").trim();
}
