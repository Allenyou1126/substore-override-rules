/**
 * 脚本参数解析 —— 本仓库唯一一份「$arguments → 类型化参数」的实现。
 *
 * 为什么放在 internal：两个交付包都要解析各自的参数，而参数来源的坑是同一套
 * （见下面「$arguments 的四种形态」）。放在这里只写一次、只测一次。
 *
 * ⚠️ 这是 internal 包**第一份带依赖的运行时实现**（此前只有类型真源）。
 *    引入 zod 的代价见 docs/standards/development.md §5：产物会从约 1.7 kB 涨到约 42 kB，
 *    前提是两个交付包的 tsdown 保持 `treeshake: true` 且入口保留了 marker。
 *
 * ── $arguments 的四种形态（依据 Sub-Store 源码 backend/src/core/proxy-utils/index.js）──
 *
 *   1. 不存在（即时预览页拿不到 `$options`，或纯链接没带 `#`）→ `{}`
 *   2. 编辑页「参数」字段填的对象 → 原样
 *   3. 链接 `#` 后是 encodeURIComponent(JSON.stringify({...})) → **对象**（上游已 JSON.parse）
 *   4. 链接 `#` 后是 `k=v&k2=v2`（上面那条 JSON.parse 失败才走的回退分支）
 *      → 上游拆成 `{ k: 'v' }`，**值一律是字符串**；`k=`（空值）记成 `true`
 *
 * 于是「字符串要变成 boolean / number」不是可选优化，而是链接传参的必经之路：
 * 没有下面这几个 helper，`#dedupe=false` 会被 zod 判成非法（字符串不是 boolean）。
 * 注意 zod 自带的 `z.coerce.boolean()` 在这里是错的 —— 它会把 'false' 变成 true。
 *
 * ── 错误策略（刻意为之）──
 *
 * 参数值非法一律**抛错**，消息用 `z.prettifyError` 生成（多行、带字段路径），
 * 因为 Sub-Store 会把抛出的错误写进日志：`Parser [Script Operator] failed\n Reason: ...`。
 * 静默回退默认值会让「参数写错了」变成「参数没生效」，用户查不出来。
 *
 * 未声明的键则**静默剥离**（不报错）：Sub-Store 自己的 `noCache` / `insecure`
 * 就在同一份 `$arguments` 里，而且钉住旧版本的链接在脚本升级后必须继续可用。
 */

import { z } from "zod/mini";

import type { SubStoreScriptArguments } from "./substore";

/**
 * 参数 schema 的形状。返回值类型由它推导，调用点不必手写泛型。
 *
 * 推导能工作的前提是**两边用的是同一份 zod 类型**，所以交付包必须从
 * `@substore/internal` 取 `z`（见 index.ts 的 `export { z }`），
 * 而不是自己 `import { z } from 'zod/mini'`。后者会让 `z.infer` 得到 `unknown`。
 */
export type ScriptParamsSpec<T> = z.ZodMiniType<T>;

/** 往 issues 里塞一条自定义消息。`abort: true` 保证同一个字段只报一条。 */
function fail(context: { issues: z.core.$ZodRawIssue[] }, message: string, input: unknown): void {
    context.issues.push({ code: "custom", message, input, abort: true });
}

/** 把值渲染进错误消息：字符串带引号，undefined / 符号之类也能安全显示。 */
function describe(value: unknown): string {
    if (typeof value === "string") {
        return JSON.stringify(value);
    }

    if (value === undefined) {
        return "undefined";
    }

    if (value === null || typeof value === "number" || typeof value === "boolean") {
        return `${value}`;
    }

    // 对象 / 函数 / symbol 之类没有可读的字符串形式，交给 JSON（失败就退回类型名）。
    try {
        return JSON.stringify(value) ?? typeof value;
    } catch {
        return typeof value;
    }
}

/**
 * 宽松布尔值：`boolean` 与字符串都接受，转成真布尔值。
 *
 * - `true` / `'true'` / `'1'` / `'yes'` / `'on'` / `''`（`k=` 的空值语义）→ `true`
 * - `false` / `'false'` / `'0'` / `'no'` / `'off'` → `false`
 * - 其它（含 `1` 这种数字）→ 报错，消息里带上真实收到的值
 *
 * 刻意不用 `z.coerce.boolean()`：它按 JS 真值语义处理，`'false'` 会变成 true。
 */
export function zBool(): z.ZodMiniType<boolean> {
    return z.pipe(
        z.transform((value: unknown, context) => {
            if (typeof value === "boolean") {
                return value;
            }

            if (typeof value === "string") {
                const normalized = value.trim().toLowerCase();

                if (["true", "1", "yes", "on", ""].includes(normalized)) {
                    return true;
                }

                if (["false", "0", "no", "off"].includes(normalized)) {
                    return false;
                }
            }

            fail(context, `需为 true/false 之一，收到 ${describe(value)}`, value);
            return value;
        }),
        z.boolean(),
    );
}

