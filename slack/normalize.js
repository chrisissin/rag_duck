/**
 * Basic normalization + async mention resolution.
 *
 * We keep this conservative:
 * - Replace channel refs <#C123|name> -> #name
 * - Replace special mentions <!here> etc.
 * - Resolve <@U123> -> @username via UserResolver
 */

export function normalizeSlackTextBase(text) {
  if (!text) return "";
  return text
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<!here>/g, "@here")
    .replace(/<!channel>/g, "@channel")
    .replace(/<!everyone>/g, "@everyone")
    .trim();
}

/**
 * @param {string} text
 * @param {{getUsername:(id:string)=>Promise<string>}} resolver
 */
export async function normalizeSlackText(text, resolver) {
  const base = normalizeSlackTextBase(text);

  // Replace user mentions
  const matches = [...base.matchAll(/<@([A-Z0-9]+)>/g)];
  if (!matches.length) return base.replace(/<@([A-Z0-9]+)>/g, "@$1");

  let out = base;
  // Resolve unique IDs only
  const uniqueIds = [...new Set(matches.map(m => m[1]))];

  const nameMap = new Map();
  await Promise.all(uniqueIds.map(async (id) => {
    const name = await resolver.getUsername(id);
    nameMap.set(id, name);
  }));

  out = out.replace(/<@([A-Z0-9]+)>/g, (_, id) => `@${nameMap.get(id) || id}`);
  return out.trim();
}

export function formatUserLine(username, text) {
  const who = username ? `@${username}` : "@unknown";
  return `${who}: ${text}`;
}
