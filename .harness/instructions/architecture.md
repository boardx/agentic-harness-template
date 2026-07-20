# 参考技术架构（reference stack）

> 渐进式披露第 3 层。这是模板推荐的**参考栈**——每层给出默认选型 + 选型理由 +
> 可替换点。硬约束只有一条（上游用真实需求换来的）：**架构必须可移植**——
> 同一套代码要能部署到不同云平台与私有环境，禁止把业务逻辑绑死在单一云的专有原语上。
> 组织本体/知识图谱的数据架构单独成篇：`docs/architecture/knowledge-ontology.md`。

## 分层总表

| 层 | 默认选型 | 为什么 | 可替换点 |
|---|---|---|---|
| 前端 | Next.js（App Router）+ Tailwind + shadcn/ui | SSR/RSC 与 API 同进程共享 session；组件可控 | 任意 SPA 框架，但保留「设计单源门控」模式（见下） |
| 后台 | Next.js API routes + **三层中间件**（Guard/Pipe/ErrorBoundary） | 纯函数 + Web 标准 Request/Response，Node 与 edge runtime 都能跑，零运行时分裂 | 换重框架（NestJS 等）的触发条件见上游案例：开放第三方 API / 强制模块边界 / 重型编排，三条有一再换 |
| AI（单轮） | **gateway 抽象层**（provider 可插拔）+ sanctioned stub | 模型/供应商必然更换，业务代码只依赖 gateway 接口；e2e 必须能在无真实 API key 时确定性通过 | 任意 provider（Anthropic/OpenAI/Qwen/本地模型），一个适配器一个文件 |
| Agent 编排（多步） | **LangGraph**（StateGraph + Postgres checkpointer） | 见下方「Agent 编排引擎」一节 | CrewAI/AutoGen 等，但先量化"到底是不是多阶段流水线"再选（见下） |
| 数据库 | PostgreSQL = canonical + **显式 SQL 迁移**（不用 ORM 魔法） | 单一事实源；迁移可读可审计；pgvector/AGE 扩展同库承载向量与图（免运维第二套存储） | 任意托管 PG / 自托管；迁移 runner 可换但迁移文件必须显式 SQL |
| 实时同步 | WebSocket + 服务端权威状态；协作编辑用 CRDT（如 Yjs） | 客户端断线重连/多端一致是常态不是异常 | 单机=自托管 ws 进程；边缘=Durable Object；**协议不变，载体可换**（协调协议 coord/0.1 就是这个原则的实例） |
| 图/本体 | Postgres + pgvector + **Apache AGE**（图投影可重建） | 见 knowledge-ontology.md——canonical 永远是关系表，图是投影 | 图查询层可换（Neo4j 等），但 canonical 在 PG 这条不变 |
| 对象存储 | S3 兼容接口（MinIO 自托管 / 云 S3） | 接口标准化，多云/私有随意切 | 任意 S3 兼容实现 |
| 缓存/队列 | Redis **仅运行时**（可丢失不可作为事实源） | 事实只在 PG；Redis 挂了系统降级不损数据 | 任意兼容实现，或小规模直接不用 |

## 部署三形态（同一套代码）

1. **单机私有**：docker compose（PG+MinIO+Redis）+ systemd 托管应用进程 + Caddy TLS。
2. **多云容器**：任意 k8s / 容器服务，镜像同一份。
3. **边缘混合**：静态/门户走边缘平台（Cloudflare Pages 等），有状态服务留守可移植层。
   边缘上的代码必须是纯 Web 标准（这正是后台选三层中间件而非重框架的原因）。

规则：**有 CD 的目标不手动部署**；迁移先于部署且幂等；冒烟带漂移探针
（模式见 `.github/workflows/examples/deploy-pattern.yml.example`）。

## Agent 编排引擎：多步 AI 功能用状态图，不手搓（上游真实教训）

产品里出现"多轮/多阶段"的 AI 功能（如深度研究、多步表单填写、需要人工确认才
继续的生成流程）时，**默认反应通常是手写一个临时状态机**——先用几个 if/switch
串起来，数据模型里加个 `status` 字段假装有阶段。这条路径的真实代价在上游被
验证过：手写状态机没有检查点持久化（进程重启/请求超时就丢状态）、没有条件边
（分支逻辑散落在业务代码里）、没有原生的人工中断点（"生成完计划、等用户确认
再继续"这种常见需求得靠额外的状态字段模拟）——而这些恰好是 **LangGraph**
（`@langchain/langgraph` + `@langchain/langgraph-checkpoint-postgres`）已经
生产验证过的能力。

**判断要不要上 LangGraph 的信号**：数据模型里已经有"阶段/状态"字段
（`status: pending/running/done` 这类），但执行代码是一次性完成、靠解析结果
硬编出多阶段的样子——这是最典型的"该用图、还在用字符串模拟图"信号。单轮生成
（一次 prompt 一次结果，没有阶段概念）不需要 LangGraph，继续用上面的 gateway
抽象层就够。

**落地要点**：
- checkpointer 选 Postgres（`@langchain/langgraph-checkpoint-postgres`），落在
  与业务表同一个 PG 实例——不为编排引擎引入第二个状态存储，呼应「canonical
  只有一个」的架构纪律。
- `interrupt_before`/`interrupt_after` 是"某阶段生成完、等人工确认再继续"的
  **原生实现**，不要再用额外字段手动模拟这条约束。
- 不要不分场景地把所有 AI 功能都套上 LangGraph——先量化"这个功能是不是真的
  多阶段流水线"，单轮生成硬套图模型是过度工程。

**边界（容易和多 agent 协调层混淆，务必分清）**：LangGraph 编排的是**产品内
一次请求内的多步执行**（节点=一次模型/工具调用，秒到分钟级生命周期），跟本
模板的**开发者协调协议**（`docs/coordination-protocol.md`——协调多个独立、
长时运行的开发 agent 会话，认领任务、心跳、交接，小时到天级生命周期）是完全
不同的两层问题。不要用 LangGraph 编排开发 agent 之间的协作，也不要用协调协议
模拟一次 AI 请求内的多步生成——两层各自有自己的状态载体和生命周期，混用会
让两边都变得难以推理。

## 三个必须建立的机械门控（上游血泪，缺一层就等出事）

1. **鉴权层**：`withAuth` 包裹所有需登录路由——handler 拿到非空 user，不再手写 401。
2. **校验层**：`withValidation(zod)`——校验层"根本不存在"是最常见的静默缺陷
   （上游实测 152 路由 0 校验库）。
3. **错误边界**：意外错误只回 `internal_error`，细节只进日志；**lint 门控**响应体里的
   `String(err)`/`err.message`（上游肉眼估 3 处泄漏，机器一扫 51 处）。

同理前端：**设计 token 单源**（字号/色彩比例尺一个文件定义）+ lint 拦超出比例尺的
硬编码值。原则：**能机器判定的一致性，绝不交给人肉抽查**。

## 不变量（实现必须遵守）

- 仓库即唯一事实来源；所有状态可从 PG + 迁移重建。
- 任何"看起来能跑"都不算数：feature 完成 = verification 命令退出码 0 + 证据落盘。
- 多 agent 并行时的资源互斥走协调协议（`docs/coordination-protocol.md`），
  禁止各自发明锁。
