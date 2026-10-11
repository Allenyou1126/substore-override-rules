# 发版手册

面向：要发布新版本的人。规范前提见 [开发规范](standards/development.md)。

发版是**人主导**的：CI 只做校验与执行，版本决定权在人手里，且 CI 不需要 `prod` 分支的写权限。

---

## 1. 前置条件（首次发版前必须全部就绪）

发版链路依赖阿里云 OSS，以下几项**必须先配好**，否则 `release.yml` 会在「校验上传结果与公网可读性」这一步失败。

### 1.1 RAM 用户与 AccessKey

在[RAM 控制台](https://ram.console.aliyun.com/users/create)创建用户，只授予本文档给出的最小权限，然后为仓库配置两个 Secret：

| Secret                  | 内容             |
| ----------------------- | ---------------- |
| `OSS_ACCESS_KEY_ID`     | AccessKey ID     |
| `OSS_ACCESS_KEY_SECRET` | AccessKey Secret |

位置：`https://github.com/Allenyou1126/substore-override-rules/settings/secrets/actions`。

**最小权限策略**（贴到该 RAM 用户的自定义策略里）：

```json
{
    "Version": "1",
    "Statement": [
        {
            "Effect": "Allow",
            "Action": ["oss:PutObject"],
            "Resource": ["acs:oss:*:*:blog-hk/substore-override-rules/*"]
        },
        {
            "Effect": "Allow",
            "Action": ["oss:GetObject", "oss:ListObjects"],
            "Resource": [
                "acs:oss:*:*:blog-hk/substore-override-rules",
                "acs:oss:*:*:blog-hk/substore-override-rules/*"
            ]
        }
    ]
}
```

要点：

- **不授予** `DeleteObject`、`PutBucket*` 等 Bucket 级管理动作。
- `blog-hk` 是**共享 Bucket**，`substore-override-rules/` 前缀是唯一的边界，因此 `Resource` 必须精确到这个前缀。
- `oss:PutObject` 覆盖创建与覆盖两种情况，不需要额外动作。

### 1.2 匿名只读

Sub-Store 需要能直接 GET 脚本，因此 `substore-override-rules/*` 必须允许匿名读取。

在 OSS 控制台给该 Bucket 添加 Bucket Policy，放行 `blog-hk/substore-override-rules/*` 的 `oss:GetObject`（如需排查方便可一并放行 `oss:ListObjects`，只作用于该前缀）。

> 这一步没配好的表现：产物上传成功，但匿名 `curl` 返回 **403**，发版在第 3 步失败。**这是刻意设计的**——宁可在发版时明确失败，也不要静默产出一个 403 的链接。

### 1.3 自定义域名

`blog-oss.allenyou.top` 需回源到 `blog-hk`。这一项由你维护，CI 只依赖它可读。

### 1.4 CDN 缓存（若域名前有 CDN）

- 版本路径（`<version>/…`）用 `immutable` 长缓存，**永远不需要刷**。
- `latest/` 与短链用 `max-age=300`，**每次发版后需要刷新**，否则会拉到旧脚本。

若没有 CDN，只需等待 OSS 自身的缓存过期时间。

---

## 2. 发版步骤

### 第 1 步：在 dev 上递增版本

按 [递增判定表](standards/development.md#32-递增判定表) 判断该用 major / minor / patch，然后：

```bash
git switch dev
pnpm check:version --list        # 看建议（仅建议，需人工确认）
npm version --no-git-tag-version minor   # 换成实际判定结果
pnpm verify                      # 确认一切正常
git add package.json && git commit -m "chore(release): prepare v0.2.0"
```

> `npm version --no-git-tag-version` 只改 `package.json`，不打 tag、不自动提交——tag 留到 `prod` 上再打。

### 第 2 步：开 PR 到 prod

```bash
git push origin dev
gh pr create --base prod --head dev --title "release: v0.2.0" \
  --body "版本判定依据：……\n用户影响：……"
```

PR 描述里写清**版本判定依据**与**用户影响**（是否需要改配置、是否有不兼容变更）。

CI 会跑：提交信息校验 → 合入来源守卫 → 版本号校验 → typecheck/lint/format → 构建 → 冒烟 → 测试。

### 第 3 步：合入并打 tag

合入 `prod` 后：

```bash
git switch prod && git pull
git tag -a v0.2.0 -m "v0.2.0"
git push origin v0.2.0
```

> 打错 tag 时的处置：`git push --delete origin v0.2.0 && git tag -d v0.2.0`。
> **已发布过的 tag 不要复用**——`check-version` 会拒绝重复版本号，这是有意的。

### 第 4 步：CI 自动完成

`release.yml` 由 tag 触发，依次做：

1. `pnpm check:version --check --tag "$GITHUB_REF_NAME"` —— 版本与 tag 一致性复检。
2. `pnpm build && pnpm smoke` —— 构建并验收产物契约。
3. 上传产物到 OSS（对象键见下）。
4. 校验：`head-object` 核对存在与字节数；**匿名 `curl` 拉取并逐字节比对**。
5. `gh release create` 建 Release 存档，正文附对外链接。

---

## 3. OSS 对象布局

每次发版写 **3 个对象 / 每个脚本**，全部在 `substore-override-rules/` 前缀内：

| 对象键                                       | 用途                   | Cache-Control                         |
| -------------------------------------------- | ---------------------- | ------------------------------------- |
| `substore-override-rules/<version>/<pkg>.js` | 版本钉住，**永不覆盖** | `public, max-age=31536000, immutable` |
| `substore-override-rules/latest/<pkg>.js`    | 跟随最新正式版         | `public, max-age=300`                 |
| `substore-override-rules/<pkg>.js`           | 短链，始终指向最新     | `public, max-age=300`                 |

`<pkg>` ∈ `substore-clean` / `substore-rules`。

对外链接（域名 `https://blog-oss.allenyou.top`）：

```text
https://blog-oss.allenyou.top/substore-override-rules/0.2.0/substore-clean.js
https://blog-oss.allenyou.top/substore-override-rules/latest/substore-clean.js
```

上传统一带 `--content-type 'application/javascript; charset=utf-8'`。OSS 默认可能按后缀猜或落成 `application/octet-stream`，错误媒体类型会影响 CDN 缓存与浏览器调试。

实现上**逐个 `aws s3 cp` 精确写入，不用 `s3 sync`**：`sync --delete` 在这种共享 Bucket 上会误判前缀外的对象，行为不可预测。

---

## 4. 回滚

**历史版本对象不可变**，所以回滚不需要重新构建：

1. 找到要回退到的版本（OSS 上的 `<version>/` 目录，或 GitHub Release 记录）。
2. 把别名对象重新指回该版本：

```bash
AWS_ENDPOINT_URL_S3=https://s3.oss-cn-hongkong.aliyuncs.com \
aws s3 cp \
  s3://blog-hk/substore-override-rules/0.1.0/substore-clean.js \
  s3://blog-hk/substore-override-rules/latest/substore-clean.js \
  --content-type 'application/javascript; charset=utf-8' \
  --cache-control 'public, max-age=300'
```

3. 刷新 CDN 上 `/substore-override-rules/latest/*` 与短链的缓存。
4. **不要降低 `package.json` 的版本号。** 下一个版本号继续往上递增；已发布的 tag 也不删除（它仍是不可变记录）。
5. 若需要标记撤回，在 GitHub Release 的说明里注明，必要时把 Release 标为 pre-release。

> 直接改版本号回退会让 `check-version` 拒绝后续发版，并且与既有 tag 冲突——这就是为什么回滚走「重指别名」而不是「改版本号」。

---

## 5. 故障排查

| 现象                                                            | 原因                                                      | 处置                                                                                                         |
| --------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `release.yml` 在匿名 curl 处报 **403**                          | Bucket 未对该前缀开放匿名读                               | 见 [§1.2](#12-匿名只读)                                                                                      |
| 匿名 curl **404**                                               | 域名未回源到 `blog-hk`，或对象键拼错                      | 核对域名映射与 `OSS_PREFIX`                                                                                  |
| 匿名 curl 内容与本地**不一致**                                  | CDN 缓存了旧内容                                          | 刷新 `latest/` 与短链的 CDN 缓存，见 [§1.4](#14-cdn-缓存若域名前有-cdn)                                      |
| 上传报 `AccessDenied`                                           | RAM 策略的 `Resource` 前缀不匹配                          | 核对策略里是 `blog-hk/substore-override-rules/*`                                                             |
| 上传报 `InvalidArgument: aws-chunked encoding is not supported` | AWS CLI 对大文件启用分段上传，而 OSS 不支持 `aws-chunked` | 产物只有几 KB，正常不会触发；若出现，改用阿里云官方 `ossutil` 上传（见 [§6](#6-已知风险与备选方案)）         |
| `check-version` 报「没有严格递增」                              | 版本号 ≤ 历史最高 tag                                     | 递增版本号；回滚走 [§4](#4-回滚)                                                                             |
| `check-version` 报「tag 与 package.json 不一致」                | tag 打错                                                  | 删除该 tag 重打；**已在 prod 上打过就不要复用同一版本号**                                                    |
| `guard-prod-source` 报「合入内容的顶端不属于 dev」              | 从非 dev 分支推进了 prod                                  | 撤销该提交，改走 `dev → prod`                                                                                |
| `guard-prod-source` 给出 warning（退出码 2）                    | 证据不足（首次建立 prod、浅克隆等）                       | **不是自动放行**，需人工确认来源；见 [§1.1](standards/development.md#11-只允许从-dev-合入-prod-是怎么实现的) |
| Sub-Store 报 `operator is not defined`                          | 产物被包成了 IIFE 或函数被摇树删掉                        | 检查 `tsdown.config.ts`：`format` 应为 `'es'`、入口无 `export`、`treeshake: false`；跑 `pnpm smoke`          |

---

## 6. 已知风险与备选方案

- **`aws-chunked` 兼容性**：OSS 明确不支持 `aws-chunked` 传输编码。当前产物是几 KB 的单文件，AWS CLI 不会启用分段上传，因此走通了。若将来产物变大或上传行为变化导致该错误，备选方案是改用阿里云官方 `ossutil`（仍在「官方工具优先」原则内），代价是放弃 `aws-actions/configure-aws-credentials`。`release.yml` 第 3 步的实测校验就是这条风险的证伪手段。
- **凭证形态**：当前用 RAM 长期 AccessKey。若将来要提高安全性，可改为 OIDC + STS 临时凭证，但需要在阿里云侧配置可信实体与角色信任策略，工作量明显更大。
- **首次发版**：`prod` 建立时与 `dev` 指向同一提交，「来自 dev 的合入」尚无历史样本，`guard-prod-source` 会给出软失败 warning。这是预期行为，人工确认即可。
