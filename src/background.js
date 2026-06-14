chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL('viewer.html') });
});

const SHARED_FILE_HOSTS = new Set([
  'storage.googleapis.com',
  'omni-viewer-share-624036133562.us-west1.run.app',
]);

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'omniViewerSharePing') {
    sendResponse({ ok: true, version: 1 });
    return undefined;
  }
  if (message?.type !== 'omniViewerFetchSharedFile') return undefined;

  (async () => {
    try {
      const url = new URL(String(message.url || ''));
      const isShareApi = url.hostname === 'omni-viewer-share-624036133562.us-west1.run.app';
      const isShareStorage = url.hostname === 'storage.googleapis.com'
        && url.pathname.startsWith('/omni-viewer-web-share/');
      if (url.protocol !== 'https:' || !SHARED_FILE_HOSTS.has(url.hostname)
        || (!isShareApi && !isShareStorage)) {
        throw new Error('Shared file download URL is not allowed.');
      }
      const response = await fetch(url.href, { method: 'GET' });
      if (!response.ok) {
        sendResponse({ ok: false, status: response.status, error: `HTTP ${response.status}` });
        return;
      }
      const bytes = await response.arrayBuffer();
      sendResponse({
        ok: true,
        status: response.status,
        base64: arrayBufferToBase64(bytes),
        contentType: response.headers.get('content-type') || '',
      });
    } catch (error) {
      sendResponse({
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  })();

  return true;
});
