"use strict";
/**
 * 容差写法归一（用户实测反馈："+- 这种符号打不出来"）
 * 判据：判定键里的容差必须把 +-1% / +/-1% / ±1% 视为同一个，否则手动录入永远合不上库里的料。
 */
const assert = require("assert");
const path = require("path");
const { normalizeText } = require(path.join(__dirname, "..", "src", "services", "spec_parser"));

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; console.log("  PASS  " + name); }
  catch (exc) { fails.push(name); console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]); }
}

t("+-1% / +/-1% / ±1% 归一后完全相同（键盘打不出 ± 也要能合上）", () => {
  const a = normalizeText("±1%"), b = normalizeText("+-1%"), c = normalizeText("+/-1%");
  assert.strictEqual(b, a, "+-1% 应等于 ±1%");
  assert.strictEqual(c, a, "+/-1% 应等于 ±1%");
});

t("其他容差同样处理（±5% / ±10% / ±20%）", () => {
  for (const v of ["5", "10", "20"]) {
    assert.strictEqual(normalizeText("+-" + v + "%"), normalizeText("±" + v + "%"), v + "% 应一致");
  }
});

t("不影响无关文本（大小写/空白归一照旧）", () => {
  assert.strictEqual(normalizeText(" 0603 "), normalizeText("0603"));
  assert.strictEqual(normalizeText("x7r"), normalizeText("X7R"));
});

console.log("=".repeat(64));
console.log("容差归一测试：通过 " + pass + " / " + (pass + fails.length));
if (fails.length > 0) process.exitCode = 1;
else console.log("全部通过");
