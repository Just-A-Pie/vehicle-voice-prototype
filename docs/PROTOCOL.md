> 本文保留 Qwen2.5-Omni 原方案；macOS 展示部署请看 [MACOS_DEMO.md](MACOS_DEMO.md)，checkpoint-48 合同请看 [MODEL_CONTRACT.md](MODEL_CONTRACT.md)。

# 与数据集工作线的共同约定

协议：`cabin-single-decision-v1`。模型输出纯JSON，只有 `tool_calls` 和 `reply`。

- `tool_calls`：空数组或一个 `{name:"control_cabin", arguments:{...}}`。多项操作合并在一个稀疏patch中，不复制完整状态。
- `reply.text`：模型生成的简短中文回复；`reply.when`：空调用必须 `immediate`，有调用必须 `after_success`。
- 成功后放行LLM原文。程序不按confirmation模板重写成功回复；失败时用程序提示，不播放预先写好的成功文案。
- 完整解析和参数检查通过之前，不执行、不播报。JSON截断、重复键、非法参数、未知工具均拒绝；不自动调用模型修复。
- 原始音频直接进入Omni；不能用外部ASR的转写作为唯一理解入口替代这一能力。
- 实际回执、完整终态仅供执行、历史和校验，不能提前作为本轮训练输入。

## 行为规则

温度16–28℃/0.5℃步长；风量1–5整数；音量0–1/0.01步长；门窗0–100整数。具体范围、枚举和联动以 `cabin.py` / `cabin_contract.json` 为准。

“不要打开”不等于关闭；“不要关闭”不等于打开；取消保持当前状态，不自动撤销已完成动作；取消静音是执行。含糊要求先澄清。未指定位置的门/窗默认全部。相对调节依据当前状态。复位独占 `reset:true`。查询不修改状态。

锁车关门、开门解锁、设温度/风量联动空调等是执行器效果，不应被误判为模型额外传参。评估同时检查模型显式参数和完整执行状态。

## HTTP与事件

使用 `profile:"slai"`。`POST /session` 创建会话；`POST /turn-stream` 提交 `session_id`、`request_id` 以及 `text` 或base64 WAV `audio` 二选一。音频输入16kHz单声道，0.2–20秒。

回复是NDJSON事件：初始state → 执行后state → transcript → audio → done；错误可产生error事件。成功回复不能在执行确认前显示。audio为24kHz单声道PCM16，带从0递增的sequence。双卡vLLM后端在模型生成期间发送多个音频块；HF参考后端发送一个完整音频块。

同会话最近64个request_id去重；重复返回409。播报失败不重做已经执行的动作。手动控制/复位清除模型历史但保留近期ID。该去重不跨进程重启持久化。

最近两轮历史包含真实输入、回执和实际发出的回复。当前状态优先于历史。优化历史缓存不能引入过期状态、把未执行草稿当事实或丢失原始音频。

## 两条工作线如何协作

项目负责人负责数据集内容与语义标注；加速同事负责推理引擎、精度、缓存、调度和音频生成/传输性能。`single_call.py`中的输入构造、输出Schema及 `single_call_prompt.txt` 是共享边界。

不要为了适配某个引擎自行重命名工具字段、变更参数单位、改变否定策略或改写成功回复规则。需要改协议时，在仓库提出变更，说明数据导出、回归和版本迁移影响，再由负责人对齐。训练导出复用 `build_decision_messages()`，参见 `scripts/export_single_call_data.py`。

216条夹具是现有基础，不是足量训练集或独立盲测。后续训练样本不在本次推理交接中扩充；禁止把开发错题上的改进包装成未见数据准确率。
