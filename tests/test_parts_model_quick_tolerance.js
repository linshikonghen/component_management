"use strict";
/**
 * 容差「快捷选择」的地基（用户实测：± 打不出来，要能点选）
 *
 * 本步只保证两件事：
 *   ① 模型层把快捷值暴露出来（页面据此渲染按钮；界面接线下一步做 ✓）
 *   ② 每个快捷值都必须是**能归一**的写法：用户手打的 +-10% 与点选的 ±10%
 *      必须落成同一个判定键，否则同一批料还是合不上 ✗
 */
const assert = require("assert");
const path = require("path");
const M = require(path.join(__dirname, "..", "renderer", "model", "parts_model"));
const { normalizeText } = require(path.join(__dirname, "..", "src", "services", "spec_parser"));

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; console.log("  PASS  " + name); }
  catch (exc) { fails.push(name); console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]); }
}

t("容差字段带快捷值（±1% / ±5% / ±10% / ±20%）", () => {
  const f = M.FORM_FIELDS.find((x) => x.key === "tolerance");
  assert.ok(f, "应有容差字段");
  assert.deepStrictEqual(f.quick, ["±1%", "±5%", "±10%", "±20%"], "快捷值应按常见档位给出");
});

t("快捷值都是可归一的写法：手打 +-10% 与点选 ±10% 落成同一个键", () => {
  const f = M.FORM_FIELDS.find((x) => x.key === "tolerance");
  for (const v of f.quick) {
    const hand = v.replace("±", "+-");
    assert.strictEqual(normalizeText(hand), normalizeText(v), v + " 的两种写法必须归一一致");
  }
});

t("不影响其它字段（值/封装等仍无 quick）", () => {
  for (const key of ["value", "footprint", "voltage", "dielectric"]) {
    const f = M.FORM_FIELDS.find((x) => x.key === key);
    assert.ok(f, key + " 字段应在");
    assert.strictEqual(f.quick, undefined, key + " 不该有快捷值");
  }
});

console.log("=".repeat(64));
console.log("容差快捷选择地基：通过 " + pass + " / " + (pass + fails.length));
if (fails.length > 0) process.exitCode = 1;
else console.log("全部通过");
