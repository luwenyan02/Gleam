# AI 模型预设维护

核对日期：2026-10-22。按用户确认更新六个平台的对话模型目录；百炼仅采用用户指定的替换和移除，不额外扩充。基础调用采用 Chat Completions，聊天搜索的 Responses 适配见下文。推荐代表已核验接口与模态的常用候选，不代表已用真实账号比较准确率或费用。

## 平台目录与来源

| 平台 | 推荐与近期型号 | 兼容版本及官方依据 |
| --- | --- | --- |
| 阿里百炼 | 推荐 deepseek-v4.1-flash-1017、qwen3.8-flash；保留 qwen3.8-max-0902、kimi-k3 | 保留 qwen3.7-flash。分别于10-17、08-26、09-02、08-19、07-21上架；见[上下架记录](https://help.aliyun.com/zh/model-studio/newly-released-models)。按用户要求移除 deepseek-v4-flash-0731、deepseek-v4-pro-0813、qwen3.7-plus 预设，不删除已保存值或屏蔽接口返回项 |
| OpenAI | 推荐 gpt-6.1-sol（09-29）、gpt-6-luna（09-22）；近期 gpt-6-sol（09-22）、gpt-6-astra（09-03） | GPT-5.6 Sol／Terra／Luna（07-09）转入兼容分组。均支持图片输入，见[API Changelog](https://developers.openai.com/api/docs/changelog)与[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol) |
| DeepSeek | 推荐 deepseek-flash：V4.1 Flash于09-10发布、10-17更新；保留文本模型 deepseek-v4-pro（08-13） | deepseek-v4-flash、deepseek-v4-flash-vision-exp 是兼容旧名，服务已转向 V4.1 Flash，均标为图片／文本并说明转向，不再按旧Flash阻止图片。见[更新日志](https://api-docs.deepseek.com/zh-cn/updates/)与[当前模型／价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)；不套用百炼的调用名 |
| 硅基流动 | 推荐 deepseek-ai/DeepSeek-V4.1-Flash（09-10，页面注明已更新至1017版）、zai-org/GLM-5.3-Flash（08-26）；近期 Qwen/Qwen3.8-27B、zai-org/GLM-5.3（均08-14） | 保留原 V4-Flash、LongCat-2.0、GLM-5.2、Kimi-K2.7-Code 兼容项。日期来自[模型中心](https://siliconflow.cn/models)的“发布时间”，不冒充平台部署日期；V4-Flash沿用页面明确的0731正式版本日期。前三款新模型支持图片，GLM-5.3仅文本 |
| Moonshot Kimi | 推荐 kimi-k3（07-16），不因超过三个月消失 | K2系列兼容项为 kimi-k2.7-code、kimi-k2.7-code-highspeed、kimi-k2.6，均支持图片。见[模型列表](https://platform.kimi.com/docs/models)与[K3指南](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)。不加入已下线的K2.5／moonshot-v1；本轮未核实K2系列各版本的确切发布日期，不填造日期 |
| 智谱 GLM | 推荐 glm-5.3-flash（08-26）、glm-5.3-flashx；近期 glm-5.3（08-19） | 保留 glm-5.2（06-16）为兼容项。Flash／FlashX支持图片，5.3／5.2仅文本；见[发布记录](https://docs.bigmodel.cn/cn/update/new-releases)及[Flash／FlashX文档](https://docs.bigmodel.cn/cn/guide/models/vlm/glm-5.3-flash)。FlashX调用名和能力已核验，确切上架日期未核实，不借用百炼上架日期 |

## 展示与兼容约定

- 当前配置置顶且去重，不因换平台、刷新目录或更新应用而自动换模型；已知型号保留核验后的能力，未知型号明确标为未核验。
- 分为“推荐模型／近期更新／兼容旧版”。推荐独立于日期，长期保留；其他预设根据明确的发布或版本更新日期判断最近三个日历月，较旧型号仍可在兼容分组选择。兼容不代表停服，转向别名单独说明。
- 首次发布／上架与版本更新分别保存。日期未知时不标假日期，也不将核对日期作为发布日期。
- “获取模型列表”仅在用户点击时请求当前接口，仍过滤生图、语音、嵌入等非本功能候选；缓存和选择器均不再截取前10个。完整候选可搜索，按接口地址隔离且去重；只在名称上命中视觉关键词的接口项仍标为能力未核验。
- 模型名称与能力说明在设置列表中分行显示，长平台前缀、转向说明和放大字体可完整阅读。
- 目录不自动联网更新；网页核查不等于账号、地域和套餐实际有权调用，真实服务测试由用户执行。

## 请求兼容与测试边界

### 文字聊天联网搜索（2026-10-20）

用户当前使用阿里百炼 `qwen3.8-max`。按[联网搜索](https://help.aliyun.com/zh/model-studio/web-search)及[Responses API](https://help.aliyun.com/zh/model-studio/compatibility-with-openai-responses-api)文档，普通聊天对已确认支持的百炼模型调用原地域／业务空间下的 `/compatible-mode/v1/responses`，携带 `tools: [{ type: 'web_search' }]`，由模型按问题判断是否搜索。该协议从 `web_search_call.action.sources` 返回来源，不能把 Chat Completions 的 `enable_search` 与仅 DashScope 原生协议支持的 `enable_source`／`enable_citation` 混用。

2026-10-21 性能排查补充：按[千问 Responses 参数表](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)，Qwen3.8 Max／Flash 在此接口默认最高 `xhigh` 思考强度；发送 `reasoning: { effort: 'none' }` 延续普通聊天原先关闭思考的响应策略，不套用 Chat Completions 参数。Qwen3.7 支持开关的版本使用 `enable_thinking: false`，排除仅思考的 Max preview／2026-05-17；其余模型不新增思考字段。流式响应仍以整个 `response.completed` 为成功边界，文字完成事件不冒充整轮完成；清理流的异步取消不阻塞已确认的完成或失败。

Android 流式补充：全局 CapacitorHttp 会先读完 POST 正文，并按行重建时去掉末尾一个换行；这既使回复整包交付，也让旧解析器遗漏最后的 completed 帧。AI 流式 POST 改走专用原生通道，按需读取有界原始字节，由 JS ReadableStream 交给同一解析器；非流式请求、云备份及全局 HTTP 配置沿用。EOF 可结束最后一帧的分帧，但仍须明确协议终态；Responses 的 done 全文快照按内容索引校正，不能单凭任一 done 或 EOF 宣布成功。取消、原生超时、销毁和测试网络隔离均须覆盖原生通道；云端合成验证不等于手机／实际服务验收。

分别记录可搜索、搜索中、实际已搜索、未使用搜索、当前配置未接入和未完成状态；只根据工具完成事件或实际用量确认执行，不根据模型正文猜测。来源仅采用已完成工具返回的 HTTP(S) 链接，去重、限长、过滤凭据和可执行协议，不预加载来源网页或站点图标；点开后在浏览器查看。API 不保证每次返回来源，已搜索而无可用链接时如实显示。搜索状态及来源随对应消息和未完成检查点存储，重新回答不继承旧来源。

搜索请求使用本机显式构建的最近上下文，发送 `store: false`，不使用服务端 `previous_response_id`；服务商的数据规则仍适用。生活 AI 已开启时，聊天以点击发送为准，不再逐条弹出素材确认；关闭时保留一次启用确认，整理、周刊及账本范围仍独立确认。搜索查询由服务商处理，可能产生费用，帮助中保留说明。搜索失败不静默回退重发；账本分析、含财务分析的上下文、记账、整理和周刊不启用搜索。其他服务商或未知自定义代理继续原聊天协议，不推断其搜索能力。模拟响应／事件与多宽度浏览器回归不等于实际账号、地域和手机的百炼服务验收。

- GPT-6 Astra 不发送不支持的 `temperature`；GPT-5.6 使用默认采样和低推理强度，见 [OpenAI 模型指导](https://developers.openai.com/api/docs/guides/latest-model)。
- Kimi K3 使用低推理强度，不发送固定采样参数，见[平台重要限制](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)。
- Moonshot K2.7 Code／Highspeed不能关闭思考，也不能传入固定`temperature: 0`，因此沿用服务默认参数；K2.6支持关闭思考，使用`thinking: { type: 'disabled' }`且不固定温度。见[Code参数限制](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart)与[K2.6参数限制](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)。硅基K2.7 Code继续省略固定采样参数。
- DeepSeek官方当前Flash、Pro及两个兼容旧名显式使用`thinking: { type: 'disabled' }`和`temperature: 0`，使普通同步任务的低随机性设置实际生效；思考模式下温度会被服务忽略。见[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)。不将这个原厂字段搬到百炼或硅基接口。
- 智谱GLM-5.3／Flash／FlashX使用服务默认参数，避免继承统一固定温度；Flash／FlashX仅支持开启思考，不发送关闭指令，依据上述官方模型文档。硅基其他模型保留其兼容接口已有参数，不因模型同名就套用原厂字段，见[硅基Chat Completions](https://docs.siliconflow.cn/cn/api-reference/chat-completions/chat-completions)。
- 百炼 Qwen3.7/3.8 记账请求显式关闭思考，降低同步等待，见[深度思考文档](https://help.aliyun.com/zh/model-studio/deep-thinking)。
- 已知仅文本模型在发送截图前给出明确提示；不凭自定义模型名称猜测能力。
- 自动测试拦截模拟 AI 响应，验证分组、当前值保留、完整列表搜索、能力提示与真实出站请求参数。本轮未读取真实 Key、调用付费模型或验证所有供应商实际连通性。
