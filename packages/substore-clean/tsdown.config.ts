import { defineConfig } from "tsdown";

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
 * - `treeshake: true` + 入口里的 marker —— 两者必须同时存在。
 *   背景：Sub-Store 用 `new Function(..., script + '\n return operator')` 取入口，
 *   所以产物里必须有**顶层 `function operator` 声明**。而入口里这个函数没有任何引用点，
 *   打包器会把它当死代码删掉 —— 这正是历史上把 `treeshake` 关成 `false` 的原因，
 *   但那样一来整棵依赖图（包括 zod）都会被原样塞进产物：实测 613 kB，关了 treeshake
 *   的 zod-mini 就等于没用。
 *   正确做法：入口里补一条**真实的顶层副作用**引用这些函数
 *   （见 src/index.ts 末尾的 `__substoreCleanEntry` 赋值）。打包器看见副作用就不会
 *   删掉它们，于是 `treeshake` 可以开着，产物约 42 kB。
 *
 *   ⚠️ 删掉那条 marker 赋值，产物会被摇成空壳 —— 由 `pnpm smoke` 拦下。
 *
 *   ⚠️ 同时**不能让入口出现 `export`**：实测 `format: 'es'` 会原样保留 `export` 语句，
 *   `new Function` 直接语法错误（`Unexpected token 'export'`）。
 *   把入口改成模块（导出函数）只在 `format: 'cjs'` 下可行，但那会偏离已实测的红线。
 *
 * - `platform: 'neutral'` —— 避免注入 `require` / `__dirname` 之类的 Node 平台假设，
 *   让产物只依赖 `new Function` 注入的自由变量和标准 JS。
 *
 * - `deps.alwaysBundle` —— 把 workspace 内部包内联进来，保证产物是**单文件**，
 *   因为 Sub-Store 只会拿到这一个文件的文本。zod 不在本包的生产依赖里，
 *   因此它本来就会被内联，不需要在这里列出。
 */
export default defineConfig({
    entry: ["src/index.ts"],
    outDir: "dist",
    format: "es",
    platform: "neutral",
    target: "es2022",
    dts: false,
    sourcemap: false,
    treeshake: true,
    hash: false,
    minify: false,
    clean: true,
    deps: {
        alwaysBundle: [/^@substore\/internal$/],
    },
    outputOptions: {
        // 默认会叫 index.js；OSS 对象键与冒烟测试都用 substore-clean.js
        entryFileNames: "substore-clean.js",
    },
});
