/**
 * storage.js
 * Wrapper around chrome.storage.local for sync state.
 *
 * Stored shape (per design §8, §12):
 *   {
 *     syncVersion: 1,
 *     rootFolderId: "<Chrome id of 'Safari Bookmarks' root folder>",
 *     mapping: { "<safariUUID>": "<chromeBookmarkId>", ... },
 *     lastHash: "<sha256 hex of last synced file bytes>"
 *   }
 *
 * All chrome.storage APIs are Promise-wrapped for ergonomic async/await.
 */
(function (global) {
  'use strict';

  const STORAGE_KEY = 'safariBookmarkSyncState';

  function getArea() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) {
      throw new Error('chrome.storage.local is not available');
    }
    return chrome.storage.local;
  }

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

  async function getState() {
    const area = getArea();
    const result = await promisify((cb) => area.get(STORAGE_KEY, cb));
    return result[STORAGE_KEY] || null;
  }

  async function setState(state) {
    const area = getArea();
    await promisify((cb) => area.set({ [STORAGE_KEY]: state }, cb));
  }

  async function clear() {
    const area = getArea();
    await promisify((cb) => area.remove(STORAGE_KEY, cb));
  }

  // Initialize a default state object.
  function defaultState() {
    return {
      syncVersion: 1,
      rootFolderId: null,
      mapping: {},
      lastHash: null,
    };
  }

  // Ensure a state object exists (create default if missing) and return it.
  async function ensureState() {
    let st = await getState();
    if (!st) {
      st = defaultState();
      await setState(st);
    }
    if (!st.mapping) st.mapping = {};
    return st;
  }

  // ---- Mapping helpers ----
  async function getMapping() {
    const st = await ensureState();
    return st.mapping;
  }

  async function lookup(safariUUID) {
    const mapping = await getMapping();
    return mapping[safariUUID] || null;
  }

  async function recordMapping(safariUUID, chromeId) {
    const st = await ensureState();
    st.mapping[safariUUID] = String(chromeId);
    await setState(st);
    return st;
  }

  async function removeMapping(safariUUID) {
    const st = await ensureState();
    delete st.mapping[safariUUID];
    await setState(st);
  }

  /**
   * Batch-record multiple mapping entries in a single storage write.
   * Avoids N individual get→set round-trips during a sync of N nodes.
   * @param {Object} entries - { safariUUID: chromeId, ... }
   */
  async function batchRecordMapping(entries) {
    const st = await ensureState();
    for (const uuid of Object.keys(entries)) {
      st.mapping[uuid] = String(entries[uuid]);
    }
    await setState(st);
    return st;
  }

  /**
   * Replace the ENTIRE mapping in one write (used by mirror mode to drop
   * stale entries — Chrome ids are recreated on every full-replace sync).
   */
  async function setMapping(mapping) {
    const st = await ensureState();
    st.mapping = mapping || {};
    await setState(st);
    return st;
  }

  async function getRootFolderId() {
    const st = await ensureState();
    return st.rootFolderId;
  }

  async function setRootFolderId(id) {
    const st = await ensureState();
    st.rootFolderId = id ? String(id) : null;
    await setState(st);
    return st;
  }

  async function getLastHash() {
    const st = await ensureState();
    return st.lastHash;
  }

  async function setLastHash(hash) {
    const st = await ensureState();
    st.lastHash = hash || null;
    await setState(st);
    return st;
  }

  const Storage = {
    STORAGE_KEY,
    getState,
    setState,
    clear,
    defaultState,
    ensureState,
    getMapping,
    lookup,
    recordMapping,
    batchRecordMapping,
    setMapping,
    removeMapping,
    getRootFolderId,
    setRootFolderId,
    getLastHash,
    setLastHash,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Storage;
  if (typeof globalThis !== 'undefined') globalThis.SyncStorage = Storage;
})(typeof globalThis !== 'undefined' ? globalThis : this);
