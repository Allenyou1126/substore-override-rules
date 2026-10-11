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
 *      得到 undefined，测不到任何东西。而「入口不能有 export」这条约束必须在
 *      **源码层**就守住 —— 一旦有人加了 export，构建产物的形状就会坏掉。
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

  it('没有任何 export —— 否则构建产物会被包成 IIFE，Sub-Store 取不到入口', () => {
    expect(source).not.toMatch(/^\s*export\s/m);
  });

  it('没有任何 import —— 产物必须是自包含的单文件', () => {
    expect(source).not.toMatch(/^\s*import\s/m);
  });
});
