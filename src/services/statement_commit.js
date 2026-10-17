"use strict";
const { isBlank, str } = require("./value_util");
/**
 * statement_commit.js — 对账单入库的**计算**部分（**不写库**）
 *
 * 职责边界：本模块只把"人工核对后的决定"算成
 *   ① 新的器件数组  ② 待写入的 movements  ③ 汇总数字
 * 真正落盘仍走既有路径（store 的批量写 + 补偿），这样"要么两边都成、要么都不留"的既有保证不重复实现。
 *
 * 用户 2026-10-16 的决定：
 *   · 只用于**入库**（不导出、不比对）
 *   · 入库量 = 对账单「订购数量」
 *   · 无位号：**不写 designators**（字段保留给 BOM 路径，这条路径不碰它）
 *   · 分类以「商品类型」为准；阈值键由商品类型推出（见 lcsc_statement.thresholdKey）
 *   · 匹配不上的当新增；拿不准的**必须人工裁决**后才动（本模块只执行决定，不做决定）
 *
 * 补字段的原则沿用项目既有约定（见 inventory.mergePartInfo）：**只补空，不覆盖**——
 * 对账单能提供的是 值/容差/耐压/封装/型号/分类，其中库里为空的才填上，已有值的一律不动。
 */

/** 对账单能补进器件的字段（只补空） */
const FILLABLE = {
  value: (it) => it.value,
  tolerance: (it) => it.tolerance,
  voltage: (it) => it.voltage,
  current: (it) => it.current,
  power: (it) => it.power,
  polarity: (it) => it.polarity,
  footprint: (it) => it.footprint,
  // 对账单的「商品型号」= 器件契约里的 `part_number`（厂商料号）。
  // **与 BOM 路径保持同一约定**：inventory.js 也是 `part_number: item.manufacturer_part`。
  // （2026-10-17 修：原来这里写成器件的 `manufacturer_part` —— 该字段**不在** PART_FIELDS 白名单里，
  //   导致库存列表「型号」列永远是空的、手动编辑还可能把它丢掉 ✗ 用户实测报"型号都没有识别到"）
  part_number: (it) => it.manufacturer_part,
  category: (it) => it.category,
};

/**
 * @param {object} input
 *   parts        当前器件数组
 *   merged       [{ item, part }]  严格命中 或 人工裁决"就是它"的
 *   created      [item]            新增（匹配不上 或 人工裁决"不是它"）
 *   order_ref    订单号/对账单标识（写进留痕的 ref 与 reason）
 *   now          注入的时间函数（测试要钉死时间）
 *   nextId       (library, movements) → 新器件 id（注入 ids.nextPartId，避免第二份实现）
 *   existingMovements 现有变动记录（nextId 需要它来避免复用已删器件的号）
 * @returns {{parts: Array, movements: Array, summary: object}}
 */
function planStatementCommit(input) {
  const opts = input || {};
  const parts = Array.isArray(opts.parts) ? opts.parts.map((p) => Object.assign({}, p)) : [];
  const merged = Array.isArray(opts.merged) ? opts.merged : [];
  const created = Array.isArray(opts.created) ? opts.created : [];
  const orderRef = String(opts.order_ref == null ? "" : opts.order_ref);
  const nowFn = typeof opts.now === "function" ? opts.now : () => new Date().toISOString();
  // **id 生成只有一处实现**（services/ids.js 的 nextPartId）：这里只接受注入，
  // 缺了就明确报错，不再留一份"兜底实现"（对账单新建器件用错的号 = 数据事故）。
  const nextId = opts.next_id;
  if (typeof nextId !== "function") {
    throw new Error("planStatementCommit 需要注入 next_id（用 services/ids.js 的 nextPartId）");
  }
  const movements = Array.isArray(opts.existing_movements) ? opts.existing_movements.slice() : [];

  const out = [];
  const toWrite = []; // **本次要写的全部留痕**（合并的 in + 新增的 init），一条都不能漏
  const indexById = new Map();
  for (const p of parts) indexById.set(p.id, p);

  let totalIn = 0;

  // ① 合并：累加数量 + 只补空字段
  for (const entry of merged) {
    const item = entry.item || {};
    const target = indexById.get(entry.part && entry.part.id);
    if (!target) continue; // 决定指向了不存在的器件：跳过（调用方应先校验）
    const delta = toQty(item.quantity);
    const before = toQty(target.quantity);
    for (const [field, pick] of Object.entries(FILLABLE)) {
      const value = pick(item);
      if (isBlank(target[field]) && !isBlank(value)) target[field] = String(value).trim();
    }
    target.quantity = before + delta;
    totalIn += delta;
    toWrite.push({
      part_id: target.id,
      kind: "in",
      delta,
      before,
      after: target.quantity,
      reason: orderRef ? `按对账单入库（${orderRef}）` : "按对账单入库",
      ref: orderRef,
      // 留痕里记下"这条来自对账单哪一行"，事后能对账
      statement_row: item.row_no == null ? null : item.row_no,
      at: nowFn(),
    });
  }

  // ② 新增：建新器件（**不写位号**），数量 = 订购数量
  const working = parts.slice();
  const workingMovements = movements.slice();
  for (const item of created) {
    const qty = toQty(item.quantity);
    const id = nextId(working, workingMovements);
    const part = {
      id,
      category: str(item.category),
      value: str(item.value),
      footprint: str(item.footprint),
      voltage: str(item.voltage),
      dielectric: "",
      tolerance: str(item.tolerance),
      // MOS/三极管/二极管的参数（对账单商品名称里认出来的，作为**建议值**随人工核对入库）
      power: str(item.power),
      current: str(item.current),
      polarity: str(item.polarity),
      // 商品型号 → 器件契约的 part_number（厂商料号）；见 FILLABLE 处的说明（与 BOM 路径一致）
      part_number: str(item.manufacturer_part),
      manufacturer: "",
      supplier_part: "",
      supplier: "",
      quantity: qty,
      min_quantity: "",
      location: "",
      note: orderRef ? `对账单新建（${orderRef}）` : "对账单新建",
      // 位号：**这条路径不写**（对账单没有位号）；BOM 路径以后按"只补空不覆盖"补上
    };
    working.push(part);
    const initRecord = {
      part_id: id, kind: "init", delta: qty, before: 0, after: qty,
      reason: orderRef ? `按对账单新建（${orderRef}）` : "按对账单新建", ref: orderRef,
      statement_row: item.row_no == null ? null : item.row_no, at: nowFn(),
    };
    workingMovements.push(initRecord);
    toWrite.push(initRecord);
    out.push(part);
    totalIn += qty;
  }

  return {
    parts: parts.concat(out),
    movements: toWrite, // 合并的 in + 新增的 init，全部返回（漏一条就是漏一笔留痕）
    summary: {
      merged_count: merged.length,
      created_count: created.length,
      quantity_in: totalIn,
      order_ref: orderRef,
    },
  };
}

/* --------------------------------------------------------------- 小工具 */

function toQty(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}
module.exports = { planStatementCommit, FILLABLE };
