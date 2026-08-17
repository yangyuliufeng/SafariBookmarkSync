/**
 * popup.js
 * UI logic for the Safari Bookmark Sync popup.
 *
 * Uses a classic <input type="file"> picker to let the user pick
 * ~/Library/Safari/Bookmarks.plist, reads it as ArrayBuffer, and sends it to
 * the background service worker for the actual sync.
 *
 * NOTE: the File System Access API (showOpenFilePicker) is deliberately NOT
 * used — Chrome refuses anything under ~/Library with "Can't open files in
 * this folder because it contains system files", which is exactly where
 * Safari keeps its bookmarks. The legacy input opens the same native panel
 * without that blocklist.
 *
 * Localization: static markup is translated via chrome.i18n + data-i18n
 * attributes (applyStaticI18n below); runtime strings go through the shared
 * SyncI18n table (i18n.js), which follows the browser's UI language.
 */

const I18n = globalThis.SyncI18n;
const t = I18n.t;

const els = {
  syncBtn: document.getElementById('syncBtn'),
  resetBtn: document.getElementById('resetBtn'),
  statusMsg: document.getElementById('statusMsg'),
  progress: document.getElementById('progress'),
  fileName: document.getElementById('fileName'),
  mappingCount: document.getElementById('mappingCount'),
  rootFolderId: document.getElementById('rootFolderId'),
  lastHash: document.getElementById('lastHash'),
  confirmBar: document.getElementById('confirmBar'),
  confirmTitle: document.getElementById('confirmTitle'),
  confirmBody: document.getElementById('confirmBody'),
  confirmOkBtn: document.getElementById('confirmOkBtn'),
  confirmCancelBtn: document.getElementById('confirmCancelBtn'),
};

// ---- Static localization (chrome.i18n + data-i18n attributes) ----
// data-i18n="key"       -> element textContent = chrome.i18n.getMessage(key)
// data-i18n-html="key"  -> element innerHTML (only for messages that contain
//                          trusted markup such as <code>; all of them are
//                          authored by us in _locales, never user input)
function applyStaticI18n() {
  if (typeof chrome === 'undefined' || !chrome.i18n) return;
  // Keep the document language in sync with the browser UI language.
  if (typeof chrome.i18n.getUILanguage === 'function') {
    document.documentElement.lang = chrome.i18n.getUILanguage();
  }
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n'));
    if (msg) el.textContent = msg;
  });
  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const msg = chrome.i18n.getMessage(el.getAttribute('data-i18n-html'));
    if (msg) el.innerHTML = msg;
  });
}

// ---- Helpers ----
function showMsg(text, kind) {
  els.statusMsg.textContent = text;
  els.statusMsg.className = 'status-msg show ' + (kind || 'info');
}
function hideMsg() {
  els.statusMsg.className = 'status-msg';
}
function showProgress(on) {
  els.progress.className = on ? 'progress show' : 'progress';
}

// ---- Inline confirmation bar ----
// window.confirm() is deliberately NOT used anywhere in this popup: on some
// macOS builds, showing the NSSavePanel file picker while/over a native
// alert crashes the WHOLE Chrome browser process at the OS level
// (ViewBridge +[NSVB_AnimationFencingSupport
// _synchronizeDrawingAcrossProcessesOverPort:] -> EXC_BREAKPOINT). All
// destructive actions confirm through this DOM bar instead.
let confirmResolve = null;

function askConfirm(title, body) {
  hideConfirm();
  els.confirmTitle.textContent = title;
  els.confirmBody.textContent = body;
  els.confirmOkBtn.textContent = t('confirmOk');
  els.confirmCancelBtn.textContent = t('confirmCancel');
  els.confirmBar.hidden = false;
  els.confirmBar.className = 'confirm-bar show';
  return new Promise((resolve) => {
    confirmResolve = resolve;
  });
}

function hideConfirm(result) {
  els.confirmBar.className = 'confirm-bar';
  els.confirmBar.hidden = true;
  if (confirmResolve) {
    const r = confirmResolve;
    confirmResolve = null;
    r(!!result);
  }
}

els.confirmOkBtn.addEventListener('click', () => hideConfirm(true));
els.confirmCancelBtn.addEventListener('click', () => hideConfirm(false));

function send(msg) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    try {
      chrome.runtime.sendMessage(msg, (response) => {
        // When the MV3 service worker is (re)starting, Chrome may invoke the
        // callback with NO response and set runtime.lastError
        // ("The message port closed before a response was received"). That
        // must be surfaced as a normal failure — not mistaken for an empty
        // success — and never thrown as an uncaught error.
        const lastError = chrome.runtime && chrome.runtime.lastError;
        if (lastError) {
          done({ ok: false, error: t('noResponse') + ' (' + lastError.message + ')' });
          return;
        }
        done(response || { ok: false, error: t('noResponse') });
      });
    } catch (e) {
      // Extension context invalidated (e.g. extension reloaded mid-sync).
      done({ ok: false, error: (e && e.message) || String(e) });
    }
  });
}

// ---- Status refresh ----
async function refreshStatus() {
  try {
    const resp = await send({ type: 'status' });
    if (resp.ok && resp.result) {
      const s = resp.result;
      els.mappingCount.textContent = s.mappingCount || 0;
      els.rootFolderId.textContent = s.rootFolderId || '—';
      els.lastHash.textContent = s.lastHash ? s.lastHash.slice(0, 12) + '…' : '—';
    }
  } catch (e) {
    // ignore
  }
}

