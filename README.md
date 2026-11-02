# 《如果长夜无明》单人剧本杀 Multi-Agent 系统

一名真人扮演角色，AI玩家与DM共同完成读本、讨论、追问、演绎和剧情选择。项目将模型的角色表达、语义判断与确定性的状态推进分开，重点解决多角色协作、知识边界、长上下文和失败恢复。目前已实现《如果长夜无明》的完整全局体验。

技术栈：TypeScript、Next.js、React、Prisma / SQLite、OpenAI兼容模型接口。当前是**本地单用户应用**，不建议直接部署成公网服务。

## 游戏界面展示

> 截图待补：主界面与DM演绎、连续剧本阅读页、右侧纸条匹配区。
>
> 此处预留真实试玩截图位置；尚未附图，不使用生成图冒充游戏画面。发布截图时需隐去密钥、私本和未授权内容。

## 核心技术

| 方向 | 实现与边界 |
| --- | --- |
| Multi-Agent协作 | 角色Reaction Planner提出回应意图，Orchestrator有界选人，Generator生成、Checker检查；支持点名、群体邀请及AI间追问 |
| FSM与剧情编排 | 大阶段由FSM控制，版本化Runtime与DM Cursor管理节点、条件补问、确认、分支、匹配与结束；模型反馈不直接改游标 |
| 角色知识隔离 | 按角色、幕次、已读回执和合法分支加载私本；共享带来源的合法历史知识与有效禁令，区分原文、公开声称和推测 |
| Semantic Observer | 根据公开消息判断剧情信息是否出现，返回消息ID与原文引用；程序校验来源、新鲜度和权限，超时回unknown |
| Context Engineering | 保留合法私本与相关历史证据，按请求预算做同源去重、有界压缩和最终长度保护；不改写长期记忆，不保证无限长对话 |
| 异步预生成与可靠性 | 可选ShareDraft将生成/审核前移，结合输入指纹、CAS租约及事务消费；持久待办、revision与回执控制过期写回及重复提交，Trace区分排队/请求/解析 |

分享预生成当前默认关闭；这是已实现并有历史演示实验的机制，不代表所有游戏都启用或获得固定加速比。系统仍可能出现模型误判、漏答或超时，权限检查不等于语义“零剧透”保证。

## 已实现功能与当前限制

- **可运行的审核剧本**：分幕PDF读本、跨幕记忆、公开讨论、回复引用、DM演绎、结构化选择、纸条匹配、线索授权及本地恢复。
- **真实验证范围**：《如果长夜无明》v3红本路线，六幕主线使用真实LLM并经人工操作/恢复到达第七幕finished；尾声为确定性流程、禁止模型调用。不能理解成双分支均真实通关或无人值守无故障运行。
- **v4状态**：修复版Runtime已发布并完成配置/Mock及入口验证，未宣称v4已完成真实全流程通关。红黑两路线的完整流程覆盖以既有Mock为准。
- **任意剧本上传是实验功能**：保留PDF/DOCX提取、语义候选、编译与校验，需要人工审核；不保证“上传任意剧本即玩”，扫描PDF等资料也有局限。
- **本地应用边界**：不是公网多租户产品；本机开发者拥有高权限，可查看完整调试信息。没有公网级限流、隔离沙箱或分布式exactly-once保证，Windows仍需实机反馈。

### 源码与剧本资源分开

**GitHub只公开程序，不包含完整《如果长夜无明》剧本资料、角色PDF、答案或商业Runtime正文。** 没安装合法资源包时，不能从源码直接玩完整商业剧本。

