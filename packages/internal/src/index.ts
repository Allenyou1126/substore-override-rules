/**
 * @substore/internal —— 内部共享包。
 *
 * 两块内容：
 *
 *   1. **类型与运行时契约**（`./substore`）—— 两个交付包共用的类型真源。
 *   2. **脚本参数解析**（`./params`）—— 把运行时拿到的 `$arguments` 解析成类型化参数。
 *      两个交付包的参数来源坑完全一样，所以只实现一次。
 *
 * 业务逻辑不属于这里：它属于 packages/substore-clean 与 packages/substore-rules。
 *
 * 该包不构建、不发布（private），由 tsdown 通过 deps.alwaysBundle 内联进产物。
 *
 * ⚠️ 体积契约：产物是自包含的单文件脚本，所以这里**任何 value 导入**
 *    （例如 `import { parseScriptParams }`）都会把 zod 的运行时整块带进产物
 *    —— 约 28 kB（gzip 约 7.5 kB）。`import type { ... }` 编译后不留痕，仍然零成本。
 *    这条体积依赖「交付包 tsdown 开着 treeshake」+「入口保留 marker」，见 docs/standards/development.md §5。
 */

export type {
  SubStoreProcessControl,
  SubStoreProxy,
  SubStoreRequestInfo,
  SubStoreRequestOptions,
  SubStoreResponsePatch,
  SubStoreRuntimeGlobals,
  SubStoreScriptArguments,
  SubStoreScriptContext,
  SubStoreTargetPlatform,
} from './substore';

export type { ScriptParamsSpec } from './params';
export { parseScriptParams, zBool, zCsv, zIntIn } from './params';

/**
 * 把 zod 的 `z` 一并转出，是**刻意的**，有两个理由：
 *
 *   1. 交付包不该自己 `import { z } from 'zod/mini'` —— zod 是 internal 的依赖，
 *      不是它们的；而且那样取到的 `z` 与本包的 `ScriptParamsSpec` 不是同一份类型，
 *      `parseScriptParams` 的返回值会退化成 `unknown`。
 *   2. 参数 schema 只有一个入口，将来换实现（或加约束）时不用去每个包里翻。
 *
 * 从 `zod/mini` 再导出一次在打包上是无损的：产物本来就是整棵依赖图，
 * 多一个 re-export 不会增加字节。
 */
export { z } from 'zod/mini';
