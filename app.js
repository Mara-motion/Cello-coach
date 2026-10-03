(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const SCORE_URL = 'https://thecellist.ru/wp-content/uploads/2020/04/cp-Goltermann-G.-Stormy-Weather.pdf';
  const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const LOCK_KEY = 'cello-coach-v06-fragment1-locks';

  // Test fragment: first 12 staff positions from the opening phrase.
  // On the first pass an unresolved position accepts the nearest chromatic
  // form of the written staff note (flat / natural / sharp), then remembers it.
  const SEQUENCE = [
    { base:64, staff:'E4' }, { base:65, staff:'F4' }, { base:64, staff:'E4' },
    { base:62, staff:'D4' }, { base:60, staff:'C4' }, { base:62, staff:'D4' },
    { base:60, staff:'C4' }, { base:59, staff:'B3' }, { base:57, staff:'A3' },
    { base:60, staff:'C4' }, { base:59, staff:'B3' }, { base:57, staff:'A3' }
  ];

  const els = {
    micBadge:$('micBadge'), scoreFrame:$('scoreFrame'), openScore:$('openScore'), pageBadge:$('pageBadge'),
    noteName:$('noteName'), octave:$('octave'), manualPicker:$('manualPicker'), pitchTitle:$('pitchTitle'),
    targetDown:$('targetDown'), targetUp:$('targetUp'), targetNote:$('targetNote'), targetFreq:$('targetFreq'), targetFreqMini:$('targetFreqMini'),
    needle:$('needle'), goodZone:$('goodZone'), pitchReadout:$('pitchReadout'), stabilityHint:$('stabilityHint'), quality:$('quality'), holdFill:$('holdFill'), micButton:$('micButton'),
    tolerance:$('tolerance'),tolOut:$('tolOut'),holdMs:$('holdMs'),holdOut:$('holdOut'),concertA:$('concertA'),aOut:$('aOut'),heardStat:$('heardStat'),confStat:$('confStat'),rawStat:$('rawStat'),stableStat:$('stableStat'),acceptedStat:$('acceptedStat'),avgStat:$('avgStat'),installButton:$('installButton'),installHelp:$('installHelp'),
    seqCounter:$('seqCounter'),seqChips:$('seqChips'),seqTarget:$('seqTarget'),seqLockState:$('seqLockState'),seqBack:$('seqBack'),seqSkip:$('seqSkip'),seqRestart:$('seqRestart'),seqToggle:$('seqToggle'),seqClearLocks:$('seqClearLocks'),seqMessage:$('seqMessage')
  };

  function loadLocks(){
    try {
      const value = JSON.parse(localStorage.getItem(LOCK_KEY) || '[]');
      return SEQUENCE.map((_,i) => Number.isInteger(value[i]) ? value[i] : null);
    } catch { return SEQUENCE.map(()=>null); }
  }

  const state={
    page:1,audioContext:null,analyser:null,source:null,stream:null,highpass:null,lowpass:null,buffer:null,raf:null,micOn:false,lastFrame:0,
    stableSince:null,centsWindow:[],accepted:0,centsSamples:[],deferredInstall:null,
    pitchHistory:[], pendingJump:null, lastStableLog:null, lastStableAt:0, rejectedFrames:0,
    sequenceMode:true, seqIndex:0, locks:loadLocks(), finished:false,
    waitingForChange:false,lastAcceptedFreq:null,silenceFrames:0
  };

  function saveLocks(){ localStorage.setItem(LOCK_KEY,JSON.stringify(state.locks)); }
  function pageUrl(page){ return `${SCORE_URL}#page=${page}&zoom=page-width&toolbar=0&navpanes=0`; }
  function setPage(page){ state.page=Math.max(1,Math.min(3,page)); els.scoreFrame.src=pageUrl(state.page); els.openScore.href=pageUrl(state.page); els.pageBadge.textContent=`стр. ${state.page}`; document.querySelectorAll('.page-btn').forEach(b=>b.classList.toggle('active',Number(b.dataset.page)===state.page)); }
  document.querySelectorAll('.page-btn').forEach(b=>b.addEventListener('click',()=>setPage(Number(b.dataset.page))));

  function selectedMidi(){ return (Number(els.octave.value)+1)*12 + Number(els.noteName.value); }
  function midiToFreq(midi){ const a=Number(els.concertA.value)||440; return a*Math.pow(2,(midi-69)/12); }
  function midiToLabel(midi){ return `${NOTE_NAMES[(midi%12+12)%12]}${Math.floor(midi/12)-1}`; }
  function centsFromMidi(freq,midi){ return 1200*Math.log2(freq/midiToFreq(midi)); }
  function nearestMidi(freq){ return Math.round(69+12*Math.log2(freq/(Number(els.concertA.value)||440))); }
  function median(arr){ if(!arr.length)return null; const a=[...arr].sort((x,y)=>x-y),m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
  function logFreq(freq){ return 1200*Math.log2(freq); }
  function freqFromLog(v){ return Math.pow(2,v/1200); }
  function setQuality(text,kind=''){ els.quality.textContent=text; els.quality.className='quality'; if(kind)els.quality.classList.add(`${kind}-text`); }

  function currentSeq(){ return SEQUENCE[state.seqIndex]; }
  function currentLock(){ return state.locks[state.seqIndex]; }
  function sequenceCandidates(){
    const locked=currentLock();
    if(Number.isInteger(locked)) return [locked];
    const b=currentSeq().base;
    return [b-1,b,b+1];
  }
  function bestSequenceTarget(freq){
    let best=null;
    for(const midi of sequenceCandidates()){
      const cents=centsFromMidi(freq,midi);
      if(!best || Math.abs(cents)<Math.abs(best.cents)) best={midi,cents};
    }
    return best;
  }

  function renderSequence(){
    els.seqChips.innerHTML='';
    SEQUENCE.forEach((item,i)=>{
      const chip=document.createElement('button');
      chip.type='button';
      chip.className='seq-chip';
      if(i<state.seqIndex) chip.classList.add('done');
      if(i===state.seqIndex&&!state.finished) chip.classList.add('active');
      const lock=state.locks[i];
      chip.textContent=Number.isInteger(lock)?midiToLabel(lock):item.staff;
      chip.title=`Нота ${i+1}`;
      chip.addEventListener('click',()=>{ state.seqIndex=i; state.finished=false; resetTracking(); renderSequence(); updateTarget(); });
      els.seqChips.appendChild(chip);
    });
    els.seqCounter.textContent=state.finished?`${SEQUENCE.length} / ${SEQUENCE.length}`:`${state.seqIndex+1} / ${SEQUENCE.length}`;
    const lock=currentLock();
    els.seqTarget.textContent=state.finished?'Готово':(Number.isInteger(lock)?midiToLabel(lock):currentSeq().staff);
    els.seqLockState.textContent=state.finished?'тестовый фрагмент пройден':(Number.isInteger(lock)?'знак уже запомнен':'знак определится при первом чистом попадании');
    els.seqBack.disabled=state.seqIndex===0;
    els.seqMessage.textContent=state.finished?'Фрагмент пройден. Нажми «Сначала», чтобы повторить.':'';
  }

  function updateTarget(){
    if(state.sequenceMode){
      const lock=currentLock();
      if(state.finished){
        els.targetNote.textContent='✓'; els.targetFreq.textContent='фрагмент пройден'; els.targetFreqMini.textContent='готово'; return;
      }
      if(Number.isInteger(lock)){
        const f=midiToFreq(lock); els.targetNote.textContent=midiToLabel(lock); els.targetFreq.textContent=`${f.toFixed(1)} Гц`; els.targetFreqMini.textContent=`${state.seqIndex+1}/${SEQUENCE.length}`;
      } else {
        els.targetNote.textContent=currentSeq().staff; els.targetFreq.textContent='знак по партитуре'; els.targetFreqMini.textContent=`${state.seqIndex+1}/${SEQUENCE.length}`;
      }
      return;
    }
    const midi=selectedMidi(),f=midiToFreq(midi); els.targetNote.textContent=midiToLabel(midi); els.targetFreq.textContent=`${f.toFixed(1)} Гц`; els.targetFreqMini.textContent=`${f.toFixed(1)} Гц`;
  }

  function setMidi(midi){ midi=Math.max(36,Math.min(83,midi)); const pc=(midi%12+12)%12,oct=Math.floor(midi/12)-1; els.noteName.value=String(pc); els.octave.value=String(Math.max(2,Math.min(5,oct))); updateTarget(); resetTracking(); }
  function settingsUI(){ els.tolOut.textContent=`±${els.tolerance.value}¢`;els.holdOut.textContent=`${els.holdMs.value} мс`;els.aOut.textContent=`${els.concertA.value} Гц`;const p=Number(els.tolerance.value);els.goodZone.style.left=`${50-p}%`;els.goodZone.style.right=`${50-p}%`;updateTarget(); }
  function resetHold(){ state.stableSince=null;state.centsWindow=[];els.holdFill.style.width='0%'; }
  function resetTracking(){ resetHold(); state.pitchHistory=[]; state.pendingJump=null; state.lastStableLog=null; state.lastStableAt=0; state.rejectedFrames=0; state.waitingForChange=false;state.lastAcceptedFreq=null;state.silenceFrames=0; if(els.stabilityHint)els.stabilityHint.textContent=''; if(els.rawStat)els.rawStat.textContent='—'; if(els.stableStat)els.stableStat.textContent='—'; }
  function resetTuner(){ resetTracking();els.needle.style.left='50%';els.pitchReadout.textContent=state.micOn?'Слушаю…':'Микрофон выключен';setQuality('—');els.heardStat.textContent='—';els.confStat.textContent='—'; }
  function updateStats(){ els.acceptedStat.textContent=String(state.accepted); if(!state.centsSamples.length){els.avgStat.textContent='—';return;} const avg=state.centsSamples.reduce((s,x)=>s+Math.abs(x),0)/state.centsSamples.length;els.avgStat.textContent=`${avg.toFixed(1)}¢`; }

  // YIN pitch detector tuned for bowed strings.
  function detectPitchYIN(input,sampleRate){
    const n=input.length;
    let mean=0; for(let i=0;i<n;i++) mean+=input[i]; mean/=n;
    let rms=0; const x=new Float32Array(n);
    for(let i=0;i<n;i++){ const v=input[i]-mean; x[i]=v; rms+=v*v; }
    rms=Math.sqrt(rms/n);
    if(rms<0.0045) return {frequency:null,confidence:0,rms};
    const minFreq=55, maxFreq=1200;
    const minTau=Math.max(2,Math.floor(sampleRate/maxFreq));
    const maxTau=Math.min(Math.floor(sampleRate/minFreq), Math.floor(n/2)-2);
    const diff=new Float32Array(maxTau+2);
    const usable=n-maxTau-1;
    for(let tau=1;tau<=maxTau+1;tau++){
      let sum=0; for(let i=0;i<usable;i+=2){ const d=x[i]-x[i+tau]; sum+=d*d; } diff[tau]=sum;
    }
    const cmnd=new Float32Array(maxTau+2); cmnd[0]=1; let running=0;
    for(let tau=1;tau<=maxTau+1;tau++){ running+=diff[tau]; cmnd[tau]=running>0 ? diff[tau]*tau/running : 1; }
    let tau=-1; const threshold=0.18;
    for(let t=minTau;t<=maxTau;t++){ if(cmnd[t]<threshold){ while(t+1<=maxTau && cmnd[t+1]<cmnd[t]) t++; tau=t; break; } }
    if(tau<0){ let best=1; for(let t=minTau;t<=maxTau;t++) if(cmnd[t]<best){best=cmnd[t];tau=t;} if(tau<0 || best>0.38) return {frequency:null,confidence:Math.max(0,1-best),rms}; }
    let refined=tau;
    if(tau>minTau && tau<maxTau){ const a=cmnd[tau-1],b=cmnd[tau],c=cmnd[tau+1],den=a-2*b+c; if(Math.abs(den)>1e-9) refined=tau+0.5*(a-c)/den; }
    const frequency=sampleRate/refined,confidence=Math.max(0,Math.min(1,1-cmnd[tau]));
    if(!Number.isFinite(frequency)||frequency<55||frequency>1200) return {frequency:null,confidence,rms};
    return {frequency,confidence,rms};
  }

  function stabilizePitch(freq,confidence,now){
    if(!freq) return null;
    const rawLog=logFreq(freq); if(els.rawStat) els.rawStat.textContent=`${freq.toFixed(1)} Гц`;
    const histMed=median(state.pitchHistory);
    if(histMed!=null){
      const absJump=Math.abs(rawLog-histMed);
      if(absJump>420 && now-state.lastStableAt<420){
        const samePending=state.pendingJump && Math.abs(rawLog-state.pendingJump.log)<90;
        if(samePending){ state.pendingJump.count++; state.pendingJump.log=(state.pendingJump.log*0.7+rawLog*0.3); }
        else state.pendingJump={log:rawLog,count:1,started:now};
        if(state.pendingJump.count<4){ state.rejectedFrames++; if(els.stabilityHint) els.stabilityHint.textContent='Фильтрую краткий скачок/обертон…'; return {frequency:freqFromLog(histMed),confidence,filtered:true}; }
        state.pitchHistory=[]; state.pendingJump=null;
      } else state.pendingJump=null;
    }
    state.pitchHistory.push(rawLog); if(state.pitchHistory.length>7) state.pitchHistory.shift();
    const stableLog=median(state.pitchHistory); state.lastStableLog=stableLog; state.lastStableAt=now;
    const stableFreq=freqFromLog(stableLog); if(els.stableStat) els.stableStat.textContent=`${stableFreq.toFixed(1)} Гц`;
    if(els.stabilityHint) els.stabilityHint.textContent=state.rejectedFrames ? `Отфильтровано скачков: ${state.rejectedFrames}` : '';
    return {frequency:stableFreq,confidence,filtered:false};
  }

  function advanceSequence(resolvedMidi){
    if(!Number.isInteger(currentLock())){ state.locks[state.seqIndex]=resolvedMidi; saveLocks(); }
    if(state.seqIndex>=SEQUENCE.length-1){ state.finished=true; }
    else state.seqIndex++;
    renderSequence(); updateTarget(); resetHold();
  }

  function updatePitch(rawFreq,confidence,now){
    if(!rawFreq||confidence<.56){
      if(state.waitingForChange && !rawFreq){ state.silenceFrames++; if(state.silenceFrames>=2){ state.waitingForChange=false;state.silenceFrames=0; } }
      els.heardStat.textContent='—'; els.confStat.textContent=confidence?`${Math.round(confidence*100)}%`:'—'; els.pitchReadout.textContent='Жду устойчивый звук…'; setQuality('—'); resetHold(); return;
    }
    const stable=stabilizePitch(rawFreq,confidence,now); if(!stable) return;
    const freq=stable.frequency,heard=nearestMidi(freq);
    els.heardStat.textContent=`${midiToLabel(heard)} · ${freq.toFixed(1)} Гц`; els.confStat.textContent=`${Math.round(confidence*100)}%`;

    if(state.waitingForChange && state.lastAcceptedFreq){
      const moved=Math.abs(1200*Math.log2(freq/state.lastAcceptedFreq));
      if(moved>55){ state.waitingForChange=false; state.silenceFrames=0; resetHold(); }
      else { els.pitchReadout.textContent='Смени ноту…'; setQuality('Следующая нота','warn'); return; }
    }

    if(state.sequenceMode && state.finished){ els.pitchReadout.textContent='Фрагмент пройден';setQuality('✓','good');return; }

    let targetMidi,cents;
    if(state.sequenceMode){ const result=bestSequenceTarget(freq); targetMidi=result.midi;cents=result.cents; }
    else { targetMidi=selectedMidi();cents=centsFromMidi(freq,targetMidi); }

    const shown=Math.max(-50,Math.min(50,cents)); els.needle.style.left=`${50+shown}%`;
    if(Math.abs(cents)>700) els.pitchReadout.textContent=`Слышу ${midiToLabel(heard)}`;
    else els.pitchReadout.textContent=`${cents>=0?'+':''}${cents.toFixed(0)}¢`;

    const tol=Number(els.tolerance.value),hold=Number(els.holdMs.value);
    if(Math.abs(cents)<=tol){
      if(state.stableSince==null) state.stableSince=now;
      state.centsWindow.push(cents); if(state.centsWindow.length>9) state.centsWindow.shift();
      const med=median(state.centsWindow),elapsed=now-state.stableSince;
      els.holdFill.style.width=`${Math.min(100,elapsed/hold*100)}%`;
      setQuality(Math.abs(med)<=Math.min(10,tol*.6)?'Чисто':'Почти — удерживай','good');
      if(elapsed>=hold){
        state.accepted++;state.centsSamples.push(med);if(state.centsSamples.length>200)state.centsSamples.shift();updateStats();
        setQuality('Засчитано','good');
        const acceptedFreq=freq;
        if(state.sequenceMode){ advanceSequence(targetMidi); state.waitingForChange=!state.finished; state.lastAcceptedFreq=acceptedFreq; }
        else { resetHold(); state.waitingForChange=true;state.lastAcceptedFreq=acceptedFreq; }
      }
    } else { resetHold(); setQuality(state.sequenceMode?'Не эта нота':(cents<0?'Низко':'Высоко'),Math.abs(cents)>45?'bad':'warn'); }
  }

  function audioLoop(now){
    state.raf=requestAnimationFrame(audioLoop); if(!state.analyser||now-state.lastFrame<70) return; state.lastFrame=now;
    state.analyser.getFloatTimeDomainData(state.buffer); const p=detectPitchYIN(state.buffer,state.audioContext.sampleRate); updatePitch(p.frequency,p.confidence,now);
  }

  async function toggleMic(){
    if(state.micOn){stopMic();return;}
    try{
      if(!navigator.mediaDevices?.getUserMedia) throw new Error('Для микрофона нужен HTTPS — открой версию на GitHub Pages.');
      const constraints={audio:{echoCancellation:{ideal:false},noiseSuppression:{ideal:false},autoGainControl:{ideal:false},channelCount:{ideal:1}},video:false};
      state.stream=await navigator.mediaDevices.getUserMedia(constraints);
      state.audioContext=new (window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'}); await state.audioContext.resume();
      state.source=state.audioContext.createMediaStreamSource(state.stream);
      state.highpass=state.audioContext.createBiquadFilter(); state.highpass.type='highpass'; state.highpass.frequency.value=52; state.highpass.Q.value=.7;
      state.lowpass=state.audioContext.createBiquadFilter(); state.lowpass.type='lowpass'; state.lowpass.frequency.value=1400; state.lowpass.Q.value=.7;
      state.analyser=state.audioContext.createAnalyser(); state.analyser.fftSize=8192; state.analyser.smoothingTimeConstant=0;
      state.source.connect(state.highpass); state.highpass.connect(state.lowpass); state.lowpass.connect(state.analyser); state.buffer=new Float32Array(state.analyser.fftSize);
      state.micOn=true; els.micButton.textContent='Выключить микрофон'; els.micBadge.textContent='микрофон слушает'; els.micBadge.className='status-pill good';
      cancelAnimationFrame(state.raf); state.raf=requestAnimationFrame(audioLoop); resetTuner();
    }catch(err){ const msg=err?.name==='NotAllowedError'?'Нет доступа к микрофону. Разреши его для этого сайта в настройках Chrome.':(err.message||'Не удалось открыть микрофон.'); setQuality(msg,'bad'); els.micBadge.textContent='нет доступа'; els.micBadge.className='status-pill bad'; }
  }
  function stopMic(){
    state.micOn=false; cancelAnimationFrame(state.raf);state.raf=null;state.stream?.getTracks().forEach(t=>t.stop());state.audioContext?.close();
    state.stream=null;state.audioContext=null;state.analyser=null;state.source=null;state.highpass=null;state.lowpass=null;
    els.micButton.textContent='Включить микрофон';els.micBadge.textContent='микрофон выкл.';els.micBadge.className='status-pill';resetTuner();
  }

  function setSequenceMode(on){
    state.sequenceMode=on; resetTracking();
    els.manualPicker.classList.toggle('hidden',on); els.seqToggle.textContent=on?'Перейти в ручной тюнер':'Вернуться к фрагменту';
    els.pitchTitle.textContent=on?'Сыграй текущую ноту':'Сыграй выбранную ноту';
    els.targetDown.disabled=on;els.targetUp.disabled=on; updateTarget();
  }

  els.noteName.addEventListener('change',()=>{if(!state.sequenceMode){updateTarget();resetTracking();}});
  els.octave.addEventListener('change',()=>{if(!state.sequenceMode){updateTarget();resetTracking();}});
  els.targetDown.addEventListener('click',()=>{if(!state.sequenceMode)setMidi(selectedMidi()-1);});
  els.targetUp.addEventListener('click',()=>{if(!state.sequenceMode)setMidi(selectedMidi()+1);});
  els.micButton.addEventListener('click',toggleMic);
  [els.tolerance,els.holdMs,els.concertA].forEach(el=>el.addEventListener('input',()=>{settingsUI();resetTracking();}));
  els.seqBack.addEventListener('click',()=>{if(state.seqIndex>0){state.seqIndex--;state.finished=false;resetTracking();renderSequence();updateTarget();}});
  els.seqSkip.addEventListener('click',()=>{if(state.finished)return;if(state.seqIndex>=SEQUENCE.length-1)state.finished=true;else state.seqIndex++;resetTracking();renderSequence();updateTarget();});
  els.seqRestart.addEventListener('click',()=>{state.seqIndex=0;state.finished=false;resetTracking();renderSequence();updateTarget();});
  els.seqToggle.addEventListener('click',()=>setSequenceMode(!state.sequenceMode));
  els.seqClearLocks.addEventListener('click',()=>{if(confirm('Сбросить запомненные знаки для тестового фрагмента?')){state.locks=SEQUENCE.map(()=>null);saveLocks();state.seqIndex=0;state.finished=false;resetTracking();renderSequence();updateTarget();}});
  window.addEventListener('pagehide',()=>{if(state.micOn)stopMic();});
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredInstall=e;els.installButton.classList.remove('hidden');els.installHelp.textContent='Можно установить приложение на главный экран одной кнопкой.';});
  els.installButton.addEventListener('click',async()=>{if(!state.deferredInstall)return;state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;els.installButton.classList.add('hidden');});

  setPage(1);renderSequence();setSequenceMode(true);settingsUI();updateStats();
  if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
