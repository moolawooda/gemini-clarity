// Gemini Clarity — Token Counter (通过 background 代理调 API)

const GeminiTokenizer = {
  // Fallback: 字符估算
  CJK_REGEX: /[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g,

  estimateFallback(text) {
    if (!text) return 0;
    const cjkChars = (text.match(this.CJK_REGEX) || []).length;
    const otherChars = text.length - cjkChars;
    return Math.round(cjkChars / 1.8 + otherChars / 4.0);
  },

  // 通过 background service worker 调 API
  async countViaBackground(text, model) {
    try {
      const resp = await chrome.runtime.sendMessage({
        type: "count_tokens",
        text: text,
        model: model || "gemini-2.0-flash"
      });
      return resp?.tokens || null;
    } catch (e) {
      return null;
    }
  },

  // 统一入口：优先 API，失败走估算
  async count(text) {
    if (!text || !text.trim()) return { tokens: 0, method: "none" };
    const apiTokens = await this.countViaBackground(text);
    if (apiTokens !== null) return { tokens: apiTokens, method: "api" };
    return { tokens: this.estimateFallback(text), method: "estimate" };
  },

  formatTokens(count) {
    if (count >= 1000000) return (count / 1000000).toFixed(1) + "M";
    if (count >= 1000) return (count / 1000).toFixed(1) + "K";
    return String(count);
  }
};
