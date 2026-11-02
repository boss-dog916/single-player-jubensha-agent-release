# Private → Public 切换前核对（2026-11-03）

本轮仅操作当前已推送的public-v1源码仓库，没有读取或改动原开发项目、数据库、剧本ZIP或Live；没有修改历史、提交、推送或切换GitHub可见性。下方11月1日记录保留为历史，不代表本轮状态。

## 历史及当前公开风险

- 当前HEAD为8461914。已检查全部可达引用：本地main、origin/main；远端heads/tags只读核对也只有同一main，无标签。3次可达提交、295个追踪文件、299个历史blob全部扫描，无超过扫描上限的遗漏。
- 既有审计脚本：敏感追踪路径0、历史敏感路径0、当前密钥命中0、历史密钥命中0、疑似Key/私钥blob为0。补充扫描GitHub Token、AWS访问Key格式、作者绝对路径及已知商业原文标记，也未命中。
- 未发现.env、数据库、PDF/DOCX、商业Runtime/私本、Live/AgentRun或日志进入该仓库历史；保留的是程序、通用Prompt和原创demo。自动标记扫描不构成完整版权或秘密审查保证。
- **个人信息仍在历史元数据中**：三次提交的作者/提交者包含个人姓名及带本机主机名的.local邮箱。它不是API凭据，公开仓库时同样会被公开；需维护者自行确认是否接受。本轮未改写或删除这些提交。
- **未发现需要因本次命中而撤销/轮换的实际凭据**；不打印或搬运任何完整密钥。脚本及详细扫描结果保存在本机/tmp，不进入仓库。

## 调试、鉴权与日志边界

- 38个API route文件中，36个使用developerRoute/playerRoute；另外2个是开发者/玩家凭证交换接口。debug、DM调试、剧本管理及AgentRun完整数据需开发者凭证；玩家接口采用响应字段白名单，PDF另有角色/幕/分支校验。
- 服务端页面在读取剧本库/游戏资料前检查凭证。凭证为本机随机秘密或HMAC签名；Cookie使用HttpOnly、SameSite=strict，变更请求检查来源；没有通过关闭鉴权解决问题。
- 模型路由输出只包含profile/endpoint而非Key，现有provider错误路径脱敏。完整Prompt/私本会保存在本机数据库供高权限调试；后台console.error也可能带私有业务信息，因此数据库、运行日志、调试页面不能公开发布。
- 以上是本地单用户边界，不是公网安全认证：没有公网登录限流/多租户隔离，不能将高权限调试接口暴露给不可信用户。

## 本轮必要加固

1. src/lib/access/requestLimits.ts：在业务handler/Zod之前按实际流读取字节，不能只信Content-Length。普通JSON上限1MiB；数组最多1000项、结构节点最多10000、嵌套最多32层，防止Zod 3累积海量校验错误；非法JSON返回400，超限413。
2. developerRoute/playerRoute：先鉴权及来源校验再限流量；维持玩家响应脱敏。大multipart预算只适用于指定上传POST路径，不能通过伪造Content-Type在普通JSON接口取得大预算。
3. 两个未登录凭证交换接口：请求体限4KiB，覆盖匿名可达入口；未增加模型或数据库操作。
4. 上传：总请求限101MiB，单文件限100MiB、只允许1个文件，字段最多16个、单文本元数据最多64KiB；元数据JSON同样检查结构再送后续校验，超限不进入文件存储。
5. parse-all：actIndices在Zod逐项处理前检查最多64项，Schema也增加max(64)，参数错误返回精简400而非大量issue详情。
6. DOCX/PDF现有解压调用增加32MiB输出限制；DOCX未压缩正文也限32MiB，PDF超限明确失败而非当作空流。只加资源保护，没有重写提取算法。此为正文/单流上限，不是整个PDF总解码/CPU沙箱，恶意复杂文件仍有残余风险。
7. 标准scripts/runtime.ts的dev/start默认监听127.0.0.1，避免Next默认0.0.0.0暴露到其他网卡；显式hostname参数仍可覆盖。build不改变，没有启动服务验证或真实游戏操作。

这些限制只针对HTTP输入与文件提取，不改Agent决策、角色记忆、Checker、Runtime、DM流程、选择机制或模型路由。CLI preset:install的ZIP安装不受HTTP上传大小限制，本轮未打开或修改资源包。

## 验证与剩余事项

