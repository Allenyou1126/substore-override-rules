/**
 * @substore/rules —— 配置分流规则脚本。
 *
 * 配置位置：最终集合（组合订阅）或「生成配置文件」的文件「脚本操作」。
 * 作用对象：**mihomo 配置对象**，由 Sub-Store 在文件路径下解构成 `$content` 后传入。
 *
 * 运行方式（Sub-Store 源码 ScriptOperator.nodeFunc）：
 * 当输入是文件形状（含 `$content` / `$files`）且 `$file.type` 是 `mihomoConfig` /
 * `mihomoProfile` 时，Sub-Store 会把脚本文本整体展开进一个异步函数，其中：
 *
 *   let { $content, $files, $options, $file } = input
 *   <脚本文本>
 *   if (typeof main === 'function') {
 *     config = ProxyUtils.yaml.safeLoad($content)
 *     $content = ProxyUtils.yaml.safeDump(await main(config || {}))
 *   }
 *
 * 也就是说：解析与序列化都走 Sub-Store 自带的那一份 YAML 实现，我们只负责
 * 「拿到配置对象 → 改它 → 还回去」，不必自己引入 YAML 依赖，也就没有 round-trip 风险。
 * 同一段文本也会被节点数组那条路复用（`return operator`），所以两个入口都要留着。
 *
 * ⚠️ 契约红线（改动前先读 packages/internal/src/substore.ts 顶部注释）：
 *
 *   1. `main` 与 `operator` 都必须是**顶层函数声明**。
 *   2. 这个文件**不要 export 任何东西** —— 理由与 packages/substore-clean/src/index.ts
 *      里写的一样：有导出会被包成闭包 / 或直接输出 `export` 语句，两条路径都会失效。
 *   3. 文件**末尾必须保留那条 marker 赋值**：`main` / `operator` 没有调用点，
 *      打包器开着 treeshake 时会把它俩摇掉。marker 用一条真实副作用引用它们，
 *      于是 treeshake 可以开着（关掉的代价是 613 kB，见 tsdown.config.ts）。
 *
 * 另外：`no-unused-vars` / TS6133 对**入口文件**在根配置的 override 里关着。
 * 入口函数由 Sub-Store 在运行时取用，源码里没有调用点。
 *
 * 当前仍是框架阶段的实现：接受一个 `enabled` 开关（默认 true），除此之外不改变配置。
 * 规则集数据、策略组构造、配置合并属于后续开发。
 */

import { parseScriptParams, z, zBool, type SubStoreScriptArguments } from "@substore/internal";

/**
 * Sub-Store 在 `new Function` 里把 `$arguments` 作为形参注入（mihomo 路径里它是
 * 同一个外层作用域的自由变量），所以它不是一个在源码里有声明位置的变量。
 * 类型真源见 packages/internal/src/substore.ts 的 `SubStoreRuntimeGlobals`。
 *
 * 运行时可能是 undefined（即时预览页），`parseScriptParams` 会把「缺失」当成空参数。
 */
declare const $arguments: SubStoreScriptArguments;

/**
 * 本脚本的参数 schema。
 *
 * `$arguments` 的四种来源形态与「字符串 → boolean / 数字」的转换全部由
 * `parseScriptParams` 处理。目前只有一个总开关，默认值写在 schema 里（`z._default`），
 * 真正的规则相关参数属于后续开发，加在这里即可。
 */
const RULES_PARAMS = z.object({
    // oxlint-disable-next-line no-underscore-dangle -- zod 就是这个 API 名，没有别名
    enabled: z.optional(z._default(zBool(), true)),
});

/** mihomo 配置的最小形状。字段含义见 mihomo 文档，这里只固定入口契约。 */
interface MihomoConfig {
    "proxy-groups"?: unknown[];
    rules?: string[];
    "rule-providers"?: Record<string, unknown>;
    [key: string]: unknown;
}

/**
 * 文件路径下的入口：收到解析后的 mihomo 配置，返回修改后的配置对象。
 */
async function main(config: MihomoConfig): Promise<MihomoConfig> {
    // 参数非法会抛错，Sub-Store 会把消息写进日志。异步入口里的抛错同样会被它捕获。
    // 目前解析结果还没被用到 —— 规则相关参数属于后续开发。
    parseScriptParams(RULES_PARAMS, $arguments);

    return config;
}

/**
 * 节点数组路径下的兜底入口。若脚本被误配到「节点操作」上，Sub-Store 取的是
 * `operator`；此处原样返回节点，不改变用户订阅。
 */
function operator(
    proxies: unknown[] = [],
    _targetPlatform?: string,
    _context?: Record<string, unknown>,
): unknown[] {
    parseScriptParams(RULES_PARAMS, $arguments);

    return proxies;
}

/**
 * 保住上面两个顶层函数声明的 marker —— 见文件头第 3 条与 tsdown.config.ts。
 *
 * `globalThis` 只是用来承载一条真实副作用的最小手段；`new Function` 环境里它总是存在。
 * 属性名带包名前缀，避免与 Sub-Store 自己的全局撞名。
 */
// oxlint-disable-next-line no-underscore-dangle -- 全局属性名刻意带前缀，避免与 Sub-Store 自己的全局撞名
(globalThis as Record<string, unknown>).__substoreRulesEntry = { main, operator };
