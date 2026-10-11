# 开发规范

本文件是本仓库的规范正文。适用范围：**所有分支、所有提交、所有协作者（含 AI Agent）**。

配套文件：[发版手册](../release.md)（OSS 前置条件、回滚、故障排查）。

---

## 1. 分支模型

| 分支   | 角色                                       | CI             | 可用性承诺 |
| ------ | ------------------------------------------ | -------------- | ---------- |
| `dev`  | 开发分支，**仓库默认分支**。日常直接提交。 | **不触发**     | 无任何保证 |
| `prod` | 已验证可上生产。                           | **合入即触发** | 可上生产   |

流程：

```
dev 上开发 → 开 PR: dev → prod → 检查通过 → 合入 → 在 prod 打 tag → 自动发版
```

### 1.1 「只允许从 dev 合入 prod」是怎么实现的

**这条规则由 CI 承担，不能只靠 GitHub 设置。** GitHub 的 branch protection 能要求「必须开 PR」「检查必须通过」，但**无法限定 PR 的 head 分支**——任何分支都能开 PR 进 `prod`。

因此仓库里有两个 workflow：

- `.github/workflows/guard-prod-source.yml` + `tools/check-prod-source.mjs` —— 真正的来源守卫。
  - `pull_request`（base `prod`）：断言 head 分支是 `dev`。
  - `push`（`prod`）：断言被推送的提交是把 `dev` 合入 `prod` 的**合入提交**（判定第二个父提交是否在 `dev` 的祖先链上）。
  - 证据不足时（首次建立 `prod`、浅克隆、引用被删除）**退出码 2 = 软失败**，打 warning 放行而不是卡死正常流程。看到这个 warning 必须人工确认来源。
- `.github/workflows/verify.yml` —— 同一个守卫 + 完整代码检查。

### 1.2 服务端设置清单（必须手动完成，文件表达不了）

在 `https://github.com/Allenyou1126/substore-override-rules/settings` 完成：

| 设置项                                | 位置                                    | 值                                                    |
| ------------------------------------- | --------------------------------------- | ----------------------------------------------------- |
| Default branch                        | General                                 | `dev`                                                 |
| Require a pull request before merging | Branches → `prod` 保护规则              | 开启                                                  |
| Require status checks to pass         | 同上                                    | 勾选 `verify`、`guard-prod-source`、`commit-messages` |
| Require linear history                | 同上                                    | 开启                                                  |
| Allow force pushes / deletions        | 同上                                    | **关闭**                                              |
| Tag protection（Rulesets）            | Rules → New ruleset → Target: tags `v*` | 禁止更新与删除                                        |

> ⚠️ **顺序问题**：`Require status checks` 里的检查名**必须先跑出过一次**才能在列表里勾选。所以正确顺序是：先推 `dev`、开一次 `dev → prod` 的 PR 触发 CI，再回来配置保护规则。

> ⚠️ **tag 保护不能省**。tag 可以被移动，缺少保护时「已发布的 v1.2.3」就不再是可信的固定点。

---

## 2. 提交规范

采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/zh-hans/v1.0.0/)。

```
<type>(<scope>): <description>

<body>

<footer / trailer 块>
```

### 2.1 标题

- **type 白名单**：`feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`
- **scope 可选**，推荐用领域或包名：`clean` `rules` `internal` `repo` `ci` `release` `oss`
- **description**：祈使句、不以句号结尾、不超过 72 字符
- 破坏性变更：`type!` 或正文里写 `BREAKING CHANGE:`

```text
feat(clean): 支持按关键字过滤节点名

fix(rules): 修正规则集地址
refactor(internal)!: 调整脚本参数结构

BREAKING CHANGE: 脚本参数 `filterKeywords` 改名，旧配置需同步修改
```

### 2.2 AI 辅助必须声明

使用 AI Agent 辅助完成的提交，**必须在最后一个 trailer 块内**追加：

```
Assisted-By: <Agent 名称> (<模型 ID>)
```

示例：

```text
chore(repo): 初始化 monorepo 框架

Assisted-By: DeepSeek Harness (deepseek-flash)
```

规则细节：

- Agent 名称与括号内的模型 ID **都必须非空**。
- 校验器会拒绝占位值：`<...>`、`[...]`、`xxx`、`tbd`、`todo`、`n/a`、`unknown`、`待填`、`未知`。
- **纯人工提交不加这个尾注。** 校验器对此只提示、不报错。
- 校验器**不惩罚**「声称有 AI」，只惩罚格式不合规——诚实声明不会带来任何成本。

