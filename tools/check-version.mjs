#!/usr/bin/env node
/**
 * 版本号校验与发版建议。
 *
 * 唯一版本真源是根 package.json 的 `version` 字段，它代表「这套 override 脚本集合」
 * 作为一个交付物的版本 —— 也就是 `substore-override-rules/<version>/` 这个 OSS 目录名，
 * 以及 `v<version>` 这个 git tag。
 *
 * 用法：
 *   node tools/check-version.mjs                        # 打印当前版本与校验结论
 *   node tools/check-version.mjs --check                # CI 模式：不合规就非零退出
 *   node tools/check-version.mjs --check --tag v0.2.0   # 额外断言 tag 与 package.json 一致
 *   node tools/check-version.mjs --list                 # 给出下一版递增建议（只建议，不改文件）
 *
 * 规范正文见 docs/standards/development.md 的「发版版本号规则」。
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 合法的版本号：三段数字，可选预发标记。不接受 `v` 前缀（tag 才带 v）。 */
const VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

function readPackageVersion() {
    const raw = readFileSync(path.join(REPO_ROOT, "package.json"), "utf8");
    return JSON.parse(raw).version;
}

function git(args) {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function tryGit(args) {
    try {
        return git(args);
    } catch {
        return undefined;
    }
}

/** 解析 semver 为可比较的结构；不合法返回 undefined。 */
function parseVersion(value) {
    const match = VERSION_RE.exec(value);

    if (!match) {
        return undefined;
    }

    return {
        raw: value,
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        prerelease: match[4],
    };
}

/**
 * 比较两个预发标记。
 *
 * 按 semver 规范 §11 逐段比较：数字段按数值、字母段按 ASCII 序，数字段永远低于字母段；
 * 前缀相同时段数少的更低（`rc.1` < `rc.1.1`）。
 * 不能图省事用 `localeCompare` —— 它会把 `rc.10` 判成小于 `rc.9`。
 */
function comparePrerelease(a, b) {
    const left = a.split(".");
    const right = b.split(".");

    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const l = left[i];
        const r = right[i];

        if (l === undefined) return -1;
        if (r === undefined) return 1;
        if (l === r) continue;

        const lNum = /^\d+$/.test(l);
        const rNum = /^\d+$/.test(r);

        if (lNum && rNum) return Number(l) - Number(r);
        if (lNum) return -1;
        if (rNum) return 1;

        if (l < r) return -1;
        if (l > r) return 1;
    }

    return 0;
}

/**
 * 按 semver 数值比较，**不是字符串比较**。
 * `0.10.0` 在字符串序里小于 `0.9.0`，但语义上更大 —— 这是最容易写错的地方。
 */
function compareVersions(a, b) {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;

    // 有预发标记的排在无标记之前（1.0.0-rc.1 < 1.0.0）
    if (a.prerelease && !b.prerelease) return -1;
    if (!a.prerelease && b.prerelease) return 1;
    if (a.prerelease && b.prerelease) {
        return comparePrerelease(a.prerelease, b.prerelease);
    }

    return 0;
}

function listTagVersions() {
    const output = tryGit(["tag", "--list", "v*"]);

    if (!output) {
        return [];
    }

    return output
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .map((tag) => ({ tag, version: parseVersion(tag.replace(/^v/, "")) }))
        .filter((entry) => entry.version !== undefined);
}

/**
 * 取版本号最高的那个 tag 条目（含 tag 名，构造 git 范围时需要）。
 * `raw` 只保留版本号，`tag` 才是 git 里可用的 ref。
 */
function highestVersion(entries) {
    return entries.reduce(
        (max, entry) =>
            max === undefined || compareVersions(entry.version, max.version) > 0 ? entry : max,
        undefined,
    );
}

/** 从提交历史推导建议的递增级别。只建议，不自动改文件。 */
function suggestBump() {
    const latestEntry = highestVersion(listTagVersions());
    // 必须用**带 v 前缀的 tag 名**构造范围：git 里 `0.11.0..HEAD` 是歧义写法，
    // 而 `v0.11.0..HEAD` 才是合法 ref 范围。
    const range = latestEntry ? `${latestEntry.tag}..HEAD` : "HEAD";

    const output = tryGit(["log", "--pretty=format:%s%n%b%n---COMMIT---", range]);

    if (output === undefined) {
        return { range, level: undefined, reason: "无法读取提交历史" };
    }

    const commits = output
        .split("---COMMIT---")
        .map((chunk) => chunk.trim())
        .filter((chunk) => chunk !== "")
        .filter((chunk) => !chunk.startsWith("Merge "));

    if (commits.length === 0) {
        return { range, level: undefined, reason: "自上个 tag 以来没有提交" };
    }

    // 还没有任何 tag 时，范围是整个历史。此时历史里通常只有引导性提交（chore/docs），
    // 若按默认走 patch 会建议一个毫无意义的 `0.1.1` —— 版本从未发布过，谈不上递增。
    // 首个版本号应由人决定（本仓库起点是 0.1.0，理由见 docs/standards/development.md）。
    if (
        !latestEntry &&
        commits.every((chunk) =>
            /^(chore|docs|ci|build|test|style)(\(|:)/.test(chunk.split("\n")[0] ?? ""),
        )
    ) {
        return {
            range,
            level: undefined,
            reason: "尚未发版，且历史里只有引导性提交；首个版本号由人决定",
        };
    }

    let hasBreaking = false;
    let hasFeature = false;
    let hasFix = false;

    for (const commit of commits) {
        const subject = commit.split("\n")[0] ?? "";

        if (/^[a-z]+(\([^)]*\))?!:/.test(subject) || /BREAKING CHANGE:/.test(commit)) {
            hasBreaking = true;
            continue;
        }

        if (/^feat(\([^)]*\))?:/.test(subject)) {
            hasFeature = true;
            continue;
        }

        if (/^(fix|perf)(\([^)]*\))?:/.test(subject)) {
            hasFix = true;
        }
    }

    if (hasBreaking) {
        return { range, level: "major", reason: "存在破坏性变更（`!` 或 BREAKING CHANGE:）" };
    }
    if (hasFeature) {
        return { range, level: "minor", reason: "存在 feat: 提交" };
    }
    if (hasFix) {
        return { range, level: "patch", reason: "存在 fix:/perf: 提交" };
    }

    return { range, level: "patch", reason: "只有 docs/chore/ci 等非功能性提交" };
}

