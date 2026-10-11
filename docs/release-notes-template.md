# 发版说明模板

`release.yml` 目前用 `gh release create --generate-notes` 自动生成变更列表，并在正文里追加对外链接。本模板用于**需要人工撰写**的场合：Major / Minor 发版、含破坏性变更、或需要写清用户操作步骤时。

用法：在 tag 的 Release 页面上编辑正文，按下面的结构填写；或本地准备 markdown 文件后 `gh release edit vX.Y.Z --notes-file <file>`。

---

```markdown
## 对外链接（阿里云 OSS）
```

https://blog-oss.allenyou.top/substore-override-rules/<version>/substore-clean.js
https://blog-oss.allenyou.top/substore-override-rules/<version>/substore-rules.js

```

跟随最新版（链接不变，内容会被后续发版覆盖）：

```

https://blog-oss.allenyou.top/substore-override-rules/latest/substore-clean.js
https://blog-oss.allenyou.top/substore-override-rules/latest/substore-rules.js

```

## 本版要点

一句话说明这个版本对使用者意味着什么。例如：
「新增节点名按地区自动编号，修正规则集地址失效问题。」

## 新增

- 订阅清洗：……
- 配置分流：……

## 修复

- ……

## 破坏性变更

> 若本版无破坏性变更，写「无」并删掉下面的说明段。

- **变更内容**：……
- **影响范围**：……（哪些配置会失效）
- **迁移步骤**：
  1. 打开 Sub-Store → 对应订阅 / 集合 → 脚本操作
  2. 把参数 `旧名` 改为 `新名`
  3. 保存后重新拉取订阅确认生效

## 已知问题

- ……

## 升级提示

- 钉住版本的用户：把脚本链接里的版本号改成 `<version>`。
- 使用 `latest` 链接的用户：若客户端仍拉取到旧内容，通常是 CDN 或客户端缓存，
  给链接加一个变化的时间戳查询串即可绕过。
- 本版是否需要重新构建：否。（产物由 CI 从本 tag 的源码构建，已上传 OSS 并归档在下方附件）
```

---

## 撰写约定

1. **面向使用者写，不是面向代码写。** 「规则集地址从 A 换到 B」比「重构规则集加载逻辑」有用。
2. **破坏性变更必须给出可操作的迁移步骤**，并对应提交里的 `BREAKING CHANGE:` 或 `type!`。
3. **版本号判定依据**应与 [递增判定表](../standards/development.md#32-递增判定表) 一致：破坏性变更 → MAJOR，`feat` → MINOR，`fix`/规则小修正 → PATCH。
4. 链接里的 `<version>` 不要写 `v` 前缀——tag 是 `v0.2.0`，但 OSS 目录名是 `0.2.0`。
