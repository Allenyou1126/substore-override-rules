#!/usr/bin/env node
/**
 * 语义化提交与 Assisted-By 尾注校验器。
 *
 * 本地钩子（.githooks/commit-msg）与 CI（.github/workflows/verify.yml）**共用这一个脚本**，
 * 保证两处判定完全一致 —— 否则会出现「本地能过、CI 拦下」或反过来的扯皮。
 *
 * 用法：
 *   node tools/check-commit-msg.mjs --message-file .git/COMMIT_EDITMSG
 *   node tools/check-commit-msg.mjs --range origin/prod..HEAD
 *   node tools/check-commit-msg.mjs --range <sha>..<sha>
 *
 * 规范正文见 docs/standards/development.md。
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

/** Conventional Commits 允许的类型白名单。 */
const ALLOWED_TYPES = new Set([
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
]);

const SCOPE_HINT = 'clean | rules | internal | repo | ci | release | oss';

/** 形如 `feat(scope)!: description` / `fix: description`。 */
const SUBJECT_RE = /^([a-z]+)(?:\(([^()]*)\))?(!)?: (.+)$/;

/** trailer 行：`Token: value`。token 允许字母、数字、连字符。 */
const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]+(.*)$/;

/** 冒号前有内容但不是合法 trailer token 的行（例如 `foo bar: baz`）。 */
const LOOSE_TRAILER_RE = /^([^:]+):[ \t]+(.*)$/;

/** 校验器要拒绝的占位值：写这些等于没写。 */
const PLACEHOLDER_RE = /^(<.*>|\[.*\]|xxx+|tbd|todo|n\/a|unknown|待填|未知)$/i;

/** Assisted-By 的值必须同时给出 Agent 名称与括号内的模型 ID。 */
const ASSISTED_BY_RE = /^(.+?) \(([^()]+)\)$/;

/** 这些提交不按本规范校验，直接放行。 */
const SKIP_SUBJECT_RE = /^(Merge |Revert "|fixup! |squash! |amend! )/;

const FIELD_SEPARATOR = '\u001f';
const RECORD_SEPARATOR = '\u001e';

function printUsage() {
  console.log(
    [
      '用法:',
      '  node tools/check-commit-msg.mjs --message-file <path>',
      '  node tools/check-commit-msg.mjs --range <from>..<to>',
      '  node tools/check-commit-msg.mjs --head',
    ].join('\n'),
  );
}

/**
 * 解析命令行参数。
 *
 * 显式写 JSDoc 类型有两个作用：让 `options.messageFile` 这类字段保持 `string | undefined`
 * 而不是被推断成 `never`（type-aware 规则会拒绝把 never 放进模板字符串），
 * 也顺便给编辑器提示。
 *
 * @param {string[]} argv
 * @returns {{ messageFile: string | undefined, range: string | undefined, head: boolean }}
 */
function parseArgs(argv) {
  const options = { messageFile: undefined, range: undefined, head: false };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === '--message-file') {
      options.messageFile = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--message-file=')) {
      options.messageFile = arg.slice('--message-file='.length);
    } else if (arg === '--range') {
      options.range = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--range=')) {
      options.range = arg.slice('--range='.length);
    } else if (arg === '--head') {
      // 只校验 HEAD 这一条提交（仓库首次推送、范围不可用时的兜底）
      options.head = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`未知参数: ${arg}`);
    }
  }

  return options;
}

/**
 * 把提交信息拆成「标题 / 正文 / trailer 块」。
 *
 * git 会把 `#` 开头的行当注释（未用 -m 时），必须剥掉，否则把
 * `# 请输入提交信息` 当正文校验会误报。
 */
function parseMessage(raw) {
  const lines = raw
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .map((line) => line.trimEnd());

  // 去掉末尾空行，便于定位最后一段
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }

  const subject = (lines.shift() ?? '').trim();

  // 标题后的第一个空行是分隔符
  if (lines.length > 0 && lines[0] === '') {
    lines.shift();
  }

  // 从后往前找连续的非空行，作为 trailer 块
  let trailerStart = lines.length;
  while (trailerStart > 0 && lines[trailerStart - 1] !== '') {
    trailerStart -= 1;
  }

  const trailerLines = lines.slice(trailerStart);
  const bodyLines = lines.slice(0, trailerStart);

  while (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') {
    bodyLines.pop();
  }

  return { subject, body: bodyLines.join('\n'), message: raw, trailerLines };
}