function applyBump(version, level) {
    if (level === "major") return `${version.major + 1}.0.0`;
    if (level === "minor") return `${version.major}.${version.minor + 1}.0`;
    return `${version.major}.${version.minor}.${version.patch + 1}`;
}

/**
 * 解析命令行参数。
 *
 * 显式 JSDoc 类型避免 `tag` 被推断成 `never`，同时给编辑器提示。
 *
 * @param {string[]} argv
 * @returns {{ check: boolean, list: boolean, tag: string | undefined }}
 */
function parseArgs(argv) {
    const options = { check: false, list: false, tag: undefined };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];

        if (arg === "--check") {
            options.check = true;
        } else if (arg === "--list") {
            options.list = true;
        } else if (arg === "--tag") {
            options.tag = argv[i + 1];
            i += 1;
        } else if (arg.startsWith("--tag=")) {
            options.tag = arg.slice("--tag=".length);
        } else if (arg === "--help" || arg === "-h") {
            console.log("用法: node tools/check-version.mjs [--check] [--list] [--tag vX.Y.Z]");
            process.exit(0);
        } else {
            console.error(`未知参数: ${arg}`);
            process.exit(1);
        }
    }

    // GITHUB_REF_NAME 在 tag 触发的 workflow 里就是 tag 名
    if (!options.tag && process.env.GITHUB_REF_NAME?.startsWith("v")) {
        options.tag = process.env.GITHUB_REF_NAME;
    }

    return options;
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const errors = [];

    const rawVersion = readPackageVersion();
    const current = parseVersion(rawVersion);

    console.log(`package.json version: ${rawVersion}`);

    if (!current) {
        errors.push(
            `版本号 ${JSON.stringify(rawVersion)} 不合法。\n` +
                "  期望：X.Y.Z，或 X.Y.Z-<预发标记>（如 0.2.0-rc.1）。\n" +
                "  注意：`v` 前缀只加在 git tag 上，不要写进 package.json；不接受前导零。",
        );
    }

    const tagEntries = listTagVersions();
    const highest = highestVersion(tagEntries);

    if (tagEntries.length === 0) {
        console.log("历史 tag：无（首次发版）");
    } else {
        console.log(`历史 tag：${tagEntries.map((entry) => entry.tag).join(", ")}`);
        console.log(`最高版本：${highest.version.raw}`);
    }

    if (current) {
        // 断言 ②：必须严格大于历史最高版本
        if (highest && compareVersions(current, highest.version) <= 0) {
            errors.push(
                [
                    `版本号没有严格递增：${current.raw} 不大于历史最高版本 ${highest.version.raw}（tag ${highest.tag}）。`,
                    "  按 semver 数值比较（不是字符串比较）：0.10.0 > 0.9.0。",
                    "  注意预发版排序：0.2.0-rc.1 < 0.2.0，所以正式版发布后不能再回到 rc 版本号。",
                    "  版本号只增不减；如需回滚，请把产物重新指向旧版本，而不是减低版本号。",
                ].join("\n"),
            );
        }

        // 断言 ③：不能与既有 tag 重复
        const duplicate = tagEntries.find((entry) => compareVersions(entry.version, current) === 0);

        if (duplicate) {
            errors.push(
                `版本号与既有 tag 重复：${duplicate.tag}。发版后 tag 不可复用，请递增版本号。`,
            );
        }
    }

    // 断言 ④：tag 与 package.json 必须一致（防止手滑打错 tag）
    if (options.tag) {
        const tagVersion = parseVersion(options.tag.replace(/^v/, ""));

        if (!tagVersion) {
            errors.push(`tag ${options.tag} 不是合法版本号（期望形如 vX.Y.Z）。`);
        } else if (current && compareVersions(tagVersion, current) !== 0) {
            errors.push(
                [
                    `tag 与 package.json 版本不一致：tag=${options.tag}，package.json=${current.raw}。`,
                    "  发布内容与版本记录必须对得上，否则 OSS 上的目录名会与 tag 语义错位。",
                ].join("\n"),
            );
        }
    }

    if (options.list) {
        const suggestion = suggestBump();
        console.log(`\n建议范围：${suggestion.range}`);

        if (!suggestion.level) {
            console.log(`建议递增：无（${suggestion.reason}）`);
        } else if (current) {
            console.log(`建议递增：${suggestion.level}（${suggestion.reason}）`);
            console.log(`建议版本：${applyBump(current, suggestion.level)}`);
            console.log(
                "\n这只是建议。请按 docs/standards/development.md 的判定表人工确认后执行：\n" +
                    `  npm version --no-git-tag-version ${suggestion.level}`,
            );
        }
    }

    if (errors.length > 0) {
        console.error("");
        for (const error of errors) {
            console.error(`✗ ${error}`);
        }
        console.error("\n版本号校验未通过。规范：docs/standards/development.md");
        process.exit(1);
    }

    if (options.check) {
        console.log("\n✓ 版本号校验通过。");
    } else {
        console.log("\n提示：加 --check 可让不合规时非零退出（CI 用法）。");
    }
}

main();
