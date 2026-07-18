'use strict';

const DB_NAME = 'mobile-seismograph-db';
const DB_VERSION = 1;
const STORE_NAME = 'records';
const MAX_SAMPLES_PER_RECORD = 250000;
const LIVE_BUFFER_MS = 32000;

const state = {
  db: null,
  sensorEnabled: false,
  demoMode: false,
  demoTimer: null,
  current: { t: 0, x: 0, y: 0, z: 0, m: 0, rawX: 0, rawY: 0, rawZ: 0 },
  live: [],
  samplingTimes: [],
  recording: false,
  recordStartPerf: 0,
  recordStartIso: '',
  samples: [],
  markers: [],
  peak: 0,
  gravity: { x: 0, y: 0, z: 0, initialized: false },
  replay: { record: null, playing: false, positionMs: 0, lastFrame: 0, raf: 0 },
  githubToken: '',
  deferredInstallPrompt: null,
};

const el = Object.fromEntries([
  'secureStatus','sensorStatus','enableSensorBtn','demoBtn','installBtn','sensorHelp',
  'metricX','metricY','metricZ','metricMagnitude','metricRate','metricPeak',
  'liveCanvas','canvasEmpty','windowSeconds','recordingClock','recordName','recordNote',
  'startRecordBtn','stopRecordBtn','addMarkerBtn','recordingBadge','replayPanel','replayTitle',
  'closeReplayBtn','replayCanvas','replaySlider','replayPlayBtn','replayResetBtn','replaySpeed',
  'replayTime','replayMetrics','historyEmpty','historyList','importInput','exportAllBtn',
  'historyItemTemplate','ghOwner','ghRepo','ghBranch','ghPath','ghToken','saveGhConfigBtn',
  'testGithubBtn','syncAllBtn','restoreGithubBtn','githubStatus','syncLog'
].map(id => [id, document.getElementById(id)]));

function setStatus(node, text, kind = 'muted') {
  node.textContent = text;
  node.className = `status-chip ${kind}`.trim();
}

function formatDuration(ms) {
  const total = Math.max(0, ms) / 1000;
  const minutes = Math.floor(total / 60);
  const seconds = total - minutes * 60;
  return `${String(minutes).padStart(2, '0')}:${seconds.toFixed(1).padStart(4, '0')}`;
}

function safeNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function magnitude(x, y, z) {
  return Math.sqrt(x * x + y * y + z * z);
}

function sanitizeFilePart(value) {
  return String(value || 'record')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'record';
}

function highPassFromGravity(rawX, rawY, rawZ) {
  const alpha = 0.8;
  if (!state.gravity.initialized) {
    state.gravity = { x: rawX, y: rawY, z: rawZ, initialized: true };
  }
  state.gravity.x = alpha * state.gravity.x + (1 - alpha) * rawX;
  state.gravity.y = alpha * state.gravity.y + (1 - alpha) * rawY;
  state.gravity.z = alpha * state.gravity.z + (1 - alpha) * rawZ;
  return {
    x: rawX - state.gravity.x,
    y: rawY - state.gravity.y,
    z: rawZ - state.gravity.z,
  };
}

function ingestSample(sample) {
  const now = performance.now();
  const x = safeNumber(sample.x);
  const y = safeNumber(sample.y);
  const z = safeNumber(sample.z);
  const m = magnitude(x, y, z);
  const point = {
    t: now,
    x, y, z, m,
    rawX: safeNumber(sample.rawX), rawY: safeNumber(sample.rawY), rawZ: safeNumber(sample.rawZ),
  };
  state.current = point;
  state.live.push(point);
  while (state.live.length && now - state.live[0].t > LIVE_BUFFER_MS) state.live.shift();

  state.samplingTimes.push(now);
  while (state.samplingTimes.length && now - state.samplingTimes[0] > 2000) state.samplingTimes.shift();

  if (state.recording) {
    if (state.samples.length >= MAX_SAMPLES_PER_RECORD) {
      stopRecording('已達單次錄製上限，系統自動保存。');
      return;
    }
    const relative = now - state.recordStartPerf;
    state.samples.push({
      t: Math.round(relative * 1000) / 1000,
      x, y, z, m,
      rawX: point.rawX, rawY: point.rawY, rawZ: point.rawZ,
    });
    state.peak = Math.max(state.peak, m);
  }

  el.metricX.textContent = x.toFixed(3);
  el.metricY.textContent = y.toFixed(3);
  el.metricZ.textContent = z.toFixed(3);
  el.metricMagnitude.textContent = m.toFixed(3);
  el.metricPeak.textContent = state.peak.toFixed(3);
  const hz = state.samplingTimes.length > 1
    ? (state.samplingTimes.length - 1) * 1000 / (state.samplingTimes.at(-1) - state.samplingTimes[0])
    : 0;
  el.metricRate.textContent = Number.isFinite(hz) ? hz.toFixed(1) : '0.0';
  el.canvasEmpty.hidden = true;
}

function onDeviceMotion(event) {
  const direct = event.acceleration;
  const including = event.accelerationIncludingGravity;
  let x, y, z;
  const rawX = safeNumber(including?.x);
  const rawY = safeNumber(including?.y);
  const rawZ = safeNumber(including?.z);

  if (direct && [direct.x, direct.y, direct.z].some(v => v !== null && Number.isFinite(v))) {
    x = safeNumber(direct.x); y = safeNumber(direct.y); z = safeNumber(direct.z);
  } else {
    ({ x, y, z } = highPassFromGravity(rawX, rawY, rawZ));
  }
  ingestSample({ x, y, z, rawX, rawY, rawZ });
}