/** 从 trailer 块解析出 `{ token: [values] }`，同时拒绝格式可疑的行。 */
function parseTrailers(trailerLines) {
  const trailers = new Map();
  const errors = [];

  for (const line of trailerLines) {
    if (line === '') {
      continue;
    }

    const match = TRAILER_RE.exec(line);

    if (match) {
      const token = match[1];
      const value = match[2].trim();
      const key = token.toLowerCase();
      const values = trailers.get(key) ?? [];
      values.push(value);
      trailers.set(key, values);
      continue;
    }

    // `Assisted-By Foo (x)` 这类漏了冒号的写法，给出针对性提示
    if (/^assisted[- ]?by\b/i.test(line)) {
      errors.push(`尾注缺少冒号：\`${line}\``);
      continue;
    }

    const loose = LOOSE_TRAILER_RE.exec(line);
    if (loose) {
      errors.push(`尾注 token 不合法（只允许字母、数字、连字符）：\`${line}\``);
      continue;
    }

    errors.push(`尾注块里有无法解析的行：\`${line}\``);
  }

  return { trailers, errors };
}

/**
 * 校验一条提交信息。返回错误字符串数组，空数组表示通过。
 */
export function validateMessage(raw) {
  const errors = [];
  const { subject, trailerLines } = parseMessage(raw);

  if (subject === '') {
    return ['提交信息为空'];
  }

  if (SKIP_SUBJECT_RE.test(subject)) {
    return [];
  }

  const subjectMatch = SUBJECT_RE.exec(subject);

  if (!subjectMatch) {
    errors.push(
      [
        '标题不符合 Conventional Commits 格式。',
        `  实际：${subject}`,
        '  期望：<type>(<scope>): <description>   —— scope 可省略',
        `  type 白名单：${[...ALLOWED_TYPES].join(', ')}`,
        `  示例：feat(clean): 支持按关键字过滤节点名`,
        `        fix: 修正规则集地址`,
      ].join('\n'),
    );
  } else {
    const [, type, scope, bang, description] = subjectMatch;

    if (!ALLOWED_TYPES.has(type)) {
      errors.push(
        `标题类型 \`${type}\` 不在白名单内：${[...ALLOWED_TYPES].join(', ')}\n  示例：chore(${SCOPE_HINT.split(' | ')[0]}): ...`,
      );
    }

    if (scope !== undefined) {
      if (scope === '') {
        errors.push('标题里的 scope 是空括号。要么删掉括号，要么填上包名/领域。');
      } else if (/\s/.test(scope)) {
        errors.push(`标题里的 scope 不应含空格：\`${scope}\`。推荐值：${SCOPE_HINT}`);
      }
    }

    if (description !== undefined) {
      if (description === '') {
        errors.push('标题缺少描述内容。');
      } else {
        if (/[。.]$/.test(description)) {
          errors.push('标题的描述不要以句号结尾。');
        }
        if (description.length > 72) {
          errors.push(
            `标题描述过长（${description.length} 字符，上限 72）：${description}\n  把细节移到正文里。`,
          );
        }
      }

      void bang; // `!` 存在即表示破坏性变更，无需额外判定
    }

    const scaled = subject.length;
    if (scaled > 100) {
      errors.push(`标题总长 ${scaled} 字符，超过 100 字符上限（含 type(scope): 前缀）。`);
    }
  }

  const { trailers, errors: trailerErrors } = parseTrailers(trailerLines);
  errors.push(...trailerErrors);

  // Assisted-By：出现多次时逐个校验
  const assistedByValues = trailers.get('assisted-by') ?? [];

  if (assistedByValues.length === 0) {
    // 未声明 AI 辅助 —— 规范不强制，但给出提示帮助作者自查
    console.log(
      '提示：未发现 Assisted-By 尾注。若本次提交有 AI Agent 参与，请补上：\n' +
        '  Assisted-By: <Agent 名称> (<模型 ID>)\n' +
        '  例如：Assisted-By: DeepSeek Harness (deepseek-flash)',
    );
  }

  for (const value of assistedByValues) {
    const match = ASSISTED_BY_RE.exec(value);

    if (!match) {
      errors.push(
        [
          'Assisted-By 尾注格式不对。',
          `  实际：Assisted-By: ${value}`,
          '  期望：Assisted-By: <Agent 名称> (<模型 ID>)',
          '  示例：Assisted-By: DeepSeek Harness (deepseek-flash)',
          '  注意：括号是格式的一部分，必须同时给出 Agent 名称与模型 ID。',
        ].join('\n'),
      );
      continue;
    }

    const [, agentName, modelId] = match;

    if (PLACEHOLDER_RE.test(agentName.trim()) || PLACEHOLDER_RE.test(modelId.trim())) {
      errors.push(`Assisted-By 里出现占位值（\`${value}\`）。请填写真实的 Agent 名称与模型 ID。`);
    }

    if (agentName.trim() === '' || modelId.trim() === '') {
      errors.push('Assisted-By 的 Agent 名称与模型 ID 都不能为空。');
    }
  }

  return errors;
}

