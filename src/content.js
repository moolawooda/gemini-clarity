// Gemini Clarity — Content Script
// API精确计数 + 动态安全系数 + 增量缓存 + Shadow DOM浮窗

(() => {
  const DEFAULT_MAX = 1000000;
  const IMG_TOKENS = 258;

  // 补偿参数
  const SYSTEM_OFFSET = 3000;        // 系统指令固定开销（加法）
  const FACTOR_THINKING_HIDDEN = 3.5; // thinking未展开：可见输出的倍数
  const FACTOR_CODE = 1.2;           // 代码块token密度补偿

  const LEVELS = [
    { max: 0.13, emoji: "\u{1F60A}", label: "Clear",    color: "#4CAF50" },
    { max: 0.20, emoji: "\u{1F610}", label: "Tired",    color: "#FF9800" },
    { max: 0.50, emoji: "\u{1F635}\u200D\u{1F4AB}", label: "Foggy",    color: "#F44336" },
    { max: 1.00, emoji: "\u{1F92F}", label: "Meltdown", color: "#9C27B0" }
  ];
  const LEVEL_DEAD = { max: Infinity, emoji: "\u{1F480}", label: "Dead", color: "#666666" };

  const INPUT_SELECTORS = [".ql-editor", "rich-textarea", ".text-input-field", "textarea", "[contenteditable='true']"];

  let debounceTimer = null;
  let shadowRoot = null;
  let hostEl = null;
  let isUpdating = false;
  let lastMethod = "none";

  // 增量缓存（按会话隔离，持久化到 chrome.storage.local）
  let processedTexts = new Set();
  let rawTokens = 0;       // API 精确计数（未加系数）
  let totalImages = 0;
  let currentSessionUrl = location.href;
  let currentModel = null; // 会话锁定的模型名（"Fast" / "Thinking" / "3 Pro" 等）
  let cacheLoaded = false;  // 标记缓存是否已加载
  let toolLocked = false;   // 会话锁定：检测到非文本工具后永久隐藏（本会话）
  let widgetCreated = false; // 胶囊是否已创建（延迟创建，确认无工具后才创建）
  let sessionTransitioning = false; // 会话切换中，阻止 MutationObserver 触发的早期扫描
  let cachedEstimatedTotal = 0; // 缓存的 estimatedTotal，刷新后避免补偿系数跳动

  // 持久化缓存：保存当前会话数据到 chrome.storage.local
  function saveSessionCache(overrideSid) {
    const sid = overrideSid || getSessionId();
    if (!sid || rawTokens === 0) return;
    const data = {};
    data["cache_" + sid] = {
      rawTokens,
      hashes: Array.from(processedTexts),
      totalImages,
      estimatedTotal: cachedEstimatedTotal,
      updatedAt: Date.now()
    };
    console.log(`[Clarity] SAVE cache: sid=${sid}, rawTokens=${rawTokens}, estimatedTotal=${cachedEstimatedTotal}, hashes=${processedTexts.size}, images=${totalImages}`);
    chrome.storage.local.set(data).catch((e) => console.error("[Clarity] SAVE error:", e));
  }

  // 持久化缓存：加载指定会话的缓存
  async function loadSessionCache() {
    const sid = getSessionId();
    console.log(`[Clarity] LOAD cache: sid=${sid}, url=${location.href}`);
    if (!sid) { cacheLoaded = true; return; }
    try {
      const result = await chrome.storage.local.get("cache_" + sid);
      const cached = result["cache_" + sid];
      if (cached && cached.rawTokens > 0) {
        rawTokens = cached.rawTokens;
        processedTexts = new Set(cached.hashes || []);
        totalImages = cached.totalImages || 0;
        cachedEstimatedTotal = cached.estimatedTotal || 0;
        console.log(`[Clarity] LOAD HIT: rawTokens=${rawTokens}, estimatedTotal=${cachedEstimatedTotal}, hashes=${processedTexts.size}, images=${totalImages}`);
      } else {
        console.log("[Clarity] LOAD MISS: no cache for this session");
      }
    } catch (e) {
      console.error("[Clarity] LOAD error:", e);
    }
    cacheLoaded = true;
  }

  // 检测当前模型：读 DOM 按钮文字，会话开始时锁定
  function detectModel() {
    const btns = document.querySelectorAll("button, [role='button'], [role='listbox']");
    for (const btn of btns) {
      const text = (btn.textContent || "").trim();
      if (/^(Fast|Thinking|[\d.]+ Pro|Pro)$/i.test(text)) {
        return text;
      }
    }
    // fallback: 查找带下拉箭头的模型选择器
    const selectors = document.querySelectorAll("[data-value], .model-selector, .mode-switcher");
    for (const el of selectors) {
      const text = (el.textContent || "").trim();
      if (/Fast|Thinking|Pro/i.test(text)) return text;
    }
    return null;
  }

  // 检测是否有激活的工具（Create image / Canvas / Deep research 等）
  function detectActiveTools() {
    // 方法1：查找 aria-label="Deselect ..." 的按钮（激活的工具标签）
    const deselectBtns = document.querySelectorAll('[aria-label^="Deselect"]');
    if (deselectBtns.length > 0) {
      const tools = Array.from(deselectBtns).map(b => b.getAttribute("aria-label").replace("Deselect ", ""));
      return tools;
    }
    return [];
  }

  // 隐藏胶囊
  function hideWidget() {
    if (hostEl) hostEl.style.display = "none";
  }

  // 显示胶囊
  function showWidget() {
    if (hostEl) hostEl.style.display = "";
  }

  // 从 URL 提取会话 ID（Gemini URL 格式：/app/会话ID）
  function getSessionId() {
    const m = location.pathname.match(/\/app\/([^/?]+)/);
    return m ? m[1] : location.href;
  }

  // 会话切换检测：URL 变化时保存旧缓存、加载新缓存
  function checkSessionChange() {
    if (location.href !== currentSessionUrl) {
      console.log(`[Clarity] SESSION CHANGE: ${currentSessionUrl} → ${location.href}`);
      // 保存旧会话缓存（用旧 URL 的 sid，避免交叉污染）
      const oldSid = currentSessionUrl.match(/\/app\/([^/?]+)/);
      saveSessionCache(oldSid ? oldSid[1] : currentSessionUrl);
      currentSessionUrl = location.href;
      // 重置内存状态
      processedTexts = new Set();
      rawTokens = 0;
      totalImages = 0;
      cachedEstimatedTotal = 0;
      currentModel = null;
      cacheLoaded = false;
      toolLocked = false; // 新会话重置工具锁定
      widgetCreated = false; // 新会话重置胶囊状态
      if (hostEl) { hostEl.remove(); hostEl = null; shadowRoot = null; } // 清除旧胶囊
      // 阻止过渡期间的扫描 + 取消待执行的扫描
      sessionTransitioning = true;
      clearTimeout(debounceTimer);
      // 加载新会话缓存后延迟扫描（等 SPA DOM 完全替换）
      loadSessionCache().then(() => {
        currentModel = detectModel();
        debounceTimer = setTimeout(() => {
          sessionTransitioning = false;
          fullScan();
        }, 3000);
      });
    }
  }

  function querySelector(selectors) {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function simpleHash(str) {
    let h = 0;
    for (let i = 0; i < Math.min(str.length, 200); i++) {
      h = ((h << 5) - h + str.charCodeAt(i)) | 0;
    }
    return h + "_" + str.length;
  }

  function getMessageElements() {
    let els = document.querySelectorAll("message-content");
    if (els.length > 0) return Array.from(els);
    els = document.querySelectorAll(".query-text, .markdown");
    if (els.length > 0) return Array.from(els);
    return [];
  }

  function countImages() {
    return document.querySelectorAll("message-content img, .conversation-container img").length;
  }

  // 检测 thinking 模式
  function detectThinking() {
    // 检测 "Show thinking" 按钮或 thinking 相关元素
    const thinkingBtns = document.querySelectorAll('[data-thinking], .show-thinking, [aria-label*="thinking"]');
    // 也检测包含 "Show thinking" 文字的按钮
    const allBtns = document.querySelectorAll("button, [role='button']");
    for (const btn of allBtns) {
      if (btn.textContent.includes("Show thinking") || btn.textContent.includes("thinking")) {
        return { hasThinking: true, expanded: btn.getAttribute("aria-expanded") === "true" };
      }
    }
    // 检测已展开的 thinking 内容区
    const thinkingContent = document.querySelector(".thinking-content, [data-thinking-content]");
    if (thinkingContent) return { hasThinking: true, expanded: true };
    if (thinkingBtns.length > 0) return { hasThinking: true, expanded: false };
    return { hasThinking: false, expanded: false };
  }

  // 检测代码块
  function hasCodeBlocks() {
    const codeEls = document.querySelectorAll("message-content pre, message-content code-block, message-content .code-block");
    return codeEls.length > 0;
  }

  // 计算补偿后的总 token 数
  function calcEstimatedTotal(rawTokens, imgTokens) {
    const thinking = detectThinking();
    const hasCode = hasCodeBlocks();
    const isThinkingModel = currentModel && /thinking/i.test(currentModel);

    let estimated = rawTokens;

    // 代码块密度补偿（对原始计数）
    if (hasCode) {
      estimated = Math.round(estimated * FACTOR_CODE);
    }

    // thinking 补偿：仅 Thinking 模式下生效
    if (isThinkingModel && thinking.hasThinking && !thinking.expanded) {
      // 未展开：可见输出 × 3.5 作为 thinking 开销估算，加到总量上
      estimated = estimated + Math.round(estimated * FACTOR_THINKING_HIDDEN);
    }
    // 已展开：thinking 文本已被精确计算在 rawTokens 里，不额外加
    // Fast/Pro：无 thinking 功能，跳过补偿

    // 固定开销：系统指令 + 图片
    estimated += SYSTEM_OFFSET + imgTokens;

    return estimated;
  }

  function getLevel(ratio) {
    if (ratio >= 1.0) return LEVEL_DEAD;
    for (const level of LEVELS) {
      if (ratio <= level.max) return level;
    }
    return LEVELS[LEVELS.length - 1];
  }

  // 非线性映射：实际 ratio → 视觉百分比
  // 四段等宽（各 25%），对应不同的实际 token 区间
  function ratioToVisual(ratio) {
    if (ratio <= 0) return 0;
    if (ratio <= 0.13) return (ratio / 0.13) * 25;
    if (ratio <= 0.20) return 25 + ((ratio - 0.13) / 0.07) * 25;
    if (ratio <= 0.50) return 50 + ((ratio - 0.20) / 0.30) * 25;
    if (ratio >= 1.00) return 100;
    return 75 + ((ratio - 0.50) / 0.50) * 25;
  }

  // ===== 动态定位（输入框上方靠右） =====
  function repositionWidget() {
    if (!hostEl) return;
    const input = querySelector(INPUT_SELECTORS);
    if (input) {
      let container = input;
      for (let i = 0; i < 8; i++) {
        if (container.parentElement && container.parentElement.offsetWidth > container.offsetWidth * 1.2) {
          container = container.parentElement;
          break;
        }
        if (container.parentElement) container = container.parentElement;
      }
      const rect = container.getBoundingClientRect();
      const hostWidth = hostEl.offsetWidth || 180;
      hostEl.style.left = (rect.right - hostWidth - 16) + "px";
      hostEl.style.bottom = (window.innerHeight - rect.top + 8) + "px";
      hostEl.style.top = "auto";
      hostEl.style.transform = "none";
    }
  }

  // ===== Shadow DOM =====
  function createWidget() {
    hostEl = document.createElement("div");
    hostEl.id = "gemini-clarity-host";
    hostEl.style.cssText = "position:fixed !important; z-index:2147483647 !important; pointer-events:auto !important;";
    document.body.appendChild(hostEl);
    shadowRoot = hostEl.attachShadow({ mode: "closed" });

    shadowRoot.innerHTML = `
      <style>
        :host { all: initial; }
        .pill {
          display: flex; align-items: center; gap: 8px;
          padding: 5px 14px;
          background: rgba(30, 30, 50, 0.9);
          backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          border-radius: 20px;
          border: 1px solid rgba(255,255,255,0.18);
          box-shadow: 0 2px 12px rgba(0,0,0,0.35);
          opacity: 0.8; transition: all 0.3s ease;
          cursor: default;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
          white-space: nowrap;
        }
        .pill:hover { opacity: 1; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
        .emoji { font-size: 20px; line-height: 1; transition: all 0.5s ease; }
        .track {
          position: relative; width: 120px; height: 6px; border-radius: 3px; overflow: hidden;
          background: linear-gradient(to right,
            rgba(76,175,80,0.2) 0%, rgba(76,175,80,0.2) 25%,
            rgba(255,152,0,0.2) 25%, rgba(255,152,0,0.2) 50%,
            rgba(244,67,54,0.2) 50%, rgba(244,67,54,0.2) 75%,
            rgba(156,39,176,0.2) 75%, rgba(156,39,176,0.2) 100%
          );
        }
        .fill {
          height: 100%; border-radius: 3px; width: 0%;
          background: linear-gradient(to right,
            #4CAF50 0%, #4CAF50 25%,
            #FF9800 25%, #FF9800 50%,
            #F44336 50%, #F44336 75%,
            #9C27B0 75%, #9C27B0 100%
          );
          background-size: 120px 100%;
          transition: width 0.8s ease;
        }
        .percent { font-size: 12px; font-weight: 700; color: #fff; min-width: 28px; text-align: right; transition: color 0.5s ease; }
      </style>
      <div class="pill">
        <span class="emoji">\u{1F60A}</span>
        <div class="track"><div class="fill"></div></div>
        <span class="percent">...</span>
      </div>
    `;

    repositionWidget();
    window.addEventListener("resize", repositionWidget);
    setInterval(repositionWidget, 2000);
  }

  function updateWidgetUI(estimatedTokens, ratio, level) {
    if (!widgetCreated) {
      createWidget();
      widgetCreated = true;
    }
    const visualPercent = ratioToVisual(ratio);
    const usagePercent = Math.round(ratio * 100);
    shadowRoot.querySelector(".fill").style.width = visualPercent + "%";
    shadowRoot.querySelector(".emoji").textContent = level.emoji;
    shadowRoot.querySelector(".percent").textContent = usagePercent + "%";
    shadowRoot.querySelector(".percent").style.color = level.color;
    repositionWidget();
  }

  // ===== 主逻辑 =====
  async function fullScan() {
    if (isUpdating || !cacheLoaded) {
      console.log(`[Clarity] fullScan SKIP: isUpdating=${isUpdating}, cacheLoaded=${cacheLoaded}`);
      return;
    }
    // 工具锁定：检测到非文本工具后整个会话不再计数
    if (toolLocked) return;
    const activeTools = detectActiveTools();
    if (activeTools.length > 0) {
      console.log(`[Clarity] Tools detected: ${activeTools.join(", ")} — hiding capsule for this session`);
      toolLocked = true;
      hideWidget();
      return;
    }
    isUpdating = true;

    try {
      const msgEls = getMessageElements();
      if (msgEls.length === 0) {
        // 如果有缓存数据，DOM 可能还没渲染完，跳过不清零
        if (rawTokens > 0) {
          console.log(`[Clarity] fullScan: 0 messages but cache has rawTokens=${rawTokens}, skip reset (DOM not ready)`);
          isUpdating = false;
          return;
        }
        console.log("[Clarity] fullScan: 0 messages, reset to 0%");
        rawTokens = 0;
        totalImages = 0;
        processedTexts = new Set();
        updateWidgetUI(0, 0, LEVELS[0]);
        isUpdating = false;
        return;
      }

      // 收集未处理的消息
      let newTexts = [];
      let skipped = 0;
      for (const el of msgEls) {
        const text = el.textContent || "";
        const hash = simpleHash(text);
        if (!processedTexts.has(hash) && text.trim()) {
          newTexts.push(text);
          processedTexts.add(hash);
        } else if (processedTexts.has(hash)) {
          skipped++;
        }
      }
      console.log(`[Clarity] fullScan: ${msgEls.length} msgs, ${newTexts.length} new, ${skipped} cached-skip, rawTokens=${rawTokens}`);

      // 新内容调 API
      if (newTexts.length > 0) {
        const combined = newTexts.join("\n");
        const result = await GeminiTokenizer.count(combined);
        rawTokens += result.tokens;
        lastMethod = result.method;
        console.log(`[Clarity] API counted: +${result.tokens} tokens (method=${result.method}), total rawTokens=${rawTokens}`);
      }

      // 计算 estimatedTotal：有新消息时重新算补偿，无新消息时用缓存值
      let estimatedTotal;
      if (newTexts.length > 0) {
        const imgCount = countImages();
        const imgTokens = imgCount * IMG_TOKENS;
        estimatedTotal = calcEstimatedTotal(rawTokens, imgTokens);
        cachedEstimatedTotal = estimatedTotal; // 更新缓存值
      } else {
        // 无新消息：优先用缓存的 estimatedTotal（避免懒加载导致补偿系数变化）
        estimatedTotal = cachedEstimatedTotal > 0 ? cachedEstimatedTotal : calcEstimatedTotal(rawTokens, countImages() * IMG_TOKENS);
      }

      // 更新 UI
      const ratio = Math.min(estimatedTotal / DEFAULT_MAX, 1.0);
      const level = getLevel(ratio);
      updateWidgetUI(estimatedTotal, ratio, level);

      chrome.runtime.sendMessage({
        type: "token_update",
        tokens: estimatedTotal, maxTokens: DEFAULT_MAX, ratio, level,
        formatted: GeminiTokenizer.formatTokens(estimatedTotal),
        percent: Math.round(ratio * 100)
      }).catch(() => {});

      // 持久化缓存
      if (newTexts.length > 0) saveSessionCache();

    } finally {
      isUpdating = false;
    }
  }

  function debouncedScan() {
    if (sessionTransitioning) return; // 会话切换中，忽略 MutationObserver 触发的扫描
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(fullScan, 2000);
  }

  function init() {
    // 胶囊延迟创建：不在 init 时创建，等第一次 fullScan 确认无工具后再创建
    // 加载缓存 → 检测模型 → 首次扫描
    loadSessionCache().then(() => {
      currentModel = detectModel();
      // 有缓存且无工具时立即用缓存的 estimatedTotal 更新 UI（避免补偿系数跳动）
      if (rawTokens > 0 && detectActiveTools().length === 0) {
        const est = cachedEstimatedTotal > 0 ? cachedEstimatedTotal : calcEstimatedTotal(rawTokens, totalImages * IMG_TOKENS);
        const r = Math.min(est / DEFAULT_MAX, 1.0);
        updateWidgetUI(est, r, getLevel(r));
      }
      setTimeout(fullScan, 1000);
    });

    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.addedNodes.length > 0 || m.type === "characterData") {
          checkSessionChange();
          debouncedScan();
          return;
        }
      }
    });

    observer.observe(document.body, {
      childList: true, subtree: true, characterData: true
    });

    // 定期检查会话切换 + 扫描
    setInterval(() => {
      checkSessionChange();
      debouncedScan();
    }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
