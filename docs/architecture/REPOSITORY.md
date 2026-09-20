# 仓库架构与职责

状态：2026-09-19。采用按信任边界组织的单仓库；先保持已部署脚本路径稳定，不为了目录命名破坏 guest 更新协议。

```text
desktop/                 宿主桌面应用，独立 npm 包
  src/main/app.cjs       Electron 窗口与生命周期装配
  src/main/security.cjs  页面资源白名单、权限与 IPC 来源校验
  src/main/controller.cjs 业务用例、审批与操作白名单
  src/main/runtime.cjs   固定 Lima / 管理脚本调用
  src/main/pi-client.cjs Pi 连接、请求关联、超时与断开
  src/main/directory-store.cjs 版本化目录计划，事务式写入
  src/shared/            纯协议与校验函数
  src/preload.cjs        最小 contextBridge
  src/renderer/          ES module 展示与交互；views 为纯函数，无 OS / token 访问
  scripts/               语法检查、白名单资源打包
  tests/                 Electron 无关的业务/边界测试
pi/                      cell 内 agent 适配器，独立 npm 包
services/                guest 上可信的 auth / policy / connectors
guest/                   cell 构建、启动及真实隔离验收
systemd/                 guest 服务身份、socket 和资源配置
lima/                    外层 VM 声明
scripts/                 宿主 CLI，保持现有用户入口
tests/                   可信服务的离线回归测试
prototype/               纯模拟 UX 参考，不参与产品打包
docs/                    产品规格、使用说明、验证记录和工程规范
artifacts/               本机构建产物，不纳入版本管理
```

## 调用方向

Renderer → preload → 主进程 controller → PiClient → 固定宿主脚本 → cell 内 Pi。

主进程 controller → Runtime → 独立 policy admin；批准详情来自策略服务，不来自 agent 消息。Pi 的审批事件只能提示 UI。

cell Pi → Unix socket → Gmail / inference → auth + policy → 上游。不得为了 UI 方便把 auth socket 或管理入口暴露给 cell。

## 关键设计决定

1. 业务逻辑不导入 Electron。原生 dialog、进程、文件 I/O 边界可注入测试替身。
2. 宿主 IPC 与 Pi RPC 两层均白名单校验；禁止扩展成通用 exec。
3. 目录计划 schema v1，迁移旧无版本文件；所有持久项重载后仍为 pending。损坏/未来版本拒绝写入并保留原文件。
4. 配置先写临时文件并 fsync，再原子 rename，成功后更新内存；串行修改防止丢更新。
5. 已打包应用从 Resources/runtime 读取脚本，不依赖开发者绝对路径。运行依赖仍是 Lima 和已有 VM，而非真正新机器零配置。
6. Pi 断开关闭 stdin 触发远端 EOF 清理，宿主进程超时先 TERM 后 KILL；不保证在途上游请求停止。
7. 默认检查全离线，真实 VM、Google、模型请求永远显式触发。

## 后续模块

真实目录代理与句柄撤销、任务级授权、桌面 OAuth、安装升级/版本兼容协商、持久审计与导出、签名公证、多 agent 实例。增加这些能力时扩展现有边界，不把原型按钮直接映射到高权限宿主操作。

### 文件与认证接入

`file-broker.cjs` 持有进程内目录能力和串行撤销队列；`scripts/host-files.py` 使用目录 fd 实施宿主文件操作。`pi/host-files.mjs` 只传送数据请求，不能授权自身。`oauth.cjs` 管理 loopback 回调与系统浏览器，`runtime.auth` 通过 stdin 调用 guest 管理面。renderer 不接触授权码、PKCE verifier 或令牌。`desktop/scripts/release.cjs` 负责证书预检、公证与发行验证。

`setup.cjs` 持有首次设置任务状态、受限安装/登录命令和中断恢复日志；`services/setup_status.py` 只返回安装、凭证库和模型认证的就绪元数据。首次任务成功按 session/turn 关联，示例不自动批准模型调用。