如需了解剧本包获取方式，可通过[仓库Issues](https://github.com/boss-dog916/single-player-jubensha-agent/issues)联系维护者。维护者只在确认合法使用或分发许可后考虑提供，**不承诺所有请求都能获得资源**，也不在公开Issue中贴私本或答案。

MIT的适用范围仅限维护者有权授权的程序源码，不覆盖第三方剧本、PDF及其他素材。**当前仓库尚缺LICENSE文件**；维护者确认源码权属并补齐许可证前，不应把本README当作完整MIT授权文件。

## 快速安装与模型API配置

要求Node.js **22.16或以上**、npm和Git。详细macOS/Windows步骤、模型要求、费用与常见配置错误见[INSTALLATION.md](docs/INSTALLATION.md)。

~~~bash
npm ci
~~~

复制配置：苹果电脑执行cp .env.example .env；Windows PowerShell执行Copy-Item .env.example .env。已有.env不要覆盖。

推荐使用**千问按量付费主模型＋百炼DeepSeek Observer**：

| 配置 | 用途 |
| --- | --- |
| QWEN_API_KEY | 千问按量付费Key，供玩家、DM及规划/生成/审核；模板已填千问API地址 |
| BAILIAN_API_KEY | 百炼Key，Observer用量较少，作者试玩时利用有效DeepSeek赠额省开支 |

按模板填写自己的两把Key，保留LLM_THINKING_MODE="disabled"。provider=bailian是现有适配器标签，实际两条服务地址分别由QWEN_BASE_URL和BAILIAN_BASE_URL决定；以runtime:check打印的endpointIdentity为准。替代模型须支持非思考、Chat Completions、JSON对象输出和足够上下文，详细兼容参数见安装说明。

作者完整《长夜》试玩主模型链路经验用量约**6–10M Token（600–1000万，输入＋输出累计）**，不是单次上下文、固定费用或用量上限；讨论、重试和开关都会改变消耗。Observer另计，赠额受账号、模型、地域和有效期影响，用完可能收费；检查主/备用模型额度及平台“用完即停”设置。两平台密钥不要混用，也不要把Key或.env提交到仓库。

~~~bash
npx prisma generate
npm run db:init
npm run runtime:check
npm run dev
~~~

默认个人库是storage/app.db，不合并作者旧库。打开http://localhost:3000/developer，另开终端执行npm run access:local获取本机凭证，解锁后进入/scripts。Ctrl+C停止，重启后继续自己的存档。

标准dev/start入口默认只监听127.0.0.1；显式传入hostname会覆盖此默认值。不要直接运行绕过入口的对外监听命令或把端口转发到公网。

配置检查不调用模型、不验证Key余额或模型权限；实际开始游戏后会产生模型调用。修改.env后需重启，git pull不会自动更新已有.env。

## 安装独立剧本资源包

取得完整且合法授权的v4包后：

~~~bash
npm run preset:install -- "/本地路径/long-night-v4-beta.zip"
# 或传入包含bundle.json和assets的目录
npm run preset:install -- "/本地路径/解压后的资源目录"
~~~

安装后刷新剧本库，从详情页创建新游戏。ZIP允许套一层目录，资源与Runtime校验后写入本机受保护的storage；重复安装不会重复导入，冲突不覆盖用户数据。不依赖作者数据库或历史GameSession。

当前支持local-script-preset-v1的long-night-v4包；普通PDF压缩包不是预置包，不支持ZIP64、加密或分卷。哈希完整性校验不代表版权许可或来源签名。

## 已知问题与反馈

- 解析仍实验性，v4真实全流程、Windows及真实API兼容性仍需后续反馈。
- 模型可能超时或出现语义错误；保留日志中的Trace ID，按游戏提示恢复，不要通过重置存档掩盖问题。
- 请求入口已增加体积/数量保护，上传解析有单流解压上限；仍不是对任意恶意文件的完整沙箱。
- 依赖仍有未修复告警；Zod/Prisma未强制跨大版本升级，入口限制不等于消除了所有依赖风险。
- 调试接口与剧本管理需开发者凭证；玩家响应做字段白名单。开发者调试可包含完整Prompt及私本，数据库和本机日志不应对外公开。

通过[Issues](https://github.com/boss-dog916/single-player-jubensha-agent/issues)反馈时，提供系统/Node版本、复现步骤、错误码和脱敏Trace ID；不要附Key、访问凭证、完整数据库或未授权剧本正文。

更多安装步骤见[INSTALLATION.md](docs/INSTALLATION.md)，公开边界见[PUBLIC_RELEASE_PREPARATION.md](docs/PUBLIC_RELEASE_PREPARATION.md)与[安全核对记录](docs/PUBLIC_RELEASE_FINAL_CHECK.md)。本项目只供本机单用户内测，不建议直接开放公网端口。
