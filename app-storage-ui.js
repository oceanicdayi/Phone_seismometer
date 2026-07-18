function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function txRequest(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    const req = action(store);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const putRecord = record => txRequest('readwrite', store => store.put(record));
const getRecord = id => txRequest('readonly', store => store.get(id));
const deleteRecord = id => txRequest('readwrite', store => store.delete(id));
const getAllRecords = () => txRequest('readonly', store => store.getAll());

async function renderHistory() {
  const records = (await getAllRecords()).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  el.historyList.innerHTML = '';
  el.historyEmpty.hidden = records.length > 0;
  for (const record of records) {
    const node = el.historyItemTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.id = record.id;
    node.querySelector('h3').textContent = record.name;
    node.querySelector('.history-meta').textContent = `${new Date(record.createdAt).toLocaleString('zh-TW')} ・ ${record.source === 'demo' ? '模擬' : '手機感測器'}`;
    node.querySelector('.history-note').textContent = record.note || '無備註';
    const stats = record.stats || calculateStats(record.samples || []);
    node.querySelector('.history-stats').innerHTML = [
      `長度 ${formatDuration(stats.durationMs)}`,
      `${record.samples?.length || 0} 筆`,
      `峰值 ${stats.peak.toFixed(3)} m/s²`,
      `RMS ${stats.rms.toFixed(3)} m/s²`,
      `${stats.sampleRate.toFixed(1)} Hz`,
    ].map(text => `<span>${text}</span>`).join('');
    node.querySelector('.history-actions').addEventListener('click', async event => {
      const action = event.target.dataset.action;
      if (!action) return;
      if (action === 'replay') openReplay(record);
      if (action === 'json') downloadJson(record, `${sanitizeFilePart(record.name)}.json`);
      if (action === 'csv') downloadCsv(record);
      if (action === 'github') await syncRecordToGithub(record);
      if (action === 'delete' && confirm(`確定刪除「${record.name}」？`)) {
        await deleteRecord(record.id); await renderHistory();
      }
    });
    el.historyList.appendChild(node);
  }
}

function downloadBlob(content, type, filename) {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJson(data, filename) {
  downloadBlob(JSON.stringify(data, null, 2), 'application/json', filename);
}

function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function downloadCsv(record) {
  const header = ['time_ms','accel_x_mps2','accel_y_mps2','accel_z_mps2','magnitude_mps2','raw_x_mps2','raw_y_mps2','raw_z_mps2'];
  const rows = record.samples.map(s => [s.t,s.x,s.y,s.z,s.m,s.rawX,s.rawY,s.rawZ].map(csvEscape).join(','));
  downloadBlob([header.join(','), ...rows].join('\n'), 'text/csv;charset=utf-8', `${sanitizeFilePart(record.name)}.csv`);
}

async function exportAll() {
  const records = (await getAllRecords()).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  downloadJson({ schemaVersion: 1, exportedAt: new Date().toISOString(), app: 'mobile-seismograph', records }, `mobile-seismograph-backup-${new Date().toISOString().slice(0,10)}.json`);
}

async function importJson(file) {
  const parsed = JSON.parse(await file.text());
  const records = Array.isArray(parsed) ? parsed : (parsed.records || [parsed]);
  let count = 0;
  for (const candidate of records) {
    if (!candidate?.id || !Array.isArray(candidate.samples)) continue;
    const stats = candidate.stats || calculateStats(candidate.samples);
    await putRecord({ ...candidate, stats });
    count++;
  }
  await renderHistory();
  alert(`已匯入 ${count} 筆紀錄。`);
}

function openReplay(record) {
  state.replay.record = record;
  state.replay.positionMs = 0;
  state.replay.playing = false;
  cancelAnimationFrame(state.replay.raf);
  el.replayTitle.textContent = record.name;
  el.replayPanel.hidden = false;
  el.replaySlider.value = 0;
  el.replayPlayBtn.textContent = '播放';
  el.replayPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  drawReplay();
}

function closeReplay() {
  state.replay.playing = false;
  cancelAnimationFrame(state.replay.raf);
  state.replay.record = null;
  el.replayPanel.hidden = true;
}

function resetReplay() {
  state.replay.positionMs = 0;
  state.replay.lastFrame = performance.now();
  el.replaySlider.value = 0;
  drawReplay();
}

function toggleReplay() {
  if (!state.replay.record) return;
  state.replay.playing = !state.replay.playing;
  el.replayPlayBtn.textContent = state.replay.playing ? '暫停' : '播放';
  state.replay.lastFrame = performance.now();
  if (state.replay.playing) state.replay.raf = requestAnimationFrame(replayTick);
}

function replayTick(now) {
  if (!state.replay.playing || !state.replay.record) return;
  const duration = state.replay.record.stats?.durationMs || state.replay.record.samples.at(-1)?.t || 0;
  const dt = now - state.replay.lastFrame;
  state.replay.lastFrame = now;
  state.replay.positionMs += dt * Number(el.replaySpeed.value);
  if (state.replay.positionMs >= duration) {
    state.replay.positionMs = duration;
    state.replay.playing = false;
    el.replayPlayBtn.textContent = '播放';
  }
  el.replaySlider.value = duration ? Math.round(state.replay.positionMs / duration * 1000) : 0;
  drawReplay();
  if (state.replay.playing) state.replay.raf = requestAnimationFrame(replayTick);
}

function setupCanvas(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width: rect.width, height: rect.height };
}

function drawGrid(ctx, width, height, maxAbs, seconds) {
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#050b13'; ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = 'rgba(255,255,255,.075)'; ctx.lineWidth = 1;
  const rows = 8, cols = Math.max(5, Math.round(seconds));
  for (let i = 0; i <= rows; i++) {
    const y = i * height / rows; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
  }
  for (let i = 0; i <= cols; i++) {
    const x = i * width / cols; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(255,255,255,.22)';
  ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();
  ctx.fillStyle = 'rgba(238,246,255,.52)'; ctx.font = '11px ui-monospace, monospace';
  ctx.fillText(`±${maxAbs.toFixed(2)} m/s²`, 8, 16);
}

function drawSeries(ctx, points, getX, getY, color, width = 1.5) {
  if (points.length < 2) return;
  ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
  points.forEach((point, index) => {
    const x = getX(point, index), y = getY(point, index);
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

function drawLive() {
  const { ctx, width, height } = setupCanvas(el.liveCanvas);
  const seconds = Number(el.windowSeconds.value);
  const cutoff = performance.now() - seconds * 1000;
  const points = state.live.filter(p => p.t >= cutoff);
  const maxAbs = Math.max(1, ...points.flatMap(p => [Math.abs(p.x), Math.abs(p.y), Math.abs(p.z), Math.abs(p.m)])) * 1.12;
  drawGrid(ctx, width, height, maxAbs, seconds);
  if (points.length) {
    const start = performance.now() - seconds * 1000;
    const xFn = p => (p.t - start) / (seconds * 1000) * width;
    const yFn = key => p => height / 2 - p[key] / maxAbs * (height * .43);
    drawSeries(ctx, points, xFn, yFn('x'), '#ff6b6b');
    drawSeries(ctx, points, xFn, yFn('y'), '#51cf66');
    drawSeries(ctx, points, xFn, yFn('z'), '#4dabf7');
    drawSeries(ctx, points, xFn, yFn('m'), '#ffd43b', 2);
  }
  el.recordingClock.textContent = state.recording ? formatDuration(performance.now() - state.recordStartPerf) : '00:00.0';
  requestAnimationFrame(drawLive);
}

function downsampleForWidth(samples, width) {
  if (samples.length <= width * 2) return samples;
  const bucket = samples.length / width;
  const out = [];
  for (let px = 0; px < width; px++) {
    const start = Math.floor(px * bucket), end = Math.min(samples.length, Math.floor((px + 1) * bucket));
    let min = samples[start], max = samples[start];
    for (let i = start + 1; i < end; i++) {
      if (samples[i].m < min.m) min = samples[i];
      if (samples[i].m > max.m) max = samples[i];
    }
    out.push(min, max);
  }
  return out.sort((a, b) => a.t - b.t);
}

function nearestSample(samples, t) {
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (samples[mid].t < t) lo = mid + 1; else hi = mid;
  }
  const a = samples[lo], b = samples[Math.max(0, lo - 1)];
  return !b || Math.abs(a.t - t) < Math.abs(b.t - t) ? a : b;
}

function drawReplay() {
  const record = state.replay.record;
  if (!record) return;
  const { ctx, width, height } = setupCanvas(el.replayCanvas);
  const samples = record.samples || [];
  const duration = record.stats?.durationMs || samples.at(-1)?.t || 0;
  const points = downsampleForWidth(samples, Math.max(1, Math.floor(width)));
  const maxAbs = Math.max(1, record.stats?.peak || 0, ...points.flatMap(p => [Math.abs(p.x), Math.abs(p.y), Math.abs(p.z)])) * 1.12;
  drawGrid(ctx, width, height, maxAbs, Math.max(1, duration / 1000));
  const xFn = p => duration ? p.t / duration * width : 0;
  const yFn = key => p => height / 2 - p[key] / maxAbs * (height * .43);
  drawSeries(ctx, points, xFn, yFn('x'), '#ff6b6b');
  drawSeries(ctx, points, xFn, yFn('y'), '#51cf66');
  drawSeries(ctx, points, xFn, yFn('z'), '#4dabf7');
  drawSeries(ctx, points, xFn, yFn('m'), '#ffd43b', 2);

  for (const marker of record.markers || []) {
    const x = duration ? marker.t / duration * width : 0;
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke(); ctx.setLineDash([]);
  }
  const cursorX = duration ? state.replay.positionMs / duration * width : 0;
  ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cursorX, 0); ctx.lineTo(cursorX, height); ctx.stroke();
  const current = nearestSample(samples, state.replay.positionMs) || { x:0,y:0,z:0,m:0,t:0 };
  el.replayTime.textContent = `${formatDuration(state.replay.positionMs)} / ${formatDuration(duration)}`;
  el.replayMetrics.innerHTML = `<span>X ${current.x.toFixed(3)}</span><span>Y ${current.y.toFixed(3)}</span><span>Z ${current.z.toFixed(3)}</span><span>|A| ${current.m.toFixed(3)} m/s²</span>`;
}

