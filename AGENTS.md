# AGENTS.md

给在本仓库工作的 AI Agent（以及人类协作者）的操作说明。**动手前先读完这份文件**；规范正文在 [docs/standards/development.md](docs/standards/development.md)，发版细节在 [docs/release.md](docs/release.md)。

## 这个仓库是什么

用 TypeScript 写、由 tsdown 打包成**单文件脚本**，供 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 直接引用的一组订阅处理工具。两个交付包：

| 包                | 产物                       | Sub-Store 里配在哪                | 作用对象                         |
| ----------------- | -------------------------- | --------------------------------- | -------------------------------- |
| `@substore/clean` | `substore-clean.js`        | 每条订阅的「节点操作 → 脚本操作」 | 该条订阅的**节点数组**           |
| `@substore/rules` | `substore-rules.js`        | 最终集合的「文件 → 脚本操作」     | 生成配置里的 **mihomo 配置对象** |

`packages/internal` 是内部共享包（契约类型 + 脚本参数解析），不构建、不发布，由 tsdown 内联进产物。它依赖 `zod@4.6.5`（Zod Mini），**所以它现在有运行时依赖了**。

**当前状态：只有框架。两个脚本只接了一个 `enabled` 参数（默认开着），节点与配置行为仍是透传。** 不要以为已有实现，也不要把占位符当成遗漏而自行「补全」——业务逻辑的添加是独立任务。

## 四条不可违反的契约红线

这是本仓库最容易改坏的地方，**全部经过实测**（tsdown 0.23.0），且由 `pnpm smoke` 守护。

**背景**：Sub-Store 不是 `import` 产物，而是把它当**脚本文本**执行：

```js
new Function('$arguments', '$options', ..., `${script}\n return operator`)(...)
```

mihomo 配置路径另有一套：把脚本文本整体展开进异步函数，用 `typeof main === 'function'` 找入口。

由此：

1. **入口文件不能有 `export`。**
   `format: 'es'` 下 rolldown 会原样保留 `export` 语句，`new Function` 直接抛 `Unexpected token 'export'`；历史上还有一种失败形态是改成 `(function (exports) { … return exports; })({})`，把函数关进闭包。
   **入口可以有 `import`**（内部包与 zod 都会被内联成单文件），只是不能有 `export`。

2. **tsdown 的 `format` 必须是 `'es'`，不能是 `'iife'`。**
   看着反直觉，但实测 `iife` 会产出 `(function () { … })();`，同样把函数关进闭包，报 `operator is not defined`。`es` + 入口无导出才会输出裸脚本。

3. **`treeshake` 必须为 `true`，且入口末尾必须保留 marker 赋值。**
   顶层 `operator` / `main` 没有任何源码引用，treeshake 会把它们当死代码删掉。所以入口末尾要有一条引用它们的**真实顶层副作用**（`(globalThis as Record<string, unknown>).__substoreCleanEntry = { operator };`）——打包器看见它就不会删函数，treeshake 于是可以开着。
   **marker 不能删**：删了产物会静默变成空壳（由 `pnpm smoke` 拦下）。
   **也不要退回 `treeshake: false`**：那样整棵依赖图会被原样内联，实测产物从约 42 kB 涨到 613 kB，zod-mini 的体积优势全没了。

4. **产物不能把函数包进任何闭包，也不能出现 `require(`。**
   `platform: 'neutral'` 保证不注入 Node 平台假设；Sub-Store 的 `new Function` 环境里 `require` 是 `undefined`。

改动构建配置或入口文件后，**必须**跑 `pnpm smoke`（`pnpm verify` 已包含）。单元测试**测不到**这些问题：它读的是源码模块，Sub-Store 执行的是产物文本。

### 由此派生的两个「看起来奇怪但正确」的点

- 入口里的 `operator` / `main` 在源码里**没有调用点**，靠末尾的 marker 让打包器认为它们被用到。它们在根 `.oxlintrc.json`（override）和 `packages/*/tsconfig.json`（`noUnusedLocals: false`）里仍被显式放过 —— **不要改成 export，也不要重新打开这两个检查**。若要让它们可被单元测试调用，请把纯逻辑抽成单独的可导出模块，入口只负责编排。
- `pnpm smoke` 除了实际调用一次，还会**静态检查产物不以 `(` 开头**、必须含顶层函数声明、不含 `import` / `export` / `require(`，并**打印每个产物的字节数与 gzip 体积**——体积突然涨到几百 kB 就说明 treeshake 被关了。

