(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    file: $('scoreFile'), loadDemo: $('loadDemo'), startMic: $('startMic'), micStatus: $('micStatus'),
    tolerance: $('tolerance'), toleranceValue: $('toleranceValue'), holdMs: $('holdMs'), holdValue: $('holdValue'),
    concertA: $('concertA'), concertAValue: $('concertAValue'), targetNote: $('targetNote'), targetFreq: $('targetFreq'),
    progressText: $('progressText'), needle: $('tunerNeedle'), pitchReadout: $('pitchReadout'), qualityText: $('qualityText'),
    holdFill: $('holdFill'), prev: $('prevNote'), next: $('nextNote'), scoreTitle: $('scoreTitle'), scoreHint: $('scoreHint'),
    osmdContainer: $('osmdContainer'), statAccepted: $('statAccepted'), statAvg: $('statAvg'), statBias: $('statBias'),
    detectedFreq: $('detectedFreq'), resetStats: $('resetStats')
  };

  const state = {
    osmd: null,
    notes: [],
    index: 0,
    audioContext: null,
    analyser: null,
    source: null,
    stream: null,
    buffer: null,
    raf: null,
    micOn: false,
    stableSince: null,
    lastFrameTime: 0,
    accepted: 0,
    centsSamples: [],
    sharpSamples: 0,
    flatSamples: 0,
    requireRelease: false,
    silenceSince: null,
    justAdvancedAt: 0
  };

  const STEP = { C:0, D:2, E:4, F:5, G:7, A:9, B:11 };
  const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];

  function midiToFreq(midi) {
    const a = Number(els.concertA.value) || 440;
    return a * Math.pow(2, (midi - 69) / 12);
  }

  function midiToLabel(midi) {
    return `${NOTE_NAMES[(midi % 12 + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  }

  function setMessage(text, kind='') {
    els.qualityText.textContent = text;
    els.qualityText.className = `quality-text ${kind}`.trim();
  }

  function updateSettingsLabels() {
    els.toleranceValue.textContent = `±${els.tolerance.value} ¢`;
    els.holdValue.textContent = `${els.holdMs.value} мс`;
    els.concertAValue.textContent = `${els.concertA.value} Гц`;
    updateTargetUI();
  }

  function updateTargetUI() {
    const note = state.notes[state.index];
    if (!note) {
      els.targetNote.textContent = '—';
      els.targetFreq.textContent = state.notes.length ? 'Готово' : 'Загрузи партитуру';
      els.progressText.textContent = `${Math.min(state.index, state.notes.length)} / ${state.notes.length}`;
      return;
    }
    els.targetNote.textContent = note.label;
    els.targetFreq.textContent = `${midiToFreq(note.midi).toFixed(1)} Гц · такт ${note.measure}`;
    els.progressText.textContent = `${state.index + 1} / ${state.notes.length}`;
  }

  function parseMusicXML(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    if (doc.querySelector('parsererror')) throw new Error('Не удалось разобрать MusicXML.');
    const part = doc.querySelector('score-partwise > part, score-timewise part');
    if (!part) throw new Error('В файле не найдена партия.');
    const out = [];
    const measures = [...part.querySelectorAll(':scope > measure')];
    for (const measure of measures) {
      const measureNo = measure.getAttribute('number') || '?';
      for (const note of [...measure.querySelectorAll(':scope > note')]) {
        if (note.querySelector(':scope > rest')) continue;
        if (note.querySelector(':scope > chord')) continue; // MVP: monophonic first voice
        const pitch = note.querySelector(':scope > pitch');
        if (!pitch) continue;
        const step = pitch.querySelector(':scope > step')?.textContent?.trim();
        const octave = Number(pitch.querySelector(':scope > octave')?.textContent);
        const alter = Number(pitch.querySelector(':scope > alter')?.textContent || 0);
        if (!(step in STEP) || !Number.isFinite(octave)) continue;
        const midi = (octave + 1) * 12 + STEP[step] + alter;
        out.push({ midi, label: midiToLabel(midi), measure: measureNo });
      }
    }
    if (!out.length) throw new Error('Не нашла нот с высотой звука. Нужен обычный MusicXML с партией виолончели.');
    return out;
  }

  async function renderScore(xmlText, title='Партитура') {
    if (!window.opensheetmusicdisplay) throw new Error('Модуль отображения нот ещё не загрузился. Проверь интернет и обнови страницу.');
    els.osmdContainer.innerHTML = '';
    state.osmd = new opensheetmusicdisplay.OpenSheetMusicDisplay('osmdContainer', {
      autoResize: true,
      backend: 'svg',
      drawTitle: true,
      drawingParameters: 'compacttight',
      followCursor: true
    });
    await state.osmd.load(xmlText);
    state.osmd.render();
    try {
      state.osmd.cursor.reset();
      state.osmd.cursor.show();
    } catch (_) {}
    els.scoreTitle.textContent = title;
  }

  function resetPractice() {
    state.index = 0;
    state.stableSince = null;
    state.requireRelease = false;
    state.silenceSince = null;
    if (state.osmd) {
      try { state.osmd.cursor.reset(); state.osmd.cursor.show(); } catch (_) {}
    }
    updateTargetUI();
    resetTuner();
  }

  function resetTuner() {
    els.needle.style.left = '50%';
    els.needle.style.background = 'var(--accent-2)';
    els.pitchReadout.textContent = state.micOn ? 'Жду звук…' : 'Микрофон выключен';
    els.holdFill.style.width = '0%';
    setMessage('—');
    els.detectedFreq.textContent = '—';
  }

  function cursorNext() {
    if (!state.osmd) return;
    try { state.osmd.cursor.next(); } catch (_) {}
  }

  function cursorPrev() {
    if (!state.osmd) return;
    try { state.osmd.cursor.previous(); } catch (_) {}
  }

  function advance() {
    if (state.index >= state.notes.length) return;
    const currentMidi = state.notes[state.index]?.midi;
    state.index += 1;
    state.accepted += 1;
    state.stableSince = null;
    state.justAdvancedAt = performance.now();
    const nextMidi = state.notes[state.index]?.midi;
    state.requireRelease = nextMidi != null && nextMidi === currentMidi;
    cursorNext();
    updateTargetUI();
    updateStats();
    els.holdFill.style.width = '0%';
    if (state.index >= state.notes.length) {
      setMessage('Фрагмент закончен', 'good');
      els.pitchReadout.textContent = 'Готово';
    }
  }

  function previous() {
    if (state.index <= 0) return;
    state.index -= 1;
    state.stableSince = null;
    state.requireRelease = false;
    cursorPrev();
    updateTargetUI();
  }

  function centsFromTarget(freq, targetFreq) {
    return 1200 * Math.log2(freq / targetFreq);
  }

  function updateTuner(freq, confidence, now=performance.now()) {
    const note = state.notes[state.index];
    if (!note || !Number.isFinite(freq) || freq <= 0 || confidence < 0.45) {
      if (!state.silenceSince) state.silenceSince = now;
      if (state.requireRelease && now - state.silenceSince > 90) state.requireRelease = false;
      state.stableSince = null;
      els.holdFill.style.width = '0%';
      els.pitchReadout.textContent = state.micOn ? 'Жду устойчивый звук…' : 'Микрофон выключен';
      els.detectedFreq.textContent = '—';
      return;
    }

    state.silenceSince = null;
    const targetFreq = midiToFreq(note.midi);
    const cents = centsFromTarget(freq, targetFreq);
    const tolerance = Number(els.tolerance.value);
    const clamped = Math.max(-50, Math.min(50, cents));
    els.needle.style.left = `${50 + clamped}%`;
    els.detectedFreq.textContent = `${freq.toFixed(1)} Гц`;
    els.pitchReadout.textContent = `${cents >= 0 ? '+' : ''}${cents.toFixed(0)} ¢`;

    if (state.requireRelease) {
      els.holdFill.style.width = '0%';
      setMessage('Отпусти / переатакуй повторную ноту', 'warn');
      if (Math.abs(cents) > Math.max(35, tolerance * 1.7)) state.requireRelease = false;
      return;
    }

    const isGood = Math.abs(cents) <= tolerance;
    if (isGood) {
      els.needle.style.background = 'var(--good)';
      if (state.stableSince == null) state.stableSince = now;
      const held = now - state.stableSince;
      const ratio = Math.min(1, held / Number(els.holdMs.value));
      els.holdFill.style.width = `${ratio * 100}%`;
      setMessage('Чисто — удерживай', 'good');
      state.centsSamples.push(Math.abs(cents));
      if (cents > 2) state.sharpSamples += 1;
      if (cents < -2) state.flatSamples += 1;
      if (held >= Number(els.holdMs.value)) advance();
    } else {
      els.needle.style.background = 'var(--bad)';
      state.stableSince = null;
      els.holdFill.style.width = '0%';
      setMessage(cents < 0 ? 'Низко — чуть выше' : 'Высоко — чуть ниже', cents < 0 ? 'warn' : 'bad');
    }
    updateStats();
  }

  // Normalized autocorrelation, tuned for the cello range. Returns {frequency, confidence}.
  function detectPitch(buffer, sampleRate) {
    let rms = 0;
    for (let i = 0; i < buffer.length; i++) rms += buffer[i] * buffer[i];
    rms = Math.sqrt(rms / buffer.length);
    if (rms < 0.008) return { frequency: null, confidence: 0 };

    const minFreq = 55;
    const maxFreq = 1200;
    const minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
    const maxLag = Math.min(buffer.length - 2, Math.ceil(sampleRate / minFreq));

    let bestLag = -1;
    let bestCorr = -1;
    const corrs = new Float32Array(maxLag + 1);

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0, e1 = 0, e2 = 0;
      const n = buffer.length - lag;
      for (let i = 0; i < n; i++) {
        const a = buffer[i];
        const b = buffer[i + lag];
        sum += a * b;
        e1 += a * a;
        e2 += b * b;
      }
      const denom = Math.sqrt(e1 * e2) + 1e-12;
      const corr = sum / denom;
      corrs[lag] = corr;
      if (corr > bestCorr) { bestCorr = corr; bestLag = lag; }
    }

    if (bestLag < 0 || bestCorr < 0.45) return { frequency: null, confidence: Math.max(0, bestCorr) };

    let refinedLag = bestLag;
    if (bestLag > minLag && bestLag < maxLag) {
      const y1 = corrs[bestLag - 1], y2 = corrs[bestLag], y3 = corrs[bestLag + 1];
      const denom = (y1 - 2 * y2 + y3);
      if (Math.abs(denom) > 1e-9) refinedLag += 0.5 * (y1 - y3) / denom;
    }
    return { frequency: sampleRate / refinedLag, confidence: bestCorr };
  }

  function audioLoop(now) {
    state.raf = requestAnimationFrame(audioLoop);
    if (!state.analyser || now - state.lastFrameTime < 55) return;
    state.lastFrameTime = now;
    state.analyser.getFloatTimeDomainData(state.buffer);
    const result = detectPitch(state.buffer, state.audioContext.sampleRate);
    updateTuner(result.frequency, result.confidence, now);
  }

  async function toggleMic() {
    if (state.micOn) {
      stopMic();
      return;
    }
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('Браузер не даёт доступ к микрофону. Открой через HTTPS или localhost.');
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false
      });
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
      await state.audioContext.resume();
      state.source = state.audioContext.createMediaStreamSource(state.stream);
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 4096;
      state.analyser.smoothingTimeConstant = 0;
      state.source.connect(state.analyser);
      state.buffer = new Float32Array(state.analyser.fftSize);
      state.micOn = true;
      els.startMic.textContent = 'Выключить микрофон';
      els.micStatus.textContent = 'Микрофон слушает';
      els.micStatus.classList.add('good');
      cancelAnimationFrame(state.raf);
      state.raf = requestAnimationFrame(audioLoop);
    } catch (err) {
      setMessage(err.message || 'Не удалось открыть микрофон', 'bad');
      els.micStatus.textContent = 'Нет доступа к микрофону';
      els.micStatus.classList.remove('good');
    }
  }

  function stopMic() {
    state.micOn = false;
    cancelAnimationFrame(state.raf);
    state.raf = null;
    state.stream?.getTracks().forEach(t => t.stop());
    state.audioContext?.close();
    state.stream = null; state.audioContext = null; state.analyser = null; state.source = null;
    els.startMic.textContent = 'Включить микрофон';
    els.micStatus.textContent = 'Микрофон выключен';
    els.micStatus.classList.remove('good');
    resetTuner();
  }

  function updateStats() {
    els.statAccepted.textContent = String(state.accepted);
    if (state.centsSamples.length) {
      const avg = state.centsSamples.reduce((a,b) => a+b,0) / state.centsSamples.length;
      els.statAvg.textContent = `${avg.toFixed(1)} ¢`;
      if (Math.abs(state.sharpSamples - state.flatSamples) < 5) els.statBias.textContent = 'ровно';
      else els.statBias.textContent = state.sharpSamples > state.flatSamples ? 'завышаешь' : 'занижаешь';
    } else {
      els.statAvg.textContent = '—'; els.statBias.textContent = '—';
    }
  }

  function resetStats() {
    state.accepted = 0; state.centsSamples = []; state.sharpSamples = 0; state.flatSamples = 0;
    updateStats();
  }

  async function loadXMLText(xmlText, title) {
    state.notes = parseMusicXML(xmlText);
    await renderScore(xmlText, title);
    resetPractice();
    resetStats();
    els.scoreHint.textContent = `Распознано ${state.notes.length} нот. MVP читает первую монодическую партию.`;
  }

  async function loadFile(file) {
    if (!file) return;
    const name = file.name.toLowerCase();
    if (name.endsWith('.mxl')) {
      throw new Error('Сжатый .mxl пока не поддерживается. Экспортируй несжатый .musicxml или .xml.');
    }
    const xmlText = await file.text();
    await loadXMLText(xmlText, file.name.replace(/\.(musicxml|xml)$/i,''));
  }

  const demoXML = `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<score-partwise version="4.0">
  <work><work-title>Демо — гамма C</work-title></work>
  <part-list><score-part id="P1"><part-name>Cello</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>1</divisions><key><fifths>0</fifths></key><time><beats>4</beats><beat-type>4</beat-type></time><clef><sign>F</sign><line>4</line></clef></attributes>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>E</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>F</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
    <measure number="2">
      <note><pitch><step>G</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>A</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>B</step><octave>3</octave></pitch><duration>1</duration><type>quarter</type></note>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><type>quarter</type></note>
    </measure>
  </part>
</score-partwise>`;

  els.file.addEventListener('change', async (e) => {
    try { await loadFile(e.target.files?.[0]); }
    catch (err) { setMessage(err.message || 'Ошибка загрузки', 'bad'); }
  });
  els.loadDemo.addEventListener('click', async () => {
    try { await loadXMLText(demoXML, 'Демо — гамма C'); }
    catch (err) { setMessage(err.message || 'Ошибка демо', 'bad'); }
  });
  els.startMic.addEventListener('click', toggleMic);
  els.prev.addEventListener('click', previous);
  els.next.addEventListener('click', () => { if (state.index < state.notes.length) { state.index++; cursorNext(); updateTargetUI(); } });
  els.resetStats.addEventListener('click', resetStats);
  [els.tolerance, els.holdMs, els.concertA].forEach(el => el.addEventListener('input', updateSettingsLabels));
  document.querySelectorAll('[data-test-cents]').forEach(btn => btn.addEventListener('click', () => {
    const note = state.notes[state.index];
    if (!note) return;
    state.requireRelease = false;
    const cents = Number(btn.dataset.testCents);
    const freq = midiToFreq(note.midi) * Math.pow(2, cents/1200);
    updateTuner(freq, 0.99, performance.now());
    if (cents === 0) {
      const start = performance.now();
      state.stableSince = start - Number(els.holdMs.value) - 1;
      updateTuner(freq, 0.99, performance.now());
    }
  }));

  updateSettingsLabels();
  updateStats();
})();
