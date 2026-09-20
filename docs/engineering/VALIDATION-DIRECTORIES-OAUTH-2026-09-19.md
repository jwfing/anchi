# 目录、桌面 OAuth 与发布验证

日期：2026-09-19，macOS arm64，现有 Lima secure-vm。

## 已完成

- `make check`：27 个桌面测试、6 个 Pi 测试、59 个 Python 测试，共 92 项通过。OAuth 测试使用真实 127.0.0.1 临时端口；受限沙箱禁止监听时需授权运行测试，而不是跳过。
- 文件代理测试覆盖只读拒绝、目录身份变化、`..`/绝对路径/隐藏路径拒绝、符号链接与硬链接拒绝、FIFO 拒绝、有界文本及原子替换。
- 撤销测试覆盖在途操作等待和排队请求拒绝。Pi RPC 测试覆盖任务执行中接收文件工具回复。
- `node desktop/scripts/verify-files.cjs` 实际启动隔离 cell，与宿主文件代理往返：写入并读回合成报告、拒绝路径逃逸和隐藏文件、只读写入拒绝、撤销后读取拒绝。临时目录已清理；未调用模型或读取 Gmail。
- 已更新 VM 内 Pi agent/protocol/host-files 及 guest admin OAuth cancel 入口。
- 新版打包应用启动成功，权限页从认证服务读取到已有 Gmail 连接及已解锁凭证库；点击连接 Google 后进入浏览器等待状态，取消后恢复，既有账户连接保留。
- 新版应用连接真实 Pi，获得 session ID；未发送模型任务、自动批准策略请求或开放用户真实目录。
- 发布配置校验覆盖缺失身份、Team ID、Keychain profile、Bundle ID 时拒绝正式发布。开发包 manifest 明确标为未签名、未公证。

## 尚需外部条件或用户操作

- Google 交互式同意授权后的真实授权码兑换：本轮验证了启动/取消、真实账户状态及合成回调兑换控制；未替用户完成浏览器授权，也未断开已有账户。
- Apple `security find-identity -v -p codesigning` 返回 0 个有效身份。实际 Developer ID 签名、Apple Accepted receipt、staple 和 Gatekeeper 尚未运行成功；需要用户的证书、Team ID、notarytool Keychain profile 和正式 Bundle ID。
- 尚未做干净机器安装、正式发行、自动更新或第三方安全审计。

文件代理目前为 Pi 适配器能力，授权在本次桌面进程内有效。限制为 UTF-8 文本最多 24000 字节、列表最多 100 项；不是面向任意 Agent 的透明文件系统挂载。
