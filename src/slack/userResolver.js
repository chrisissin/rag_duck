/**
 * Simple in-memory user resolver w/ caching.
 * - Resolves user IDs like U123... to username via users.info
 * - Also handles bot IDs (B...) best-effort
 */
export class UserResolver {
  /**
   * @param {import("@slack/web-api").WebClient} web
   */
  constructor(web) {
    this.web = web;
    /** @type {Map<string,string>} */
    this.cache = new Map();
  }

  /**
   * @param {string} userId
   * @returns {Promise<string>} username (no @ prefix)
   */
  async getUsername(userId) {
    if (!userId) return "unknown";
    if (this.cache.has(userId)) return this.cache.get(userId);

    // Slack user IDs start with U/W; bot users can still be returned by users.info.
    try {
      const res = await this.web.users.info({ user: userId });
      const user = res?.user;
      const name = user?.name || user?.profile?.display_name || user?.profile?.real_name;
      const normalized = (name && String(name).trim()) ? String(name).trim() : userId;
      this.cache.set(userId, normalized);
      return normalized;
    } catch (e) {
      // Don't fail indexing on resolution issues
      this.cache.set(userId, userId);
      return userId;
    }
  }
}
