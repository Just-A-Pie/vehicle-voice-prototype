class Recorder extends AudioWorkletProcessor {process(inputs){const a=inputs[0];if(a?.[0])this.port.postMessage(a[0].slice());return true}}registerProcessor('pcm-recorder',Recorder);
