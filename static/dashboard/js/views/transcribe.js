// 在线转录：上传 / 拖拽 / 麦克风录音
import { escape } from "../lib/escape.js";

const transState = {
  recording: false,
  audioCtx: null,
  source: null,
  processor: null,
  stream: null,
  chunks: [],
  sampleRate: 0,
  recStartMs: 0,
  timerHandle: null,
  meterHandle: null,
  blobUrl: null,
};

export async function mount() {
  const dz = document.getElementById("trans-dropzone");
  const fileInput = document.getElementById("trans-file");
  if (!dz || !fileInput) return;

  dz.addEventListener("click", () => fileInput.click());
  dz.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => {
    const f = fileInput.files && fileInput.files[0];
    if (f) submitAudio(f);
    fileInput.value = "";
  });

  ["dragenter", "dragover"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
  });
  ["dragleave", "dragend", "drop"].forEach((ev) => {
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
    });
  });
  dz.addEventListener("drop", (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) submitAudio(f);
  });

  document.getElementById("trans-rec-btn").addEventListener("click", toggleRecording);

  document.getElementById("trans-copy-btn").addEventListener("click", () => {
    const text = document.getElementById("trans-result-text").innerText;
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      const btn = document.getElementById("trans-copy-btn");
      const orig = btn.textContent;
      btn.textContent = "已复制";
      setTimeout(() => { btn.textContent = orig; }, 1400);
    });
  });
  document.getElementById("trans-reset-btn").addEventListener("click", resetTranscribe);

  resetTranscribe();
}

export function unmount() {
  if (transState.recording) stopRecordingDiscard();
  if (transState.blobUrl) {
    URL.revokeObjectURL(transState.blobUrl);
    transState.blobUrl = null;
  }
}

function resetTranscribe() {
  document.getElementById("trans-status").hidden = true;
  document.getElementById("trans-result").hidden = true;
  document.getElementById("trans-rec-time").textContent = "00:00";
  setMeter(0);
  if (transState.recording) stopRecordingDiscard();
  if (transState.blobUrl) {
    URL.revokeObjectURL(transState.blobUrl);
    transState.blobUrl = null;
  }
}

function showTransStatus(html, kind = "info") {
  const el = document.getElementById("trans-status");
  el.className = `trans-status trans-status-${kind}`;
  el.innerHTML = html;
  el.hidden = false;
}

function setRecordingUI(on) {
  const btn = document.getElementById("trans-rec-btn");
  const label = document.getElementById("trans-rec-label");
  btn.classList.toggle("recording", on);
  label.textContent = on ? "停止录音" : "开始录音";
  btn.setAttribute("aria-label", on ? "停止录音" : "开始录音");
}

function setMeter(level) {
  const bar = document.getElementById("trans-rec-meter-bar");
  if (!bar) return;
  bar.style.width = `${Math.min(100, Math.round(level * 100))}%`;
}

async function toggleRecording() {
  if (transState.recording) {
    const blob = await stopRecording();
    if (blob) {
      transState.blobUrl = URL.createObjectURL(blob);
      const file = new File([blob], `recording-${Date.now()}.wav`, { type: "audio/wav" });
      submitAudio(file, transState.blobUrl);
    }
    return;
  }
  try {
    await startRecording();
  } catch (err) {
    showTransStatus(`无法访问麦克风：${escape(err.message || err)}`, "error");
  }
}

async function startRecording() {
  resetTranscribe();
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioCtx.createMediaStreamSource(stream);
  const processor = audioCtx.createScriptProcessor(4096, 1, 1);
  const chunks = [];
  processor.onaudioprocess = (e) => {
    chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
  };
  source.connect(processor);
  processor.connect(audioCtx.destination);

  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 256;
  source.connect(analyser);
  const buf = new Uint8Array(analyser.frequencyBinCount);
  const tickMeter = () => {
    if (!transState.recording) return;
    analyser.getByteTimeDomainData(buf);
    let max = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = Math.abs(buf[i] - 128) / 128;
      if (v > max) max = v;
    }
    setMeter(max);
    transState.meterHandle = requestAnimationFrame(tickMeter);
  };

  Object.assign(transState, {
    recording: true, audioCtx, source, processor, stream, chunks,
    sampleRate: audioCtx.sampleRate, recStartMs: Date.now(),
  });
  setRecordingUI(true);
  transState.meterHandle = requestAnimationFrame(tickMeter);
  transState.timerHandle = setInterval(updateRecTime, 250);
}

