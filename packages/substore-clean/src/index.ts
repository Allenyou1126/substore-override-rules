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
 *      一旦有导出，rolldown 在 `format: 'es'` 下会原样输出 `export` 语句，而 Sub-Store 是
 *      把脚本文本插进 `new Function(...)` 求值的 —— 那句 `export` 直接是语法错误。
 *      （历史上还有第二种失败形态：被包成 `(function(exports){...})({})`，函数被关进闭包。）
 *      这条约束由 `pnpm smoke` 守着，不要靠人工记忆。
 *
 *   3. 文件**末尾必须保留那条 marker 赋值**。
 *      `operator` 在本文件里没有调用点，打包器开着 treeshake 时会把整个函数摇掉，
 *      产物变成空壳。marker 是一条真实的顶层副作用，它引用 `operator`，
 *      于是函数声明被保留，而 treeshake 仍然可以开着（关掉的代价是 613 kB，见 tsdown.config.ts）。
 *
 *   4. 返回 falsy 时 Sub-Store 会保留入参，所以「清洗」可以直接返回新数组。
 *
 * 另外：入口文件的 no-unused-vars / TS6133 在根配置里被显式放过
 * （.oxlintrc.json 针对本文件的 override，以及各包 tsconfig 的 noUnusedLocals: false）。
 * 入口函数由 Sub-Store 在运行时取用，源码里没有调用点；marker 之后 tsc 已不再报 TS6133，
 * 但那条 override 保留着，免得将来换 marker 写法时突然被判定成未使用。
 *
 * 当前仍是框架阶段的实现：接受一个 `enabled` 开关（默认 true），除此之外不做任何清洗。
 * 本次改动只打通「参数 → 生效」的链路，清洗逻辑本身属于后续开发。
 */

import { parseScriptParams, z, zBool, type SubStoreScriptArguments } from '@substore/internal';

/**
 * Sub-Store 在 `new Function` 里把 `$arguments` 作为形参注入，所以它不是一个
 * 在源码里有声明位置的变量。类型真源见 packages/internal/src/substore.ts
 * 的 `SubStoreRuntimeGlobals`；这里只补一句声明让 tsc 认它。
 *
 * 运行时可能是 undefined（即时预览页），`parseScriptParams` 会把「缺失」当成空参数。
 */
declare const $arguments: SubStoreScriptArguments;

/**
 * 本脚本的参数 schema。
 *
 * `$arguments` 的四种来源形态（对象 / JSON 字符串 / `k=v&…` 字符串 / 缺失）与
 * 「字符串 → boolean / 数字」的转换全部由 `parseScriptParams` 处理，这里只声明参数本身。
 *
 * 目前只有一个总开关 `enabled`，且默认值就是 `true` —— 也就是说默认行为与
 * 「透传占位」完全一致。用 `z._default` 而不是「缺省 undefined 再在代码里兜底」，
 * 是为了让「默认开着」这件事写在 schema 里、并且对调用方可见。
 * 过滤、重命名、去重等真正的业务参数属于后续开发，加在这里即可。
 */
const CLEAN_PARAMS = z.object({
  // oxlint-disable-next-line no-underscore-dangle -- zod 就是这个 API 名，没有别名
  enabled: z.optional(z._default(zBool(), true)),
});

function operator(
  proxies: unknown[] = [],
  _targetPlatform?: string,
  _context?: Record<string, unknown>,
): unknown[] {
  // 参数非法会抛错（消息可读、带字段名），Sub-Store 会把它写进日志：
  //   Parser [Script Operator] failed ... Reason: ...
  const params = parseScriptParams(CLEAN_PARAMS, $arguments);

  if (!params.enabled) {
    return [];
  }

  return proxies;
}

/**
 * 保住上面那个顶层函数声明的 marker —— 见文件头第 3 条与 tsdown.config.ts。
 *
 * `globalThis` 只是用来承载一条真实副作用的最小手段；`new Function` 环境里它总是存在。
 * 属性名带包名前缀，避免与 Sub-Store 自己的全局撞名。
 */
// oxlint-disable-next-line no-underscore-dangle -- 全局属性名刻意带前缀，避免与 Sub-Store 自己的全局撞名
(globalThis as Record<string, unknown>).__substoreCleanEntry = { operator };
