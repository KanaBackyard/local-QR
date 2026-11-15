(() => {
  if (window.__QR__) return;

  const MAX_SIDE = 2000;
  const SMALL_SIDE = 320;
  const UPSCALE = 2;
  const ADAPT_STEPS = [[1, 5], [1.5, 5], [0.75, 5], [1, 12], [1, 2], [2, 5], [3, 2], [1, 20]];
  const URL_PATTERN = /https?:\/\/[^\s<>"'`\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]+/gi;
  const TRAILING_PUNCT = /[.,;:!?)\]}>'"''""''、。，；：！？）】》」』…]+$/;

  function runQR(rgba, w, h) {
    if (typeof window.jsQR !== 'function' || w < 8 || h < 8) return null;
    const res = window.jsQR(rgba, w, h, { inversionAttempts: 'attemptBoth' });
    return res && res.data ? res.data : null;
  }

  function toGray(rgba, w, h, mode) {
    const out = new Uint8ClampedArray(w * h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      let v;
      if (mode === 'lum') v = 0.299 * r + 0.587 * g + 0.114 * b;
      else if (mode === 'min') v = r < g ? (r < b ? r : b) : (g < b ? g : b);
      else if (mode === 'max') v = r > g ? (r > b ? r : b) : (g > b ? g : b);
      else {
        const mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
        const mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
        v = mx - mn;
      }
      out[p] = v;
    }
    return out;
  }

  function grayToRGBA(gray, w, h) {
    const out = new Uint8ClampedArray(w * h * 4);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      out[i] = out[i + 1] = out[i + 2] = gray[p];
      out[i + 3] = 255;
    }
    return out;
  }

  function boxBlur(gray, w, h, radius) {
    if (radius <= 0) return gray;
    const tmp = new Float32Array(w * h);
    const out = new Uint8ClampedArray(w * h);
    const span = radius * 2 + 1;
    for (let y = 0; y < h; y++) {
      const base = y * w;
      let sum = 0;
      for (let x = -radius; x <= radius; x++) sum += gray[base + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        tmp[base + x] = sum / span;
        sum -= gray[base + Math.max(0, x - radius)];
        sum += gray[base + Math.min(w - 1, x + radius + 1)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -radius; y <= radius; y++) sum += tmp[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        out[y * w + x] = sum / span;
        sum -= tmp[Math.max(0, y - radius) * w + x];
        sum += tmp[Math.min(h - 1, y + radius + 1) * w + x];
      }
    }
    return out;
  }

  function adaptiveThreshold(gray, w, h, radius, offset) {
    const integ = new Float64Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let rowSum = 0;
      const base = y * w;
      for (let x = 0; x < w; x++) {
        rowSum += gray[base + x];
        integ[(y + 1) * (w + 1) + (x + 1)] = integ[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    const out = new Uint8ClampedArray(w * h);
    for (let y = 0; y < h; y++) {
      const y1 = y - radius < 0 ? 0 : y - radius;
      const y2 = y + radius > h - 1 ? h - 1 : y + radius;
      for (let x = 0; x < w; x++) {
        const x1 = x - radius < 0 ? 0 : x - radius;
        const x2 = x + radius > w - 1 ? w - 1 : x + radius;
        const count = (x2 - x1 + 1) * (y2 - y1 + 1);
        const sum = integ[(y2 + 1) * (w + 1) + (x2 + 1)] - integ[y1 * (w + 1) + (x2 + 1)]
          - integ[(y2 + 1) * (w + 1) + x1] + integ[y1 * (w + 1) + x1];
        out[y * w + x] = gray[y * w + x] > sum / count - offset ? 255 : 0;
      }
    }
    return out;
  }

  function otsuThreshold(gray, w, h) {
    const hist = new Uint32Array(256);
    const n = w * h;
    for (let p = 0; p < n; p++) hist[gray[p]]++;
    let sum = 0;
    for (let i = 0; i < 256; i++) sum += i * hist[i];
    let sumB = 0, wB = 0, best = -1, thr = 127;
    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (!wB) continue;
      const wF = n - wB;
      if (!wF) break;
      sumB += t * hist[t];
      const mB = sumB / wB, mF = (sum - sumB) / wF;
      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = t; }
    }
    return thr;
  }

  function globalThreshold(gray, w, h) {
    const thr = otsuThreshold(gray, w, h);
    const out = new Uint8ClampedArray(w * h);
    for (let p = 0; p < w * h; p++) out[p] = gray[p] > thr ? 255 : 0;
    return out;
  }

  function resize(rgba, w, h, nw, nh) {
    if (nw === w && nh === h) return rgba;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const sy0 = Math.floor(y * h / nh), sy1 = Math.max(sy0 + 1, Math.floor((y + 1) * h / nh));
      for (let x = 0; x < nw; x++) {
        const sx0 = Math.floor(x * w / nw), sx1 = Math.max(sx0 + 1, Math.floor((x + 1) * w / nw));
        let r = 0, g = 0, b = 0, n = 0;
        for (let yy = sy0; yy < sy1 && yy < h; yy++) {
          for (let xx = sx0; xx < sx1 && xx < w; xx++) {
            const i = (yy * w + xx) * 4;
            r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; n++;
          }
        }
        const di = (y * nw + x) * 4;
        out[di] = n ? r / n : 0;
        out[di + 1] = n ? g / n : 0;
        out[di + 2] = n ? b / n : 0;
        out[di + 3] = 255;
      }
    }
    return out;
  }

  function scaleDown(rgba, w, h, maxSide) {
    if (Math.max(w, h) <= maxSide) return { data: rgba, w, h };
    const s = maxSide / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
    return { data: resize(rgba, w, h, nw, nh), w: nw, h: nh };
  }

  function upscaleNearest(rgba, w, h, factor) {
    const nw = w * factor, nh = h * factor;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const sy = (y / factor) | 0;
      for (let x = 0; x < nw; x++) {
        const si = (sy * w + ((x / factor) | 0)) * 4;
        const di = (y * nw + x) * 4;
        out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
      }
    }
    return { data: out, w: nw, h: nh };
  }

  function contentBox(gray, w, h) {
    const thr = otsuThreshold(gray, w, h);
    let x0 = w, y0 = h, x1 = -1, y1 = -1;
    for (let y = 0; y < h; y++) {
      const base = y * w;
      for (let x = 0; x < w; x++) {
        if (gray[base + x] < thr) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
      }
    }
    if (x1 < 0) return null;
    return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  function cropRGBA(rgba, w, h, box, pad) {
    const x0 = Math.max(0, box.x - pad), y0 = Math.max(0, box.y - pad);
    const x1 = Math.min(w, box.x + box.w + pad), y1 = Math.min(h, box.y + box.h + pad);
    const nw = x1 - x0, nh = y1 - y0;
    if (nw <= 0 || nh <= 0) return null;
    const out = new Uint8ClampedArray(nw * nh * 4);
    for (let y = 0; y < nh; y++) {
      const srcRow = (y0 + y) * w, dstRow = y * nw;
      for (let x = 0; x < nw; x++) {
        const si = (srcRow + x0 + x) * 4, di = (dstRow + x) * 4;
        out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
      }
    }
    return { data: out, w: nw, h: nh };
  }

  function canonicalize(rgba, w, h, target) {
    const box = contentBox(toGray(rgba, w, h, 'min'), w, h);
    if (!box) return null;

    const pad = Math.round(Math.max(box.w, box.h) * 0.08);
    const x0 = Math.max(0, box.x - pad), y0 = Math.max(0, box.y - pad);
    const x1 = Math.min(w, box.x + box.w + pad), y1 = Math.min(h, box.y + box.h + pad);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 16 || ch < 16) return null;

    let br = 0, bg = 0, bb = 0;
    for (const [sx, sy] of [[x0, y0], [x1 - 1, y0], [x0, y1 - 1], [x1 - 1, y1 - 1]]) {
      const i = (Math.min(h - 1, sy) * w + Math.min(w - 1, sx)) * 4;
      br += rgba[i]; bg += rgba[i + 1]; bb += rgba[i + 2];
    }
    br = Math.round(br / 4); bg = Math.round(bg / 4); bb = Math.round(bb / 4);

    const side = Math.max(cw, ch);
    const square = new Uint8ClampedArray(side * side * 4);
    for (let i = 0; i < square.length; i += 4) {
      square[i] = br; square[i + 1] = bg; square[i + 2] = bb; square[i + 3] = 255;
    }
    const ox = Math.round((side - cw) / 2), oy = Math.round((side - ch) / 2);
    for (let y = 0; y < ch; y++) {
      for (let x = 0; x < cw; x++) {
        const si = ((y0 + y) * w + (x0 + x)) * 4;
        const di = ((oy + y) * side + (ox + x)) * 4;
        square[di] = rgba[si];
        square[di + 1] = rgba[si + 1];
        square[di + 2] = rgba[si + 2];
        square[di + 3] = 255;
      }
    }
    return resize(square, side, side, target, target);
  }

  function tryAdaptive(rgba, w, h) {
    const base = Math.max(6, Math.round(Math.min(w, h) * 0.03));
    for (const mode of ['min', 'lum']) {
      const g = toGray(rgba, w, h, mode);
      for (const [mult, offset] of ADAPT_STEPS) {
        const radius = Math.max(4, Math.round(base * mult));
        const text = runQR(grayToRGBA(adaptiveThreshold(g, w, h, radius, offset), w, h), w, h);
        if (text) return text;
      }
    }
    return null;
  }

  function decodeImageData(imageData) {
    const { data, width, height } = imageData;
    const scaled = scaleDown(data, width, height, MAX_SIDE);
    const rgba = scaled.data, w = scaled.w, h = scaled.h;

    let text = runQR(rgba, w, h);
    if (text) return text;

    text = tryAdaptive(rgba, w, h);
    if (text) return text;

    if (Math.max(w, h) <= SMALL_SIDE) {
      const up = upscaleNearest(rgba, w, h, UPSCALE);
      text = runQR(up.data, up.w, up.h) || tryAdaptive(up.data, up.w, up.h);
      if (text) return text;
    }

    for (const target of [240, 160, 320]) {
      const c = canonicalize(rgba, w, h, target);
      if (!c) continue;
      text = runQR(c, target, target) || tryAdaptive(c, target, target);
      if (text) return text;
    }

    const box = contentBox(toGray(rgba, w, h, 'min'), w, h);
    if (box) {
      const pad = Math.round(Math.min(box.w, box.h) * 0.05);
      const c = cropRGBA(rgba, w, h, box, pad);
      if (c && c.w * c.h < w * h * 0.85) {
        text = runQR(c.data, c.w, c.h) || tryAdaptive(c.data, c.w, c.h);
        if (text) return text;
        for (const target of [240, 160]) {
          const c2 = canonicalize(c.data, c.w, c.h, target);
          if (!c2) continue;
          text = runQR(c2, target, target) || tryAdaptive(c2, target, target);
          if (text) return text;
        }
      }
    }

    const base = Math.max(6, Math.round(Math.min(w, h) * 0.03));
    for (const mode of ['min', 'lum', 'sat', 'max']) {
      const g = toGray(rgba, w, h, mode);
      text = runQR(grayToRGBA(adaptiveThreshold(boxBlur(g, w, h, 1), w, h, base, 5), w, h), w, h);
      if (text) return text;
    }

    const grayMin = toGray(rgba, w, h, 'min');
    return runQR(grayToRGBA(globalThreshold(grayMin, w, h), w, h), w, h);
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
    return list.length === 1 ? list[0] : null;
  }

  function rectOf(img) {
    const r = img.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: r.left, y: r.top, w: r.width, h: r.height, vw: window.innerWidth, vh: window.innerHeight };
  }

  function findLinks(text) {
    const links = [];
    URL_PATTERN.lastIndex = 0;
    let match;
    while ((match = URL_PATTERN.exec(text)) !== null) {
      let url = match[0];
      while (url && TRAILING_PUNCT.test(url)) url = url.slice(0, -1);
      if (url) links.push({ start: match.index, end: match.index + url.length, url });
    }
    return links;
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
    return ctx.getImageData(0, 0, w, h);
  }

  function el(tag, css, text) {
    const node = document.createElement(tag);
    if (css) node.style.cssText = css;
    if (text != null) node.textContent = text;
    return node;
  }

  function copyText(value) {
    return navigator.clipboard.writeText(value).then(() => true, () => {
      try {
        const ta = el('textarea');
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
    });
  }

  window.__QR__ = {
    fromImage(srcUrl) {
      const img = findImage(srcUrl);
      if (!img) return { ok: false, reason: 'no-image' };

      const nw = img.naturalWidth || img.width;
      const nh = img.naturalHeight || img.height;
      if (!nw || !nh) return { ok: false, reason: 'not-loaded' };

      let pixels;
      try {
        pixels = drawToImageData(img, nw, nh);
      } catch {
        return { ok: false, reason: 'tainted', rect: rectOf(img) };
      }

      const text = decodeImageData(pixels);
      return text ? { ok: true, text } : { ok: false, reason: 'not-found', rect: rectOf(img) };
    },

    rectOf(srcUrl) {
      const img = findImage(srcUrl);
      return img ? rectOf(img) : null;
    },

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

            const text = decodeImageData(ctx.getImageData(0, 0, w, h));
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

      const host = el('div');
      host.id = '__qr_toast_host__';
      host.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;';
      const root = host.attachShadow({ mode: 'closed' });

      const box = el('div', [
        'position:fixed', 'left:50%', 'top:24px', 'transform:translateX(-50%)',
        'max-width:min(560px,86vw)', 'padding:10px 16px', 'border-radius:10px',
        'background:#fff', 'color:#202124', 'font:13px/1.5 system-ui,"Segoe UI",sans-serif',
        'box-shadow:0 6px 24px rgba(0,0,0,.18)',
        `border-left:4px solid ${kind === 'error' ? '#b3261e' : '#1a73e8'}`,
        'word-break:break-all', 'pointer-events:none', 'opacity:0', 'transition:opacity .18s ease',
      ].join(';'), message);

      root.appendChild(box);
      document.documentElement.appendChild(host);
      requestAnimationFrame(() => { box.style.opacity = '1'; });

      setTimeout(() => {
        box.style.opacity = '0';
        setTimeout(() => host.remove(), 220);
      }, 3200);
    },

    showResult(text) {
      const raw = String(text ?? '');
      const links = findLinks(raw);
      const trimmed = raw.trim();
      const start = raw.indexOf(trimmed);
      const pure = links.length === 1 && links[0].start === start
        && links[0].end === start + trimmed.length ? links[0].url : null;
      const mixed = !pure && links.length > 0;

      const oldHost = document.getElementById('__qr_panel_host__');
      if (oldHost) oldHost.remove();

      const host = el('div');
      host.id = '__qr_panel_host__';
      host.style.cssText = 'position:fixed;z-index:2147483647;left:0;top:0;width:0;height:0;';
      const root = host.attachShadow({ mode: 'closed' });

      const overlay = el('div', [
        'position:fixed', 'inset:0', 'background:rgba(15,18,24,.32)',
        'display:flex', 'align-items:center', 'justify-content:center', 'padding:20px',
        'font:14px/1.55 system-ui,"Segoe UI","Microsoft YaHei",sans-serif',
      ].join(';'));

      const card = el('div', [
        'box-sizing:border-box', 'width:min(520px,92vw)', 'max-height:min(560px,86vh)',
        'display:flex', 'flex-direction:column', 'background:#fff', 'color:#202124',
        'border-radius:14px', 'box-shadow:0 18px 48px rgba(0,0,0,.28)', 'overflow:hidden',
      ].join(';'));

      const head = el('div', 'display:flex;align-items:center;gap:8px;padding:14px 16px 10px;font-weight:600;font-size:15px;');
      head.appendChild(el('span', null, '二维码识别结果'));

      const close = el('button', [
        'margin-left:auto', 'border:0', 'background:transparent', 'font-size:16px',
        'line-height:1', 'color:#5f6368', 'cursor:pointer', 'padding:4px 6px', 'border-radius:6px',
      ].join(';'), '✕');
      close.type = 'button';
      close.setAttribute('aria-label', '关闭');
      head.appendChild(close);

      const body = el('div', 'padding:0 16px 4px;overflow:auto;');
      const pre = el('div', [
        'white-space:pre-wrap', 'word-break:break-all', 'user-select:text',
        'background:#f6f7f9', 'border:1px solid #e6e8eb', 'border-radius:10px', 'padding:12px',
        'font:13px/1.5 ui-monospace,Consolas,"Courier New",monospace',
        'max-height:34vh', 'overflow:auto',
      ].join(';'));

      if (mixed) {
        let cursor = 0;
        for (const link of links) {
          if (link.start > cursor) pre.appendChild(document.createTextNode(raw.slice(cursor, link.start)));
          const a = el('a', 'color:#1a73e8;text-decoration:underline;cursor:pointer;', link.url);
          a.href = link.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.title = link.url;
          a.addEventListener('click', (e) => { e.preventDefault(); openUrl(link.url); });
          pre.appendChild(a);
          cursor = link.end;
        }
        if (cursor < raw.length) pre.appendChild(document.createTextNode(raw.slice(cursor)));
      } else {
        pre.textContent = raw;
      }
      body.appendChild(pre);

      const status = el('div', 'padding:6px 16px 0;font-size:12px;color:#1a73e8;min-height:18px;');
      const foot = el('div', 'display:flex;justify-content:flex-end;gap:8px;padding:12px 16px 14px;');

      const mkBtn = (label, primary) => el('button', [
        'padding:8px 16px', 'border-radius:8px', 'font-size:13px', 'font-weight:500', 'cursor:pointer',
        `border:1px solid ${primary ? '#1a73e8' : '#dadce0'}`,
        `background:${primary ? '#1a73e8' : '#fff'}`,
        `color:${primary ? '#fff' : '#3c4043'}`,
      ].join(';'), label);

      const openTarget = pure || (mixed ? links[0].url : null);
      const copyBtn = mkBtn(mixed ? '复制全部文字' : '复制', false);
      const openBtn = openTarget ? mkBtn('打开链接', true) : null;
      const cancelBtn = mkBtn('关闭', false);

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

      function openUrl(url) {
        closePanel();
        try {
          chrome.runtime.sendMessage({ type: 'qr-open-url', url });
        } catch {
          location.href = url;
        }
      }

      close.addEventListener('click', closePanel);
      cancelBtn.addEventListener('click', closePanel);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) closePanel(); });
      window.addEventListener('keydown', onKey, true);

      copyBtn.addEventListener('click', async () => {
        const ok = await copyText(raw);
        status.style.color = ok ? '#1a73e8' : '#b3261e';
        status.textContent = ok ? '已复制到剪贴板' : '复制失败，请手动选中上方内容复制';
        if (ok) setTimeout(() => { if (status.isConnected) status.textContent = ''; }, 1800);
      });

      if (openBtn) openBtn.addEventListener('click', () => openUrl(openTarget));
    },
  };
})();
