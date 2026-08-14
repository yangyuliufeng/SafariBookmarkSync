/**
 * popup.js
 * UI logic for the Safari Bookmark Sync popup.
 *
 * Uses a classic <input type="file"> picker to let the user pick
 * ~/Library/Safari/Bookmarks.plist, reads it as ArrayBuffer, and sends it to
 * the background service worker for the actual sync.
 *
 * NOTE: the File System Access API (showOpenFilePicker) is deliberately NOT
 * used — Chrome refuses anything under ~/Library with "无法打开此文件夹内的
 * 文件，因为此文件夹含有系统文件", which is exactly where Safari keeps its
 * bookmarks. The legacy input opens the same native panel without that
 * blocklist.
 */

const els = {
  syncBtn: document.getElementById('syncBtn'),
  resetBtn: document.getElementById('resetBtn'),
  statusMsg: document.getElementById('statusMsg'),
  progress: document.getElementById('progress'),
  fileName: document.getElementById('fileName'),
  mappingCount: document.getElementById('mappingCount'),
  rootFolderId: document.getElementById('rootFolderId'),
  lastHash: document.getElementById('lastHash'),
};

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

function send(msg) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(msg, (response) => {
      resolve(response || { ok: false, error: 'No response' });
    });
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

  // Personal-use build: no pre-sync confirmation dialog. Guard against
  // re-entry instead — the button must be disabled for the WHOLE flow
  // (file picking + parsing + syncing), because a second concurrent sync
  // would interleave wipe/rebuild with the first and corrupt it
  // ("Can't find parent bookmark for id").
  if (els.syncBtn.disabled) return;
  els.syncBtn.disabled = true;

  try {
    let file;
    try {
      // Remind the user where the file lives while the picker is open.
      showMsg('请选择 ~/Library/Safari/Bookmarks.plist（选择器中按 ⌘⇧G 粘贴路径直达）', 'info');
      file = await pickFile();
    } catch (e) {
      if (e && e.name === 'AbortError') { hideMsg(); return; } // user cancelled
      showMsg('选择文件失败：' + (e.message || e), 'err');
      return;
    }

    let safariTree;
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      if (bytes.length === 0) {
        throw new Error('File is empty (0 bytes). Did you pick the right file?');
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
      showMsg('解析成功：' + stats.folders + ' 文件夹 · ' + stats.urls + ' 书签，正在同步…', 'info');
    } catch (e) {
      showMsg('解析文件失败：' + (e.message || e), 'err');
      return;
    }

    showProgress(true);

    // Send the parsed tree (plain JSON) to the background — no binary needed.
    const resp = await send({ type: 'syncTree', safariTree: safariTree });

    if (!resp.ok) {
      showMsg('同步失败：' + (resp.error || '未知错误'), 'err');
      return;
    }

    const r = resp.result;
    if (r.skipped) {
      showMsg('文件未变化，跳过同步（增量检测）', 'info');
    } else {
      const c = r.counts;
      const parts = [];
      if (c.remove) parts.push('清除旧书签 ' + c.remove);
      if (c.create) parts.push('写入 ' + c.create);
      if (c.readingList) parts.push('阅读清单 ' + c.readingList);
      if (c.update) parts.push('更新 ' + c.update);
      if (c.move) parts.push('移动 ' + c.move);
      if (c.skip) parts.push('跳过 ' + c.skip);
      const summary = parts.length ? parts.join(' · ') : '无变更';
      showMsg('替换完成 ✓ ' + summary + '（' + r.durationMs + 'ms）', 'ok');
    }
    refreshStatus();
  } catch (e) {
    showMsg('同步出错：' + (e.message || e), 'err');
  } finally {
    showProgress(false);
    els.syncBtn.disabled = false;
  }
});

// ---- Reset flow ----
els.resetBtn.addEventListener('click', async () => {
  if (!confirm('确定要清除同步数据（哈希/映射记录）吗？\n\n注意：这不会改动 Chrome 里已同步的书签。')) return;
  showProgress(true);
  els.resetBtn.disabled = true;
  try {
    const resp = await send({ type: 'reset' });
    showProgress(false);
    els.resetBtn.disabled = false;
    if (resp.ok) {
      showMsg('已清除同步数据', 'info');
      refreshStatus();
    } else {
      showMsg('清除失败：' + (resp.error || '未知错误'), 'err');
    }
  } catch (e) {
    showProgress(false);
    els.resetBtn.disabled = false;
    showMsg('清除出错：' + (e.message || e), 'err');
  }
});

// Init
refreshStatus();
