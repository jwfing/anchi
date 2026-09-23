// Chinese source messages and their English translations. Interpolated user data is never translated.
export const messages = {
  未知: 'Unknown',
  操作: 'Operation',
  '账户 generation': 'Account generation',
  模型: 'Model',
  上下文条目: 'Context items',
  条: 'items',
  最近用户输入: 'Latest user input',
  模型可调用工具: 'Available model tools',
  无: 'None',
  系统指令长度: 'System instruction length',
  字符: 'characters',
  'Gmail 查询': 'Gmail query',
  数量上限: 'Maximum results',
  '邮件 ID': 'Message ID',
  类型: 'Type',
  写入: 'Write',
  ') 修订': ') revision',
  ') 编辑于': ') edited at',
  父页面: 'Parent page',
  '· 新页面《': '· New page “',
  文件夹: 'Folder',
  线程: 'thread',
  频道: 'Channel',
  目标: 'Target',
  正文: 'Body',
  尚未检查: 'Not checked',
  '需要重新认证：上游授权已失效，请重新连接':
    'Reauthentication required: authorization expired. Reconnect to continue.',
  未连接: 'Not connected',
  已连接: 'Connected',
  '逐次审批：每个操作都进入独立审批': 'Per-request approval: review every operation independently',
  '持续授权：读写与模型调用由策略自动放行（默认）':
    'Standing authorization: policy allows reads, writes and model calls automatically (default)',
  '导入客户端 JSON': 'Import client JSON',
  '连接 Google': 'Connect Google',
  取消授权流程: 'Cancel sign-in',
  输入: 'Enter',
  令牌: 'token',
  '远端撤销待重试，请再次点击断开。': 'Remote revocation pending. Click Disconnect to retry.',
  '正在等待浏览器授权…': 'Waiting for browser consent…',
  恢复持续授权: 'Restore standing access',
  改为逐次审批: 'Require approval',
  断开: 'Disconnect',
  连接提示: 'Connection tips',
  '连接即授权：连接后 Agent 可持续读写；改为逐次审批后每个操作都需你确认。':
    'Connecting grants standing access. Require approval to review every operation before it runs.',
  已授权: 'Authorized',
  '目录已变化，需重新确认': 'Directory changed; confirm again',
  '目录不可访问，需重新确认': 'Directory inaccessible; confirm again',
  未启用: 'Inactive',
  已就绪: 'Ready',
  待完成: 'Pending',
  '模型认证已过期。点击「使用已有 Codex 登录」或「登录 / 重新认证」更新，不需要断开 Pi。':
    'Model authentication expired. Use “Import Codex login” or “Sign in / Reauthenticate”; Pi can stay connected.',
  模型认证将于: 'Model authentication expires at',
  '到期，建议现在重新导入。': '; reimport your login now.',
  模型认证有效至: 'Model authentication valid until',
  'VM 内服务版本': 'VM service version',
  与应用版本: ' differs from app version',
  '不同，建议点击「修复 / 更新 Pi」同步。': '. Use “Repair / Update Pi” to synchronize.',
  当前可用磁盘: 'Available disk space:',
  'GB；安装至少需要 8 GB。': 'GB; installation requires at least 8 GB.',
  'QEMU 与 KVM 权限需要你在终端执行：':
    'Run these commands in a terminal to install QEMU and grant KVM access:',
  '安装 QEMU 需要你在终端执行：': 'Run this command in a terminal to install QEMU:',
  '加入 kvm 组后需退出登录并重新登录，再点「重新检查」。':
    'After joining the kvm group, sign out and back in, then select “Recheck”.',
  '执行后点「重新检查」。': 'Select “Recheck” after running the commands.',
  '下载 Lima 与 Codex': 'Download Lima and Codex',
  '查看 Linux 安装说明': 'Linux installation guide',
  '1 · 准备系统环境': '1 · Prepare your system',
  'Lima 与 Codex 由应用按固定版本和 SHA-256 下载到 ~/.local/share/anchi/tools，不需要管理员密码。':
    'Lima and Codex are downloaded to ~/.local/share/anchi/tools with pinned versions and SHA-256 verification. No administrator password is required.',
  '打开 Homebrew 安装包下载页': 'Download Homebrew installer',
  '先下载 Homebrew 的 .pkg 安装包，在系统安装器完成安装，再回到这里重新检查。':
    'Download the Homebrew .pkg, complete the system installer, then return here and recheck.',
  安装或补齐依赖: 'Install dependencies',
  '首次安装可能需要数分钟。': 'First installation may take several minutes.',
  重新检查: 'Recheck',
  进入对话: 'Open chat',
  安装系统依赖: 'Installing dependencies',
  '安装 Pi 环境': 'Installing Pi',
  解锁凭证库: 'Unlocking the vault',
  浏览器登录: 'Browser sign-in',
  导入已有登录: 'Importing existing login',
  取消登录: 'Cancel sign-in',
  '正在检查本机环境…': 'Checking your environment…',
  '此版本支持 Apple Silicon Mac 和 x86_64 Linux。请在支持的设备上运行。':
    'This build supports Apple Silicon Macs and x86_64 Linux. Use a supported device.',
  '· 服务版本': '· Service version',
  '修复 / 更新 Pi': 'Repair / Update Pi',
  '安装 Pi': 'Install Pi',
  启动环境: 'Start environment',
  已解锁: 'Unlocked',
  未解锁: 'Locked',
  '初始化 / 解锁': 'Initialize / Unlock',
  '使用已有 Codex 登录': 'Import Codex login',
  '登录 / 重新认证': 'Sign in / Reauthenticate',
  恢复模型调用持续授权: 'Restore automatic model calls',
  模型调用改为逐轮审批: 'Require approval per model turn',
  '首个任务已返回结果。你可以继续对话，或到「连接与权限」添加自己的资源。':
    'Your first task returned a result. Continue chatting or add resources in “Connectors”.',
  '任务未完成。检查模型认证和审批状态后重试。':
    'Task incomplete. Check model authentication and approval status, then retry.',
  'Pi 已连接': 'Pi connected',
  '连接 Pi': 'Connect Pi',
  开始示例任务: 'Start example task',
  查看待审批请求: 'View pending requests',
  查看结果: 'View result',
  '2 · 安装 Pi 安全环境': '2 · Install the secure Pi environment',
  '环境：': 'Environment: ',
  '独立 Linux 环境使用 4 GB 内存、最多 30 GB 虚拟磁盘；保留已有账户和工作区。':
    'The isolated Linux environment uses 4 GB memory and up to 30 GB virtual disk. Existing accounts and workspaces are preserved.',
  '3 · 连接模型': '3 · Connect a model',
  '凭证库：': 'Vault: ',
  '· 模型认证：': '· Model authentication: ',
  '登录会打开系统浏览器。使用你的 ChatGPT 订阅，短期访问令牌保存在隔离认证层。到期后从这里重新认证，已连接的 Pi 不需要断开。请备份本机主密钥；详情见使用说明。':
    'Sign-in opens your system browser and uses your ChatGPT subscription. Short-lived access tokens stay in the isolated authentication service. Reauthenticate here after expiry without disconnecting Pi. Back up your local master key; see the guide for details.',
  '4 · 完成第一个任务': '4 · Complete your first task',
  '示例：把一段虚构项目计划整理为三条待办。不需要连接邮箱或授权目录。':
    'Example: turn a fictional project plan into three action items. No mailbox connection or directory access required.',
  '模型调用 ·': 'Model calls ·',
  '先连接 Pi，再开始任务。持续授权下模型请求自动放行并记入审计；改为逐轮审批后才会进入「独立审批」等待确认。':
    'Connect Pi before starting. Standing authorization allows and audits model requests automatically. Per-turn approval pauses requests in “Approvals” for your review.',
  '从这里开始使用 Pi': 'Get started with Pi',
  '完成环境、模型登录和一次示例任务。Gmail 和本地目录可以稍后连接。':
    'Set up the environment, sign in to a model and try an example task. Connect Gmail and local directories later.',
  '已连接真实 agent': 'Agent connected',
  等待连接: 'Waiting to connect',
  检查环境: 'Check environment',
  '启动已有 VM': 'Start existing VM',
  刷新状态: 'Refresh status',
  你: 'You',
  开始一个新任务: 'Start a new task',
  '先连接，再开始对话': 'Connect to start chatting',
  '描述你的需求，或试试「介绍一下你自己，不要使用工具」。':
    'Describe what you need, or try “Introduce yourself without using tools.”',
  '首次使用请完成「首次设置」，然后连接 Pi。': 'Complete “Setup” first, then connect Pi.',
  任务执行中: 'Task running',
  '进入独立审批，核对真实请求': 'Open Approvals to review the actual request',
  查看审批: 'View approvals',
  新会话: 'New session',
  恢复会话: 'Resume session',
  加载历史: 'Load history',
  停止任务: 'Stop task',
  你的本地工作助理: 'Your local assistant',
  '与 Pi 的对话': 'Conversation with Pi',
  会话与权限说明: 'Sessions and permissions',
  '新会话不继承旧审批。模型认证由隔离认证层托管；认证过期时在「首次设置」重新导入即可，不需要断开 Pi。':
    'A new session does not inherit old approvals. Model authentication stays in the isolated service. If it expires, reimport your login in “Setup” without disconnecting Pi.',
  '本地目录通过 host_files 工具访问；shell 仅能访问 cell 工作区。默认持续授权：读写与模型调用由策略自动放行并记入审计；可在「权限」中改为逐次审批。':
    'Local directories are accessed through host_files; shell only accesses the cell workspace. Standing authorization allows and audits reads, writes and model calls automatically. Change to per-request approval in permissions.',
  '＋ 选择只读目录': '＋ Read-only directory',
  '＋ 选择读写目录': '＋ Read/write directory',
  只读: 'Read-only',
  读写: 'Read/write',
  重新确认: 'Confirm again',
  启用授权: 'Enable access',
  '尚未选择目录。建议原始资料只读、结果目录读写。':
    'No directories selected. Use read-only access for source material and read/write access for output.',
  '正在载入连接器…': 'Loading connectors…',
  '凭证库已锁定，请先在首次设置解锁。': 'Vault locked. Unlock it in Setup first.',
  明确每一项访问范围: 'Control each resource’s access',
  '目录授权持续至撤销；重新打开应用时会先核对目录身份，只有同一目录才自动恢复。':
    'Directory grants last until revoked. On restart, access restores only after the directory’s identity is verified.',
  本地目录: 'Local directories',
  '目录由宿主文件代理逐次校验权限，不直接挂载到 VM。撤销会等待已开始的操作结束。':
    'The host file broker checks every operation; directories are not mounted into the VM. Revocation waits for operations already in progress.',
  '支持最多 24 KB 的 UTF-8 文本读写、创建子目录和删除普通文件。覆盖或删除的文件会移入该目录下隐藏的 .anchi-trash 供你找回，Agent 看不到它。列表最多 100 项。拒绝隐藏路径、符号链接、硬链接和常见凭证目录。':
    'Read and write UTF-8 text up to 24 KB, create subdirectories and delete regular files. Replaced or deleted files move to the hidden .anchi-trash for recovery; agents cannot access it. Lists contain at most 100 entries. Hidden paths, symbolic links, hard links and common credential directories are blocked.',
  '凭证只由 VM 认证层保存。默认连接即持续授权：读取、写入与模型调用由策略自动放行并记入审计；任一 connector 可改为逐次审批。写入始终绑定目标修订并受每日次数上限。':
    'Credentials stay in the VM authentication service. Connections default to standing authorization: policy allows and audits reads, writes and model calls. Each connector can require approval instead. Writes remain bound to target revisions and daily limits.',
  从策略服务刷新: 'Refresh from policy service',
  '· 到期': '· Expires',
  '已刷新，当前没有待审批请求。': 'Up to date. No requests awaiting approval.',
  '尚未载入。点击刷新获取最新状态。': 'Not loaded. Refresh to get the latest requests.',
  '这是一次写入：批准后立即向外部服务写入下方内容。':
    'This is a write: approval immediately sends the content below to the external service.',
  批准这份请求: 'Approve this request',
  拒绝: 'Deny',
  撤销: 'Revoke',
  请求: 'Request',
  到期: 'Expires',
  '下方为完整动作内容，可能包含将发送到模型的文件或邮件正文。请核对后决定。':
    'The full action below may include file or email content sent to the model. Review it before deciding.',
  '完整 JSON': 'Full JSON',
  独立审批: 'Approvals',
  '请求详情直接读取可信策略服务；agent 的消息只能提示有请求，不能批准自己。':
    'Details come directly from the trusted policy service. Agent messages can notify you, but cannot approve requests.',
  读取最近审计: 'Load recent audit',
  '尚未读取。审计只含事件、时间、请求 ID 和内容摘要哈希。':
    'Not loaded. The audit contains events, timestamps, request IDs and content hashes only.',
  'VM 中还没有审计记录。': 'No audit records in the VM yet.',
  活动记录: 'Activity',
  '桌面只保存事件类型、时间和标识，不保存聊天与审批正文；完整策略审计存于 VM，可在下方读取。':
    'The desktop stores event types, timestamps and identifiers, not chat or approval bodies. Full policy audit is stored in the VM and can be loaded below.',
  '策略审计（VM）': 'Policy audit (VM)',
  'Shell 命令': 'Shell command',
  'Notion 搜索': 'Notion search',
  'Google Drive 搜索': 'Google Drive search',
  '读取 Gmail 邮件': 'Read Gmail message',
  'Gmail 搜索': 'Gmail search',
  本地文件操作: 'Local file operation',
  'Pi 已连接，可以开始任务': 'Pi connected and ready for tasks',
  'Pi 已断开连接': 'Pi disconnected',
  连接器状态已更新: 'Connector status updated',
  'Gmail 连接状态已更新': 'Gmail connection updated',
  环境设置状态已更新: 'Setup status updated',
  有请求需要审批: 'A request needs approval',
  任务执行异常: 'Task error',
  'Agent 通信异常': 'Agent communication error',
  其他活动: 'Other activity',
  记录: 'Record',
  工具: 'Tool',
  任务已取消: 'Task cancelled',
  已取消: 'Cancelled',
  任务已完成: 'Task completed',
  成功: 'Success',
  任务失败: 'Task failed',
  失败: 'Failed',
  任务已结束: 'Task ended',
  已结束: 'Ended',
  '开始：': 'Starting: ',
  开始: 'Started',
  执行失败: 'failed',
  执行结束: 'finished',
  结束: 'Finished',
  需审批: 'Needs approval',
  异常: 'Error',
  审批请求已批准: 'Request approved',
  审批请求已拒绝: 'Request denied',
  审批授权已撤销: 'Authorization revoked',
  审批: 'Approval',
  活动已记录: 'Activity recorded',
  '尚无活动。连接 Pi 并开始任务后，记录会显示在这里。':
    'No activity yet. Connect Pi and start a task to see events here.',
  时间未知: 'Unknown date',
  事件: 'Event',
  '审批 ID': 'Approval ID',
  时间: 'Time',
  错误: 'Error',
  错误代码: 'Error code',
  未知时间: 'Unknown time',
  详情: 'Details',
  最近: 'Latest',
  '条活动 · 最新在前 · 本地时间': 'activities · Newest first · Local time',
  '模型认证已过期。进入首次设置点击「使用已有 Codex 登录」或「登录 / 重新认证」，不需要断开 Pi。':
    'Model authentication expired. Open Setup and use “Import Codex login” or “Sign in / Reauthenticate”; Pi can stay connected.',
  '模型认证已过期。进入首次设置点击「使用已有 Codex 登录」重新导入，不需要断开 Pi。':
    'Model authentication expired. Open Setup and use “Import Codex login”; Pi can stay connected.',
  '模型服务拒绝了当前认证。请在首次设置重新登录后再试。':
    'The model rejected your authentication. Sign in again in Setup and retry.',
  '会话上下文已达网关上限。请点击「新会话」继续，或拆分任务。':
    'This session reached the context limit. Start a new session or split the task.',
  '订阅用量已达上限，请稍后再试。': 'Subscription usage limit reached. Try again later.',
  '已达到本 VM 每日模型请求上限，明天再试或调整任务。':
    'This VM reached its daily model request limit. Try tomorrow or adjust the task.',
  '本轮工具循环已达上限。请把任务拆小后再发送。':
    'This turn reached the tool-loop limit. Split the task and try again.',
  '等待审批超时，任务已停止。需要时重新发送，会生成新的审批。':
    'Approval timed out and the task stopped. Resend if needed to create a new approval.',
  'Gmail 授权已失效。请在「连接与权限」重新点击「连接 Google」。':
    'Gmail authorization expired. Select “Connect Google” in Connectors.',
  '凭证库已锁定，请进入首次设置解锁后重试。': 'Vault locked. Unlock it in Setup and retry.',
  '设置正在进行，请等待完成。': 'Setup is in progress. Please wait.',
  '请先点击左下角「停止并断开 Pi」，再重建运行环境。':
    'Select “Stop & disconnect Pi” in the sidebar before rebuilding the environment.',
  '请先在步骤 1 安装系统依赖。': 'Install system dependencies in step 1 first.',
  '请先完成步骤 2 的 Pi 安装；环境停止时先启动。':
    'Install Pi in step 2 first; start the environment if it is stopped.',
  '请先初始化或解锁凭证库。': 'Initialize or unlock the vault first.',
  '安装至少需要 8 GB 可用磁盘空间，请腾出空间后重试。':
    'Installation requires at least 8 GB free disk space. Free up space and retry.',
  '请先连接 Pi，并等待当前任务结束。': 'Connect Pi and wait for the current task to finish.',
  'Pi 尚未连接。请完成首次设置后连接。': 'Pi is not connected. Complete Setup and connect first.',
  '请先从步骤 1 的链接安装 Homebrew，再重新检查。':
    'Install Homebrew using the link in step 1, then recheck.',
  '未找到宿主 Python。请在首次设置步骤 1 安装依赖。':
    'Host Python was not found. Install dependencies in Setup step 1.',
  '尚未安装 Lima。请在首次设置步骤 1 点击「下载 Lima 与 Codex」。':
    'Lima is not installed. Select “Download Lima and Codex” in Setup step 1.',
  '无法连接可信服务。请检查 VM 是否运行，必要时在首次设置中修复 Pi。':
    'Cannot connect to the trusted service. Check that the VM is running; repair Pi in Setup if needed.',
  '目录已被移动或替换，请在「连接与权限」重新确认后再访问。':
    'The directory moved or was replaced. Confirm it again in Connectors.',
  '目标在审批期间被修改，写入已取消。请重新读取后再试。':
    'The target changed during approval. The write was cancelled. Read it again and retry.',
  '该目录包含应用运行代码或工具安装文件，不能授予写权限。请选择独立的工作目录。':
    'This directory contains app code or installed tools and cannot allow writes. Choose a separate workspace.',
  '无法安全覆盖此文件：需要非空修订号；Google 文档目前仅支持读取和新建。':
    'Cannot safely overwrite this file: a nonempty revision is required. Google Docs supports reading and creation only.',
  '远端写入结果不明，请先到对应账户核对，避免重复提交。':
    'The remote write result is unknown. Check the account before resubmitting to avoid duplicates.',
  '该请求的远端结果仍不确定，已阻止重复执行。请到对应账户核对。':
    'This request’s remote result is still unknown. Duplicate execution was blocked. Check the account.',
  'Drive 只允许更新由本应用创建的文件。': 'Drive can update only files created by this app.',
  'Bot 尚未加入该频道，请先在 Slack 中邀请它。':
    'The bot has not joined this channel. Invite it in Slack first.',
  '上游授权已失效，请在「连接与权限」重新连接。':
    'Provider authorization expired. Reconnect in Connectors.',
  '该连接器今日写入次数已达上限。': 'This connector reached its daily write limit.',
  '令牌格式不正确，请检查前缀与长度。': 'Invalid token format. Check the prefix and length.',
  '上游服务限流，请稍后再试。': 'Provider rate limit reached. Try again later.',
  '该连接器使用 Google 授权，不接受粘贴令牌。':
    'This connector uses Google sign-in, not pasted tokens.',
  '该连接器使用令牌导入，不走 Google 授权。':
    'This connector uses token import, not Google sign-in.',
  '此版本支持 Apple Silicon Mac 和 x86_64 Linux。':
    'This build supports Apple Silicon Macs and x86_64 Linux.',
  '下载内容校验失败，未安装任何文件。请检查网络后重试。':
    'Download checksum failed; nothing was installed. Check your network and retry.',
  '下载被重定向到未知主机，已拒绝，未安装任何文件。':
    'Download redirected to an unknown host and was blocked. Nothing was installed.',
  '下载内容超过大小上限，已中止，未安装任何文件。':
    'Download exceeded the size limit and was stopped. Nothing was installed.',
  '下载重定向次数过多，已中止，未安装任何文件。':
    'Too many download redirects. Nothing was installed.',
  '下载失败，未安装任何文件。请检查网络后重试。':
    'Download failed; nothing was installed. Check your network and retry.',
  关闭: 'Close',
  桌面开发版: 'Development build',
  '● Pi 任务执行中': '● Pi task running',
  '● Pi 已连接': '● Pi connected',
  '◌ 正在连接 Pi': '◌ Connecting to Pi',
  '○ Pi 未连接': '○ Pi disconnected',
  首次设置: 'Setup',
  连接与权限: 'Connectors',
  '未找到 secure-vm': 'secure-vm not found',
  '正在启动已有 VM…': 'Starting the existing VM…',
  'VM 已启动。重启后可能需要先解锁凭证库。':
    'VM started. You may need to unlock the vault after a restart.',
  '本地任务已取消。待审批请求请在独立审批页拒绝或撤销。':
    'Local task cancelled. Deny or revoke pending requests in Approvals.',
  '恢复 Pi 会话': 'Resume Pi session',
  '没有已保存会话。': 'No saved sessions.',
  '恢复上下文不恢复授权，也不自动执行任务。':
    'Restoring context does not restore authorization or automatically run tasks.',
  '已取消。': 'Cancelled.',
  '模型调用已恢复持续授权。': 'Automatic model authorization restored.',
  '模型调用改为逐轮审批；待消费的授权已作废。':
    'Model calls now require per-turn approval. Unconsumed grants were revoked.',
  '已取消授权，现有权限未改变。': 'Cancelled. Existing permissions are unchanged.',
  '已允许持续只读访问。': 'Standing read-only access enabled.',
  '持续读取已撤销；待处理审批已撤销。': 'Standing read access and pending approvals revoked.',
  展开导航: 'Expand navigation',
  收起导航: 'Collapse navigation',
  '已取消，现有设置未改变。': 'Cancelled. Existing settings are unchanged.',
  '已恢复持续授权。': 'Standing authorization restored.',
  '已改为逐次审批；待消费的授权已作废。':
    'Per-request approval enabled. Unconsumed grants were revoked.',
  '本机凭证已删除。Notion 没有远端撤销接口，请到 Notion 设置中移除该集成。':
    'Local credentials removed. Notion has no remote revocation API; remove the integration in Notion settings.',
  '任务已完成。可继续对话，或返回首次设置查看下一步。':
    'Task completed. Continue chatting or return to Setup for next steps.',
  'Pi 提示需要审批。请进入独立审批页，从策略服务读取详情。':
    'Pi requested approval. Open Approvals to load details from the policy service.',
  'Pi 错误：': 'Pi error: ',
  '模型调用失败：': 'Model call failed: ',
  '打开 app.notion.com/developers/connections（需为工作区 Owner），在 Internal connections 新建连接，Configuration 里勾选读取、插入、更新内容并复制 Installation access token（ntn_ 开头），再把测试页面共享给该连接。':
    'Open app.notion.com/developers/connections as a workspace Owner. Create an Internal connection, enable read, insert and update content under Configuration, copy the Installation access token (ntn_ prefix), and share a test page with the connection.',
  '在 api.slack.com 创建应用并安装到工作区，复制以 xoxb- 开头的 Bot User OAuth Token。':
    'Create an app at api.slack.com, install it in your workspace, and copy the Bot User OAuth Token starting with xoxb-.',
  '保存失败，请重试。': 'Could not save. Try again.',
  '安装 Lima、Python 和 Codex CLI。软件从 Homebrew 下载，会占用磁盘空间。':
    'Install Lima, Python and Codex CLI. Software is downloaded through Homebrew and uses disk space.',
  '创建或更新本机 Linux 环境并安装 Pi。分配 4 GB 内存和最多 30 GB 虚拟磁盘，下载可能需要数分钟。已有凭证和工作区保留。':
    'Create or update the local Linux environment and install Pi. Allocates 4 GB memory and up to 30 GB virtual disk; downloads may take several minutes. Existing credentials and workspaces are preserved.',
  '在本机创建或使用已有主密钥，解锁 VM 内凭证库。请保留 ~/.config/secure-vm/vault.key；丢失后需重新连接账户。':
    'Create or reuse a local master key to unlock the VM vault. Keep ~/.config/secure-vm/vault.key safe; losing it requires reconnecting accounts.',
  '打开 Codex 的浏览器登录，使用本机 Codex 账户缓存。短期访问令牌加密导入 VM，刷新令牌不会交给 Pi。已连接的 Pi 可以保持连接。':
    'Open Codex browser sign-in using the local account cache. Only the short-lived access token is encrypted and imported into the VM; Pi never receives the refresh token. Pi can stay connected.',
  '读取本机已有 Codex 订阅登录，仅将短期访问令牌导入 VM。已连接的 Pi 可以保持连接。':
    'Read the existing local Codex subscription login and import only its short-lived access token into the VM. Pi can stay connected.',
  '继续设置 Pi？': 'Continue Pi setup?',
  取消: 'Cancel',
  继续: 'Continue',
  '授权 Agent 访问所选目录': 'Allow agent access to a directory',
  '读写（含覆盖和删除文件）': 'read and write (including overwriting and deleting files)',
  读取: 'read',
  '允许 Agent': 'Allow the agent to',
  '此目录？': 'this directory?',
  授权: 'Allow',
  '导入 Google Desktop OAuth 客户端 JSON': 'Import Google Desktop OAuth client JSON',
  恢复: 'Restore',
  '的持续授权？': 'standing authorization?',
  '此后 Agent 的操作由策略自动放行，不再逐条审批。读取到的内容若含有提示注入，可能直接触发写入或模型调用；仍有修订核对、内容与次数上限和完整审计。':
    'Agent operations will be allowed automatically without individual approval. Prompt injection in retrieved content may trigger writes or model calls directly. Revision checks, content and usage limits, and auditing remain in place.',
  '将删除本机保存的令牌并撤销持续读取；Notion 没有远端撤销接口，请到 Notion 设置中移除该集成。':
    'Remove local tokens and standing access. Notion has no remote revocation API; remove the integration in Notion settings.',
  '将撤销持续读取、移除本机凭证并尝试撤销远端令牌；在途操作无法回滚。':
    'Revoke standing access, remove local credentials and attempt remote token revocation. In-flight operations cannot be rolled back.',
  独立权限审批: 'Independent permission approval',
  '批准当前已查看的请求？': 'Approve the request you reviewed?',
  确认: 'Confirm',
  '该请求？': 'this request?',
  '请先核对审批页完整动作。批准可能向模型发送所列内容并产生费用。':
    'Review the full action on the approval page first. Approval may send the listed content to the model and incur charges.',
  '目录配置损坏或版本不兼容，已保留原文件且禁用配置写入。请备份并恢复配置。':
    'Directory configuration is corrupt or incompatible. The original file is preserved and writes are disabled. Back up and restore the configuration.',
  '已将配置目录从 Qisuo 迁移到 Anchi。': 'Configuration directory migrated from Qisuo to Anchi.',
  '目录授权未恢复：': 'Directory access was not restored:',
  '。请在「连接与权限」重新确认。': '. Confirm it again in Connectors.',
  '安栖 · 本地 Agent': 'Anchi · Local Agent',
  安栖: 'Anchi',
  编辑: 'Edit',
  窗口: 'Window',
  '设置正在进行，请等待完成。浏览器登录可在首次设置页取消。':
    'Setup is in progress. Please wait. Browser sign-in can be cancelled in Setup.',
  '结束 Pi 连接并退出？': 'Disconnect Pi and quit?',
  '本地任务将停止。VM 保持运行，远端在途操作可能继续完成。':
    'The local task will stop. The VM stays running; remote operations already in progress may still complete.',
  保留窗口: 'Keep open',
  停止并退出: 'Stop and quit',
  无法启动安栖: 'Unable to start Anchi',
  '请检查运行资源是否完整。': 'Check that the runtime resources are complete.',
  主导航: 'Main navigation',
  '◈ 安栖': '◈ Anchi',
  '本地 Agent 工作空间': 'Local agent workspace',
  '正在加载…': 'Loading…',
  '停止并断开 Pi': 'Stop & disconnect Pi',
  '个人空间 /': 'Personal space /',
  '真实 Pi · 受控目录 · 隔离认证': 'Real Pi · Controlled directories · Isolated credentials',
  输入令牌: 'Enter token',
  保存到隔离凭证库: 'Save to isolated vault',
  '令牌只经本窗口和主进程进入 VM 加密库，不会显示在聊天页面或活动记录中。':
    'Tokens pass through this window and the main process into the encrypted VM vault. They never appear in chat or activity logs.',
  '只读邮件（gmail.readonly）': 'Read-only mail (gmail.readonly)',
  '邮件内容可能进入 agent 上下文与云模型。':
    'Email content may enter agent context and cloud models.',
  '读取全部文件；新建文件；仅可覆盖本应用创建且具备修订号的文本文件（drive.readonly + drive.file）':
    'Read all files; create files; update only app-created text files with revisions (drive.readonly + drive.file)',
  '文件正文可能进入 agent 上下文与云模型；更新绑定目标修订。':
    'File contents may enter agent context and cloud models. Updates are bound to target revisions.',
  '内部集成令牌；只能访问你在 Notion 中共享给该集成的页面':
    'Internal integration token; access only pages you share with the integration in Notion',
  '页面内容可能进入 agent 上下文与云模型；追加绑定页面编辑时间。':
    'Page content may enter agent context and cloud models. Appends are bound to the page’s edit time.',
  'Bot 令牌，需 channels:read、channels:history、groups:read、groups:history、chat:write；只能读取 bot 已加入的频道':
    'Bot token with channels:read, channels:history, groups:read, groups:history and chat:write; read only channels the bot has joined',
  '频道消息可能进入 agent 上下文与云模型；发消息受每日次数上限。':
    'Channel messages may enter agent context and cloud models. Posting is subject to daily limits.',
  '安装失败。请检查网络；macOS 上另查看 Homebrew 的系统安装提示，然后重试。':
    'Installation failed. Check your network and, on macOS, Homebrew system prompts, then retry.',
  '安装未完成。检查网络和可用磁盘后重试；已有凭证和工作区会保留。':
    'Installation incomplete. Check network and disk space, then retry. Existing credentials and workspaces are preserved.',
  '解锁失败。已有加密凭证时必须使用原来的主密钥，不能生成替代密钥。':
    'Unlock failed. Existing encrypted credentials require the original master key; do not generate a replacement.',
  '登录未完成或已过期，请重新登录；浏览器授权需由你完成。':
    'Sign-in incomplete or expired. Sign in again and complete browser consent yourself.',
  '未找到可用的 Codex 订阅登录，或令牌即将到期。请点击登录后再导入。':
    'No usable Codex subscription login found, or the token is about to expire. Sign in, then import again.',
  '上次设置被中断。请重新检查并重试相应步骤；不会自动删除已有数据。':
    'Previous setup was interrupted. Recheck and retry the step. Existing data will not be deleted automatically.',
  '上次设置步骤已完成。': 'The previous setup step completed.',
  '处理中，请保持应用打开。': 'Working. Keep the app open.',
  '此步骤已完成，可以继续下一步。': 'This step is complete. Continue to the next step.',
  '登录完成，正在将短期访问令牌导入隔离认证层。':
    'Signed in. Importing the short-lived access token into the isolated authentication service.',
  '这是首次使用的示例任务。仅根据以下虚构文本，整理成三条待办清单，不要调用任何工具：周一整理项目需求，周二写出设计初稿，周三与团队评审。':
    'This is an onboarding example. Using only this fictional text, make three action items without calling any tools: organize project requirements on Monday, draft the design on Tuesday, and review it with the team on Wednesday.',
  '已有 secure-vm 已启动': 'Existing secure-vm started',
  '已停止本地任务。待审批记录仍需拒绝/撤销，在途远端操作不会回滚。':
    'Local task stopped. Pending approvals must still be denied or revoked; remote operations are not rolled back.',
  '目录授权已生效；可通过 host_files 工具访问。':
    'Directory access is active through the host_files tool.',
  模型调用: 'Model calls',
  '目录权限已更新，撤销前已开始的操作已结束。':
    'Directory permissions updated. Operations started before revocation have finished.',
  '，远端令牌已撤销': '; remote token revoked',
  'Google 授权已超时。': 'Google sign-in timed out.',
  '可以关闭此页面，返回安栖查看连接结果。':
    'You can close this page and return to Anchi to check the connection.',
  'Google 授权未完成，请重新连接并检查凭证库是否解锁。':
    'Google sign-in incomplete. Reconnect and check that the vault is unlocked.',
  'Pi 启动超时，请检查安装与 cell 占用。':
    'Pi startup timed out. Check installation and whether the cell is occupied.',
  'Pi 连接进程启动失败。': 'Could not start the Pi connection process.',
  完成: 'Completed',
  '会话：': 'Session: ',
  '发送给 Pi 的需求': 'Your request for Pi',
  '描述你希望完成的任务…': 'Describe the task you want to complete…',
  发送: 'Send',
  改为: 'Switch to ',
  撤销并移除: 'Revoke and remove',
  查看完整请求: 'View full request',
  '。': '.',
  '：': ':',
  '》': '”',
  '？': '?',
  '输入 {0} 令牌': 'Enter {0} token',
  '审批 {0}：{1}': 'Approval {0}: {1}',
  '{0} 令牌已导入。': '{0} token imported.',
  '{0} 已保存令牌，但账户探测失败，显示为未验证。':
    '{0} token saved, but the account probe failed. Shown as unverified.',
  '{0} 已断开{1}。': '{0} disconnected{1}.',
  '{0} 已连接。Agent 的读取仍由独立策略控制。':
    '{0} connected. Agent access is still controlled by independent policy.',
  '文件访问 {0} · {1}/{2} · {3}': 'File access {0} · {1}/{2} · {3}',
  '目录授权未恢复：{0} · {1}。请在「连接与权限」重新确认。':
    'Directory access not restored: {0} · {1}. Confirm it again in Connectors.',
  '用发行版的包管理器安装 qemu-system-x86_64 和 qemu-img':
    'Install qemu-system-x86_64 and qemu-img using your distribution’s package manager.',
  '拒绝该请求？': 'Deny this request?',
  '撤销该请求？': 'Revoke this request?',
  '允许 Agent {0}此目录？': 'Allow the agent to {0} this directory?',
  撤销操作: 'Undo',
  重做: 'Redo',
  剪切: 'Cut',
  复制: 'Copy',
  粘贴: 'Paste',
  全选: 'Select all',
  '关于 Anchi': 'About Anchi',
  '退出 Anchi': 'Quit Anchi',
  最小化: 'Minimize',
  缩放: 'Zoom',
  'Pi 错误：{0}': 'Pi error: {0}',
  '模型调用失败：{0}': 'Model call failed: {0}',
};
