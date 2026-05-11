// ─── Constants ──────────────────────────────────────────────────────────────
const EL_API      = 'https://api.elevenlabs.io/v1';
const EL_MODEL    = 'eleven_turbo_v2_5';  // fast + natural; swap for eleven_multilingual_v2 for more langs
const EL_MAX_CHARS = 4000;

// ─── State ──────────────────────────────────────────────────────────────────
let appState       = 'idle';        // idle | playing | paused | loading | done
let mode           = 'browser';     // browser | elevenlabs
let charIndexStart = 0;             // char offset where current browser utterance starts
let isSeeking      = false;
let seekBarHeld    = false;   // true while mouse/touch is physically held on bar
let elVoices           = [];
let elAbortCtrl        = null;   // AbortController for in-flight EL fetch
let synthBugTimer      = null;   // Chrome 15-sec pause bug workaround
let progressTimer      = null;   // time-based progress fallback ticker
let speechStartTime    = 0;      // Date.now() when current utterance began
let estimatedDurationMs = 0;     // rough estimate of total utterance length

const synth = window.speechSynthesis;
let utterance = null;

// ─── DOM refs ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const el = {
  textInput:    $('textInput'),
  voiceSelect:  $('voiceSelect'),
  rateSlider:   $('rateSlider'),
  pitchSlider:  $('pitchSlider'),
  volumeSlider: $('volumeSlider'),
  seekBar:      $('seekBar'),
  statusBadge:  $('statusBadge'),
  statusDot:    $('statusDot'),
  statusText:   $('statusText'),
  progressPct:  $('progressPct'),
  wordBox:      $('currentWordBox'),
  charCount:    $('charCount'),
  wordCount:    $('wordCount'),
  elAudio:      $('elAudio'),
  elApiKey:     $('elApiKey'),
  elMsg:        $('elMsg'),
  btnPlay:      $('btnPlay'),
  btnPause:     $('btnPause'),
  btnResume:    $('btnResume'),
  btnStop:      $('btnStop'),
};

// ─── Browser support ─────────────────────────────────────────────────────────
if (!synth) $('noSupportBanner').classList.remove('hidden');

// ─── Mode switching ──────────────────────────────────────────────────────────
function switchMode(m) {
  mode = m;
  handleStop();
  $('tabBrowser').classList.toggle('active', m === 'browser');
  $('tabEL').classList.toggle('active', m === 'elevenlabs');
  $('tabBrowser').setAttribute('aria-selected', m === 'browser');
  $('tabEL').setAttribute('aria-selected', m === 'elevenlabs');
  $('elPanel').classList.toggle('hidden', m !== 'elevenlabs');
  $('elPitchNote').classList.toggle('hidden', m !== 'elevenlabs');
  populateVoices();
}

// ─── Voice categorisation ────────────────────────────────────────────────────
function categoriseVoice(v) {
  const n = v.name.toLowerCase();
  const u = (v.voiceURI || '').toLowerCase();
  if (n.includes('google'))  return 'google';
  if (n.includes('apple') || u.includes('com.apple') || u.includes('speech:')) return 'apple';
  // Edge/Azure neural voices — surprisingly natural
  if ((n.includes('microsoft') || n.includes('azure')) &&
      (n.includes('natural') || n.includes('online') || n.includes('neural'))) return 'neural';
  // Old SAPI robots
  if (n.includes('microsoft') || n.includes('zira') || n.includes('david') ||
      n.includes('mark') || n.includes('hazel') || n.includes('helen') ||
      u.includes('tts_ms')) return 'ms_old';
  return 'other';
}

const GROUP_DEFS = [
  { key: 'google',  label: '\uD83C\uDF99\uFE0F Google Voices (Great quality)' },
  { key: 'apple',   label: '\uD83C\uDF4E Apple Voices (Great quality)' },
  { key: 'neural',  label: '\uD83E\uDDE0 Microsoft Neural / Edge (Natural)' },
  { key: 'other',   label: '\uD83C\uDF10 Other Voices' },
  { key: 'ms_old',  label: '\uD83E\uDDF9 Microsoft Standard (Robotic \u2014 avoid)' },
];