/**
 * 跑一条 git 命令，失败时返回 undefined 而不是抛错。
 *
 * 用于「读不到就降级处理」的场景（例如仓库还没有提交、提交不在本地历史里）。
 * stderr 必须吞掉：否则 git 的英文报错会混进我们自己的诊断信息里，看起来很吵。
 */
function tryGit(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return undefined;
  }
}

function listCommitsInRange(range) {
  const output = execFileSync(
    'git',
    ['log', `--pretty=format:%H${FIELD_SEPARATOR}%B${RECORD_SEPARATOR}`, range],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );

  return output
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter((record) => record !== '')
    .map((record) => {
      const index = record.indexOf(FIELD_SEPARATOR);
      const hash = record.slice(0, index).trim();
      const message = record
        .slice(index + 1)
        .replaceAll(FIELD_SEPARATOR, '')
        .trimEnd();
      return { hash, message };
    });
}

function describeCommit(hash) {
  try {
    const subject = execFileSync('git', ['log', '-1', '--pretty=format:%s', hash], {
      encoding: 'utf8',
    }).trim();
    return `${hash.slice(0, 12)} ${subject}`;
  } catch {
    return hash.slice(0, 12);
  }
}

function main() {
  let options;

  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(`错误：${error.message}`);
    printUsage();
    process.exit(1);
  }

  const exclusive = [options.messageFile, options.range, options.head && 'head'].filter(
    (value) => value !== undefined && value !== false && value !== '',
  );

  if (exclusive.length !== 1) {
    console.error('错误：需要且只能指定 --message-file、--range、--head 三者之一。');
    printUsage();
    process.exit(1);
  }

  /** @type {Array<{ label: string, message: string }>} */
  let targets;

  if (options.messageFile) {
    let raw;
    try {
      raw = readFileSync(options.messageFile, 'utf8');
    } catch (error) {
      console.error(`错误：读不到提交信息文件 ${options.messageFile}：${error.message}`);
      process.exit(1);
    }
    targets = [{ label: '当前提交', message: raw }];
  } else if (options.head) {
    const hash = tryGit(['rev-parse', 'HEAD']);

    if (!hash) {
      console.error('错误：读不到 HEAD 提交（仓库可能还没有提交）。');
      process.exit(1);
    }

    const message = tryGit(['log', '-1', '--pretty=format:%B', hash]);

    if (message === undefined) {
      console.error(`错误：读不到 ${hash.slice(0, 12)} 的提交信息。`);
      process.exit(1);
    }

    targets = [{ label: describeCommit(hash), message }];
  } else {
    if (options.range === undefined || options.range === '') {
      console.error('错误：--range 需要一个 `<from>..<to>` 形式的值。');
      printUsage();
      process.exit(1);
    }

    let commits;
    try {
      commits = listCommitsInRange(options.range);
    } catch (error) {
      // 范围读不出来 ≠ 提交不合规。典型情形是强制推送：`before` 指向的提交已经不在
      // 新历史里，`git log before..after` 直接报错。把它当作违规会让强制推送永远无法
      // 通过检查，而正确的结论应该是「这次没法判定」。
      console.error(
        `⚠ 无法读取提交范围 ${options.range}：${error.message.split('\n')[0]}\n` +
          '  常见原因：强制推送导致 before 指向的提交已不在历史里。\n' +
          '  处置：本次跳过范围校验。提交规范仍由目标分支上的 PR 检查把关。',
      );
      process.exit(0);
    }

    if (commits.length === 0) {
      console.log(`范围 ${options.range} 内没有提交，跳过校验。`);
      process.exit(0);
    }

    targets = commits.map((commit) => ({
      label: describeCommit(commit.hash),
      message: commit.message,
    }));
  }

  let failed = 0;
  let skipped = 0;

  for (const target of targets) {
    const subject = parseMessage(target.message).subject;

    if (SKIP_SUBJECT_RE.test(subject)) {
      console.log(`跳过（合入/自动提交）：${target.label}`);
      skipped += 1;
      continue;
    }

    const errors = validateMessage(target.message);

    if (errors.length > 0) {
      failed += 1;
      console.error(`\n✗ ${target.label}`);
      for (const error of errors) {
        console.error(`  ${error.replaceAll('\n', '\n  ')}`);
      }
    } else {
      console.log(`✓ ${target.label}`);
    }
  }

  if (failed > 0) {
    console.error(
      `\n校验未通过：${failed} 条提交不合规（跳过 ${skipped} 条）。\n` +
        '规范正文：docs/standards/development.md',
    );
    process.exit(1);
  }

  console.log(`\n提交信息校验通过（${targets.length} 条，跳过 ${skipped} 条）。`);
}

// 被当作脚本直接运行时才执行 main，便于测试导入 validateMessage
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
