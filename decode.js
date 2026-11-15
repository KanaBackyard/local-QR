/**
 * 本地二维码识别 —— 页面内解码器（内容脚本，按需注入）
 *
 * 提供 window.__QR__：
 *   fromImage(srcUrl)            用 canvas 直读图片像素并解码
 *   rectOf(srcUrl)               返回图片在视口内的位置（用于截屏裁剪）
 *   ensureVisible(srcUrl)        把图片滚动到视口中央，返回它的位置
 *   fromScreenshot(dataUrl, rect) 从整页截图里裁出该图区域再解码
 *   toast(message, kind)         页面内轻提示（shadow DOM 隔离）
 *   showResult(text, isUrl)      结果面板
 *
 * 解码策略（全部本地，不联网），按代价从低到高依次尝试，命中即止：
 *   1. 原始像素直接交给 jsQR（正片 + 反色都试）
 *   2. min/lum 通道 + 自适应阈值阶梯（处理彩色、渐变、低对比度）
 *   3. 小图放大 2 倍再试（像素不足时模块粘连）
 *   4. 规范化（裁留白 → 补静区 → 统一尺寸）后重试，
 *      解决“二维码只占大图一角”和“高清图里模块太细”
 *   5. 原尺寸下按墨迹包围盒裁剪
 *   6. 轻微模糊后自适应（圆点/菱形模块需先糊成块）
 *   7. sat/max 通道、Otsu 全局阈值兜底
 */
