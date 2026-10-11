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
 *
 * ⚠️ 契约红线（改动前先读 packages/internal/src/substore.ts 顶部注释）：
 *
 *   1. `main` 与 `operator` 都必须是**顶层函数声明**。
 *   2. 这个文件**不要 export 任何东西** —— 理由与 packages/substore-clean/src/index.ts
 *      里写的一样：有导出就会被 rolldown 包成 IIFE，函数被关进闭包后
 *      Sub-Store 的 `typeof main === 'function'` 与 `return operator` 都会失效。
 *
 * 另外：`no-unused-vars` / TS6133 对**入口文件**在根配置的 override 里关闭了。
 * 入口函数由 Sub-Store 在运行时取用，源码里没有调用点；而 `@ts-expect-error` 与
 * `oxlint-disable-next-line` 无法同时生效（两者都要求自己是紧邻上一行）。
 *
 * 当前是框架阶段的占位实现：两个函数都只做透传，不含任何规则内容。
 * 规则集数据、策略组构造、配置合并属于后续开发。
 */

/** mihomo 配置的最小形状。字段含义见 mihomo 文档，这里只固定入口契约。 */
interface MihomoConfig {
  'proxy-groups'?: unknown[];
  rules?: string[];
  'rule-providers'?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * 文件路径下的入口：收到解析后的 mihomo 配置，返回修改后的配置对象。
 */
async function main(config: MihomoConfig): Promise<MihomoConfig> {
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
  return proxies;
}
