"use strict";
/**
 * 分类单一来源（spec §5.3 + 立创商品类型映射）
 * 关键：阈值**逐项对照 spec §5.3 真值**（R=50 / 晶振=3 / 蜂鸣器=2 / 排针排母=10 …），
 * 一旦有人改表忘改 spec（或反过来），这里会红 ✓
 */
const assert = require("assert");
const path = require("path");
const C = require(path.join(__dirname, "..", "src", "services", "categories"));
const M = require(path.join(__dirname, "..", "renderer", "model", "parts_model"));

let pass = 0;
const fails = [];
function t(name, fn) {
  try { fn(); pass += 1; console.log("  PASS  " + name); }
  catch (exc) { fails.push(name); console.log("  FAIL  " + name + "\n        " + String(exc.message).split("\n")[0]); }
}

t("14 个分类与 spec §5.3 的默认阈值逐项一致（含 R=50 / 晶振=3 / 蜂鸣器=2 / 排针排母=10）", () => {
  const want = { C: 20, R: 50, L: 10, D: 10, Q: 10, U: 5, CN: 5, X: 3, KEY: 5, F: 5, BUZZER: 2, LED: 10, H: 10, OTHER: 5 };
  const got = {};
  for (const c of C.CLASSES) got[c.key] = c.min;
  assert.deepStrictEqual(got, want, "分类阈值与 spec §5.3 不一致：" + JSON.stringify(got));
});

t("用户库里的 13 个立创商品类型全部能映射到某个阈值类（不是 _default）", () => {
  const need = ["排母", "场效应管(MOSFET)", "翘板船型开关", "DC-DC电源芯片", "功率电感",
    "一体成型电感", "自恢复保险丝", "静电和浪涌保护(TVS/ESD)", "贴片型铝电解电容",
    "直插铝电解电容", "滑动开关", "音频功率放大器", "钮子开关"];
  for (const n of need) {
    const cls = C.resolve(n);
    assert.ok(cls && cls.key !== "OTHER", n + " 应映射到具体类，实际 " + (cls && cls.key));
  }
});

t("映射的阈值拿得到，且与类一致（排母=10、MOS=10、开关=5、保险丝=5、TVS=10、铝电解=20、DC-DC=5）", () => {
  assert.strictEqual(C.minOf("排母"), 10);
  assert.strictEqual(C.minOf("场效应管(MOSFET)"), 10);
  assert.strictEqual(C.minOf("翘板船型开关"), 5);
  assert.strictEqual(C.minOf("自恢复保险丝"), 5);
  assert.strictEqual(C.minOf("静电和浪涌保护(TVS/ESD)"), 10);
  assert.strictEqual(C.minOf("贴片型铝电解电容"), 20);
  assert.strictEqual(C.minOf("DC-DC电源芯片"), 5);
});

t("旧数据兼容：位号前缀反向可读（R→电阻 50 / H→排针排母 10 / SW→按键开关 5）", () => {
  assert.strictEqual(C.settingsKeyOf("R"), "R");
  assert.strictEqual(C.minOf("R"), 50);
  assert.strictEqual(C.settingsKeyOf("H"), "H");
  assert.strictEqual(C.minOf("H"), 10);
  assert.strictEqual(C.settingsKeyOf("SW"), "KEY");
  assert.strictEqual(C.minOf("SW"), 5);
});

t("认不出的一律兜底到其它（不猜 ✗），空值也算不合法", () => {
  assert.strictEqual(C.resolve("好奇怪的分类").key, "OTHER");
  assert.strictEqual(C.resolve("").key, "OTHER");
  assert.strictEqual(C.isAcceptable(""), false);
  assert.strictEqual(C.isAcceptable("好奇怪的分类"), false);
});

t("可接受值：中文名 / 旧前缀键 / 类名都算（服务端校验要用它）", () => {
  for (const v of ["贴片电阻", "排母", "R", "C", "SW", "H", "电阻", "其它", "_default"]) {
    assert.ok(C.isAcceptable(v), v + " 应可接受");
  }
});

