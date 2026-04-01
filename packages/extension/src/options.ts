const STORAGE_KEY = 'upstreamUrl';
const DEFAULT_URL = 'http://127.0.0.1:19824';

const urlInput = document.getElementById('url') as HTMLInputElement;
const saveBtn = document.getElementById('save') as HTMLButtonElement;
const statusDiv = document.getElementById('status') as HTMLDivElement;

// 加载当前设置
chrome.storage.sync.get(STORAGE_KEY, (result) => {
  urlInput.value = result[STORAGE_KEY] || '';
  urlInput.placeholder = DEFAULT_URL;
});

saveBtn.addEventListener('click', async () => {
  const url = urlInput.value.trim();
  await chrome.storage.sync.set({ [STORAGE_KEY]: url });
  statusDiv.textContent = `Saved. ${url ? `Using: ${url}` : `Using default: ${DEFAULT_URL}`}`;
  statusDiv.className = 'status saved';
  setTimeout(() => { statusDiv.textContent = ''; }, 3000);
});
