# Anchi / 安栖

面向本地 agent 的独立权限运行环境：账户由环境托管，agent 通过受控接口使用资源。当前是 **MVP 开发版**，已完成隔离 PoC 和桌面控制端，尚未达到公开分发条件。

## 当前能力

| 能力 | 状态 |
|---|---|
| Lima/VZ VM、nspawn cell 与服务身份隔离 | 已实现并做过真实隔离检查 |
| auth/policy/Gmail/inference 独立服务 | 已实现，Gmail 只读 |
| Pi、Codex 订阅认证、JSONL 多轮通信 | 已实现；凭证不进入 cell |
| 桌面聊天、会话恢复、取消与独立审批 | 已接入现有运行环境 |
| 原生目录授权、只读/读写与撤销 | 已接入宿主文件代理；真实 cell 合成文件往返验证通过 |
| 桌面 Gmail OAuth、账户断开、持续只读许可 | 已实现；浏览器交互式授权需用户完成 |
| 首次引导、依赖安装、VM/Pi 安装、解锁与订阅认证 | 已接入桌面；全新 VM 安装与重试通过 |
| 首个示例任务与审批引导 | 已实现，真实模型请求需用户审批 |
| 任务级资源授权 | 尚未实现 |
| Developer ID 签名、公证 | 发布流水线已实现；本机缺少证书，尚无正式签名产物 |
| 自动更新、公开分发 | 尚未完成 |

agent 读取的内容可以进入云模型；凭证隔离不意味着数据不离开本机。完整限制见 [安全声明](SECURITY.md)。

新用户入口见 [首次使用指南](docs/GETTING_STARTED.md)。无需先手工部署 VM；首次系统依赖安装和浏览器登录需要用户完成对应系统提示。

## 开发与运行

需要 Node 22+、Python 3.11+；桌面/VM 目标为 macOS Apple Silicon。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
npm ci --prefix desktop
npm ci --prefix pi
make check PYTHON=.venv/bin/python
make desktop
```

桌面首次设置可以安装或连接 `secure-vm`。命令行部署仍可按 [Pi 安装与认证](docs/PI_AGENT.md) 操作；首次基础 VM 入口仍为 `bash scripts/up.sh`。这些部署动作有系统副作用，不属于默认检查。

本机打包运行 `make package PYTHON=.venv/bin/python`，产物为 `artifacts/releases/0.1.1/Anchi-darwin-arm64/Anchi.app`。应用自带运行脚本，不依赖开发仓库位置；仍需 Lima 与已部署 VM。参见 [桌面说明](docs/DESKTOP_APP.md) 和 [发布流程](docs/engineering/RELEASE.md)。

## 工程结构

| 目录 | 职责 |
|---|---|
| `desktop/` | 宿主桌面 UI、可信控制面、配置与 Pi 进程管理 |
| `pi/` | 不可信 cell 内 Pi 适配器与 RPC |
| `services/` | 可信 auth、policy、Gmail 和模型网关 |
| `guest/`、`systemd/`、`lima/` | 隔离环境构建与部署 |
| `scripts/` | 稳定的宿主 CLI 与显式 live 验证入口 |
| `tests/` | 服务离线回归测试 |
| `prototype/` | 纯模拟 UX 参考，不参与应用打包 |
| `docs/` | 产品规格、架构、运行手册与历史证据 |

桌面主进程按窗口、安全、业务用例、运行时、Pi 通信、目录存储拆分，细节见 [模块职责](docs/architecture/REPOSITORY.md)。保留既有 guest 和脚本路径，避免破坏已部署环境。

## 常用命令

```bash
make help        # 所有入口
make check       # 离线语法、格式、单元测试；不访问 VM 或账户
make format      # 桌面代码格式化
make verify-vm   # 显式运行真实 VM 隔离检查
```

开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)，完整文档见 [文档导航](docs/README.md)。历史 PoC 记录归档于 [运行记录](docs/archive/POC_RUNBOOK.md)。

## How to contribute

欢迎为 Anchi（安栖）提交 Bug 报告、文档改进、测试和代码贡献。

1. **确认问题或需求**：先查看已有 Issue 和 PR；较大的功能或架构调整建议先开 Issue 讨论。安全漏洞请按 [安全报告指南](SECURITY.md) 私下报告。
2. **准备开发环境**：Fork 仓库并克隆到本地，创建独立分支，按 [贡献指南](CONTRIBUTING.md) 安装依赖。当前优先支持 macOS Apple Silicon 和 Pi。
3. **实现并验证**：保持每个 PR 聚焦一个问题，按改动范围补充测试和文档。提交前运行 `make format` 和 `make check PYTHON=.venv/bin/python`；涉及 VM 隔离或桌面流程时，补充对应实测记录。
4. **提交 Pull Request**：说明解决的问题、改动后的行为、验证结果以及已知限制，关联对应 Issue。界面改动可附截图，注意移除真实账户和用户数据。
5. **参与评审**：根据反馈完善变更。不要提交密钥、token、邮件正文、真实会话、依赖目录或构建产物。

完整开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。项目采用 [Apache-2.0](license.md)，提交贡献前请确认你有权贡献相关代码，并保留第三方版权与许可证声明。

## License

Anchi（安栖）采用 [Apache License 2.0](license.md)。Copyright 2026 Junwen。第三方依赖及其附带文件仍遵循各自的许可证。
