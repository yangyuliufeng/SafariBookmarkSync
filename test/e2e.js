/**
 * E2E test for the Safari Bookmark Sync engine (full-replace / mirror mode).
 *
 * Simulates chrome.bookmarks + chrome.readingList + chrome.storage.local in
 * memory, loads the real bplist-parser + safari-plist + storage + chrome
 * modules, and runs syncFromBytes against the real
 * ~/Library/Safari/Bookmarks.plist.
 *
 * Run:  node test/e2e.js
 */
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

// ---- Simulated Chrome environment ----

function createChromeEnv() {
  const tree = {
    '0': { id: '0', title: '', parentId: null, children: ['1', '2'] },
    '1': { id: '1', title: 'Bookmarks Bar', parentId: '0', children: [] },
    '2': { id: '2', title: 'Other Bookmarks', parentId: '0', children: [] },
  };
  let nextId = 100;
  const readingList = new Map(); // url -> { title, url, hasBeenRead }
  // Mirrors chrome.runtime so the modules' lastError checks work like real
  // Chrome. Mock methods set lastError right before invoking their callback
  // (the promisified wrappers read it synchronously) and clear it after.
  const runtime = { lastError: null };

  const bookmarks = {
    getChildren(id, cb) {
      const node = tree[String(id)];
      if (!node) return cb([]);
      cb((node.children || []).map((cid) => {
        const c = tree[cid];
        return { id: c.id, title: c.title, url: c.url, parentId: c.parentId };
      }));
    },
    getTree(cb) {
      const build = (id) => {
        const n = tree[id];
        if (!n) return null;
        const node = { id: n.id, title: n.title, url: n.url, parentId: n.parentId };
        if (n.children) {
          node.children = n.children.map(build).filter(Boolean);
        }
        return node;
      };
      const root = build('0');
      cb(root ? [root] : []);
    },
    create(props, cb) {
      // Real Chrome rejects a create whose parentId is missing or is a
      // bookmark (not a folder) with "Can't find parent bookmark for id".
      const parent = tree[props.parentId];
      if (!parent || parent.url) {
        runtime.lastError = { message: "Can't find parent bookmark for id '" + props.parentId + "'." };
        cb();
        runtime.lastError = null;
        return;
      }
      const id = String(nextId++);
      const node = {
        id, title: props.title || '', url: props.url || undefined,
        parentId: props.parentId, children: !props.url ? [] : undefined,
      };
      tree[id] = node;
      parent.children.push(id);
      cb({ id, title: node.title, url: node.url, parentId: node.parentId });
    },
    update(id, props, cb) {
      const node = tree[String(id)];
      if (node) {
        if (props.title !== undefined) node.title = props.title;
        if (props.url !== undefined) node.url = props.url;
      }
      cb({ id, title: node ? node.title : '', url: node ? node.url : undefined });
    },
    move(id, props, cb) {
      const node = tree[String(id)];
      if (node && props.parentId !== undefined) {
        const oldParent = tree[node.parentId];
        if (oldParent) oldParent.children = oldParent.children.filter((c) => c !== id);
        node.parentId = props.parentId;
        const newParent = tree[props.parentId];
        if (newParent) newParent.children.push(id);
      }
      cb({ id, parentId: node ? node.parentId : '' });
    },
    remove(id, cb) {
      const node = tree[String(id)];
      if (node) {
        const parent = tree[node.parentId];
        if (parent) parent.children = parent.children.filter((c) => c !== String(id));
        delete tree[String(id)];
      }
      cb();
    },
    removeTree(id, cb) {
      const node = tree[String(id)];
      if (node) {
        (function del(nid) {
          const n = tree[nid];
          if (!n) return;
          if (n.children) n.children.forEach(del);
          delete tree[nid];
        })(String(id));
        const parent = tree[node.parentId];
        if (parent) parent.children = parent.children.filter((c) => c !== String(id));
      }
      cb();
    },
  };

  const readingListAPI = {
    addEntry({ title, url, hasBeenRead }) {
      // Chrome's addEntry is idempotent (no-op if URL exists).
      if (!readingList.has(url)) {
        readingList.set(url, { title, url, hasBeenRead: !!hasBeenRead });
      }
      return Promise.resolve();
    },
    query({ url }) {
      if (url) return Promise.resolve(readingList.has(url) ? [readingList.get(url)] : []);
      return Promise.resolve(Array.from(readingList.values()));
    },
    removeEntry({ url }) {
      readingList.delete(url);
      return Promise.resolve();
    },
  };

  const store = {};
  const storage = {
    local: {
      get(keys, cb) {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        const result = {};
        for (const k of keyArr) if (store[k] !== undefined) result[k] = store[k];
        cb(result);
      },
      set(obj, cb) { Object.assign(store, obj); cb(); },
      remove(keys, cb) {
        const keyArr = Array.isArray(keys) ? keys : [keys];
        for (const k of keyArr) delete store[k];
        cb();
      },
      clear(cb) { for (const k of Object.keys(store)) delete store[k]; cb(); },
    },
  };
  return { bookmarks, storage, readingList: readingListAPI, runtime, tree, _store: store, _readingList: readingList };
}

