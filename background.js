/**
 * 电商图片下载助手 - 后台 Service Worker（Manifest V3）
 *
 * 职责：
 *   1. 接收 popup 发来的下载请求（单张下载 / 批量打包）；
 *   2. 单张下载：直接调用 chrome.downloads 下载；
 *   3. 批量打包：用 JSZip 将多张图片打包成一个 zip 后统一下载。
 *
 * 说明：
 *   - MV3 不允许远程加载脚本，因此 JSZip 通过 importScripts 引入本地文件 lib/jszip.min.js；
 *   - 抓取图片二进制需要跨域能力，依赖 manifest 中声明的 host_permissions（<all_urls>）。
 */

importScripts('lib/jszip.min.js');

/**
 * 下载单张图片。
 * @param {string} url      图片地址
 * @param {string} filename 可选，保存文件名（不含扩展名）
 */
async function downloadSingle(url, filename) {
  const name = filename ? sanitizeFilename(filename) : filenameFromUrl(url);
  await chrome.downloads.download({ url, filename: name, saveAs: false });
}

/**
 * 抓取图片二进制数据。
 * 已通过 host_permissions 获得跨域能力，可绕过页面 CORS 限制。
 */
async function fetchImage(url) {
  const resp = await fetch(url, { credentials: 'include' });
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return await resp.arrayBuffer();
}

/**
 * 将 ArrayBuffer 转为 Base64 字符串。
 * 分块处理，避免一次性 apply 超大数组导致调用栈溢出。
 */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const CHUNK = 0x8000; // 32768
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** 清理文件名中的非法字符 */
function sanitizeFilename(name) {
  return (name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim() || 'image';
}

/** 从图片 URL 推导文件名（含扩展名） */
function filenameFromUrl(url) {
  const path = url.split('?')[0].split('#')[0];
  const base = path.substring(path.lastIndexOf('/') + 1);
  const extMatch = base.match(/\.(jpe?g|png|webp|gif)$/i);
  if (extMatch && extMatch[1]) {
    return sanitizeFilename(base);
  }
  return sanitizeFilename(base) + '.jpg';
}

/**
 * 批量打包下载：逐张抓取图片 → 加入 zip → 生成并下载 zip。
 * @param {string[]} urls    图片地址数组
 * @param {string}   zipName zip 文件名（不含扩展名）
 * @returns {Promise<{filename:string, failed:Array}>}
 */
async function downloadZip(urls, zipName) {
  if (typeof JSZip === 'undefined') {
    throw new Error('JSZip 未加载，请确认 lib/jszip.min.js 存在');
  }

  const zip = new JSZip();
  const failed = [];
  let successCount = 0;

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    try {
      const buffer = await fetchImage(url);
      // 依据 URL 推导扩展名，保证 zip 内文件可正常打开
      const extMatch = url.split('?')[0].match(/\.(jpe?g|png|webp|gif)$/i);
      const ext = (extMatch && extMatch[1] ? extMatch[1] : 'jpg').toLowerCase();
      const name = `${String(i + 1).padStart(3, '0')}.${ext}`;
      zip.file(name, buffer, { binary: true });
      successCount++;
    } catch (e) {
      failed.push({ url, error: e.message });
    }
  }

  if (successCount === 0) {
    throw new Error('没有成功获取任何图片，可能被站点防盗链拦截');
  }

  // 生成 zip 二进制，转为 data URL 后交给下载 API
  const blob = await zip.generateAsync({ type: 'blob' });
  const base64 = arrayBufferToBase64(await blob.arrayBuffer());
  const dataUrl = `data:application/zip;base64,${base64}`;
  const filename = `${sanitizeFilename(zipName)}.zip`;

  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });

  return { filename, failed, successCount };
}

// 监听 popup 发来的消息（异步处理，返回 true 保持通道）
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.type) return false;

  if (msg.type === 'DOWNLOAD_SINGLE') {
    downloadSingle(msg.url, msg.filename)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  if (msg.type === 'DOWNLOAD_ZIP') {
    downloadZip(msg.urls, msg.zipName)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: e.message }));
    return true;
  }

  return false;
});