function populateVoices() {
  el.voiceSelect.innerHTML = '';

  if (mode === 'elevenlabs') {
    if (!elVoices.length) {
      el.voiceSelect.innerHTML = '<option value="">\u2197 Load voices in the Setup panel above\u2026</option>';
      return;
    }
    elVoices.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.voice_id;
      const lb  = v.labels || {};
      const tag = [lb.gender, lb.accent, lb.description].filter(Boolean).join(' \u00b7 ');
      opt.textContent = `${v.name}${tag ? '  \u2014  ' + tag : ''}`;
      el.voiceSelect.appendChild(opt);
    });
    return;
  }

  // Browser TTS: categorise + sort into optgroups
  const voices = synth.getVoices();
  if (!voices.length) { el.voiceSelect.innerHTML = '<option>Loading\u2026</option>'; return; }

  const groups = { google:[], apple:[], neural:[], other:[], ms_old:[] };
  voices.forEach((v, i) => groups[categoriseVoice(v)].push({ v, i }));

  GROUP_DEFS.forEach(({ key, label }) => {
    if (!groups[key].length) return;
    const grp = document.createElement('optgroup');
    grp.label = label;
    groups[key].forEach(({ v, i }) => {
      const opt = document.createElement('option');
      opt.value = i;
      opt.textContent = `${v.name} (${v.lang})`;
      grp.appendChild(opt);
    });
    el.voiceSelect.appendChild(grp);
  });

  // Auto-select first non-robotic voice
  const firstGood = el.voiceSelect.querySelector(
    'optgroup:not([label*="Robotic"]) option'
  );
  if (firstGood) firstGood.selected = true;
}

populateVoices();
if (synth.onvoiceschanged !== undefined) synth.onvoiceschanged = populateVoices;

// ─── Text counters ───────────────────────────────────────────────────────────
el.textInput.addEventListener('input', updateCounts);
function updateCounts() {
  const txt = el.textInput.value;
  el.charCount.textContent = `${txt.length.toLocaleString()} characters`;
  const w = txt.trim() ? txt.trim().split(/\s+/).length : 0;
  el.wordCount.textContent = `${w.toLocaleString()} word${w !== 1 ? 's' : ''}`;
}

// ─── Status & buttons ────────────────────────────────────────────────────────
const STATUS = {
  idle:    { cls:'badge-idle',    dot:'#868686', text:'Idle',     anim:false },
  playing: { cls:'badge-playing', dot:'#0053e2', text:'Playing',  anim:true  },
  paused:  { cls:'badge-paused',  dot:'#ffc220', text:'Paused',   anim:false },
  loading: { cls:'badge-loading', dot:'#0053e2', text:'Loading\u2026', anim:true },
  done:    { cls:'badge-done',    dot:'#2a8703', text:'Done \u2713', anim:false },
};

function setStatus(s) {
  appState = s;
  const m = STATUS[s] || STATUS.idle;
  el.statusBadge.className = `badge ${m.cls}`;
  el.statusDot.style.background = m.dot;
  el.statusDot.classList.toggle('dot-anim', m.anim);
  el.statusText.textContent = m.text;
}

function updateButtons(s) {
  el.btnPlay.disabled   = ['playing','paused','loading'].includes(s);
  el.btnPause.disabled  = s !== 'playing';
  el.btnStop.disabled   = s === 'idle' || s === 'done';
  const isPaused = s === 'paused';
  el.btnResume.style.display = isPaused ? '' : 'none';
  el.btnResume.disabled = !isPaused;
}

// ─── Seek bar & progress ─────────────────────────────────────────────────────
// force=true bypasses the drag-guard (used when we explicitly set a position)
function setProgress(pct, force = false) {
  if (isSeeking && !force) return;
  const p = Math.min(100, Math.max(0, pct));
  el.seekBar.value = p;
  el.seekBar.style.setProperty('--fill', p + '%');
  el.seekBar.setAttribute('aria-valuenow', Math.round(p));
  el.progressPct.textContent = Math.round(p) + '%';
}

// ─── Time-based progress ticker ──────────────────────────────────────────────
// onboundary is unreliable on Windows/many voices, so we drive the bar with a
// timer and let onboundary provide precision corrections when it does fire.
function startProgressTimer(fullText, fromChar, rate) {
  clearProgressTimer();
  speechStartTime = Date.now();
  const remaining  = fullText.substring(fromChar);
  const wordCount  = remaining.trim().split(/\s+/).length;
  // ~140 wpm at rate 1.0 — adjusted for selected rate
  estimatedDurationMs = Math.max(500, (wordCount / 140) * 60000 / Math.max(0.1, rate));

  const startPct = (fromChar / fullText.length) * 100;
  const pctRange = 100 - startPct;

  progressTimer = setInterval(() => {
    if (isSeeking || appState !== 'playing') return;
    const fraction = Math.min(0.99, (Date.now() - speechStartTime) / estimatedDurationMs);
    setProgress(startPct + fraction * pctRange);
  }, 150);
}

