/** Slack API retry with rate-limit handling and diagnostic logging */
export function withSlackRetry(fn, opts = {}) {
  const { operation = "slack-api", logger = console, maxAttempts = 5 } = opts;
  let attempt = 0;

  async function run() {
    while (true) {
      try {
        return await fn();
      } catch (e) {
        attempt++;
        const status = e?.data?.status ?? e?.status ?? e?.code;
        const retryAfter = parseInt(e?.data?.headers?.["retry-after"] ?? e?.data?.retry_after ?? 0, 10);
        const msg = e?.message ?? e?.data?.error ?? String(e);

        const isRateLimit = status === 429 || retryAfter > 0;
        const isInternalError = e?.data?.error === "internal_error";
        if (logger.warn && (process.env.DEBUG_SLACK === "1" || isRateLimit || isInternalError || attempt > 1)) {
          logger.warn(`[Slack] ${operation} failed (attempt ${attempt}/${maxAttempts}): status=${status ?? "n/a"} error=${e?.data?.error ?? "n/a"} msg=${msg?.slice?.(0, 200) ?? msg}`);
        }

        if ((isRateLimit || isInternalError) && attempt < maxAttempts) {
          const waitMs = (retryAfter || Math.min(2 * 2 ** (attempt - 1), 30)) * 1000;
          logger.warn?.(`[Slack] ${isInternalError ? "Internal error" : "Rate limited"}. Retrying in ${waitMs}ms...`);
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        throw e;
      }
    }
  }

  return run();
}
