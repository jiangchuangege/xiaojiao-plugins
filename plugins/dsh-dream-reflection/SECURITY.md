# Security

## Reporting

请通过私有渠道报告漏洞，不要公开 issue。当前没有 bug bounty；修复会以 patch release 发布并写入 CHANGELOG。

## Trust model（简述，完整版见 THREAT_MODEL.md）

- 插件是 Harness 宿主进程内的受信任代码，Cordis scope 不是沙箱；安装者等于授权其进程内权限。
- 唯一外部调用是用户已配置的 Harness LLM provider；无文件工具、无 Bash、无 MCP、无网络搜索、无子进程。
- 模型输出永不直接落库：引用逐条宿主验证，输出经过与输入相同的脱敏扫描与逐字复制门，全部候选先隔离、只能由人类命令批准。

## Hardened by design

- 无安装期脚本（`prepare`/`postinstall` 均不提供）；预构建 npm/tarball；最小运行依赖并锁版本。
- 日志只写 hash/id/计数/码/耗时/用量，不写 cwd、prompt、正文或 key。
- 数据库位于 `$DSH_HOME/dream-reflection/state.sqlite`，默认 owner-only 权限；跨进程写入用 SQLite 事务 + 租约 + fencing token 协调，旧 holder 过期后无法提交。
- 崩溃恢复不盲续旧 payload：租约过期的 running run 标记 `abandoned`，重新走门禁。
