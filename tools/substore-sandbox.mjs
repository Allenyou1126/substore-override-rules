#!/usr/bin/env node
/**
 * Sub-Store 脚本执行环境的忠实复刻。
 *
 * 这个文件的存在理由：产物到底能不能在 Sub-Store 里跑起来，只有把它放进与 Sub-Store
 * 完全相同的求值环境里执行才算数。它复刻自 Sub-Store 源码
 * `backend/src/core/proxy-utils/processors/index.js` 的 `createDynamicFunction`。
 *
 * 上游（Node 后端分支）等价于：
 *
 *   new Function(
 *     '$arguments', '$options', '$substore', 'lodash', 'ProxyUtils', 'yaml',
 *     'Buffer', 'b64d', 'b64e', 'DOMAIN_RESOLVERS', 'scriptResourceCache',
 *     'flowUtils', 'produceArtifact', 'require',
 *     `${script}\n return operator`,
 *   )(...)
 *
 * 两个必须保持一致的细节，改动前请回读上游源码：
 *   1. 形参列表 —— 脚本里的 `$arguments`、`ProxyUtils` 等自由变量就是从这里来的。
 *   2. 末尾的 `\n return operator` —— 所以脚本必须提供**顶层 `function operator`**。
 *
 * 上游的 Loon 分支形参更多（多出 `$persistentStore` / `$httpClient` / `$notification`）。
 * 我们面向 Node 后端，因此只复刻 Node 分支；若将来要支持 Loon，在这里补形参即可。
 */

/** 与上游 `createDynamicFunction` 的 Node 分支**逐字一致**的形参名，顺序也不能改。 */
export const SUBSTORE_GLOBALS = [
  '$arguments',
  '$options',
  '$substore',
  'lodash',
  'ProxyUtils',
  'yaml',
  'Buffer',
  'b64d',
  'b64e',
  'DOMAIN_RESOLVERS',
  'scriptResourceCache',
  'flowUtils',
  'produceArtifact',
  'require',
];

/** 上游在结尾追加的取函数语句。 */
export const OPERATOR_TAIL = '\n return operator';

/**
 * 构造按需返回的自由变量值。
 *
 * 未提供的全局一律是 `undefined` —— 与上游在 Node 环境下把
 * `require` 传成 `undefined` 的做法一致。脚本实现里应当对 `$arguments` 之类做兜底。
 *
 * @param {Record<string, unknown>} [overrides]
 */
export function createGlobals(overrides = {}) {
  const globals = {};

  for (const name of SUBSTORE_GLOBALS) {
    globals[name] = name in overrides ? overrides[name] : undefined;
  }

  return globals;
}

/**
 * 用与 Sub-Store 相同的方式把脚本文本编译成 `operator` 函数。
 *
 * @param {string} script 产物文件内容
 * @param {Record<string, unknown>} [overrides] 注入的自由变量，例如 `$arguments`
 * @returns {Function} 取到的 `operator`
 */
export function loadOperator(script, overrides = {}) {
  const globals = createGlobals(overrides);

  let factory;
  try {
    // 这里必须用 Function 构造器 —— 它的唯一目的就是复刻 Sub-Store 的求值方式。
    // 换成 eval 或直接 import 都会让测试偏离真实运行环境，失去把关意义。
    // oxlint-disable-next-line typescript/no-implied-eval -- 刻意复刻 Sub-Store 的 new Function
    factory = new Function(...SUBSTORE_GLOBALS, `${script}${OPERATOR_TAIL}`);
  } catch (error) {
    throw new Error(
      `脚本文本无法被 Sub-Store 求值（new Function 抛错）：${error.message}\n` +
        '  常见原因：产物顶层出现了 `import` / `export` 模块语法，或被包成了 IIFE 包裹表达式。\n' +
        "  检查 packages/*/tsdown.config.ts：format 应为 'es'，且入口文件不能有 export。",
      { cause: error },
    );
  }

  const operator = factory(...SUBSTORE_GLOBALS.map((name) => globals[name]));

  if (typeof operator !== 'function') {
    throw new Error(
      'Sub-Store 的 `return operator` 取到的不是函数。\n' +
        '  最常见的原因：入口里的顶层 `function operator` 声明被摇树删掉了。\n' +
        '  检查 packages/*/tsdown.config.ts 里的 treeshake 是否为 false。',
    );
  }

  return operator;
}
