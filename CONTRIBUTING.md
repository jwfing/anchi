# Contributing to Anchi / 为安栖贡献

当前是走向 MVP 的工程开发版，未达到公开分发条件。提交变更前先阅读 [架构与目录职责](docs/architecture/REPOSITORY.md) 和 [安全边界](SECURITY.md)。

## 贡献方式与提交流程

可以通过修复问题、改进首次使用体验、补充安全边界测试、完善文档或提交可复现的 Bug 报告参与项目。较大的功能和架构改动，建议先开 Issue 明确目标与范围。

Bug 报告请包含系统版本、应用版本、复现步骤、预期行为和实际结果；优先使用合成数据复现。安全问题按 [SECURITY.md](SECURITY.md) 私下报告，不在公开 Issue 中贴出凭证或私密材料。

Fork 并克隆仓库后，为本次变更创建分支，例如：

```bash
git switch -c fix/describe-the-change
```

完成开发和验证后，将分支推送到自己的 Fork，向项目提交 PR。PR 应描述具体问题及改动后的行为，关联对应 Issue，并列出已执行的验证、未覆盖的场景和已知限制。界面修改可附脱敏截图；安装、权限或隔离修改应说明实测环境和结果。每个 PR 尽量聚焦一个问题，并根据评审反馈完善。

## 开发环境

桌面和 VM 开发以 macOS Apple Silicon 为目标；离线测试支持 Linux/macOS。需要 Node 22+、npm、Python 3.11+；CI 使用 `.nvmrc` 和 Python 3.13。

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
npm ci --prefix desktop
npm ci --prefix pi
make check PYTHON=.venv/bin/python
make desktop
```

仅测试时可设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1` 安装桌面依赖。依赖使用各组件自己的 lockfile，升级必须同时提交 manifest 和 lockfile，不新增一个重复管理它们的根 npm lock。

## 日常工作

- `make check` 是提交前入口：语法、桌面格式和所有离线单元测试。不操作 VM、不访问账户、不批准模型。
- `make format` 格式化桌面代码；Python 遵循四空格及现有服务接口约定。避免在安全修改中混入全库无关重排。
- `make verify-vm` 是显式 live 检查。模型/Gmail live 测试另按相应文档执行，不进入默认 CI。
- 添加权限相关 IPC 时同时更新 controller 操作白名单、边界测试、文档与 renderer；禁止通用 shell/文件读写代理。
- 系统选择器返回路径仍需主进程校验。保存的目录配置不等于有效授权；只有文件代理激活成功后才能显示已授权，并需覆盖只读、越界拒绝和撤销行为。
- 新配置必须有 schema、验证与迁移规则。未知版本/损坏文件应保留原数据，不能静默覆盖。
- 功能变更要更新能力表；原型、已实现能力和未来计划分别记录。

## 测试分层

| 层 | 路径 | 依赖与目的 |
|---|---|---|
| 服务边界 | `tests/` | Python + cryptography；网络与策略使用 mock |
| Pi 协议 | `pi/tests/` | Node + Pi SDK；会话、取消、输入校验 |
| 桌面业务 | `desktop/tests/` | Node；审批、配置事务、RPC 生命周期、IPC 来源、打包资源 |
| 真实隔离 | `guest/check-*.py`、`scripts/verify.sh` | 已部署 VM；验证 OS 边界 |
| 手工桌面验收 | `docs/DESKTOP_APP.md` | 窗口、原生选择器、真实连接；未经用户批准不提交真实模型请求 |

## 发布

参见 [发布流程](docs/engineering/RELEASE.md)。不要提交 `artifacts/`、node_modules、凭证、邮件正文或真实用户会话。项目采用 [Apache License 2.0](license.md)。请确认你有权提交相关贡献，并保留第三方依赖的版权和许可证声明。