function clearProgressTimer() {
  if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
}

function showWord(word) {
  if (!word) return;
  el.wordBox.innerHTML = `Speaking: <span class="word-hl">${escHtml(word)}</span>`;
  el.wordBox.style.color = '#1a1a1a';
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Live visual fill while dragging — runs on every tick
el.seekBar.addEventListener('input', () => {
  el.seekBar.style.setProperty('--fill', el.seekBar.value + '%');
  el.progressPct.textContent = Math.round(el.seekBar.value) + '%';
});

// Arm isSeeking the moment the user touches the bar
el.seekBar.addEventListener('mousedown',  () => { isSeeking = true; seekBarHeld = true; });
el.seekBar.addEventListener('touchstart', () => { isSeeking = true; seekBarHeld = true; }, { passive: true });

// Listen on DOCUMENT so we catch release even if cursor leaves the bar
document.addEventListener('mouseup', () => {
  if (!seekBarHeld) return;
  seekBarHeld = false;
  commitSeek();
});
document.addEventListener('touchend', () => {
  if (!seekBarHeld) return;
  seekBarHeld = false;
  commitSeek();
}, { passive: true });

// Fallback: keyboard arrow navigation on the range fires 'change' without mousedown
el.seekBar.addEventListener('change', () => {
  if (seekBarHeld) return; // already handled via mouseup/touchend above
  isSeeking = true;
  commitSeek();
});

function commitSeek() {
  const pct = parseFloat(el.seekBar.value);
  if (mode === 'elevenlabs') seekEL(pct);
  else seekBrowser(pct);
  // Hold isSeeking a little longer so stale onboundary / ontimeupdate
  // events from the old position can't snap the bar back
  setTimeout(() => { isSeeking = false; }, 500);
}

// ─── Browser TTS ─────────────────────────────────────────────────────────────
function startBrowserUtterance(fullText, fromChar) {
  const remaining = fullText.substring(fromChar);
  if (!remaining.trim()) return;
  charIndexStart = fromChar;

  utterance = new SpeechSynthesisUtterance(remaining);

  const voices = synth.getVoices();
  const idx    = parseInt(el.voiceSelect.value);
  if (!isNaN(idx) && voices[idx]) utterance.voice = voices[idx];
  const rate  = parseFloat(el.rateSlider.value);
  utterance.rate   = rate;
  utterance.pitch  = parseFloat(el.pitchSlider.value);
  utterance.volume = parseFloat(el.volumeSlider.value);

  // onboundary = precision correction on top of the ticker (unreliable on Windows)
  utterance.onboundary = (e) => {
    if (isSeeking || e.name !== 'word') return;
    const totalChar = charIndexStart + e.charIndex;
    setProgress((totalChar / fullText.length) * 100);
    const word = fullText.substring(totalChar, totalChar + (e.charLength || 12)).split(/\s/)[0];
    showWord(word);
  };

  utterance.onstart = () => {
    // Kick off the ticker once speech actually starts
    startProgressTimer(fullText, fromChar, rate);
  };

  utterance.onend = () => {
    clearSynthBugTimer();
    clearProgressTimer();
    if (isSeeking) return;
    setStatus('done');
    updateButtons('done');
    setProgress(100, true);
    el.wordBox.innerHTML = '\u2705 <span style="color:#2a8703;font-weight:600">Finished!</span>';
  };

  utterance.onerror = (e) => {
    clearSynthBugTimer();
    clearProgressTimer();
    if (e.error === 'interrupted' || e.error === 'canceled') return;
    setStatus('idle');
    updateButtons('idle');
    el.wordBox.textContent = '\u274c Error: ' + e.error;
  };

  synth.speak(utterance);
  startSynthBugTimer();
}

// Chrome silently pauses after ~15s; this nudges it awake
function startSynthBugTimer() {
  clearSynthBugTimer();
  synthBugTimer = setInterval(() => {
    if (synth.speaking && !synth.paused) { synth.pause(); synth.resume(); }
  }, 12000);
}
function clearSynthBugTimer() {
  if (synthBugTimer) { clearInterval(synthBugTimer); synthBugTimer = null; }
}

function seekBrowser(pct) {
  const text = el.textInput.value.trim();
  if (!text) return;
  const targetChar = Math.floor(text.length * pct / 100);
  // Snap to previous word boundary so we don't start mid-word
  const spaceIdx  = text.lastIndexOf(' ', targetChar);
  const startChar = spaceIdx > 0 ? spaceIdx + 1 : 0;
  const wasActive = appState === 'playing' || appState === 'paused';

  clearSynthBugTimer();
  clearProgressTimer();
  synth.cancel();

  if (wasActive) {
    startBrowserUtterance(text, startChar);
    setStatus('playing');
    updateButtons('playing');
  } else {
    charIndexStart = startChar;
  }
  // force=true so isSeeking cooldown doesn't block the position update
  setProgress(pct, true);
}

// ─── ElevenLabs ──────────────────────────────────────────────────────────────
async function loadELVoices() {
  const key = el.elApiKey.value.trim();
  if (!key) { showElMsg('Please enter your API key first.', 'error'); return; }
  showElMsg('\u23f3 Fetching voices\u2026', 'info');
  $('elLoadBtn').disabled = true;
  try {
    const res = await fetch(`${EL_API}/voices`, { headers: { 'xi-api-key': key } });
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    elVoices = (data.voices || []).sort((a, b) =>
      (a.category === 'premade' ? -1 : 1) - (b.category === 'premade' ? -1 : 1)
    );
    populateVoices();
    showElMsg(`\u2705 Loaded ${elVoices.length} voices! Pick one and hit Play.`, 'success');
  } catch (err) {
    showElMsg(`\u274c ${err.message}`, 'error');
  } finally {
    $('elLoadBtn').disabled = false;
  }
}

function showElMsg(msg, type) {
  el.elMsg.textContent = msg;
  const styles = {
    error:   'background:#fff0f0;color:#ea1100;border:1px solid #ea1100',
    success: 'background:#e8f5e1;color:#2a8703;border:1px solid #2a8703',
    info:    'background:#f0f5ff;color:#0053e2;border:1px solid #b3d0ff',
  };
  el.elMsg.style.cssText = styles[type] || styles.info;
  el.elMsg.classList.remove('hidden');
}

async function playEL() {
  const key     = el.elApiKey.value.trim();
  const voiceId = el.voiceSelect.value;
  const text    = el.textInput.value.trim();
  if (!key)     { showElMsg('Enter your ElevenLabs API key.', 'error'); return; }
  if (!voiceId) { showElMsg('Load and select a voice first.', 'error');  return; }
  if (!text)    { flashEmpty(); return; }

  const payload = text.length > EL_MAX_CHARS ? text.substring(0, EL_MAX_CHARS) : text;
  if (text.length > EL_MAX_CHARS)
    showElMsg(`\u26a0\ufe0f Text truncated to ${EL_MAX_CHARS} chars for ElevenLabs.`, 'info');

  setStatus('loading');
  updateButtons('loading');
  el.wordBox.textContent = '\u23f3 Generating audio with ElevenLabs AI\u2026';

  if (elAbortCtrl) elAbortCtrl.abort();
  elAbortCtrl = new AbortController();

  try {
    const res = await fetch(`${EL_API}/text-to-speech/${voiceId}`, {
      method: 'POST',
      signal: elAbortCtrl.signal,
      headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: payload,
        model_id: EL_MODEL,
        voice_settings: { stability:0.5, similarity_boost:0.75, style:0.0, use_speaker_boost:true },
      }),
    });
    if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);

    const blob = await res.blob();
    const url  = URL.createObjectURL(blob);

    el.elAudio.src           = url;
    el.elAudio.playbackRate  = parseFloat(el.rateSlider.value);
    el.elAudio.volume        = parseFloat(el.volumeSlider.value);

    el.elAudio.onplay = () => {
      setStatus('playing');
      updateButtons('playing');
      el.wordBox.textContent = '\uD83D\uDD0A Playing ElevenLabs AI audio\u2026';
    };
    el.elAudio.ontimeupdate = () => {
      if (isSeeking || !el.elAudio.duration) return;
      setProgress((el.elAudio.currentTime / el.elAudio.duration) * 100);
    };
    el.elAudio.onended = () => {
      setStatus('done');
      updateButtons('done');
      setProgress(100);
      el.wordBox.innerHTML = '\u2705 <span style="color:#2a8703;font-weight:600">Finished!</span>';
    };
    el.elAudio.onerror = () => {
      setStatus('idle'); updateButtons('idle');
      el.wordBox.textContent = '\u274c Audio playback error.';
    };

    await el.elAudio.play();
  } catch (err) {
    if (err.name === 'AbortError') return;
    setStatus('idle'); updateButtons('idle');
    el.wordBox.textContent = '\u274c ' + err.message;
    showElMsg(`\u274c ${err.message}`, 'error');
  }
}

