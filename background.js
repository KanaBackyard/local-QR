/**
 * 本地二维码识别 —— 后台 Service Worker
 *
 * 解码策略（全部本地，不访问任何在线识别服务）：
 *   1. 页面 canvas 直读像素     —— 同源图 / 带 CORS 头的图，最快且无损
 *   2. 整页截图 → 裁剪该图区域  —— 跨域图（canvas 会被污染）时的兜底
 *
 * 识别到 http(s) 链接 → 当前标签页跳转；其它内容 → 页面内提示并复制，绝不跳转。
 *
 * 权限说明：只用 contextMenus / activeTab / scripting，不申请 host_permissions，
 * 因此扩展在任何页面都不会自动获得读取权限，只在用户点右键菜单那一刻生效。
 */

const MENU_ID = 'qr-scan-image';
const MENU_TITLE = '识别图片中的二维码';

// ---------------- 右键菜单 ----------------
function ensureMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: MENU_TITLE,
      contexts: ['image'],
    });
  });
}

chrome.runtime.onInstalled.addListener(ensureMenu);
chrome.runtime.onStartup.addListener(ensureMenu);

// ---------------- 通用 ----------------
// 只允许 http/https，且不允许出现空白：避免 javascript:、data: 等伪协议被利用
const isHttpUrl = (t) => /^https?:\/\/[^\s]+$/i.test(t);

async function injectDecoder(tabId, frameId) {
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    files: ['lib/jsQR.js', 'decode.js'],
  });
}

async function runInFrame(tabId, frameId, func, args = []) {
  const [r] = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    func,
    args,
  });
  return r?.result;
}

async function toast(tabId, frameId, message, kind = 'ok') {
  try {
    await runInFrame(tabId, frameId, (m, k) => window.__QR__ && window.__QR__.toast(m, k), [message, kind]);
  } catch {
    /* chrome:// 等页面无法注入 */
  }
}

// ---------------- 截图兜底 ----------------
// 只在顶层 frame 使用：子 frame 的 getBoundingClientRect 是相对 iframe 视口的，
// 而 captureVisibleTab 截的是顶层页面，坐标对不上。
async function decodeFromScreenshot(tabId, frameId, srcUrl, rect) {
  if (frameId !== 0) return null;

  let r = rect;
  const outside = r.y < 0 || r.x < 0 || r.y + r.h > r.vh || r.x + r.w > r.vw;
  if (outside) {
    const moved = await runInFrame(tabId, frameId, (src) => window.__QR__.ensureVisible(src), [srcUrl]);
    if (moved) r = moved;
  }

  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, { format: 'png' });
  return runInFrame(
    tabId,
    frameId,
    (url, rc) => window.__QR__.fromScreenshot(url, rc),
    [dataUrl, r],
  );
}

// ---------------- 跳转（只由用户点击面板按钮触发） ----------------
// 三级兜底：tabs.update → 页面内 location.href → 新标签打开
async function navigate(tabId, frameId, url) {
  if (!isHttpUrl(url)) return; // 双重保险：只允许 http(s)

  try {
    await chrome.tabs.update(tabId, { url });
    return;
  } catch {
    /* 某些页面不允许直接改 URL，继续 */
  }
  try {
    await runInFrame(tabId, frameId, (u) => { location.href = u; }, [url]);
    return;
  } catch {
    /* 无法注入，最后开新标签 */
  }
  await chrome.tabs.create({ url });
}

// 面板上的「打开链接」按钮通过消息转发到后台，这样在 iframe 里也能跳顶层
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

// ---------------- 主流程 ----------------
async function handleScan(info, tab) {
  const tabId = tab.id;
  const frameId = info.frameId ?? 0;
  const srcUrl = info.srcUrl || '';

  try {
    if (!srcUrl) {
      await toast(tabId, frameId, '这个位置不是可识别的图片', 'error');
      return;
    }

    await injectDecoder(tabId, frameId);

    // 1) canvas 直读
    let res = await runInFrame(tabId, frameId, (src) => window.__QR__.fromImage(src), [srcUrl]);

    // 2) 截图裁剪（仅顶层 frame）
    if (!res?.ok) {
      const rect = res?.rect || (await runInFrame(tabId, frameId, (src) => window.__QR__.rectOf(src), [srcUrl]));
      if (rect) {
        try {
          const retry = await decodeFromScreenshot(tabId, frameId, srcUrl, rect);
          if (retry?.ok) res = retry;
        } catch {
          /* 截图失败（窗口最小化等），继续走失败提示 */
        }
      }
    }

    if (!res?.ok) {
      const msg =
        res?.reason === 'not-loaded'
          ? '图片还没加载完成，稍等片刻再试'
          : res?.reason === 'no-image'
            ? '没找到这张图片，请直接在图片上右键'
            : frameId !== 0
              ? '跨域图片，且子框架无法截屏识别（可先放大图片后重试）'
              : '图片中没有识别到二维码';
      await toast(tabId, frameId, msg, 'error');
      return;
    }

    const text = String(res.text).trim();
    const isUrl = isHttpUrl(text);

    // 不自动跳转：统一弹出结果面板，由用户决定「打开链接」还是「复制」
    try {
      await runInFrame(
        tabId,
        frameId,
        (t, u) => window.__QR__.showResult(t, u),
        [text, isUrl],
      );
    } catch {
      // 极少数页面注入被拦，降级为复制 + 提示
      await toast(tabId, frameId, '已识别：' + text, 'ok');
    }
  } catch (err) {
    const message = String(err?.message || err);
    // chrome:// 页面、扩展商店页等不允许注入脚本
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