t("**对账单能入库的分类，手动录入必须也能接受**（否则用户存不回自己的数据）", () => {
  // 实测：对账单里有「固态电容」——当时本表还没收录这个商品类型，但它照样会被入库（对账单是事实）。
  // **落库合法性**必须放行，否则编辑这条料会被服务端判成"乱输"直接拒绝 → 用户的数据再也改不了。
  // （该类型后来由**用户裁定**归入电容类，见下一条断言；"能存"这条不变量与归类无关，仍要钉住 ✓）
  const stmt = require(path.join(__dirname, "..", "src", "services", "lcsc_statement"));
  const fixture = path.join(__dirname, "fixtures", "sample_statement");
  const parsed = stmt.parseStatementFile(fixture);
  assert.strictEqual(parsed.ok, true, parsed.error);
  const cats = [...new Set(parsed.items.map((it) => it.category))];
  assert.ok(cats.length > 0, "对账单样本没解析出分类");
  for (const c of cats) {
    assert.ok(C.isAcceptable(c), "对账单里的分类「" + c + "」手动录入时被拒（存不回自己的数据）");
  }
  assert.ok(cats.includes("固态电容"), "样本里应有「固态电容」这条类型（本断言的由来）");
  assert.strictEqual(C.isKnownProductType("固态电容"), true);
  assert.ok(C.KNOWN_PRODUCT_TYPES.includes("贴片电阻"), "已知名单应包含全部已映射类型");
  // 名单外的真·乱输仍要拒绝
  assert.strictEqual(C.isAcceptable("固态电容2"), false);
  assert.strictEqual(C.isAcceptable("随便乱输"), false);
});

t("用户裁定：对账单里的「固态电容」归入**电容**类（阈值 20），与贴片/直插铝电解一致", () => {
  assert.strictEqual(C.settingsKeyOf("固态电容"), "C", "归电容类");
  assert.strictEqual(C.minOf("固态电容"), 20, "阈值取 §5.3 电容类的 20");
  assert.strictEqual(C.LCSC_TO_CLASS["固态电容"], "C");
  // 阈值键（核对表显示给用户的）与判定（low_stock 用的）必须是同一个 → 显示的=会用的 ✓
  const st = require(path.join(__dirname, "..", "src", "services", "lcsc_statement"));
  assert.strictEqual(st.thresholdKey("固态电容"), "C");
  const ls = require(path.join(__dirname, "..", "src", "services", "low_stock"));
  const store = require(path.join(__dirname, "..", "src", "services", "store"));
  assert.deepStrictEqual(ls.effectiveMinQuantity({ category: "固态电容", min_quantity: "" }, store.DEFAULT_SETTINGS),
    { threshold: 20, source: "category" });
  // 下拉里也要能选到它（否则用户改不了这条料的分类）
  assert.ok(M.CATEGORY_OPTIONS.some((o) => o.key === "固态电容"), "下拉应有 固态电容 这一项");
});

t("**未收录**的名字仍是乱输（拒绝保存），但阈值查询继续兜底不猜（`_default`=5）", () => {
  // 评审指出上一版标题自相矛盾（写"可存"，断言却是 isAcceptable=false）——这里说清两条不同的语义：
  //   · **能不能存**：只有"对账单里真出现过"的类型才放行（进 KNOWN_PRODUCT_TYPES）；
  //     纯表外名字（`火星牌电容`）仍按乱输拒绝，不许用户手打一个不存在的分类绕过校验；
  //   · **阈值怎么算**：无论存不存得进去，查不到类就落 `_default`(5)，**绝不猜** ✗
  assert.strictEqual(C.isAcceptable("火星牌电容"), false, "未收录的名字 → 拒绝保存（乱输）");
  assert.strictEqual(C.settingsKeyOf("火星牌电容"), "OTHER", "查表：认不出 → 兜底类");
  assert.strictEqual(C.minOf("火星牌电容"), 5, "兜底阈值 = _default 的 5");
});

