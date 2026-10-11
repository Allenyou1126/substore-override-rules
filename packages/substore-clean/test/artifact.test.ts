import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

import type { SubStoreProxy } from "@substore/internal";
import {
    findMissingDeclarations,
    findModuleSyntaxViolations,
    loadEntries,
    loadOperator,
} from "@substore/internal/sandbox";
import { describe, expect, it } from "vitest";

/**
 * @substore/clean 的**产物冒烟测试** —— 「`dist` 里的文本真的能被 Sub-Store 执行」的唯一证据。
 *
 * 为什么必须读产物文本而不是源码：入口刻意不导出（见 `src/index.ts` 顶部注释），
 * Sub-Store 也从不 import 它，而是执行
 * `new Function('$arguments', …, `${script}\n return operator`)`。
 * 因此源码层的单测**测不到**产物形状；这里读 `dist/substore-clean.js`，放进
 * `packages/internal/src/sandbox.ts` 复刻的求值环境里跑，并且每个用例都重新求值一次
 * （与 Sub-Store 每次处理都重新 `new Function` 的行为一致）。
 *
 * 用法：`pnpm test` —— 本包的 `pretest` 会先跑 `pnpm build`，所以测的总是刚构建出来的产物
 * （`pnpm verify` 同样包含）。单独跑 `vitest run --dir test` 时不会触发构建，测的是旧产物。
 *
 * ⚠️ 不要把这些用例改写成 import 源码：那会绕过「产物是脚本文本」这条根本前提，
 *    正是这套件要守住的东西（见 docs/standards/development.md §5）。
 */

const ARTIFACT = "../dist/substore-clean.js";
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

const script = readArtifact();

describe("@substore/clean 产物", () => {
    describe("形状（静态检查产物文本）", () => {
        it("没有 import / export / require()，也没有被包成 IIFE", () => {
            expect(findModuleSyntaxViolations(script)).toEqual([]);
        });

        it("保留了顶层 `function operator`（marker 被删会让产物变成空壳）", () => {
            expect(findMissingDeclarations(script, ["function operator"])).toEqual([]);
        });
    });

    describe("可执行性（复刻的 Sub-Store 求值环境）", () => {
        it("Sub-Store 的 `\\n return operator` 能取到函数", () => {
            expect(typeof loadOperator(script)).toBe("function");
        });

        it("作用域里没有 `main`（clean 只有节点数组入口）", () => {
            expect(loadEntries(script).main).toBeUndefined();
        });
    });

    describe("$arguments 参数链路（zod 必须真的被内联进产物）", () => {
        it("编辑页对象形式 `{ name: 'smoke' }` 解析成功，节点原样透传", () => {
            const proxies = fakeProxies();

            expect(
                loadOperator(script, { $arguments: { name: "smoke" } })(proxies, "ClashMeta", {}),
            ).toEqual(proxies);
        });

        it('链接 JSON 形式 `\'{"name":"smoke"}\'` 同样生效', () => {
            const proxies = fakeProxies();

            expect(
                loadOperator(script, { $arguments: '{"name":"smoke"}' })(proxies, "ClashMeta", {}),
            ).toEqual(proxies);
        });

        it("链接 k=v 形式 `'name=smoke'` 同样生效（值一律是字符串）", () => {
            const proxies = fakeProxies();

            expect(
                loadOperator(script, { $arguments: "name=smoke" })(proxies, "ClashMeta", {}),
            ).toEqual(proxies);
        });

        it("缺 `name` 时抛错，消息里带字段名（Sub-Store 会把它写进日志）", () => {
            expect(() => loadOperator(script)(fakeProxies(), "ClashMeta", {})).toThrow(/name/);
        });

        it("`name` 类型非法时抛错，消息里带字段名", () => {
            expect(() =>
                loadOperator(script, { $arguments: { name: 123 } })(fakeProxies(), "ClashMeta", {}),
            ).toThrow(/name/);
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
