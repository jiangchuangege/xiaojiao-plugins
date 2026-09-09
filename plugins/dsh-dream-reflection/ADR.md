# Architecture Decision Records

## ADR-001：单一 RunCoordinator 拥有全部可变状态

**状态**：已接受（实现于 `src/reflection/coordinator.ts`）。

**决策**：scheduler、`/dream` 命令与（可选的）job adapter 只能提交 `RunRequest`；cursors、candidates、leases、budget 与 run 台账的写入只发生在 `RunCoordinator` 内部，最终统一收敛到一个 settle 路径（停心跳 → 事务内验证 fencing → 提交/回滚 → 结算预算 → 释放租约 → 完成 Promise）。

**理由**：多条执行路径各自持锁与水位是重复提交与水位错乱的经典来源；一个 owner + 一个 settle 使「失败不改可见状态」「迟到结果零提交」成为结构性不变量而非约定。

## ADR-002：状态落在插件自有的 SQLite，不用 `storageDomain`

**状态**：已接受（实现于 `src/store/`）。

**决策**：`dreamReflectionStore` Service Definition + `node:sqlite` provider，库位于 `$DSH_HOME/dream-reflection/state.sqlite`，WAL + busy timeout + `BEGIN IMMEDIATE` 事务、租约 + fencing token。

**理由**：`storageDomain` 只有 web bundle 挂载且无多进程写入协调；插件需要覆盖 base/headless/web 且要求跨进程单飞与预算对账。未来可增加 storageDomain provider，核心引擎不依赖具体介质。

## ADR-003：候选先隔离，人类命令批准，无模型批准工具

**状态**：已接受。

**决策**：所有候选默认 `quarantined`；`/dream approve` 只允许 quarantined 的 medium/high，revision CAS；不注册任何模型可调用批准工具；V1 无自动提升开关。approved 卡片经 `ctx.systemPrompt.context()` 同步 provider 注入，AgentLoop 物化为可回放 snapshot。

**理由**：模型不得批准自身产物（自我提升面）；人类命令是 V1 唯一审批通道。

## ADR-004：零自定义 SessionEvent

**状态**：已接受。

**决策**：不追加任何 `dream/*`/`reflection/*` 事件。辅助 LLM 调用的审计用可重建 audit record（prompt/sanitizer/schema 版本 + refs + 哈希 + usage）；approved 内容只经官方动态上下文 snapshot 进入会话日志。

**理由**：树外插件事件不在当前构建的 `KNOWN_SESSION_EVENT_TYPES` 中，且下游事件注册面尚未提供；自造事件会让插件卸载后 Session 无法恢复。

## ADR-005：工作区身份 = 规范化 cwd 的加盐 HMAC

**状态**：已接受（实现于 `src/corpus/workspace.ts`）。

**决策**：exact cwd（最深存在祖先 realpath）+ 实例随机 salt 的 HMAC-SHA256 作为稳定键；库与日志不输出原始绝对路径；scanner 从 Session 元数据重建 `workspaceKey → canonical cwd` 瞬时映射。

**理由**：跨进程确定性 + 不可逆（防路径泄漏）；exact 匹配杜绝前缀/别名误合并。

## ADR-006：日预算 = actual + reserved 累计对比上限

**状态**：已接受（实现于 `src/store/sqlite.ts::reserveBudget`）。

**决策**：先预留再调用；结算释放预留并累计 actual；上限判据为「已结算 actual + 在飞 reserved + 本次预留 ≤ 日上限」。缺 usage 时按预留量计，绝不按零计。

**理由**：若只对「在飞预留」设限，串行调用会在每次结算后释放预留，日上限形同虚设；累计语义才是费用上限。

## ADR-007：近重复门 0.9（针对本实现的混合向量）

**状态**：已接受，待公开评测集复核。

**决策**：词 unigram/bigram/trigram + CJK 三字组哈希进 512 桶的单位向量，余弦 ≥ 0.9 判近重复。实测近同句单词差异 ≈0.905、CJK ≈0.886。

**理由**：0.92 会漏掉单/双词差异的近重复；0.9 是当前向量设计的实测可工作点。正式承诺需自有/公开评测集校准（方案 §6.7/R15）。

## ADR-008：语料 allowlist 与「最后完成 turn 边界」

**状态**：已接受（实现于 `src/corpus/build.ts`）。

**决策**：只消费 `user/message`（`source.kind==='user'`）与 `assistant/message` 的 text block，排除注入上下文/工具/chunk/推理/命令；只处理最后一个 `turn/end` 之前的事件；预算截断的事件留给下一轮（不推进其水位）。

**理由**：半个 turn 与注入上下文会把非用户语义带入反思；预算截断不推进水位是「最早未消费事件优先」公平性的实现。
