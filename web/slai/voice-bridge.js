import './app.js?v=rose-20261016';
import {ContinuousMic} from './voice-activity.mjs';
import {wavBase64} from './voice-wav.mjs';
const cockpit=window.slaiCockpit,$=id=>document.getElementById(id);
const micAvailable=globalThis.isSecureContext!==false;
if(!micAvailable){$('voice-network-note').hidden=false;$('voice-record').title='局域网录音需要 HTTPS，请先用键盘输入';}
let sid=sessionStorage.getItem('slai-session')||'',ready=false,busy=false,checking=false,recording=false;
let mic,context,worklet,samples=[],sampleRate,start,stopTimer,replayURL;
const replay=new Audio(),player=new PCMStreamPlayer(()=>phase('speaking','正在播报'),{startupBufferMs:160});
let log={},localDirty=false,connectionLabel='实时语音交互',activeProfile='',switching=false;
function write(){ $('voice-log').textContent=JSON.stringify({...log,playback:player.metrics},null,2); }
const continuous=new ContinuousMic({
 onUtterance:(chunks,rate)=>submit({audio:wavBase64(chunks,rate)}),
 onStatus:status=>{
  $('voice-continuous').setAttribute('aria-checked',String(continuous.enabled));
  if(status==='opening')phase('listening','正在开启麦克风');
  else if(status==='listening'||status==='speech')phase('listening',status==='speech'?'正在听 · 停顿后发送':'连续对话 · 请说话');
  else if(status==='off'&&!busy)phase(ready?'idle':'disconnected',ready?'语音已连接':'语音未连接');
 },
 onError:e=>cockpit.notify(e.name==='NotAllowedError'?'请允许麦克风权限后重新开启连续对话':e.message,'',true)
});
function settle(){
 phase(ready?'idle':'disconnected',ready?'语音已连接':'连接异常');
 if(continuous.enabled&&ready)continuous.resume();
}
function updateModelControls(){const locked=busy||recording||checking||switching||continuous.enabled;$('voice-clear-history').disabled=busy||recording||checking||switching||!ready;$('remote-model-select').disabled=locked||!activeProfile;$('remote-model-switch').disabled=locked||!activeProfile||$('remote-model-select').value===activeProfile;}
function phase(kind,label){updateModelControls();cockpit.setVoicePhase(kind);$('voice-status').replaceChildren(document.createTextNode(label),Object.assign(document.createElement('small'),{textContent:continuous.enabled?(busy?'回复结束后自动继续听':'停顿约1秒自动发送 · 再点开关关闭'):(ready?connectionLabel:'本地演示 · 遥控器可用')}));$('voice-record').textContent=recording?'结束':'说话';$('voice-record').setAttribute('aria-label',recording?'结束录音':'开始录音');$('voice-record').hidden=continuous.enabled;$('voice-record').disabled=!micAvailable||busy||checking||(!ready&&!recording);$('voice-continuous').disabled=!micAvailable||(!continuous.enabled&&(busy||recording||checking||!ready));$('voice-continuous').title=continuous.enabled?label+'；点击关闭麦克风':'开启后直接说话，停顿约一秒自动发送';$('voice-reconnect').disabled=busy||recording||checking||continuous.enabled;$('voice-replay').disabled=busy||recording||(continuous.enabled&&!continuous.worklet);}
function remember(x){sid=x.session_id;sessionStorage.setItem('slai-session',sid);}
function consume(x){if(x.session_id)remember(x);if(x.state)cockpit.applyServerState(x.state);}
function failure(status,detail){if(detail?.state)consume(detail);const e=Error(typeof detail==='string'?detail:detail?.error||'服务暂时不可用');e.status=status;return e;}
async function request(path,data,timeout=10000){const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),timeout);try{const r=await fetch('/api/'+path,{method:data?'POST':'GET',headers:data?{'Content-Type':'application/json'}:{},body:data?JSON.stringify({profile:'slai',session_id:sid,...data}):undefined,signal:abort.signal});let x;try{x=await r.json();}catch{const e=Error('服务返回异常，请核对车辆状态后重试');e.status=r.status;throw e;}if(!r.ok)throw failure(r.status,x.detail);return x;}finally{clearTimeout(timer);}}
async function connect(){if(busy||recording||checking||continuous.enabled)return;checking=true;if(!ready)phase('disconnected','正在连接');try{const selected=await request('connection-settings');if(activeProfile&&selected.profile!==activeProfile){sid='';sessionStorage.removeItem('slai-session');}if(activeProfile!==selected.profile)$('remote-model-select').value=selected.profile;activeProfile=selected.profile;const h=await request('health');connectionLabel=h.model?.includes('checkpoint-48')?'车载 checkpoint-48 · 无历史':'实时语音交互';document.title=h.model?.includes('checkpoint-48')?'SLAI · 车载 checkpoint-48 测试':'SLAI · 智能座舱';$('remote-model-status').textContent='当前：'+(h.model||activeProfile)+(h.engine_info?.history_mode==='disabled'?' · 历史已关闭，每轮只读当前车况':'');if(!h.ready||!h.streaming_audio||!h.profiles?.includes('slai'))throw Error('服务器尚未启用新版座舱接口');const session=await request('session',{});if(busy||recording)return;consume(session);ready=true;if(localDirty){localDirty=false;cockpit.notify('语音已连接，已同步服务器状态；本地演示调整不会上传');}log={...log,connection:h};phase('idle','语音已连接');}catch(e){ready=false;log={...log,connection_error:e.message};phase('disconnected','语音未连接');}finally{checking=false;phase(ready?'idle':'disconnected',ready?'语音已连接':'语音未连接');write();}}
function guard(){if(switching||checking)throw Error('正在连接模型，请稍候');if(continuous.enabled&&!continuous.worklet)throw Error('正在开启麦克风，请稍候');if(busy||recording)throw Error('请等待本轮语音结束');if(!ready)throw Error('语音服务未连接，请点击连接后重试');}
async function action(p,{source}={}){if(!ready&&!busy&&!recording){busy=true;localDirty=true;phase('disconnected','本地演示');try{const result=await cockpit.previewAction(p);log={source:'local-preview',requested:p,state:result};write();return result;}finally{busy=false;phase('disconnected','语音未连接');}}try{guard();}catch(e){cockpit.notify(e.message,'',true);throw e;}try{continuous.pause();busy=true;cockpit.beginFeedback();phase('processing','正在执行');await cockpit.unlockMedia();const x=await request(source==='reset'?'reset':'control',source==='reset'?{}:{patch:p});consume(x);cockpit.notify(source==='reset'?'已恢复初始设置':'设置已确认');log={source:'touch',requested:p,result:x};write();return cockpit.read();}catch(e){cockpit.notify(e.message,'',true);throw e;}finally{busy=false;settle();}}
async function submit(payload){
 let reader,abort,timer;
 try{guard();}catch(e){cockpit.notify(e.message,'',true);return;}
 try{continuous.pause();busy=true;cockpit.beginFeedback();player.reset();replay.pause();$('voice-replay').hidden=true;log={input:payload.text||'语音输入',started:performance.now()};phase('processing','正在理解');await player.unlock();await cockpit.unlockMedia();
  abort=new AbortController();timer=setTimeout(()=>abort.abort(),245000);
  const requestId=globalThis.crypto?.randomUUID?.()||`${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response=await fetch('/api/turn-stream',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({profile:'slai',session_id:sid,...payload,request_id:requestId}),signal:abort.signal});
  if(!response.ok){const x=await response.json();throw failure(response.status,x.detail);}
  reader=response.body.getReader();const decoder=new TextDecoder();let buffer='',done=false;
  const event=line=>{if(!line.trim())return;if(done)throw Error('语音结束后仍收到数据');const {type,data}=JSON.parse(line);
   if(type==='state'){consume(data);log.state=data;log.state_ms=performance.now()-log.started;if(data.agent_reply){cockpit.notifyAction(data.agent_reply,data.input_text);log.first_feedback_ms??=performance.now()-log.started;}}
   else if(type==='transcript'){cockpit.notifyTranscript(data.text,data.input_text);log.first_text_ms??=performance.now()-log.started;}
   else if(type==='audio'){if(!log.state)throw Error('语音先于车控结果到达');log.first_audio_ms??=performance.now()-log.started;player.push(data);}
   else if(type==='done'){consume(data);log.result=data;if(data.reply)cockpit.notify(data.reply,data.input_text);done=true;}
   else if(type==='error')throw failure(data.status,data.detail);
  };
  while(true){const item=await reader.read();buffer+=decoder.decode(item.value||new Uint8Array(),{stream:!item.done});let n;while((n=buffer.indexOf('\n'))>=0){event(buffer.slice(0,n));buffer=buffer.slice(n+1);}if(buffer.length>4000000)throw Error('语音事件过大');if(item.done)break;}
  if(buffer.trim())event(buffer);if(!done)throw Error('语音连接中断；已确认的车辆状态已保留，请核对后再发令');
  const blob=player.wav();if(blob){if(replayURL)URL.revokeObjectURL(replayURL);replayURL=URL.createObjectURL(blob);replay.src=replayURL;$('voice-replay').hidden=false;}
  await player.finish();if(player.muted){continuous.stop();}if(player.muted)cockpit.notify('状态已确认，声音未能播放，请点击重播','',true);
 }catch(e){continuous.stop();player.stop();log.error=e.message;cockpit.notify(e.name==='AbortError'?'等待超时，请核对车辆状态后再发令':e.message,'',true);if(!e.status||e.status>=500)ready=false;}
 finally{clearTimeout(timer);if(reader){try{await reader.cancel();}catch{}reader.releaseLock();}busy=false;write();settle();}
}
async function release(){clearTimeout(stopTimer);if(worklet){worklet.port.onmessage=null;worklet.disconnect();worklet=null;}mic?.getTracks().forEach(t=>t.stop());mic=null;if(context){await context.close();context=null;}}
async function begin(){try{guard();busy=true;phase('processing','开启麦克风');await player.unlock();replay.pause();mic=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:false,autoGainControl:false}});context=new AudioContext();await context.resume();sampleRate=context.sampleRate;await context.audioWorklet.addModule('../recorder.js');worklet=new AudioWorkletNode(context,'pcm-recorder');samples=[];worklet.port.onmessage=e=>samples.push(e.data);const source=context.createMediaStreamSource(mic),silent=context.createGain();silent.gain.value=0;source.connect(worklet);worklet.connect(silent).connect(context.destination);recording=true;start=performance.now();busy=false;phase('listening','正在听 · 点击结束');stopTimer=setTimeout(end,19500);}catch(e){await release();busy=false;cockpit.notify(e.name==='NotAllowedError'?'请允许麦克风权限':e.message,'',true);phase(ready?'idle':'disconnected',ready?'语音已连接':'语音未连接');}}
async function end(){if(!recording)return;recording=false;busy=true;const elapsed=performance.now()-start;await release();busy=false;if(elapsed<300||!samples.length){cockpit.notify('录音太短，请再说一次','',true);phase('idle','语音已连接');return;}const audio=wavBase64(samples,sampleRate);samples=[];await submit({audio});}
async function switchModel(){
 if(busy||recording||checking||switching||continuous.enabled)return;
 const target=$('remote-model-select').value;
 if(target===activeProfile)return;
 switching=true;busy=true;updateModelControls();
 $('remote-model-status').textContent='正在切换到：'+($('remote-model-select').selectedOptions?.[0]?.textContent||target)+'…';
 phase('processing','正在切换模型');
 let changed=false;
 try{
  await request('connection-settings',{profile:target},15000);
  changed=true;ready=false;sid='';sessionStorage.removeItem('slai-session');
  replay.pause();player.stop();if(replayURL){URL.revokeObjectURL(replayURL);replayURL=null;}
  $('voice-replay').hidden=true;cockpit.beginFeedback();log={};
 }catch(e){
  $('remote-model-select').value=activeProfile;
  $('remote-model-status').textContent='切换失败，仍连接 '+activeProfile+'：'+e.message;
  cockpit.notify(e.message,'',true);
 }finally{
  switching=false;busy=false;
  if(changed){await connect();if(ready)cockpit.notify('模型已切换，已开始新对话');}
  else phase(ready?'idle':'disconnected',ready?'语音已连接':'语音未连接');
 }
}
async function clearConversation(){
 if(busy||recording||checking||switching||!ready)return;
 continuous.stop();busy=true;phase('processing','正在清空对话');
 try{
  const result=await request('clear-history',{});
  consume(result);replay.pause();player.stop();
  if(replayURL){URL.revokeObjectURL(replayURL);replayURL=null;}
  $('voice-replay').hidden=true;cockpit.beginFeedback();
  log={connection:log.connection,history_cleared:true};write();
  cockpit.notify('对话已清空，当前车况保持不变');
 }catch(e){cockpit.notify(e.message,'',true);}
 finally{busy=false;settle();}
}
$('voice-clear-history').onclick=clearConversation;
$('remote-model-select').onchange=switchModel;
$('remote-model-switch').onclick=switchModel;
cockpit.setCommandTransport({action,turn:text=>submit({text})});
$('voice-continuous').onclick=async()=>{
 if(continuous.enabled){continuous.stop();return;}
 if(busy||recording||checking||!ready)return;
 replay.pause();void player.unlock();void cockpit.unlockMedia();await continuous.start();
};
$('voice-record').onclick=()=>recording?end():begin();$('voice-reconnect').onclick=connect;
$('voice-replay').onclick=async()=>{if(busy||recording||!replayURL)return;continuous.pause();busy=true;phase('speaking','正在重播');try{replay.currentTime=0;await replay.play();}catch(e){continuous.stop();busy=false;cockpit.notify('声音未能播放，请检查浏览器声音设置','',true);phase('idle','语音已连接');}};
replay.onended=()=>{busy=false;settle();};
replay.onerror=()=>{continuous.stop();busy=false;phase(ready?'idle':'disconnected','声音播放失败');};
addEventListener('visibilitychange',()=>{if(document.hidden&&continuous.enabled)continuous.stop();});
addEventListener('pagehide',()=>{continuous.stop();void release();player.stop();replay.pause();if(replayURL)URL.revokeObjectURL(replayURL);});
void connect();setInterval(connect,15000);
