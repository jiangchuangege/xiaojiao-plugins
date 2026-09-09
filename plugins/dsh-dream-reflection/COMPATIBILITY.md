# Compatibility Matrix

Harness 仍处于 developer preview；本矩阵只记录**实测过**的组合。任何新 prerelease 都必须重跑下列验证后才允许扩大 peer range。

## 实测组合（本地验收，2026-08-13）

| Harness 基线 | Node | 平台 | 验证内容 | 结果 |
| --- | --- | --- | --- | --- |
| `0.1.0-rc.5` @ `47f943859bef60e4160492346772ded9b24f765a` | v24.18.0 | macOS | typecheck（对 harness 构建产物 `lib/types`） | 通过 |
| 同上 | v24.18.0 | macOS | vitest 15 文件 96 用例（对 harness 源码平面，`tsconfig.base.json` 路径面） | 全绿 |
| 同上 | v24.18.0 | macOS | `tsc` 构建 lib/ + plain Node ESM 导入 | 通过 |
| 同上 | v24.18.0 | macOS | `pnpm pack` + `dsh plugin --profile smoke add <tgz>` + `--dump-config` + 真实启动（临时 `DSH_HOME`） | 通过 |

## 依赖面（peerDependencies，均为实测解析版本）

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | ^4.0.1 | 插件 ABI、Service/Context |
| `@deepseek-ai/cordis-plugin-timer` | ^1.1.2 | `ctx.interval` 调度 |
| `@deepseek-ai/schemastery` | ^3.18.1 | Config schema |
| `@deepseek-ai/dsh-llm` / `dsh-session` / `dsh-session-query` / `dsh-agent` / `dsh-system-prompt` / `dsh-commands` / `dsh-home-paths` | 0.1.0-rc.5 | 服务面 |

## 声明

- Node engines：`^22.19 || >=24`（`node:sqlite` 运行时依赖）。
- 未在 Windows/Linux 实测的组合一律标注「未验证」，不得宣称支持。
- 每个 Harness prerelease 的复验清单：Loader 组合、持久化 schema 兼容（`state.sqlite` 版本检查 fail loud）、模型快照（canonical request 重建）、pack-install 四步。
