"use strict";
/**
 * real_data_guard.js — 守护「测试绝不改动真实 data/」这条硬规则。
 *
 * **为什么要改成快照比对**：旧写法是断言 `!fs.existsSync(data/)` ——
 * 这在**用户真的用过工具之后必然失败**：双击运行会把真实库建起来，那是正常使用，不是测试污染。
 * （2026-10-16 实测踩到：用户双击出窗口后，T11 与 T6 两条"没碰真实 data/"的断言同时变红。）
 *
 * 现在：套件**加载时**给 `data/` 拍一张快照，断言时再拍一张，**两张完全一致**才算通过。
 * 这样"测试没碰真实库"照样被守住，而"用户本来就有库"不再被误判。
 *
 * 快照内容：相对路径 → `类型:大小:mtime:内容哈希`（目录只记名字，不记 mtime——目录 mtime
 * 会被系统上的无关活动影响，记进来只会制造假警报）。
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

/** 拍一张目录快照：{ 相对路径: "file:大小:mtime:sha256" | "dir" } */
function snapshot(dir) {
  const out = {};
  const walk = (base, rel) => {
    let entries;
    try {
      entries = fs.readdirSync(base, { withFileTypes: true });
    } catch (ignored) {
      return; // 目录不存在/读不了都当作"空的"，由调用方比较
    }
    for (const entry of entries) {
      const abs = path.join(base, entry.name);
      const key = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        out[key] = "dir";
        walk(abs, key);
      } else {
        try {
          const st = fs.statSync(abs);
          const hash = crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 16);
          out[key] = `file:${st.size}:${Math.round(st.mtimeMs)}:${hash}`;
        } catch (exc) {
          out[key] = `file:unreadable:${exc.code || exc.message}`;
        }
      }
    }
  };
  walk(dir, "");
  return out;
}

/**
 * @param {string} projectRoot 项目根（真实 data/ 在其中）
 * @returns {{before: object, assertUnchanged: function(string=): void}}
 */
function createRealDataGuard(projectRoot) {
  const dataDir = path.join(projectRoot, "data");
  const before = snapshot(dataDir);
  return {
    dataDir,
    before,
    /** 断言真实 data/ 与套件开始时**逐字节一致**；不一致就列出差异 */
    assertUnchanged(where) {
      const after = snapshot(dataDir);
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      const diffs = [];
      for (const key of keys) {
        if (before[key] === after[key]) continue;
        if (!(key in before)) diffs.push(`新增：${key}`);
        else if (!(key in after)) diffs.push(`消失：${key}`);
        else diffs.push(`被改：${key}\n        之前 ${before[key]}\n        之后 ${after[key]}`);
      }
      if (diffs.length > 0) {
        throw new Error(`${where || "测试"}改动了真实库 ${dataDir}：\n      ` + diffs.join("\n      "));
      }
    },
  };
}

module.exports = { createRealDataGuard, snapshot };
