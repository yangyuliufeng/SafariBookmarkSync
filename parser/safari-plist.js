/**
 * safari-plist.js
 * Convert a parsed Safari Bookmarks.plist object into a unified BookmarkNode tree.
 *
 * Unified node shape (per design §7):
 *   { id, type: "folder"|"url", title, url?, children? }
 *
 * Safari plist node fields:
 *   WebBookmarkType: "WebBookmarkTypeList" (folder) | "WebBookmarkTypeLeaf" (url)
 *                     "WebBookmarkTypeProxy" (e.g. History) -> skipped
 *   Title: folder title (leaf uses URIDictionary.title)
 *   URLString: leaf url
 *   URIDictionary: { title } for leaf
 *   WebBookmarkUUID: stable Safari id (used for mapping)
 *   Children: array of child nodes
 *
 * Structure (flat-into-Chrome mode):
 *   - Safari BookmarksBar children are flattened to the root
 *   - Safari BookmarksMenu children are flattened to the root
 *   - Safari ReadingList is preserved as a single folder (routed to Chrome
 *     Reading List, not to chrome.bookmarks)
 *   - History (WebBookmarkTypeProxy) is skipped
 */
(function (global) {
  'use strict';

  const TYPE_LIST = 'WebBookmarkTypeList';
  const TYPE_LEAF = 'WebBookmarkTypeLeaf';

  // Synthetic UUID for the Safari root container we sync into Chrome.
  const ROOT_UUID = '__safari_root__';

  // Synthetic UUID for the ReadingList pseudo-folder (routed to Reading List API).
  const READING_LIST_UUID = '__safari_reading_list__';

  // Safari top-level folder titles that get flattened into the root.
  const FLATTEN_ROOTS = new Set(['BookmarksBar', 'BookmarksMenu']);

  // Safari top-level folder title that gets routed to Chrome Reading List.
  const READING_LIST_TITLE = 'com.apple.ReadingList';

  // Only sync these URL schemes; skip data:, file:, chrome:, etc.
  const ALLOWED_URL = /^(https?|ftp|javascript):/i;

  /**
   * Convert a single Safari plist node into a BookmarkNode (or null to skip).
   */
  function convertNode(node) {
    if (!node || typeof node !== 'object') return null;
    const type = node.WebBookmarkType;

    if (type === TYPE_LEAF) {
      const url = node.URLString;
      // Only keep http(s)/ftp/javascript URLs; skip data:, file:, etc.
      if (!url || !ALLOWED_URL.test(url)) return null;
      const title =
        (node.URIDictionary && node.URIDictionary.title) || node.Title || url;
      return {
        id: node.WebBookmarkUUID || null,
        type: 'url',
        title: title,
        url: url,
      };
    }

    if (type === TYPE_LIST) {
      const title = node.Title || 'Untitled';
      const children = [];
      const raw = node.Children || [];
      for (const child of raw) {
        const c = convertNode(child);
        if (c) children.push(c);
      }
      return {
        id: node.WebBookmarkUUID || null,
        type: 'folder',
        title: title,
        children: children,
      };
    }

    // WebBookmarkTypeProxy (History, etc.) and unknown types are skipped.
    return null;
  }

  /**
   * Build the unified Safari bookmark tree from a parsed plist root.
   *
   * Returns a single root folder whose children are:
   *   - All children of Safari's BookmarksBar and BookmarksMenu (flattened)
   *   - One folder for ReadingList (with READING_LIST_UUID as id, marked with
   *     isReadingList: true so the sync engine routes it to chrome.readingList)
   */
  function buildSafariTree(plistRoot) {
    const rootChildren = (plistRoot && plistRoot.Children) || [];
    const out = {
      id: ROOT_UUID,
      type: 'folder',
      title: 'Safari Bookmarks',
      children: [],
    };

    for (const child of rootChildren) {
      const title = child.Title;

      if (FLATTEN_ROOTS.has(title)) {
        // Flatten: push each child of BookmarksBar/BookmarksMenu directly to
        // the root (preserving their own UUIDs so mapping works).
        const node = convertNode(child);
        if (!node) continue;
        out.children.push(...(node.children || []));
        continue;
      }

      if (title === READING_LIST_TITLE) {
        const node = convertNode(child);
        if (!node) continue;
        // Mark the ReadingList pseudo-folder so the sync engine routes it to
        // chrome.readingList instead of chrome.bookmarks.
        node.id = READING_LIST_UUID;
        node.isReadingList = true;
        node.title = 'ReadingList';
        out.children.push(node);
        continue;
      }

      // Skip History (WebBookmarkTypeProxy) and other unknowns.
    }

    return out;
  }

  /**
   * Count folders and urls in a unified tree.
   */
  function countTree(node) {
    const stats = { folders: 0, urls: 0 };
    function walk(n) {
      if (!n) return;
      if (n.type === 'folder') {
        stats.folders++;
        (n.children || []).forEach(walk);
      } else if (n.type === 'url') {
        stats.urls++;
      }
    }
    walk(node);
    return stats;
  }

  const SafariPlist = {
    ROOT_UUID,
    READING_LIST_UUID,
    buildSafariTree,
    convertNode,
    countTree,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SafariPlist;
  if (typeof globalThis !== 'undefined') globalThis.SafariPlist = SafariPlist;
})(typeof globalThis !== 'undefined' ? globalThis : this);