function seekEL(pct) {
  if (el.elAudio.duration) {
    el.elAudio.currentTime = el.elAudio.duration * (pct / 100);
  }
}

// ─── Unified playback controls ────────────────────────────────────────────────
function handlePlay() {
  if (mode === 'elevenlabs') { playEL(); return; }
  const text = el.textInput.value.trim();
  if (!text) { flashEmpty(); return; }
  clearSynthBugTimer();
  synth.cancel();
  setProgress(0);
  startBrowserUtterance(text, 0);
  setStatus('playing');
  updateButtons('playing');
}

function handlePause() {
  if (mode === 'elevenlabs') {
    el.elAudio.pause(); setStatus('paused'); updateButtons('paused');
  } else if (synth.speaking && !synth.paused) {
    clearSynthBugTimer();
    synth.pause(); setStatus('paused'); updateButtons('paused');
  }
}

function handleResume() {
  if (mode === 'elevenlabs') {
    el.elAudio.play(); setStatus('playing'); updateButtons('playing');
  } else if (synth.paused) {
    synth.resume(); startSynthBugTimer();
    setStatus('playing'); updateButtons('playing');
  }
}

function handleStop() {
  clearSynthBugTimer();
  clearProgressTimer();
  synth.cancel();
  if (elAbortCtrl) { elAbortCtrl.abort(); elAbortCtrl = null; }
  el.elAudio.pause();
  el.elAudio.currentTime = 0;
  setStatus('idle');
  updateButtons('idle');
  setProgress(0, true);
  el.wordBox.textContent = 'Current word will appear here\u2026';
  el.wordBox.style.color = '#868686';
}

