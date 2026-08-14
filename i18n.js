/**
 * i18n.js
 * Shared runtime string table for dynamic messages (popup status messages,
 * confirm dialogs, and errors thrown by the background service worker).
 *
 * Static popup markup is localized separately via the standard Chrome
 * extension `_locales` mechanism (see popup.js applyStaticI18n). This module
 * covers everything that is built in JS at runtime, where chrome.i18n is not
 * always convenient (e.g. inside the service worker's sync engine).
 *
 * Language resolution: chrome.i18n.getUILanguage() when available, falling
 * back to navigator.language, then English. Anything starting with "zh"
 * (zh-CN, zh-TW, ...) maps to the Chinese table.
 */
(function (global) {
  'use strict';

  const MESSAGES = {
    en: {
      // ---- popup: sync flow ----
      confirmReplace:
        '⚠️ Syncing will FULLY REPLACE your Chrome bookmarks and reading list:\n\n' +
        '· Everything in Bookmarks Bar and Other Bookmarks will be wiped\n' +
        '· The Reading List will be wiped\n' +
        '· Then rebuilt from the Safari Bookmarks.plist\n\n' +
        'This cannot be undone. Continue?',
      pickFilePrompt:
        'Please pick ~/Library/Safari/Bookmarks.plist (press ⌘⇧G in the picker and paste the path)',
      pickFileFailed: 'Failed to pick a file: ',
      parseOk: (folders, urls) =>
        'Parsed: ' + folders + ' folders · ' + urls + ' bookmarks, syncing…',
      parseFailed: 'Failed to parse the file: ',
      syncFailed: 'Sync failed: ',
      syncError: 'Sync error: ',
      skippedUnchanged: 'File unchanged, sync skipped (incremental detection)',
      replaceDone: (summary, ms) => 'Replace complete ✓ ' + summary + ' (' + ms + 'ms)',
      noChanges: 'no changes',
      statRemoved: (n) => 'removed ' + n,
      statCreated: (n) => 'created ' + n,
      statReadingList: (n) => 'reading list ' + n,
      statUpdated: (n) => 'updated ' + n,
      statMoved: (n) => 'moved ' + n,
      statSkipped: (n) => 'skipped ' + n,
      emptyFile: 'File is empty (0 bytes). Did you pick the right file?',

      // ---- popup: reset flow ----
      confirmReset:
        'Clear the sync data (hash / mapping records)?\n\n' +
        'Note: this does NOT touch the bookmarks already synced into Chrome.',
      resetDone: 'Sync data cleared',
      resetFailed: 'Failed to clear: ',
      resetError: 'Clear error: ',

      // ---- background / sync engine errors ----
      emptySafariTree:
        'Safari bookmark parsing returned 0 items; sync aborted to protect ' +
        'existing Chrome bookmarks. Make sure you picked ' +
        '~/Library/Safari/Bookmarks.plist.',
      sameFolder:
        (id) =>
          'Bookmarks Bar and Other Bookmarks resolved to the same folder (id=' +
          id + '); sync aborted.',
      unknownMessage: (type) => 'Unknown message type: ' + type,
      noResponse: 'No response',
    },

    zh: {
      // ---- popup: sync flow ----
      confirmReplace:
        '⚠️ 同步将【完全替换】Chrome 的书签和阅读清单：\n\n' +
        '· 书签栏 和 其他书签 的现有内容将被全部清空\n' +
        '· 阅读清单将被清空\n' +
        '· 然后按 Safari Bookmarks.plist 完整重建\n\n' +
        '此操作不可撤销。确定继续吗？',
      pickFilePrompt: '请选择 ~/Library/Safari/Bookmarks.plist（选择器中按 ⌘⇧G 粘贴路径直达）',
      pickFileFailed: '选择文件失败：',
      parseOk: (folders, urls) =>
        '解析成功：' + folders + ' 文件夹 · ' + urls + ' 书签，正在同步…',
      parseFailed: '解析文件失败：',
      syncFailed: '同步失败：',
      syncError: '同步出错：',
      skippedUnchanged: '文件未变化，跳过同步（增量检测）',
      replaceDone: (summary, ms) => '替换完成 ✓ ' + summary + '（' + ms + 'ms）',
      noChanges: '无变更',
      statRemoved: (n) => '清除旧书签 ' + n,
      statCreated: (n) => '写入 ' + n,
      statReadingList: (n) => '阅读清单 ' + n,
      statUpdated: (n) => '更新 ' + n,
      statMoved: (n) => '移动 ' + n,
      statSkipped: (n) => '跳过 ' + n,
      emptyFile: '文件为空（0 字节）。确定选对文件了吗？',

      // ---- popup: reset flow ----
      confirmReset:
        '确定要清除同步数据（哈希/映射记录）吗？\n\n注意：这不会改动 Chrome 里已同步的书签。',
      resetDone: '已清除同步数据',
      resetFailed: '清除失败：',
      resetError: '清除出错：',

      // ---- background / sync engine errors ----
      emptySafariTree:
        'Safari 书签解析结果为 0 条，已中止同步以保护 Chrome 现有书签。' +
        '请确认选择的是 ~/Library/Safari/Bookmarks.plist。',
      sameFolder:
        (id) => '书签栏与其他书签解析到了同一个文件夹 (id=' + id + ')，已中止同步。',
      unknownMessage: (type) => '未知消息类型：' + type,
      noResponse: '无响应',
    },
  };

  /**
   * Detect the UI language: prefer chrome.i18n.getUILanguage() (follows the
   * browser's display language), fall back to navigator.language, then 'en'.
   */
  function detectLang() {
    let raw = '';
    try {
      if (typeof chrome !== 'undefined' && chrome.i18n &&
          typeof chrome.i18n.getUILanguage === 'function') {
        raw = chrome.i18n.getUILanguage() || '';
      }
    } catch (e) { /* ignore — fall through to navigator */ }
    if (!raw && typeof navigator !== 'undefined') raw = navigator.language || '';
    return String(raw).toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
  }

  const lang = detectLang();
  const table = MESSAGES[lang];

  /**
   * Look up a message by key. Function-valued entries are called with the
   * given args (for interpolated strings). Falls back to English, then to
   * the raw key, so a missing translation never crashes the flow.
   */
  function t(key) {
    const args = Array.prototype.slice.call(arguments, 1);
    let entry = table[key];
    if (entry === undefined) entry = MESSAGES.en[key];
    if (entry === undefined) return key;
    return typeof entry === 'function' ? entry.apply(null, args) : entry;
  }

  const I18n = { lang: lang, t: t, MESSAGES: MESSAGES };

  if (typeof module !== 'undefined' && module.exports) module.exports = I18n;
  if (typeof globalThis !== 'undefined') globalThis.SyncI18n = I18n;
})(typeof globalThis !== 'undefined' ? globalThis : this);
