# macOS展示部署

## 先准备什么

- Python 3.12。Finder启动脚本会查找 `/opt/homebrew/bin`、`/usr/local/bin` 的 python3.12；其他安装位置可在终端设置 VEHICLE_PYTHON 后运行安装脚本。
- SSH客户端与Git；macOS通常提供OpenSSH，Git可能需要先安装系统命令行工具。
- 对现有GPU服务的SSH访问权限与endpoint绝对路径；这些由负责人另行提供，不能从仓库获得权限。
- 若启用API备用，准备百炼工作空间地址、自己的API Key及相应调用授权。

克隆 `codex/macos-demo-20261017` 分支后执行 `bash install.command`。安装使用已验证的requirements-client-lock.txt固定直接和间接依赖版本，只下载客户端Python依赖，不安装PyTorch、CUDA、模型权重，不申请GPU任务。Node仅用于开发测试，不是展示运行的依赖。Three.js、字体、3D模型均随仓库提供。

## 远端checkpoint配置

安装后编辑 `runtime/demo-settings.json`，保留 `default_profile` 为 `checkpoint48`。把checkpoint48部分填为：

```json
{
  "enabled": true,
  "ssh_target": "vehicle-model",
  "ssh_port": null,
  "ssh_key": "",
  "remote_endpoint": "/absolute/path/to/private/service/output/endpoint.json",
  "tunnel_port": 18948,
  "gateway_port": 18748
}
```

`ssh_target` 可以是已配置的SSH别名，或者 `user@host`。别名的端口和私钥由 `~/.ssh/config` 提供；不用别名时填写ssh_port和ssh_key。示例SSH配置（实际值由管理员提供）：

```text
Host vehicle-model
    HostName SERVER_HOST
    User YOUR_USER
    Port SERVER_SSH_PORT
    IdentityFile ~/.ssh/vehicle_demo
    IdentitiesOnly yes
    ServerAliveInterval 15
```

展示电脑应使用自己的密钥身份并获得授权。先在终端执行 `ssh vehicle-model true`，根据管理员提供的指纹完成首次连接验证。应用使用BatchMode，不代填密码或接受未知主机。专用SSH别名不要附带与本项目无关的LocalForward/RemoteForward。

服务器结构是：SSH登录入口/CPU CCI → 调度器启动的GPU计算作业。模型不运行在CPU CCI上。`remote_endpoint` 由实际GPU服务写出，包含计算节点地址和令牌，必须是本次模型服务的端点；任务重排后地址会变化，客户端自动重新读取，但不会自行提交新GPU任务或重放车控指令。

## API备用配置

将api.enabled设为true，填写其余模型、音色和工作空间base_url；确认允许调用后设置usage_authorized=true。然后在本机创建 `runtime/dashscope.key`，只写密钥，并执行：

```bash
chmod 600 runtime/dashscope.key
```

也支持在启动终端导出DASHSCOPE_API_KEY。不要把密钥写进配置模板、Git或共享截图。配置默认API关闭，不自动申请付费或静默回退。可以在同一页面主动切换API，界面显示真实后端；对外身份介绍为河套学院车载助手，技术模型标识保留。

## 日常启动与停止

运行start.command，保持该终端开启。它在8765启动网页代理，在需要时启动本机API网关/训练模型适配器和SSH连接。checkpoint路径就绪后才启动其适配器；等待期间网页显示未连接，不发送模拟成功答复。启动日志在runtime/demo-*.log。

模型下拉框选中即检查并切换，失败保留原后端。切换会创建新会话并同步初始车况；“清空对话”只清历史、保留车况。checkpoint已禁用跨轮历史，应明确说出对象，如“音量小一点”，不能依赖上一句补全“它”。

stop.command/终端Ctrl+C只停止该checkout启动的进程，不停止服务器GPU作业。端口占用时拒绝抢占其他应用；需要另一个本机实例时改config中的四个端口。

## 现场检查

提前完成安装和拉取，现场不依赖临时pip安装。展示前确认：

1. 远端模型服务覆盖整个展示时段，实际健康检查ready；SSH登录成功不等于GPU模型就绪。
2. 用展示电脑和现场网络测试文字请求、麦克风授权、录音、工具状态变化及扬声器播放。
3. 本机页面用localhost，麦克风可在浏览器授权后使用；其他设备用HTTP局域网地址时不能录音，需另行HTTPS和可互访网络配置。
4. 正式演示前预热几轮，确认使用的是微调模型还是API；不要把其中一套结果当作另一套。
5. 本版本模型服务串行处理请求，多设备同时请求可能返回忙碌；本次部署以单展示电脑为主。

连续对话为本地声能分句：停顿约一秒提交，播报期间暂停收音，播完继续听；不是全双工打断，现场噪声/旁人说话需要实际测试。跨轮历史关闭不等于已修好所有单轮语义错误。

## 服务器侧参考

`checkpoint48/run_remote.sh` 是GPU作业内部启动入口，不是集群调度器。需要负责人配置AUDIO_TRAIN_ROOT、VEHICLE_CHECKPOINT、AUDIO_KOKORO_MODEL和OUTPUT_ROOT，再按服务器授权方式申请1张GPU。它复用训练项目的ASR/Kokoro运行时，不能使用旧Qwen2.5的requirements-inference.txt代替。默认最长运行10800秒，展示前由负责人按允许的时长配置VEHICLE_SERVICE_SECONDS。

如果只是部署展示电脑，不执行服务器安装、训练或GPU启动脚本。