async function enableSensor() {
  if (!window.isSecureContext) {
    setStatus(el.sensorStatus, '需要 HTTPS 才能使用', 'bad');
    el.sensorHelp.textContent = '請從 GitHub Pages 的 https:// 網址開啟；直接開啟本機檔案通常無法使用感測器。';
    return;
  }
  if (!('DeviceMotionEvent' in window)) {
    setStatus(el.sensorStatus, '此瀏覽器不支援動作感測器', 'bad');
    return;
  }
  try {
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      const result = await DeviceMotionEvent.requestPermission();
      if (result !== 'granted') throw new Error('使用者未授權動作感測器');
    }
    stopDemo();
    window.removeEventListener('devicemotion', onDeviceMotion);
    window.addEventListener('devicemotion', onDeviceMotion, { passive: true });
    state.sensorEnabled = true;
    setStatus(el.sensorStatus, '感測器已啟用', '');
    el.enableSensorBtn.textContent = '感測器已啟用';
    el.enableSensorBtn.disabled = true;
    el.startRecordBtn.disabled = false;
    el.sensorHelp.textContent = '將手機平放或固定後搖晃，即可觀察三軸加速度。不同手機的感測器頻率與校正狀況可能不同。';
  } catch (error) {
    setStatus(el.sensorStatus, `無法啟用：${error.message}`, 'bad');
  }
}

function startDemo() {
  if (state.demoMode) { stopDemo(); return; }
  window.removeEventListener('devicemotion', onDeviceMotion);
  state.demoMode = true;
  state.sensorEnabled = true;
  el.demoBtn.textContent = '停止模擬';
  el.startRecordBtn.disabled = false;
  setStatus(el.sensorStatus, '桌面模擬訊號', '');
  const started = performance.now();
  state.demoTimer = setInterval(() => {
    const t = (performance.now() - started) / 1000;
    const burst = (Math.sin(t * 0.55) > 0.72) ? 1.7 : 0.35;
    const x = burst * (Math.sin(2 * Math.PI * 3.2 * t) + .18 * Math.sin(2 * Math.PI * 11 * t));
    const y = burst * .7 * Math.sin(2 * Math.PI * 4.4 * t + .8);
    const z = burst * .5 * Math.sin(2 * Math.PI * 2.2 * t + 1.5);
    ingestSample({ x, y, z, rawX: x, rawY: y, rawZ: z });
  }, 20);
}

function stopDemo() {
  if (state.demoTimer) clearInterval(state.demoTimer);
  state.demoTimer = null;
  state.demoMode = false;
  el.demoBtn.textContent = '桌面模擬訊號';
}

function startRecording() {
  if (!state.sensorEnabled || state.recording) return;
  state.recording = true;
  state.recordStartPerf = performance.now();
  state.recordStartIso = new Date().toISOString();
  state.samples = [];
  state.markers = [];
  state.peak = 0;
  el.metricPeak.textContent = '0.000';
  el.startRecordBtn.disabled = true;
  el.stopRecordBtn.disabled = false;
  el.addMarkerBtn.disabled = false;
  el.recordingBadge.textContent = '錄製中';
  el.recordingBadge.classList.add('active');
}

function calculateStats(samples) {
  if (!samples.length) return { peak: 0, rms: 0, sampleRate: 0, durationMs: 0 };
  const peak = samples.reduce((v, s) => Math.max(v, s.m), 0);
  const rms = Math.sqrt(samples.reduce((sum, s) => sum + s.m * s.m, 0) / samples.length);
  const durationMs = samples.at(-1).t;
  const sampleRate = durationMs > 0 ? (samples.length - 1) * 1000 / durationMs : 0;
  return { peak, rms, sampleRate, durationMs };
}

async function stopRecording(message = '') {
  if (!state.recording) return;
  state.recording = false;
  el.startRecordBtn.disabled = false;
  el.stopRecordBtn.disabled = true;
  el.addMarkerBtn.disabled = true;
  el.recordingBadge.textContent = '保存中…';
  el.recordingBadge.classList.remove('active');

  if (!state.samples.length) {
    el.recordingBadge.textContent = '沒有收到資料';
    return;
  }
  const stats = calculateStats(state.samples);
  const record = {
    id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    schemaVersion: 1,
    name: el.recordName.value.trim() || `震動紀錄 ${new Date().toLocaleString('zh-TW')}`,
    note: el.recordNote.value.trim(),
    createdAt: state.recordStartIso,
    endedAt: new Date().toISOString(),
    source: state.demoMode ? 'demo' : 'DeviceMotionEvent',
    units: 'm/s²',
    coordinateSystem: 'device coordinates',
    stats,
    markers: state.markers,
    samples: state.samples,
  };
  await putRecord(record);
  el.recordingBadge.textContent = '已保存';
  el.recordName.value = '';
  el.recordNote.value = '';
  state.samples = [];
  state.markers = [];
  await renderHistory();
  if (message) alert(message);
}

function addMarker() {
  if (!state.recording) return;
  const label = prompt('標記名稱（可留白）', `標記 ${state.markers.length + 1}`);
  if (label === null) return;
  state.markers.push({ t: performance.now() - state.recordStartPerf, label: label.trim() || `標記 ${state.markers.length + 1}` });
  el.recordingBadge.textContent = `錄製中・${state.markers.length} 個標記`;
}