### 2.3 强制手段（两层）

1. **本地钩子**：`.githooks/commit-msg` → `tools/check-commit-msg.mjs`。
   `pnpm install` 时由 `prepare` 自动设置 `core.hooksPath=.githooks`。克隆后没跑过 install 时执行 `pnpm hooks:install`。
2. **CI**：`.github/workflows/verify.yml` 的 `commit-messages` job，对 PR 的 `base..head` 逐条校验。

两者**共用同一个脚本**，不会出现两套判定。注意：

- 钩子可用 `git commit --no-verify` 绕过，**CI 才是最终把关**。
- 合入提交（`Merge ...`）以及 `fixup!` / `squash!` / `amend!` / `Revert "` 会被跳过。
- 因此**被合入 `prod` 的 `dev` 提交由 `pull_request` 那一轮的 CI 负责校验**。`push` 到 `prod` 时合入提交本身被跳过是预期行为，不是漏检。

本地自查：

```bash
pnpm commit:check --range origin/prod..HEAD
pnpm commit:check --message-file .git/COMMIT_EDITMSG
pnpm commit:check --head
```

---

## 3. 发版版本号规则

### 3.1 版本载体

- **唯一真源 = 根 `package.json` 的 `version`**，代表「这套 override 脚本集合」整体的版本。
  它就是 OSS 上的目录名与 `v<version>` tag 的来源。
- 两个交付包与 `packages/internal` 均为 `private`、**不各自发版**。目前使用者只引用产物文件，不 `import` 包，per-package 版本没有消费者。
- tag 命名：稳定版 `vX.Y.Z`；预发版 `vX.Y.Z-rc.N`。

> **未来可选**：若将来要把包发布到 npm / GitHub Packages、出现按包引用的消费者，再决定各包版本与整体版本的关系。届时这是一次结构性变更，需要单独提案。

### 3.2 递增判定表

| 部分      | 用于                 | 判定条件                                                                                        |
| --------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| **MAJOR** | 架构大改             | 提交带 `!` 或 `BREAKING CHANGE:`；或**现有脚本链接 / 参数名不再兼容**（用户必须改配置才算升级） |
| **MINOR** | 新增功能             | `feat:` 类型；新增脚本或新增**可选**参数；新增规则分组或规则集，且**不改变既有默认行为**        |
| **PATCH** | Bug 修复、规则小修改 | `fix:` / `perf:`；规则集地址或小规则修正；文档更正；构建工具链升级                              |

补充规则：

- **版本只增不减。** 需要回滚时，把产物重新指向旧版本内容，**不要**降低版本号。
- `0.y.z` 期间内部仍严格按上表执行；`1.0.0` 才代表对外承诺「契约已稳定」。
- **本仓库起点 `0.1.0`**：脚本实现尚未开始就打 `v1.0.0`，等于声明契约已稳定，是误导性自述。
- 预发版排序遵循 semver：`0.2.0-rc.1 < 0.2.0`，所以正式版发布后不能再回到同版本的 `rc`。

### 3.3 `tools/check-version.mjs` 的断言

```bash
pnpm check:version                 # 打印当前版本与结论
pnpm check:version --check         # 不合规即非零退出（CI 用法）
pnpm check:version --list          # 依据提交历史给出递增建议（只建议，不改文件）
pnpm check:version --check --tag v0.2.0
```

| 断言     | 内容                                                                                           |
| -------- | ---------------------------------------------------------------------------------------------- |
| ① 格式   | `/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/`；拒绝前导零、空段、把 `v` 前缀写进文件                   |
| ② 递增   | 严格大于历史最高版本，**按 semver 数值比较而非字符串**（否则 `0.9.0 → 0.10.0` 会被误判为回退） |
| ③ 不重复 | 不得等于任何既有 tag 版本                                                                      |
| ④ 一致   | `--tag` 给定时，`package.json` 版本必须与 tag 一致（防手滑打错 tag）                           |

调用点三处：`verify.yml`（prod 合入）、`release.yml`（打 tag 后复检）、本地 `pnpm check:version`。

---

## 4. 工具链与依赖

### 4.1 版本策略

