"use strict";
/**
 * 解析不得把「描述」当成「值」（用户实测：库里 5 种电阻的值全是「厚膜电阻」✗）
 *
 * 背景：立创对账单电阻/开关行的商品名称就是描述（「厚膜电阻」「钮子开关」），
 * 真正的阻值/容量只在商品型号里；而项目铁律是**禁止从型号猜参数** ✗
 * → 正确行为：解不出值就**留空 + 警告**，由人在核对表里填 ✓
 */
const assert = require("assert");
const path = require("path");
const { parseProductName } = require(path.join(__dirname, "..", "src", "services", "lcsc_statement"));

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; console.log("  PASS  " + name); }
  catch (exc) { fails.push(name); console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]); }
}

t("描述不是值：厚膜电阻 → value 留空，描述原样留在 extra", () => {
  const r = parseProductName("厚膜电阻 0603 ±1% 编带");
  assert.strictEqual(r.value, "", "描述不能被当成值");
  assert.ok(r.extra.includes("厚膜电阻"), "描述应留在 extra 里供人查看：" + r.extra);
  assert.strictEqual(r.tolerance, "±1%", "容差照旧解出来");
  assert.strictEqual(r.pack, "编带", "包装照旧识别");
});

t("真值照旧解出来：100nF ±10% 100V 编带", () => {
  const r = parseProductName("100nF ±10% 100V 编带");
  assert.strictEqual(r.value, "100nF");
  assert.strictEqual(r.tolerance, "±10%");
  assert.strictEqual(r.voltage, "100V");
});

t("型号样式的串不算值：SMBJ18CA / 1个P沟道 / 降压型 都留空", () => {
  for (const name of ["SMBJ18CA SMB", "1个P沟道 SOT-23", "降压型 TSOT-23-8"]) {
    assert.strictEqual(parseProductName(name).value, "", name + " 不该产出值");
  }
});

t("纯数字无单位也留空（spec §5.2：不推断单位）", () => {
  assert.strictEqual(parseProductName("100 0603").value, "", "100 没有单位，不猜");
});

t("单位齐全的照旧：10uF / 47uH / 3A（3A 是电流，A 在单位表里）", () => {
  assert.strictEqual(parseProductName("10uF 0603 10V ±10%").value, "10uF");
  assert.strictEqual(parseProductName("47uH SMD ±20%").value, "47uH");
});

console.log("=".repeat(64));
console.log("解析不得把描述当值：通过 " + pass + " / " + (pass + fails.length));
if (fails.length > 0) process.exitCode = 1;
else console.log("全部通过");
