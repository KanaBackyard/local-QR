/**
 * 本地二维码识别 —— 页面内解码器（内容脚本，按需注入）
 *
 * 提供 window.__QR__：
 *   fromImage(srcUrl)            用 canvas 直读图片像素并解码
 *   rectOf(srcUrl)               返回图片在视口内的位置（用于截屏裁剪）
 *   ensureVisible(srcUrl)        把图片滚动到视口中央，返回它的位置
 *   fromScreenshot(dataUrl, rect) 从整页截图里裁出该图区域再解码
 *   toast(message, kind)         页面内轻提示（shadow DOM 隔离）
 */
(() => {
  if (window.__QR__) return;

  const MAX_SIDE = 2000;   // 原图过大时先缩到此尺寸，避免 jsQR 卡顿
  const SMALL_SIDE = 320;  // 长边小于此值视为小图，解码失败后放大重试
  const UPSCALE = 2;

  function loadError() {
    return typeof window.jsQR !== 'function';
  }

  function decodePixels(imageData, w, h) {
    if (loadError()) return null;
    const res = window.jsQR(imageData.data, w, h, { inversionAttempts: 'attemptBoth' });
    return res && res.data ? res.data : null;
  }

  function drawToImageData(source, sw, sh) {
    const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    return { data: ctx.getImageData(0, 0, w, h), w, h };
  }

  function upscale(imageData, factor) {
    const { data, width, height } = imageData;
    const tmp = document.createElement('canvas');
    tmp.width = width;
    tmp.height = height;
    tmp.getContext('2d').putImageData(data, 0, 0);

    const big = document.createElement('canvas');
    big.width = width * factor;
    big.height = height * factor;
    const ctx = big.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingEnabled = false; // 放大时保持模块边缘锐利
    ctx.drawImage(tmp, 0, 0, big.width, big.height);
    return { data: ctx.getImageData(0, 0, big.width, big.height), w: big.width, h: big.height };
  }

  function decodeImageData(imageData, w, h) {
    let text = decodePixels(imageData, w, h);
    if (!text && Math.max(w, h) <= SMALL_SIDE) {
      const big = upscale(imageData, UPSCALE);
      text = decodePixels(big.data, big.w, big.h);
    }
    return text;
  }

  function normalize(u) {
    try { return new URL(u, location.href).href; } catch { return String(u || ''); }
  }

  function findImage(srcUrl) {
    const list = Array.from(document.images || []);
    const target = normalize(srcUrl);
    const strip = (u) => String(u || '').split('?')[0].split('#')[0];

    for (const img of list) {
      if (img.currentSrc && normalize(img.currentSrc) === target) return img;
      if (img.src && normalize(img.src) === target) return img;
    }
    const bare = strip(target);
    for (const img of list) {
      if (strip(img.currentSrc) === bare || strip(img.src) === bare) return img;
    }
    if (list.length === 1) return list[0];
    return null;
  }

  function rectOf(img) {
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return {
      x: r.left,
      y: r.top,
      w: r.width,
      h: r.height,
      vw: window.innerWidth,
      vh: window.innerHeight,
    };
  }

  window.__QR__ = {
    fromImage(srcUrl) {
      const img = findImage(srcUrl);
      if (!img) return { ok: false, reason: 'no-image' };

      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      if (!nw || !nh) return { ok: false, reason: 'not-loaded' };

      let pack;
      try {
        pack = drawToImageData(img, nw, nh);
      } catch {
        // 跨域图片会污染 canvas，getImageData 抛 SecurityError
        return { ok: false, reason: 'tainted', rect: rectOf(img) };
      }

      const text = decodeImageData(pack.data, pack.w, pack.h);
      if (text) return { ok: true, text };

      return { ok: false, reason: 'not-found', rect: rectOf(img) };
    },

    rectOf(srcUrl) {
      const img = findImage(srcUrl);
      return img ? rectOf(img) : null;
    },

    /** 若图片不在视口内或只露出一部分，滚动到中央并返回新的位置 */
    ensureVisible(srcUrl) {
      const img = findImage(srcUrl);
      if (!img) return null;
      img.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
      return rectOf(img);
    },

    fromScreenshot(dataUrl, rect) {
      return new Promise((resolve) => {
        const image = new Image();
        image.onload = () => {
          try {
            // 截图是设备像素，rect 是 CSS 像素，按比例换算
            const sx = image.naturalWidth / (rect.vw || window.innerWidth);
            const sy = image.naturalHeight / (rect.vh || window.innerHeight);
            const pad = 2;
            const x = Math.max(0, Math.round((rect.x - pad) * sx));
            const y = Math.max(0, Math.round((rect.y - pad) * sy));
            const w = Math.min(image.naturalWidth - x, Math.round((rect.w + pad * 2) * sx));
            const h = Math.min(image.naturalHeight - y, Math.round((rect.h + pad * 2) * sy));
            if (w <= 8 || h <= 8) return resolve({ ok: false, reason: 'empty-rect' });

            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(image, x, y, w, h, 0, 0, w, h);

            const text = decodeImageData(ctx.getImageData(0, 0, w, h), w, h);
            resolve(text ? { ok: true, text } : { ok: false, reason: 'not-found' });
          } catch (e) {
            resolve({ ok: false, reason: 'error:' + e.message });
          }
        };
        image.onerror = () => resolve({ ok: false, reason: 'screenshot-load-failed' });
        image.src = dataUrl;
      });
    },

    toast(message, kind) {
      const old = document.getElementById('__qr_toast_host__');
      if (old) old.remove();

      const host = document.createElement('div');
      host.id = '__qr_toast_host__';
      host.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;';
      const root = host.attachShadow({ mode: 'closed' });

      const color = kind === 'error' ? '#b3261e' : '#1a73e8';
      const box = document.createElement('div');
      box.style.cssText = [
        'position:fixed',
        'left:50%',
        'top:24px',
        'transform:translateX(-50%)',
        'max-width:min(560px,86vw)',
        'padding:10px 16px',
        'border-radius:10px',
        'background:#fff',
        'color:#202124',
        'font:13px/1.5 system-ui,"Segoe UI",sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.18)',
        `border-left:4px solid ${color}`,
        'word-break:break-all',
        'pointer-events:none',
        'opacity:0',
        'transition:opacity .18s ease',
      ].join(';');
      box.textContent = message;
      root.appendChild(box);
      document.documentElement.appendChild(host);
      requestAnimationFrame(() => { box.style.opacity = '1'; });

      setTimeout(() => {
        box.style.opacity = '0';
        setTimeout(() => host.remove(), 220);
      }, 3200);
    },

    /**
     * 识别结果面板：弹窗展示内容，不自动跳转。
     *  - 网址：显示「打开链接」按钮，用户点击后才跳转
     *  - 非网址：只提供「复制」
     * @param {string} text 识别到的内容
     * @param {boolean} isUrl 是否是可跳转的 http(s) 网址
     */
    showResult(text, isUrl) {
      const oldHost = document.getElementById('__qr_panel_host__');
      if (oldHost) oldHost.remove();

      const host = document.createElement('div');
      host.id = '__qr_panel_host__';
      host.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;';
      const root = host.attachShadow({ mode: 'closed' });

      // ---- 遮罩 ----
      const overlay = document.createElement('div');
      overlay.style.cssText = [
        'position:fixed', 'inset:0',
        'background:rgba(15,18,24,.32)',
        'display:flex', 'align-items:center', 'justify-content:center',
        'padding:20px',
        'font:14px/1.55 system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
      ].join(';');

      // ---- 卡片 ----
      const card = document.createElement('div');
      card.style.cssText = [
        'box-sizing:border-box',
        'width:min(520px,92vw)',
        'max-height:min(560px,86vh)',
        'display:flex', 'flex-direction:column',
        'background:#fff', 'color:#202124',
        'border-radius:14px',
        'box-shadow:0 18px 48px rgba(0,0,0,.28)',
        'overflow:hidden',
      ].join(';');

      // 头部
      const head = document.createElement('div');
      head.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px',
        'padding:14px 16px 10px',
        'font-weight:600', 'font-size:15px',
      ].join(';');
      const title = document.createElement('span');
      title.textContent = '二维码识别结果';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = '✕';
      close.setAttribute('aria-label', '关闭');
      close.style.cssText = [
        'margin-left:auto', 'border:0', 'background:transparent',
        'font-size:16px', 'line-height:1', 'color:#5f6368',
        'cursor:pointer', 'padding:4px 6px', 'border-radius:6px',
      ].join(';');
      head.appendChild(title);
      head.appendChild(close);

      // 内容区（可选中复制）
      const body = document.createElement('div');
      body.style.cssText = 'padding:0 16px 4px;overflow:auto;';
      const pre = document.createElement('div');
      pre.textContent = text;
      pre.style.cssText = [
        'white-space:pre-wrap',
        'word-break:break-all',
        'user-select:text',
        'background:#f6f7f9',
        'border:1px solid #e6e8eb',
        'border-radius:10px',
        'padding:12px',
        'font:13px/1.5 ui-monospace,Consolas,"Courier New",monospace',
        'max-height:34vh',
        'overflow:auto',
      ].join(';');
      body.appendChild(pre);

      // 状态行
      const status = document.createElement('div');
      status.style.cssText = 'padding:6px 16px 0;font-size:12px;color:#1a73e8;min-height:18px;';

      // 底部按钮
      const foot = document.createElement('div');
      foot.style.cssText = [
        'display:flex', 'justify-content:flex-end', 'gap:8px',
        'padding:12px 16px 14px',
      ].join(';');

      const mkBtn = (label, primary) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = [
          'padding:8px 16px',
          'border-radius:8px',
          'font-size:13px',
          'font-weight:500',
          'cursor:pointer',
          'border:1px solid ' + (primary ? '#1a73e8' : '#dadce0'),
          'background:' + (primary ? '#1a73e8' : '#fff'),
          'color:' + (primary ? '#fff' : '#3c4043'),
        ].join(';');
        return b;
      };

      const copyBtn = mkBtn('复制');
      const openBtn = isUrl ? mkBtn('打开链接', true) : null;
      const cancelBtn = mkBtn('关闭');

      if (openBtn) foot.appendChild(openBtn);
      foot.appendChild(copyBtn);
      foot.appendChild(cancelBtn);

      card.appendChild(head);
      card.appendChild(body);
      card.appendChild(status);
      card.appendChild(foot);
      overlay.appendChild(card);
      root.appendChild(overlay);
      document.documentElement.appendChild(host);

      // 关闭统一入口：移除 DOM + 解绑键盘监听，避免多次识别后监听器堆积
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          closePanel();
        }
      };
      function closePanel() {
        window.removeEventListener('keydown', onKey, true);
        host.remove();
      }

      close.addEventListener('click', closePanel);
      cancelBtn.addEventListener('click', closePanel);

      // 点击遮罩空白处关闭（点卡片内部不关）
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePanel();
      });

      window.addEventListener('keydown', onKey, true);

      // 复制
      copyBtn.addEventListener('click', async () => {
        const ok = await copyText(text);
        status.textContent = ok ? '已复制到剪贴板' : '复制失败，请手动选中上方内容复制';
        if (!ok) status.style.color = '#b3261e';
        else setTimeout(() => { if (status.isConnected) status.textContent = ''; }, 1800);
      });

      // 打开链接（用户点击才跳转）
      if (openBtn) {
        openBtn.addEventListener('click', () => {
          closePanel();
          try {
            // 交给后台做 tabs.update，iframe 里触发也能跳顶层
            chrome.runtime.sendMessage({ type: 'qr-open-url', url: text });
          } catch {
            location.href = text;
          }
        });
      }

      async function copyText(value) {
        try {
          await navigator.clipboard.writeText(value);
          return true;
        } catch {
          /* 降级到 execCommand */
        }
        try {
          const ta = document.createElement('textarea');
          ta.value = value;
          ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
          document.body.appendChild(ta);
          ta.select();
          const ok = document.execCommand('copy');
          ta.remove();
          return ok;
        } catch {
          return false;
        }
      }
    },
  };
})();
