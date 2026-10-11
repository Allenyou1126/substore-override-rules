#!/usr/bin/env node
/**
 * 「prod 只接受来自 dev 的合入」守卫。
 *
 * 为什么需要它：GitHub 的 branch protection **无法**限定 pull request 的 head 分支
 * —— 它能要求「必须开 PR」和「检查必须通过」，但任何分支都能开 PR 进 prod。
 * 所以这条规则必须由 CI 自己守，不能只靠服务端设置。
 *
 * 用法（由 .github/workflows/guard-prod-source.yml 调用）：
 *   node tools/check-prod-source.mjs --event pull_request --head-ref <ref> --base-ref <ref>
 *   node tools/check-prod-source.mjs --event push --sha <after-sha>
 *
 * 判定：
 *   - pull_request 且 base=prod：head 必须是 `dev`
 *   - push 到 prod：被推送的提交必须是把 `dev` 合入 `prod` 的合入提交
 *   - 拿不到证据时**软失败**（退出码 2）：打印诊断，由工作流决定是否放行。
 *     首次建立 prod 时还没有任何合入历史，硬失败会把正常流程卡死。
 */

import { execFileSync } from 'node:child_process';
import process from 'node:process';

const PROTECTED_BRANCH = 'prod';
const SOURCE_BRANCH = 'dev';

const EXIT_OK = 0;
const EXIT_VIOLATION = 1;
const EXIT_INCONCLUSIVE = 2;

function tryGit(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8' }).trim();
  } catch {
    return undefined;
  }
}

/**
 * 解析命令行参数。
 *
 * 显式 JSDoc 类型避免字段被推断成 `never`，同时给编辑器提示。
 *
 * @param {string[]} argv
 * @returns {{
 *   event: string | undefined,
 *   headRef: string | undefined,
 *   baseRef: string | undefined,
 *   sha: string | undefined,
 *   pushedRef: string | undefined,
 * }}
 */
function parseArgs(argv) {
  const options = {
    event: undefined,
    headRef: undefined,
    baseRef: undefined,
    sha: undefined,
    pushedRef: undefined,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      return argv[i];
    };

    if (arg === '--event') options.event = next();
    else if (arg.startsWith('--event=')) options.event = arg.slice('--event='.length);
    else if (arg === '--head-ref') options.headRef = next();
    else if (arg.startsWith('--head-ref=')) options.headRef = arg.slice('--head-ref='.length);
    else if (arg === '--base-ref') options.baseRef = next();
    else if (arg.startsWith('--base-ref=')) options.baseRef = arg.slice('--base-ref='.length);
    else if (arg === '--sha') options.sha = next();
    else if (arg.startsWith('--sha=')) options.sha = arg.slice('--sha='.length);
    else if (arg === '--pushed-ref') options.pushedRef = next();
    else if (arg.startsWith('--pushed-ref=')) options.pushedRef = arg.slice('--pushed-ref='.length);
    else {
      console.error(`未知参数: ${arg}`);
      process.exit(EXIT_VIOLATION);
    }
  }

  return options;
}

function inconclusive(reason, detail = []) {
  console.error(`\n⚠ 无法确认合入来源：${reason}`);
  for (const line of detail) {
    console.error(`  ${line}`);
  }
  console.error(
    [
      '',
      '这不一定代表违规。常见原因是首次建立 prod、或本地缺少合入提交的历史。',
      '请人工确认以下几点：',
      `  1. prod 上的这次变更确实来自 ${SOURCE_BRANCH}（不是直接从本地或其它分支推进去）；`,
      `  2. 若确实是首次建立 ${PROTECTED_BRANCH}，本检查会在下一次合入时正常生效。`,
      '',
      '手动核对合入来源：',
      '  gh api repos/{owner}/{repo}/commits/<sha> --jq ".parents[].sha"',
      '  gh api repos/{owner}/{repo}/commits/<sha> --jq ".commit.message"',
    ].join('\n'),
  );
  process.exit(EXIT_INCONCLUSIVE);
}

function violation(reason, detail = []) {
  console.error(`\n✗ 违反分支规则：${reason}`);
  for (const line of detail) {
    console.error(`  ${line}`);
  }
  console.error(
    [
      '',
      `规则：${PROTECTED_BRANCH} 只允许从 ${SOURCE_BRANCH} 合入，禁止直接把改动推进 ${PROTECTED_BRANCH}。`,
      `正确流程：改动先进 ${SOURCE_BRANCH} → 开 PR：${SOURCE_BRANCH} → ${PROTECTED_BRANCH} → 合入。`,
      '规范正文：docs/standards/development.md',
    ].join('\n'),
  );
  process.exit(EXIT_VIOLATION);
}

function ok(message) {
  console.log(`✓ ${message}`);
  process.exit(EXIT_OK);
}

