/**
 * Sub-Store 脚本执行环境的忠实复刻 —— **测试专用**，由各交付包的产物冒烟套件使用
 * （每个包里的 `test/artifact.test.ts`，命令 `pnpm test`）。
 *
 * ⚠️ **入口文件绝不能 import 本模块。** 它只服务于测试：一旦被入口引用，产物里会多出
 *    `new Function` 复刻逻辑与这份说明，`pnpm smoke` 的形状与体积断言会立刻失败。
 *    契约的**类型**说明在 `./substore.ts`，两份文件配套读。
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
 *
 * 放在 internal 而不是某个工具目录的理由：两个交付包的冒烟套件需要**同一份**复刻。
 * 执行环境本身就是契约的一部分，两份实现一旦漂移，冒烟测试就不再是证据。
 */

/** 与上游 `createDynamicFunction` 的 Node 分支**逐字一致**的形参名，顺序也不能改。 */
export const SUBSTORE_GLOBALS = [
    "$arguments",
    "$options",
    "$substore",
    "lodash",
    "ProxyUtils",
    "yaml",
    "Buffer",
    "b64d",
    "b64e",
    "DOMAIN_RESOLVERS",
    "scriptResourceCache",
    "flowUtils",
    "produceArtifact",
    "require",
] as const;

/** 上游在结尾追加的取函数语句。`loadOperator` 用它，与上游逐字一致。 */
export const OPERATOR_TAIL = "\n return operator";

/** 求值环境里的自由变量名。 */
type SubStoreGlobalName = (typeof SUBSTORE_GLOBALS)[number];

/**
 * 注入的自由变量。
 *
 * 未提供的项一律是 `undefined` —— 与上游在 Node 环境下把 `require` 传成 `undefined`
 * 的做法一致。脚本实现里应当对 `$arguments` 之类做兜底。
 */
export type SubStoreGlobalOverrides = Partial<Record<SubStoreGlobalName, unknown>>;

/** 节点数组路径的入口，即 Sub-Store 的 `return operator` 取到的那个函数。 */
export type SubStoreOperator = (...args: unknown[]) => unknown;

/** mihomo 配置路径的入口，上游用 `typeof main === 'function'` 找它。 */
export type SubStoreMain = (config: unknown) => unknown;

/** 求值出来的整个作用域里，我们关心的两个入口。 */
export interface SubStoreEntryScope {
    /** 由 `loadEntries` 保证是函数（取不到就直接抛错）。 */
    operator: SubStoreOperator;
    /** 只有带 mihomo 配置入口的产物才有（clean 没有 `main`）。 */
    main?: SubStoreMain;
}

/** 构造按需返回的自由变量值。 */
export function createGlobals(overrides: SubStoreGlobalOverrides = {}): Record<string, unknown> {
    const globals: Record<string, unknown> = {};

    for (const name of SUBSTORE_GLOBALS) {
        globals[name] = name in overrides ? overrides[name] : undefined;
    }

    return globals;
}

/**
 * 把脚本文本编译成可调用的工厂函数，用与 Sub-Store 相同的方式。
 *
 * 必须用 `Function` 构造器 —— 它的唯一目的就是复刻 Sub-Store 的求值方式。
 * 换成 eval 或直接 import 都会让测试偏离真实运行环境，失去把关意义。
 *
 * 返回值刻意是 `unknown`：`new Function` 的静态类型只能是 `Function`，真实签名由这里
 * 拼出来的 body 决定，因此调用方必须做**运行时校验**（见 `isCallable`），而不是断言。
 */
function compile(body: string): (...args: unknown[]) => unknown {
    let factory: unknown;

    try {
        // oxlint-disable-next-line typescript/no-implied-eval -- 刻意复刻 Sub-Store 的 new Function
        factory = new Function(...SUBSTORE_GLOBALS, body);
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new Error(
            `脚本文本无法被 Sub-Store 求值（new Function 抛错）：${reason}\n` +
                "  常见原因：产物顶层出现了 `import` / `export` 模块语法，或被包成了 IIFE 包裹表达式。\n" +
                "  检查 packages/*/tsdown.config.ts：format 应为 'es'，且入口文件不能有 export。",
            { cause: error },
        );
    }

    if (typeof factory !== "function") {
        // `new Function` 只会返回函数，这里纯粹是让类型收窄到可调用的形状
        throw new Error("new Function 没有返回函数，运行环境异常。");
    }

    return (...args: unknown[]): unknown => Reflect.apply(factory, undefined, args);
}

/** 按形参顺序把自由变量的值铺开传给工厂函数。 */
function callFactory(
    factory: (...args: unknown[]) => unknown,
    globals: Record<string, unknown>,
): unknown {
    return factory(...SUBSTORE_GLOBALS.map((name) => globals[name]));
}

/**
 * 运行时可调用即认为是入口函数。
 *
 * 类型谓词而不是 `as`：`new Function` 求值出来的东西只能是 `unknown`，能不能当函数用
 * 只有运行时知道。`operator` 与 `main` 的差别只在调用约定上，收窄成同一个签名即可
 * 互相赋值。
 */
function isCallable(value: unknown): value is SubStoreOperator {
    return typeof value === "function";
}

