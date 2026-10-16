// Acoustic endpointing for the existing whole-utterance HTTP API.
// It detects sound energy, not meaning; server semantic VAD remains a future upgrade.
export class VoiceActivity {
  constructor(sampleRate) { this.rate=sampleRate; this.noise=.002; this.reset(); }
  reset() { this.pre=[]; this.preMs=0; this.chunks=[]; this.active=false; this.onset=0; this.voiced=0; this.silence=0; this.duration=0; }
  push(chunk) {
    const ms=chunk.length/this.rate*1000;
    let energy=0; for(const x of chunk) energy+=x*x;
    const rms=Math.sqrt(energy/chunk.length);
    const loud=rms>Math.max(.012,Math.min(.045,this.noise*3));
    if(!this.active) {
      if(!loud) this.noise=.99*this.noise+.01*rms;
      this.pre.push(chunk); this.preMs+=ms;
      while(this.preMs>350+ms) this.preMs-=this.pre.shift().length/this.rate*1000;
      this.onset=loud?this.onset+ms:0;
      if(this.onset<100) return null;
      this.active=true; this.chunks=this.pre; this.pre=[];
      this.duration=this.preMs; this.voiced=this.onset;
      return {type:'start'};
    }
    this.chunks.push(chunk); this.duration+=ms;
    if(loud) {this.voiced+=ms;this.silence=0;} else this.silence+=ms;
    // Do not submit a truncated command if sustained noise/speech hits the limit.
    if(this.duration>=19000) {this.reset();return {type:'limit'};}
    if(this.silence>=1000) {
      const chunks=this.chunks, valid=this.voiced>=240;
      this.reset(); return {type:valid?'utterance':'discard',chunks:valid?chunks:[]};
    }
    return null;
  }
}

export class ContinuousMic {
  constructor({onUtterance,onStatus,onError}) {
    Object.assign(this,{onUtterance,onStatus,onError}); this.epoch=0; this.enabled=false;this.listening=false;
  }
  async start() {
    const epoch=++this.epoch; this.enabled=true;this.onStatus('opening');
    try {
      const stream=await navigator.mediaDevices.getUserMedia({audio:{channelCount:1,echoCancellation:true,noiseSuppression:true,autoGainControl:true}});
      if(epoch!==this.epoch) {stream.getTracks().forEach(t=>t.stop());return;}
      this.stream=stream;
      for(const track of stream.getTracks()) track.onended=()=>this.fail(Error('麦克风已断开，请重新开启连续对话'));
      const context=this.context=new AudioContext();
      await context.resume(); await context.audioWorklet.addModule('../recorder.js');
      if(epoch!==this.epoch) return;
      this.detector=new VoiceActivity(context.sampleRate);
      const worklet=this.worklet=new AudioWorkletNode(context,'pcm-recorder');
      worklet.port.onmessage=({data})=>{
        if(!this.enabled||!this.listening) return;
        const event=this.detector.push(data);
        if(event?.type==='start') this.onStatus('speech');
        if(event?.type==='discard') this.onStatus('listening');
        if(event?.type==='limit') {this.fail(Error('这段声音超过19秒，未提交。请重新开启，分句说话'));return;}
        if(event?.type==='utterance') {
          this.pause();
          Promise.resolve().then(()=>{if(this.enabled&&epoch===this.epoch)return this.onUtterance(event.chunks,context.sampleRate);}).catch(e=>this.fail(e));
        }
      };
      this.source=context.createMediaStreamSource(stream);
      this.silent=context.createGain();this.silent.gain.value=0;
      this.source.connect(worklet);worklet.connect(this.silent).connect(context.destination);
      this.resume(0);
    } catch(e) {if(epoch===this.epoch)this.fail(e);}
  }
  pause() {
    clearTimeout(this.resumeTimer);this.listening=false;this.detector?.reset();
    this.stream?.getTracks().forEach(t=>{t.enabled=false;});
  }
  resume(delay=450) {
    if(!this.enabled||!this.worklet)return;
    this.pause(); const epoch=this.epoch;
    this.resumeTimer=setTimeout(()=>{
      if(!this.enabled||epoch!==this.epoch)return;
      this.detector.reset();this.stream.getTracks().forEach(t=>{t.enabled=true;});
      this.listening=true;this.onStatus('listening');
    },delay);
  }
  stop() {
    ++this.epoch;this.enabled=false;this.pause();
    this.stream?.getTracks().forEach(t=>{t.onended=null;t.stop();});this.stream=null;
    if(this.worklet){this.worklet.port.onmessage=null;this.worklet.disconnect();this.worklet=null;}
    this.source?.disconnect();this.silent?.disconnect();
    const context=this.context;this.context=null;
    if(context&&context.state!=='closed')void context.close().catch(()=>{});
    this.onStatus('off');
  }
  fail(error) {this.stop();this.onError(error);}
}
