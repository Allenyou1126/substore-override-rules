#!/usr/bin/env node
/**
 * 安装 git 钩子：把仓库级的 core.hooksPath 指向 .githooks/。
 *
 * 由根 package.json 的 `prepare` 自动调用，所以 `pnpm install` 之后钩子就生效了。
 * 克隆后没跑过 install 时，可手动执行 `pnpm hooks:install`。
 *
 * 为什么不用 husky：这里只需要设置一个配置项并保证钩子文件可执行，
 * 不需要引入依赖，也不需要钩子管理器。少一个依赖少一处供应链面。
 */

import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = path.join(REPO_ROOT, ".githooks");

function git(args, options = {}) {
    return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", ...options }).trim();
}

function main() {
    if (!existsSync(path.join(REPO_ROOT, ".git"))) {
        console.log("不是 git 仓库（或不在仓库根目录），跳过钩子安装。");
        return;
    }

    if (!existsSync(HOOKS_DIR)) {
        console.log(".githooks/ 不存在，跳过钩子安装。");
        return;
    }

    // 让钩子文件在支持可执行位的平台上真的可执行
    for (const entry of readdirSync(HOOKS_DIR)) {
        try {
            chmodSync(path.join(HOOKS_DIR, entry), 0o755);
        } catch {
            // Windows 等平台没有可执行位概念，忽略即可
        }
    }

    const current = (() => {
        try {
            return git(["config", "--local", "--get", "core.hooksPath"]);
        } catch {
            return "";
        }
    })();

    if (current === ".githooks") {
        console.log("git 钩子已就绪（core.hooksPath = .githooks）。");
        return;
    }

    if (current !== "") {
        console.warn(
            `警告：core.hooksPath 当前是 \`${current}\`，将被覆盖为 \`.githooks\`。\n` +
                "  若你另有钩子管理器，请改用 pnpm hooks:install 之外的方案，或把两者的钩子合并。",
        );
    }

    git(["config", "--local", "core.hooksPath", ".githooks"]);
    console.log("已设置 core.hooksPath = .githooks，提交信息钩子生效。");
    console.log("提示：钩子可被 `git commit --no-verify` 绕过，CI 才是最终把关。");
}

main();
