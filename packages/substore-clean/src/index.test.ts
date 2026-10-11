import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const entryPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const source = readFileSync(entryPath, 'utf8');

/**
 * 入口源码的文本契约。
 *
 * 为什么读**文本**而不是 `import`：入口是刻意不导出的（见该文件顶部注释），
 * import 进来只会得到 undefined，测不到任何东西。而下面这几条约束必须在
 * **源码层**就守住 —— 一旦有人加了 export 或删掉 marker，产物形状就会坏掉，
 * 而那种回归只有 `pnpm smoke` 会在构建之后发现；这里让它在更早、更便宜的一层先响。
 *
 * 产物在 Sub-Store 环境里能否真正执行，仍由 `pnpm smoke` 用复刻的 new Function 环境把关。
 */
describe('入口文件契约（源码层）', () => {
  it('声明了顶层 function operator', () => {
    expect(source).toMatch(/^function operator\s*\(/m);
  });

  it('没有任何 export —— 否则产物会输出 export 语句，new Function 直接语法错误', () => {
    expect(source).not.toMatch(/^\s*export\s/m);
  });

  it('只从 @substore/internal 取值导入，不自己 import zod', () => {
    const imports = [...source.matchAll(/^\s*import\s[^;]*?from\s+'([^']+)'/gm)].map((m) => m[1]);

    expect(imports).toEqual(['@substore/internal']);
  });

  it('声明了运行时注入的 $arguments（否则 tsc 不认这个自由变量）', () => {
    expect(source).toMatch(/^declare const \$arguments:/m);
  });

  it('末尾保留了保住顶层函数声明的 marker 赋值', () => {
    expect(source).toMatch(
      /^\(globalThis as Record<string, unknown>\)\.__substoreCleanEntry = \{ operator \};$/m,
    );
  });

  it('marker 是文件里最后一条语句（它必须在函数声明之后）', () => {
    const markerIndex = source.indexOf('.__substoreCleanEntry');
    const operatorIndex = source.indexOf('function operator');

    expect(operatorIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBeGreaterThan(operatorIndex);
  });
});
