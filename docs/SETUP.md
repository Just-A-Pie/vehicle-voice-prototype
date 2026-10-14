# 启动与连接

## 同机

GPU服务按README启动并看到 `OPT_READY` 后，在同一checkout运行 `python3 scripts/connect_local.py`。它把endpoint令牌复制到本地代理配置，不打印令牌。再运行 `VEHICLE_LOCAL_PORT=8770 python3 local_server.py`，访问 `http://127.0.0.1:8770/slai/`。

UI代理仅监听本机。若GPU在远端，使用下述隧道，不应直接公开未配置网络访问控制的GPU端口。

## 远程GPU、本机浏览器

由项目负责人另行提供SSH账号、端口、私钥/SSH-agent使用方式、调度账号和GPU上的checkout路径。仓库不附共享密钥、账户令牌或内网地址。

在本机shell设置：

```bash
export VEHICLE_SSH_TARGET=your-user@your-gateway
export VEHICLE_SSH_PORT=22
export VEHICLE_REMOTE_ENDPOINT=/absolute/remote/checkout/runtime/endpoint.json
export VEHICLE_TUNNEL_PORT=18841
# 可选：export VEHICLE_SSH_KEY=/absolute/path/to/your/key
python3 server_omni25_opt/connect.py
```

隧道从指定远端读取endpoint，再转发本机18841到模型节点18825。只有health确认build正确、模型ready才写本地 `runtime/connection.json`。它不会重发用户请求，也不会自动提交GPU任务。

另一个终端：

```bash
VEHICLE_LOCAL_PORT=8770 python3 local_server.py
```

打开浏览器；首次录音由使用者授予本站麦克风权限。若页面已有旧会话，刷新/重新连接；不要把代理健康检查等同于模型质量验收。

## 共享集群

需要由负责人提供调度器命令。服务脚本 `server_omni25_opt/run.sh` 支持 `VEHICLE_PROJECT_ROOT`、`VEHICLE_PYTHON`，默认最长运行3小时。模型路径通过 `VEHICLE_MODEL_PATH` 显式给出。脚本本身不替代集群资源申请，不要在登录节点直接加载模型。

停止时只终止自己启动的服务/隧道/UI进程和GPU任务。运行中token、endpoint、请求录音、审计文件均在被忽略的runtime/evidence目录。

## 复现边界

CPU测试和GPU参考环境版本不同，分别列出。推理依赖记录来自真实H100环境；裸机CUDA驱动、PyTorch索引、ffmpeg/音频系统库等仍需按目标机器配置。完整环境快照中的 `file:///tmp/...` 是原镜像构建来源，不能在新机器上直接安装。

权重revision和全部分片哈希尚未锁定，必须先向负责人取得统一快照再作严格A/B。不要把下载到的不同revision、不同量化权重和不同精度混在同一速度排名中。
