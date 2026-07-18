function loadGithubConfig() {
  const config = JSON.parse(localStorage.getItem('mobile-seismograph-github-config') || '{}');
  el.ghOwner.value = config.owner || 'oceanicdayi';
  el.ghRepo.value = config.repo || 'Phone_seismometer';
  el.ghBranch.value = config.branch || 'main';
  el.ghPath.value = config.path || 'data/records';
  setStatus(el.githubStatus, `${el.ghOwner.value}/${el.ghRepo.value}`, '');
}

function getGithubConfig(requireToken = true) {
  const config = {
    owner: el.ghOwner.value.trim(), repo: el.ghRepo.value.trim(), branch: el.ghBranch.value.trim() || 'main',
    path: el.ghPath.value.trim().replace(/^\/+|\/+$/g, '') || 'data/records', token: el.ghToken.value.trim() || state.githubToken,
  };
  if (!config.owner || !config.repo || (requireToken && !config.token)) throw new Error('請填寫 owner、repo 與 token。');
  if (config.token) state.githubToken = config.token;
  return config;
}

function saveGithubConfig() {
  const { owner, repo, branch, path } = getGithubConfig(false);
  localStorage.setItem('mobile-seismograph-github-config', JSON.stringify({ owner, repo, branch, path }));
  setStatus(el.githubStatus, `${owner}/${repo}`, '');
  logSync('已保存非機密設定；token 沒有保存。');
}

function logSync(message) {
  const line = `[${new Date().toLocaleTimeString('zh-TW')}] ${message}`;
  el.syncLog.textContent = `${line}\n${el.syncLog.textContent}`.slice(0, 12000);
}

async function githubFetch(url, options = {}) {
  const config = getGithubConfig(true);
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${config.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {}),
    }
  });
  if (!response.ok) {
    let detail = '';
    try { detail = (await response.json()).message || ''; } catch {}
    throw new Error(`GitHub ${response.status}: ${detail || response.statusText}`);
  }
  return response;
}

async function testGithub() {
  try {
    const config = getGithubConfig(true);
    await githubFetch(`https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}`);
    setStatus(el.githubStatus, 'GitHub 連線成功', '');
    logSync('GitHub 連線成功。');
  } catch (error) {
    setStatus(el.githubStatus, 'GitHub 連線失敗', 'bad');
    logSync(error.message);
  }
}

function utf8ToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(binary);
}

