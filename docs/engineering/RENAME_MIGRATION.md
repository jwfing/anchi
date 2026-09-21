# Qisuo → Anchi 改名迁移

2026-09-20。产品名已为 Anchi（安栖），以下是仍带旧名的位置、当前处理和后续计划。

| 位置 | 现状 | 处理 |
|---|---|---|
| 用户配置目录 `~/Library/Application Support/Qisuo/` | 首次启动新版本时自动重命名为 `Anchi/`；失败则继续使用旧目录 | 已实现，见 `desktop/src/main/user-data.cjs` |
| 发布环境变量 `QISUO_RELEASE`、`QISUO_SIGN_IDENTITY` 等 | `ANCHI_*` 为规范名，`QISUO_*` 继续接受 | 已实现；正式签名流程建立后移除 `QISUO_*` |
| 安装脚本变量 `QISUO_INSTALL_VM` | `ANCHI_INSTALL_VM` 为规范名，旧名仍接受 | 已实现 |
| 开发版 Bundle ID `local.securevm.qisuo` | 改为 `local.anchi.desktop`；正式发布使用 `ANCHI_BUNDLE_ID` | 已实现。macOS 对未签名开发包的权限提示可能重新出现一次 |
| npm 包名 `secure-vm-desktop`、`secure-vm-pi` | 改为 `anchi-desktop`、`anchi-pi` | 已实现 |
| 文件代理临时文件前缀 `.qisuo-` | 改为 `.anchi-`；回收目录为 `.anchi-trash` | 已实现。旧前缀的残留临时文件可手工删除 |
| 仓库目录名 `secure-vm`、Lima 实例名 `secure-vm`、guest 路径 `/opt/secure-vm` | 保留 | 这是运行环境的内部名称，不面向用户；改名会破坏已部署 VM 的更新协议 |

迁移原则：不删除用户数据，不因改名重新创建账户或凭证库，旧名只在兼容层出现一次。
