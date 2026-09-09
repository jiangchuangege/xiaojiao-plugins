# Privacy

## 数据去向（启用后）

1. **读取**：当前 `$DSH_HOME` 下 SessionQuery 可见的会话元数据与事件日志（仅已完成 turn 边界之前的真实用户/模型文本）。
2. **处理**：确定性脱敏规则（密钥格式、PII、私网/凭据 URL、高熵 token），高风险或无法局部替换的事件整段丢弃；脱敏后的证据以 run 内 opaque ref 形式交给模型。
3. **发送**：脱敏后的语料与阶段提示词发送到你选择的模型 provider（`config.provider`/`config.model`）。
4. **存储**：候选正文、source refs（sessionId+seq+hash）、审核决定写入 `$DSH_HOME/dream-reflection/state.sqlite`；**原始对话正文不落库**，日志不写正文。
5. **注入**：只有人类批准的卡片作为动态上下文进入该工作区后续模型请求，并经 Harness 记录为可回放的 `user/message` snapshot。

## 不收集

- 不读取工作区源代码、文件、Git 历史、环境变量或 shell 输出。
- 不发送任何遥测；插件不新建任何网络端点。
- 不删除或修改任何会话历史与用户文件。

## 删除数据

- 删除 `$DSH_HOME/dream-reflection/` 目录即删除全部插件数据（含候选与审核事实）。
- 会话日志中的 `command/run`（你的 `/dream` 命令原始参数）与 approved 上下文快照属于 Harness 会话日志，按 Harness 自身的会话删除流程处理。

## 边界声明

安全扫描降低风险，**不保证识别所有 PII/密钥**。安装者应按自身数据政策决定是否启用，并知悉脱敏内容会发送给模型 provider。
