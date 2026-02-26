// Gemini Clarity — Background Service Worker
// 状态管理 + API 代理

// API Key 从 chrome.storage 读取（用户在 options 页面配置）
let API_KEY = "";
chrome.storage.sync.get("geminiApiKey", (data) => {
  if (data.geminiApiKey) API_KEY = data.geminiApiKey;
});
chrome.storage.onChanged.addListener((changes) => {
  if (changes.geminiApiKey) API_KEY = changes.geminiApiKey.newValue || "";
});

let currentState = {
  tokens: 0,
  maxTokens: 1000000,
  ratio: 0,
  level: null,
  formatted: "0",
  percent: 0
};

// countTokens API 代理（content script 不能直接调外部 API）
async function countTokensAPI(text, model = "gemini-2.0-flash") {
  if (!text || !API_KEY) return null;
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:countTokens?key=${API_KEY}`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }]
      })
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.totalTokens || null;
  } catch (e) {
    console.error("countTokens error:", e);
    return null;
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // API 代理请求
  if (msg.type === "count_tokens") {
    countTokensAPI(msg.text, msg.model).then(tokens => {
      sendResponse({ tokens });
    });
    return true; // async response
  }

  // UI 更新
  if (msg.type === "token_update") {
    currentState = { ...msg };
    const tabId = sender.tab?.id;

    // hover 提示（图标始终用静态蓝紫渐变 G，不变色）
    chrome.action.setTitle({
      title: `${msg.level?.emoji || ""} Gemini Clarity\n${msg.percent}% used (${msg.formatted} tokens)\nStatus: ${msg.level?.label || "Unknown"}`,
      tabId
    });
  }

  if (msg.type === "get_state") {
    sendResponse(currentState);
  }

  return true;
});

// 非 Gemini 页面时重置 hover 提示
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    if (!tab.url?.includes("gemini.google.com")) {
      chrome.action.setTitle({ title: "Gemini Clarity", tabId: activeInfo.tabId });
    }
  } catch (e) {}
});
