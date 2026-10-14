# Vehicle Voice Prototype

面向模拟座舱的 **Qwen2.5-Omni-3B 原生语音 → 单次工具决策 → 原生语音回复** 项目。本仓库用于推理加速交接，不连接实体车辆，不包含模型权重、账户凭据、用户录音或完整训练数据。

**先读 [推理加速交接文档](docs/INFERENCE_HANDOFF.md)。** 当前模型尚未微调，存在否定误操作、查询误调用和范围遗漏；仓库是优化基线，不是已验收产品。

## 当前请求流程

原始语音或文字 + 当前状态 + 最近两轮历史 → 3B一次生成JSON → 程序校验并调用 `control_cabin` → 放行模型回复文字 → 同一Omni单独生成声音。

```json
{
  "tool_calls": [{"name": "control_cabin", "arguments": {"rearRightWindow": 50}}],
  "reply": {"text": "右后车窗已开到一半。", "when": "after_success"}
}
```

普通聊天/查询/澄清使用空调用列表和 `when:"immediate"`。一次决策不等于整条语音链路一次模型运行：目前正常请求是一次语义生成、一次语音生成，音频完整生成后才发出。

## 无GPU运行回归测试

建议 Python 3.12。以下命令从仓库根目录执行：

```bash
python3 -m venv .venv-test
.venv-test/bin/python -m pip install -r requirements-test.txt
.venv-test/bin/python -m unittest scripts.test_single_call scripts.test_native_realtime_agent scripts.test_climate_modes test_vehicle
node scripts/test_scene_music.mjs
```

27项Python测试，包括216条固定标注答案的执行回放。测试注入模型输出，不代表模型准确率。`tests/fixtures/gold_cases.jsonl` 仅为冻结回归夹具，数据集构建由另一条工作线负责。

## GPU运行

已验证参考环境为单H100 80GB、BF16、SDPA。依赖见 `requirements-inference.txt`；完整环境记录见 `benchmarks/reference/environment_reference.txt`，后者含原镜像构建目录，仅供查阅，不应直接 `pip install -r`。

```bash
python3 -m venv .venv-gpu
# 按你的CUDA环境安装匹配的PyTorch轮子，再安装其余依赖。
.venv-gpu/bin/python -m pip install -r requirements-inference.txt
export VEHICLE_MODEL_PATH=/absolute/path/to/Qwen2.5-Omni-3B
.venv-gpu/bin/python server_omni25_opt/serve.py
```

权重需另行准备完整的Qwen2.5-Omni-3B（含Thinker、Talker、Token2Wav）。加载使用 `local_files_only=True`。参考测试未记录完整权重commit/hash；优化对照前应由项目负责人提供同一份权重快照并补齐锁定信息。

服务预热完成后输出 `OPT_READY`，监听18825，认证信息写入权限0600的 `runtime/endpoint.json`。不要把该文件提交到Git或贴在公共日志中。共享集群需使用获授权的调度方式，不在登录节点运行模型。

## 打开座舱页面

与GPU服务在同一台机器时：

```bash
python3 scripts/connect_local.py
VEHICLE_LOCAL_PORT=8770 python3 local_server.py
```

浏览器访问 `http://127.0.0.1:8770/slai/`。远程GPU则使用 [远程连接说明](docs/SETUP.md)，只需在本机启动SSH隧道和标准库UI代理。文本/录音走同一接口，UI不持有服务端令牌。

## 单独运行真实模型短测

```bash
.venv-gpu/bin/python scripts/smoke_single_call.py --model "$VEHICLE_MODEL_PATH" --output evidence/new-run
```

包含8条文字与3条合成音频。不要覆盖旧结果目录；不是完整稳定性或泛化测试。旧/新路径的历史对照原始记录已精简保存在 `benchmarks/reference/`，解释见交接文档。

## 文件入口

- `single_call.py` / `single_call_prompt.txt`：统一协议、输入构造、执行和回复放行。
- `small_model_eval/backend.py`：Omni加载、编码、生成与时间记录。
- `server_omni25_opt/native_backend.py`：阶段计时、原生语音与RoPE兼容修复。
- `agent_service.py` / `realtime_turn.py`：HTTP、会话锁、状态与音频事件。
- `cabin.py` / `cabin_contract.json`：23项模拟状态及执行规则。
- `web/slai/` / `web/stream-player.js`：界面、录音和播放。
- `docs/INFERENCE_HANDOFF.md`：工作边界、基线、性能排查顺序和交付要求。
- `docs/PROTOCOL.md`：与数据集工作线共同维护的接口约定。

API与旧模型的少量兼容代码用于保留现有模块导入和回归；此次加速目标仅为服务器Qwen2.5-Omni-3B路径。第三方资源声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