// ---- File picking ----
async function pickFile() {
  // Use a classic <input type="file">. Chrome's File System Access API
  // (showOpenFilePicker) blocklists ~/Library as a "system folder" and
  // refuses to open files in it — which is exactly where Safari stores
  // Bookmarks.plist. The legacy input uses the same native open panel
  // (⌘⇧G path entry works) but without that blocklist.
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.plist';

    let settled = false;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('focus', onFocusBack);
      fn(value);
    };
    const cancelError = () => {
      const err = new Error('File picker cancelled');
      err.name = 'AbortError';
      return err;
    };
    // The change event does NOT fire when the user cancels the panel, so
    // detect cancel via the popup regaining focus with no file selected.
    // Delayed so a real selection (change fires around the same time) wins.
    const onFocusBack = () => {
      setTimeout(() => {
        if (!input.files || input.files.length === 0) settle(reject, cancelError());
      }, 300);
    };

    input.onchange = () => {
      if (input.files && input.files[0]) settle(resolve, input.files[0]);
      else settle(reject, cancelError());
    };
    window.addEventListener('focus', onFocusBack);
    input.click();
  });
}

// ---- Sync flow ----
els.syncBtn.addEventListener('click', async () => {
  hideMsg();

  // Guard against re-entry — the button must be disabled for the WHOLE flow
  // (confirm + file picking + parsing + syncing), because a second
  // concurrent sync would interleave wipe/rebuild with the first and corrupt
  // it ("Can't find parent bookmark for id").
  if (els.syncBtn.disabled) return;
  els.syncBtn.disabled = true;

  try {
    // Full-replace (mirror) mode is destructive: Chrome's Bookmarks Bar,
    // Other Bookmarks and Reading List are all wiped and rebuilt from the
    // plist. Warn before anything happens — the extension is shared
    // publicly, so every user must understand what they are agreeing to.
    // NOTE: must NOT use window.confirm() here (see askConfirm comment) —
    // on some macOS builds the file picker shown after the alert crashes
    // the whole Chrome browser process.
    if (!(await askConfirm(t('confirmTitle'), t('confirmReplace')))) return;

    let file;
    try {
      // Remind the user where the file lives while the picker is open.
      showMsg(t('pickFilePrompt'), 'info');
      file = await pickFile();
    } catch (e) {
      if (e && e.name === 'AbortError') { hideMsg(); return; } // user cancelled
      showMsg(t('pickFileFailed') + (e.message || e), 'err');
      return;
    }

    let safariTree;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length === 0) {
        throw new Error(t('emptyFile'));
      }
      const head = Array.from(bytes.slice(0, 8))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join(' ');
      els.fileName.textContent = file.name + ' (' + (file.size / 1024).toFixed(1) + ' KB, head: ' + head + ')';
      console.log('[Safari Bookmark Sync] picked file:', file.name, 'size:', file.size, 'head:', head);

      // Parse the plist in the popup (where binary works reliably) and send
      // the resulting JSON tree to the background. Avoids MV3 sendMessage
      // ArrayBuffer edge cases that can deliver an empty payload.
      const plistRoot = BplistParser.parse(bytes);
      safariTree = SafariPlist.buildSafariTree(plistRoot);
      const stats = SafariPlist.countTree(safariTree);
      console.log('[Safari Bookmark Sync] parsed tree:', stats.folders, 'folders,', stats.urls, 'urls');
      showMsg(t('parseOk', stats.folders, stats.urls), 'info');
    } catch (e) {
      showMsg(t('parseFailed') + (e.message || e), 'err');
      return;
    }

    showProgress(true);

    // Send the parsed tree (plain JSON) to the background — no binary needed.
    const resp = await send({ type: 'syncTree', safariTree: safariTree });

    if (!resp.ok) {
      showMsg(t('syncFailed') + (resp.error || 'Unknown error'), 'err');
      return;
    }

    const r = resp.result;
    if (r.skipped) {
      showMsg(t('skippedUnchanged'), 'info');
    } else {
      const c = r.counts;
      const parts = [];
      if (c.remove) parts.push(t('statRemoved', c.remove));
      if (c.create) parts.push(t('statCreated', c.create));
      if (c.readingList) parts.push(t('statReadingList', c.readingList));
      if (c.update) parts.push(t('statUpdated', c.update));
      if (c.move) parts.push(t('statMoved', c.move));
      if (c.skip) parts.push(t('statSkipped', c.skip));
      const summary = parts.length ? parts.join(' · ') : t('noChanges');
      showMsg(t('replaceDone', summary, r.durationMs), 'ok');
    }
    refreshStatus();
  } catch (e) {
    showMsg(t('syncError') + (e.message || e), 'err');
  } finally {
    showProgress(false);
    els.syncBtn.disabled = false;
  }
});

// ---- Reset flow ----
els.resetBtn.addEventListener('click', async () => {
  // Inline confirm (never window.confirm — see askConfirm comment).
  if (!(await askConfirm(t('confirmTitle'), t('confirmReset')))) return;
  showProgress(true);
  els.resetBtn.disabled = true;
  try {
    const resp = await send({ type: 'reset' });
    showProgress(false);
    els.resetBtn.disabled = false;
    if (resp.ok) {
      showMsg(t('resetDone'), 'info');
      refreshStatus();
    } else {
      showMsg(t('resetFailed') + (resp.error || 'Unknown error'), 'err');
    }
  } catch (e) {
    showProgress(false);
    els.resetBtn.disabled = false;
    showMsg(t('resetError') + (e.message || e), 'err');
  }
});

// Init
applyStaticI18n();
refreshStatus();