function checkPullRequest(options) {
  if (options.baseRef !== PROTECTED_BRANCH) {
    ok(`base 不是 ${PROTECTED_BRANCH}（实际 ${options.baseRef ?? '未知'}），不适用本守卫。`);
  }

  if (options.headRef === SOURCE_BRANCH) {
    ok(`PR 从 ${SOURCE_BRANCH} 合入 ${PROTECTED_BRANCH}，符合规则。`);
  }

  violation(`PR 的源分支是 \`${options.headRef ?? '未知'}\`，不是 \`${SOURCE_BRANCH}\`。`, [
    `base 分支：${options.baseRef}`,
    `head 分支：${options.headRef ?? '未知'}`,
  ]);
}

function checkPush(options) {
  const sha = options.sha;

  // 全零 SHA 表示「引用被删除」或首次推送，此时没有可判定的提交
  if (!sha || sha.startsWith('0'.repeat(40))) {
    inconclusive('推送事件没有可用的提交 SHA（引用被删除或首次推送）。');
  }

  const revList = tryGit(['rev-list', '--parents', '-n', '1', sha]);

  if (revList === undefined) {
    // 提交不存在（例如本地只有浅历史）。这属于证据不足，不是违规。
    inconclusive(
      `读不到提交 ${sha.slice(0, 12)} 的父提交（可能是浅克隆，或该提交不在本地历史里）。`,
      [
        `推送的分支：${options.pushedRef || '未知'}`,
        '工作流应使用 fetch-depth: 0 检出，以便读取合入提交的父提交。',
      ],
    );
  }

  const parents = revList.split(/\s+/).filter((token) => token !== '');

  if (parents.length < 2) {
    // 引导例外：仓库建立后第一次推 prod 时，推的是一个根提交，天然没有父提交。
    // 这不是「绕过规则」，而是规则生效前的初始状态 —— prod 的内容与 dev 完全相同，
    // 且此时还没有任何「非 dev 来源」的历史。硬失败会让引导流程永远无法完成，
    // 因此按证据不足处理（软失败 + 诊断），而不是判违规。
    if (parents.length === 1 && tryGit(['rev-list', '--count', sha]) === '1') {
      inconclusive(
        `被推送的提交是仓库的根提交（${sha.slice(0, 12)}），这是引导 prod 的初始推送，没有合入可判定。`,
        [
          `提交：${sha.slice(0, 12)} ${tryGit(['log', '-1', '--pretty=format:%s', sha]) ?? ''}`,
          `${PROTECTED_BRANCH} 尚未有过合入历史，因此「只允许从 ${SOURCE_BRANCH} 合入」还没有判定依据。`,
          '从下一次变更起，本守卫会正常生效：改动必须先进入 dev，再经 PR 合入 prod。',
        ],
      );
    }

    violation(
      `被推送到 ${PROTECTED_BRANCH} 的提交不是合入提交（父提交数 ${parents.length - 1}）。`,
      [
        `提交：${sha.slice(0, 12)} ${tryGit(['log', '-1', '--pretty=format:%s', sha]) ?? ''}`,
        '直接推送到 prod 的普通提交不受允许；合入才是唯一入口。',
      ],
    );
  }

  const sourceCommit = parents[2];

  // 辅助分支必须都被尝试过，才能对「不是 dev」下结论
  const candidates = [options.pushedRef, `origin/${SOURCE_BRANCH}`, SOURCE_BRANCH].filter(
    (name) => typeof name === 'string' && name !== '',
  );

  for (const candidate of candidates) {
    if (tryGit(['rev-parse', '--quiet', '--verify', `${candidate}^{commit}`]) === undefined) {
      continue;
    }

    // 第二个父提交是「被合入分支的顶端」或其后代时，合入内容全部来自该分支
    const isAncestor =
      tryGit(['merge-base', '--is-ancestor', sourceCommit, candidate]) !== undefined;

    if (isAncestor) {
      const normalized = candidate.replace(/^origin\//, '');
      ok(
        `合入内容的来源分支包含 ${normalized}，符合规则（被合入顶端 ${sourceCommit.slice(0, 7)}）。`,
      );
    }
  }

  violation(`合入内容的顶端（${sourceCommit.slice(0, 7)}）不属于 \`${SOURCE_BRANCH}\`。`, [
    `提交：${sha.slice(0, 12)}`,
    `推送的分支：${options.pushedRef || '未知'}`,
    `已尝试的判定分支：${candidates.join(', ') || '（无）'}`,
    `含义：被合入 prod 的内容不是来自 ${SOURCE_BRANCH}。`,
  ]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (!options.event) {
    console.error('错误：需要 --event。');
    process.exit(EXIT_VIOLATION);
  }

  if (options.event === 'pull_request') {
    checkPullRequest(options);
  } else if (options.event === 'push') {
    checkPush(options);
  } else {
    ok(`事件 ${options.event} 不适用本守卫。`);
  }
}

main();
