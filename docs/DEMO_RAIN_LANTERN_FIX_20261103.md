# 《雨灯未灭》读本与回应修复（2026-11-03）

仅修改release源码；现有个人库只读检查，回归使用独立临时数据库、Mock模型和实际玩家API。未发送真实模型请求，未改写现有存档或商业Runtime。

## 真实证据

演示局：cmw0dw6da0003ejzs201hjv8k。模型接入正常：qwen3.8-flash，千问兼容API，thinking关闭，输出预算2400。Observer单独配置为百炼deepseek-v4.1-flash，不负责角色读本。

| 角色读本AgentRun | 请求耗时 | 请求前排队 |
| --- | ---: | ---: |
| cmw0dwbz1000wejzscpys84pj（林安） | 21.684秒 | 0秒 |
| cmw0dwsq00010ejzsph25zsq4（沈牧） | 25.626秒 | 21.703秒 |
| cmw0dxci40014ejzs5rhs17ec（乔晚） | 15.217秒 | 47.332秒 |

三次调用均成功，Prompt各约4957–4979字符，无超限或重试证据；整体读本等待约62.6秒。旧演示局没有runtimeDefinitionId，落入LLM整理读本路径，并受既有前台并发1限制；已发布Runtime则直接加载结构化角色本。没有通过调整模型或放大并发解决问题。

回应失败：cmw0dyu85001qejzsbo4wv7lh的Planner调用成功，但将“我是林安女朋友”标为direct_question_to_self，同时addressing.directTargets却是发言者role_d。目标语义自相矛盾，导致discussion_orchestrator记录cmw0dyu7h001mejzsvb7hfstm失败，ConversationState随后为failed。此处不是网络或Checker拒绝。

## 修改

- aiPlayerInternalReading.ts：仅原生demo-script改为确定性加载当前角色完整私本、分享项及禁令；保留历史记忆，CAS事务原子保存单次阅读回执与无LLM的span。已完成的旧阅读不重复写入；原Runtime读取路径不变。
- scriptPackageService.ts：读取演示包时将遗漏角色追加到分享顺序，不移动原有位置，不改数据库中的scriptJson。旧三幕名单漏了role_a，选择其他真人角色时会遗漏林安分享。
- aiPlayerReactionPlanner.ts：只对普通关联陈述中明确的“回复接收者误填为提问对象”矛盾做降级，作为普通相关内容交给原调度器；不强制制造回复。保留真正点名、群体邀请和排除规则。原模型输出仍保存在原AgentRun，返回意图说明归一化原因。
- aiPlayerReactionPlannerPrompt.ts：明确addressing分析输入消息，不分析模型将要说的回复。

## 验证与边界

定向入口：

```bash
npx vitest run src/lib/services/demoPlaythrough.test.ts src/lib/agents/aiPlayerReactionPlanner.test.ts src/lib/access/playerEntry.test.tsx src/lib/services/rolePrivateKnowledge.test.ts --reporter=dot
npm run typecheck
```

覆盖三幕读本、四名角色依次分享、普通身份介绍故障注入、失败状态下新消息恢复、点名讨论、DM收束与下一幕，最终finished；读取无模型调用，重复读本不新增回执，本人完整私本保留且不引入其他角色或未来幕。共享权限和历史保密测试一并运行。

这证明程序流程可完成，不代替真实模型质量验收。演示本仍走分幕分享流程：轮到真人时统一使用聊天“发送”，自动将普通陈述作为正式分享并推进下一位；提问和引用回复保留当前分享回合，输入区显示用途并允许手动校正。草稿仅用于整理。AI回合仍点击“让该AI分享”，自由讨论后点击“进入下一幕阅读”（最后一幕会结束）；它不是《长夜》同等完整的Runtime演绎与分支体验。普通身份陈述可以不接话；真正问题仍按原策略选择回应者。其他模型语义矛盾、超时或网络故障仍可能出现。

现有局可在停止、重启release服务后继续，无需删库或重开；下一次读本采用新加载方式，原已保存发言和历史错误不改写。旧失败发言不自动付费重试，用户可重新发言或继续分享。未自动重启当前服务、提交或推送。
