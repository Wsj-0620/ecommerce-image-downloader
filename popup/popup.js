/**
 * 电商图片下载助手 - 弹出窗口脚本（popup.js）
 *
 * 职责：
 *   1. 向内容脚本请求提取当前页面的商品图片；
 *   2. 在弹窗中渲染图片网格，支持勾选/全选；
 *   3. 触发单张下载或批量打包下载（转发给后台脚本）。
 */
(function () {
  'use strict';

  var images = [];   // 提取到的图片 [{url, width, height}]
  var pageTitle = ''; // 页面标题，用于命名 zip

  var grid = document.getElementById('grid');
  var empty = document.getElementById('empty');
  var selectAllEl = document.getElementById('selectAll');
  var statsEl = document.getElementById('stats');
  var siteInfoEl = document.getElementById('siteInfo');
  var btnZip = document.getElementById('btnZip');

  var SITE_NAMES = { taobao: '淘宝/天猫', jd: '京东', pdd: '拼多多', unknown: '其他站点' };

  /** 向指定标签页发送消息（Promise 封装） */
  function sendToTab(tabId, msg) {
    return new Promise(function (resolve, reject) {
      chrome.tabs.sendMessage(tabId, msg, function (res) {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(res);
        }
      });
    });
  }

  /** 请求提取图片；若内容脚本尚未注入（插件后安装等场景），手动注入后再重试 */
  async function requestExtract() {
    var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    var tab = tabs[0];
    if (!tab || !tab.id) {
      showEmpty('无法获取当前标签页');
      return;
    }

    var result = null;
    try {
      result = await sendToTab(tab.id, { type: 'EXTRACT_IMAGES' });
    } catch (e) {
      // 内容脚本未注入：手动注入 JS + CSS 后重试
      try {
        await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['content/content.css'] });
        await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/content.js'] });
        result = await sendToTab(tab.id, { type: 'EXTRACT_IMAGES' });
      } catch (e2) {
        showEmpty('当前页面不支持或无法注入脚本');
        return;
      }
    }

    if (result && result.images) {
      images = result.images;
      pageTitle = result.title || '';
      siteInfoEl.textContent = (SITE_NAMES[result.site] || '站点') + ' · ' + (result.title || '');
      render();
    } else {
      showEmpty('未检测到商品图片');
    }
  }

  /** 渲染图片网格 */
  function render() {
    grid.innerHTML = '';
    if (images.length === 0) {
      showEmpty('未检测到商品图片');
      return;
    }
    empty.style.display = 'none';
    grid.style.display = 'grid';

    images.forEach(function (img, idx) {
      var card = document.createElement('div');
      card.className = 'card';
      card.innerHTML =
        '<div class="thumb-wrap">' +
          '<img class="thumb" src="' + escapeAttr(img.url) + '" loading="lazy" alt="' + (idx + 1) + '">' +
          '<div class="mask"><button class="dl" data-idx="' + idx + '" title="下载这张">下载</button></div>' +
        '</div>' +
        '<label class="check">' +
          '<input type="checkbox" class="chk" data-idx="' + idx + '">' +
          '<span>' + (idx + 1) + '</span>' +
        '</label>';
      grid.appendChild(card);
    });

    // 单张下载按钮
    grid.querySelectorAll('.dl').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        downloadSingle(images[Number(btn.dataset.idx)].url);
      });
    });

    // 复选框变化 → 更新统计
    grid.querySelectorAll('.chk').forEach(function (chk) {
      chk.addEventListener('change', updateStats);
    });

    updateStats();
  }

  /** 转义 HTML 属性中的特殊字符，防止 URL 破坏结构 */
  function escapeAttr(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/"/g, '&quot;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  /** 返回当前勾选的图片 URL 列表 */
  function getSelected() {
    return Array.from(grid.querySelectorAll('.chk'))
      .filter(function (c) { return c.checked; })
      .map(function (c) { return images[Number(c.dataset.idx)].url; });
  }

  /** 更新「已选/共」统计与全选状态 */
  function updateStats() {
    var selected = getSelected().length;
    statsEl.textContent = '共 ' + images.length + ' 张 · 已选 ' + selected;
    selectAllEl.checked = images.length > 0 && selected === images.length;
  }

  /** 显示空状态 */
  function showEmpty(text) {
    grid.style.display = 'none';
    empty.style.display = 'block';
    empty.querySelector('.empty-text').innerHTML = text;
    statsEl.textContent = '共 0 张 · 已选 0';
  }

  /** 单张下载：转发给后台 */
  function downloadSingle(url) {
    chrome.runtime.sendMessage({ type: 'DOWNLOAD_SINGLE', url: url }, function (res) {
      if (chrome.runtime.lastError) {
        alert('下载失败: ' + chrome.runtime.lastError.message);
        return;
      }
      if (res && !res.ok) alert('下载失败: ' + res.error);
    });
  }

  /** 批量打包下载：收集勾选图片，转发给后台生成 zip */
  function downloadZip() {
    var urls = getSelected();
    if (urls.length === 0) {
      alert('请先勾选要下载的图片');
      return;
    }
    var zipName = sanitize(pageTitle) + '_' + timestamp();
    btnZip.disabled = true;
    btnZip.textContent = '打包中…';

    chrome.runtime.sendMessage({ type: 'DOWNLOAD_ZIP', urls: urls, zipName: zipName }, function (res) {
      btnZip.disabled = false;
      btnZip.textContent = '打包下载所选 (ZIP)';
      if (chrome.runtime.lastError) {
        alert('打包失败: ' + chrome.runtime.lastError.message);
        return;
      }
      if (!res || !res.ok) {
        alert('打包失败: ' + (res && res.error));
        return;
      }
      var msg = '已开始下载 ' + res.filename;
      if (res.failed && res.failed.length > 0) {
        msg += '\n' + res.failed.length + ' 张图片获取失败（可能被防盗链拦截）';
      }
      alert(msg);
    });
  }

  /** 清理文件名 */
  function sanitize(s) {
    return (s || '电商图片').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  }

  /** 生成时间戳字符串 yyyyMMdd_HHmmss */
  function timestamp() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      '_' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // 事件绑定
  selectAllEl.addEventListener('change', function () {
    var checked = selectAllEl.checked;
    grid.querySelectorAll('.chk').forEach(function (c) { c.checked = checked; });
    updateStats();
  });
  btnZip.addEventListener('click', downloadZip);

  // 启动：请求提取图片
  requestExtract();
})();
