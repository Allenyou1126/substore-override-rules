/**
 * Sub-Store 运行时契约 —— 本仓库唯一的类型真源。
 *
 * 事实依据（Sub-Store 源码 backend/src/core/proxy-utils/processors/index.js，
 * 函数 `createDynamicFunction` 与 `ScriptOperator`）：
 * 脚本操作会把脚本文本交给 createDynamicFunction，等价于执行
 *
 *   new Function(
 *     '$arguments', '$options', '$substore', 'lodash', 'ProxyUtils', 'yaml',
 *     'Buffer', 'b64d', 'b64e', 'DOMAIN_RESOLVERS', 'scriptResourceCache',
 *     'flowUtils', 'produceArtifact', 'require',
 *     `${script}\n return operator`,
 *   )(...)
 *
 * 另有第二条路径：对 mihomo 配置文件，Sub-Store 把脚本文本**整体展开**进一个
 * 异步函数体，再用 `typeof main === 'function'` 找入口：
 *
 *   let { $content, $files, $options, $file } = input
 *   <脚本文本>
 *   if (typeof main === 'function') { $content = yaml.safeDump(await main(config)) }
 *
 * 由此推出四条不可违反的约束，构建产物必须始终满足（均由 `pnpm smoke` 守护）：
 *
 *   1. 脚本里必须有**顶层 `function operator` 声明**（文件路径下用 `main`）。
 *      末尾那行 `return operator` 取的是标识符，而函数声明才提供可被其取到的绑定。
 *
 *   2. 产物**不能把函数包进任何闭包**。
 *      实测（tsdown 0.23.0）：`format: 'iife'` 会输出
 *          (function () { function operator() {} })();
 *      `operator` 被关在闭包里，外层 `return operator` 抛 "operator is not defined"。
 *      这就是 tsdown 配置里用 `format: 'es'` 而不是 `iife` 的原因 —— 反直觉但正确。
 *
 *   3. 入口文件**不能有 `export`**。
 *      一旦有导出，rolldown 会保留 `export` 语句（实测 `format: 'es'`），而
 *      `new Function` 无法解析模块语法，直接抛 `Unexpected token 'export'`；
 *      历史上还有第二种失败形态：被改包成
 *          (function (exports) { ...; return exports; })({});
 *      函数同样被关进闭包，而且 `(...)({})` 这种调用放在 `${script}` 的插值位置
 *      （以及异步函数体内）无法解析。**入口可以有 `import`**（产物会被内联成单文件），
 *      就是不能有 `export`。
 *
 *   4. 入口必须有一条**引用入口函数的顶层副作用**（本仓库叫它 marker），
 *      例如 `(globalThis as Record<string, unknown>).__substoreCleanEntry = { operator };`。
 *      理由：`operator` / `main` 在源码里没有任何调用点，打包器开着 treeshake 时会把
 *      顶层函数当死代码删掉。marker 让打包器看见「有人用了它」，于是 treeshake 可以开着。
 *
 *      为什么非要开着 treeshake：这是**引入 zod 之后才浮现的约束**。
 *      关掉 treeshake 时整棵依赖图会被原样内联 —— 实测产物从约 42 kB 变成 613 kB
 *      （gzip 从 13 kB 变成 111 kB），zod-mini 的体积优势全没了。
 *      而给入口加 `export` 换不来这个效果（见第 3 条），所以 marker 是唯一可行的办法。
 *
 *      删掉 marker 不会让构建失败，只会让产物变成空壳 —— 这正是 `pnpm smoke` 要拦的：
 *      它除了检查「行首有 `function operator`」，还会检查产物不以 `(` 开头、没有
 *      `import` / `export` / `require(`，并把体积打出来（体积突然涨到 600 kB 就说明
 *      treeshake 被关了）。
 */

/**
 * 编辑页「参数」字段传入的值。
 *
 * `$arguments`（编辑页参数）与 `$options`（输出链接 `?$options=`）在运行时都可能是
 * 对象、JSON 字符串，或干脆不存在（即时预览页拿不到 `$options`）。因此这里的类型
 * 刻意宽松：解析与兜底属于后续实现阶段的职责，框架阶段只固定形状。
 */
export type SubStoreScriptArguments = Record<string, unknown> | string | undefined;

/** 一次请求的元信息，对应 `$options._req`。 */
export interface SubStoreRequestInfo {
  method?: string;
  url?: string;
  path?: string;
  query?: Record<string, unknown>;
  params?: Record<string, unknown>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
  socket?: { remoteAddress?: string };
}

/** 脚本可以写回的自定义响应，对应 `$options._res`。 */
export interface SubStoreResponsePatch {
  status?: number;
  headers?: Record<string, string>;
}

/** 输出链接 `?$options=` 解析后的对象。 */
export interface SubStoreRequestOptions {
  _req?: SubStoreRequestInfo;
  _res?: SubStoreResponsePatch;
  [key: string]: unknown;
}

/** Sub-Store 内部节点对象。结构整体参照 mihomo，字段随平台转换。 */
export interface SubStoreProxy {
  name: string;
  type: string;
  server?: string;
  port?: number;
  [key: string]: unknown;
}

/** 目标输出平台，例如 'Surge'、'ClashMeta'、'sing-box'。 */
export type SubStoreTargetPlatform = string;

/**
 * 脚本操作收到的上下文。
 *
 * - `env`：环境信息（后端类型与版本）
 * - `process`：动态控制本次处理中后续 action 是否执行
 * - `raw`：处理前的原始订阅内容（单条订阅为数组；组合订阅为以订阅名为键的对象）
 * - `source`：订阅/组合订阅数据，`source._collection` 是否存在可判断脚本挂在单条订阅还是组合订阅上
 */
export interface SubStoreScriptContext {
  env?: unknown;
  process?: SubStoreProcessControl;
  raw?: unknown;
  source?: Record<string, unknown>;
  [key: string]: unknown;
}

/** `context.process` 的形状；`disable` 跳过列出的后续 action，`enable` 只执行列出的。 */
export interface SubStoreProcessControl {
  type: 'disable' | 'enable';
  customNames: string[];
}

/** 脚本文本在运行时能看到的全局对象。未使用到的项不必声明。 */
export interface SubStoreRuntimeGlobals {
  /** 编辑页「参数」字段传入的脚本参数。 */
  readonly $arguments: SubStoreScriptArguments | undefined;
  /** 输出链接上的 `?$options=` 参数；含 `_req` 与可写的 `_res`。 */
  readonly $options: SubStoreRequestOptions | undefined;
}
