const MENU_ID = 'qr-scan-image';

function ensureMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_ID, title: '识别图片中的二维码', contexts: ['image'] });
  });
}

chrome.runtime.onInstalled.addListener(ensureMenu);
chrome.runtime.onStartup.addListener(ensureMenu);

const isHttpUrl = (t) => /^https?:\/\/[^\s]+$/i.test(t);

async function runInFrame(tabId, frameId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, func, args });
  return r?.result;
}

async function toast(tabId, frameId, message, kind = 'ok') {
  try {
    await runInFrame(tabId, frameId, (m, k) => window.__QR__ && window.__QR__.toast(m, k), [message, kind]);
  } catch {}
}

async function decodeFromScreenshot(tabId, frameId, srcUrl, rect) {
  if (frameId !== 0) return null;

  let r = rect;
  if (r.y < 0 || r.x < 0 || r.y + r.h > r.vh || r.x + r.w > r.vw) {
    const moved = await runInFrame(tabId, frameId, (src) => window.__QR__.ensureVisible(src), [srcUrl]);
    if (moved) r = moved;
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
  return runInFrame(tabId, frameId, (url, rc) => window.__QR__.fromScreenshot(url, rc), [dataUrl, r]);
}

async function navigate(tabId, frameId, url) {
  if (!isHttpUrl(url)) return;
  try {
    await chrome.tabs.update(tabId, { url });
    return;
  } catch {}
  try {
    await runInFrame(tabId, frameId, (u) => { location.href = u; }, [url]);
    return;
  } catch {}
  await chrome.tabs.create({ url });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== 'qr-open-url') return;
  const tabId = sender?.tab?.id;
  const frameId = sender?.frameId ?? 0;
  if (typeof tabId !== 'number' || !isHttpUrl(String(msg.url || ''))) {
    sendResponse({ ok: false });
    return;
  }
  navigate(tabId, frameId, String(msg.url));
  sendResponse({ ok: true });
});

async function handleScan(info, tab) {
  const tabId = tab.id;
  const frameId = info.frameId ?? 0;
  const srcUrl = info.srcUrl || '';

  try {
    if (!srcUrl) {
      await toast(tabId, frameId, '这个位置不是可识别的图片', 'error');
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      files: ['lib/jsQR.js', 'decode.js'],
    });

    let res = await runInFrame(tabId, frameId, (src) => window.__QR__.fromImage(src), [srcUrl]);

    if (!res?.ok) {
      const rect = res?.rect || (await runInFrame(tabId, frameId, (src) => window.__QR__.rectOf(src), [srcUrl]));
      if (rect) {
        try {
          const retry = await decodeFromScreenshot(tabId, frameId, srcUrl, rect);
          if (retry?.ok) res = retry;
        } catch {}
      }
    }

    if (!res?.ok) {
      const msg =
        res?.reason === 'not-loaded' ? '图片还没加载完成，稍等片刻再试'
          : res?.reason === 'no-image' ? '没找到这张图片，请直接在图片上右键'
            : frameId !== 0 ? '跨域图片，且子框架无法截屏识别（可先放大图片后重试）'
              : '图片中没有识别到二维码';
      await toast(tabId, frameId, msg, 'error');
      return;
    }

    const text = String(res.text).trim();

    try {
      await runInFrame(tabId, frameId, (t) => window.__QR__.showResult(t), [text]);
    } catch {
      await toast(tabId, frameId, '已识别：' + text, 'ok');
    }
  } catch (err) {
    const message = String(err?.message || err);
    if (/cannot be scripted|cannot access|Missing host permission|extensions gallery/i.test(message)) {
      chrome.action.setBadgeText({ text: '✕' });
      chrome.action.setBadgeBackgroundColor({ color: '#b3261e' });
      setTimeout(() => chrome.action.setBadgeText({ text: '' }), 2500);
      return;
    }
    await toast(tabId, frameId, '识别失败：' + message, 'error');
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  handleScan(info, tab);
});
