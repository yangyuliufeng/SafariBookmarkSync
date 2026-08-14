/**
 * background.js
 * MV3 service worker (ES module).
 *
 * Responsibilities:
 *   - Listen for messages from the popup to run a sync.
 *   - Load the core modules (bplist-parser, safari-plist, storage, chrome).
 *   - Run the heavy sync work here (off the popup thread).
 *
 * Sync strategy: FULL REPLACE (mirror). Every sync wipes all Chrome bookmark
 * content (Bookmarks Bar + Other Bookmarks) and the Reading List, then
 * rebuilds from the Safari plist. See sync/chrome.js.
 *
 * Message protocol (popup -> background):
 *   { type: "sync", bytes: ArrayBuffer }  -> runs syncFromBytes
 *   { type: "syncTree", safariTree }      -> runs executeSync on a parsed tree
 *   { type: "status" }                    -> returns current state summary
 *   { type: "reset" }                     -> clears stored state
 *
 * Response: { ok: true, result } | { ok: false, error }
 */

// MV3 module worker: relative imports work. The IIFE modules attach to globalThis.
import './lib/bplist-parser.js';
import './parser/safari-plist.js';
import './i18n.js';
import './sync/storage.js';
import './sync/diff.js';
import './sync/chrome.js';

const BplistParser = globalThis.BplistParser;
const SafariPlist = globalThis.SafariPlist;
const I18n = globalThis.SyncI18n;
const Storage = globalThis.SyncStorage;
const ChromeSync = globalThis.ChromeSync;

// Version stamp — visible in the service worker console to confirm the
// reloaded extension is actually running the latest code.
console.log('[Safari Bookmark Sync] background loaded, BplistParser.VERSION =', BplistParser && BplistParser.VERSION);

/**
 * Run a sync from raw plist bytes.
 */
async function runSync(bytes) {
  const result = await ChromeSync.syncFromBytes(bytes, Storage, BplistParser, SafariPlist);
  return result;
}

/**
 * Return a status summary for the popup.
 */
async function getStatus() {
  const state = await Storage.getState();
  const mapping = await Storage.getMapping();
  const rootFolderId = await Storage.getRootFolderId();
  const lastHash = await Storage.getLastHash();
  return {
    initialized: !!state,
    rootFolderId,
    mappingCount: Object.keys(mapping).length,
    lastHash,
  };
}

/**
 * Reset: clear the stored sync state (hash, mapping, rootFolderId).
 *
 * Mirror mode never creates a wrapper folder, so there is nothing of ours to
 * remove — the next sync rebuilds everything anyway. As a safety measure we
 * only ever remove a stored folder if it is NOT one of Chrome's fixed root
 * folders ('0'/'1'/'2'): those can never be legitimate targets.
 */
async function reset() {
  const rootFolderId = await Storage.getRootFolderId();
  let removedTree = false;
  // Chrome's fixed roots: '0' root, '1' Bookmarks Bar, '2' Other Bookmarks,
  // '3' Mobile Bookmarks — none of them may ever be removed by a reset.
  const FIXED_ROOTS = new Set(['0', '1', '2', '3']);
  if (rootFolderId && !FIXED_ROOTS.has(String(rootFolderId))) {
    removedTree = await new Promise((resolve) => {
      try {
        chrome.bookmarks.removeTree(rootFolderId, () => {
          const err = chrome.runtime && chrome.runtime.lastError;
          // "Can't find bookmark for id" etc. means the folder is already gone —
          // treat that as a successful reset, not a failure.
          resolve(!err);
        });
      } catch (e) {
        resolve(false);
      }
    });
  }
  await Storage.clear();
  return { cleared: true, removedTree };
}

// Message listener.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === 'sync') {
        // Legacy: popup sends raw bytes, background parses. Kept for backward
        // compatibility but the popup now prefers syncTree below.
        const result = await runSync(message.bytes);
        sendResponse({ ok: true, result });
      } else if (message.type === 'syncTree') {
        // Preferred path: popup already parsed the plist into a unified tree.
        // Compute a hash of the tree for incremental skip, then execute.
        const treeJson = JSON.stringify(message.safariTree);
        const hashBytes = new TextEncoder().encode(treeJson);
        const hashBuf = await crypto.subtle.digest('SHA-256', hashBytes);
        const hash = Array.from(new Uint8Array(hashBuf))
          .map((b) => b.toString(16).padStart(2, '0')).join('');

        const lastHash = await Storage.getLastHash();
        if (lastHash && hash === lastHash) {
          sendResponse({
            ok: true,
            result: {
              skipped: true,
              counts: { create: 0, update: 0, move: 0, skip: 0, remove: 0, readingList: 0 },
              rootFolderId: await Storage.getRootFolderId(),
              durationMs: 0,
              hash,
            },
          });
          return;
        }
        const result = await ChromeSync.executeSync(message.safariTree, Storage);
        await Storage.setLastHash(hash);
        // Normalize the report (adds remove/folders/urls fields).
        result.counts = ChromeSync.collectSyncStats(message.safariTree, result.counts);
        sendResponse({ ok: true, result: Object.assign({ skipped: false, hash }, result) });
      } else if (message.type === 'status') {
        const status = await getStatus();
        sendResponse({ ok: true, result: status });
      } else if (message.type === 'reset') {
        const result = await reset();
        sendResponse({ ok: true, result });
      } else {
        sendResponse({ ok: false, error: I18n.t('unknownMessage', message.type) });
      }
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || String(err) });
    }
  })();
  // Return true to indicate we will call sendResponse asynchronously.
  return true;
});
