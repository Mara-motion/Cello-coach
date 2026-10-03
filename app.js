(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const SCORE_URL = 'https://thecellist.ru/wp-content/uploads/2020/04/cp-Goltermann-G.-Stormy-Weather.pdf';
  const NOTE_NAMES = ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'];
  const els = {
    micBadge:$('micBadge'), scoreFrame:$('scoreFrame'), openScore:$('openScore'), pageBadge:$('pageBadge'),
    noteName:$('noteName'), octave:$('octave'), targetDown:$('targetDown'), targetUp:$('targetUp'), targetNote:$('targetNote'), targetFreq:$('targetFreq'), targetFreqMini:$('targetFreqMini'),
    needle:$('needle'), goodZone:$('goodZone'), pitchReadout:$('pitchReadout'), quality:$('quality'), holdFill:$('holdFill'), micButton:$('micButton'),
    tolerance:$('tolerance'),tolOut:$('tolOut'),holdMs:$('holdMs'),holdOut:$('holdOut'),concertA:$('concertA'),aOut:$('aOut'),heardStat:$('heardStat'),confStat:$('confStat'),acceptedStat:$('acceptedStat'),avgStat:$('avgStat'),installButton:$('installButton'),installHelp:$('installHelp')
  };
  const state={page:1,audioContext:null,analyser:null,source:null,stream:null,buffer:null,raf:null,micOn:false,lastFrame:0,stableSince:null,centsWindow:[],accepted:0,centsSamples:[],deferredInstall:null};

  function pageUrl(page){ return `${SCORE_URL}#page=${page}&zoom=page-width&toolbar=0&navpanes=0`; }
  function setPage(page){ state.page=Math.max(1,Math.min(3,page)); els.scoreFrame.src=pageUrl(state.page); els.openScore.href=pageUrl(state.page); els.pageBadge.textContent=`стр. ${state.page}`; document.querySelectorAll('.page-btn').forEach(b=>b.classList.toggle('active',Number(b.dataset.page)===state.page)); }
  document.querySelectorAll('.page-btn').forEach(b=>b.addEventListener('click',()=>setPage(Number(b.dataset.page))));

  function selectedMidi(){ return (Number(els.octave.value)+1)*12 + Number(els.noteName.value); }
  function setMidi(midi){ midi=Math.max(36,Math.min(83,midi)); const pc=(midi%12+12)%12,oct=Math.floor(midi/12)-1; els.noteName.value=String(pc); els.octave.value=String(Math.max(2,Math.min(5,oct))); updateTarget(); resetHold(); }
  function midiToFreq(midi){ const a=Number(els.concertA.value)||440; return a*Math.pow(2,(midi-69)/12); }
  function midiToLabel(midi){ return `${NOTE_NAMES[(midi%12+12)%12]}${Math.floor(midi/12)-1}`; }
  function centsFromMidi(freq,midi){ return 1200*Math.log2(freq/midiToFreq(midi)); }
  function nearestMidi(freq){ return Math.round(69+12*Math.log2(freq/(Number(els.concertA.value)||440))); }
  function median(arr){ if(!arr.length)return null; const a=[...arr].sort((x,y)=>x-y),m=Math.floor(a.length/2); return a.length%2?a[m]:(a[m-1]+a[m])/2; }
  function setQuality(text,kind=''){ els.quality.textContent=text; els.quality.className='quality'; if(kind)els.quality.classList.add(`${kind}-text`); }
  function updateTarget(){ const midi=selectedMidi(),f=midiToFreq(midi); els.targetNote.textContent=midiToLabel(midi); els.targetFreq.textContent=`${f.toFixed(1)} Гц`; els.targetFreqMini.textContent=`${f.toFixed(1)} Гц`; }
  function settingsUI(){ els.tolOut.textContent=`±${els.tolerance.value}¢`;els.holdOut.textContent=`${els.holdMs.value} мс`;els.aOut.textContent=`${els.concertA.value} Гц`;const p=Number(els.tolerance.value);els.goodZone.style.left=`${50-p}%`;els.goodZone.style.right=`${50-p}%`;updateTarget(); }
  function resetHold(){ state.stableSince=null;state.centsWindow=[];els.holdFill.style.width='0%'; }
  function resetTuner(){ resetHold();els.needle.style.left='50%';els.pitchReadout.textContent=state.micOn?'Слушаю…':'Микрофон выключен';setQuality('—');els.heardStat.textContent='—';els.confStat.textContent='—'; }
  function updateStats(){ els.acceptedStat.textContent=String(state.accepted); if(!state.centsSamples.length){els.avgStat.textContent='—';return;} const avg=state.centsSamples.reduce((s,x)=>s+Math.abs(x),0)/state.centsSamples.length;els.avgStat.textContent=`${avg.toFixed(1)}¢`; }

  function updatePitch(freq,confidence,now){
    if(!freq||confidence<.42){els.heardStat.textContent='—';els.confStat.textContent=confidence?`${Math.round(confidence*100)}%`:'—';els.pitchReadout.textContent='Жду устойчивый звук…';setQuality('—');resetHold();return;}
    const heard=nearestMidi(freq),target=selectedMidi(),cents=centsFromMidi(freq,target);els.heardStat.textContent=`${midiToLabel(heard)} · ${freq.toFixed(1)} Гц`;els.confStat.textContent=`${Math.round(confidence*100)}%`;
    const shown=Math.max(-50,Math.min(50,cents));els.needle.style.left=`${50+shown}%`;els.pitchReadout.textContent=`${cents>=0?'+':''}${cents.toFixed(0)}¢`;
    const tol=Number(els.tolerance.value),hold=Number(els.holdMs.value);
    if(Math.abs(cents)<=tol){
      if(state.stableSince==null)state.stableSince=now;state.centsWindow.push(cents);if(state.centsWindow.length>9)state.centsWindow.shift();const med=median(state.centsWindow);const elapsed=now-state.stableSince;els.holdFill.style.width=`${Math.min(100,elapsed/hold*100)}%`;setQuality(Math.abs(med)<=Math.min(10,tol*.6)?'Чисто':'Почти — удерживай','good');
      if(elapsed>=hold){state.accepted++;state.centsSamples.push(med);if(state.centsSamples.length>200)state.centsSamples.shift();updateStats();setQuality('Засчитано','good');resetHold();state.stableSince=now+350;}
    }else{resetHold();setQuality(cents<0?'Низко':'Высоко',Math.abs(cents)>45?'bad':'warn');}
  }

  function detectPitch(buffer,sampleRate){
    let mean=0;for(let i=0;i<buffer.length;i++)mean+=buffer[i];mean/=buffer.length;let rms=0;for(let i=0;i<buffer.length;i++){buffer[i]-=mean;rms+=buffer[i]*buffer[i];}rms=Math.sqrt(rms/buffer.length);if(rms<.005)return{frequency:null,confidence:0};
    const minFreq=60,maxFreq=1200,minLag=Math.floor(sampleRate/maxFreq),maxLag=Math.min(buffer.length-2,Math.ceil(sampleRate/minFreq));let bestLag=-1,best=-1;const corr=new Float32Array(maxLag+1);
    for(let lag=minLag;lag<=maxLag;lag++){let sum=0,e1=0,e2=0,n=buffer.length-lag;for(let i=0;i<n;i+=2){const a=buffer[i],b=buffer[i+lag];sum+=a*b;e1+=a*a;e2+=b*b;}const c=sum/(Math.sqrt(e1*e2)+1e-12);corr[lag]=c;if(c>best){best=c;bestLag=lag;}}
    if(bestLag<0||best<.40)return{frequency:null,confidence:Math.max(0,best)};let lag=bestLag;if(bestLag>minLag&&bestLag<maxLag){const y1=corr[bestLag-1],y2=corr[bestLag],y3=corr[bestLag+1],d=y1-2*y2+y3;if(Math.abs(d)>1e-8)lag+=.5*(y1-y3)/d;}return{frequency:sampleRate/lag,confidence:best};
  }
  function audioLoop(now){state.raf=requestAnimationFrame(audioLoop);if(!state.analyser||now-state.lastFrame<65)return;state.lastFrame=now;state.analyser.getFloatTimeDomainData(state.buffer);const p=detectPitch(state.buffer,state.audioContext.sampleRate);updatePitch(p.frequency,p.confidence,now);}
  async function toggleMic(){
    if(state.micOn){stopMic();return;}try{if(!navigator.mediaDevices?.getUserMedia)throw new Error('Для микрофона нужен HTTPS — открой версию на GitHub Pages.');const constraints={audio:{echoCancellation:{ideal:false},noiseSuppression:{ideal:false},autoGainControl:{ideal:false},channelCount:{ideal:1}},video:false};state.stream=await navigator.mediaDevices.getUserMedia(constraints);state.audioContext=new (window.AudioContext||window.webkitAudioContext)({latencyHint:'interactive'});await state.audioContext.resume();state.source=state.audioContext.createMediaStreamSource(state.stream);state.analyser=state.audioContext.createAnalyser();state.analyser.fftSize=4096;state.analyser.smoothingTimeConstant=0;state.source.connect(state.analyser);state.buffer=new Float32Array(state.analyser.fftSize);state.micOn=true;els.micButton.textContent='Выключить микрофон';els.micBadge.textContent='микрофон слушает';els.micBadge.className='status-pill good';cancelAnimationFrame(state.raf);state.raf=requestAnimationFrame(audioLoop);resetTuner();}catch(err){const msg=err?.name==='NotAllowedError'?'Нет доступа к микрофону. Разреши его для этого сайта в настройках Chrome.':(err.message||'Не удалось открыть микрофон.');setQuality(msg,'bad');els.micBadge.textContent='нет доступа';els.micBadge.className='status-pill bad';}}
  function stopMic(){state.micOn=false;cancelAnimationFrame(state.raf);state.raf=null;state.stream?.getTracks().forEach(t=>t.stop());state.audioContext?.close();state.stream=null;state.audioContext=null;state.analyser=null;state.source=null;els.micButton.textContent='Включить микрофон';els.micBadge.textContent='микрофон выкл.';els.micBadge.className='status-pill';resetTuner();}

  els.noteName.addEventListener('change',()=>{updateTarget();resetHold();});els.octave.addEventListener('change',()=>{updateTarget();resetHold();});els.targetDown.addEventListener('click',()=>setMidi(selectedMidi()-1));els.targetUp.addEventListener('click',()=>setMidi(selectedMidi()+1));els.micButton.addEventListener('click',toggleMic);[els.tolerance,els.holdMs,els.concertA].forEach(el=>el.addEventListener('input',settingsUI));window.addEventListener('pagehide',()=>{if(state.micOn)stopMic();});
  window.addEventListener('beforeinstallprompt',e=>{e.preventDefault();state.deferredInstall=e;els.installButton.classList.remove('hidden');els.installHelp.textContent='Можно установить приложение на главный экран одной кнопкой.';});els.installButton.addEventListener('click',async()=>{if(!state.deferredInstall)return;state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;els.installButton.classList.add('hidden');});
  setPage(1);settingsUI();updateStats();if('serviceWorker'in navigator&&location.protocol!=='file:')navigator.serviceWorker.register('./sw.js').catch(()=>{});
})();