/** `operator` 取不到时的统一报错 —— 这是产物形状坏掉的典型症状。 */
function missingOperatorError(): Error {
    return new Error(
        "Sub-Store 的 `return operator` 取到的不是函数。\n" +
            "  最常见的原因：入口里那条保住顶层函数声明的 marker 被删了，函数被摇树删掉。\n" +
            "  检查 packages/*/src/index.ts 末尾的 `__substore*Entry` 赋值。",
    );
}

/**
 * 用与 Sub-Store 相同的方式求值，并交出整个作用域。
 *
 * 为什么不是只返回 `operator`：mihomo 配置路径取的是 `main`（见 `substore.ts` 顶部注释），
 * 而 `return operator` 这个尾巴只能取到一个名字。所以这里把求值出来的整个作用域交出去，
 * 由调用方按名字取所需入口 —— 两条路径都能测到，且求值环境与上游完全一致。
 *
 * @param script 产物文件内容
 * @param overrides 注入的自由变量，例如 `{ $arguments: { name: 'x' } }`
 * @throws 脚本文本无法求值，或取不到 `operator`
 */
export function loadEntries(
    script: string,
    overrides: SubStoreGlobalOverrides = {},
): SubStoreEntryScope {
    const globals = createGlobals(overrides);

    // 返回数组而不是对象：求值结果是 `unknown`，数组能用 `Array.isArray` 安全收窄。
    // 两个元素都用 `typeof x === 'function' ? x : undefined` 取 —— clean 产物里没有
    // `main`，直接写标识符会抛 ReferenceError（`typeof` 对未声明的名字是安全的）。
    const entries = callFactory(
        compile(
            `${script}\n return [` +
                " typeof operator === 'function' ? operator : undefined," +
                " typeof main === 'function' ? main : undefined ]",
        ),
        globals,
    );

    if (!Array.isArray(entries)) {
        throw new Error("Sub-Store 求值出来的作用域不是数组，产物形状异常。");
    }

    const [operator, main] = entries;

    if (!isCallable(operator)) {
        throw missingOperatorError();
    }

    const scope: SubStoreEntryScope = { operator };

    if (isCallable(main)) {
        scope.main = main;
    }

    return scope;
}

/**
 * 只要 `operator` 时的便捷包装。
 *
 * 用的是上游**逐字**的 `\n return operator` 尾巴（`OPERATOR_TAIL`），也就是节点数组路径的
 * 真实取入口机制；`loadEntries` 为了同时取到 `main` 才换了等价的写法。
 *
 * @throws 脚本文本无法求值，或取到的 `operator` 不是函数
 */
export function loadOperator(
    script: string,
    overrides: SubStoreGlobalOverrides = {},
): SubStoreOperator {
    const globals = createGlobals(overrides);
    const operator = callFactory(compile(`${script}${OPERATOR_TAIL}`), globals);

    if (!isCallable(operator)) {
        throw missingOperatorError();
    }

    return operator;
}

/**
 * ── 产物形状检查（静态，只看文本）──
 *
 * 下面两条约束从源码看不出来，只有构建之后才有证据，所以和求值复刻放在一起，
 * 由每个交付包的 `test/artifact.test.ts` 调用。返回值为违规说明，空数组即合规：
 * 这样调用方可以用 `expect(violations).toEqual([])` 一次性看到全部问题。
 */

/** 会破坏产物契约的文本形态。只认行首的关键字，避免把注释或字符串里的 "import" 误判。 */
export function findModuleSyntaxViolations(script: string): string[] {
    const violations: string[] = [];
    const banned = [
        { re: /^\s*import\s/m, name: "import 声明" },
        { re: /^\s*export\s/m, name: "export 声明" },
        { re: /^\s*import\s*\(/m, name: "import() 动态导入" },
        { re: /\brequire\s*\(/, name: "require() 调用" },
    ];

    for (const { re, name } of banned) {
        const match = re.exec(script);

        if (match) {
            const line = script.slice(0, match.index).split("\n").length;

            violations.push(
                `产物里出现 ${name}（第 ${line} 行）。\n` +
                    "  入口文件不能有 export/import —— 会让 rolldown 把函数包进闭包。",
            );
        }
    }

    // 被包成 IIFE 是实测过的失败形态：函数被关进闭包，外层 return operator 取不到
    if (/^\s*\(/.test(script)) {
        violations.push(
            "产物以 `(` 开头，说明被包成了 IIFE 包裹表达式。\n" +
                "  `operator` 会被关进那个闭包，Sub-Store 的 `return operator` 将抛 operator is not defined。\n" +
                "  检查 tsdown.config.ts 的 format：应当用 'es' 而不是 'iife'。",
        );
    }

    return violations;
}

/**
 * 产物里必须出现的顶层函数声明。
 *
 * 声明前允许 `async `，因为 mihomo 配置入口必须是异步的。
 *
 * @param declarations 形如 `"function operator"` / `"function main"`
 */
export function findMissingDeclarations(script: string, declarations: readonly string[]): string[] {
    const missing: string[] = [];

    for (const declaration of declarations) {
        if (!new RegExp(`^\\s*(?:async\\s+)?${declaration}\\b`, "m").test(script)) {
            missing.push(
                `产物里找不到顶层声明 \`${declaration}\`。\n` +
                    "  常见原因：入口文件有 export 导致被包成闭包，或 treeshake 打开后把函数当死代码删掉。",
            );
        }
    }

    return missing;
}
