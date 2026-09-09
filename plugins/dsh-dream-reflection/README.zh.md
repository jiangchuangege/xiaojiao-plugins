# dsh-dream-reflection（做梦反思）

独立实现的 DeepSeek Harness **定时做梦反思**（dream-reflection）社区插件：在同一工作区的顶层会话中，以有界、脱敏、可追溯的方式定期构建证据，生成结构化的**反思卡片**，先进入隔离区（quarantine），只有人类通过 `/dream approve` 批准的卡片才会作为动态上下文进入该工作区后续的模型请求。

> 本插件不是 DeepSeek 官方产品，不承诺当前存在官方收录入口，也不得使用 `@deepseek-ai/*` scope 或官方背书措辞发布。

## 这是什么

- 低频资格扫描（默认每 15 分钟一次），满足「空闲 + 静默 + 新增语义内容 + 正常间隔/变化压力 + 预算 + 租约」全部门禁时才运行。
- 语料只读取 `user/message`（真实用户文本）与 `assistant/message`（模型文本），排除工具、chunk、推理、命令、注入上下文、subagent 与 fork 种子历史。
- 输入输出双向脱敏（密钥 / PII / 私网与凭据 URL / 高熵 token / prompt 注入数据化封装），正文永不落库。
- 模型引用只能使用宿主发放的 run 内 opaque ref，逐条宿主验证；候选先隔离，人类批准后才注入上下文。
- 状态存于 `$DSH_HOME/dream-reflection/state.sqlite`：事务、租约 + fencing token、心跳、崩溃恢复、按 UTC 日的跨进程预算。
- 不新增任何自定义 SessionEvent；approved 卡片通过官方动态上下文快照进入会话日志（可回放）。

## 安装

```sh
dsh plugin --profile <name> add <package-tarball-or-spec>
```

profile 的 `cordis.patch.yml` 会追加本组合包；默认 `enabled: false`，零模型费用。最小启用 overlay（覆盖整块 config，所有键都会替换，请按需全量重述）：

```yaml
- id: dream-reflection
  config:
    enabled: true
    provider: deepseek-official
    model: deepseek-v4-flash
    scope:
      mode: live-roots        # 或 allowlist + allowedCwds 绝对路径列表
      allowedCwds: []
```

## 命令

| 命令 | 行为 |
| --- | --- |
| `/dream status` | 配置状态、最近 run、下次资格与稳定 skip code |
| `/dream run [--dry-run]` | 手动触发（进入与自动触发相同的状态机）；dry-run 只估算不发模型请求 |
| `/dream cancel <run-id>` | 取消同工作区当前 run |
| `/dream list [quarantined\|approved\|challenged]` | 有界列表 |
| `/dream show <candidate-id>` | 候选正文 + 脱敏短上下文（源 session 已删除时降级显示） |
| `/dream approve <candidate-id>` | 仅 quarantined 的 medium/high；revision CAS |
| `/dream reject <candidate-id>` | 拒绝 quarantined/challenged 候选 |

命令只渲染到 UI，不发给模型。`/dream` 命令的原始参数会随 `command/run` 事件进入接收 Agent 的会话日志（opaque id 与状态词，无正文）；语料构建排除全部 `command/*` 事件。

## 真实权限与数据流

插件运行在 Harness 宿主进程内，不是沙箱。它：

1. 读取当前用户 `$DSH_HOME` 下 SessionQuery 可见的会话元数据与日志（live-preferred，重放校验）。
2. 在 `$DSH_HOME/dream-reflection/state.sqlite` 写自己的数据库（默认文件 0600、目录 0700；Windows 为 no-op，依赖 `$DSH_HOME` 目录权限）。
3. 用 profile 中已注册的 provider/credentials 调用 LLM——**脱敏后的会话内容会发送到该模型 provider**。
4. 注册一个 `/dream` 命令与一个 approved 动态上下文贡献。

启用前请按所在组织的数据政策评估第 3 点。默认关闭、显式作用域、双向脱敏与透明声明是必要条件，不是「识别所有敏感信息」的保证。

## 配置

全部可调值在 Schemastery `Config` 中，默认值见 `cordis.patch.yml` 与 `src/config.ts`；交叉字段在加载时 fail loud。安全不变量（不自动批准、不读文件、不给模型批准工具、不跨 cwd 合并、不保存 reasoning、不发送 LLM tools、日志不写正文）**刻意不配置化**。

已知限制：SQLite 是宿主本地单机设计（多主机共享 `$DSH_HOME` 不支持）；插件只在 Harness 进程存活时运行；Harness 仍是 developer preview，每个 prerelease 都需要重跑兼容矩阵后才会扩大 peer range。

## 开发

本地开发在仓库外的独立包目录进行（本 checkout 中为 git 不跟踪的 `chajian/dsh-dream-reflection/`）：

```sh
pnpm exec tsc -p chajian/dsh-dream-reflection --noEmit        # typecheck
pnpm exec vitest run --config chajian/dsh-dream-reflection/vitest.config.ts  # tests
pnpm exec tsc -p chajian/dsh-dream-reflection                  # build lib/
pnpm pack                                                     # 打包
```

## 许可证与来源

MIT（最终许可证须由代码权利人书面确认）。这是基于 DeepSeek Harness 公开扩展 API 与通用软件工程模式的独立实现，不含 CrabCode 源码、提示词、私有协议、测试夹具、内部文档、私有参数集或保密标识——见 `PROVENANCE.md`。公开前必须完成商业秘密/权属复核。
