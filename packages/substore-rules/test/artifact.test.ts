import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import type { SubStoreProxy } from "@substore/internal";
import {
    findMissingDeclarations,
    findModuleSyntaxViolations,
    loadEntries,
    loadOperator,
    type SubStoreGlobalOverrides,
    type SubStoreMain,
} from "@substore/internal/sandbox";
import { describe, expect, it } from "vitest";

/**
 * @substore/rules 的**产物冒烟测试** —— 「`dist` 里的文本真的能被 Sub-Store 执行」的唯一证据。
 *
 * 为什么必须读产物文本而不是源码：入口刻意不导出（见 `src/index.ts` 顶部注释），
 * Sub-Store 也从不 import 它。它有两条执行路径，取入口的方式完全不同：
 *
 *   1. 节点数组路径：`new Function('$arguments', …, `${script}\n return operator`)`；
 *   2. mihomo 配置路径：把脚本文本整体展开进异步函数体，再用 `typeof main === 'function'` 找入口。
 *
 * 所以两条路径都要在产物上各测一次。这里读 `dist/substore-rules.js`，放进
 * `packages/internal/src/sandbox.ts` 复刻的求值环境里跑，并且每个用例都重新求值一次
 * （与 Sub-Store 每次处理都重新 `new Function` 的行为一致）。
 *
 * 用法：`pnpm test` —— 本包的 `pretest` 会先跑 `pnpm build`，所以测的总是刚构建出来的产物
 * （`pnpm verify` 同样包含）。单独跑 `vitest run --dir test` 时不会触发构建，测的是旧产物。
 */

const ARTIFACT = "../dist/substore-rules.js";
const ARTIFACT_PATH = fileURLToPath(new URL(ARTIFACT, import.meta.url));

/**
 * 产物体积预算。
 *
 * 这条断言唯一的目的是拦住「treeshake 被关掉」：那时整棵依赖图（含 zod）会被原样内联，
 * 实测产物从约 42 kB 涨到 613 kB（见 docs/standards/development.md §5）。
 * 正常的业务增长不该接近这个数字；确实需要放宽时请**显式**改这里，并在提交信息里说明原因。
 */
const MAX_RAW_BYTES = 128 * 1024;

/** 读取产物文本；读不到就说明还没构建 —— 报错里直接说清该怎么办。 */
function readArtifact(): string {
    try {
        return readFileSync(ARTIFACT_PATH, "utf8");
    } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);

        throw new Error(
            `读不到产物 ${ARTIFACT}：${reason}\n  产物没构建：跑 pnpm test（pretest 会先构建）或 pnpm build。`,
            {
                cause: error,
            },
        );
    }
}

/** 冒烟用的假节点数组：字段与 Sub-Store 内部节点一致，内容无关紧要。 */
function fakeProxies(): SubStoreProxy[] {
    return [
        { name: "a", type: "ss", server: "a.example.com", port: 443 },
        { name: "b", type: "vmess", server: "b.example.com", port: 443 },
    ];
}

/** mihomo 配置的最小形状；字段含义见 mihomo 文档，这里只固定入口契约。 */
interface MihomoConfig {
    "proxy-groups"?: unknown[];
    rules?: string[];
    "rule-providers"?: Record<string, unknown>;
    [key: string]: unknown;
}

function fakeConfig(): MihomoConfig {
    return { rules: ["MATCH,DIRECT"], "rule-providers": {} };
}

const script = readArtifact();

/**
 * 取 mihomo 配置入口。
 *
 * 取不到时给出与真实运行一致的原因：上游用 `typeof main === 'function'` 判断，
 * 取不到就**静默跳过**脚本 —— 这是最危险的一种产物回归，必须让失败信息指向根因。
 */
function mihomoMain(overrides: SubStoreGlobalOverrides = {}): SubStoreMain {
    const { main } = loadEntries(script, overrides);

    if (typeof main !== "function") {
        throw new Error(
            "产物里取不到 `main`：Sub-Store 在 mihomo 配置路径下用 `typeof main === 'function'` 找入口，\n" +
                "  找不到就静默跳过脚本。检查入口是否仍是顶层函数，以及末尾那条 marker 是否同时引用了 main。",
        );
    }

    return main;
}

describe("@substore/rules 产物", () => {
    describe("形状（静态检查产物文本）", () => {
        it("没有 import / export / require()，也没有被包成 IIFE", () => {
            expect(findModuleSyntaxViolations(script)).toEqual([]);
        });

        it("保留了顶层 `function main` 与 `function operator`", () => {
            expect(findMissingDeclarations(script, ["function main", "function operator"])).toEqual(
                [],
            );
        });
    });

    describe("可执行性（复刻的 Sub-Store 求值环境）", () => {
        it("Sub-Store 的 `\\n return operator` 能取到函数", () => {
            expect(typeof loadOperator(script)).toBe("function");
        });

        it("mihomo 配置路径能取到 `main`（`typeof main === 'function'`）", () => {
            expect(typeof loadEntries(script).main).toBe("function");
        });
    });

    describe("行为（两条执行路径）", () => {
        it("operator 原样返回入参节点（节点数组路径）", () => {
            const proxies = fakeProxies();

            expect(loadOperator(script)(proxies, "ClashMeta", {})).toEqual(proxies);
        });

        it("main(config) 原样返回配置对象（mihomo 配置路径）", async () => {
            const config = fakeConfig();
            const result = await mihomoMain()(config);

            expect(result).toEqual(config);
        });
    });

    describe("$arguments 参数链路（zod 必须真的被内联进产物）", () => {
        it("编辑页对象形式 `{ enabled: false }` 解析成功，且不改变节点", () => {
            const proxies = fakeProxies();

            expect(
                loadOperator(script, { $arguments: { enabled: false } })(proxies, "ClashMeta", {}),
            ).toEqual(proxies);
        });

        it("链接 k=v 形式 `'enabled=false'` 同样生效（值一律是字符串）", () => {
            const proxies = fakeProxies();

            expect(
                loadOperator(script, { $arguments: "enabled=false" })(proxies, "ClashMeta", {}),
            ).toEqual(proxies);
        });

        it("operator 路径：`enabled` 非法时抛错，消息里带字段名", () => {
            expect(() =>
                loadOperator(script, { $arguments: { enabled: "maybe" } })(
                    fakeProxies(),
                    "ClashMeta",
                    {},
                ),
            ).toThrow(/enabled/);
        });

        it("main 路径：`enabled` 非法时抛错，消息里带字段名", async () => {
            const main = mihomoMain({ $arguments: { enabled: "maybe" } });

            await expect(async () => {
                await main(fakeConfig());
            }).rejects.toThrow(/enabled/);
        });
    });

    describe("体积", () => {
        it("在预算内（treeshake 被关掉时实测涨到 613 kB）", () => {
            const raw = Buffer.byteLength(script, "utf8");
            const gzip = gzipSync(script).byteLength;

            console.log(`  ↳ ${ARTIFACT}：${raw} B（gzip ${gzip} B），预算 ${MAX_RAW_BYTES} B`);

            expect(raw).toBeLessThan(MAX_RAW_BYTES);
        });
    });
});
