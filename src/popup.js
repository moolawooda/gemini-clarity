// Gemini Clarity — Popup

const LEVELS = [
  { max: 0.13, emoji: "\u{1F60A}", label: "Clear Mind", advice: "High-efficiency zone (0-128K). Best for complex reasoning and hard questions." },
  { max: 0.20, emoji: "\u{1F610}", label: "Getting Tired", advice: "Past 128K — accuracy dropping. Wrap up complex tasks or start a new chat." },
  { max: 0.50, emoji: "\u{1F635}\u200D\u{1F4AB}", label: "Brain Fog", advice: "200K-500K zone. Output quality significantly degraded. Double-check everything." },
  { max: 1.00, emoji: "\u{1F92F}", label: "Meltdown!", advice: "Beyond 500K — retrieval near random. Start a fresh conversation now (F5)." }
];
const LEVEL_DEAD = { max: Infinity, emoji: "\u{1F480}", label: "Dead", advice: "Context window exhausted. This conversation is beyond saving. Start fresh!" };

function getLevel(ratio) {
  if (ratio >= 1.0) return LEVEL_DEAD;
  for (const level of LEVELS) {
    if (ratio <= level.max) return level;
  }
  return LEVELS[LEVELS.length - 1];
}

function ratioToVisual(ratio) {
  if (ratio <= 0) return 0;
  if (ratio <= 0.13) return (ratio / 0.13) * 25;
  if (ratio <= 0.20) return 25 + ((ratio - 0.13) / 0.07) * 25;
  if (ratio <= 0.50) return 50 + ((ratio - 0.20) / 0.30) * 25;
  if (ratio >= 1.00) return 100;
  return 75 + ((ratio - 0.50) / 0.50) * 25;
}

function formatTokens(count) {
  if (count >= 1000000) return (count / 1000000).toFixed(1) + "M";
  if (count >= 1000) return (count / 1000).toFixed(1) + "K";
  return String(count);
}

async function render() {
  const container = document.getElementById("content");

  // Check if API key is configured
  const { geminiApiKey } = await chrome.storage.sync.get("geminiApiKey");
  if (!geminiApiKey) {
    container.innerHTML = '<div class="no-data">API Key not set.<br><a href="#" id="openOptions" style="color:#4285F4">Configure in Settings</a></div>';
    document.getElementById("openOptions")?.addEventListener("click", (e) => {
      e.preventDefault();
      chrome.runtime.openOptionsPage();
    });
    return;
  }

  try {
    const state = await chrome.runtime.sendMessage({ type: "get_state" });

    if (!state || state.tokens === 0) {
      container.innerHTML = '<div class="no-data">Open Gemini to start monitoring</div>';
      return;
    }

    const level = getLevel(state.ratio);
    const visualPercent = ratioToVisual(state.ratio);
    const usagePercent = state.percent;

    container.innerHTML = `
      <div class="header">
        <div class="emoji">${level.emoji}</div>
        <div class="status-label">${level.label}</div>
      </div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: ${visualPercent}%;${visualPercent > 0 ? ` background-size: ${(100 / visualPercent) * 100}% 100%` : ''}"></div>
      </div>
      <div class="stats">
        <span><span class="value">${formatTokens(state.tokens)}</span> tokens</span>
        <span><span class="value">${usagePercent}%</span> used</span>
      </div>
      <div class="advice">${level.advice}</div>
    `;
    container.className = "";
  } catch (e) {
    container.innerHTML = '<div class="no-data">Open Gemini to start monitoring</div>';
  }
}

render();
