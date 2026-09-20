# 工程整理验收：2026-09-19

环境：macOS arm64、Node 24.15.0、Python 3.13；CI 配置目标为 Node 22、Python 3.13，Linux/macOS。CI workflow 已加入但未在远端执行。

## 完成

- `make check` 通过：Python/shell/Pi 语法、桌面语法/Prettier、22 项桌面 + 5 项 Pi + 55 项服务测试，共 82 项。
- `git diff --check` 通过。
- `npm --prefix desktop run package` 成功生成 macOS arm64 应用。
- 包内 `Resources/runtime/manifest.json` 的 63 个文件与 SHA-256 全部匹配。
- 应用资源中不再包含旧 `workspace.json`，脚本从包内运行资源定位。
- 已从新产物启动窗口，renderer ES modules 正常载入；通过界面连接 Pi，收到真实 session ID。
- 未提交模型请求、未批准策略、未读取邮件，未增加宿主目录访问。

## 产物

`artifacts/releases/0.1.0/Qisuo-darwin-arm64/Qisuo.app`

`artifacts/releases/0.1.0/build-manifest.json`

旧的 `artifacts/desktop/` 保留为历史开发构建，不作为当前交付入口。

## 不在本轮证明范围

签名公证、干净机器安装、所有 GUI 操作、实际目录访问/撤销、桌面 OAuth、升级恢复、多实例、远端 CI，以及整体安全审计。当前源码已按产品工程边界整理，不意味着这些功能或发布条件已具备。
