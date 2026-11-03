# 安装与使用指南

1. 安装Node.js 22.16以上和Git，克隆源码，进入含package.json的目录。
2. 运行npm ci。苹果电脑用cp .env.example .env创建配置，Windows PowerShell用Copy-Item .env.example .env；已有.env不重复覆盖。
3. 推荐“**千问付费主模型＋百炼赠送额度Observer**”：填QWEN_API_KEY（千问按量付费Key）和BAILIAN_API_KEY（百炼Key）。模板已填千问QWEN_BASE_URL与百炼BAILIAN_BASE_URL。Qwen3.8负责AI玩家、DM及规划审核，DeepSeek只作公开信息判断。主链用量大，不靠有限赠额撑整局；Observer在作者试玩中用量较少，单独利用有效赠额省开支，不是全部默认走百炼。
4. 保留LLM_THINKING_MODE=disabled；模型须支持非思考、Chat Completions、JSON对象输出与长上下文。完整配置和其他兼容API填法见下方[配置自己的模型API](#配置自己的模型api)。Observer单独配置，不会借主模型Key。
5. 执行npx prisma generate、npm run db:init。自动创建个人storage/app.db并应用迁移，无资源包也能建库，但会提示尚未安装预置剧本。可重复初始化，不重置存档。
6. 获得合法资源后运行npm run preset:install -- "本地ZIP或目录完整路径"。ZIP直接包含bundle.json和assets/，或再套一层目录。不需要Python、系统unzip、作者数据库或历史GameSession。
7. 运行npm run runtime:check，查看configurationProblems与实际endpointIdentity：主模型应指向千问，Observer指向百炼。推荐配置的provider=bailian是内部适配器标签，去向由地址决定。这一步不调用模型，不验证Key、模型权限或余额。
8. 运行npm run dev，打开http://localhost:3000，点击「进入剧本库」（/scripts）选择已安装剧本并创建新游戏；普通玩家无需开发者凭证，选角后即可游玩。同一浏览器的本局凭证仍有效时，可从剧本库继续自己的游戏。

需要管理剧本、上传解析或查看Debug时，使用「开发者入口」（/developer），另开终端运行npm run access:local取得本机凭证，认证后进入/developer/scripts。开发者在游戏顶部可切换「预览玩家视角」，普通玩家不会收到Debug、AgentRun或Prompt数据。玩家凭证保存在HttpOnly Cookie中，有效期7天；清除Cookie、换浏览器或过期后需使用本局入口凭证恢复权限，不能只凭gameId读取游戏。

可复制的安装/启动命令：

~~~bash
npm ci
# 按上面的操作创建并编辑.env后再继续
npx prisma generate
npm run db:init
npm run preset:install -- "合法资源包.zip"
npm run runtime:check
npm run dev
~~~

Windows安装包示例：npm run preset:install -- "C:\Jubensha\剧本资源包.zip"（替换为自己的位置），路径带空格时保留双引号。

## 配置自己的模型API

模型API是程序连接模型服务的地址与访问密钥，需要自行向服务商申请；它不是聊天网页账号。用文本编辑器打开项目中的.env填写，真实Key不要发到Issues或提交Git。推荐模板使用两组服务：

| 配置 | 作用 |
| --- | --- |
| QWEN_API_KEY、QWEN_BASE_URL | 千问按量付费主模型，负责AI玩家、DM及规划、生成、审核；使用量较大 |
| BAILIAN_API_KEY、BAILIAN_BASE_URL | 百炼DeepSeek辅助模型，仅作Semantic Observer；作者利用有效赠额降低这部分成本 |

模板中的provider=bailian是适配器名称，不能据此理解成所有请求都走百炼。实际服务由两组地址分别决定，两把Key不能混用。推荐方案保留RUNTIME_LLM_BASE_URL/RUNTIME_LLM_API_KEY及Observer的两个覆盖字段为空，由各自平台配置供值。

使用其他OpenAI兼容服务时：

- 主模型显式设置RUNTIME_LLM_PROVIDER=compatible，并填写RUNTIME_LLM_MODEL、RUNTIME_LLM_BASE_URL、RUNTIME_LLM_API_KEY。
- Observer单独设置DM_SEMANTIC_OBSERVER_PROVIDER=compatible，并填写DM_SEMANTIC_OBSERVER_MODEL、DM_SEMANTIC_OBSERVER_BASE_URL、DM_SEMANTIC_OBSERVER_API_KEY；不会自动借用主模型的Key。可以选择同一家服务，但仍需明确配置这组字段。
- 模型须支持Chat Completions、JSON对象输出和关闭思考，并能容纳长剧本上下文。仅标注“OpenAI兼容”不代表所有参数都兼容；保留任务输出预算等默认值，先用npm run runtime:check检查，再由使用者自行做少量真实API验证。
- 不要只填旧OPENAI_*字段，也不要追加/chat/completions到BASE_URL。检查命令不调用模型、不验证实际余额或API能力；修改.env后必须重启服务。

## 试玩前：用量、费用与模型要求

- 作者《长夜》完整局的**玩家/DM主模型链路累计约6–10M Token（600–1000万，输入＋输出）**，是作者经验预算，不是本次测量或固定收费。包括同路由规划/审核，不是两个平台各6–10M、单次上下文或输出字数；讨论量、重试、剧本与开关可能使实际消耗更高。Observer另计，上传解析费用不在此参考中。
- 主模型用千问按量付费Key，与https://maas.qianwenaiapi.com/compatible-mode/v1配套；不混用订阅套餐Key或百炼Key。[千问接入](https://platform.qianwenai.com/docs/developer-guides/clients-and-developer-tools/chatbox)
- Observer用百炼DeepSeek赠额的前提是自己账号有模型权限、有效余额及匹配地域。作者当时够用不代表所有人免费；额度用完/过期可能收费，按需开启控制台“免费额度用完即停”。故障切换可能调用deepseek-v4.1-flash-1017，也核对其额度与收费。[百炼额度规则](https://help.aliyun.com/zh/model-studio/new-free-quota/)
- 保持enable_thinking:false对应的非思考模式；支持response_format={"type":"json_object"}，程序还会本地校验。不要选只能思考或不支持JSON参数的模型，推荐适配器还使用max_tokens设置输出上限。[JSON输出](https://platform.qianwenai.com/docs/developer-guides/text-generation/structured-output)、[思考设置](https://platform.qianwenai.com/docs/developer-guides/text-generation/thinking)
- 单请求应用窗口估计65,536 Token，包含输入估计、输出及预留，另有60k字符保护；与整局累计6–10M不同。保留默认超时/输出预算，换模型核对容量与接口兼容性。
- 费用按输入与输出分别计价，不用总Token乘一个统一单价，以平台用量/账单为准。开发者调试面板AgentRun显示模型、输入/输出Token和Trace；缺失usage的失败请求不能按0费用估算。[千问计费](https://platform.qianwenai.com/docs/resources/faq-billing)
- 已有.env不会随git pull更新。旧用户须检查QWEN_BASE_URL与两个RUNTIME覆盖项，确认实际路由后重启；只拉新说明不代表配置自动切换。

Ctrl+C停止，重新启动可恢复保存的游戏；不要复制别人的.env、凭证或数据库。第七幕尾声禁模型由《长夜》Runtime控制，不改动现有流程。

仓库不含商业剧本。未装合法资源包时，上传/解析仅为实验功能，须人工审核，使用独立BAILIAN_MANUAL_*配置且另有调用费用。当前仅支持local-script-preset-v1的v4包，普通PDF ZIP不能充当预置包；不支持ZIP64、加密和分卷ZIP。完整性校验不代表签名认证或版权授权。

此前只完成macOS本地安装/初始化及入口验收；Windows仍待实机反馈。文档更新不代表重新做了真实API或完整七幕测试。


## 玩家与开发者入口

入口与权限分开如下：

| 使用目的 | 访问路径 | 所需凭证 |
| --- | --- | --- |
| 首页 | / | 无；只提供「进入剧本库」「开发者入口」两个入口 |
| 玩家剧本库、开新局、继续自己的游戏 | /scripts | 浏览剧本与开局无需开发者凭证；开局自动签发本局玩家Cookie |
| 本局游戏与读本 | /games/本局gameId | 本局玩家Cookie，或有效的本局进入链接 |
| 开发者登录 | /developer | 终端运行npm run access:local获取本机凭证 |
| 剧本管理、上传与解析 | /developer/scripts | 已认证开发者；原/scripts/剧本ID管理详情页也仍需认证 |
| Debug与「预览玩家视角」 | 已认证开发者进入游戏后操作 | 开发者凭证；预览地址为/games/本局gameId?view=player |

玩家只看到可玩剧本的标题、版本、角色数和幕数，不获得Runtime正文、角色私本或匹配答案。继续列表仅列出本浏览器持有有效本局凭证的游戏；知道其他gameId不能读取其消息或私本。玩家凭证保存在HttpOnly Cookie中，有效期7天，清除Cookie、换浏览器或过期后需使用本局进入链接重新授权，数据库存档不会因此删除。

需要恢复本局进入权限时，维护者在同一项目目录运行npm run access:local -- --game 本局gameId --port 3000，生成10分钟内有效的本局链接，仅私下交给该局玩家。端口应与实际服务一致；不要分享开发者凭证或把进入链接贴到公开Issue。

开发者进入游戏默认保留Debug，点击「预览玩家视角」可查看隐藏调试面板后的布局，再点击「返回开发者视角」恢复。预览不撤销开发者权限，不能替代独立浏览器的权限验收；普通玩家不会收到Debug、AgentRun或Prompt数据。

标准dev/start入口默认仅监听127.0.0.1。本项目是本机单用户应用，不建议转发端口或直接部署到公网。

## 手工验收玩家入口

先在**这份源码所在目录**完成上面的安装、个人API配置和数据库初始化，再启动服务。如果3000端口已有其他项目，使用npm run dev -- --port 3001，并将以下地址的端口都换成3001。不同项目的.env、数据库和本机访问凭证互相独立，不会自动同步。

1. 用新的浏览器配置或独立无痕会话访问首页，确认只有「进入剧本库」「开发者入口」，没有旧的「新游戏」按钮和首页信息板选项。
2. 点击「进入剧本库」，应直接显示可玩剧本，不要求本机凭证；点击「开始游戏」应进入选角页。只验入口时可停在这里，确认选角后可能启动AI读本并消耗模型额度。
3. 返回/scripts，应在「继续我的游戏」看到刚才的一局；刷新、重启服务后，只要本局Cookie仍有效就能继续。
4. 普通玩家游戏中不应出现DEBUG、AgentRun、Prompt或开发者操作；信息板关闭且没有线索、纸条区域时，不应为Debug留空列。可在已有读本页面查看PDF底部提示，应为浅色背景上的深灰文字，无需推进剧情。
5. 另用没有本局Cookie的独立浏览器访问同一/games/本局gameId，应提示缺少凭证；访问/api/games/本局gameId、/api/games/本局gameId/debug或/api/script-packages应返回401，不显示私有数据。两个无痕窗口可能共享Cookie，请使用真正隔离的浏览器配置。
6. 在开发者专用浏览器访问/developer并输入本机凭证，应进入/developer/scripts；进入游戏后确认Debug仍可使用，并能切换「预览玩家视角」。这不会授权另一个浏览器访问调试接口。

没有安装商业资源包时，只显示原创演示及资源包提示；这不代表《如果长夜无明》已安装。无需为本轮入口验收重新跑完整七幕。

## 维护者文档导出提示

安装指南已移至根目录INSTALLATION.md。旧scripts/export-public.mjs仍按docs/INSTALLATION.md收集文档；如另行使用该历史快照导出工具，应核对产物并补入根目录安装指南及LICENSE。本轮只修改说明文档，未调整或执行导出脚本。正常克隆仓库不受影响。
