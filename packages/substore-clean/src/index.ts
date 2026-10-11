/**
 * @substore/clean —— 订阅清洗脚本。
 *
 * 配置位置：每条订阅的「节点操作 → 脚本操作」。
 * 作用对象：该条订阅的节点数组。在单条订阅阶段把节点洗干净，避免脏节点进入最终集合。
 *
 * ⚠️ 契约红线（改动前先读 packages/internal/src/substore.ts 顶部注释）：
 *
 *   1. `operator` 必须是**顶层函数声明**，名字不能改。
 *      Sub-Store 在脚本文本后追加 `\n return operator`，取的是**外层函数作用域**里的
 *      这个名字。函数声明恰好是函数作用域的绑定，所以能被取到。
 *
 *   2. 这个文件**不要 export 任何东西**。
 *      一旦有导出，rolldown 会把入口包成
 *          (function (exports) { ... return exports; })({})
 *      于是 `function operator` 被关进那个闭包，外层的 `return operator` 就取不到了；
 *      而且 `(...)({})` 这种 IIFE 调用在 Sub-Store 的 `${script}` 插值位置也无法解析。
 *      这条约束由 `pnpm smoke` 守着，不要靠人工记忆。
 *
 *   3. 返回 falsy 时 Sub-Store 会保留入参，所以「清洗」可以直接返回新数组。
 *
 * 另外：`no-unused-vars` / TS6133 对**入口文件**在根配置的 override 里关闭了。
 * 原因见 .oxlintrc.json 的注释 —— 入口函数由 Sub-Store 在运行时取用，源码里没有调用点，
 * 而 `@ts-expect-error` 与 `oxlint-disable-next-line` 无法同时生效（两者都要求自己是紧邻上一行）。
 *
 * 当前是框架阶段的占位实现：只做透传，不含任何清洗逻辑。
 * 真正的过滤 / 重命名 / 去重等属于后续开发。
 */

function operator(
  proxies: unknown[] = [],
  _targetPlatform?: string,
  _context?: Record<string, unknown>,
): unknown[] {
  return proxies;
}
