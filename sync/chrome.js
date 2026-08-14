/**
 * chrome.js
 * Execute a Safari → Chrome bookmark sync against the chrome.bookmarks API.
 *
 * Strategy (design §10, mirror mode):
 *   FULL REPLACE — the plist is the single source of truth. Every sync:
 *     1. Wipe ALL Chrome bookmark content (Bookmarks Bar + Other Bookmarks).
 *     2. Rebuild the tree from the Safari plist, in Safari order.
 *     3. Replace Chrome's Reading List with the Safari ReadingList entries.
 *   After a sync, Chrome bookmarks + reading list are an exact mirror of the
 *   plist. No diffing, no adoption, no stale mappings — a wipe cannot leave
 *   duplicates, and bookmark order always matches Safari.
 *
 *   Safety guards:
 *     - If the Safari side has zero bookmark nodes, the sync aborts instead
 *       of wiping Chrome (protects against picking the wrong file).
 *     - If the rebuild step fails midway, the just-created partial tree is
 *       rolled back so Chrome is not left with a half-written bar.
 */
(function (global) {
  'use strict';

  // Chrome's fixed top-level folder ids ("Bookmarks Bar" / "Other Bookmarks").
  const BOOKMARKS_BAR_ID = '1';
  const OTHER_BOOKMARKS_ID = '2';

  // Localized messages via the shared i18n table (i18n.js). Falls back to
  // the raw key when the table is not loaded (e.g. bare unit-test harness),
  // so this module never hard-depends on load order.
  function t(key) {
    const args = Array.prototype.slice.call(arguments, 1);
    const I = globalThis.SyncI18n;
    return I && typeof I.t === 'function' ? I.t.apply(null, [key].concat(args)) : key;
  }

  // ---- chrome.bookmarks Promise wrappers ----

  function promisify(fn) {
    return new Promise((resolve, reject) => {
      try {
        fn((result) => {
          const err = chrome.runtime && chrome.runtime.lastError;
          if (err) reject(new Error(err.message));
          else resolve(result);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  function getChildren(id) {
    return promisify((cb) => chrome.bookmarks.getChildren(String(id), cb));
  }
  function createBookmark(props) {
    return promisify((cb) => chrome.bookmarks.create(props, cb));
  }
  function removeBookmark(id) {
    return promisify((cb) => chrome.bookmarks.remove(String(id), cb));
  }
  function removeTree(id) {
    return promisify((cb) => chrome.bookmarks.removeTree(String(id), cb));
  }
  function getTree() {
    return promisify((cb) => chrome.bookmarks.getTree(cb));
  }

  /**
   * Find the Chrome "Bookmarks Bar" folder id. The id is conventionally '1'
   * but we look it up by title to be robust across Chrome versions and
   * profiles that may have been reset.
   */
  async function findBookmarksBarId() {
    const tree = await getTree();
    const roots = (tree && tree[0] && tree[0].children) || [];
    for (const node of roots) {
      // Chrome's localised title for the bookmarks bar is "Bookmarks Bar" in
      // English, "书签栏" in zh-CN, etc. The stable id is '1' but we don't
      // rely on it; match by the well-known id first, fall back to title.
      if (node.id === BOOKMARKS_BAR_ID) return node.id;
    }
    // Fall back: match common localised titles.
    for (const node of roots) {
      if (node.url) continue;
      const title = (node.title || '').toLowerCase();
      if (title.includes('bookmark') && title.includes('bar')) return node.id;
      if (title === '书签栏' || title === '书签工具栏') return node.id;
    }
    // Last resort: take the first non-url root.
    for (const node of roots) {
      if (!node.url) return node.id;
    }
    throw new Error('Could not locate the Chrome Bookmarks Bar folder');
  }

  /**
   * Find the Chrome "Other Bookmarks" folder id. Conventionally '2'.
   */
  async function findOtherBookmarksId() {
    const tree = await getTree();
    const roots = (tree && tree[0] && tree[0].children) || [];
    for (const node of roots) {
      if (node.id === OTHER_BOOKMARKS_ID) return node.id;
    }
    // Fall back: match common localised titles.
    for (const node of roots) {
      if (node.url) continue;
      const title = (node.title || '').toLowerCase();
      if (title.includes('other') && title.includes('bookmark')) return node.id;
      if (title === '其他书签') return node.id;
    }
    throw new Error('Could not locate the Chrome Other Bookmarks folder');
  }

  // Backwards-compatible alias: older code looked for a "Safari Bookmarks"
  // wrapper folder on the bar. Mirror mode never creates one.
  async function findRootFolder(bookmarksBarId) {
    const children = await getChildren(bookmarksBarId);
    return children.find((c) => !c.url && c.title === 'Safari Bookmarks') || null;
  }

  // ---- Sync serialization ----
  // Two executeSync runs must NEVER overlap: run A's wipe would delete the
  // folders run B just created, so B's next chrome.bookmarks.create fails
  // with "Can't find parent bookmark for id" (and A's rollback then wipes
  // B's partial tree too). Serialize all syncs through a module-level
  // promise chain so any caller (popup double-click, overlapping messages)
  // is safe.
  let syncChain = Promise.resolve();

  /**
   * Execute the full sync — FULL REPLACE (mirror) mode.
   *
   * The plist is the single source of truth. Chrome's entire bookmark content
   * (Bookmarks Bar + Other Bookmarks) is wiped, rebuilt from the Safari tree
   * in Safari order, and the Reading List is fully replaced.
   *
   * Safety: if the Safari side has zero bookmark nodes we abort BEFORE wiping
   * anything (protects against picking the wrong file or a parse failure).
   *
   * Concurrent calls are queued and executed one at a time (see syncChain).
   *
   * @param {object} safariRoot  - unified Safari root node (type: folder)
   * @param {object} Storage     - sync/storage.js module
   * @returns {Promise<{counts, rootFolderId, durationMs}>}
   */
  function executeSync(safariRoot, Storage) {
    const run = syncChain.then(() => executeSyncLocked(safariRoot, Storage));
    // Keep the chain alive even when a run rejects.
    syncChain = run.then(() => {}, () => {});
    return run;
  }

  async function executeSyncLocked(safariRoot, Storage) {
    const t0 = performance.now();
    const counts = { create: 0, update: 0, move: 0, skip: 0, readingList: 0 };

    // 1. Split the Safari root's children into bookmarks vs. reading list.
    //    ReadingList is routed to chrome.readingList, not chrome.bookmarks.
    const bookmarkChildren = [];
    let readingListNode = null;
    for (const child of safariRoot.children || []) {
      if (child.isReadingList) {
        readingListNode = child;
      } else {
        bookmarkChildren.push(child);
      }
    }

    // 2. Safety guard: never wipe Chrome when the Safari side is empty.
    //    An empty plist almost always means the wrong file or a parse issue.
    if (bookmarkChildren.length === 0) {
      throw new Error(t('emptySafariTree'));
    }

    // 3. Locate the fixed top-level folders (robust against non-'1'/'2' ids).
    const bookmarksBarId = await findBookmarksBarId();
    const otherBookmarksId = await findOtherBookmarksId();
    // Paranoia: if both lookups resolved to the SAME folder (e.g. a localised
    // title fallback misfired), wiping+creating would target one folder twice.
    if (String(bookmarksBarId) === String(otherBookmarksId)) {
      throw new Error(t('sameFolder', bookmarksBarId));
    }

    // 4. Wipe ALL Chrome bookmark content (bar + other). Everything is
    //    rebuilt from the plist below, so nothing user-side survives — that
    //    is exactly what "full replace" means.
    counts.remove = await clearFolderChildren(bookmarksBarId);
    counts.remove += await clearFolderChildren(otherBookmarksId);

    // 5. Rebuild the Safari tree on the Bookmarks Bar, in Safari order.
    //    If anything fails midway, roll back the partial rebuild so Chrome
    //    is left empty-but-clean instead of half-written.
    try {
      await createTree(bookmarkChildren, bookmarksBarId, counts);
    } catch (e) {
      console.error('[Safari Bookmark Sync] rebuild failed, rolling back partial tree:', e);
      try { await clearFolderChildren(bookmarksBarId); } catch (e2) { /* best effort */ }
      throw e;
    }

    // 6. Fully replace Chrome's Reading List with the Safari ReadingList.
    //    An absent/empty ReadingList clears the Chrome side too.
    counts.readingList = await syncReadingList(readingListNode);

    // 7. Mirror mode leaves no meaningful per-node mapping (Chrome ids are
    //    recreated every sync). Clear stale state so the popup status and any
    //    future incremental logic never see phantom ids.
    if (Storage && typeof Storage.setMapping === 'function') {
      await Storage.setMapping({});
    }

    const durationMs = Math.round(performance.now() - t0);
    return { counts, rootFolderId: bookmarksBarId, durationMs };
  }

  /**
   * Remove every child of a Chrome bookmark folder (bar / other) and return
   * the number of direct children removed. The folders' own ids are fixed
   * by Chrome and must never be removed themselves.
   */
  async function clearFolderChildren(folderId) {
    let children = [];
    try {
      children = await getChildren(folderId);
    } catch (e) {
      console.warn('[Safari Bookmark Sync] getChildren failed for', folderId, e);
      return 0;
    }
    for (const child of children) {
      try {
        if (child.url) {
          await removeBookmark(child.id);
        } else {
          await removeTree(child.id);
        }
      } catch (e) {
        console.warn('[Safari Bookmark Sync] failed to remove', child.id, child.title, e);
      }
    }
    return children.length;
  }

  /**
   * Fully replace Chrome's Reading List with the Safari ReadingList entries:
   * remove every existing Chrome entry, then re-add from the plist in order.
   * chrome.readingList is keyed by URL. `hasBeenRead` resets to unread, since
   * Safari's plist carries no per-entry read state we can rely on.
   *
   * Returns the number of Safari entries written.
   */
  async function syncReadingList(readingListNode) {
    if (typeof chrome === 'undefined' || !chrome.readingList) {
      console.warn('[Safari Bookmark Sync] chrome.readingList not available, skipping ReadingList sync');
      return 0;
    }
    // 1. Clear the Chrome side completely.
    let existing = [];
    try {
      existing = await chrome.readingList.query({});
    } catch (e) {
      console.warn('[Safari Bookmark Sync] readingList.query failed:', e);
    }
    for (const item of existing || []) {
      try {
        await chrome.readingList.removeEntry({ url: item.url });
      } catch (e) {
        console.warn('[Safari Bookmark Sync] readingList.removeEntry failed for', item.url, e);
      }
    }
    // 2. Re-add from Safari, preserving order.
    let added = 0;
    const entries = readingListNode ? (readingListNode.children || []) : [];
    for (const entry of entries) {
      if (entry.type !== 'url' || !entry.url) continue;
      try {
        await chrome.readingList.addEntry({
          title: entry.title,
          url: entry.url,
          hasBeenRead: false,
        });
        added++;
      } catch (e) {
        console.warn('[Safari Bookmark Sync] readingList.addEntry failed for', entry.url, e);
      }
    }
    return added;
  }

  /**
   * Recursively create Safari nodes under a Chrome parent, preserving order.
   * Chrome appends each created node at the end of the parent, so iterating
   * the Safari children in order yields exactly the Safari ordering.
   *
   * Per-node failures are TOLERATED: a single problematic bookmark (e.g. a
   * javascript: bookmarklet or an overlong URL that Chrome's API rejects)
   * must not abort the whole sync — it is counted as skipped and logged,
   * and for folders the whole subtree is skipped. Structural failures
   * (invalid parent folder) are prevented by the sync lock + root checks.
   */
  async function createTree(children, parentId, counts) {
    for (const child of children || []) {
      if (child.type === 'url') {
        try {
          await createBookmark({ parentId, title: child.title, url: child.url });
          counts.create++;
        } catch (e) {
          counts.skip++;
          console.warn('[Safari Bookmark Sync] skipped bookmark:', child.title, child.url, e);
        }
      } else if (child.type === 'folder') {
        let node;
        try {
          node = await createBookmark({ parentId, title: child.title });
          counts.create++;
        } catch (e) {
          counts.skip += 1 + countSubtree(child);
          console.warn('[Safari Bookmark Sync] skipped folder subtree:', child.title, e);
          continue;
        }
        await createTree(child.children || [], node.id, counts);
      }
    }
  }

  // Count all nodes in a Safari subtree (inclusive) — used to report how
  // many nodes were skipped when a folder could not be created.
  function countSubtree(node) {
    let n = 0;
    for (const c of (node && node.children) || []) {
      n += 1 + (c.type === 'folder' ? countSubtree(c) : 0);
    }
    return n;
  }

  /**
   * Summarize what a successful mirror sync produced, so the report reflects
   * reality: every Safari bookmark node was created; update/move/skip are
   * always 0 in wipe+rebuild mode.
   */
  function collectSyncStats(safariRoot, counts) {
    let folders = 0, urls = 0;
    (function walk(n) {
      for (const c of (n && n.children) || []) {
        if (c.isReadingList) continue;
        if (c.type === 'url') urls++;
        else if (c.type === 'folder') { folders++; walk(c); }
      }
    })(safariRoot);
    return {
      create: counts.create,
      update: 0,
      move: 0,
      skip: counts.skip || 0,
      remove: counts.remove || 0,
      readingList: counts.readingList || 0,
      folders: folders,
      urls: urls,
    };
  }

  /**
   * High-level entry point: parse plist bytes, check file hash for incremental
   * skip, build the unified tree, and execute the sync.
   *
   * Params:
   *   bytes   : Uint8Array / ArrayBuffer of the Safari Bookmarks.plist
   *   Storage : sync/storage.js module
   *   BplistParser : lib/bplist-parser.js module (parse)
   *   SafariPlist  : parser/safari-plist.js module (buildSafariTree)
   *
   * Returns: {
   *   skipped: boolean,        // true if file hash unchanged (incremental skip)
   *   counts: {create,update,move,skip,remove,readingList,folders,urls},
   *   rootFolderId, durationMs, hash
   * }
   */
  async function syncFromBytes(bytes, Storage, BplistParser, SafariPlist) {
    const t0 = performance.now();
    // Compute SHA-256 of the file bytes for incremental detection (design §12).
    const hash = await sha256Hex(bytes);
    const lastHash = await Storage.getLastHash();
    if (lastHash && hash === lastHash) {
      return {
        skipped: true,
        counts: { create: 0, update: 0, move: 0, skip: 0, remove: 0, readingList: 0 },
        rootFolderId: await Storage.getRootFolderId(),
        durationMs: Math.round(performance.now() - t0),
        hash,
      };
    }

    const plistRoot = BplistParser.parse(bytes);
    const safariTree = SafariPlist.buildSafariTree(plistRoot);
    const result = await executeSync(safariTree, Storage);
    await Storage.setLastHash(hash);
    // Normalize the report so the popup/tests see the full mirror-mode shape.
    result.counts = collectSyncStats(safariTree, result.counts);
    return Object.assign({ skipped: false, hash }, result);
  }

  // Compute SHA-256 hex of bytes using SubtleCrypto (available in SW + popup).
  async function sha256Hex(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const hashBuf = await crypto.subtle.digest('SHA-256', data);
    const arr = new Uint8Array(hashBuf);
    let hex = '';
    for (const b of arr) hex += b.toString(16).padStart(2, '0');
    return hex;
  }

  const ChromeSync = {
    findBookmarksBarId,
    findOtherBookmarksId,
    findRootFolder,
    executeSync,
    createTree,
    clearFolderChildren,
    syncReadingList,
    collectSyncStats,
    syncFromBytes,
    sha256Hex,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = ChromeSync;
  if (typeof globalThis !== 'undefined') globalThis.ChromeSync = ChromeSync;
})(typeof globalThis !== 'undefined' ? globalThis : this);