## 每次改动都要过的关卡

```bash
pnpm verify   # = check + check:version + build + smoke + test
```

分步含义见 [README 命令表](README.md#命令)。提交信息由 `.githooks/commit-msg` 自动校验，**可被 `--no-verify` 绕过但 CI 不会**。

## 提交与分支

- **分支**：`dev` 是默认分支、日常提交、**不触发 CI**；`prod` 已验证可上生产、**合入即触发 CI**、**只接受从 `dev` 合入**。
- **不要直接推 `prod`。** 正确流程是改动进 `dev` → PR `dev → prod` → 合入 → 在 `prod` 打 tag。CI 里有 `guard-prod-source` 专门拦这件事。
- **提交信息用 Conventional Commits**：`<type>(<scope>): <description>`，type 白名单与 scope 建议见 [规范 §2](docs/standards/development.md)。
- **AI 辅助完成的提交必须加尾注**（放在最后一个 trailer 块内）：

  ```text
  Assisted-By: <Agent 名称> (<模型 ID>)
  ```

  例如 `Assisted-By: DeepSeek Harness (deepseek-flash)`。名称与括号内模型 ID 都不能为空，也不能写 `<...>` / `unknown` / `TODO` 之类的占位值。纯人工提交不加。

- **版本号**：唯一真源是根 `package.json` 的 `version`。递增判定（MAJOR/MINOR/PATCH）见 [规范 §3](docs/standards/development.md)。不要用 `--list` 的建议值直接开干——它只是建议，`--check` 才是硬校验。

## 容易踩的几个坑

| 坑                                                             | 后果 / 正确做法                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 提交 `dist/`                                                   | **不要**。`dist/` 不进版本库；发版时 CI 从 tag 源码重建。                                                                 |
| 关闭 `minimumReleaseAge`                                       | **不要**。它是供应链保护，见 [规范 §4.2](docs/standards/development.md)。装不上就等或退到已满 24h 的版本。   |
| 依赖写成 `^` / `~`                                             | **不要**。全部精确版本，否则同一 tag 两次构建结果可能不同。                                                |
| 在各包加独立的 oxlint / oxfmt 配置                             | **不要**。两个工具只在仓库根配置一处。                                                                     |
| 改了 `packages/*/src/` 却没跑冒烟                              | 产物形状的回归只有 `pnpm smoke` 能发现。                                                                    |
| 改 workflow 后只做 YAML 语法检查                               | 不够。逐步 `bash -n` 校验每个 `run:` 步骤；本仓库已多次在 CI 上暴露只测语法测不出的问题。                   |
| 给校验脚本只测「通过」路径                                     | 不够。`tools/check-*.mjs` 的 `process.exit` 码有语义（0 通过 / 1 违规 / 2 证据不足），**必须用故意构造的坏输入反向验证**。 |

## 改 CI / 校验脚本时的额外要求

`.github/workflows/*.yml` 与 `tools/check-*.mjs` 是「把关者」，它们出错的代价是**默默放行**或**卡死正常流程**。历史上这里出过三类真问题，改的时候请照着防：

1. **退出码语义**：`1` 表示确实违规，`2` 表示证据不足（软失败 + 诊断）。不要把「读不到证据」判成违规——强制推送、浅克隆、仓库首次建立都会造成证据不足。工作流里对 `2` 发 warning 放行，对 `1` 失败。
2. **强制推送**：`github.event.before..after` 在强制推送后**不可读**（before 已不在历史里）。所以 push 事件只校验被推送的单个提交，范围校验交给 `pull_request` 那一轮。
3. **本地 vs CI 一致**：校验脚本本地跑一遍不代表 CI 会过。改完 workflow 请确认对应的 `run:` 在本地能复现出同样的判定。

## 不要做的事

- 不要在没有明确要求时改动 `.github/workflows/release.yml` 的 OSS 上传逻辑（对象键、Cache-Control、匿名可读校验都有明确理由，见 [release.md](docs/release.md)）。
- 不要在 `dev` / `prod` 之外新增长期分支；临时分支用完删除。
- 不要提交任何凭证（`OSS_ACCESS_KEY_ID` / `OSS_ACCESS_KEY_SECRET` 只能存在于 GitHub Secrets）。
- 不要把「框架阶段」补成「有实现」——业务实现是独立任务，且需要同步更新 README 的状态说明。
