# Threat Model

## 假设

- 插件代码受信任；安装 = 授权其进程内权限（读会话、写插件库、调 LLM、注册命令/上下文）。
- 同一 `$DSH_HOME` 可能被多个 Harness 进程共享（同机）；多主机共享不在 V1 支持范围。
- 会话内容不可信（可能含用户粘贴的恶意指令），模型输出不可信（可能伪造引用、输出机密、逐字复制）。

## 威胁 → 控制

| 威胁 | 控制 |
| --- | --- |
| transcript prompt injection | 语料明确包为 data、无 tools、严格 JSON、引用 allowlist、禁止遵循源内指令；注入内容（`{kind:'plugin'}`）不入语料 |
| secrets / API keys | 输入正则 + 高熵检测、不可逆局部替换、高风险整段丢弃、输出再扫描（`safety/redact.ts`） |
| PII | email/电话/证件/地址启发式与高熵规则；命中只计数不写值 |
| 私网与内部 URL | localhost/私网 IP/内网域/凭据 URL 输入输出双拦截 |
| 跨工作区泄漏 | canonical exact cwd + HMAC workspace key + 默认 live-root opt-in + ref 绑定 workspace |
| subagent 重复/越权 | 默认排除 `origin='subagent'`、非顶层（`delegationDepth>0`）、live 非 root 与 fork seed 前缀 |
| 模型伪造证据 | 只接受 run 内 opaque ref；宿主逐 claim 验证；伪造 → `schema-invalid` 失败 |
| 模型自我提升 | 无模型批准工具；全部候选 quarantine；人类命令 + revision CAS |
| 输出复制长原文 | n-gram 重叠与最大逐字片段门（`safety/output.ts`），超限 blocked |
| 双计费/重复提交 | SQLite lease、heartbeat、fence、预算先预留后对账、幂等 candidate hash |
| 崩溃与迟到结果 | 事务 cursor、`abandoned` 恢复、run/fence 验证、迟到结果丢弃 |
| 前台抢占 | `agent/status` 监听 + AbortSignal + 阶段安全边界取消 |
| HMR 泄漏 | 单 disposer 串行停止 scan、abort、await、close |
| 供应链执行 | 预构建 npm/tarball、无 install 脚本、最小运行依赖 |
| 日志泄漏 | 命名 logger 只写 hash/id/计数/码/耗时/用量 |

## 残余风险（明示）

- 脱敏是启发式，不保证识别所有敏感信息（PRIVACY.md 已声明）。
- 近重复阈值 0.9 为针对当前向量设计的初始值，需有权使用的评测集校准后承诺。
- 同机恶意进程可直读 `$DSH_HOME` 下的数据库与会话文件——插件不提供对抗本机攻击者的保护。
