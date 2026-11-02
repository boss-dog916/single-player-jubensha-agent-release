# macOS / Windows 内测安装

1. 安装Node.js 22.16以上和Git，克隆源码，进入含package.json的目录。
2. 运行npm ci。苹果电脑用cp .env.example .env创建配置，Windows PowerShell用Copy-Item .env.example .env；已有.env不重复覆盖。
3. 推荐“**千问付费主模型＋百炼赠送额度Observer**”：填QWEN_API_KEY（千问按量付费Key）和BAILIAN_API_KEY（百炼Key）。模板已填千问QWEN_BASE_URL与百炼BAILIAN_BASE_URL。Qwen3.8负责AI玩家、DM及规划审核，DeepSeek只作公开信息判断。主链用量大，不靠有限赠额撑整局；Observer在作者试玩中用量较少，单独利用有效赠额省开支，不是全部默认走百炼。
4. 保留LLM_THINKING_MODE=disabled；模型须支持非思考、Chat Completions、JSON对象输出与长上下文。完整配置和其他兼容API填法见[README](../README.md#环境与安装)。Observer单独配置，不会借主模型Key。
5. 执行npx prisma generate、npm run db:init。自动创建个人storage/app.db并应用迁移，无资源包也能建库，但会提示尚未安装预置剧本。可重复初始化，不重置存档。
6. 获得合法资源后运行npm run preset:install -- "本地ZIP或目录完整路径"。ZIP直接包含bundle.json和assets/，或再套一层目录。不需要Python、系统unzip、作者数据库或历史GameSession。
7. 运行npm run runtime:check，查看configurationProblems与实际endpointIdentity：主模型应指向千问，Observer指向百炼。推荐配置的provider=bailian是内部适配器标签，去向由地址决定。这一步不调用模型，不验证Key、模型权限或余额。
8. 运行npm run dev，打开http://localhost:3000/developer；另开终端运行npm run access:local获取本机凭证，解锁后去/scripts选择已安装剧本并创建新游戏。

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
