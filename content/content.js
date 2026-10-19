/**
 * 电商图片下载助手 - 内容脚本（content.js）
 *
 * 运行环境：淘宝/天猫、京东、拼多多的商品详情页（由 manifest.json 声明 matches）。
 * 职责：
 *   1. 从页面 DOM 提取商品图片地址（含懒加载属性与 CSS 背景图）；
 *   2. 响应 popup 发来的 EXTRACT_IMAGES 消息；
 *   3. 页面加载完成后显示一个轻量「就绪」提示角标。
 *
 * 说明：内容脚本运行在隔离世界（isolated world），可访问页面 DOM，
 *       但不会与页面自身的 JavaScript 变量互相干扰。
 */
(function () {
  'use strict';

  /** 过滤阈值：宽或高小于该值的图片（px）会被当作图标/头像丢弃 */
  var MIN_IMAGE_SIZE = 60;

  /** 识别当前站点类型 */
  function detectSite() {
    var host = location.hostname;
    if (/taobao\.com|tmall\.com/i.test(host)) return 'taobao';
    if (/jd\.com|jd\.hk/i.test(host)) return 'jd';
    if (/pinduoduo\.com|yangkeduo\.com/i.test(host)) return 'pdd';
    return 'unknown';
  }

  /** 从 srcset 里挑选分辨率最高的一张地址 */
  function pickLargestFromSrcset(srcset) {
    if (!srcset) return null;
    var best = null;
    var bestScore = -1;
    srcset.split(',').forEach(function (item) {
      var parts = item.trim().split(/\s+/);
      var url = parts[0];
      var desc = parts[1] || '';
      var score = 0;
      // 形如 "640w" 按宽度计分，形如 "2x" 按像素密度计分
      if (/^\d+w$/.test(desc)) score = parseInt(desc, 10);
      else if (/^\d+(\.\d+)?x$/.test(desc)) score = parseFloat(desc) * 100;
      if (score > bestScore) {
        bestScore = score;
        best = url;
      }
    });
    return best;
  }

  /**
   * 标准化 URL，并过滤明显非商品图的地址（logo/图标/头像/像素统计等）。
   * @returns {string|null} 标准化后的绝对地址，不合规返回 null
   */
  function normalizeUrl(raw) {
    if (!raw) return null;
    var u = String(raw).trim();
    if (!/^https?:\/\//i.test(u) && u.indexOf('//') !== 0) return null;
    try {
      var url = new URL(u, location.href);
      var path = url.pathname.toLowerCase();
      if (/(avatar|logo|icon|badge|favicon|beacon|pixel|analytics|loading|blank|placeholder|sprite|emoji|emot)/.test(path)) {
        return null;
      }
      return url.href;
    } catch (e) {
      return null;
    }
  }

  /**
   * 提取全部商品图片。
   * @returns {Array<{url:string, width:number, height:number}>}
   */
  function extractImages() {
    var map = new Map(); // key: url -> {url, width, height}

    /** 记录一个候选地址，自动去重并保留最大的已知尺寸 */
    function record(raw, w, h) {
      var url = normalizeUrl(raw);
      if (!url) return;
      var nw = Number(w) || 0;
      var nh = Number(h) || 0;
      var prev = map.get(url);
      if (prev) {
        if (nw > prev.width) prev.width = nw;
        if (nh > prev.height) prev.height = nh;
      } else {
        map.set(url, { url: url, width: nw, height: nh });
      }
    }

    // 1) <img> 标签：懒加载属性通常保存高清/原图地址，优先读取
    document.querySelectorAll('img').forEach(function (img) {
      var w = img.naturalWidth || img.getAttribute('width');
      var h = img.naturalHeight || img.getAttribute('height');
      record(img.getAttribute('data-src'), w, h);
      record(img.getAttribute('data-original'), w, h);
      record(img.getAttribute('data-ks-lazyload'), w, h);
      record(img.getAttribute('data-lazy-src'), w, h);
      record(img.getAttribute('data-lazyload'), w, h);
      record(img.getAttribute('data-url'), w, h);
      record(img.getAttribute('data-img'), w, h);
      record(img.getAttribute('data-origin'), w, h);
      record(img.getAttribute('src'), w, h);
      record(pickLargestFromSrcset(img.getAttribute('srcset')), w, h);
    });

    // 2) CSS 背景图（部分画廊用 background-image 展示，无尺寸信息）
    document.querySelectorAll('*').forEach(function (el) {
      var bg = null;
      try {
        bg = getComputedStyle(el).backgroundImage;
      } catch (e) {
        return;
      }
      if (!bg || bg === 'none') return;
      var m = bg.match(/url\(["']?(.*?)["']?\)/);
      if (m) record(m[1], 0, 0);
    });

    // 3) 按尺寸过滤掉过小的图片（图标、头像等）
    var result = [];
    map.forEach(function (item) {
      if (item.width > 0 && item.height > 0) {
        if (item.width < MIN_IMAGE_SIZE || item.height < MIN_IMAGE_SIZE) return;
      }
      result.push(item);
    });
    return result;
  }

  /** 显示轻量「就绪」角标（几秒后自动淡出） */
  function showReadyBadge() {
    if (document.getElementById('__ed_img_badge')) return;
    var badge = document.createElement('div');
    badge.id = '__ed_img_badge';
    badge.className = 'ed-badge';
    badge.textContent = '电商图片助手已就绪，点击插件图标提取图片';
    (document.body || document.documentElement).appendChild(badge);
    setTimeout(function () {
      badge.classList.add('ed-hide');
      setTimeout(function () {
        if (badge.parentNode) badge.parentNode.removeChild(badge);
      }, 600);
    }, 5000);
  }

  // 响应 popup 的提取请求
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === 'EXTRACT_IMAGES') {
      sendResponse({
        site: detectSite(),
        title: document.title,
        url: location.href,
        images: extractImages()
      });
    }
    return false;
  });

  // 页面就绪后显示提示角标
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    showReadyBadge();
  } else {
    window.addEventListener('DOMContentLoaded', showReadyBadge);
  }
})();
