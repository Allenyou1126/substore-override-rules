#!/usr/bin/env node
/**
 * 产物冒烟测试 —— 本仓库对「构建产物真的能被 Sub-Store 执行」这件事的唯一证据。
 *
 * 单元测试测的是可复用的纯函数；这里测的是 `dist/*.js` 的**文本**，用与 Sub-Store
 * 相同的 `new Function` 环境求值后调用。五组断言：
 *
 *   A. 形状：产物不是空壳，且必须出现的顶层函数声明确实存在
 *   B. 隔离：不以 `(` 开头（那说明被包成了 IIFE，函数会被关进闭包）
 *   C. 契约：能被求值，且 `return operator` 取到的是函数
 *   D. 行为：用假节点数组调用，返回形状正确
 *   E. 参数：把 `$arguments` 注入求值环境，验证参数真的被解析并生效
 *
 * E 存在的原因：`parseScriptParams` 那条路径只有在**产物里**跑一次才算数 ——
 * 源码层的单测覆盖不到「zod 被正确内联进产物」这件事，而 treeshake 打开后
 * 任何一处引用丢了都会让参数静默失效。所以每个产物都跑一遍
 * 「不传参数 → 默认行为」与「传参数 → 行为改变」。
 *
 * 顺带打印每个产物的字节数与 gzip 体积：这是唯一能反映「依赖有没有被意外全量内联」
 * 的地方（历史上 treeshake 关掉过，zod 会一次性塞进 613 kB）。
 *
 * 用法：pnpm build && pnpm smoke
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { loadEntries } from './substore-sandbox.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 冒烟用的假节点数组。 */
function fakeProxies() {
  return [
    { name: 'a', type: 'ss', server: 'a.example.com', port: 443 },
    { name: 'b', type: 'vmess', server: 'b.example.com', port: 443 },
  ];
}

/**
 * 每个交付包一条：产物路径 + 必须出现的顶层声明 + 用例列表。
 *
 * 用例里的 `run(entry)` 收到的是**在复刻环境里求值出来的入口集合**
 * （`{ operator, main }`，取不到的项为 undefined），`arguments` 是注入的 `$arguments`。
 * `expect` 严格比较返回值；`expectThrow` 是正则，要求抛错且消息匹配。
 */
const TARGETS = [
  {
    package: '@substore/clean',
    file: 'packages/substore-clean/dist/substore-clean.js',
    requiredDeclarations: ['function operator'],
    cases: [
      {
        label: 'operator(proxies) 返回数组',
        arguments: undefined,
        run: ({ operator }) => operator(fakeProxies(), 'ClashMeta', {}),
        expect: 'array',
      },
      {
        label: '默认参数下不改变节点（透传）',
        arguments: undefined,
        run: ({ operator }) => operator(fakeProxies(), 'ClashMeta', {}).length,
        expect: 2,
      },
      {
        label: '$arguments={enabled:false} 时返回空数组',
        arguments: { enabled: false },
        run: ({ operator }) => operator(fakeProxies(), 'ClashMeta', {}).length,
        expect: 0,
      },
      {
        label: '链接形式 $arguments="enabled=false" 同样生效',
        arguments: 'enabled=false',
        run: ({ operator }) => operator(fakeProxies(), 'ClashMeta', {}).length,
        expect: 0,
      },
      {
        label: 'JSON 字符串形式 $arguments 同样生效',
        arguments: '{"enabled":false}',
        run: ({ operator }) => operator(fakeProxies(), 'ClashMeta', {}).length,
        expect: 0,
      },
      {
        label: '参数非法时抛错且消息里带字段名',
        arguments: { enabled: 'maybe' },
        run: ({ operator }) => operator(fakeProxies(), 'ClashMeta', {}),
        expectThrow: /enabled/,
      },
    ],
  },
  {
    package: '@substore/rules',
    file: 'packages/substore-rules/dist/substore-rules.js',
    requiredDeclarations: ['function main', 'function operator'],
    cases: [
      {
        label: 'operator(proxies) 返回数组',
        arguments: undefined,
        run: ({ operator }) => operator(fakeProxies(), 'ClashMeta', {}),
        expect: 'array',
      },
      {
        label: 'main(config) 原样返回配置（mihomo 配置路径）',
        arguments: undefined,
        run: ({ main: mainEntry }) =>
          mainEntry({ rules: ['MATCH,DIRECT'], 'rule-providers': {} }).then(
            (config) => config.rules[0],
          ),
        expect: 'MATCH,DIRECT',
      },
      {
        label: '$arguments={enabled:false} 时 operator 不改变节点',
        arguments: { enabled: false },
        run: ({ operator }) => operator(fakeProxies(), 'ClashMeta', {}).length,
        expect: 2,
      },
      {
        label: '参数非法时抛错且消息里带字段名（operator 路径）',
        arguments: { enabled: 'maybe' },
        run: ({ operator }) => operator(fakeProxies(), 'ClashMeta', {}),
        expectThrow: /enabled/,
      },
    ],
  },
];

/**
 * 检测会破坏契约的产物形状。
 *
 * 只认出现在行首（允许前导空白）的关键字，避免把注释或字符串里的 "import" 误判。
 */
