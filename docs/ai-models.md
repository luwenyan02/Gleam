# AI 模型预设维护

最近增量核对日期：2026-10-22，本次仅按用户指定调整阿里百炼三项预设；其他平台预设沿用2026-09-07版本。运行时按最近三个日历月筛选。仅收录适用于本应用的对话模型，基础调用采用 Chat Completions，聊天搜索的 Responses 适配见下文；不为凑满数量加入生图、语音或嵌入模型。

## 平台目录与来源

| 平台 | 预设模型 | 官方日期依据 |
| --- | --- | --- |
| 阿里百炼 | deepseek-v4.1-flash-1017、qwen3.8-max-0902、qwen3.8-flash、kimi-k3、qwen3.7-flash | 分别于 10-17、09-02、08-26、08-19、07-21 上架，见[上下架记录](https://help.aliyun.com/zh/model-studio/newly-released-models) |
| OpenAI | gpt-6-astra、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna | Astra 09-03 发布，5.6 系列 07-09 发布，见[API Changelog](https://developers.openai.com/api/docs/changelog) |
| DeepSeek | deepseek-v4-flash-vision-exp、deepseek-v4-pro、deepseek-v4-flash | 08-21 视觉实验版、08-13 Pro 正式版、07-31 Flash 正式版，见[更新日志](https://api-docs.deepseek.com/zh-cn/updates/)。官方调用 ID 不套用百炼的快照后缀 |
| 硅基流动 | zai-org/GLM-5.3、deepseek-ai/DeepSeek-V4-Flash、meituan-longcat/LongCat-2.0、zai-org/GLM-5.2、moonshotai/Kimi-K2.7-Code | [模型中心](https://siliconflow.cn/models)提供平台 ID 和日期；Flash 采用页面明确描述的 0731 正式版本，其他日期为 08-14、06-30、06-17、06-12 |
| Moonshot Kimi | kimi-k3 | 07-16 发布，见[技术博客](https://www.kimi.ai/blog/kimi-k3)与[平台接入文档](https://platform.kimi.com/docs/guide/kimi-k3-quickstart) |
| 智谱 GLM | glm-5.2 | 06-16 发布，见[新品发布](https://docs.bigmodel.cn/cn/update/new-releases)。不把其他供应商的 ID 或未核验的平台版本直接搬入 |

2026-10-22 按用户最新要求，用 `deepseek-v4.1-flash-1017` 替换百炼 `deepseek-v4-flash-0731`，并移除 `deepseek-v4-pro-0813` 和 `qwen3.7-plus` 的内置预设。新版 Flash 支持图片与文本，兼容 Chat Completions，见[DeepSeek API](https://help.aliyun.com/zh/model-studio/deepseek-api)。移除预设不删除用户已保存的模型，也不屏蔽用户主动获取的接口返回项；原有三个月筛选、数量限制与其他平台保持不变。

## 展示与兼容约定

- 候选去重、最多 10 个（不含“自定义输入”操作），标明日期与“图片／文本”或“仅文本”。不自动覆盖已保存的模型。
- “获取模型列表”仅在用户点击后请求当前接口，缓存按接口地址隔离。API 列表不保证包含真实发布日期或视觉能力，明确标为未核验。
- 这是离线维护目录，不自动联网更新。后续需再次核对官方日期、平台调用 ID、模态与参数，不能把网页更新时间当作模型发布时间。
- 目录不保证用户账号、地域或套餐拥有所有模型权限，需使用自己的 API Key 测试。

## 请求兼容与测试边界

### 文字聊天联网搜索（2026-10-20）

用户当前使用阿里百炼 `qwen3.8-max`。按[联网搜索](https://help.aliyun.com/zh/model-studio/web-search)及[Responses API](https://help.aliyun.com/zh/model-studio/compatibility-with-openai-responses-api)文档，普通聊天对已确认支持的百炼模型调用原地域／业务空间下的 `/compatible-mode/v1/responses`，携带 `tools: [{ type: 'web_search' }]`，由模型按问题判断是否搜索。该协议从 `web_search_call.action.sources` 返回来源，不能把 Chat Completions 的 `enable_search` 与仅 DashScope 原生协议支持的 `enable_source`／`enable_citation` 混用。

2026-10-21 性能排查补充：按[千问 Responses 参数表](https://help.aliyun.com/zh/model-studio/qwen-api-via-openai-responses)，Qwen3.8 Max／Flash 在此接口默认最高 `xhigh` 思考强度；发送 `reasoning: { effort: 'none' }` 延续普通聊天原先关闭思考的响应策略，不套用 Chat Completions 参数。Qwen3.7 支持开关的版本使用 `enable_thinking: false`，排除仅思考的 Max preview／2026-05-17；其余模型不新增思考字段。流式响应仍以整个 `response.completed` 为成功边界，文字完成事件不冒充整轮完成；清理流的异步取消不阻塞已确认的完成或失败。

Android 流式补充：全局 CapacitorHttp 会先读完 POST 正文，并按行重建时去掉末尾一个换行；这既使回复整包交付，也让旧解析器遗漏最后的 completed 帧。AI 流式 POST 改走专用原生通道，按需读取有界原始字节，由 JS ReadableStream 交给同一解析器；非流式请求、云备份及全局 HTTP 配置沿用。EOF 可结束最后一帧的分帧，但仍须明确协议终态；Responses 的 done 全文快照按内容索引校正，不能单凭任一 done 或 EOF 宣布成功。取消、原生超时、销毁和测试网络隔离均须覆盖原生通道；云端合成验证不等于手机／实际服务验收。

分别记录可搜索、搜索中、实际已搜索、未使用搜索、当前配置未接入和未完成状态；只根据工具完成事件或实际用量确认执行，不根据模型正文猜测。来源仅采用已完成工具返回的 HTTP(S) 链接，去重、限长、过滤凭据和可执行协议，不预加载来源网页或站点图标；点开后在浏览器查看。API 不保证每次返回来源，已搜索而无可用链接时如实显示。搜索状态及来源随对应消息和未完成检查点存储，重新回答不继承旧来源。

搜索请求使用本机显式构建的最近上下文，发送 `store: false`，不使用服务端 `previous_response_id`；服务商的数据规则仍适用。生活 AI 已开启时，聊天以点击发送为准，不再逐条弹出素材确认；关闭时保留一次启用确认，整理、周刊及账本范围仍独立确认。搜索查询由服务商处理，可能产生费用，帮助中保留说明。搜索失败不静默回退重发；账本分析、含财务分析的上下文、记账、整理和周刊不启用搜索。其他服务商或未知自定义代理继续原聊天协议，不推断其搜索能力。模拟响应／事件与多宽度浏览器回归不等于实际账号、地域和手机的百炼服务验收。

- GPT-6 Astra 不发送不支持的 `temperature`；GPT-5.6 使用默认采样和低推理强度，见 [OpenAI 模型指导](https://developers.openai.com/api/docs/guides/latest-model)。
- Kimi K3 使用低推理强度，不发送固定采样参数，见[平台重要限制](https://platform.kimi.com/docs/guide/kimi-k3-quickstart)。
- Kimi K2.7 Code 同样不发送固定采样参数，见[官方参数限制](https://platform.kimi.com/docs/guide/kimi-k2-7-code-quickstart)；DeepSeek、GLM 等其余模型保留原有 `temperature: 0`。
- 百炼 Qwen3.7/3.8 记账请求显式关闭思考，降低同步等待，见[深度思考文档](https://help.aliyun.com/zh/model-studio/deep-thinking)。
- 已知仅文本模型在发送截图前给出明确提示；不凭自定义模型名称猜测能力。
- 自动测试拦截模拟 AI 响应，只验证选择、持久化和请求参数。本轮未读取真实 Key、调用付费模型或验证所有供应商实际连通性。
