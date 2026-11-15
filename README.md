# local-QR · 本地二维码识别

一款 Chrome / Edge 扩展：在网页图片上右键即可识别二维码。
**全程本地运算**——二维码图像不上传、不联网，扩展也不申请常驻的网页读取权限。

识别成功后**不会自动跳转**，而是弹出结果面板，由你决定下一步。

| 识别到网址 | 识别到其它内容 |
|---|---|
| ![网址结果](docs/panel-url.png) | ![文本结果](docs/panel-text.png) |

---

## 功能

- 右键任意图片 → 「识别图片中的二维码」
- 识别出 `http(s)` 网址：点「打开链接」才跳转当前标签页
- 识别出其它内容（纯文本、WiFi 配置、vCard 等）：点「复制」写入剪贴板
- 同时支持正片与**反色**二维码（深底浅码）
- 小图自动放大重试；网页上显示得再小，解码也用原图分辨率
- 跨域图片（canvas 被污染）自动退化为截图裁剪解码
- 面板可用 ✕ / 点击遮罩 / `Esc` 关闭，内容可鼠标选中

## 安装

### 下载 zip（推荐）

到 [Releases](https://github.com/KanaBackyard/local-QR/releases/latest) 下载 `qr-local-1.1.0.zip`：

1. 打开 `chrome://extensions`（Edge 为 `edge://extensions`）
2. 右上角开启「开发者模式」
3. 把 zip **直接拖入**页面；或解压后点「加载已解压的扩展程序」选择解压目录
4. 工具栏出现蓝色二维码图标即安装成功

### 从源码加载

1. 下载本仓库（`Code` → `Download ZIP`，或 `git clone`）
2. 打开 `chrome://extensions`
3. 开启「开发者模式」→「加载已解压的扩展程序」
4. 选择**含 `manifest.json` 的那一层目录**

### 自行打包

```bash
zip -r qr-local-1.1.0.zip manifest.json background.js decode.js popup.html lib icons
```

> 注意：zip 内的路径分隔符必须是 `/`。用 Windows PowerShell 的 `Compress-Archive`
> 会写成 `\`，Chrome 解压时会把 `icons\icon16.png` 当成文件名而不是目录，
> 导致 `Could not load icon 'icons/icon16.png'`。

## 使用

1. 在网页图片上点右键
2. 选择「识别图片中的二维码」
3. 结果面板：

| 按钮 | 行为 |
|---|---|
| 打开链接 | 仅当内容是 `http(s)` 网址时出现；点击后跳转当前标签页 |
| 复制 | 写入剪贴板（`navigator.clipboard` → `execCommand` 两级降级） |
| 关闭 | 或点遮罩空白 / 按 `Esc` |

## 权限

只申请三个权限，没有 `host_permissions`，没有 `<all_urls>`，不读取浏览记录，不注入常驻脚本。

| 权限 | 用途 |
|---|---|
| `contextMenus` | 添加右键菜单项 |
| `activeTab` | 仅在你点菜单的那一刻授予当前标签页临时访问权 |
| `scripting` | 把解码脚本注入当前页面取像素 |
| `clipboardWrite` | 「复制」按钮写入剪贴板 |

## 工作原理

1. **页面内 canvas 直读**：同源图 / 带 CORS 头的图，直接用原图分辨率取 `ImageData`
2. **整页截图裁剪**：跨域图片会让 canvas 被污染（`getImageData` 抛 `SecurityError`），
   此时用 `captureVisibleTab` 截图，按元素 `getBoundingClientRect` 裁剪出该图区域再解码
3. 解码统一交给 [jsQR](https://github.com/cozmo/jsQR)（纯 JS，无 WASM、无网络）

### 图像预处理

jsQR 直接吃原始像素时，对彩色渐变、圆点风、模块过细或留白过多的二维码容易失败。
`decode.js` 因此改为“按代价递增、命中即止”的多级策略：

| 级别 | 处理 | 解决的情况 |
|---|---|---|
| 1 | 原始像素 | 普通清晰二维码，一步命中 |
| 2 | `min`/`lum` 通道 + 自适应阈值阶梯 | 彩色、渐变底、低对比度 |
| 3 | 小图放大 2 倍 | 图片显示尺寸太小，模块粘连 |
| 4 | **规范化**：裁留白 → 补静区 → 统一尺寸 | 二维码只占大图一角；高清图模块过细 |
| 5 | 原尺寸按墨迹包围盒裁剪 | 小码贴在大片留白中 |
| 6 | 轻微模糊后再自适应 | 圆点/菱形模块需要先糊成块 |
| 7 | `sat`/`max` 通道、Otsu 全局阈值 | 单色块底、反色二维码 |

自适应阈值用积分图实现，窗口半径按图片边长百分比取多档（×0.75 ~ ×3），
避免窗口太小把单个模块整个吃掉、或太大退化成全局阈值。

识别结果通过 Shadow DOM 渲染面板，不受目标页面 CSS 影响。

### 安全处理

「打开链接」不是 `<a href>`，而是把 URL 发给后台由后台再校验一次：

- 只放行 `http(s)://` 且不含空白的 URL
- `javascript:` / `data:` / `file:` 一律拒绝
- 在 iframe 中识别也能跳转顶层标签页

## 已知边界

- `chrome://`、扩展商店等页面禁止注入脚本，只能靠图标角标提示
- 跨域图片位于**子 iframe** 中时无法截图裁剪（坐标系不同），会提示失败
- 二维码被裁掉角（缺定位图案）或遮挡面积过大时无法识别
- 二维码模块低于约 1.5 像素/模块时无法识别，先放大图片再试
- 一张图有多个二维码时只返回第一个

## 开发

无需构建步骤，改完源码在 `chrome://extensions` 点「重新加载」即可。

```
.
├── manifest.json    扩展清单（MV3）
├── background.js    Service Worker：右键菜单、解码编排、跳转校验
├── decode.js        页面内解码器 + 结果面板（按需注入）
├── popup.html       工具栏图标弹窗
├── lib/jsQR.js      jsQR 1.4.0
├── icons/           16/32/48/128
└── docs/            README 截图
```

## 许可证

本扩展代码以 [MIT](LICENSE) 发布。
`lib/jsQR.js` 为 [jsQR](https://github.com/cozmo/jsQR) 1.4.0，同样以 MIT 授权，版权归 cozmo 及贡献者。
