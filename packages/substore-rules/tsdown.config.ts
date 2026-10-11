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
 *   另外注意：Sub-Store 对 mihomo 配置走的是「把脚本文本展开进异步函数」的路径，
 *   靠 `typeof main === 'function'` 找入口，所以 `main` 也必须是顶层函数声明，
 *   不能被包进任何闭包。
 *
 * - `treeshake: true` + 入口里的 marker —— 两者必须同时存在。
 *   背景：Sub-Store 对 mihomo 配置走「把脚本文本展开进异步函数」的路径，靠
 *   `typeof main === 'function'` 找入口；节点数组路径仍用
 *   `new Function(..., script + '\n return operator')`。两条路都要求顶层函数声明。
 *   而入口里 `main` / `operator` 都没有引用点，打包器会当死代码删掉 —— 这正是历史上
 *   把 `treeshake` 关成 `false` 的原因，但那样整棵依赖图（包括 zod）都会被原样塞进产物：
 *   实测 613 kB，等于白用 zod-mini。
 *   正确做法：入口里补一条**真实的顶层副作用**引用这两个函数
 *   （见 src/index.ts 末尾的 `__substoreRulesEntry` 赋值）。打包器看见副作用就不会
 *   删掉它们，于是 `treeshake` 可以开着，产物约 42 kB。
 *
 *   ⚠️ 删掉那条 marker 赋值，产物会被摇成空壳 —— 由 `pnpm smoke` 拦下。
 *
 *   ⚠️ 同时**不能让入口出现 `export`**：实测 `format: 'es'` 会原样保留 `export` 语句，
 *   `new Function` 直接语法错误（`Unexpected token 'export'`）；异步函数体的插值位置同样解析不了。
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
        // 默认会叫 index.js；OSS 对象键与冒烟测试都用 substore-rules.js
        entryFileNames: "substore-rules.js",
    },
});
