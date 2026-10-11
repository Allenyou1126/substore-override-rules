# Sub-Store Override 脚本集合

用 TypeScript 编写、由 tsdown 打包成**单文件脚本**，供 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 直接引用的一组订阅处理工具。

> **当前状态：只有框架。** 构建、检查、发版链路已完整可用，但两个脚本的行为仍是**透传**——不含任何过滤、重命名、去重或分流规则逻辑。唯一的例外是参数解析链路已经打通：脚本接受一个 `enabled` 参数（默认 `true`），传 `enabled=false` 可以让 `substore-clean` 返回空数组。见 [脚本参数](#脚本参数) 与 [后续开发](#后续开发)。

## 两个脚本

| 包                | 产物                                             | 配置位置                          | 作用对象                         |
| ----------------- | ------------------------------------------------ | --------------------------------- | -------------------------------- |
| `@substore/clean` | `packages/substore-clean/dist/substore-clean.js` | 每条订阅的「节点操作 → 脚本操作」 | 该条订阅的**节点数组**           |
| `@substore/rules` | `packages/substore-rules/dist/substore-rules.js` | 最终集合的「文件 → 脚本操作」     | 生成配置里的 **mihomo 配置对象** |

`packages/internal` 是内部共享包（契约类型 + 脚本参数解析），不构建、不发布，由 tsdown 内联进上面两个产物。它依赖 `zod@4.6.5`（Zod Mini）。

## 命令

```bash
pnpm install          # 安装依赖，并自动装好 git 钩子
pnpm verify           # 一条命令跑完下面全部检查（提交前建议跑这个）
```

分步命令：

| 命令                                | 作用                                              |
| ----------------------------------- | ------------------------------------------------- |
| `pnpm typecheck`                    | 各包 `tsc --noEmit`（TypeScript 7）               |
| `pnpm lint`                         | `oxlint --type-aware`                             |
| `pnpm lint:fix`                     | 同上并自动修复                                    |
| `pnpm format` / `pnpm format:check` | `oxfmt --write .` / `--check`                     |
| `pnpm check`                        | typecheck + lint + format:check                   |
| `pnpm check:version`                | 版本号校验；`--list` 给出递增建议                 |
| `pnpm build`                        | 各包 tsdown 构建                                  |
| `pnpm test`                         | **全部测试**：逐包 vitest（单测 + 产物契约）      |
| `pnpm smoke`                        | **产物契约验收**：等价于 `pnpm test`              |
| `pnpm clean`                        | 删除各包 `dist/`                                  |
| `pnpm hooks:install`                | 单独安装 git 钩子（`pnpm install` 已自动做过）    |

## 在 Sub-Store 里使用

发版后，脚本通过**阿里云 OSS**（自定义域名 `blog-oss.allenyou.top`）对外提供。把链接填进对应的脚本操作即可。

```text
# 钉住版本（推荐，内容永不改变）
https://blog-oss.allenyou.top/substore-override-rules/<version>/substore-clean.js
https://blog-oss.allenyou.top/substore-override-rules/<version>/substore-rules.js

# 跟随最新版（链接固定，内容随发版更新）
https://blog-oss.allenyou.top/substore-override-rules/latest/substore-clean.js
https://blog-oss.allenyou.top/substore-override-rules/latest/substore-rules.js
```

脚本参数通过链接 `#参数=值` 或编辑页参数传入（`$arguments`）。详细的参数表与解析规则见 [脚本参数](#脚本参数)。

> 若客户端仍拉到旧内容，通常是 CDN 或客户端缓存。给链接加一个变化的时间戳查询串即可绕过（不要用 `?$options=` 传参的空间）。

## 脚本参数


传参方式（`$arguments` 的几种来源都被解析层接住了）：

```text
# 编辑页「参数」字段：直接填 JSON
{ "enabled": false }

# 链接：JSON 形式
https://blog-oss.allenyou.top/substore-override-rules/latest/substore-clean.js#%7B%22enabled%22%3Afalse%7D

# 链接：k=v 形式（值一律当字符串处理，再由解析层转成 boolean / 数字）
https://blog-oss.allenyou.top/substore-override-rules/latest/substore-clean.js#enabled=false
```

解析规则与边界（实现见 [`packages/internal/src/params.ts`](packages/internal/src/params.ts)，单测在同目录的 `params.test.ts`）：

- **布尔值**接受 `true` / `false` / `1` / `0` / `yes` / `no` / `on` / `off`（大小写与前后空白不敏感）。
  刻意不用 zod 的 `z.coerce.boolean()` —— 它会把 `'false'` 判成 `true`。
- **参数值非法会抛错**，Sub-Store 会把它写进日志（`Parser [Script Operator] failed ... Reason: ...`）。这是刻意的：静默回退默认值会让「参数写错了」变成「参数没生效」。
- **参数名写错不会报错**（未声明的键被剥离）。Sub-Store 自己的 `noCache` / `insecure` 就在同一份 `$arguments` 里，而且钉住旧版本的链接在脚本升级后必须继续可用。
- 即时预览页拿不到参数时按「没传」处理，全部取默认值。

### `substore-clean`

| 参数      | 类型    | 默认值 | 作用                                              |
| --------- | ------- | ------ | ------------------------------------------------- |
| `name` | string | 必需 | 用于给清洗后的节点附加统一标识 |

### `substore-rules`

只接受一个总开关（默认 `true`，也就是不改变任何东西）：

| 参数      | 类型    | 默认值 | 作用                                              |
| --------- | ------- | ------ | ------------------------------------------------- |
| `enabled` | boolean | `true` | `false` 时 `substore-clean` 返回空数组（丢弃全部节点） |

## 产物契约（改动构建配置前务必读）

Sub-Store 是把脚本当**脚本文本**执行的，不是 `import` 一个模块。它等价于：

```js
new Function('$arguments', '$options', ..., `${script}\n return operator`)(...)
```

由此产生四条硬约束，**已实测**（tsdown 0.23.0）：

1. 入口必须有**顶层 `function operator`**（mihomo 配置路径用 `main`），且**不能有 `export`**。
   有导出时 `format: 'es'` 会原样输出 `export` 语句，`new Function` 直接语法错误；历史上还有被包成 `(function (exports) { … })({})` 的失败形态。
   **入口可以有 `import`**（内部包与 zod 都会被打包进同一份产物）。
2. tsdown 的 `format` 必须是 **`'es'`**，不能是 `'iife'`。
   `iife` 会产出 `(function () { … })();`，把函数关进闭包，实测报 `operator is not defined`。
3. `treeshake` 必须开着，**同时入口末尾必须保留 marker 赋值**（`(globalThis as …).__substoreCleanEntry = { operator };`）。
   入口函数没有源码引用，marker 用一条真实副作用让打包器保住它们。删掉 marker 产物会静默变空壳；退回 `treeshake: false` 则整棵依赖图被原样内联，产物从约 42 kB 涨到 613 kB。
4. 产物不能以 `(` 开头、不能出现 `require(`。

`pnpm smoke`（等价于 `pnpm test`）会逐条守住这些约束：两个交付包的 `pretest` 先 `pnpm build`，再用 `vitest run --dir test` 跑 [`packages/substore-clean/test/artifact.test.ts`](packages/substore-clean/test/artifact.test.ts) 与 [`packages/substore-rules/test/artifact.test.ts`](packages/substore-rules/test/artifact.test.ts) —— 检查产物形状、用复刻环境真正调用一次、注入 `$arguments` 验证参数链路、打印字节数与 gzip 体积并对体积预算断言（treeshake 被关掉时实测从约 42 kB 涨到 613 kB）。复刻的求值环境在 [`packages/internal/src/sandbox.ts`](packages/internal/src/sandbox.ts)。改动构建配置后请务必跑它。完整说明见 [`packages/internal/src/substore.ts`](packages/internal/src/substore.ts)。

## 仓库结构

```
packages/internal/          # 内部共享：契约类型 + 参数解析 + 冒烟用的求值环境复刻（不构建、不发布）
packages/substore-clean/    # 交付包 1：订阅清洗（产物契约测试在 test/artifact.test.ts）
packages/substore-rules/    # 交付包 2：配置分流规则（产物契约测试在 test/artifact.test.ts）
tools/                      # 校验器：提交信息、版本号、prod 合入来源
scripts/                    # git 钩子安装
.githooks/                  # 提交信息钩子
.github/workflows/          # verify / guard-prod-source / release
docs/standards/development.md   # 开发规范、分支模型、提交规范、版本号规则
docs/release.md                 # 发版手册（OSS 前置条件、回滚、排查）
```

`dist/` **不进版本库**。发版时由 CI 从 tag 的源码重新构建，产物同时上传到 OSS（对外分发）并作为 GitHub Release 的附件归档。本地需要检查产物时运行 `pnpm build`。

这样历史里只有源码，不会有构建产物的 diff 噪音；构建可复现——依赖全部精确固定，同一 tag 任何时候都能构建出相同内容。

## 分支与发版（摘要）

- `dev` —— 默认分支，日常开发，**不触发 CI**，不提供任何可用性保证。
- `prod` —— 已验证可上生产，**合入即触发 CI**；只接受从 `dev` 合入。
- 发版：在 `dev` 递增版本 → PR 到 `prod` → 在 `prod` 打 tag `vX.Y.Z` → 自动上传 OSS 并建 Release 存档。

完整规则见 [docs/standards/development.md](docs/standards/development.md) 与 [docs/release.md](docs/release.md)。

## 后续开发

框架阶段刻意留空的部分：

- `packages/substore-clean/src/index.ts` —— 节点过滤、重命名与编号、去重、字段统一。
- `packages/substore-rules/src/index.ts` —— 规则集数据、策略组构造、配置合并。

参数解析这块**已经不用再写**了：`@substore/internal` 导出了
`parseScriptParams(schema, $arguments)` 与三个强制转换 helper（`zBool` / `zIntIn` / `zCsv`），
`$arguments` 的四种来源形态、字符串到类型的转换、错误消息都处理好了。
新增业务参数只需要在各自入口的 schema 里加字段，用法见 [脚本参数](#脚本参数)。

开发时请先读 [docs/standards/development.md](docs/standards/development.md)：里面有提交信息格式（**AI 辅助必须附 `Assisted-By` 尾注**）、版本递增判定表和契约红线。

用 AI Agent 参与开发时，先让它读 [AGENTS.md](AGENTS.md)：那份文件把最容易改坏的契约红线、容易踩的坑和把关要求集中列了出来。

## 许可

[MIT](LICENSE) © 2026 Allenyou

本项目打包的脚本会被导入代理客户端并处理你的订阅与配置。请在理解脚本行为的前提下使用；仓库作者不对使用后果承担责任。
