(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const els = {
    micBadge:$('micBadge'), photoSetup:$('photoSetup'), photoCount:$('photoCount'), page1Input:$('page1Input'), page2Input:$('page2Input'), page1State:$('page1State'), page2State:$('page2State'), clearPhotos:$('clearPhotos'),
    scoreCanvas:$('scoreCanvas'), scoreEmpty:$('scoreEmpty'), canvasWrap:$('canvasWrap'), lineTitle:$('lineTitle'), lineStatus:$('lineStatus'), prevLine:$('prevLine'), nextLine:$('nextLine'), practiceTab:$('practiceTab'), teachTab:$('teachTab'), practicePanel:$('practicePanel'), teachPanel:$('teachPanel'),
    targetNote:$('targetNote'), targetFreq:$('targetFreq'), noteProgress:$('noteProgress'), needle:$('needle'), goodZone:$('goodZone'), pitchReadout:$('pitchReadout'), quality:$('quality'), holdFill:$('holdFill'),
    micButton:$('micButton'), prevNote:$('prevNote'), skipNote:$('skipNote'), nextNote:$('nextNote'), tolerance:$('tolerance'), tolOut:$('tolOut'), holdMs:$('holdMs'), holdOut:$('holdOut'), concertA:$('concertA'), aOut:$('aOut'),
    heardStat:$('heardStat'), confStat:$('confStat'), acceptedStat:$('acceptedStat'), avgStat:$('avgStat'), biasStat:$('biasStat'), flatCurrent:$('flatCurrent'), sharpCurrent:$('sharpCurrent'), octDownCurrent:$('octDownCurrent'), octUpCurrent:$('octUpCurrent'),
    teachMic:$('teachMic'), recordTeach:$('recordTeach'), teachMessage:$('teachMessage'), capturedNotes:$('capturedNotes'), flatTeach:$('flatTeach'), sharpTeach:$('sharpTeach'), octDownTeach:$('octDownTeach'), octUpTeach:$('octUpTeach'), undoTeach:$('undoTeach'), clearTeach:$('clearTeach'), finishTeach:$('finishTeach'),
    exportData:$('exportData'), importData:$('importData'), resetAll:$('resetAll'), installButton:$('installButton'), installHelp:$('installHelp')
  };

  const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const STORAGE_KEY = 'celloCoachGoltermannV03';
  const OLD_STORAGE_KEY = 'celloCoachGoltermannV02';
  const DB_NAME = 'celloCoachLocalPhotos';
  const DB_STORE = 'photos';

  // Positions measured on the two supplied pages, normalized to page height.
  const BASE_H = 2048;
  const LINE_DEFS = [
    ...[307,515,736,943,1138,1330,1513,1694].map((top,i)=>({page:0, top:top/BASE_H, spacing:[16,15,16,15,15,15,15,15][i]/BASE_H})),
    ...[273,462,653,820,969,1142,1295,1479,1666].map((top,i)=>({page:1, top:top/BASE_H, spacing:[13,13,13,12,12,12,13,13,13][i]/BASE_H}))
  ];

  const state = {
    images:[null,null], imageUrls:[null,null], lineIndex:0, noteIndex:0, selectedTeachIndex:-1, lineData:{}, mode:'practice',
    audioContext:null, analyser:null, source:null, stream:null, buffer:null, raf:null, micOn:false, lastFrame:0,
    stableSince:null, centsWindow:[], releaseNeeded:false, silenceSince:null,
    teachRecording:false, teachStableMidi:null, teachStableSince:null, teachLastCaptured:null, teachRelease:true,
    accepted:0, centsSamples:[], sharpCount:0, flatCount:0, deferredInstall:null
  };

  function loadData(){
    try{
      let raw=localStorage.getItem(STORAGE_KEY);
      if(!raw){ raw=localStorage.getItem(OLD_STORAGE_KEY); }
      if(raw){ const parsed=JSON.parse(raw); state.lineData=parsed?.lines||{}; if(parsed?.settings){ applySettings(parsed.settings); } }
    }catch(_){ }
  }
  function applySettings(s){
    if(Number.isFinite(Number(s.tolerance))) els.tolerance.value=String(Math.max(8,Math.min(40,Number(s.tolerance))));
    if(Number.isFinite(Number(s.holdMs))) els.holdMs.value=String(Math.max(80,Math.min(500,Number(s.holdMs))));
    if(Number.isFinite(Number(s.concertA))) els.concertA.value=String(Math.max(430,Math.min(445,Number(s.concertA))));
  }
  function saveData(){
    const payload={version:3,piece:'Goltermann — Schlechtes Wetter / В непогоду',lines:state.lineData,settings:{tolerance:Number(els.tolerance.value),holdMs:Number(els.holdMs.value),concertA:Number(els.concertA.value)}};
    localStorage.setItem(STORAGE_KEY,JSON.stringify(payload));
    updateLineUI();
  }

  function openDb(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME,1);
      req.onupgradeneeded=()=>{ if(!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE); };
      req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error);
    });
  }
  async function idbPut(key,value){ const db=await openDb(); return new Promise((resolve,reject)=>{ const tx=db.transaction(DB_STORE,'readwrite'); tx.objectStore(DB_STORE).put(value,key); tx.oncomplete=()=>{db.close();resolve();}; tx.onerror=()=>{db.close();reject(tx.error);}; }); }
  async function idbGet(key){ const db=await openDb(); return new Promise((resolve,reject)=>{ const tx=db.transaction(DB_STORE,'readonly'); const req=tx.objectStore(DB_STORE).get(key); req.onsuccess=()=>resolve(req.result||null); req.onerror=()=>reject(req.error); tx.oncomplete=()=>db.close(); }); }
  async function idbDelete(key){ const db=await openDb(); return new Promise((resolve,reject)=>{ const tx=db.transaction(DB_STORE,'readwrite'); tx.objectStore(DB_STORE).delete(key); tx.oncomplete=()=>{db.close();resolve();}; tx.onerror=()=>{db.close();reject(tx.error);}; }); }

  function loadImageFromBlob(blob,index){
    return new Promise((resolve,reject)=>{
      if(state.imageUrls[index]) URL.revokeObjectURL(state.imageUrls[index]);
      const url=URL.createObjectURL(blob); state.imageUrls[index]=url;
      const img=new Image();
      img.onload=()=>{state.images[index]=img;resolve(img);}; img.onerror=reject; img.src=url;
    });
  }
  async function restorePhotos(){
    for(let i=0;i<2;i++){
      try{ const blob=await idbGet(`page${i+1}`); if(blob) await loadImageFromBlob(blob,i); }catch(_){ }
    }
    updatePhotoUI(); renderScoreLine();
  }
  async function handlePhoto(file,index){
    if(!file) return;
    if(!file.type.startsWith('image/')){ alert('Нужна фотография или изображение.'); return; }
    try{
      await idbPut(`page${index+1}`,file);
      await loadImageFromBlob(file,index);
      updatePhotoUI(); renderScoreLine();
    }catch(e){ alert(`Не удалось сохранить фото: ${e.message||e}`); }
  }
  async function clearPhotos(){
    if(!confirm('Удалить обе фотографии из памяти этого браузера? Разметка нот останется.')) return;
    await Promise.all([idbDelete('page1'),idbDelete('page2')]);
    for(let i=0;i<2;i++){ if(state.imageUrls[i]) URL.revokeObjectURL(state.imageUrls[i]); state.imageUrls[i]=null; state.images[i]=null; }
    els.page1Input.value=''; els.page2Input.value=''; updatePhotoUI(); renderScoreLine();
  }
  function updatePhotoUI(){
    const count=state.images.filter(Boolean).length;
    els.photoCount.textContent=`${count} / 2`;
    els.page1State.textContent=state.images[0]?'сохранена на устройстве':'выбрать из галереи';
    els.page2State.textContent=state.images[1]?'сохранена на устройстве':'выбрать из галереи';
    els.photoSetup.classList.toggle('complete',count===2);
    updateLineUI();
  }

  function getLineNotes(){ return state.lineData[state.lineIndex]||[]; }
  function midiToFreq(midi){ const a=Number(els.concertA.value)||440; return a*Math.pow(2,(midi-69)/12); }
  function midiToLabel(midi){ return `${NOTE_NAMES[(midi%12+12)%12]}${Math.floor(midi/12)-1}`; }
  function freqToMidi(freq){ return 69+12*Math.log2(freq/(Number(els.concertA.value)||440)); }
  function nearestMidi(freq){ return Math.round(freqToMidi(freq)); }
  function centsFromMidi(freq,midi){ return 1200*Math.log2(freq/midiToFreq(midi)); }
  function median(arr){ if(!arr.length)return null; const a=[...arr].sort((x,y)=>x-y),m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }

  function setQuality(text,kind=''){
    els.quality.textContent=text; els.quality.className='quality';
    if(kind==='good')els.quality.classList.add('good-text'); if(kind==='warn')els.quality.classList.add('warn-text'); if(kind==='bad')els.quality.classList.add('bad-text');
  }
  function settingsUI(){
    els.tolOut.textContent=`±${els.tolerance.value}¢`; els.holdOut.textContent=`${els.holdMs.value} мс`; els.aOut.textContent=`${els.concertA.value} Гц`;
    const pct=Math.max(8,Math.min(40,Number(els.tolerance.value))); els.goodZone.style.left=`${50-pct}%`; els.goodZone.style.right=`${50-pct}%`;
    saveData(); updateTarget();
  }

  function cropForLine(def,img){
    const topPx=def.top*img.naturalHeight, sp=def.spacing*img.naturalHeight;
    const y=Math.max(0,topPx-sp*4.8), bottom=Math.min(img.naturalHeight,topPx+sp*6.5);
    const side=Math.max(12,img.naturalWidth*.017);
    return{x:side,y,w:img.naturalWidth-side*2,h:bottom-y};
  }
  function renderScoreLine(){
    const def=LINE_DEFS[state.lineIndex],img=state.images[def.page],canvas=els.scoreCanvas;
    if(!img){ canvas.width=1;canvas.height=1;canvas.style.width='1px';canvas.style.height='1px';els.scoreEmpty.classList.remove('hidden');return; }
    els.scoreEmpty.classList.add('hidden');
    const crop=cropForLine(def,img),wrapW=Math.max(300,els.canvasWrap.clientWidth||360);
    // Keep notes readable on a phone; the container scrolls horizontally.
    const cssW=Math.max(wrapW,Math.min(980,wrapW<600?900:wrapW));
    const cssH=Math.max(160,Math.min(260,cssW*(crop.h/crop.w)));
    const dpr=Math.min(2,window.devicePixelRatio||1);
    canvas.style.width=`${cssW}px`;canvas.style.height=`${cssH}px`;canvas.width=Math.round(cssW*dpr);canvas.height=Math.round(cssH*dpr);
    const ctx=canvas.getContext('2d');ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,cssW,cssH);ctx.fillStyle='#eee9df';ctx.fillRect(0,0,cssW,cssH);ctx.drawImage(img,crop.x,crop.y,crop.w,crop.h,0,0,cssW,cssH);
    const notes=getLineNotes();
    if(notes.length&&state.mode==='practice'&&state.noteIndex<notes.length){
      const x=notes.length===1?cssW*.5:cssW*(.055+.89*(state.noteIndex/(notes.length-1)));
      ctx.save();ctx.strokeStyle='#9d6427';ctx.fillStyle='rgba(215,167,106,.22)';ctx.lineWidth=2;ctx.beginPath();
      if(ctx.roundRect)ctx.roundRect(Math.max(1,x-18),4,36,cssH-8,8);else ctx.rect(Math.max(1,x-18),4,36,cssH-8);
      ctx.fill();ctx.stroke();ctx.restore();
      requestAnimationFrame(()=>centerMarker(x,cssW));
    }
  }
  function centerMarker(x,canvasW){
    const wrap=els.canvasWrap,desired=Math.max(0,Math.min(canvasW-wrap.clientWidth,x-wrap.clientWidth*.5));
    try{wrap.scrollTo({left:desired,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}catch(_){wrap.scrollLeft=desired;}
  }

  function updateLineUI(){
    const notes=getLineNotes(),def=LINE_DEFS[state.lineIndex],hasPhoto=!!state.images[def.page];
    els.lineTitle.textContent=`Строка ${state.lineIndex+1} из ${LINE_DEFS.length}`;
    els.lineStatus.textContent=!hasPhoto?`нужна стр. ${def.page+1}`:notes.length?`${notes.length} нот · стр. ${def.page+1}`:`не обучена · стр. ${def.page+1}`;
    els.prevLine.disabled=state.lineIndex===0;els.nextLine.disabled=state.lineIndex===LINE_DEFS.length-1;
    renderScoreLine();updateTarget();renderCaptured();
  }
  function changeLine(delta){ state.lineIndex=Math.max(0,Math.min(LINE_DEFS.length-1,state.lineIndex+delta));state.noteIndex=0;state.selectedTeachIndex=-1;state.releaseNeeded=false;resetTuner();updateLineUI(); }
  function setMode(mode){
    state.mode=mode;const teach=mode==='teach';els.teachPanel.classList.toggle('hidden',!teach);els.practicePanel.classList.toggle('hidden',teach);els.practiceTab.classList.toggle('active',!teach);els.teachTab.classList.toggle('active',teach);state.selectedTeachIndex=-1;renderCaptured();renderScoreLine();
  }

  function resetTuner(){
    state.stableSince=null;state.centsWindow=[];els.needle.style.left='50%';els.needle.style.background='var(--accent2)';els.holdFill.style.width='0%';els.pitchReadout.textContent=state.micOn?'Жду звук…':'Микрофон выключен';els.heardStat.textContent='—';els.confStat.textContent='—';setQuality('—');
  }
  function updateTarget(){
    const notes=getLineNotes(),midi=notes[state.noteIndex];
    if(!notes.length){els.targetNote.textContent='—';els.targetFreq.textContent='Сначала обучи эту строку';els.noteProgress.textContent='0 / 0';return;}
    if(midi==null){els.targetNote.textContent='✓';els.targetFreq.textContent='Строка закончена';els.noteProgress.textContent=`${notes.length} / ${notes.length}`;return;}
    els.targetNote.textContent=midiToLabel(midi);els.targetFreq.textContent=`${midiToFreq(midi).toFixed(1)} Гц`;els.noteProgress.textContent=`${state.noteIndex+1} / ${notes.length}`;
  }
  function advanceNote(countAccepted=true){
    const notes=getLineNotes();if(state.noteIndex>=notes.length)return;const cur=notes[state.noteIndex];state.noteIndex++;if(countAccepted)state.accepted++;
    state.stableSince=null;state.centsWindow=[];els.holdFill.style.width='0%';const next=notes[state.noteIndex];state.releaseNeeded=next!=null&&next===cur;state.silenceSince=null;updateTarget();renderScoreLine();updateStats();if(state.noteIndex>=notes.length)setQuality('Строка закончена','good');
  }
  function prevNote(){if(state.noteIndex>0){state.noteIndex--;state.releaseNeeded=false;resetTuner();updateTarget();renderScoreLine();}}
  function editCurrent(delta){const notes=getLineNotes();if(!notes.length||state.noteIndex>=notes.length)return;notes[state.noteIndex]+=delta;state.lineData[state.lineIndex]=notes;saveData();updateTarget();renderCaptured();}
  function editTeach(delta){const notes=getLineNotes();if(!notes.length)return;let i=state.selectedTeachIndex;if(i<0||i>=notes.length)i=notes.length-1;notes[i]+=delta;state.lineData[state.lineIndex]=notes;state.selectedTeachIndex=i;saveData();renderCaptured();}

  function normalizeToExpected(freq,targetMidi){
    const target=midiToFreq(targetMidi);let best=freq,bestErr=Math.abs(1200*Math.log2(freq/target));
    for(const factor of [0.5,2]){const f=freq*factor,e=Math.abs(1200*Math.log2(f/target));if(e<bestErr){best=f;bestErr=e;}}
    return best;
  }
  function updatePracticePitch(rawFreq,confidence,now){
    const notes=getLineNotes(),midi=notes[state.noteIndex];if(midi==null)return;
    els.confStat.textContent=`${Math.round((confidence||0)*100)}%`;
    if(!rawFreq||confidence<.45){
      if(!state.silenceSince)state.silenceSince=now;if(state.releaseNeeded&&now-state.silenceSince>80)state.releaseNeeded=false;state.stableSince=null;state.centsWindow=[];els.holdFill.style.width='0%';els.pitchReadout.textContent='Жду устойчивый звук…';els.heardStat.textContent='—';return;
    }
    state.silenceSince=null;const freq=normalizeToExpected(rawFreq,midi);let cents=centsFromMidi(freq,midi);state.centsWindow.push(cents);if(state.centsWindow.length>5)state.centsWindow.shift();cents=median(state.centsWindow)??cents;
    const clamped=Math.max(-50,Math.min(50,cents));els.needle.style.left=`${50+clamped}%`;els.heardStat.textContent=`${midiToLabel(nearestMidi(freq))} · ${freq.toFixed(1)} Гц`;els.pitchReadout.textContent=`${cents>=0?'+':''}${cents.toFixed(0)}¢`;
    if(state.releaseNeeded){els.holdFill.style.width='0%';setQuality('Переатакуй повторную ноту','warn');if(Math.abs(cents)>45)state.releaseNeeded=false;return;}
    const good=Math.abs(cents)<=Number(els.tolerance.value);
    if(good){
      els.needle.style.background='var(--good)';if(state.stableSince==null)state.stableSince=now;const held=now-state.stableSince;els.holdFill.style.width=`${Math.min(100,100*held/Number(els.holdMs.value))}%`;setQuality('Чисто — держи','good');state.centsSamples.push(cents);if(cents>2)state.sharpCount++;if(cents<-2)state.flatCount++;if(held>=Number(els.holdMs.value))advanceNote(true);
    }else{els.needle.style.background='var(--bad)';state.stableSince=null;els.holdFill.style.width='0%';setQuality(cents<0?'Низко — чуть выше':'Высоко — чуть ниже',cents<0?'warn':'bad');}
    updateStats();
  }
  function updateTeachPitch(freq,confidence,now){
    els.confStat.textContent=`${Math.round((confidence||0)*100)}%`;
    if(!state.teachRecording||!freq||confidence<.50){state.teachStableMidi=null;state.teachStableSince=null;if(!freq)state.teachRelease=true;return;}
    const mf=freqToMidi(freq),midi=Math.round(mf),cents=(mf-midi)*100;els.heardStat.textContent=`${midiToLabel(midi)} · ${cents>=0?'+':''}${cents.toFixed(0)}¢`;
    if(Math.abs(cents)>38){state.teachStableMidi=null;state.teachStableSince=null;return;}
    if(state.teachStableMidi!==midi){state.teachStableMidi=midi;state.teachStableSince=now;}
    if(state.teachStableSince!=null&&now-state.teachStableSince>230){
      const canRepeat=state.teachLastCaptured!==midi||state.teachRelease;
      if(canRepeat){const notes=getLineNotes();notes.push(midi);state.lineData[state.lineIndex]=notes;state.teachLastCaptured=midi;state.teachRelease=false;state.teachStableSince=now+100000;state.selectedTeachIndex=notes.length-1;saveData();renderCaptured();renderScoreLine();els.teachMessage.textContent=`Записано ${notes.length} нот. Продолжай медленно.`;}
    }
    if(state.teachLastCaptured!=null&&midi!==state.teachLastCaptured)state.teachRelease=true;
  }
  function updateStats(){
    els.acceptedStat.textContent=String(state.accepted);if(!state.centsSamples.length){els.avgStat.textContent='—';els.biasStat.textContent='—';return;}
    const avgAbs=state.centsSamples.reduce((s,x)=>s+Math.abs(x),0)/state.centsSamples.length;els.avgStat.textContent=`${avgAbs.toFixed(1)}¢`;const avg=state.centsSamples.reduce((s,x)=>s+x,0)/state.centsSamples.length;els.biasStat.textContent=Math.abs(avg)<3?'ровно':avg>0?'чаще высоко':'чаще низко';
  }

  // Lightweight normalized autocorrelation tuned for cello fundamentals on mobile.
  function detectPitch(buffer,sampleRate){
    let mean=0;for(let i=0;i<buffer.length;i++)mean+=buffer[i];mean/=buffer.length;
    let rms=0;for(let i=0;i<buffer.length;i++){buffer[i]-=mean;rms+=buffer[i]*buffer[i];}rms=Math.sqrt(rms/buffer.length);if(rms<.006)return{frequency:null,confidence:0};
    const minFreq=60,maxFreq=1100,minLag=Math.floor(sampleRate/maxFreq),maxLag=Math.min(buffer.length-2,Math.ceil(sampleRate/minFreq));let bestLag=-1,best=-1;const corr=new Float32Array(maxLag+1);
    for(let lag=minLag;lag<=maxLag;lag++){
      let sum=0,e1=0,e2=0,n=buffer.length-lag;for(let i=0;i<n;i+=2){const a=buffer[i],b=buffer[i+lag];sum+=a*b;e1+=a*a;e2+=b*b;}const c=sum/(Math.sqrt(e1*e2)+1e-12);corr[lag]=c;if(c>best){best=c;bestLag=lag;}
    }
    if(bestLag<0||best<.40)return{frequency:null,confidence:Math.max(0,best)};
    let lag=bestLag;if(bestLag>minLag&&bestLag<maxLag){const y1=corr[bestLag-1],y2=corr[bestLag],y3=corr[bestLag+1],d=y1-2*y2+y3;if(Math.abs(d)>1e-8)lag+=.5*(y1-y3)/d;}
    return{frequency:sampleRate/lag,confidence:best};
  }
  function audioLoop(now){
    state.raf=requestAnimationFrame(audioLoop);if(!state.analyser||now-state.lastFrame<70)return;state.lastFrame=now;state.analyser.getFloatTimeDomainData(state.buffer);const p=detectPitch(state.buffer,state.audioContext.sampleRate);if(state.mode==='teach')updateTeachPitch(p.frequency,p.confidence,now);else updatePracticePitch(p.frequency,p.confidence,now);
  }
  async function toggleMic(){
    if(state.micOn){stopMic();return;}
    try{
      if(!navigator.mediaDevices?.getUserMedia)throw new Error('Для микрофона открой приложение по HTTPS (GitHub Pages), а не как локальный файл.');
      const constraints={audio:{echoCancellation:{ideal:false},noiseSuppression:{ideal:false},autoGainControl:{ideal:false},channelCount:{ideal:1}},video:false};
      state.stream=await navigator.mediaDevices.getUserMedia(constraints);
      state.audioContext=new (window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'});await state.audioContext.resume();state.source=state.audioContext.createMediaStreamSource(state.stream);state.analyser=state.audioContext.createAnalyser();state.analyser.fftSize=2048;state.analyser.smoothingTimeConstant=0;state.source.connect(state.analyser);state.buffer=new Float32Array(state.analyser.fftSize);state.micOn=true;
      els.micButton.textContent='Выключить микрофон';els.teachMic.textContent='Выключить микрофон';els.micBadge.textContent='микрофон слушает';els.micBadge.className='status-pill good';cancelAnimationFrame(state.raf);state.raf=requestAnimationFrame(audioLoop);resetTuner();
    }catch(err){const msg=err?.name==='NotAllowedError'?'Нет доступа к микрофону. Разреши его для этого сайта в настройках браузера.':(err.message||'Не удалось открыть микрофон.');setQuality(msg,'bad');els.teachMessage.textContent=msg;els.micBadge.textContent='нет доступа';els.micBadge.className='status-pill bad';}
  }
  function stopMic(){
    state.micOn=false;cancelAnimationFrame(state.raf);state.raf=null;state.stream?.getTracks().forEach(t=>t.stop());state.audioContext?.close();state.stream=null;state.audioContext=null;state.analyser=null;state.source=null;els.micButton.textContent='Включить микрофон';els.teachMic.textContent='Включить микрофон';els.micBadge.textContent='микрофон выкл.';els.micBadge.className='status-pill';resetTuner();
  }

  function renderCaptured(){
    const notes=getLineNotes();els.capturedNotes.innerHTML='';notes.forEach((m,i)=>{const b=document.createElement('button');b.type='button';b.className='chip'+(i===state.selectedTeachIndex?' selected':'');b.textContent=`${i+1}. ${midiToLabel(m)}`;b.addEventListener('click',()=>{state.selectedTeachIndex=i;renderCaptured();});els.capturedNotes.appendChild(b);});if(!notes.length)els.teachMessage.textContent='Записанных нот пока нет.';
  }
  function toggleTeachRecord(){
    if(!state.micOn){els.teachMessage.textContent='Сначала включи микрофон.';return;}state.teachRecording=!state.teachRecording;state.teachStableMidi=null;state.teachStableSince=null;state.teachLastCaptured=getLineNotes().at(-1)??null;state.teachRelease=true;els.recordTeach.textContent=state.teachRecording?'Остановить запись':'Продолжить запись';els.recordTeach.classList.toggle('primary',state.teachRecording);els.teachMessage.textContent=state.teachRecording?'Слушаю. Играй по одной ноте, медленно.':`Запись остановлена. Нот: ${getLineNotes().length}.`;
  }
  function finishTeach(){state.teachRecording=false;els.recordTeach.textContent='Продолжить запись';saveData();state.noteIndex=0;state.selectedTeachIndex=-1;setMode('practice');resetTuner();updateTarget();renderScoreLine();}

  function exportData(){
    const payload=JSON.stringify({version:3,piece:'Goltermann — В непогоду',created:new Date().toISOString(),lines:state.lineData,settings:{tolerance:Number(els.tolerance.value),holdMs:Number(els.holdMs.value),concertA:Number(els.concertA.value)}},null,2);const blob=new Blob([payload],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download='cello-coach-goltermann-map.json';document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},500);
  }
  async function importData(file){
    if(!file)return;try{const parsed=JSON.parse(await file.text());if(!parsed.lines||typeof parsed.lines!=='object')throw new Error('В JSON нет разметки lines.');state.lineData=parsed.lines;if(parsed.settings)applySettings(parsed.settings);saveData();settingsUI();state.noteIndex=0;updateLineUI();}catch(e){alert(`Не удалось импортировать: ${e.message}`);}
  }

  els.page1Input.addEventListener('change',e=>handlePhoto(e.target.files?.[0],0));els.page2Input.addEventListener('change',e=>handlePhoto(e.target.files?.[0],1));els.clearPhotos.addEventListener('click',clearPhotos);
  els.prevLine.addEventListener('click',()=>changeLine(-1));els.nextLine.addEventListener('click',()=>changeLine(1));els.practiceTab.addEventListener('click',()=>setMode('practice'));els.teachTab.addEventListener('click',()=>setMode('teach'));
  els.micButton.addEventListener('click',toggleMic);els.teachMic.addEventListener('click',toggleMic);els.prevNote.addEventListener('click',prevNote);els.skipNote.addEventListener('click',()=>advanceNote(false));els.nextNote.addEventListener('click',()=>advanceNote(false));
  els.flatCurrent.addEventListener('click',()=>editCurrent(-1));els.sharpCurrent.addEventListener('click',()=>editCurrent(1));els.octDownCurrent.addEventListener('click',()=>editCurrent(-12));els.octUpCurrent.addEventListener('click',()=>editCurrent(12));
  els.recordTeach.addEventListener('click',toggleTeachRecord);els.flatTeach.addEventListener('click',()=>editTeach(-1));els.sharpTeach.addEventListener('click',()=>editTeach(1));els.octDownTeach.addEventListener('click',()=>editTeach(-12));els.octUpTeach.addEventListener('click',()=>editTeach(12));
  els.undoTeach.addEventListener('click',()=>{const n=getLineNotes();n.pop();state.lineData[state.lineIndex]=n;state.selectedTeachIndex=n.length-1;saveData();renderCaptured();renderScoreLine();});
  els.clearTeach.addEventListener('click',()=>{if(confirm('Очистить разметку этой строки?')){state.lineData[state.lineIndex]=[];state.noteIndex=0;state.selectedTeachIndex=-1;saveData();renderCaptured();renderScoreLine();updateTarget();}});els.finishTeach.addEventListener('click',finishTeach);
  [els.tolerance,els.holdMs,els.concertA].forEach(el=>el.addEventListener('input',settingsUI));els.exportData.addEventListener('click',exportData);els.importData.addEventListener('change',e=>importData(e.target.files?.[0]));els.resetAll.addEventListener('click',()=>{if(confirm('Стереть разметку всех 17 строк?')){state.lineData={};state.noteIndex=0;state.selectedTeachIndex=-1;saveData();updateLineUI();}});
  window.addEventListener('resize',()=>requestAnimationFrame(renderScoreLine));window.addEventListener('pagehide',()=>{if(state.micOn)stopMic();});

  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredInstall=e;els.installButton.classList.remove('hidden');els.installHelp.textContent='Можно установить приложение на главный экран одной кнопкой.';});
  els.installButton.addEventListener('click',async()=>{if(!state.deferredInstall)return;state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;els.installButton.classList.add('hidden');});

  loadData();settingsUI();updateStats();updatePhotoUI();restorePhotos();
  if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
