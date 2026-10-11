import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const entryPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const source = readFileSync(entryPath, 'utf8');

/**
 * 框架阶段的测试，分两部分：
 *
 *   1. 几条纯函数断言 —— 证明 vitest 已经接通、断言与 DOM 无关的普通逻辑可用。
 *   2. 入口契约断言 —— 直接读 `src/index.ts` 的**文本**。
 *      为什么不用 `import`：入口是刻意不导出的（见该文件顶部注释），import 进来只会
 *      得到 undefined，测不到任何东西。而下面这几条约束必须在**源码层**就守住 ——
 *      一旦有人加了 export 或删掉 marker，产物形状就会坏掉，而那种回归只有
 *      `pnpm smoke` 在构建之后才会发现；这里让它在更早、更便宜的一层先响。
 *
 * 产物在 Sub-Store 环境里能否真正执行，由 `pnpm smoke` 用复刻的 new Function 环境把关。
 */
const passThrough = async (value: unknown) => value;

describe('vitest 已接通', () => {
  it('可以运行普通断言', () => {
    expect([1, 2, 3].filter((n) => n > 1)).toEqual([2, 3]);
  });

  it('可以断言异步函数', async () => {
    await expect(passThrough('ok')).resolves.toBe('ok');
  });
});

describe('入口文件契约（源码层）', () => {
  it('声明了顶层 function main（mihomo 配置文件路径的入口）', () => {
    expect(source).toMatch(/^async function main\s*\(/m);
  });

  it('声明了顶层 function operator（节点数组路径的兜底入口）', () => {
    expect(source).toMatch(/^function operator\s*\(/m);
  });

  it('没有任何 export —— 否则产物会输出 export 语句，两条执行路径都会失效', () => {
    expect(source).not.toMatch(/^\s*export\s/m);
  });

  it('只从 @substore/internal 取值导入，不自己 import zod', () => {
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);

    expect(imports).toEqual(['@substore/internal']);
  });

  it('声明了运行时注入的 $arguments（否则 tsc 不认这个自由变量）', () => {
    expect(source).toMatch(/^declare const \$arguments:/m);
  });

  it('末尾保留了保住两个顶层函数声明的 marker 赋值', () => {
    expect(source).toMatch(
      /^\(globalThis as Record<string, unknown>\)\.__substoreRulesEntry = \{ main, operator \};$/m,
    );
  });

  it('marker 在 main 与 operator 之后（顺序反了就保不住声明）', () => {
    const markerIndex = source.indexOf('.__substoreRulesEntry');

    expect(markerIndex).toBeGreaterThan(source.indexOf('function main'));
    expect(markerIndex).toBeGreaterThan(source.indexOf('function operator'));
  });
});
