# Sub-Store Override 脚本集合

用 TypeScript 编写、由 tsdown 打包成**单文件脚本**，供 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 直接引用的一组订阅处理工具。

> **当前状态：只有框架。** 构建、检查、发版链路已完整可用，但两个脚本的实现都是**透传占位**——不含任何过滤、重命名、去重或分流规则逻辑。见 [后续开发](#后续开发)。

## 两个脚本

| 包                | 产物                                             | 配置位置                          | 作用对象                         |
| ----------------- | ------------------------------------------------ | --------------------------------- | -------------------------------- |
| `@substore/clean` | `packages/substore-clean/dist/substore-clean.js` | 每条订阅的「节点操作 → 脚本操作」 | 该条订阅的**节点数组**           |
| `@substore/rules` | `packages/substore-rules/dist/substore-rules.js` | 最终集合的「文件 → 脚本操作」     | 生成配置里的 **mihomo 配置对象** |

`packages/internal` 是内部共享包（类型与运行时契约），不构建、不发布，由 tsdown 内联进上面两个产物。

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
| `pnpm smoke`                        | **产物契约验收**：用复刻的 Sub-Store 环境执行产物 |
| `pnpm test`                         | 各包 vitest                                       |
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

脚本参数通过链接 `#参数=值` 或编辑页参数传入（`$arguments`），当前占位实现不读取任何参数。

> 若客户端仍拉到旧内容，通常是 CDN 或客户端缓存。给链接加一个变化的时间戳查询串即可绕过（不要用 `?$options=` 传参的空间）。

## 产物契约（改动构建配置前务必读）

Sub-Store 是把脚本当**脚本文本**执行的，不是 `import` 一个模块。它等价于：

```js
new Function('$arguments', '$options', ..., `${script}\n return operator`)(...)
```

由此产生三条硬约束，**已实测**（tsdown 0.23.0）：

1. 入口必须有**顶层 `function operator`**（mihomo 配置路径用 `main`），且**不能有 `export`**。
   一旦有导出，rolldown 会改成 `(function (exports) { … return exports; })({})`——函数被关进闭包，Sub-Store 取不到，而且这种调用写在 `${script}` 位置本身就是语法错误。
2. tsdown 的 `format` 必须是 **`'es'`**，不能是 `'iife'`。
   `iife` 会产出 `(function () { … })();`，同样把函数关进闭包，实测报 `operator is not defined`。
3. `treeshake` 必须关闭，否则没人引用的顶层函数会被当死代码删掉。

`pnpm smoke` 会逐条守住这些约束（检查产物形状 + 用复刻环境真正调用一次），改动构建配置后请务必跑它。完整说明见 [`packages/internal/src/substore.ts`](packages/internal/src/substore.ts)。

## 仓库结构

```
packages/internal/          # 内部共享：Sub-Store 契约类型（不构建、不发布）
packages/substore-clean/    # 交付包 1：订阅清洗
packages/substore-rules/    # 交付包 2：配置分流规则
tools/                      # 校验器与冒烟脚本
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

开发时请先读 [docs/standards/development.md](docs/standards/development.md)：里面有提交信息格式（**AI 辅助必须附 `Assisted-By` 尾注**）、版本递增判定表和契约红线。
