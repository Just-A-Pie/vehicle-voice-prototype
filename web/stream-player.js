/* PCM chunks share one audio clock; measurements describe browser scheduling,
   not an acoustic loopback measurement of the device's speaker output. */
class PCMStreamPlayer {
  constructor(onStart, options={}) { this.startupBufferMs=options.startupBufferMs??80; this.onStart=onStart; this.context=null; this.reset(); }
  reset() {
    this.stop(); this.parts=[]; this.pending=[]; this.pendingSamples=0;
    this.sampleRate=null; this.nextSequence=0; this.nextTime=0;
    this.started=false; this.finished=false; this.muted=false; this.sources=new Set();
    this.metrics={audio_chunks:0,audio_seconds:0,underruns:0,max_gap_ms:0,startup_buffer_ms:this.startupBufferMs,startup_scheduling_lead_ms:20,recovery_scheduling_lead_ms:40,scheduling_lead_ms:20};
  }
  async unlock() {
    try {
      this.context ||= new AudioContext();
      await this.context.resume();
      this.muted=this.context.state!=='running';
    } catch { this.muted=true; }
    return !this.muted;
  }
  push(data) {
    const {sample_rate:rate,channels,sequence,pcm}=data;
    if(channels!==1 || !Number.isInteger(rate) || rate<8000 || rate>96000 || sequence!==this.nextSequence || (this.sampleRate && rate!==this.sampleRate)) throw Error('语音分块格式或顺序异常');
    const raw=Uint8Array.from(atob(pcm),c=>c.charCodeAt(0));
    if(!raw.length || raw.length%2) throw Error('语音分块不完整');
    this.sampleRate=rate; this.nextSequence++; this.parts.push(raw);
    this.metrics.audio_chunks++; this.metrics.audio_seconds+=raw.length/2/rate;
    if(this.muted) return;
    this.pending.push(raw); this.pendingSamples+=raw.length/2;
    // Accumulate 80 ms of PCM before startup; short complete replies flush at finish.
    // This is an audio-length threshold, not an 80 ms wall-clock wait.
    if(this.started || this.pendingSamples/rate>=this.startupBufferMs/1000) this.flush();
  }
  flush() {
    if(this.muted || !this.pending.length) return;
    if(this.context?.state!=='running') { this.muted=true; return; }
    const now=this.context.currentTime;
    // scheduling_lead_ms remains a compatibility alias for the startup lead.
    let startAt=this.started?this.nextTime:now+.02;
    if(this.started && this.nextTime<now+.008) {
      // Recover with 40 ms lead if the next chunk missed its scheduling margin.
      startAt=now+.04;this.metrics.underruns++;
      this.metrics.max_gap_ms=Math.max(this.metrics.max_gap_ms,(startAt-this.nextTime)*1000);
    }
    if(!this.started) this.metrics.startup_buffered_ms=this.pendingSamples/this.sampleRate*1000;
    const data=this.context.createBuffer(1,this.pendingSamples,this.sampleRate);
    const channel=data.getChannelData(0); let offset=0;
    for(const raw of this.pending) {
      const view=new DataView(raw.buffer,raw.byteOffset,raw.byteLength);
      for(let i=0;i<raw.length;i+=2) channel[offset++]=view.getInt16(i,true)/32768;
    }
    this.pending=[]; this.pendingSamples=0;
    const node=this.context.createBufferSource(); node.buffer=data; node.connect(this.context.destination);
    this.sources.add(node); node.onended=()=>{node.disconnect();this.sources.delete(node)};
    node.start(startAt); this.nextTime=startAt+data.duration;
    if(!this.started) {
      this.started=true;
      this.metrics.first_audio_scheduled_at=performance.now()+(startAt-now)*1000;
      this.metrics.output_latency_ms=Number.isFinite(this.context.outputLatency)?this.context.outputLatency*1000:null;
      this.startTimer=setInterval(()=>{
        if(this.context.currentTime>=startAt) {
          clearInterval(this.startTimer); this.startTimer=null;
          this.metrics.playback_started_at=performance.now();this.onStart?.();
        }
      },15);
    }
  }
  async finish() {
    this.finished=true; this.flush();
    if(!this.muted && this.sources.size) await new Promise(resolve=>{
      this.finishResolve=resolve;
      this.finishTimer=setInterval(()=>{
        if(this.context.state!=='running') {this.muted=true;this.stop();}
        else if(!this.sources.size) {clearInterval(this.finishTimer);this.finishTimer=null;this.finishResolve=null;resolve();}
      },30);
    });
    this.metrics.playback_completed_at=this.started&&!this.muted?performance.now():null;
  }
  stop() {
    clearInterval(this.startTimer); clearInterval(this.finishTimer);
    this.startTimer=null; this.finishTimer=null;
    for(const source of this.sources||[]) {source.onended=null;try{source.stop()}catch{}source.disconnect()}
    this.sources?.clear(); this.pending=[];this.pendingSamples=0;this.muted=true;
    if(this.finishResolve) {this.finishResolve();this.finishResolve=null;}
  }
  wav() {
    if(!this.parts.length) return null;
    const length=this.parts.reduce((n,p)=>n+p.length,0),header=new ArrayBuffer(44),v=new DataView(header);
    const str=(offset,value)=>[...value].forEach((c,i)=>v.setUint8(offset+i,c.charCodeAt(0)));
    str(0,'RIFF');v.setUint32(4,36+length,true);str(8,'WAVE');str(12,'fmt ');
    v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,this.sampleRate,true);
    v.setUint32(28,this.sampleRate*2,true);v.setUint16(32,2,true);v.setUint16(34,16,true);str(36,'data');v.setUint32(40,length,true);
    return new Blob([header,...this.parts],{type:'audio/wav'});
  }
}