async function syncRecordToGithub(record) {
  try {
    const config = getGithubConfig(true);
    const date = (record.createdAt || new Date().toISOString()).slice(0, 10);
    const filename = `${date}-${sanitizeFilePart(record.name)}-${record.id.slice(0, 8)}.json`;
    const path = `${config.path}/${filename}`.replace(/\/+/g, '/');
    const apiUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
    let sha;
    try {
      const existing = await githubFetch(`${apiUrl}?ref=${encodeURIComponent(config.branch)}`);
      sha = (await existing.json()).sha;
    } catch (error) {
      if (!error.message.includes('404')) throw error;
    }
    const body = {
      message: `backup seismograph record: ${record.name}`,
      content: utf8ToBase64(JSON.stringify(record, null, 2)),
      branch: config.branch,
      ...(sha ? { sha } : {}),
    };
    await githubFetch(apiUrl, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    setStatus(el.githubStatus, '最近備份成功', '');
    logSync(`已備份：${path}`);
    return true;
  } catch (error) {
    setStatus(el.githubStatus, '備份失敗', 'bad');
    logSync(error.message);
    return false;
  }
}

async function restoreFromGithub() {
  try {
    const config = getGithubConfig(true);
    const dirPath = config.path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
    const listUrl = `https://api.github.com/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/contents/${dirPath}?ref=${encodeURIComponent(config.branch)}`;
    const response = await githubFetch(listUrl);
    const entries = await response.json();
    if (!Array.isArray(entries)) throw new Error('GitHub 資料路徑不是資料夾。');
    const jsonFiles = entries.filter(item => item.type === 'file' && item.name.toLowerCase().endsWith('.json'));
    if (!jsonFiles.length) { logSync('GitHub 路徑中沒有 JSON 紀錄。'); return; }
    el.restoreGithubBtn.disabled = true;
    let count = 0;
    for (const file of jsonFiles) {
      try {
        const fileResponse = await githubFetch(file.url);
        const metadata = await fileResponse.json();
        const raw = atob(String(metadata.content || '').replace(/\s/g, ''));
        const bytes = Uint8Array.from(raw, ch => ch.charCodeAt(0));
        const record = JSON.parse(new TextDecoder().decode(bytes));
        if (!record?.id || !Array.isArray(record.samples)) continue;
        record.stats = record.stats || calculateStats(record.samples);
        await putRecord(record);
        count++;
      } catch (error) {
        logSync(`略過 ${file.name}：${error.message}`);
      }
    }
    await renderHistory();
    logSync(`已從 GitHub 還原 ${count}/${jsonFiles.length} 筆紀錄。`);
    setStatus(el.githubStatus, '還原完成', '');
  } catch (error) {
    setStatus(el.githubStatus, '還原失敗', 'bad');
    logSync(error.message);
  } finally {
    el.restoreGithubBtn.disabled = false;
  }
}

async function syncAll() {
  const records = (await getAllRecords()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  if (!records.length) { logSync('目前沒有可備份的紀錄。'); return; }
  el.syncAllBtn.disabled = true;
  let success = 0;
  for (const record of records) if (await syncRecordToGithub(record)) success++;
  logSync(`批次備份完成：${success}/${records.length}。`);
  el.syncAllBtn.disabled = false;
}

function bindEvents() {
  el.enableSensorBtn.addEventListener('click', enableSensor);
  el.demoBtn.addEventListener('click', startDemo);
  el.startRecordBtn.addEventListener('click', startRecording);
  el.stopRecordBtn.addEventListener('click', () => stopRecording());
  el.addMarkerBtn.addEventListener('click', addMarker);
  el.closeReplayBtn.addEventListener('click', closeReplay);
  el.replayPlayBtn.addEventListener('click', toggleReplay);
  el.replayResetBtn.addEventListener('click', resetReplay);
  el.replaySlider.addEventListener('input', () => {
    const duration = state.replay.record?.stats?.durationMs || state.replay.record?.samples?.at(-1)?.t || 0;
    state.replay.positionMs = Number(el.replaySlider.value) / 1000 * duration;
    drawReplay();
  });
  el.importInput.addEventListener('change', async () => {
    const file = el.importInput.files?.[0];
    if (!file) return;
    try { await importJson(file); } catch (error) { alert(`匯入失敗：${error.message}`); }
    el.importInput.value = '';
  });
  el.exportAllBtn.addEventListener('click', exportAll);
  el.saveGhConfigBtn.addEventListener('click', () => { try { saveGithubConfig(); } catch (e) { logSync(e.message); } });
  el.testGithubBtn.addEventListener('click', testGithub);
  el.syncAllBtn.addEventListener('click', syncAll);
  el.restoreGithubBtn.addEventListener('click', restoreFromGithub);
  window.addEventListener('resize', () => { if (state.replay.record) drawReplay(); });
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault(); state.deferredInstallPrompt = event; el.installBtn.hidden = false;
  });
  el.installBtn.addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt(); await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null; el.installBtn.hidden = true;
  });
  window.addEventListener('beforeunload', event => {
    if (state.recording) { event.preventDefault(); event.returnValue = ''; }
  });
}

async function init() {
  if (window.isSecureContext) setStatus(el.secureStatus, 'HTTPS 安全連線', '');
  else setStatus(el.secureStatus, '非 HTTPS：感測器可能停用', 'bad');
  try {
    state.db = await openDb();
    await renderHistory();
  } catch (error) {
    alert(`無法開啟本機資料庫：${error.message}`);
  }
  loadGithubConfig();
  bindEvents();
  drawLive();
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(console.warn));
  }
}

init();
