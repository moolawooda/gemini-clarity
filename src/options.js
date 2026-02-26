// Gemini Clarity — Options Page

const keyInput = document.getElementById("apiKey");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

// Load saved key
chrome.storage.sync.get("geminiApiKey", (data) => {
  if (data.geminiApiKey) keyInput.value = data.geminiApiKey;
});

saveBtn.addEventListener("click", () => {
  const key = keyInput.value.trim();
  if (!key) {
    statusEl.textContent = "Please enter an API key.";
    statusEl.className = "status err";
    return;
  }
  chrome.storage.sync.set({ geminiApiKey: key }, () => {
    statusEl.textContent = "Saved!";
    statusEl.className = "status ok";
    setTimeout(() => { statusEl.textContent = ""; }, 2000);
  });
});
