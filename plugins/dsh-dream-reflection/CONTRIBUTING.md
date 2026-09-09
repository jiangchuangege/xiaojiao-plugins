# Contributing

## 先读

- `PROVENANCE.md`：clean-room 边界与发布阻断项。任何直接派生的 CrabCode 实现、提示词或测试都属于发布阻断。
- `docs/local-plans/2026-08-13-dsh-dream-reflection-plugin-plan.zh.md`（方案，位于 Harness checkout 的 `docs/local-plans/`）：设计、成功标准与分阶段计划。

## 仓库形态

当前处于本地开发阶段：代码位于 Harness checkout 内的 **git 不跟踪目录** `chajian/dsh-dream-reflection/`。公开前的正式流程是把本目录迁移到独立社区仓库并执行 M0/M6 治理门（权属复核、商标/包名检查、`dsh-plugin` topic、npm prerelease）。

## 开发循环

```sh
cd <deepseek-harness-checkout>
pnpm exec tsc -p chajian/dsh-dream-reflection --noEmit    # typecheck（对 harness 构建产物）
pnpm exec vitest run --config chajian/dsh-dream-reflection/vitest.config.ts  # 测试（对 harness 源码平面）
pnpm exec tsc -p chajian/dsh-dream-reflection              # 构建 lib/ + lib/types/
cd chajian/dsh-dream-reflection && pnpm pack               # 打包
```

依赖解析约定：`chajian/dsh-dream-reflection/node_modules/@deepseek-ai/*` 是指向 Harness 包目录的本地 symlink（`lib/types` 用于 typecheck/build，vitest 经 `tsconfig.base.json` 路径面跑源码）。

## 变更门禁

1. 新行为必须落在既有扩展点（timer / sessionQuery / llm / commands / systemPrompt / store），不得改动 Harness agent loop 或新增自定义 SessionEvent（ADR-004）。
2. 每个状态迁移、失败路径与安全门都要有测试；跑全量 vitest（含性质测试与集成组合）。
3. 改默认值/错误码/skip code 必须同步 `cordis.patch.yml`、`src/config.ts`、README（双语）与方案文档。
4. 提交信息与文档使用仓库全名，不写裸文件名；本目录内文件引用使用相对路径。
5. 发布前执行 `COMPATIBILITY.md` 的复验清单。

## 目录速览

```
src/store/        SQLite provider：事务、租约+fencing、预算、台账、恢复
src/corpus/       workspace 身份、cursor 水位、有界语料构建
src/safety/       双向脱敏、注入封装、输出校验（含逐字复制门）
src/reflection/   coordinator（唯一 run owner）、pipeline、schemas、confidence、dedupe
src/scheduler/    timer pump、eligibility 门禁、假时钟安全
src/commands.ts   /dream 子命令（UI-only）
src/context.ts    approved 卡片动态上下文（同步 provider）
tests/            单元/性质/真实组合（boot.ts 为共享引导）
```
