"use strict";
/**
 * 分类校验落在**服务端**（不只靠界面下拉 ✗）—— 用户曾手输「R」，说明界面挡不住 ✗
 * 判定用 categories.isAcceptable：立创中文名 ∪ 类名 ∪ 旧位号前缀 ∪ _default 哨兵 合法 ✓；其它拒绝 ✓
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { isAcceptable } = require(path.join(__dirname, "..", "src", "services", "categories"));
const partsModule = require(path.join(__dirname, "..", "src", "services", "parts"));
const { validatePartInput, savePart } = partsModule;

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; console.log("  PASS  " + name); }
  catch (exc) { fails.push(name); console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]); }
}

t("合法：立创中文名 / 类名 / 旧位号前缀 / _default 哨兵", () => {
  for (const v of ["贴片电阻", "排母", "场效应管(MOSFET)", "翘板船型开关", "其它", "电阻", "R", "C", "SW", "H", "_default"]) {
    assert.ok(isAcceptable(v), v + " 应合法");
  }
});

t("非法：空值 / 乱输 / 纯符号（用户手输过的那些）", () => {
  for (const v of ["", "  ", "随便", "ABC123", "-", "??", "固态电容2"]) {
    assert.strictEqual(isAcceptable(v), false, v + " 应被拒绝");
  }
  assert.ok(isAcceptable(" 贴片电阻 ".trim()), "首尾空格由调用方 trim 后是合法值");
});

t("对账单里出现过、但阈值表还没收录的商品类型也要放行（否则用户存不回自己的数据）", () => {
  // 放行的理由只在"落库合法性"；阈值仍旧兜底（不猜）。名单外的仍然拒绝。
  assert.ok(isAcceptable("固态电容"), "对账单实测类型应可保存（阈值走 _default）");
  assert.strictEqual(isAcceptable("固态电容2"), false, "名单外的一律拒绝");
});

t("闸门确实挂在服务端保存路径上（parts.js 调用了 categories.isAcceptable）", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "src", "services", "parts.js"), "utf8");
  assert.ok(src.includes('require("./categories")') && src.includes("isAcceptable"), "parts.js 应调用 isAcceptable");
});

/* --------------- 闸门的**行为**断言（评审 R_8adb1e0d(T79) / R_97e52f62(T81) 明确要求的三条） ---------------
 * 为什么必须测 `validatePartInput` 而不是只测 `isAcceptable`：
 *   两者语义**相反** —— `isAcceptable("")` 是 false（空不是合法分类**值**），
 *   而保存路径对「空分类」是**放行**的（空 = 未选 = 其它，服务端规整成 `_default`）。
 *   只测谓词的话，把闸门条件写反（`!isBlank(c) && !isAcceptable(c)` 写成 `isAcceptable(c)`）也会绿 ✗
 *   静态检查 `src.includes("isAcceptable")` 同样挡不住条件写反 ✗
 */
function validate(over) {
  return validatePartInput(Object.assign({
    category: "_default", value: "10uF", footprint: "C1210", quantity: 1,
  }, over || {}));
}
const categoryErrors = (r) => (r.errors || []).filter((e) => /分类/.test(e));

t("闸门行为①：`category` 为空 → **放行**（空 = 未选 = 其它），errors 里不许出现分类错误", () => {
  const r = validate({ category: "" });
  assert.strictEqual(r.ok, true, JSON.stringify(r.errors));
  assert.deepStrictEqual(categoryErrors(r), [], "空分类不该报错");
  // null / undefined 同样放行（界面没选就是不传）
  assert.strictEqual(validate({ category: null }).ok, true);
  assert.strictEqual(validate({ category: undefined }).ok, true);
});

t("闸门行为②：`_default` 哨兵 / 中文名 / 旧位号前缀 / 类名 → 都放行（v2.1 落库值是中文名）", () => {
  for (const good of ["_default", "贴片电容(MLCC)", "排母", "场效应管(MOSFET)", "R", "SW", "电容"]) {
    const r = validate({ category: good });
    assert.strictEqual(r.ok, true, good + " 应放行：" + JSON.stringify(r.errors));
  }
});

t("闸门行为③：乱输 → **拒绝**，errors 明确指出「不在可选范围内」，文案无 markdown 星号", () => {
  for (const bad of ["乱七八糟!!!", "??", "<script>", "固态电容2"]) {
    const r = validate({ category: bad });
    assert.strictEqual(r.ok, false, bad + " 应被拒绝");
    const hit = categoryErrors(r);
    assert.strictEqual(hit.length, 1, "要有一条分类错误：" + JSON.stringify(r.errors));
    assert.ok(/不在可选范围内/.test(hit[0]), "报错要说清原因：" + hit[0]);
    assert.ok(!hit[0].includes("**"), "用户可见文案不得含 markdown 星号：" + hit[0]);
  }
});

t("闸门挂在**保存路径**上（不是只挂在谓词上）：savePart 收到乱分类抛错，且库数组一个字节不变", () => {
  const now = () => "2026-10-17T10:00:00+08:00";
  const library = [];
  // savePart 的契约是**抛错**（IPC 层转成 {ok:false, error}），不是返回 {ok:false} ✓
  assert.throws(
    () => savePart({ category: "乱七八糟!!!", value: "10uF", footprint: "C1210", quantity: 1 }, library, { now }),
    /不在可选范围内的|不在可选范围内/,
    "保存路径必须自己拒绝（不能只靠界面下拉）"
  );
  assert.deepStrictEqual(library, [], "被拒的提交不得改动库数组");
  // 放行语义的另一半：空分类能存进去，并落库为 _default 哨兵
  const good = savePart({ category: "", value: "10uF", footprint: "C1210", quantity: 1 }, library, { now });
  assert.strictEqual(good.part.category, "_default", "空分类落库为哨兵 _default");
  assert.strictEqual(library.length, 0, "savePart 不改调用方数组（返回新数组）");
});

console.log("=".repeat(64));
console.log("分类服务端校验：通过 " + pass + " / " + (pass + fails.length));
if (fails.length > 0) process.exitCode = 1;
else console.log("全部通过");
