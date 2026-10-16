# 河套车载交互展示

在 macOS 展示电脑运行座舱网页与本地代理，模型继续运行在远端。支持在页面的「测试遥控器 → 对话模型」中切换：

- **车载微调 checkpoint-48**：原生ASR → 工具调用 → 模拟执行回执 → 模型回复 → Kokoro播报。跨轮历史关闭，每轮仍提供完整23项车况。
- **千问实时 API**：保留原Realtime语音及多轮链路。需要用户自己的百炼配置和调用授权。

包含玫瑰红车漆、连续对话开关、模型自动切换、清空对话但保留车况、文字输入及测试遥控器。仅控制模拟座舱，不连接实体车辆。GitHub不保存模型权重、密钥、用户录音或运行日志。

## 展示电脑启动

要求 **macOS、Python 3.12、Git、可访问模型服务器的网络**。展示电脑无需CUDA或GPU推理环境。

```bash
git clone --branch codex/macos-demo-20261017 https://github.com/Just-A-Pie/vehicle-voice-prototype.git
cd vehicle-voice-prototype
bash install.command
```

仓库为私有；展示电脑需登录有访问权限的 GitHub 账号。首次安装会下载Python依赖。

1. 在此分支克隆仓库，双击 `install.command`（或终端执行 `bash install.command`）。
2. 填写它生成的 `runtime/demo-settings.json`。SSH首次登录、API密钥等配置见 [macOS部署说明](docs/MACOS_DEMO.md)。
3. 双击 `start.command`。保持启动终端打开；页面自动打开为 `http://127.0.0.1:8765/slai/`。
4. 使用完毕双击 `stop.command`，或在启动终端按 Ctrl+C。只停止这个checkout管理的本机服务，不会停止GPU任务。

```bash
# 安装完成后检查本机配置；不发起付费模型请求
.venv-demo/bin/python scripts/demo.py check
# 检查真正的模型连接状态
.venv-demo/bin/python scripts/demo.py status
```

如果未准备服务器权限或模型尚未启动，页面不会因此变成可用的本地模型。不要把页面HTTP 200当成推理就绪。

## 模型边界

checkpoint-48对应训练作业32769、第二阶段48步版本；本机适配器严格使用其 `vehicle_tool_messages_v3` 资源。只有本轮工具执行结果参与同轮回复，前轮对话不再注入。

无历史的50条功能抽测：39条符合预期，9条错误/多余操作，2条越界调用被执行器拦截。这是一次小规模功能诊断，不是泛化准确率。解锁、否定、范围、上下首、模糊请求仍有已知问题，不能把演示当成生产车控验收。仅保留脱敏摘要：[模型说明](docs/MODEL_CONTRACT.md)。

本次客户端部署整理没有更换权重、重新训练或声称提高模型准确率。远端GPU服务的时限、额度与被回收风险仍需展示负责人安排。

## 开发与验证

```bash
.venv-demo/bin/python -m unittest scripts.test_single_call scripts.test_native_realtime_agent scripts.test_climate_modes test_vehicle
.venv-demo/bin/python checkpoint48/test_adapter.py
.venv-demo/bin/python tests/test_history_clear.py
node --test tests/voice-activity.test.mjs tests/continuous-bridge.test.mjs
```

同事提交的Qwen2.5-Omni双卡流式实现保留在 `server_omni25_opt/`、`patches/` 及相关脚本；没有用新版客户端覆盖其模型加载/流式生成代码。旧方案的运行方法见 [原Omni基线](docs/LEGACY_OMNI_BASELINE.md) 和 [推理加速交接](docs/INFERENCE_HANDOFF.md)。它与checkpoint-48是两套不同模型与协议。

第三方车辆、字体和Three.js许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

部署验证范围与结果见 [DEPLOYMENT_VERIFICATION.md](docs/DEPLOYMENT_VERIFICATION.md)。
