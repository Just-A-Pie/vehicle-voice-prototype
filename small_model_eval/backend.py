"""Qwen2.5-Omni BF16 reference adapter. Full audio output, NOT streaming generation."""
import base64,time,os
import numpy as np
import torch
from transformers import Qwen2_5OmniForConditionalGeneration,Qwen2_5OmniProcessor
from qwen_omni_utils import process_mm_info
from qwen_agent.llm.function_calling import BaseFnCallModel
from qwen_agent.llm.schema import Message
from small_model_eval.tool_format import normalize_tool_response
IDENTITY='You are Qwen, a virtual human developed by the Qwen Team, Alibaba Group, capable of perceiving auditory and visual inputs, as well as generating text and speech.'
class SmallOmniBackend(BaseFnCallModel):
 def __init__(self,path):
  super().__init__({'model':path.rsplit('/',1)[-1],'generate_cfg':{'fncall_prompt_type':'nous','max_input_tokens':8192}})
  self.model_name=path.rsplit('/',1)[-1];self.audio_sink=None;self.audit=None;self.calls=0;self.trace=[];self.timings=[];self.stage='agent'
  self.processor=Qwen2_5OmniProcessor.from_pretrained(path,local_files_only=True)
  self.net=Qwen2_5OmniForConditionalGeneration.from_pretrained(path,dtype=torch.bfloat16,device_map={'':0},attn_implementation='sdpa',local_files_only=True)
  self.engine_info={'engine':'transformers','precision':'BF16','speech_model':self.model_name,'native_audio_streaming':False,'transport_audio':'single_complete_chunk','gpu':torch.cuda.get_device_name(0),'devices':1}
 @property
 def support_multimodal_input(self):return True
 @property
 def support_audio_input(self):return True
 def convert(self,messages):
  out=[]
  for m in messages:
   content=m.content
   if not isinstance(content,str):
    content=[{'type':'text','text':i.text} if i.text is not None else {'type':'audio','audio':i.audio} for i in content if i.text is not None or i.audio]
   out.append({'role':m.role,'content':content})
  return out
 @torch.inference_mode()
 def generate(self,messages,audio=False,force_text=None,max_new_tokens=None):
  t=time.monotonic();stage='speech' if audio else self.stage
  text=self.processor.apply_chat_template(messages,add_generation_prompt=True,tokenize=False)
  audios,images,videos=process_mm_info(messages,use_audio_in_video=False)
  inputs=self.processor(text=text,audio=audios,images=images,videos=videos,return_tensors='pt',padding=True,use_audio_in_video=False).to('cuda').to(torch.bfloat16)
  extra={};max_tokens=max_new_tokens if max_new_tokens is not None else (192 if not audio else 96)
  if force_text is not None:
   tokens=self.processor.tokenizer.encode(force_text,add_special_tokens=False)
   eos=self.net.thinker.generation_config.eos_token_id
   if isinstance(eos,list):eos=eos[0]
   tokens.append(eos);prompt_length=inputs.input_ids.shape[1]
   def allowed(batch_id,ids):return [tokens[min(len(ids)-prompt_length,len(tokens)-1)]]
   extra['thinker_prefix_allowed_tokens_fn']=allowed;max_tokens=len(tokens)
  result=self.net.generate(**inputs,return_audio=audio,thinker_max_new_tokens=max_tokens,talker_max_new_tokens=512,thinker_do_sample=False,use_audio_in_video=False,**extra)
  ids,wav=result if isinstance(result,tuple) else (result,None)
  seq=ids.sequences if hasattr(ids,'sequences') else ids
  reply=self.processor.batch_decode(seq[:,inputs.input_ids.shape[1]:],skip_special_tokens=True,clean_up_tokenization_spaces=False)[0]
  samples=wav.reshape(-1).float().cpu().numpy() if wav is not None else None
  if samples is not None and self.audio_sink:
   pcm=np.clip(np.rint(samples*32768),-32768,32767).astype('<i2').tobytes()
   self.audio_sink({'pcm':base64.b64encode(pcm).decode(),'sample_rate':24000,'channels':1,'sequence':0})
  entry={'stage':stage,'seconds':time.monotonic()-t,'output':reply,'tokens':int(seq.shape[1]-inputs.input_ids.shape[1]),'peak_gpu_bytes':torch.cuda.max_memory_allocated(),'gpu_bytes':torch.cuda.memory_allocated()}
  self.trace.append(entry);self.timings.append(entry)
  if self.audit:self.audit('model_output',entry)
  return reply,samples
 def _chat_no_stream(self,messages,generate_cfg):
  self.calls+=1
  if self.calls>4:raise RuntimeError('模型工具调用超出本轮限制')
  text,_=self.generate(self.convert(messages));normalized=normalize_tool_response(text)
  if normalized!=text and self.audit:self.audit('tool_format_normalized',{'raw':text,'normalized':normalized})
  return [Message(role='assistant',content=normalized)]
 def _chat_stream(self,messages,delta_stream,generate_cfg):yield self._chat_no_stream(messages,generate_cfg)
 def transcribe(self,path):
  self.stage='transcription'
  try:return self.generate([{'role':'system','content':'请逐字转写音频，只输出原话，不要回答或执行。'},{'role':'user','content':[{'type':'audio','audio':path}]}])[0].strip()
  finally:self.stage='agent'
 def speak(self,text):return self.generate([{'role':'system','content':IDENTITY},{'role':'user','content':'请严格原样朗读下面这句话，不要添加任何文字：'+text}],audio=True,force_text=text if os.environ.get('OMNI_FORCE_SPEECH_TEXT')=='1' else None)
