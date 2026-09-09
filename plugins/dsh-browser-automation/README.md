# dsh-browser-automation

DeepSeek Harness（DSH）的隔离式公共网页浏览器自动化插件族：打开公共网页、读取有界语义快照、执行受控交互、获取截图 —— 不继承用户的登录态、配置或秘密。

> English：[README.en.md](README.en.md)
> **社区插件，不是 DeepSeek 官方产品。** DSH 尚在 developer preview，兼容性请按发布逐个锁定版本。
> npm scope 尚未定稿：包名使用开发占位 scope `@dsh-browser-automation`，发布 npm 前将机械替换为发布者 scope。

## 四个包

| 包 | 角色 |
| --- | --- |
| `packages/browser` | Service Definition：`ctx.browsers`、branded IDs、owner 会话、一次性审批编排、awaited cleanup |
| `packages/browser-playwright` | 隔离 Playwright/Chromium Provider：egress 策略、网络租约、沙箱约束启动、快照/动作/截图机制 |
| `packages/tool-browser` | Consumer：单一 manifest 派生十个模型可见 `browser_*` 工具 |
| `packages/browser-standard` | Profile Bundle（`dsh.bundle.patch` + `cordis.patch.yml`）组合上述三包 |

## 安全模型（V1）

- 每次会话新建临时浏览器 profile；无扩展、无既有登录态、mock keychain、绝不 `--no-sandbox`。
- 进程文件约束走 Harness `ctx.sandbox` 缝（要求 full enforcement；`read-only`/partial fail closed）；网络隔离由本插件自建 egress 策略负责。
- Egress：仅精确 http(s)、无 userinfo/控制字符、DNS 答案必须为公网、导航目标禁 query/fragment、子资源默认同源、禁用 WebSocket/service worker/下载/popup、操作级网络租约。
- 每个写动作一次性人工批准（`approval/request` waterfall），动作现场 TOCTOU 复验；不透明 ref 绑定 generation + observation + 指纹。
- 不可信网页内容永远不是信任声明；快照绝不暴露 HTML、选择器、隐藏值或密码字段。

详见各包 README、`PROVENANCE.md`、`SECURITY.md`、`PRIVACY.md` 与 `docs/`。

## 开发与验收

```bash
pnpm install
pnpm run typecheck
pnpm run test            # 含真实 Chrome 集成（无 Chrome 时自跳过）
pnpm run test:coverage   # 每文件 100% 覆盖率硬闸门
pnpm run build
node scripts/exports-check.mjs
```

真实 Harness 验收（需在 DeepSeek Harness checkout 内运行，隔离 DSH_HOME）：

```bash
node plugins/dsh-browser-automation/scripts/acceptance.mjs
# CLI 安装 → dump-config 组合 → 官方 boot() 挂载断言 → tarball 打包/安装
# → keyless 只读调用 → 卸载，全链路 exit 0
```

## 安装（Profile Bundle）

```bash
dsh plugin --profile web add <bundle 包名/本地 tgz 路径>
```

写动作需要能展示 tool call 的 answerer（`web` profile）；无 answerer 的 profile 一律 fail closed。卸载不会删除不属于插件的浏览器或用户数据。

## 已知限制（V1）

- DNS 级 egress 降低但不根除 DNS rebinding；无法证明 connect-IP 的平台按文档处理，不宣称 SSRF 免疫。
- turn 边界清理依赖空闲 deadline、插件 dispose 与显式 close（当前基线无插件可订阅的 turn-end 事件）。
- 审批 reason 与 `approval/asked`/`approval/decided` 审计对随会话日志持久化。
- 同源子资源默认会挡掉常见 CDN；运营者须显式 allowlist 静态资源 origin 并接受数据接收者披露。