(() => {
  if (window.__QR__) return;

  const MAX_SIDE = 2000;   // 原图过大时先缩到此尺寸，避免 jsQR 卡顿
  const SMALL_SIDE = 320;  // 长边小于此值视为小图，解码时放大重试
  const UPSCALE = 2;

  function hasDecoder() {
    return typeof window.jsQR === 'function';
  }

  function runQR(rgba, w, h) {
    if (!hasDecoder() || w < 8 || h < 8) return null;
    const res = window.jsQR(rgba, w, h, { inversionAttempts: 'attemptBoth' });
    return res && res.data ? res.data : null;
  }

  // ---------------- 基础图像处理（全部在 RGBA / 灰度缓冲上做） ----------------

  function toGray(rgba, w, h, mode) {
    const out = new Uint8ClampedArray(w * h);
    for (let p = 0, i = 0; p < w * h; p++, i += 4) {
      const r = rgba[i], g = rgba[i + 1], b = rgba[i + 2];
      let v;
      if (mode === 'lum') {
        v = 0.299 * r + 0.587 * g + 0.114 * b;
      } else if (mode === 'min') {
        // 取三通道最小值：深色前景（纯色/渐变）在浅底上对比最大
        v = r < g ? (r < b ? r : b) : (g < b ? g : b);
      } else if (mode === 'max') {
        v = r > g ? (r > b ? r : b) : (g > b ? g : b);
      } else {
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
      const v = gray[p];
      out[i] = out[i + 1] = out[i + 2] = v;
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

  /** 积分图自适应阈值：每个像素与邻域均值比较，能吃掉渐变背景。 */
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

  function scaleDown(rgba, w, h, maxSide) {
    if (Math.max(w, h) <= maxSide) return { data: rgba, w, h };
    const s = maxSide / Math.max(w, h);
    const nw = Math.max(1, Math.round(w * s)), nh = Math.max(1, Math.round(h * s));
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
        out[di] = n ? r / n : 0; out[di + 1] = n ? g / n : 0; out[di + 2] = n ? b / n : 0; out[di + 3] = 255;
      }
    }
    return { data: out, w: nw, h: nh };
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

  /** 墨迹包围盒：条码类内容常被大片留白包住，裁掉能显著提高成功率。 */
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
      const srcRow = (y0 + y) * w;
      const dstRow = y * nw;
      for (let x = 0; x < nw; x++) {
        const si = (srcRow + x0 + x) * 4;
        const di = (dstRow + x) * 4;
        out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = 255;
      }
    }
    return { data: out, w: nw, h: nh };
  }

  /**
   * 自适应阈值的半径/偏移组合。半径按图边长百分比取，再乘系数。
   * 一个模块大约占图宽的 1/25~1/50，所以窗口要足够大才不会把单个模块整个吃掉。
   */
  const ADAPT_STEPS = [
    [1, 5], [1.5, 5], [0.75, 5],
    [1, 12], [1, 2], [2, 5],
    [3, 2], [1, 20],
  ];

  function resizeBox(rgba, w, h, nw, nh) {
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
        out[di] = n ? r / n : 0; out[di + 1] = n ? g / n : 0; out[di + 2] = n ? b / n : 0; out[di + 3] = 255;
      }
    }
    return out;
  }

  /**
   * 把二维码规范化为一张正方形图：
   *   1. 按墨迹包围盒裁掉背景留白
   *   2. 补回一圈静区（二维码规范要求四周留白）
   *   3. 缩放到统一边长
   *
   * 这一步专治两种情况：二维码在大图里只占一小块；截图或高清原图里模块太细。
   */
  function canonicalize(rgba, w, h, target) {
    const gray = toGray(rgba, w, h, 'min');
    const box = contentBox(gray, w, h);
    if (!box) return null;

    const pad = Math.round(Math.max(box.w, box.h) * 0.08);
    const x0 = Math.max(0, box.x - pad), y0 = Math.max(0, box.y - pad);
    const x1 = Math.min(w, box.x + box.w + pad), y1 = Math.min(h, box.y + box.h + pad);
    const cw = x1 - x0, ch = y1 - y0;
    if (cw < 16 || ch < 16) return null;

    // 用四角颜色估计背景色，补边时填同色，避免出现硬边干扰定位图案。
    const corners = [[x0, y0], [x1 - 1, y0], [x0, y1 - 1], [x1 - 1, y1 - 1]];
    let br = 0, bg = 0, bb = 0;
    for (const [sx, sy] of corners) {
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
        square[di] = rgba[si]; square[di + 1] = rgba[si + 1]; square[di + 2] = rgba[si + 2]; square[di + 3] = 255;
      }
    }
    return resizeBox(square, side, side, target, target);
  }

  /** 在给定图上跑一遍自适应阈值阶梯，命中即返回。 */
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

    // 1) 原始像素：同源清晰二维码一步命中。
    let text = runQR(rgba, w, h);
    if (text) return text;

    // 2) 彩色/渐变二维码：min 通道 + 自适应阈值阶梯，最有效的一步。
    text = tryAdaptive(rgba, w, h);
    if (text) return text;

    // 3) 小图放大：像素太少时模块粘连，放大后阈值窗口才有意义。
    if (Math.max(w, h) <= SMALL_SIDE) {
      const up = upscaleNearest(rgba, w, h, UPSCALE);
      text = runQR(up.data, up.w, up.h);
      if (text) return text;
      text = tryAdaptive(up.data, up.w, up.h);
      if (text) return text;
    }

    // 4) 规范化：裁掉留白、补静区、统一尺寸，再解一次。
    for (const target of [240, 160, 320]) {
      const c = canonicalize(rgba, w, h, target);
      if (!c) continue;
      text = runQR(c, target, target);
      if (text) return text;
      text = tryAdaptive(c, target, target);
      if (text) return text;
    }

    // 5) 原尺寸下裁到墨迹包围盒（保留原始像素，适合小码贴大背景）。
    {
      const gray = toGray(rgba, w, h, 'min');
      const box = contentBox(gray, w, h);
      if (box) {
        const pad = Math.round(Math.min(box.w, box.h) * 0.05);
        const c = cropRGBA(rgba, w, h, box, pad);
        if (c && c.w * c.h < w * h * 0.85) {
          text = runQR(c.data, c.w, c.h);
          if (text) return text;
          text = tryAdaptive(c.data, c.w, c.h);
          if (text) return text;
          for (const target of [240, 160]) {
            const c2 = canonicalize(c.data, c.w, c.h, target);
            if (!c2) continue;
            text = runQR(c2, target, target);
            if (text) return text;
            text = tryAdaptive(c2, target, target);
            if (text) return text;
          }
        }
      }
    }

    // 6) 圆点/菱形模块：先轻微模糊把点粘成块，再做自适应。
    for (const mode of ['min', 'lum']) {
      const g = boxBlur(toGray(rgba, w, h, mode), w, h, 1);
      const base = Math.max(6, Math.round(Math.min(w, h) * 0.03));
      text = runQR(grayToRGBA(adaptiveThreshold(g, w, h, base, 5), w, h), w, h);
      if (text) return text;
    }

    // 7) 其余通道 + 全局 Otsu 兜底。
    for (const mode of ['sat', 'max']) {
      const g = toGray(rgba, w, h, mode);
      const base = Math.max(6, Math.round(Math.min(w, h) * 0.03));
      text = runQR(grayToRGBA(adaptiveThreshold(g, w, h, base, 5), w, h), w, h);
      if (text) return text;
    }
    {
      const g = toGray(rgba, w, h, 'min');
      text = runQR(grayToRGBA(globalThreshold(g, w, h), w, h), w, h);
      if (text) return text;
    }

    return null;
  }

  // ---------------- 图片 / 截图入口 ----------------

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

  /**
   * 在一段文本里找出所有 http(s) 链接（只认 http/https，天生排除 javascript:、data:）。
   *
   * URL 正文里不允许出现空白、引号尖括号，也不允许出现中文和全角符号——
   * 二维码里常见的「详情见（https://...）谢谢」如果把这些字符吃进链接，
   * 点开就会带着 `）谢谢` 一起跳转。中文域名/路径按规范应做百分号编码，
   * 所以这里直接截断是安全的。
   */
  const URL_PATTERN = /https?:\/\/[^\s<>"'`\u3000-\u303F\u4E00-\u9FFF\uFF00-\uFFEF]+/gi;
  const TRAILING_PUNCT = /[.,;:!?)\]}>'"''""''、。，；：！？）】》」』…]+$/;

  function findLinks(text) {
    const links = [];
    URL_PATTERN.lastIndex = 0;
    let match;
    while ((match = URL_PATTERN.exec(text)) !== null) {
      let url = match[0];
      while (url && TRAILING_PUNCT.test(url)) url = url.slice(0, -1);
      if (!url) continue;
      links.push({ start: match.index, end: match.index + url.length, url });
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
    return { data: ctx.getImageData(0, 0, w, h), w, h };
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

      const text = decodeImageData(pack.data);
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
     * 识别结果面板：弹窗展示内容，不自动跳转。按内容分三种情况：
     *  1. 整段就是一个链接 —— 按钮：打开链接 / 复制
     *  2. 文字里夹着链接 —— 正文把链接渲染成可点的超链接；按钮：打开链接（首个）/ 复制全部文字
     *  3. 纯文字没有链接 —— 只给「复制」
     * @param {string} text 识别到的内容
     * @param {boolean} isUrl 兼容旧调用：整段是否为 http(s) 链接
     */
    showResult(text, isUrl) {
      const raw = String(text ?? '');
      const links = findLinks(raw);
      // 整段（去掉首尾空白和结尾标点后）恰好等于一个链接，才算「纯链接」。
      const trimmed = raw.trim();
      const pure = links.length === 1 && links[0].start === raw.indexOf(trimmed) &&
        links[0].end === raw.indexOf(trimmed) + trimmed.length
        ? links[0].url
        : (isUrl && /^https?:\/\/\S+$/i.test(trimmed) ? trimmed : null);
      const mixed = !pure && links.length > 0;

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

      if (mixed) {
        // 文字与链接混排：把每个链接渲染成可点超链接，其余原样保留。
        let cursor = 0;
        for (const link of links) {
          if (link.start > cursor) pre.appendChild(document.createTextNode(raw.slice(cursor, link.start)));
          const a = document.createElement('a');
          a.textContent = link.url;
          a.href = link.url;
          a.target = '_blank';
          a.rel = 'noopener noreferrer';
          a.title = link.url;
          a.style.cssText = 'color:#1a73e8;text-decoration:underline;cursor:pointer;';
          // 点击交给后台跳当前标签页，保持在同一个 tab 而不是新开一堆。
          a.addEventListener('click', (e) => {
            e.preventDefault();
            openUrl(link.url);
          });
          pre.appendChild(a);
          cursor = link.end;
        }
        if (cursor < raw.length) pre.appendChild(document.createTextNode(raw.slice(cursor)));
      } else {
        pre.textContent = raw;
      }
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

      const hasLink = Boolean(pure) || mixed;
      const openTarget = pure || (mixed ? links[0].url : null);
      const copyLabel = mixed ? '复制全部文字' : '复制';

      const copyBtn = mkBtn(copyLabel, false);
      const openBtn = hasLink ? mkBtn('打开链接', true) : null;
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

      function openUrl(url) {
        closePanel();
        try {
          // 交给后台做 tabs.update，iframe 里触发也能跳顶层
          chrome.runtime.sendMessage({ type: 'qr-open-url', url });
        } catch {
          location.href = url;
        }
      }

      close.addEventListener('click', closePanel);
      cancelBtn.addEventListener('click', closePanel);

      // 点击遮罩空白处关闭（点卡片内部不关）
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closePanel();
      });

      window.addEventListener('keydown', onKey, true);

      // 复制：混排时复制整段原文，不复制渲染后的 DOM 文本，避免丢换行
      copyBtn.addEventListener('click', async () => {
        const ok = await copyText(raw);
        status.style.color = ok ? '#1a73e8' : '#b3261e';
        status.textContent = ok ? '已复制到剪贴板' : '复制失败，请手动选中上方内容复制';
        if (ok) setTimeout(() => { if (status.isConnected) status.textContent = ''; }, 1800);
      });

      // 打开链接（用户点击才跳转）
      if (openBtn) {
        openBtn.addEventListener('click', () => openUrl(openTarget));
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
