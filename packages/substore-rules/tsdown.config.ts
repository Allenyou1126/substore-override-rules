import { defineConfig } from 'tsdown';

/**
 * 产物是给 Sub-Store 当**脚本文本**执行的，不是给 Node `import` 的库。
 * 下面几个选项不是风格偏好，改动会让产物在 Sub-Store 里直接失败。
 * 结论都经过实测：`pnpm smoke` 就是这条链路的验收。
 *
 * - `format: 'es'` —— 看着反直觉，但它和 `treeshake: false` 一起才产出**裸脚本**。
 *   Sub-Store 把脚本文本插进 `new Function(..., script + '\n return operator')`，
 *   要求产物里有一层顶层的 `function operator`。
 *   实测结论（tsdown 0.23.0）：
 *     · `iife` → 包成 `(function(){ ... })();`，`operator` 被关进闭包，
 *       外层的 `return operator` 抛 "operator is not defined"。
 *     · `es` / `cjs` + 入口无导出 → 直接输出裸的函数声明，正确。
 *   前提是入口**不能有 export**：一旦有导出，rolldown 会改包成
 *   `(function(exports){ ... return exports; })({})`，既藏起函数，
 *   又让 `(...)({})` 这种调用无法在 `${script}` 插值位置解析。
 *
 *   另外注意：Sub-Store 对 mihomo 配置走的是「把脚本文本展开进异步函数」的路径，
 *   靠 `typeof main === 'function'` 找入口，所以 `main` 也必须是顶层函数声明，
 *   不能被包进任何闭包。
 *
 * - `treeshake: false` —— 顶层 `main` / `operator` 没有被任何代码引用，
 *   摇树会把它们当死代码删掉，产物就只剩一个空壳。
 *
 * - `platform: 'neutral'` —— 避免注入 `require` / `__dirname` 之类的 Node 平台假设，
 *   让产物只依赖 `new Function` 注入的自由变量和标准 JS。
 *
 * - `deps.alwaysBundle` —— 把 workspace 内部包内联进来，保证产物是**单文件**，
 *   因为 Sub-Store 只会拿到这一个文件的文本。
 */
export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'dist',
  format: 'es',
  platform: 'neutral',
  target: 'es2022',
  dts: false,
  sourcemap: false,
  treeshake: false,
  hash: false,
  minify: false,
  clean: true,
  deps: {
    alwaysBundle: [/^@substore\/internal$/],
  },
  outputOptions: {
    // 默认会叫 index.js；OSS 对象键与冒烟测试都用 substore-rules.js
    entryFileNames: 'substore-rules.js',
  },
});
