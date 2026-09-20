# 构建与发布

## 本机构建

```bash
make check
make package
```

目前仅支持 macOS arm64 打包，产物在 `artifacts/releases/<version>/Anchi-darwin-arm64/Anchi.app`。旧 `artifacts/desktop/` 是历史开发构建，不覆盖运行中的旧应用。重新构建同一版本前先退出该版本应用。

版本来自 `desktop/package.json`。Electron 与依赖由 lockfile 固定。构建在系统临时目录组装运行资源，结束后清理，不向源码写入本机路径。

资源只收录 scripts/services/guest/systemd/lima/pi 的允许文件类型，不复制 node_modules、密钥、用户工作区或会话。资源 manifest 记录文件尺寸与 SHA-256；构建 manifest 记录版本、平台、Electron 和资源 manifest 摘要。摘要用于追踪构建内容，不替代代码签名或供应链验证。

构建产物自带控制脚本和首次引导，可以安装 Lima 与 Pi、创建 secure-vm。Homebrew 系统安装及浏览器登录仍由用户完成。桌面目录配置在 macOS 的 `~/Library/Application Support/Qisuo/directory-plans.json`，不进入应用包。

## 发布门槛

当前产物为未签名的开发版；下列项目未全部完成前不对外宣称正式产品：

- [ ] 明确仓库许可证、第三方许可证与隐私说明。
- [ ] Developer ID 签名、公证、staple 与干净机器 Gatekeeper 验证。
- [ ] 全新安装、安装取消、升级/降级、失败恢复与配置迁移验证。
- [ ] 目录真实访问和撤销、OAuth 连接与撤销、任务权限边界验收。
- [ ] 用户可恢复的配置备份、异常退出和断电恢复策略。
- [ ] 安全评审、依赖审查、分发更新校验与版本兼容矩阵。

## 每次变更验证

`make check` 通过后，按改动范围运行打包和桌面验收。涉及 guest 部署再显式运行真实隔离测试。CI 不保存凭证、不连接账户、不自动批准模型，也不发布产物。

打包后的手工检查：从 Finder 启动 → 检查 VM → 连接 Pi → 新建/恢复会话 → 原生目录选择与取消 → 可信审批详情核对 → 退出连接。模型真实请求必须由用户确认，不能为证明 UI 正常自动批准。

## Developer ID 签名与公证入口

本机目前检测到 0 个有效 code-signing identities。未提供证书和 Keychain profile 前，仅能生成未签名开发包，不会自动使用 ad-hoc 签名冒充正式发布。

安装自己的 Developer ID Application 证书（含私钥），并用 Apple `notarytool store-credentials` 交互式将公证凭据保存在 Keychain。不要把密码、私钥或 API key 写入仓库或发到聊天中。随后配置以下非秘密值：

```bash
export QISUO_RELEASE=1
export QISUO_SIGN_IDENTITY='Developer ID Application: Your Company (TEAMID1234)'
export QISUO_APPLE_TEAM='TEAMID1234'
export QISUO_NOTARY_PROFILE='anchi-notary'
export QISUO_BUNDLE_ID='com.yourcompany.anchi'
npm --prefix desktop run package
```

签名产物单独写入 `artifacts/releases/<version>/signed/`；失败构建不保留之前的成功 manifest 或分发 ZIP。发布模式先检查证书和 Keychain profile，再以 hardened runtime 及 Electron osx-sign 默认 entitlements 签名所有组件。随后 codesign 严格验证 → ZIP 提交 notarytool 并等待 Accepted → staple → staple validate → Gatekeeper assess → 重新生成携带票据的分发 ZIP 和 SHA-256。只有全部成功才写入 `signed: true, notarized: true` 的 build manifest；Apple 返回的 receipt 保存在 notarization.json。应用只能依赖可信内置资源，不能把外部下载内容注入签名包。

实现依据：[Electron Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)、[Apple Notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution)。真实 Apple 提交、干净机器 Gatekeeper 和全新安装仍须在有效开发者配置下验收。

## 文件代理实测

`node desktop/scripts/verify-files.cjs` 使用现有 VM 和合成临时目录，验证 cell JSONL 工具到宿主的真实往返、读写、路径拒绝、只读和撤销；不调用模型或读取 Gmail。执行前退出 Pi，会占用固定 secure-cell unit。

产品名称为 **Anchi（安栖）**。为兼容既有安装，用户配置仍保存在 `~/Library/Application Support/Qisuo/`，开发版 Bundle ID 和 `QISUO_*` 构建变量继续沿用；不会因改名重新创建账户或凭证库。