// ---- Load modules ----

const ROOT = path.resolve(__dirname, '..');
const BplistParser = require(path.join(ROOT, 'lib', 'bplist-parser.js'));
const SafariPlist = require(path.join(ROOT, 'parser', 'safari-plist.js'));
const SyncI18n = require(path.join(ROOT, 'i18n.js'));
const SyncDiff = require(path.join(ROOT, 'sync', 'diff.js'));
const SyncStorage = require(path.join(ROOT, 'sync', 'storage.js'));
const ChromeSync = require(path.join(ROOT, 'sync', 'chrome.js'));

// ---- Test harness ----

let pass = 0, fail = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) { pass++; console.log('  ✓ ' + msg); }
  else { fail++; failures.push(msg); console.log('  ✗ FAIL: ' + msg); }
}

function assertEq(actual, expected, msg) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) {
    console.log('    expected: ' + JSON.stringify(expected));
    console.log('    actual:   ' + JSON.stringify(actual));
  }
  assert(ok, msg);
}

function countNodes(node) {
  let folders = 0, urls = 0, readingList = 0;
  (function walk(n) {
    if (n.isReadingList) {
      readingList = (n.children || []).length;
      return;
    }
    if (n.type === 'url') urls++;
    else if (n.type === 'folder') {
      folders++;
      for (const c of n.children || []) walk(c);
    }
  })(node);
  // Subtract 1 for the synthetic root (not synced as a folder).
  return { folders: folders - 1, urls, readingList };
}

function countBookmarksInTree(tree, rootId) {
  let folders = 0, urls = 0;
  (function walk(id) {
    const node = tree[id];
    if (!node) return;
    if (node.url) urls++;
    else if (id !== rootId) folders++;
    (node.children || []).forEach(walk);
  })(rootId);
  return { folders, urls };
}

// Count all nodes (folders + urls) in a unified Safari subtree, inclusive.
function countSubtreeNodes(node) {
  if (!node) return 0;
  let n = 1;
  if (node.type === 'folder') {
    for (const c of node.children || []) n += countSubtreeNodes(c);
  }
  return n;
}

// ---- Main test ----

