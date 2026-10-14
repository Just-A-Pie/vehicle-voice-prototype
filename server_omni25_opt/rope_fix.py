"""Process-local compatibility fix for Transformers issue #47328.
Only the Token2Wav DiT rotary layout is changed, never Thinker/Talker.
"""
import inspect,types,torch
from transformers.models.qwen2_5_omni import modeling_qwen2_5_omni as mod
def apply(net):
 rot=net.token2wav.code2wav_dit_model.rotary_embed
 original=rot.forward
 broken='rotate_half_codec' in inspect.getsource(mod.apply_rotary_pos_emb) and 'torch.cat' in inspect.getsource(original)
 if not broken:return False
 def forward(self,*args,**kwargs):
  cos,sin=original(*args,**kwargs)
  return cos[...,:cos.shape[-1]//2].repeat_interleave(2,dim=-1),sin[...,:sin.shape[-1]//2].repeat_interleave(2,dim=-1)
 rot.forward=types.MethodType(forward,rot)
 return True