function updateRecTime() {
  const elapsed = Math.floor((Date.now() - transState.recStartMs) / 1000);
  const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
  const ss = String(elapsed % 60).padStart(2, "0");
  document.getElementById("trans-rec-time").textContent = `${mm}:${ss}`;
}

async function stopRecording() {
  if (!transState.recording) return null;
  try { transState.processor.disconnect(); } catch {}
  try { transState.source.disconnect(); } catch {}
  try { transState.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { await transState.audioCtx.close(); } catch {}
  if (transState.timerHandle) clearInterval(transState.timerHandle);
  if (transState.meterHandle) cancelAnimationFrame(transState.meterHandle);
  setMeter(0);

  const sampleRate = transState.sampleRate;
  const chunks = transState.chunks;
  transState.recording = false;
  transState.chunks = [];
  setRecordingUI(false);

  if (chunks.length === 0) return null;
  return new Blob([encodeWav(chunks, sampleRate)], { type: "audio/wav" });
}

function stopRecordingDiscard() {
  try { transState.processor && transState.processor.disconnect(); } catch {}
  try { transState.source && transState.source.disconnect(); } catch {}
  try { transState.stream && transState.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { transState.audioCtx && transState.audioCtx.close(); } catch {}
  if (transState.timerHandle) clearInterval(transState.timerHandle);
  if (transState.meterHandle) cancelAnimationFrame(transState.meterHandle);
  transState.recording = false;
  transState.chunks = [];
  setRecordingUI(false);
  setMeter(0);
}

// Float32 chunks → WAV (PCM 16-bit mono) ArrayBuffer
function encodeWav(chunks, sampleRate) {
  let length = 0;
  for (const c of chunks) length += c.length;
  const merged = new Float32Array(length);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }

  const pcm = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const s = Math.max(-1, Math.min(1, merged[i]));
    pcm[i] = s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7FFF);
  }

  const buf = new ArrayBuffer(44 + pcm.byteLength);
  const view = new DataView(buf);
  const writeStr = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return buf;
}

async function submitAudio(file, audioUrl = null) {
  document.getElementById("trans-result").hidden = true;
  showTransStatus(
    `<span class="trans-spinner" aria-hidden="true"></span>正在转录 ${escape(file.name || "audio")}（${(file.size / 1024).toFixed(1)} KB）…`,
    "info",
  );

  if (!audioUrl && file instanceof Blob) {
    audioUrl = URL.createObjectURL(file);
    transState.blobUrl = audioUrl;
  }

  const t0 = Date.now();
  const fd = new FormData();
  fd.append("file", file, file.name || "upload.wav");
  try {
    const r = await fetch("/v1/audio/transcriptions", { method: "POST", body: fd });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const body = await r.json(); if (body.error) msg = body.error; } catch {}
      showTransStatus(`转录失败：${escape(msg)}`, "error");
      return;
    }
    const body = await r.json();
    document.getElementById("trans-status").hidden = true;
    renderTranscribeResult({
      text: body.text || "",
      audioUrl,
      elapsed,
      filename: file.name,
      size: file.size,
    });
  } catch (err) {
    showTransStatus(`请求失败：${escape(err.message || err)}`, "error");
  }
}

function renderTranscribeResult({ text, audioUrl, elapsed, filename, size }) {
  const result = document.getElementById("trans-result");
  document.getElementById("trans-result-meta").textContent =
    `${filename || "audio"} · ${(size / 1024).toFixed(1)} KB · 耗时 ${elapsed}s`;
  document.getElementById("trans-result-text").textContent = text || "(空)";
  const audio = document.getElementById("trans-result-audio");
  if (audioUrl) {
    audio.src = audioUrl;
    audio.hidden = false;
  } else {
    audio.removeAttribute("src");
    audio.hidden = true;
  }
  document.getElementById("trans-result-raw-wrap").hidden = true;
  result.hidden = false;
}
