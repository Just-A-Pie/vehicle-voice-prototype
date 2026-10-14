"""CUDA native audio -> one JSON decision -> execution -> model-authored reply speech."""
import time,torch
from transformers import LogitsProcessor,LogitsProcessorList
class SentenceEnd(LogitsProcessor):
 def __init__(self,tokenizer,start,eos):self.tokenizer=tokenizer;self.start=start;self.eos=eos
 def __call__(self,ids,scores):
  if ids.shape[1]>self.start and any(c in self.tokenizer.decode(ids[0,self.start:],skip_special_tokens=True) for c in "。！？\n"):
   scores.fill_(-float("inf"));scores[:,self.eos]=0
  return scores
from single_call import SingleDecisionMixin, PROTOCOL
from small_model_eval.backend import SmallOmniBackend,IDENTITY
class NativeBackend(SingleDecisionMixin, SmallOmniBackend):
 def __init__(self,path):
  super().__init__(path);self.sessions={};self.text_sink=None;self.parts=[]
  from server_omni25_opt.rope_fix import apply
  self.engine_info["token2wav_rope_layout_fixed"]=apply(self.net)
  for name,component in [('thinker',self.net.thinker),('talker',self.net.talker)]:
   original=component.generate
   def timed(*args,_fn=original,_name=name,**kwargs):
    if _name=='thinker' and getattr(self,'short_speech',False) and not getattr(self,'constrained_confirmation',False):
     ids=kwargs.get('input_ids');start=ids.shape[1] if ids is not None else 0
     eos=self.net.thinker.generation_config.eos_token_id
     if isinstance(eos,list):eos=eos[0]
     kwargs['logits_processor']=LogitsProcessorList([SentenceEnd(self.processor.tokenizer,start,eos)])
    torch.cuda.synchronize();t=time.monotonic();result=_fn(*args,**kwargs);torch.cuda.synchronize()
    self.parts.append({'stage':_name,'seconds':time.monotonic()-t});return result
   component.generate=timed
  self.net.token2wav.register_forward_pre_hook(self._wav_start)
  self.net.token2wav.register_forward_hook(self._wav_end)
  self.engine_info.update({'mode':'single-decision-native-audio','protocol':PROTOCOL,'speech_text_constraint':'released-model-reply','semantic_calls_per_turn':1,'speech_generation_separate':True})
 def _wav_start(self,module,args):
  torch.cuda.synchronize();self.wav_start=time.monotonic()
 def _wav_end(self,module,args,result):
  torch.cuda.synchronize();self.parts.append({'stage':'waveform','seconds':time.monotonic()-self.wav_start})
 def generate(self,messages,audio=False,force_text=None,max_new_tokens=None):
  self.short_speech=audio;self.constrained_confirmation=force_text is not None;self.parts=[]
  result=super().generate(messages,audio,force_text,max_new_tokens=max_new_tokens)
  if self.trace:self.trace[-1]['components']=list(self.parts)
  return result
