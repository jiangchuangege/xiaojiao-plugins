# Third-Party Notices

本包不捆绑任何第三方运行时代码：所有功能依赖都以 **peerDependencies** 声明，由宿主 DeepSeek Harness 安装提供；安装本插件不会下载或执行额外代码（无 `prepare`/`postinstall` 脚本）。

## peerDependencies（由 Harness 提供）

| 包 | 版本范围 | 许可 |
| --- | --- | --- |
| `@deepseek-ai/cordis` | ^4.0.1 | MIT |
| `@deepseek-ai/cordis-plugin-timer` | ^1.1.2 | MIT |
| `@deepseek-ai/schemastery` | ^3.18.1 | MIT |
| `@deepseek-ai/dsh-llm` | 0.1.0-rc.5 | MIT |
| `@deepseek-ai/dsh-session` | 0.1.0-rc.5 | MIT |
| `@deepseek-ai/dsh-session-query` | 0.1.0-rc.5 | MIT |
| `@deepseek-ai/dsh-agent` | 0.1.0-rc.5 | MIT |
| `@deepseek-ai/dsh-system-prompt` | 0.1.0-rc.5 | MIT |
| `@deepseek-ai/dsh-commands` | 0.1.0-rc.5 | MIT |
| `@deepseek-ai/dsh-home-paths` | 0.1.0-rc.5 | MIT |

版本与许可以各包的 `package.json` 为准；公开发布前以正式 SBOM（`sbom.cdx.json`）与 registry 元数据复核。

## 直接运行时依赖

`node:` 内置模块（`node:sqlite`、`node:crypto`、`node:fs`、`node:path`）——Node.js 运行时的一部分，无第三方许可义务。
