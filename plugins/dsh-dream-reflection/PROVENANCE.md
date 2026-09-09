# Provenance

本插件是对 DeepSeek Harness 公开扩展 API（函数插件 ABI、`ctx.sessionQuery`、`ctx.llm`、`ctx.systemPrompt.context()`、`ctx.commands`、`ctx.interval`、bundle patch 协议）与通用软件工程模式（增量水位、空闲门禁、单飞租约、有界语料、证据硬门、阶段化反思、去重、原子结算、失败回滚、人工审核）的独立 clean-room 实现。

## 声明

> This plugin is an independent implementation based on public DeepSeek Harness extension APIs and general software-engineering patterns. It contains no CrabCode source code, prompts, private protocols, tests, internal documentation, proprietary parameter sets, or confidential identifiers.

## 边界证据

- 设计依据为 Harness 仓库公开文档与源码（`docs/`、`packages/`、`vendor/cordis`），仅使用公开 API 与行为契约。
- 不使用任何 CrabCode 的目录/符号命名、提示词、错误文案、测试夹具或阈值组合；launch 默认值为独立设计的保守值。
- 没有从任何私有仓库复制代码片段。

## 公开前阻断项

在代码公开前必须完成商业秘密/权属复核并取得书面确认。任何经查证直接派生的 CrabCode 实现、提示词或测试都属于发布阻断项。仓库位于 git 不跟踪的本地目录 `chajian/dsh-dream-reflection/`，不得直接作为上游提交内容。
