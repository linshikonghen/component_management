"use strict";
/**
 * 对账单路径的阈值键：规则表命中者照旧 ✓，原来落 _default 的那批改由 categories 解析 ✓
 * （用户反馈"分类种类不全"的一半原因就在这里：排母/MOS/开关… 的阈值提示不准）
 */
const assert = require("assert");
const path = require("path");
const { thresholdKey } = require(path.join(__dirname, "..", "src", "services", "lcsc_statement"));
const C = require(path.join(__dirname, "..", "src", "services", "categories"));

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; console.log("  PASS  " + name); }
  catch (exc) { fails.push(name); console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]); }
}

t("立创商品类型不再一律 _default：排母→H、MOS→Q、开关→KEY、保险丝→F、TVS→D、铝电解→C、DC-DC→U", () => {
  assert.strictEqual(thresholdKey("排母"), "H");
  assert.strictEqual(thresholdKey("场效应管(MOSFET)"), "Q");
  assert.strictEqual(thresholdKey("翘板船型开关"), "KEY");
  assert.strictEqual(thresholdKey("自恢复保险丝"), "F");
  assert.strictEqual(thresholdKey("静电和浪涌保护(TVS/ESD)"), "D");
  assert.strictEqual(thresholdKey("贴片型铝电解电容"), "C");
  assert.strictEqual(thresholdKey("DC-DC电源芯片"), "U");
});

t("与 categories 同源：**每一个**已知立创类型 + 旧前缀逐个一致（不许各写一份表）", () => {
  const inputs = Object.keys(C.LCSC_TO_CLASS).concat([
    "R", "C", "H", "SW", "Y", "J", "P", "KEY", "LED", "_default", "其它", "",
  ]);
  for (const v of inputs) {
    const want = C.settingsKeyOf(v) === "OTHER" ? "_default" : C.settingsKeyOf(v);
    assert.strictEqual(thresholdKey(v), want, `「${v}」两处结果不一致（核对表显示的和判定的会不同）`);
  }
  assert.strictEqual(inputs.length > 25, true, "应覆盖全部立创类型");
});

t("**回归**：表外类型不许「看名字像就给键」——核对表的阈值键必须等于判定真正会用的键", () => {
  // 曾经的实现（自己的正则表）把 `发光二极管` 给 D（实际用 LED）、`排针` 给 CN（实际用 H）、
  // `固态电容` 给 C=20（当时实际映射不到 → `_default`=5）。用户按核对表显示的阈值备货，
  // 却按另一个阈值报警 → 必须钉死"显示的 == 会用的" ✓
  assert.strictEqual(thresholdKey("发光二极管"), "LED", "不能给 D");
  assert.strictEqual(thresholdKey("排针"), "H", "不能给 CN");
  // `固态电容` 现已由**用户裁定**归入电容类 → 显示的键与判定都用 C（一致：20）✓
  assert.strictEqual(thresholdKey("固态电容"), "C", "已裁定归电容类，与判定一致");
  // 仍未归类的表外名字：两边都必须兜底 _default（不许一边显示 C、一边用 5）
  assert.strictEqual(thresholdKey("火星牌电容"), "_default");
  assert.strictEqual(C.settingsKeyOf("火星牌电容") === "OTHER" ? "_default" : C.settingsKeyOf("火星牌电容"),
    thresholdKey("火星牌电容"));
  for (const k of Object.keys(C.LCSC_TO_CLASS)) {
    const key = thresholdKey(k);
    const judge = C.settingsKeyOf(k);
    assert.strictEqual(key, judge === "OTHER" ? "_default" : judge, k + " 的显示键与判定键不一致");
  }
});

t("认不出 / 空值 → _default 兜底（不猜 ✗）", () => {
  assert.strictEqual(thresholdKey("完全不认识的分类"), "_default");
  assert.strictEqual(thresholdKey(""), "_default");
  assert.strictEqual(thresholdKey(null), "_default");
});

console.log("=".repeat(64));
console.log("对账单阈值键：通过 " + pass + " / " + (pass + fails.length));
if (fails.length > 0) process.exitCode = 1;
else console.log("全部通过");
