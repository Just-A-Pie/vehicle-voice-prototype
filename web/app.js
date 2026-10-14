const $=id=>document.getElementById(id);
const debugMode=new URLSearchParams(location.search).get('debug')==='1';
document.body.classList.toggle('debug-mode',debugMode);$('engineering').hidden=!debugMode;
let settleTimer;
const recordLabel=text=>{$('record-label').textContent=text;$('record').setAttribute('aria-label',text==='结束'?'结束语音输入':'开始语音输入')};
function settleAssistant() {
  clearTimeout(settleTimer);
  settleTimer=setTimeout(()=>{if(!busy&&!recording&&ready&&document.body.dataset.phase==='idle') {phase('语音助手');$('reply').textContent='';$('interaction-hint').textContent='点击麦克风开始说话'}},5500);
}
let session='',busy=false,recording=false,ready=false,checking=false,streaming=false;
let ctx,stream,recorder,chunks=[],rate=48000,start=0,tick,autoStop,audioUrl,waitTick;
let currentState=null,activeTurn=null,turnCount=0,playbackStopped=false,replaying=false;
try {session=sessionStorage.getItem('vehicle-session')||''} catch {}
const rememberSession=id=>{session=id;try{sessionStorage.setItem('vehicle-session',id)}catch{}};
const seconds=n=>Number.isFinite(n)?n.toFixed(1)+'s':'—';
function phase(text,kind='idle') {clearTimeout(settleTimer);$('phase').textContent=text;document.body.dataset.phase=kind;document.body.classList.toggle('error',kind==='error')}
function setBusy(value) {
  busy=value;
  $('record').disabled=busy||(!ready&&!recording);
  $('reset').disabled=busy||recording||!ready;
  $('text-form').querySelector('button').disabled=busy||recording||!ready;
  $('text').disabled=busy||recording;
  $('reconnect').disabled=busy||recording||checking;
  $('replay').disabled=busy||recording;
  for(const el of document.querySelectorAll('[data-prompt]')) el.disabled=busy||recording;
}
function serverError(status,detail) {
  if(detail?.state) paint(detail.state);
  const error=new Error(typeof detail==='string'?detail:detail?.error||'服务暂时不可用，请稍后重试');
  error.status=status;error.detail=detail;return error;
}
async function request(path,data,timeout=10000) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),timeout);
  try {
    const response=await fetch('/api/'+path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify(data):undefined,signal:controller.signal});
    const result=await response.json();
    if(!response.ok) throw serverError(response.status,result.detail);
    return result;
  } catch(e) {
    if(e.name==='AbortError') throw Error('等待服务超时。本轮结果尚未确认，请连接后核对车辆状态，勿重复发送。');
    throw e;
  } finally {clearTimeout(timer)}
}
function paint(s) {
  if(!s || ![s.temperature,s.media_volume,s.window_open].every(Number.isFinite) || typeof s.ac_on!=='boolean') throw Error('服务器返回的车辆状态不完整');
  const previous=currentState;currentState={...s};document.body.classList.remove('state-unknown');document.body.classList.toggle('ac-off',!s.ac_on);
  $('temperature').replaceChildren(document.createTextNode(String(s.temperature)),Object.assign(document.createElement('sup'),{textContent:'°'}));
  $('ac').textContent=s.ac_on?'开启':'关闭';$('ac').classList.toggle('off',!s.ac_on);
  $('ac-note').textContent='A/C · '+(s.ac_on?'开启':'关闭');$('air-label').textContent='空调'+(s.ac_on?'开启':'关闭');
  $('volume').textContent=s.media_volume;$('window').textContent=s.window_open;
  $('window-note').textContent=s.window_open===0?'车窗已关闭':s.window_open===100?'车窗已完全打开':'车窗已打开 '+s.window_open+'%';
  $('temp-progress').style.width=Math.max(0,Math.min(100,(s.temperature-16)/14*100))+'%';
  $('volume-progress').style.width=s.media_volume+'%';$('window-progress').style.width=s.window_open+'%';
  $('state-freshness').textContent='已同步';
  for(const [id,keys] of [['climate-card',['temperature','ac_on']],['volume-card',['media_volume']],['window-card',['window_open']]]) {
    if(previous&&keys.some(k=>previous[k]!==s[k])) {$(id).classList.add('changed');setTimeout(()=>$(id).classList.remove('changed'),1300)}
  }
}
async function health() {
  if(busy||recording||checking) return;
  checking=true;setBusy(busy);
  try {
    const h=await request('health',undefined,6500);
    streaming=h.streaming_audio===true;
    if(busy||recording) return;
    if(h.ready) {
      const s=await request('session',{session_id:session});
      if(busy||recording) return;
      rememberSession(s.session_id);paint(s.state);
    }
    ready=!!h.ready&&!h.busy;
    $('connection').textContent=ready?'语音已就绪':h.ready?'语音忙碌':'语音准备中';
    $('dot').classList.toggle('online',ready);
    $('connection-notice').hidden=ready;
    $('connection-help').textContent=h.ready?'语音暂忙，请稍候':'语音正在准备，请稍候';
    if(document.body.dataset.phase==='offline'||(!activeTurn&&document.body.dataset.phase==='idle')) {
      phase(ready?'语音助手':h.ready?'语音忙碌':'语音准备中',ready?'idle':'offline');
      if(!activeTurn&&!turnCount) $('reply').textContent='';
    }
  } catch(e) {
    ready=false;$('connection').textContent='语音未连接';$('dot').classList.remove('online');
    $('connection-notice').hidden=false;$('connection-help').textContent=currentState?'语音连接已断开 · 保留上次车辆状态':'语音暂不可用 · 正在重连';
    $('state-freshness').textContent=currentState?'上次确认状态 · 待重连':'等待状态同步';
    if(!busy&&!recording) phase('语音暂不可用','offline');
  } finally {checking=false;setBusy(busy)}
}
function wavBase64(chunks,sr){const size=chunks.reduce((a,x)=>a+x.length,0),input=new Float32Array(size);let k=0;for(const c of chunks){input.set(c,k);k+=c.length}const n=Math.floor(size*16000/sr);const b=new ArrayBuffer(44+n*2),v=new DataView(b);function str(o,s){for(let i=0;i<s.length;i++)v.setUint8(o+i,s.charCodeAt(i))}str(0,'RIFF');v.setUint32(4,36+n*2,true);str(8,'WAVE');str(12,'fmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,16000,true);v.setUint32(28,32000,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,n*2,true);for(let i=0;i<n;i++){const a=Math.floor(i*sr/16000),z=Math.max(a+1,Math.floor((i+1)*sr/16000));let sum=0;for(let j=a;j<z&&j<size;j++)sum+=input[j];const x=Math.max(-1,Math.min(1,sum/(z-a)));v.setInt16(44+i*2,x<0?x*32768:x*32767,true)}const bytes=new Uint8Array(b);let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(binary)}
async function releaseMicrophone() {
  if(recorder) {recorder.port.onmessage=null;try{recorder.disconnect()}catch{}recorder=null}
  stream?.getTracks().forEach(t=>t.stop());stream=null;
  if(ctx&&ctx.state!=='closed') await ctx.close();ctx=null;
}
async function begin() {
  if(busy||recording||!ready) return;
  setBusy(true);clearAudio();phase('正在开启麦克风','waiting');$('reply').textContent='';
  try {
    if(!navigator.mediaDevices?.getUserMedia) throw Error('当前浏览器不支持麦克风，请使用本机 localhost 页面');
    stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:false,autoGainControl:false}});
    ctx=new AudioContext();await ctx.resume();rate=ctx.sampleRate;await ctx.audioWorklet.addModule('recorder.js');
    recorder=new AudioWorkletNode(ctx,'pcm-recorder');chunks=[];recorder.port.onmessage=e=>{chunks.push(e.data);let energy=0;for(const value of e.data)energy+=value*value;$('orb').style.setProperty('--voice-level',Math.min(1,Math.sqrt(energy/e.data.length)*12))};
    const source=ctx.createMediaStreamSource(stream);source.connect(recorder);
    const silent=ctx.createGain();silent.gain.value=0;recorder.connect(silent).connect(ctx.destination);
    recording=true;start=Date.now();document.body.classList.add('recording');phase('正在听你说','recording');
    $('reply').textContent='';recordLabel('结束');
    $('interaction-hint').textContent='说完点击结束 · 最长 19.5 秒';$('timer').textContent='0.0 / 19.5s';
    setBusy(false);tick=setInterval(()=>$('timer').textContent=((Date.now()-start)/1000).toFixed(1)+' / 19.5s',100);
    autoStop=setTimeout(end,19500);
  } catch(e) {
    await releaseMicrophone();phase('麦克风不可用','error');
    $('reply').textContent=debugMode?(e.name==='NotAllowedError'?'请允许麦克风权限，或使用工程文字输入。':e.message):(e.name==='NotAllowedError'?'请开启麦克风权限':e.name==='NotFoundError'?'请检查麦克风连接':'麦克风无法开启，请检查设备');
    setBusy(false);
  }
}
async function end() {
  if(!recording) return;
  const duration=Date.now()-start,recordEnd=performance.now();
  recording=false;setBusy(true);clearInterval(tick);clearTimeout(autoStop);
  await releaseMicrophone();document.body.classList.remove('recording');
  recordLabel('语音');$('timer').textContent='';
  if(duration<300 || !chunks.length) {chunks=[];phase('录音太短','idle');$('reply').textContent='请再说一次';setBusy(false);return}
  const audio=wavBase64(chunks,rate);chunks=[];setBusy(false);await submit({audio},recordEnd);
}
const player=new PCMStreamPlayer(()=>{
  if(!activeTurn) return;
  phase('正在播报','playing');
  activeTurn.browser.playback_started_ms=performance.now()-activeTurn.started;
  $('stop-playback').hidden=false;writeLog();
});
function clearAudio() {
  $('audio').pause();$('audio').removeAttribute('src');$('audio').load();player.reset();
  if(audioUrl) {URL.revokeObjectURL(audioUrl);audioUrl=null}
  $('replay').hidden=true;$('replay').classList.remove('playback-recovery');$('stop-playback').hidden=true;playbackStopped=false;replaying=false;
}
function setAudio(blob) {
  if(audioUrl) URL.revokeObjectURL(audioUrl);
  audioUrl=URL.createObjectURL(blob);$('audio').src=audioUrl;$('replay').hidden=false;
}
function writeLog() {
  if(!activeTurn) return;
  const x=activeTurn.result||{},browser=activeTurn.browser;
  if(activeTurn.mode==='stream') {
    Object.assign(browser,player.metrics);
    for(const key of ['first_audio_scheduled','playback_started','playback_completed']) {
      if(Number.isFinite(player.metrics[key+'_at'])) browser[key+'_ms']=player.metrics[key+'_at']-activeTurn.started;
      delete browser[key+'_at'];
    }
  }
  browser.request_sent=activeTurn.started;
  browser.state_received=Number.isFinite(browser.state_ms)?activeTurn.started+browser.state_ms:null;
  browser.audio_first_received=Number.isFinite(browser.first_audio_received_ms)?activeTurn.started+browser.first_audio_received_ms:null;
  browser.playback_started=Number.isFinite(browser.playback_started_ms)?activeTurn.started+browser.playback_started_ms:null;
  browser.playback_done=Number.isFinite(browser.playback_completed_ms)?activeTurn.started+browser.playback_completed_ms:null;
  browser.underrun_count=browser.underruns||0;
  window.vehicleVoiceMetrics=window.__vehicleMetrics={...browser};
  $('log').textContent=JSON.stringify({request_id:x.request_id,build:x.build,mode:activeTurn.mode,recognized_input:x.input_text,tools:x.events,model_trace:x.trace,timings:x.timings,agent_reply:x.agent_reply,spoken_text:x.reply,error:activeTurn.error,browser:{...browser,measurement:'浏览器音频时钟与调度观测，非扬声器声学实测；时间从发送本轮请求开始'}},null,2);
}
function stopWaiting() {clearInterval(waitTick);waitTick=null;$('wait-time').textContent=''}
function finishTurn(message='已完成') {
  stopWaiting();$('stop-playback').hidden=true;
  if(activeTurn) {
    if(activeTurn.mode==='legacy'&&!playbackStopped&&!replaying&&activeTurn.browser.playback_started_ms!=null) activeTurn.browser.playback_completed_ms=performance.now()-activeTurn.started;
    writeLog();
  }
  replaying=false;phase(message);$('interaction-hint').textContent='点击麦克风开始说话';setBusy(false);settleAssistant();
}
function addHistory(result,error=false) {
  const item=document.createElement('li'),time=document.createElement('time'),copy=document.createElement('div');
  time.textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});
  const input=document.createElement('p');input.className='user-text';input.textContent='你 · '+(result.input_text||activeTurn?.input||'语音输入（未返回转写）');
  const reply=document.createElement('p');reply.textContent='助手 · '+(result.reply||'本轮未完成');
  const outcome=document.createElement('p');outcome.className='turn-result';
  const changed=activeTurn?.before&&currentState&&Object.keys(currentState).filter(k=>currentState[k]!==activeTurn.before[k]);
  const names={temperature:'温度',ac_on:'空调',media_volume:'媒体音量',window_open:'车窗'};
  outcome.textContent=error?'本轮异常 · 请核对当前状态':changed?.length?'已更新 '+changed.map(k=>names[k]).join('、'):'车辆状态未改变';
  copy.append(input,reply,outcome);item.append(time,copy);$('history').prepend(item);
  while($('history').children.length>6) $('history').lastChild.remove();
  $('history-empty').hidden=true;$('turn-count').textContent=++turnCount;
}
function updateResult(x,final=false) {
  if(x.session_id) rememberSession(x.session_id);
  if(x.state) {paint(x.state);activeTurn.browser.state_ms??=performance.now()-activeTurn.started}
  activeTurn.result={...activeTurn.result,...x};
  if(final) {
    $('reply').textContent=x.reply||'本轮处理完成';
    $('latency').textContent='状态返回 '+seconds(activeTurn.browser.state_ms/1000)+' · 服务端处理 '+seconds(x.total_seconds)+(activeTurn.mode==='stream'?' · 流式语音':' · 完整语音');
  } else {
    phase('正在处理','waiting');
    $('reply').textContent='';
    $('interaction-hint').textContent='';
  }
  writeLog();
}
async function streamTurn(payload) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),245000);
  let reader,done=false;
  try {
    const response=await fetch('/api/turn-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload),signal:controller.signal});
    if(!response.ok) {const x=await response.json();throw serverError(response.status,x.detail)}
    if(!response.body) throw Error('浏览器不支持流式响应');
    reader=response.body.getReader();const decoder=new TextDecoder();let buffer='';
    const event=line=>{
      if(!line.trim()) return;
      if(done) throw Error('语音结束后仍收到数据');
      const {type,data}=JSON.parse(line);
      if(type==='state') updateResult(data);
      else if(type==='audio') {
        activeTurn.browser.first_audio_received_ms??=performance.now()-activeTurn.started;
        player.push(data);
      } else if(type==='done') {done=true;updateResult(data,true)}
      else if(type==='error') throw serverError(data.status,data.detail);
      // Unknown event types are ignored for forward compatibility.
    };
    while(true) {
      const packet=await reader.read();buffer+=decoder.decode(packet.value||new Uint8Array(),{stream:!packet.done});
      let newline;while((newline=buffer.indexOf('\n'))>=0) {event(buffer.slice(0,newline));buffer=buffer.slice(newline+1)}
      if(buffer.length>4000000) throw Error('语音事件过大');
      if(packet.done) break;
    }
    if(buffer.trim()) event(buffer);
    if(!done) throw Error('语音连接中断；已确认的车辆状态已保留，请核对后再发令。');
    activeTurn.browser.response_completed_ms=performance.now()-activeTurn.started;writeLog();
    const blob=player.wav();if(blob) setAudio(blob);
    addHistory(activeTurn.result);
    await player.finish();writeLog();
    if(player.muted&&blob&&!playbackStopped) playbackRecovery();
    else finishTurn(playbackStopped?'已停止播报':blob?'已完成':'未收到语音回复');
  } catch(e) {
    if(e.name==='AbortError') throw Error('等待语音超时；请核对已确认的车辆状态，勿重复发送。');
    throw e;
  } finally {clearTimeout(timer);if(reader) {try{await reader.cancel()}catch{}reader.releaseLock()}}
}
async function submit(payload,recordEnd=null) {
  if(busy||recording||!ready) return;
  setBusy(true);clearAudio();
  activeTurn={started:performance.now(),mode:streaming?'stream':'legacy',before:currentState?{...currentState}:null,input:payload.text,browser:{record_end:recordEnd},result:{}};
  $('log').textContent='等待本轮服务器回传';phase('正在处理','waiting');
  $('reply').textContent='';
  $('interaction-hint').textContent='';
  const waiting=()=>{$('wait-time').textContent='已等待 '+seconds((performance.now()-activeTurn.started)/1000);if(performance.now()-activeTurn.started>12000&&document.body.dataset.phase==='waiting') $('reply').textContent='响应较慢，请稍候'};
  waiting();waitTick=setInterval(waiting,200);
  try {
    if(streaming) {await player.unlock();activeTurn.started=performance.now();await streamTurn({session_id:session,...payload});return}
    activeTurn.started=performance.now();
    const x=await request('turn',{session_id:session,...payload},245000);
    activeTurn.browser.response_completed_ms=performance.now()-activeTurn.started;activeTurn.browser.first_audio_received_ms=activeTurn.browser.response_completed_ms;updateResult(x,true);addHistory(x);
    if(!x.audio) {finishTurn('未收到语音回复');return}
    setAudio(new Blob([Uint8Array.from(atob(x.audio),c=>c.charCodeAt(0))],{type:'audio/wav'}));
    stopWaiting();phase('正在播报','playing');$('stop-playback').hidden=false;
    try {await $('audio').play()} catch {playbackRecovery()}
  } catch(e) {
    player.stop();$('audio').pause();stopWaiting();$('stop-playback').hidden=true;$('replay').hidden=true;
    activeTurn.error={message:e.message,status:e.status,detail:e.detail};writeLog();
    phase('本轮未完成','error');$('reply').textContent=debugMode?e.message:e.status===409?'语音暂忙，请稍后再试':e.status===400?'没有听清，请再说一次':activeTurn.result.state||e.detail?.state?'语音未完成，请核对车辆状态':'连接异常，请稍后再试';
    $('interaction-hint').textContent='点击麦克风重新说话';
    addHistory({...activeTurn.result,reply:e.message},true);setBusy(false);
    if(!e.status||e.status>=500) {ready=false;setBusy(false);void health()}
  }
}
$('audio').onplaying=()=>{
  if(activeTurn&&activeTurn.mode==='legacy'&&activeTurn.browser.playback_started_ms==null) activeTurn.browser.playback_started_ms=performance.now()-activeTurn.started;
  writeLog();
};
$('audio').onended=()=>finishTurn();
$('audio').onerror=()=>{if(audioUrl) playbackRecovery()};
$('record').onclick=()=>recording?end():begin();
$('stop-playback').onclick=()=>{
  if(replaying) {$('audio').pause();finishTurn('已停止播报');return}
  playbackStopped=true;if(activeTurn) activeTurn.browser.playback_stopped_ms=performance.now()-activeTurn.started;
  $('audio').pause();player.stop();$('stop-playback').hidden=true;
  if(activeTurn?.mode==='stream'&&!player.finished) {phase('已停止播报 · 正在处理','waiting');$('interaction-hint').textContent='';writeLog()}
  else finishTurn('已停止播报');
};
$('replay').onclick=async()=>{
  if(busy||recording||!audioUrl) return;
  setBusy(true);replaying=true;$('audio').currentTime=0;$('replay').classList.remove('playback-recovery');phase('正在播报','playing');$('stop-playback').hidden=false;
  try {await $('audio').play()} catch {playbackRecovery()}
};
$('reset').onclick=async()=>{
  if(busy||recording||!ready) return;
  setBusy(true);clearAudio();phase('正在恢复初始状态','waiting');
  try {
    const x=await request('reset',{session_id:session});if(x.session_id) rememberSession(x.session_id);paint(x.state);
    activeTurn=null;$('reply').textContent='已恢复初始状态，可以开始新的对话';phase('准备就绪');$('log').textContent='车辆与服务端对话已复位';
    $('history').replaceChildren();$('history-empty').hidden=false;$('turn-count').textContent='0';turnCount=0;
    $('latency').textContent='已复位 · 等待新一轮对话';window.vehicleVoiceMetrics=window.__vehicleMetrics=null;
  } catch(e) {phase('复位未完成','error');$('reply').textContent=e.message}
  setBusy(false);
};
function playbackRecovery() {
  finishTurn('声音未能播放');clearTimeout(settleTimer);
  $('replay').classList.add('playback-recovery');$('replay').hidden=false;
  $('interaction-hint').textContent='点击重播收听';
}
$('reconnect').onclick=health;
$('toggle-details').onclick=()=>{const open=$('details').hidden;$('details').hidden=!open;$('toggle-details').setAttribute('aria-expanded',String(open));$('toggle-details').textContent=open?'收起详情 ↑':'联调详情 ↓'};
$('text-form').onsubmit=e=>{e.preventDefault();const text=$('text').value.trim();if(text&&!busy&&!recording&&ready){$('text').value='';void submit({text})}};
for(const el of document.querySelectorAll('[data-prompt]')) el.onclick=()=>{$('text').value=el.dataset.prompt;$('text').focus()};
const clock=()=>$('clock').textContent=new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'});clock();setInterval(clock,1000);
void health();setInterval(health,15000);
window.addEventListener('pagehide',()=>{clearInterval(tick);clearTimeout(autoStop);stopWaiting();stream?.getTracks().forEach(t=>t.stop());player.stop();$('audio').pause();if(audioUrl)URL.revokeObjectURL(audioUrl)});
