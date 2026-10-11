#!/usr/bin/env node
/**
 * 产物冒烟测试 —— 本仓库对「构建产物真的能被 Sub-Store 执行」这件事的唯一证据。
 *
 * 单元测试测的是可复用的纯函数；这里测的是 `dist/*.js` 的**文本**，用与 Sub-Store
 * 相同的 `new Function` 环境求值后调用。四组断言：
 *
 *   A. 形状：产物不是空壳，且必须出现的顶层函数声明确实存在
 *   B. 隔离：不以 `(` 开头（那说明被包成了 IIFE，函数会被关进闭包）
 *   C. 契约：能被求值，且 `return operator` 取到的是函数
 *   D. 行为：用假节点数组调用，返回形状正确
 *
 * 用法：pnpm build && pnpm smoke
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { loadOperator } from './substore-sandbox.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 每个交付包一条：产物路径 + 必须出现的顶层声明 + 冒烟调用方式。 */
const TARGETS = [
  {
    package: '@substore/clean',
    file: 'packages/substore-clean/dist/substore-clean.js',
    requiredDeclarations: ['function operator'],
    invoke: (operator) => {
      const proxies = [
        { name: 'a', type: 'ss', server: 'a.example.com', port: 443 },
        { name: 'b', type: 'vmess', server: 'b.example.com', port: 443 },
      ];
      return { label: 'operator(proxies) 返回数组', value: operator(proxies, 'ClashMeta', {}) };
    },
  },
  {
    package: '@substore/rules',
    file: 'packages/substore-rules/dist/substore-rules.js',
    requiredDeclarations: ['function main', 'function operator'],
    invoke: (operator) => {
      const proxies = [
        { name: 'a', type: 'ss', server: 'a.example.com', port: 443 },
        { name: 'b', type: 'vmess', server: 'b.example.com', port: 443 },
      ];
      return { label: 'operator(proxies) 返回数组', value: operator(proxies, 'ClashMeta', {}) };
    },
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

function runTarget(target) {
  const errors = [];
  const absolute = path.join(REPO_ROOT, target.file);

  let script;
  try {
    script = readFileSync(absolute, 'utf8');
  } catch (error) {
    return [`读不到产物 ${target.file}：${error.message}\n  先运行 pnpm build`];
  }

  if (script.trim() === '') {
    return [`产物 ${target.file} 是空文件`];
  }

  // A + B：形状
  assertShape(script, target, errors);

  // C：契约层
  let operator;
  try {
    operator = loadOperator(script);
  } catch (error) {
    errors.push(error.message);
    return errors;
  }

  // D：行为层
  try {
    const { label, value } = target.invoke(operator);
    assertProxyArray(label, value, errors);
  } catch (error) {
    errors.push(`调用 operator 抛错：${error.message}`);
  }

  return errors;
}

function main() {
  let failed = 0;

  for (const target of TARGETS) {
    const errors = runTarget(target);

    if (errors.length === 0) {
      console.log(`✓ ${target.package} (${target.file})`);
      continue;
    }

    failed += 1;
    console.error(`\n✗ ${target.package} (${target.file})`);
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

main();