- npm ci使用缓存、跳过安装脚本；显式Prisma generate仅生成类型客户端，没有连接/迁移数据库。TypeScript通过。
- 31项定向测试通过（3文件）：请求体缺长度/虚假长度、数组/深度/总节点、鉴权与来源、玩家响应脱敏、登录上限、上传及元数据、幕次数组在模型管线前拒绝、PDF/DOCX膨胀保护及普通提取。未跑全量测试、未调用模型。
- README已按简介→截图占位→核心技术→功能/验证边界→精简安装/API→资源包→问题与Issues重排。没有虚构截图；v3红线真实六幕＋确定性尾声与v4未真实全流程完成明确分开。INSTALLATION.md原样保留。
- 未升级依赖；沿用11月1日生产审计的8项（7 high、1 moderate），不称本轮重新审计结果。入口约束缓解已识别Zod路径，不修复包本身；Prisma/deepmerge、PostCSS、nanoid、source-map-js等剩余条件见历史表。
- **人工发布事项**：确认是否公开姓名/本机邮箱；仓库尚缺LICENSE，需确认源码权属并补齐拟采用的MIT文件。MIT不覆盖第三方剧本，资源包仅在合法使用/分发许可确认后考虑提供，Issues咨询不保证获得资源。Windows与真实API试玩仍待本人完成。

**结论：未发现实际凭据泄露等必须先撤销的安全阻断项，不等于零风险。**公开源码与部署公网是两件事：前者仍需处理上述隐私/授权事项；后者仍不建议直接进行。所有本轮修改留在工作区，未自动提交或推送。

---

# 发布前最小收尾（2026-11-01，历史记录）

最终交付目录名：`single-player-jubensha-agent-public-v1`。它是原开发项目的同级独立目录，不复制原.git或storage，不应与原先含资源的安装测试副本混用。本轮未初始化、创建或推送GitHub仓库。

## 生产依赖核对

以实际package-lock.json和npm audit --omit=dev为准；告警数是依赖节点数，不是独立可利用漏洞数。初始9项（8 high、1 critical），定向更新后8项（7 high、1 moderate、0 critical）。这不是安全清零结论。

| 实际版本 / 处理 | 漏洞条件 | 当前项目使用情况与结论 |
| --- | --- | --- |
| Next 15.5.19 → **15.5.28**，@next/env同步 | Windows文件系统上的App/Pages Router服务存在RCE；其他公告涉及Server Actions、缓存、rewrites、图片优化 | 使用App Router，且将供Windows内测，Windows风险明确，采用同一15.5补丁线。没有use server、next/image、Edge或自定义rewrites配置。其余条件未确认可触发，不将“未使用组件”当作全框架不可触发保证。现余Next告警仅来自PostCSS依赖链。 |
| Sharp 0.34.5 → **0.35.5** | 解码恶意SVG/HEIF等图片；公告中的SVG RCE涉及glibc Linux图片优化 | 没有使用图片优化组件，但旧可选依赖仍安装。Next 15.5.28明确允许^0.35.5，定向刷新此依赖，未新增图片功能。 |
| Prisma / @prisma/config **6.19.3** → deepmerge-ts **7.1.5**，保留 | 两个被合并对象在同一路径递归引用，导致栈耗尽；deepmerge-ts修复版8.0.0 | 仅Prisma CLI配置合并链；本项目无prisma.config.ts，不将上传内容或玩家消息送入该配置合并，普通JSON也不包含自引用。未发现游戏请求可达条件。不强制覆盖内部依赖或迁移Prisma 7。三项high节点保留。 |
| PostCSS：Next内 **8.4.31**、构建侧 **8.5.15**，保留 | 处理攻击者CSS中的sourceMappingURL时可读本地文件；旧stringify输出嵌入HTML可XSS；<=8.5.22另有map读取修复不完整告警 | 仅构建本仓库Tailwind/全局CSS；上传入口是PDF/DOCX，未找到把玩家或剧本文本当CSS处理的路径。Next内部固定8.4.31，未用override强制替换。生产审计的PostCSS和Next传递告警保留。 |
| Nanoid **3.3.12**，保留 | 非安全生成器负size，或自定义生成器size=0，导致死循环；修复版3.3.18覆盖两项 | 项目无直接调用；Next的PostCSS调用nanoid(6)，size不是用户输入。不为降低告警数字改动未证实可达的路径。 |
| source-map-js **1.2.1**，保留 | 恶意indexed source map中的section offset导致事件循环DoS；修复版1.2.2 | 由PostCSS构建源映射使用，未接收玩家上传的map，不是正常游戏消息处理链。 |
| Zod **3.25.76**，保留 | 超大集合逐元素校验并积累错误，可能耗尽内存；公告修复版4.6.6 | 确实用于API和LLM校验；例如受开发者鉴权的parse-all接口scope.actIndices是数组，没有长度上限，存在有条件资源耗尽风险，不能宣称不受影响。跨Zod 4会影响现有Schema/SDK，超出本轮安全补丁范围，故明确保留。只供本机内测，不承诺公网防护。 |