t("渲染侧镜像：下拉值 ⊆ 单一来源认得的名字（漏一个立创类型就意味着用户选不到）", () => {
  for (const o of M.CATEGORY_OPTIONS) {
    assert.ok(C.isAcceptable(o.key), "下拉值 " + o.key + " 服务端不认（单向漂移）");
    assert.ok(/[\u4e00-\u9fa5]/.test(o.key), o.key + " 不是中文名（v2.1：落库值一律中文名）");
  }
  for (const name of Object.keys(C.LCSC_TO_CLASS)) {
    assert.ok(M.CATEGORY_OPTIONS.some((o) => o.key === name), "下拉缺立创类型：" + name);
  }
});

t("阈值行镜像（CATEGORY_CLASS_ROWS）与 §5.3 类表**逐项一致**：键 / 标签 / 位号前缀", () => {
  assert.strictEqual(M.CATEGORY_CLASS_ROWS.length, C.CLASSES.length, "行数应与 §5.3 类表一致");
  // 顺序与键都一致，**只有兜底类的键是有意的例外**：类表叫 `OTHER`，设置表叫 `_default`
  // （store.DEFAULT_SETTINGS 就是 `_default: 5`）→ 阈值行必须用设置表的键，否则查不到阈值。
  assert.deepStrictEqual(M.CATEGORY_CLASS_ROWS.slice(0, -1).map((r) => r.key),
    C.CLASSES.slice(0, -1).map((c) => c.key), "键与顺序都应一致（兜底行除外）");
  assert.strictEqual(M.CATEGORY_CLASS_ROWS[M.CATEGORY_CLASS_ROWS.length - 1].key, "_default");
  assert.strictEqual(C.CLASSES[C.CLASSES.length - 1].key, "OTHER");
  for (const row of M.CATEGORY_CLASS_ROWS) {
    const cls = C.CLASSES.find((c) => c.key === row.key) || C.CLASSES.find((c) => c.key === "OTHER" && row.key === "_default");
    assert.ok(cls, "类表里没有 " + row.key);
    const wantLabel = row.key === "_default" ? "其它" : cls.label;
    assert.strictEqual(row.label, wantLabel, row.key + " 的标签应与 §5.3 一致");
    assert.deepStrictEqual(row.prefixes, cls.prefixes, row.key + " 的位号前缀应与 §5.3 一致");
  }
  // 记一处**有意的不一致**：§5.3 兜底类的类名是「其它」，而设置表的键是哨兵 `_default`
  // （store.DEFAULT_SETTINGS 就是 `_default: 5`）→ 阈值行必须用 `_default`，否则查不到阈值。
  // 两边都得被服务端接受（settingsKeyOf 认 `_default`；标签「其它」也能解析回同一类）。
  assert.strictEqual(C.settingsKeyOf("_default"), "OTHER");
  assert.strictEqual(C.settingsKeyOf("其它"), "OTHER");
});

t("settings_model **不再**自带第二份类表（反重复）：阈值行只能来自 CATEGORY_CLASS_ROWS", () => {
  const SM = require(path.join(__dirname, "..", "renderer", "model", "settings_model"));
  const src = require("fs").readFileSync(path.join(__dirname, "..", "renderer", "model", "settings_model.js"), "utf8");
  assert.ok(!/"C", label: "电容"/.test(src), "settings_model 里不该再抄一份 §5.3 类表");
  assert.strictEqual(SM.thresholdRows({ default_min_quantity: {} }, null).length, 0, "不注入就没有行（看得见）");
  const rows = SM.thresholdRows({ default_min_quantity: {} }, M.CATEGORY_CLASS_ROWS);
  assert.deepStrictEqual(rows.map((r) => ({ key: r.key, label: r.label })),
    M.CATEGORY_CLASS_ROWS.map((r) => ({ key: r.key, label: r.label })));
});

console.log("=".repeat(64));
console.log("分类单一来源：通过 " + pass + " / " + (pass + fails.length));
if (fails.length > 0) process.exitCode = 1;
else console.log("全部通过");