function assertShape(script, target, errors) {
  const banned = [
    { re: /^\s*import\s/m, name: 'import 声明' },
    { re: /^\s*export\s/m, name: 'export 声明' },
    { re: /^\s*import\s*\(/m, name: 'import() 动态导入' },
    { re: /\brequire\s*\(/, name: 'require() 调用' },
  ];

  for (const { re, name } of banned) {
    const match = re.exec(script);
    if (match) {
      const line = script.slice(0, match.index).split('\n').length;
      errors.push(
        `产物里出现 ${name}（第 ${line} 行）。\n` +
          '  入口文件不能有 export/import —— 会让 rolldown 把函数包进闭包。',
      );
    }
  }

  // 被包成 IIFE 是实测过的失败形态：函数被关进闭包，外层 return operator 取不到
  if (/^\s*\(/.test(script)) {
    errors.push(
      '产物以 `(` 开头，说明被包成了 IIFE 包裹表达式。\n' +
        '  `operator` 会被关进那个闭包，Sub-Store 的 `return operator` 将抛 operator is not defined。\n' +
        "  检查 tsdown.config.ts 的 format：应当用 'es' 而不是 'iife'。",
    );
  }

  for (const declaration of target.requiredDeclarations) {
    // 声明前允许 `async `，因为 mihomo 配置入口必须是异步的
    if (!new RegExp(`^\\s*(?:async\\s+)?${declaration}\\b`, 'm').test(script)) {
      errors.push(
        `产物里找不到顶层声明 \`${declaration}\`。\n` +
          '  常见原因：入口文件有 export 导致被包成闭包，或 treeshake 打开后把函数当死代码删掉。',
      );
    }
  }
}

function assertProxyArray(label, value, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${label}：期望数组，实际 ${Object.prototype.toString.call(value)}`);
    return;
  }

  if (value.length !== 2) {
    errors.push(`${label}：期望长度 2，实际 ${value.length}`);
  }
}

/**
 * 跑一条用例并把结果与期望比对。
 *
 * 返回值会被 `await`，所以 `main`（异步入口）也能直接写进用例。
 * 期望有两种写法：`expect`（严格相等，或字符串 `'array'` 表示「长度为 2 的数组」）、
 * `expectThrow`（正则，要求抛错且消息匹配）。
 */
async function runCase(entry, testCase, errors) {
  if (testCase.expectThrow instanceof RegExp) {
    let thrown;

    try {
      await testCase.run(entry);
    } catch (error) {
      thrown = error;
    }

    if (!thrown) {
      errors.push(`${testCase.label}：期望抛错，实际正常返回。`);
      return;
    }

    const message = thrown instanceof Error ? thrown.message : JSON.stringify(thrown);

    if (!testCase.expectThrow.test(message)) {
      errors.push(
        `${testCase.label}：抛错消息不匹配 ${testCase.expectThrow}。\n  实际消息：${message}`,
      );
    }

    return;
  }

  let value;

  try {
    value = await testCase.run(entry);
  } catch (error) {
    errors.push(`${testCase.label}：调用抛错 ${error.message}`);
    return;
  }

  if (testCase.expect === 'array') {
    assertProxyArray(testCase.label, value, errors);
    return;
  }

  if (value !== testCase.expect) {
    errors.push(
      `${testCase.label}：期望 ${JSON.stringify(testCase.expect)}，实际 ${JSON.stringify(value)}`,
    );
  }
}

async function runTarget(target) {
  const errors = [];
  const absolute = path.join(REPO_ROOT, target.file);

  let script;
  try {
    script = readFileSync(absolute, 'utf8');
  } catch (error) {
    return { errors: [`读不到产物 ${target.file}：${error.message}\n  先运行 pnpm build`] };
  }

  if (script.trim() === '') {
    return { errors: [`产物 ${target.file} 是空文件`] };
  }

  // A + B：形状
  assertShape(script, target, errors);

  const size = {
    raw: Buffer.byteLength(script, 'utf8'),
    gzip: gzipSync(script).byteLength,
  };

  // C：契约层
  let entries;
  try {
    entries = loadEntries(script);
  } catch (error) {
    errors.push(error.message);
    return { errors, size };
  }

  if (target.requiredDeclarations.includes('function main') && typeof entries.main !== 'function') {
    errors.push(
      '入口里取不到 `main`（mihomo 配置路径靠 `typeof main === "function"` 找入口）。\n' +
        '  检查入口是否仍是顶层函数，以及末尾那条 marker 是否同时引用了 main。',
    );
  }

  // D + E：行为层与参数层。每条用例都用自己那份 $arguments 重新求值一次
  //（与 Sub-Store 每次处理都重新 new Function 的行为一致）。
  for (const testCase of target.cases) {
    const scoped = loadEntries(script, { $arguments: testCase.arguments });
    await runCase(scoped, testCase, errors);
  }

  return { errors, size };
}

async function main() {
  let failed = 0;

  for (const target of TARGETS) {
    const { errors, size } = await runTarget(target);
    const sizeLabel = size ? `${size.raw} B（gzip ${size.gzip} B）` : '体积未知';

    if (errors.length === 0) {
      console.log(`✓ ${target.package} (${target.file}, ${sizeLabel})`);
      continue;
    }

    failed += 1;
    console.error(`\n✗ ${target.package} (${target.file}, ${sizeLabel})`);
    for (const error of errors) {
      console.error(`  ${error.replaceAll('\n', '\n  ')}`);
    }
  }

  if (failed > 0) {
    console.error(
      `\n冒烟未通过：${failed}/${TARGETS.length} 个产物不合格。\n` +
        '产物契约说明见 packages/internal/src/substore.ts 顶部注释。',
    );
    process.exit(1);
  }

  console.log(`\n冒烟通过：${TARGETS.length} 个产物均可被 Sub-Store 执行。`);
}

await main();