依据：[Next Windows公告](https://github.com/vercel/next.js/security/advisories/GHSA-p293-qw3h-jr36)、[Next 15.5.28安全公告](https://github.com/vercel/next.js/security/advisories/GHSA-2464-fhr4-w9xw)、[deepmerge-ts维护者公告](https://github.com/RebeccaStevens/deepmerge-ts/security/advisories/GHSA-ggr8-5vv4-36mx)、[PostCSS维护者公告](https://github.com/postcss/postcss/security/advisories/GHSA-6g55-p6wh-862q)、[Zod修复PR](https://github.com/colinhacks/zod/pull/6652)。Nanoid、source-map-js版本范围来自npm审计原始GHSA记录。未执行audit fix或force，未升级Prisma/Zod大版本。

## 源码及权限边界

10个Agent、14个Prompt、状态机、调度和env配置与上一公开快照逐文件一致；完整合法私本、记忆、Checker原则、DM流程与玩法不改。所有非测试应用模块继续保留，TypeScript用于检查完整模块依赖；公开测试使用原创通用场景，不依赖商业夹具。

仅将一个旧私有回归工具的资源路径移到忽略的storage/test-fixtures/activity-sources.json。正常上传解析使用传入的ActivitySourcePack与activitySourceEvidence，不调用该读私有夹具的函数；它们继续完整保留。预置导入仍从用户明确提供的ZIP或目录读取，缺包不冒充已安装。可选的presetRolePolicy仅随合法包安装，不是启动必需资源。

公开目录不含.env、API Key、作者绝对路径、PDF/DOCX/商业Runtime、数据库、Live、日志、node_modules或旧.git。通用提示词、DM兜底模板、模型配置、迁移和本地凭证入口保留。安装命令仍为README中的npm ci → 创建.env → prisma generate → db:init → 可选preset:install → runtime:check → dev；Observer需显式确认独立配置。

## 验证结果

最终快照验收：

- npm ci（本地缓存、跳过安装脚本）成功，显式prisma generate成功；与README要求的生成步骤一致。首次生成因本机缓存写权限失败，缺客户端引发的初次检查失败已保留日志；完成生成后重新检查通过，没有改业务代码绕过。
- 原工作区及最终快照TypeScript通过。7个公开测试文件62项全部通过，涵盖API隔离/Mock请求、ZIP防护、当前公开选项与DM互动范围、历史私本权限、结构化选择和状态机。
- db:init在没有.env或剧本包的目录应用24个迁移，明确提示尚未安装资源；Package/GameSession/AgentRun均为0，无真实模型请求。
- 非测试应用模块逐文件比对：app47、components21、src173、lib1、data1均保留且内容一致；24个迁移及migration_lock.toml也完整。公开测试替换的是商业评测资料，不替换业务模块。
- 已清理测试产生的node_modules、临时个人库和类型检查缓存。交付目录296个文件，最终扫描未发现作者路径、当前实际密钥或疑似Key/私钥，不含.git及资源目录；扫描不是完备的秘密检测保证。最终静态清单及日志留在原项目忽略的storage/private-audits/release-final-20261101，不随源码发布。

没有启动真实游戏、付费API或七幕测试；Windows和真实API不在本次验证范围。

## 创建全新仓库

先将源码许可证放入最终目录；商业包和原.git不要复制进来。进入最终目录后执行（先在GitHub手动建立空仓库）：

```bash
git init -b main
git add .
git status --short
# 检查待提交列表只有源码、配置、迁移和文档
git commit -m "Initial public source"
git remote add origin https://github.com/YOUR_NAME/YOUR_REPO.git
git push -u origin main
```

这些是提供给维护者的命令，本轮没有执行。以后更换模型或安装资源仍使用自己的.env与storage；两者保持忽略。

## 维护者仍需亲自处理

- 选择源码许可证并加入LICENSE。
- 确认剧本内容、PDF、答案及包提供方式的授权；源码不附商业资源。
- Windows实机和Node22最低版本验证。
- 自己配置API完成真实试玩；本轮配置/Mock检查不代表模型兼容或效果实测。
- 保留并评估未修复依赖风险；若准备公网部署，应另行处理鉴权/资源上限和重大依赖迁移。