async function main() {
  // Prefer the real Safari plist; fall back to the bundled fixture when it
  // does not exist or is not readable (macOS TCC protects ~/Library/Safari —
  // the terminal needs Full Disk Access to read it). Override with PLIST_PATH.
  const realPath = process.env.PLIST_PATH ||
    path.join(os.homedir(), 'Library', 'Safari', 'Bookmarks.plist');
  const fixturePath = path.join(__dirname, 'fixtures', 'Bookmarks.plist');
  let plistPath = realPath;
  let bytes = null;
  try {
    bytes = new Uint8Array(fs.readFileSync(realPath));
  } catch (e) {
    console.log('Cannot read ' + realPath + ' (' + (e.code || e.message) + ')');
    console.log('Falling back to fixture: ' + fixturePath);
    plistPath = fixturePath;
    bytes = new Uint8Array(fs.readFileSync(fixturePath));
  }
  console.log('Using plist: ' + plistPath);
  const plistRoot = BplistParser.parse(bytes);
  const safariTree = SafariPlist.buildSafariTree(plistRoot);
  const expected = countNodes(safariTree);
  console.log('\nSafari tree: ' + expected.folders + ' folders, ' + expected.urls + ' URLs, ' + expected.readingList + ' reading list\n');

  // ===== Test 1: Fresh full-replace sync =====
  console.log('Test 1: Fresh full-replace sync');
  {
    const chrome = createChromeEnv();
    global.chrome = chrome;
    globalThis.chrome = chrome;
    const Storage = SyncStorage;
    await Storage.clear();

    const result = await ChromeSync.syncFromBytes(bytes, Storage, BplistParser, SafariPlist);
    assert(!result.skipped, 'should not skip on first sync');
    assertEq(result.counts.create, expected.folders + expected.urls,
      'create count = total bookmark nodes (' + (expected.folders + expected.urls) + ')');
    assertEq(result.counts.update, 0, 'no updates in mirror mode');
    assertEq(result.counts.move, 0, 'no moves in mirror mode');
    assertEq(result.counts.remove, 0, 'nothing to remove on a fresh Chrome');
    assertEq(result.counts.readingList, expected.readingList, 'reading list entries synced');

    // Bookmarks live directly on the Bookmarks Bar (id '1'), no wrapper.
    const barStats = countBookmarksInTree(chrome.tree, '1');
    assertEq(barStats.folders, expected.folders, 'bookmarks bar has all folders');
    assertEq(barStats.urls, expected.urls, 'bookmarks bar has all urls');
    const barChildren = chrome.tree['1'].children.map((id) => chrome.tree[id]);
    const wrapper = barChildren.find((c) => !c.url && c.title === 'Safari Bookmarks');
    assert(!wrapper, 'no Safari Bookmarks wrapper folder created');

    // Safari content is flattened into the bar; Other Bookmarks stays empty.
    const otherStats = countBookmarksInTree(chrome.tree, '2');
    assertEq(otherStats.folders + otherStats.urls, 0, 'other bookmarks is empty');

    // Reading list mirrors Safari exactly.
    assertEq(chrome._readingList.size, expected.readingList, 'reading list API has all entries');

    // Mapping is cleared in mirror mode (Chrome ids are rebuilt every sync).
    const mapping = await Storage.getMapping();
    assertEq(Object.keys(mapping).length, 0, 'mapping cleared after mirror sync');
  }

  // ===== Test 2: Idempotent re-sync (hash skip) =====
  console.log('\nTest 2: Idempotent re-sync (hash skip)');
  {
    const chrome = createChromeEnv();
    global.chrome = chrome; globalThis.chrome = chrome;
    const Storage = SyncStorage; await Storage.clear();

    await ChromeSync.syncFromBytes(bytes, Storage, BplistParser, SafariPlist);
    const result = await ChromeSync.syncFromBytes(bytes, Storage, BplistParser, SafariPlist);
    assert(result.skipped === true, 'should skip on identical hash');
    assertEq(result.counts.create, 0, '0 creates on skip');
  }

  // ===== Test 3: Full replace wipes Chrome-only content =====
  console.log('\nTest 3: Full replace wipes Chrome-only bookmarks/folders/reading list');
  {
    const chrome = createChromeEnv();
    global.chrome = chrome; globalThis.chrome = chrome;
    const Storage = SyncStorage; await Storage.clear();

    // First sync.
    await ChromeSync.syncFromBytes(bytes, Storage, BplistParser, SafariPlist);
    const safariTop = safariTree.children.filter((c) => !c.isReadingList).length;

    // Inject Chrome-only junk: a bookmark on the bar, a folder in Other
    // Bookmarks, and a reading list entry — none of them exist in Safari.
    await new Promise((r) => chrome.bookmarks.create(
      { parentId: '1', title: 'Chrome Only Bookmark', url: 'https://chrome-only.example.com' }, r));
    await new Promise((r) => chrome.bookmarks.create(
      { parentId: '2', title: 'Chrome Only Folder' }, r));
    await chrome.readingList.addEntry(
      { title: 'Chrome Only RL', url: 'https://chrome-only-rl.example.com', hasBeenRead: false });

    // Re-sync (bypass hash skip).
    await Storage.setLastHash(null);
    const r = await ChromeSync.syncFromBytes(bytes, Storage, BplistParser, SafariPlist);

    // Everything Chrome-only must be gone; counts reflect a full rebuild.
    assertEq(r.counts.create, expected.folders + expected.urls, 'full rebuild recreates all nodes');
    assertEq(r.counts.remove, safariTop + 2, 'wipe removed previous bar children + injected extras');
    const allTitles = Object.values(chrome.tree).map((n) => n.title);
    assert(!allTitles.includes('Chrome Only Bookmark'), 'Chrome-only bookmark removed from bar');
    assert(!allTitles.includes('Chrome Only Folder'), 'Chrome-only folder removed from Other Bookmarks');
    assertEq(countBookmarksInTree(chrome.tree, '2').folders, 0, 'Other Bookmarks empty again');
    assert(!chrome._readingList.has('https://chrome-only-rl.example.com'),
      'Chrome-only reading list entry removed');
    assertEq(chrome._readingList.size, expected.readingList, 'reading list mirrors Safari exactly');

    // A Safari-side deletion is mirrored on next sync: rebuild from a tree
    // whose first bookmark child was removed, and Chrome must shrink to match.
    const firstBookmarkChild = safariTree.children.find((c) => !c.isReadingList);
    const pruned = {
      id: safariTree.id, type: 'folder', title: safariTree.title,
      children: safariTree.children.filter((c) => c !== firstBookmarkChild),
    };
    await Storage.setLastHash(null);
    const r2 = await ChromeSync.executeSync(pruned, Storage);
    const expectedAfterPrune = expected.folders + expected.urls - countSubtreeNodes(firstBookmarkChild);
    assertEq(r2.counts.create, expectedAfterPrune, 'Safari-side deletion is mirrored to Chrome');
    const after = countBookmarksInTree(chrome.tree, '1');
    assertEq(after.folders + after.urls, expectedAfterPrune, 'Chrome tree size equals pruned Safari tree');
  }

  // ===== Test 4: Bookmark order matches Safari =====
  console.log('\nTest 4: Bookmark order matches Safari');
  {
    const chrome = createChromeEnv();
    global.chrome = chrome; globalThis.chrome = chrome;
    const Storage = SyncStorage; await Storage.clear();

    await ChromeSync.syncFromBytes(bytes, Storage, BplistParser, SafariPlist);

    // Top-level order on the bar must equal the Safari root order.
    const safariTopTitles = safariTree.children
      .filter((c) => !c.isReadingList)
      .map((c) => c.title);
    const chromeTopTitles = chrome.tree['1'].children.map((id) => chrome.tree[id].title);
    assertEq(chromeTopTitles, safariTopTitles, 'top-level bar order matches Safari');

    // Nested order: find the first Safari folder with >= 2 children.
    const safariFolder = safariTree.children
      .filter((c) => !c.isReadingList && c.type === 'folder')
      .find((f) => (f.children || []).length >= 2);
    if (!safariFolder) {
      console.log('  (skipped - no Safari folder with >= 2 children)');
    } else {
      const chromeFolder = chrome.tree['1'].children
        .map((id) => chrome.tree[id])
        .find((n) => !n.url && n.title === safariFolder.title);
      assert(!!chromeFolder, 'nested folder found on bar: ' + safariFolder.title);
      if (chromeFolder) {
        const safariChildTitles = safariFolder.children.map((c) => c.title);
        const chromeChildTitles = (chromeFolder.children || []).map((id) => chrome.tree[id].title);
        assertEq(chromeChildTitles, safariChildTitles, 'nested folder order matches Safari');
      }
    }
  }

  // ===== Test 5: Safety guard — empty Safari tree never wipes Chrome =====
  console.log('\nTest 5: Safety guard (empty Safari tree aborts, Chrome untouched)');
  {
    const chrome = createChromeEnv();
    global.chrome = chrome; globalThis.chrome = chrome;
    const Storage = SyncStorage; await Storage.clear();

    // Pre-existing Chrome content that must survive.
    await new Promise((r) => chrome.bookmarks.create(
      { parentId: '1', title: 'Precious Bookmark', url: 'https://precious.example.com' }, r));

    const emptyTree = { id: '__safari_root__', type: 'folder', title: 'Safari Bookmarks', children: [] };
    let threw = false;
    try {
      await ChromeSync.executeSync(emptyTree, Storage);
    } catch (e) {
      threw = true;
    }
    assert(threw, 'executeSync throws on empty Safari tree');
    assertEq(chrome.tree['1'].children.length, 1, 'existing bar content untouched');

    // A tree with ONLY reading list entries must also abort (0 bookmark nodes).
    const rlOnly = {
      id: '__safari_root__', type: 'folder', title: 'Safari Bookmarks',
      children: [{
        id: '__safari_reading_list__', type: 'folder', title: 'ReadingList', isReadingList: true,
        children: [{ id: 'u1', type: 'url', title: 'A', url: 'https://a.example.com' }],
      }],
    };
    threw = false;
    try { await ChromeSync.executeSync(rlOnly, Storage); } catch (e) { threw = true; }
    assert(threw, 'executeSync throws when only reading list entries exist');
    assertEq(chrome.tree['1'].children.length, 1, 'bar still untouched');
  }

  // ===== Test 6: SHA-256 determinism =====
  console.log('\nTest 6: SHA-256 determinism');
  {
    const h1 = await ChromeSync.sha256Hex(bytes);
    const h2 = await ChromeSync.sha256Hex(bytes);
    assert(h1 === h2, 'same input -> same hash');
    assert(h1.length === 64, 'hash is 64 hex chars');
    assert(/^[0-9a-f]{64}$/.test(h1), 'hash is valid SHA-256 hex');
  }

  // ===== Test 7: Stale mapping is dropped by mirror sync =====
  console.log('\nTest 7: Stale mapping is dropped by mirror sync');
  {
    const chrome = createChromeEnv();
    global.chrome = chrome; globalThis.chrome = chrome;
    const Storage = SyncStorage; await Storage.clear();

    // Seed stale entries as if an old incremental-mode sync had run.
    await Storage.batchRecordMapping({ 'stale-uuid-1': '9999', 'stale-uuid-2': 'readingList:x' });
    await ChromeSync.syncFromBytes(bytes, Storage, BplistParser, SafariPlist);
    const mapping = await Storage.getMapping();
    assertEq(Object.keys(mapping).length, 0,
      'mapping cleared (Chrome ids are rebuilt on every full-replace sync)');
  }

  // ===== Test 8: Concurrent syncs are serialized =====
  console.log('\nTest 8: Concurrent syncs are serialized (no "Can\'t find parent bookmark")');
  {
    const chrome = createChromeEnv();
    global.chrome = chrome; globalThis.chrome = chrome;
    const Storage = SyncStorage; await Storage.clear();

    // Fire two syncs WITHOUT awaiting the first. Previously the interleaved
    // wipe/rebuild corrupted each other: one run's wipe deleted the other's
    // freshly created folders, so its next create failed with
    // "Can't find parent bookmark for id". The module-level sync lock must
    // now serialize them.
    const [r1, r2] = await Promise.all([
      ChromeSync.executeSync(safariTree, Storage),
      ChromeSync.executeSync(safariTree, Storage),
    ]);
    assert(r1.counts.create > 0, 'first concurrent sync completed');
    assert(r2.counts.create > 0, 'second concurrent sync completed');

    // Final state must be an exact mirror of Safari (the second run wins).
    const expected = countNodes(safariTree);
    const after = countBookmarksInTree(chrome.tree, '1');
    assertEq(after.folders, expected.folders, 'bar folder count matches Safari after concurrent syncs');
    assertEq(after.urls, expected.urls, 'bar url count matches Safari after concurrent syncs');
    assertEq(chrome._readingList.size, expected.readingList, 'reading list intact after concurrent syncs');

    // A failing run must not poison the lock: the next sync still runs.
    let threw = false;
    try {
      await ChromeSync.executeSync(
        { id: 'r', type: 'folder', title: 'x', children: [] }, Storage);
    } catch (e) { threw = true; }
    assert(threw, 'empty tree still aborts (lock released after failure)');
    const r3 = await ChromeSync.executeSync(safariTree, Storage);
    assert(r3.counts.create > 0, 'sync works again after a failed run');
  }

  // ===== Summary =====
  console.log('\n========================================');
  console.log('Results: ' + pass + ' passed, ' + fail + ' failed');
  if (fail > 0) {
    console.log('Failures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('All tests passed');
}

main().catch((e) => { console.error('Fatal error:', e); process.exit(1); });
