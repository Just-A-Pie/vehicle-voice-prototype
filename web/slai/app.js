import {initialState,defaultPatch,windowKeys,windowNames,doorKeys,doorNames,parameters,controlSchema,applyPatch,validatePatch,parseCommand,palette,chooseSuggestion,trackNames} from './controls.mjs?v=47';
import {mountScene} from './scene.js?v=rose-20261016';
const $=s=>document.querySelector(s),$$=s=>[...document.querySelectorAll(s)],shell=$('.cockpit');
const state=initialState();
const icons={progress:'<path d="M20 12a8 8 0 11-8-8"/><circle cx="12" cy="4" r="1" fill="currentColor"/>',fan:'<circle cx="12" cy="12" r="2"/><path d="M10 10C0 2 16-3 14 8M14 10c8-10 13 6 2 4M14 14c10 8-6 13-4 2M10 14c-8 10-13-6-2-4"/>',play:'<path d="M8 4l12 8-12 8z" fill="currentColor" stroke="none"/>',pause:'<path d="M7 5v14M17 5v14" stroke-width="3"/>',next:'<path d="M18 5v14M5 5l10 7-10 7z"/>',car:'<path d="M4 10l2-6h12l2 6M3 17h18V10H3zM5 17v3M19 17v3M6 13h2M16 13h2"/>',micOff:'<path d="M9 7V5a3 3 0 016 0v6M9 11v1a3 3 0 004 3M5 10v2a7 7 0 0012 5M19 10v2M12 19v3M8 22h8M3 3l18 18"/>',keyboard:'<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M6 9h1M11 9h1M16 9h1M6 13h1M11 13h1M16 13h1M8 16h8"/>',check:'<path d="M5 12l4 4L19 6"/>',error:'<circle cx="12" cy="12" r="9"/><path d="M12 7v6M12 17h.01"/>'};
function icon(el,name){el.innerHTML=`<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name]}</svg>`;}$$('[data-icon]').forEach(e=>icon(e,e.dataset.icon));
const tracks=[{name:'Nightfall',notes:[65.406,97.999,130.813,164.814,195.998]},{name:'Blue Horizon',notes:[73.416,110,146.832,174.614,220]},{name:'Weightless',notes:[55,82.407,110,138.591,164.814]},{name:'晨光',file:'morning'},{name:'河畔',file:'riverside'},{name:'星夜',file:'starlight'}];
let audioCtx,master,voices=[],audioTrack=-1,audioRevision=0;const musicBuffers=new Map();
async function audio(next){
 if(!audioCtx&&!next.playing)return;
 if(!audioCtx){audioCtx=new(window.AudioContext||window.webkitAudioContext)();master=audioCtx.createGain();master.gain.value=0;master.connect(audioCtx.destination);}
 if(next.playing){let timeout;try{await Promise.race([audioCtx.resume(),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(Error('请点按播放按钮启用声音')),1800);})]);}finally{clearTimeout(timeout);}if(audioCtx.state!=='running')throw Error('音乐未能播放，请检查浏览器声音设置');}
 if(audioTrack!==next.track){
  const revision=++audioRevision,track=tracks[next.track];audioTrack=next.track;
  const bus=audioCtx.createGain();bus.gain.value=0;bus.connect(master);const newVoices=[];
  try{
   if(track.file){
    if(!musicBuffers.has(track.file))musicBuffers.set(track.file,fetch('./assets/music/'+track.file+'.wav').then(r=>{if(!r.ok)throw Error('音乐载入失败');return r.arrayBuffer();}).then(b=>audioCtx.decodeAudioData(b)).catch(e=>{musicBuffers.delete(track.file);throw e;}));
    const buffer=await musicBuffers.get(track.file);
    if(revision!==audioRevision){bus.disconnect();return;}
    const source=audioCtx.createBufferSource();source.buffer=buffer;source.loop=true;source.connect(bus);source.start();newVoices.push(source);
   }else track.notes.forEach((f,i)=>{const osc=audioCtx.createOscillator(),gain=audioCtx.createGain(),pan=audioCtx.createStereoPanner();osc.type='sine';osc.frequency.value=f;gain.gain.value=.034/(1+i*.3);pan.pan.value=(i%2?-1:1)*.65;osc.connect(gain);gain.connect(pan);pan.connect(bus);osc.start();newVoices.push(osc);const lfo=audioCtx.createOscillator(),mod=audioCtx.createGain();lfo.frequency.value=.08+i*.023;mod.gain.value=.006;lfo.connect(mod);mod.connect(gain.gain);lfo.start();newVoices.push(lfo);});
   const old=voices;for(const voice of old)voice.bus.gain.setTargetAtTime(0,audioCtx.currentTime,.09);
   setTimeout(()=>old.forEach(({nodes,bus})=>{nodes.forEach(n=>{try{n.stop();n.disconnect();}catch{}});bus.disconnect();}),500);
   voices=[{nodes:newVoices,bus}];shell.dataset.musicLoaded=track.name;shell.dataset.musicContext=audioCtx.state;bus.gain.setTargetAtTime(track.file?.32:1,audioCtx.currentTime,.12);
  }catch(e){bus.disconnect();if(revision===audioRevision)audioTrack=-1;throw e;}
 }
 master.gain.setTargetAtTime(next.playing&&!next.muted?next.volume*(['listening','processing','speaking'].includes(voicePhase)?.12:1):0,audioCtx.currentTime,.25);
}
let sceneController;
let busy=false,feedbackTimer,commandRevision=0,quietUntil=0,lastInteraction=0,lastCategory='',history=[],lastSuggestionAt=performance.now(),currentSuggestion,hoverSuggestion=false,voicePhase='disconnected';
const modeNames={auto:'自动',cool:'制冷',heat:'制热',fan:'通风'};
const reducedMotion=matchMedia('(prefers-reduced-motion: reduce)');
let shownTemp=null,tempHintTimer;
const valueAnimations=new WeakMap(),rangeFrames=new WeakMap();
function presentValue(el,text){const first=el.dataset.presented!==undefined;el.dataset.presented='true';if(el.textContent===text)return;valueAnimations.get(el)?.cancel();el.textContent=text;if(first&&!reducedMotion.matches)valueAnimations.set(el,el.animate([{opacity:.35,transform:'translateY(5px)'},{opacity:1,transform:'translateY(0)'}],{duration:240,easing:'ease-out'}));}
function presentRange(el,target){const old=rangeFrames.get(el);if(old)cancelAnimationFrame(old);if(el.matches(':active')||reducedMotion.matches){el.value=target;return;}const from=Number(el.value),start=performance.now();if(from===target)return;function tick(now){const t=Math.min(1,(now-start)/300);if(el.matches(':active'))return;el.value=from+(target-from)*(1-(1-t)**3);if(t<1)rangeFrames.set(el,requestAnimationFrame(tick));else rangeFrames.delete(el);}rangeFrames.set(el,requestAnimationFrame(tick));}
function render(){
 shell.dataset.climateMode=state.climateMode;document.documentElement.dataset.climateMode=state.climateMode;shell.dataset.ac=state.ac;shell.dataset.playing=state.playing;shell.dataset.ambient=state.ambient;shell.dataset.ambientColor=state.ambientColor;shell.dataset.focus='climate';shell.dataset.busy=busy;shell.dataset.feedback=state.feedbackKind||'';
 document.documentElement.style.setProperty('--ambient',palette[state.ambientColor].hex);
 $('#temp-down').disabled=state.temp<=16;$('#temp-up').disabled=state.temp>=28;$$('[data-adjust]').forEach(b=>b.disabled=Number(b.dataset.adjust)<0?state.temp<=16:state.temp>=28);$('#ac-power').setAttribute('aria-pressed',state.ac);$('#ac-power').setAttribute('aria-label',state.ac?'关闭空调':'打开空调');$('#dock-temp').textContent=state.ac?'运行中':'已关闭';presentValue($('#dock-setpoint'),state.temp+'°');presentValue($('#dialog-temp'),state.temp+'°');$('#dialog-ac').textContent=state.ac?'关闭空调':'打开空调';presentRange($('#fan'),state.fan);$('#fan-value').textContent=state.fan+' 档';$('#fan-status').textContent=state.ac?'风量 '+state.fan+' 档':'待机';$('#front-flow-state').textContent=state.ac&&state.frontAir?'送风中':'已关闭';$('#rear-flow-state').textContent=state.ac&&state.rearAir?'送风中':'已关闭';$('#climate-power-state').textContent=state.ac?'运行中':'已关闭';$$('[data-flow-zone]').forEach(el=>el.dataset.active=String(state.ac&&state[el.dataset.flowZone]));
 $('#mini-title').textContent=tracks[state.track].name;$('#music-status').textContent=state.playing?(state.muted?'已静音':state.volume?'正在播放':'音量 0%'):'音乐待机';icon($('#play'),state.playing?'pause':'play');$('#play').setAttribute('aria-label',state.playing?'暂停音乐':'播放音乐');$('#music-toggle').textContent=state.playing?'暂停音乐':'播放音乐';presentRange($('#volume'),Math.round(state.volume*100));$('#volume-value').textContent=Math.round(state.volume*100)+'%';$$('[data-track]').forEach(b=>{b.classList.toggle('active',+b.dataset.track===state.track);b.setAttribute('aria-pressed',+b.dataset.track===state.track);});
 $('#ambient-name').textContent=state.ambient?palette[state.ambientColor].name+' · '+state.ambientBrightness+'%':'已关闭';document.documentElement.style.setProperty('--ambient-level',state.ambient?state.ambientBrightness/100:0);$('#ambient-toggle').textContent=state.ambient?'关闭氛围灯':'打开氛围灯';$$('[data-ambient]').forEach(b=>{b.classList.toggle('active',state.ambient&&state.ambientColor===b.dataset.ambient);b.setAttribute('aria-pressed',state.ambient&&state.ambientColor===b.dataset.ambient);});
 $$('[data-control]').forEach(b=>{const key=b.dataset.control,on=state[key];b.classList.toggle('active',on);b.setAttribute('aria-pressed',on);b.querySelector('span').textContent=key==='locked'?(on?'已锁定':'已解锁'):(on?'已开启':'已关闭');});
 $$('[data-remote-toggle]').forEach(b=>{const key=b.dataset.remoteToggle,on=state[key];b.setAttribute('aria-pressed',on);b.querySelector('span').textContent=key==='playing'?(on?'播放中':'已暂停'):(on?'已开启':'已关闭');});
 $$('[data-remote-range]').forEach(input=>{const key=input.dataset.remoteRange,value=key==='volume'?Math.round(state.volume*100):state[key];if(!input.matches(':active'))presentRange(input,value);});
 for(const key of ['temp','fan','volume','ambientBrightness'])$('[data-remote-output="'+key+'"]').textContent=remoteValue(key,key==='volume'?Math.round(state.volume*100):state[key]);
 $$('[data-remote-color]').forEach(b=>b.setAttribute('aria-pressed',state.ambient&&state.ambientColor===b.dataset.remoteColor));
 for(const key of [...windowKeys,...doorKeys]){const input=$('[data-opening-range="'+key+'"]');if(!input.matches(':active'))input.value=state[key];$('[data-target="'+key+'"]').textContent=state[key]+'%';}
 $$('[data-opening-key]').forEach(b=>b.setAttribute('aria-pressed',state[b.dataset.openingKey]===Number(b.dataset.opening)));
 $$('[data-zone]').forEach(b=>{const on=state[b.dataset.zone];b.setAttribute('aria-pressed',on);b.querySelector('span').textContent=on?'开启':'关闭';});
 for(const id of ['remote-mute','music-mute']){$('#'+id).textContent=state.muted?'解除静音':'静音';$('#'+id).setAttribute('aria-pressed',state.muted);}
 $('#ambient-brightness').value=state.ambientBrightness;$('#ambient-brightness-value').textContent=state.ambientBrightness+'%';
 // Persistent cabin instruments never become the last action's result page.
 if(shownTemp!==null&&shownTemp!==state.temp){clearTimeout(tempHintTimer);const delta=state.temp-shownTemp;$('#temp-change').textContent=(delta>0?'提高 ':'降低 ')+Math.abs(delta)+'°C';$('#temp-change').classList.add('visible');tempHintTimer=setTimeout(()=>$('#temp-change').classList.remove('visible'),2200);}shownTemp=state.temp;
 $$('[data-fan-level]').forEach(b=>{b.dataset.lit=String(state.ac&&Number(b.dataset.fanLevel)<=state.fan);b.setAttribute('aria-pressed',String(state.ac&&Number(b.dataset.fanLevel)===state.fan));});
 $('#climate-mode-label').textContent=modeNames[state.climateMode]+' · '+(state.ac?'已开启':'待机');
 $('#climate-mode-note').textContent=state.climateMode==='auto'?'自动模式示意：尚未接入舱温，气流不表示实际冷暖。':state.climateMode==='fan'?'仅送风；下方温度为保留设定，不进行温度调节。':'目标温度为设定值，不代表实测舱温。';
 $$('[data-climate-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.climateMode===state.climateMode)));
 updateWindowFeedback(state.windowPositions||{});
 shell.dispatchEvent(new CustomEvent('cockpit:render',{detail:state}));
}
const hasWindowAction=p=>windowKeys.some(k=>k in p);
function updateWindowFeedback(positions){
 state.windowPositions=positions;
 for(const key of windowKeys){const percent=positions[key]||0,pane=$('[data-window-pane="'+key+'"]');pane.style.setProperty('--window-open',percent+'%');pane.querySelector('i').setAttribute('aria-valuenow',percent);$('[data-window-percent="'+key+'"]').textContent=percent===0?'关闭':percent===100?'全开':percent+'%';$('[data-window-target="'+key+'"]').textContent='目标 '+state[key]+'%';$('[data-actual="'+key+'"]').textContent='实际 '+percent+'%';}
 const values=windowKeys.map(k=>positions[k]||0),open=values.filter(p=>p>0).length;
 $('#window-position').textContent=values.every(p=>p===0)?'全部关闭':values.every(p=>p===100)?'全部打开':windowKeys.some(k=>Math.abs((positions[k]||0)-state[k])>0)?'正在调节':open+' 扇已打开';
}
function describeWindows(p,pending=false){
 const keys=windowKeys.filter(k=>k in p);if(!keys.length)return '';
 const verb=value=>pending?'正在调至 '+value+'%':value===0?'已关闭':value===100?'已全开':'已调至 '+value+'%';
 if(keys.length===4&&keys.every(k=>p[k]===p[keys[0]]))return '全部车窗'+verb(p[keys[0]]);
 if(keys.length>1)return keys.length+' 扇车窗'+(pending?'正在调节':'已调节');
 return keys.map(k=>windowNames[k]+verb(p[k])).join('，');
}

function describe(p){const out=[];if(p.climateMode)out.push('已切换到'+modeNames[p.climateMode]+'模式');if(p.ac!==undefined)out.push(p.ac?'空调已开启':'空调已关闭');if(p.temp!==undefined)out.push('温度已调至 '+state.temp+'°C');if(p.fan!==undefined)out.push('风量已调至 '+state.fan+' 档');for(const [k,n]of [['frontAir','前排送风'],['rearAir','后排送风']])if(k in p)out.push(n+(p[k]?'已开启':'已关闭'));if(p.playing!==undefined)out.push(p.playing?'正在播放 '+tracks[state.track].name:'音乐已暂停');else if(p.track!==undefined)out.push('已切换至 '+tracks[state.track].name);if(p.muted!==undefined)out.push(p.muted?'已静音':'已解除静音');if(p.volume!==undefined)out.push('音量 '+Math.round(state.volume*100)+'%');if(p.ambientBrightness!==undefined)out.push('氛围灯亮度 '+state.ambientBrightness+'%');if(p.ambientColor)out.push('氛围灯已切换为'+palette[state.ambientColor].name);else if(p.ambient!==undefined)out.push(p.ambient?'氛围灯已开启':'氛围灯已关闭');for(const [k,name]of [['leftDoor','主驾车门'],['rightDoor','副驾车门'],['rearLeftDoor','左后车门'],['rearRightDoor','右后车门'],['lights','迎宾灯']])if(p[k]!==undefined)out.push(name+(doorKeys.includes(k)?(p[k]===0?'已关闭':p[k]===100?'已全开':'已调至 '+p[k]+'%'):(p[k]?'已开启':'已关闭')));if(hasWindowAction(p))out.push(describeWindows(p));if(p.locked!==undefined)out.push(p.locked?'车辆已锁定，车门已关闭':'车辆已解锁');return out.join('，');}
function feedback(message,echo='',error=false,pending=false){clearTimeout(feedbackTimer);$('#window-feedback').hidden=error||state.feedbackKind!=='windows';$('.feedback').classList.toggle('error',error);$('.feedback').classList.toggle('pending',pending);$('.feedback').classList.toggle('complete',!pending&&!error);icon($('.feedback-mark'),error?'error':pending?'progress':'check');$('#command-echo').textContent=echo;$('#command-echo').hidden=!echo;$('#response').textContent=message;$('#result-state').textContent=error?'未执行':pending?'执行中':'已完成';$('.feedback').classList.add('visible');$('.feedback').setAttribute('aria-hidden','false');quietUntil=performance.now()+6500;if(!pending)feedbackTimer=setTimeout(()=>{$('.feedback').classList.remove('visible');$('.feedback').setAttribute('aria-hidden','true');},5500);}
let commandTransport={action:async()=>{throw Error('语音服务正在初始化');},turn:async()=>{feedback('语音服务正在初始化','',true);}};
async function execute(p,{echo='',source='touch',resultText=''}={}){
 if(commandTransport&&source!=='server')return commandTransport.action(validatePatch(p),{echo,source,resultText});
 const revision=++commandRevision;busy=true;render();
 try{const patch=validatePatch(p),next=applyPatch(state,patch);await audio(next);if(revision!==commandRevision)return snapshot();Object.assign(state,next);state.feedbackKind=hasWindowAction(patch)?'windows':['leftDoor','rightDoor','rearLeftDoor','rearRightDoor','locked'].some(k=>k in patch)?'doors':null;sceneController?.pulse(patch);render();
 const mechanical=hasWindowAction(patch)||['leftDoor','rightDoor','rearLeftDoor','rearRightDoor','locked'].some(k=>k in patch);
 const shownEcho=echo?((source==='demo'?'预演 · ':'')+echo):'';
 if(mechanical){
  const opening=['leftDoor','rightDoor','rearLeftDoor','rearRightDoor'].some(k=>patch[k]>0);
  feedback(opening&&state.motionSpeed>.01?'正在减速，停稳后打开车门':hasWindowAction(patch)?describeWindows(patch,true):'正在执行车辆操作',shownEcho,false,true);
  const target=patch.locked===true?{...patch,leftDoor:0,rightDoor:0,rearLeftDoor:0,rearRightDoor:0}:patch;
  await sceneController?.whenSettled(target);if(revision!==commandRevision)return snapshot();
 }
 feedback(resultText||describe(patch),shownEcho);lastCategory=['ac','temp','fan','frontAir','rearAir'].some(k=>k in patch)?'climate':['playing','volume','track','muted'].some(k=>k in patch)?'music':['ambient','ambientColor','ambientBrightness'].some(k=>k in patch)?'ambient':hasWindowAction(patch)?'windows':'doors';lastSuggestionAt=performance.now();busy=false;render();return snapshot();}
 catch(e){if(revision===commandRevision)feedback(e.message,echo,true);throw e;}
 finally{if(revision===commandRevision){busy=false;render();}}
}
const act=p=>execute(p).catch(()=>{});
async function demo(text){if(commandTransport)return commandTransport.turn(text);try{const patch=parseCommand(text,state);return await execute(patch,{echo:text,source:'demo'});}catch(e){feedback(e.message,text,true);return {error:e.message};}}
function snapshot(){return {...state,voicePhase,simulated:true,busy,trackName:tracks[state.track].name,suggestion:currentSuggestion?.text};}
function showSuggestion(manual=false){if(!manual&&(busy||voicePhase!=='disconnected'&&voicePhase!=='idle'||document.querySelector('dialog[open],#remote-panel:not([hidden])')))return;currentSuggestion=chooseSuggestion(state,history,lastCategory);history.push(currentSuggestion.text);history=history.slice(-8);lastCategory=currentSuggestion.category;lastSuggestionAt=performance.now();$('#suggestion').replaceChildren(document.createTextNode('「'+currentSuggestion.text+'」'),Object.assign(document.createElement('small'),{textContent:commandTransport?'点按发送 ↗':'点按预演 ↗'}));$('#suggestion').setAttribute('aria-label',(commandTransport?'发送指令：':'预演示例指令：')+currentSuggestion.text);}
$('#suggestion').onclick=()=>demo(currentSuggestion.text);$('#next-suggestion').onclick=()=>showSuggestion(true);$('.suggestion-line').onpointerenter=()=>hoverSuggestion=true;$('.suggestion-line').onpointerleave=()=>hoverSuggestion=false;
setInterval(()=>{const now=performance.now(),paused=busy||now<quietUntil||!!document.querySelector('dialog[open],#remote-panel:not([hidden])')||!['idle','disconnected'].includes(voicePhase);$('.suggestion-line').classList.toggle('dimmed',paused);if(!paused&&!hoverSuggestion&&!document.hidden&&now-lastInteraction>4000&&now-lastSuggestionAt>=12000)showSuggestion();},250);
addEventListener('pointerdown',()=>lastInteraction=performance.now());addEventListener('keydown',()=>lastInteraction=performance.now());
$$('[data-fan-level]').forEach(b=>b.onclick=()=>act({fan:Number(b.dataset.fanLevel)}));
$$('[data-climate-mode]').forEach(b=>b.onclick=()=>act({climateMode:b.dataset.climateMode}));
$('#ac-power').onclick=()=>act({ac:!state.ac});$('#temp-down').onclick=()=>act({temp:Math.max(16,state.temp-.5)});$('#temp-up').onclick=()=>act({temp:Math.min(28,state.temp+.5)});$$('[data-adjust]').forEach(b=>b.onclick=()=>act({temp:Math.max(16,Math.min(28,state.temp+Number(b.dataset.adjust)))}));$('#dialog-ac').onclick=()=>act({ac:!state.ac});$('#fan').oninput=e=>$('#fan-value').textContent=e.target.value+' 档';$('#fan').onchange=e=>act({fan:+e.target.value});
$('#play').onclick=()=>act({playing:!state.playing});$('#music-toggle').onclick=()=>act({playing:!state.playing});$('#next-track').onclick=()=>act({track:(state.track+1)%tracks.length,playing:true});$$('[data-track]').forEach(b=>b.onclick=()=>act({track:+b.dataset.track,playing:true}));$('#volume').oninput=e=>$('#volume-value').textContent=e.target.value+'%';$('#volume').onchange=e=>act({volume:+e.target.value/100});
$$('[data-ambient]').forEach(b=>b.onclick=()=>{act({ambientColor:b.dataset.ambient});$('#ambient-dialog').close();});$('#ambient-toggle').onclick=()=>{act({ambient:!state.ambient});$('#ambient-dialog').close();};$$('[data-control]').forEach(b=>b.onclick=()=>{act({[b.dataset.control]:!state[b.dataset.control]});});
function remoteValue(key,value){return value+(key==='temp'?'°C':key==='fan'?' 档':'%');}
function showRemote(open){$('#remote-panel').hidden=!open;$('#vehicle-detail').setAttribute('aria-expanded',open);if(open)$('#remote-close').focus();else $('#vehicle-detail').focus();}
$('#vehicle-detail').onclick=()=>showRemote($('#remote-panel').hidden);$('#remote-close').onclick=()=>showRemote(false);
addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#remote-panel').hidden)showRemote(false);});
$$('[data-remote-toggle]').forEach(b=>b.onclick=()=>act({[b.dataset.remoteToggle]:!state[b.dataset.remoteToggle]}));
$$('[data-remote-range]').forEach(input=>{const key=input.dataset.remoteRange;input.oninput=()=>{$('[data-remote-output="'+key+'"]').textContent=remoteValue(key,input.value);};input.onchange=()=>act({[key]:Number(input.value)/(key==='volume'?100:1)});});
$$('[data-remote-color]').forEach(b=>b.onclick=()=>act({ambientColor:b.dataset.remoteColor}));
$('#remote-mute').onclick=()=>act({muted:!state.muted});$('#music-mute').onclick=()=>act({muted:!state.muted});$('#remote-previous').onclick=()=>act({track:(state.track+tracks.length-1)%tracks.length,playing:true});$('#remote-next').onclick=()=>act({track:(state.track+1)%tracks.length,playing:true});
$$('[data-zone]').forEach(b=>b.onclick=()=>act({[b.dataset.zone]:!state[b.dataset.zone]}));
$('#ambient-brightness').oninput=e=>$('#ambient-brightness-value').textContent=e.target.value+'%';$('#ambient-brightness').onchange=e=>act({ambientBrightness:Number(e.target.value)});
$$('[data-opening-key]').forEach(b=>b.onclick=()=>act({[b.dataset.openingKey]:Number(b.dataset.opening)}));
$$('[data-opening-range]').forEach(input=>{const key=input.dataset.openingRange;input.oninput=()=>{$('[data-target="'+key+'"]').textContent=input.value+'%';};input.onchange=()=>act({[key]:Number(input.value)});});
$('#remote-windows-open').onclick=()=>act({windows:true});$('#remote-windows-close').onclick=()=>act({windows:false});
$('#remote-doors-open').onclick=()=>act({leftDoor:true,rightDoor:true,rearLeftDoor:true,rearRightDoor:true});
$('#remote-doors-close').onclick=()=>act({leftDoor:0,rightDoor:0,rearLeftDoor:0,rearRightDoor:0});
$('#remote-reset').onclick=()=>execute(defaultPatch(),{resultText:'已恢复默认状态',source:'reset'}).catch(()=>{});
for(const [button,dialog]of [['climate-detail','climate-dialog'],['music-detail','music-dialog'],['ambient-detail','ambient-dialog'],['command-open','command-dialog']])$('#'+button).onclick=()=>$('#'+dialog).showModal();
$$('dialog').forEach(d=>{d.addEventListener('close',()=>{quietUntil=Math.max(quietUntil,performance.now()+1500);});d.addEventListener('click',e=>{if(e.target===d){const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();}});});
$('#command-form').onsubmit=e=>{e.preventDefault();const text=$('#command-input').value;$('#command-dialog').close();demo(text);};
$('#fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await document.documentElement.requestFullscreen();}catch{feedback('当前浏览器不支持全屏','',true);}};$('.wordmark').onclick=e=>{e.preventDefault();state.focus='climate';render();};
function clock(){$('time').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});}clock();setInterval(clock,30000);
for(const input of $$('[data-remote-range],[data-opening-range]')){const key=input.dataset.remoteRange||input.dataset.openingRange,d=parameters[key],factor=key==='volume'?100:1;input.min=d.min*factor;input.max=d.max*factor;input.step=d.step*factor;}
render();showSuggestion();sceneController=mountScene(state,()=>{state.modelReady=true;},phase=>{
 const labels={cruising:['D','行驶演示'],braking:['D','正在停稳'],accelerating:['D','恢复行驶'],parked:['P','驻车演示'],parking:['P','已停稳']};
 const [gear,label]=labels[phase]||labels.cruising;$('#drive-gear').textContent=gear;$('#drive-label').textContent=label;
},telemetry=>{updateWindowFeedback(telemetry.windowPositions);state.doorPositions=telemetry.doorPositions;for(const key of doorKeys)$('[data-actual="'+key+'"]').textContent='实际 '+telemetry.doorPositions[key]+'%';});
// Future voice adapter: bind real service events here; this prototype never opens a microphone.
window.slaiCockpit=window.aetherCockpit=Object.freeze({
 beginFeedback:()=>{$('#action-confirmation').textContent='';clearTimeout(feedbackTimer);state.feedbackKind=null;$('#window-feedback').hidden=true;$('.feedback').classList.remove('visible');$('.feedback').setAttribute('aria-hidden','true');render();},
 read:snapshot,executeAction:p=>execute(p,{source:'model'}),
 previewAction:p=>{state.stateSource='local-preview';return execute(p,{source:'server',echo:'本地演示'});},
 setCommandTransport:value=>{commandTransport=value;showSuggestion(true);},
 async unlockMedia(){if(!audioCtx){audioCtx=new AudioContext();master=audioCtx.createGain();master.gain.value=0;master.connect(audioCtx.destination);}await audioCtx.resume();},
 applyServerState:values=>{state.stateSource='server';const patch=validatePatch(values),changed=Object.fromEntries(Object.entries(patch).filter(([k,v])=>state[k]!==v));Object.assign(state,patch);if(Object.keys(changed).length)state.feedbackKind=windowKeys.some(k=>k in changed)?'windows':doorKeys.some(k=>k in changed)?'doors':null;state.windows=windowKeys.every(k=>state[k]===100);sceneController?.pulse(changed);render();void audio(state).catch(e=>feedback('车辆状态已同步；'+e.message,'',true));return snapshot();},
 notifyAction:(text,echo='')=>{$('#action-confirmation').textContent=text;feedback('',echo,false,true);$('#result-state').textContent='已确认';},
 notifyTranscript:(text,echo='')=>{feedback(text,echo,false,true);$('#result-state').textContent='回复中';},
 notify:(text,echo='',error=false)=>feedback(text,echo,error),
 setVoicePhase:phase=>{if(!['disconnected','idle','listening','processing','speaking'].includes(phase))throw Error('Invalid voice phase');voicePhase=phase;state.voicePhase=phase;shell.dataset.voice=phase;quietUntil=performance.now()+1500;if(master)master.gain.setTargetAtTime(state.playing&&!state.muted?state.volume*(['listening','processing','speaking'].includes(phase)?.12:1):0,audioCtx.currentTime,.1);return snapshot();}
});

if(document.modelContext?.registerTool){
 document.modelContext.registerTool({name:'read_cockpit_state',description:'Read server-confirmed simulated cabin targets plus local animation positions and voice phase. No real vehicle is connected.',inputSchema:{type:'object',properties:{},additionalProperties:false},annotations:{readOnlyHint:true},execute:snapshot});
 document.modelContext.registerTool({name:'control_cabin',description:'Execute validated simulated cabin actions through the same controls used by the UI. Includes air conditioning, audio, cabin lighting and doors.',inputSchema:controlSchema,execute:p=>execute(p,{source:'agent'})});
 document.modelContext.registerTool({name:'send_cabin_command',description:'Send a Chinese command to the connected Qwen3-Omni assistant; the server validates simulated cabin actions.',inputSchema:{type:'object',properties:{text:{type:'string',minLength:1,maxLength:160}},required:['text'],additionalProperties:false},execute:input=>{if(typeof input?.text!=='string'||!input.text.trim()||input.text.length>160)throw Error('请输入 1–160 字的指令');return demo(input.text);}});
}