function flashEmpty() {
  el.textInput.focus();
  el.textInput.style.borderColor = '#ea1100';
  setTimeout(() => { el.textInput.style.borderColor = '#c2c2c2'; }, 1500);
}

// ─── Sample & Clear ───────────────────────────────────────────────────────────
function loadSample() {
  el.textInput.value = [
    'Welcome to the enhanced Puppy Text Reader! \uD83D\uDC36',
    '',
    'Drag the blue seek bar up top to jump anywhere in the text \u2014 no need to listen from the start. You can also use the left and right arrow keys to skip backward or forward by 5%.',
    '',
    'For the most natural-sounding speech, switch to the ElevenLabs AI tab. Voices like Rachel, Charlotte, and Adam sound remarkably close to real humans. Get a free API key at elevenlabs.io \u2014 you get 10,000 characters per month for free.',
    '',
    'Browser voices are sorted by quality: Google and Apple voices come first, while the old robotic Microsoft SAPI voices are tucked away at the bottom where they belong. The Microsoft Edge Neural voices (if you\u2019re on Edge) are surprisingly natural too!',
    '',
    'Happy listening! Woof woof! \uD83C\uDF99\uFE0F',
  ].join('\n');
  updateCounts();
}

function clearText() {
  handleStop();
  el.textInput.value = '';
  updateCounts();
  el.textInput.focus();
}

// ─── Keyboard shortcuts ───────────────────────────────────────────────────────
document.addEventListener('keydown', e => {
  const active = document.activeElement;
  if (active === el.textInput || active === el.elApiKey) return;

  if (e.code === 'Space') {
    e.preventDefault();
    if (appState === 'playing') handlePause();
    else if (appState === 'paused') handleResume();
    else handlePlay();
  }
  if (e.code === 'Escape') handleStop();

  // Arrow key seek: ±5% with same cooldown as drag
  if ((e.code === 'ArrowRight' || e.code === 'ArrowLeft') &&
      (appState === 'playing' || appState === 'paused')) {
    e.preventDefault();
    const delta  = e.code === 'ArrowRight' ? 5 : -5;
    const newPct = Math.min(100, Math.max(0, parseFloat(el.seekBar.value) + delta));
    el.seekBar.value = newPct;
    el.seekBar.style.setProperty('--fill', newPct + '%');
    el.progressPct.textContent = Math.round(newPct) + '%';
    isSeeking = true;
    if (mode === 'elevenlabs') seekEL(newPct);
    else seekBrowser(newPct);
    setTimeout(() => { isSeeking = false; }, 500);
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
setStatus('idle');
updateButtons('idle');
updateCounts();