- **pnpm ≥ 12.4.1**（`packageManager` 字段已固定为 `pnpm@12.4.1`），**Node ≥ 22.18**（`engines`），CI 固定 `node@24`。
- **所有依赖写精确版本**，不用 `^` / `~`。这是刻意的：发版时由 CI 从 tag 的源码重新构建产物，依赖浮动会让「同一个 tag 两次构建出不同内容」，构建必须可复现。
- 当前固定：`tsdown@0.23.0`、`oxlint@1.87.0`、`oxfmt@0.72.0`、`oxlint-tsgolint@7.0.2003`、`typescript@7.0.2`、`vitest@5.0.3`、`@types/node@26.6.5`。

### 4.2 `minimumReleaseAge`：不要关闭

`pnpm-workspace.yaml` 里显式配置了：

```yaml
minimumReleaseAge: 1440 # 只安装发布满 24 小时的版本
allowBuilds: {} # 无依赖需要放行安装脚本
```

这是**供应链保护**：恶意版本通常在发布后一小时内被发现并撤下。显式写出还有第二个作用——它让 `minimumReleaseAgeStrict` 默认为 `true`，于是找不到满足条件的版本时**直接解析失败**，而不是静默降级到新版本。

遇到「某个版本装不上」时：

1. 优先**等待**到满 24 小时；发布计划赶不上时退到**已满 24h 的最近版本**（本项目全部依赖都是这样选的，发布于 16.9 小时的 `tsdown@0.23.1` 因此没被采用）。
2. 需要豁免时用 `minimumReleaseAgeExclude` **逐包列出**并写清理由。
3. **不要关闭 `minimumReleaseAge`，也不要使用 `dangerouslyAllowAllBuilds`。**

引入带原生构建的依赖时，在 `allowBuilds` 里逐项写 `true`，不要整体放行。

### 4.3 Lint 与格式化

- `oxlint --type-aware`，配置在根 `.oxlintrc.json`（`correctness: error`、`suspicious: warn`，启用 typescript / unicorn / import / promise / node 插件）。
- `oxfmt`，配置在根 `.oxfmtrc.json`（100 列、单引号、分号、尾随逗号、自动整理 import 顺序）。
- 两个工具都只在根配置一处，**不要在各包添加独立配置**。
- 新增 lint 抑制注释时**必须写明理由**：`// oxlint-disable-next-line <rule> -- <原因>`。

---

## 5. 契约红线

以下三条是「产物能被 Sub-Store 执行」的前提，由 `pnpm smoke` 守护。改动构建配置或入口文件前先读 [`packages/internal/src/substore.ts`](../../packages/internal/src/substore.ts) 顶部注释。

1. **入口必须有顶层函数声明**，且**不能有 `export`/`import`**。
   Sub-Store 用 `new Function(..., script + '\n return operator')` 取入口；文件路径下用 `typeof main === 'function'` 找入口。一旦有导出，rolldown 会把函数包进 `(function (exports) { … })({})`，两者都会失效。
2. **tsdown `format` 必须是 `'es'`**，不能是 `'iife'`。
   实测：`iife` 产出 `(function () { … })();`，函数被关进闭包，`return operator` 报 `operator is not defined`。
3. **`treeshake` 必须为 `false`**，否则无人引用的顶层函数会被当死代码删除。

`pnpm smoke` 会检查产物形状并以复刻的 Sub-Store 环境实际调用一次。**它是产物契约的唯一验收手段，任何构建配置改动都必须让它通过。**

### 5.1 测试分工

| 层次     | 工具                                 | 覆盖什么                                                          |
| -------- | ------------------------------------ | ----------------------------------------------------------------- |
| 单元测试 | vitest（`packages/*/src/*.test.ts`） | 可复用的纯函数逻辑；入口源码的文本契约（顶层函数存在、无 export） |
| 产物冒烟 | `tools/smoke.mjs`                    | `dist/*.js` 的真实形状与可执行性                                  |

**两者不可互相替代**：单元测试测的是源码模块，Sub-Store 执行的是产物文本，取入口的机制完全不同。开发新逻辑时，把可测的纯粹逻辑抽成可导出的小模块，入口只负责编排——否则这段逻辑在单元测试里无从触及。

---

## 6. 提交前自查

```bash
pnpm verify   # check + check:version + build + smoke + test
```

改动 `packages/*/src/` 下非测试文件、或改动 tsdown / package.json 等构建配置时，**必须跑 `pnpm smoke`**（`pnpm verify` 已包含）。产物形状的三条约束（见 §5）从源码看不出来，只有它能发现。

`dist/` **不进版本库**：发版时由 CI 从 tag 的源码重新构建，上传 OSS 并作为 Release 附件归档。因此提交时不需要带产物，`pre-commit` 钩子改为提示跑冒烟。
