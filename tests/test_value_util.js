"use strict";
/**
 * test_value_util.js — 服务层小工具（自检重构后唯一实现处）
 * 为什么单独测：原来 str/toInt/isBlank/clone 在 5 个 service 里各复制一份，
 * 现在集中到 src/services/value_util.js；这里钉住边界行为，防止以后又被各写一份后漂移。
 */
const assert = require("assert");
const path = require("path");
const U = require(path.resolve(__dirname, "..", "src", "services", "value_util.js"));

let passCount = 0;
const failures = [];
function t(name, fn) {
  try { fn(); passCount += 1; console.log("  PASS  " + name); }
  catch (exc) {
    failures.push(name);
    console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]);
  }
}

t("str：null/undefined → \"\"，其余 String + trim", () => {
  assert.strictEqual(U.str(null), "");
  assert.strictEqual(U.str(undefined), "");
  assert.strictEqual(U.str("  abc  "), "abc");
  assert.strictEqual(U.str(0), "0");
  assert.strictEqual(U.str(false), "false");
  assert.strictEqual(U.str(""), "");
});

t("toInt：截断取整；非有限数用默认值", () => {
  assert.strictEqual(U.toInt(3.9), 3);
  assert.strictEqual(U.toInt(-3.9), -3);
  assert.strictEqual(U.toInt("12"), 12);
  assert.strictEqual(U.toInt("abc", 7), 7);
  assert.strictEqual(U.toInt(Infinity, 5), 5);
  assert.strictEqual(U.toInt(NaN), 0);
  // 注意：Number(null)=0、Number("")=0，都是"可转成有限数"，所以走 0 而不是默认值（与旧实现一致）
  assert.strictEqual(U.toInt(null, 4), 0);
  assert.strictEqual(U.toInt("", 4), 0);
});

t("isBlank：null/undefined/纯空白字符串算空；数字 0、false 不算空", () => {
  assert.strictEqual(U.isBlank(null), true);
  assert.strictEqual(U.isBlank(undefined), true);
  assert.strictEqual(U.isBlank(""), true);
  assert.strictEqual(U.isBlank("   "), true);
  assert.strictEqual(U.isBlank(0), false);
  assert.strictEqual(U.isBlank(false), false);
  assert.strictEqual(U.isBlank("x"), false);
});

t("clone：深拷贝（改副本不影响原对象）", () => {
  const src = { a: 1, nested: { b: [1, 2, 3] } };
  const copy = U.clone(src);
  copy.nested.b.push(4);
  assert.strictEqual(src.nested.b.length, 3, "原对象不应被改");
  assert.deepStrictEqual(U.clone([{ x: 1 }]), [{ x: 1 }]);
});

console.log("\n" + "=".repeat(64));
console.log(`T112（服务层小工具 value_util）测试结果：通过 ${passCount} / ${passCount + failures.length}`);
if (failures.length > 0) process.exitCode = 1;
else console.log("全部通过");
