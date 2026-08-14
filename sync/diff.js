/**
 * diff.js
 * Pure tree-diff helpers for syncing a unified Safari tree into Chrome.
 *
 * This module contains NO chrome.* calls and NO side effects, so it can be
 * unit-tested in isolation. The chrome.* execution lives in sync/chrome.js.
 *
 * Concepts:
 *   - mapping: { safariUUID -> chromeBookmarkId }
 *   - For each Safari node the executor decides an action:
 *       "create"   : no existing mapping / no matching node -> create
 *       "update"   : mapped but title/url changed -> update
 *       "move"     : mapped but parent changed -> move
 *       "skip"     : mapped and unchanged in place, or adopted -> skip
 *   - Anti-duplicate (防重复): when creating, if a sibling with the same
 *     title (and url for bookmarks) already exists, adopt it into the mapping
 *     instead of creating a duplicate.
 */
(function (global) {
  'use strict';

  function sameStr(a, b) {
    return (a || '') === (b || '');
  }

  // Build a lookup of existing Chrome children by key for anti-duplicate adoption.
  function indexExisting(existingChildren) {
    const byTitle = {};
    const byUrl = {};
    for (const node of existingChildren || []) {
      if (node.url) {
        byUrl[node.title + '\u0000' + node.url] = node;
      } else if (!byTitle[node.title]) {
        byTitle[node.title] = node;
      }
    }
    return { byTitle, byUrl };
  }

  // Find an existing Chrome child that matches a Safari node, for adoption.
  function findExistingMatch(existingIndex, safariNode) {
    if (safariNode.type === 'url') {
      return existingIndex.byUrl[safariNode.title + '\u0000' + safariNode.url] || null;
    }
    return existingIndex.byTitle[safariNode.title] || null;
  }

  const Diff = {
    sameStr,
    indexExisting,
    findExistingMatch,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Diff;
  if (typeof globalThis !== 'undefined') globalThis.SyncDiff = Diff;
})(typeof globalThis !== 'undefined' ? globalThis : this);