/**
 * 整数，可限定区间。
 *
 * 接受数字，以及链接传参必然出现的数字字符串（`'3'` → `3`）。
 * 小数、非数字字符串、越界都会报错，并且消息里说清是哪个约束不满足。
 */
export function zIntIn(
    bounds: { min?: number; max?: number } = {},
    label = "该参数",
): z.ZodMiniType<number> {
    const { min, max } = bounds;

    return z.pipe(
        z.transform((value: unknown) => {
            if (typeof value !== "string") {
                return value;
            }

            const trimmed = value.trim();

            if (trimmed !== "" && !Number.isNaN(Number(trimmed))) {
                return Number(trimmed);
            }

            return value;
        }),
        z.number().check((context) => {
            const value = context.value;

            if (!Number.isInteger(value)) {
                fail(context, `${label}需为整数，收到 ${describe(value)}`, value);
                return;
            }

            if (min !== undefined && value < min) {
                fail(context, `${label}需 ≥ ${min}，收到 ${value}`, value);
                return;
            }

            if (max !== undefined && value > max) {
                fail(context, `${label}需 ≤ ${max}，收到 ${value}`, value);
            }
        }),
    );
}

/**
 * 逗号分隔列表：`'a, b ,c'` → `['a', 'b', 'c']`。
 *
 * 链接传参只能给字符串，而「关键字列表」这类参数写成 `k=a,b,c` 远比
 * `k=["a","b","c"]` 好写。数组形式（编辑页 JS 对象）照常通过，前后空白与空段被丢弃。
 */
export function zCsv(item?: z.ZodMiniType<string>): z.ZodMiniType<string[]> {
    return z.pipe(
        z.transform((value: unknown) => {
            if (typeof value === "string") {
                return value
                    .split(",")
                    .map((part) => part.trim())
                    .filter((part) => part !== "");
            }

            return value;
        }),
        z.array(item ?? z.string()),
    );
}

/** `decodeURIComponent` 对残缺的百分号编码会抛错，这里降级为原样返回。 */
function safeDecode(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** 复刻上游 `k=v&k2=v2` 回退分支：上游在拿不到值时记成 true，这里保持一致。 */
function parseQueryLike(text: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const pair of text.split("&")) {
        if (pair === "") {
            continue;
        }

        const separator = pair.indexOf("=");
        const key = separator === -1 ? pair : pair.slice(0, separator);

        if (key === "") {
            continue;
        }

        const rawValue = separator === -1 ? undefined : pair.slice(separator + 1);
        result[key] = rawValue ? safeDecode(rawValue) : true;
    }

    return result;
}

/** 把 `raw` 归一成待校验的对象；无法归一则抛错（消息里带原文片段，便于定位链接）。 */
function toParamsObject(raw: SubStoreScriptArguments | null): Record<string, unknown> {
    if (raw === undefined || raw === null) {
        return {};
    }

    if (typeof raw === "object") {
        if (Array.isArray(raw)) {
            throw new Error(
                "脚本参数应为一个对象，收到数组。检查链接 `#` 后的内容或编辑页「参数」字段。",
            );
        }

        return raw;
    }

    if (typeof raw !== "string") {
        throw new Error(`脚本参数应为对象或字符串，收到 ${typeof raw}。`);
    }

    const text = raw.trim();

    if (text === "") {
        return {};
    }

    // `k=v&…` 的键不可能是引号、数字、`-` 开头的，所以这几个首字符就够了：
    // 命中就按 JSON 解析（失败即报错），否则按 query 形式拆。
    if (!/^[{[",\d-]/.test(text)) {
        return parseQueryLike(text);
    }

    try {
        const parsed: unknown = JSON.parse(text);

        if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            const actual = Array.isArray(parsed)
                ? "数组"
                : parsed === null
                  ? "null"
                  : typeof parsed;
            throw new Error(`解析结果不是 JSON 对象，而是${actual}`);
        }

        return { ...parsed };
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new Error(
            `脚本参数的 JSON 解析失败：${reason}\n  收到的内容：${text.slice(0, 120)}`,
            {
                cause: error,
            },
        );
    }
}

/**
 * 解析并校验脚本参数。
 *
 * @param schema 由 `z.object({...})` 构造的参数 schema；未声明的键会被剥离
 * @param raw 运行时拿到的 `$arguments`（对象 / JSON 字符串 / `k=v&…` 字符串 / 缺失）
 * @returns 类型化参数；未传的字段取 schema 里 `z.optional(...)` / `z._default(...)` 的结果
 * @throws 参数值非法，或参数整体不是可解析的对象；消息可直接给用户看
 *
 * @example
 * const Params = z.object({ dedupe: z.optional(zBool()) });
 * const params = parseScriptParams(Params, $arguments);
 */
export function parseScriptParams<T>(
    schema: ScriptParamsSpec<T>,
    raw: SubStoreScriptArguments | null,
): T {
    const result = z.safeParse(schema, toParamsObject(raw));

    if (!result.success) {
        throw new Error(z.prettifyError(result.error), { cause: result.error });
    }

    return result.data;
}
