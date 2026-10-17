"use strict";
/**
 * inventory.js — 入库合并 / 出库 / 按 BOM 领料 / 变动留痕（plan §5）
 *
 * 四条铁律（都来自 spec，违反任何一条用户就会看到错的库存）：
 *
 * ① **同一种料累加，不新建重复器件**（FR-1.9）
 *    判定键复用 `compare.dedupeKey`——**全工程唯一实现**。若这里再写一份，
 *    导入与比对就会对"是不是同一种料"给出不同答案，用户会看到"库里明明有、比对却说缺"。
 *
 * ② **累加的是「本次入库量」，不是 BOM 原值**（spec FR-1.6 v1.4 强制）
 *    `quantity_per_board` / `total_quantity` 只用于**显示算式**与**留痕**，
 *    绝不参与累加、**绝不回写 BOM 文件**。人工把 24 改成 10 就只加 10。
 *
 * ③ **数量变了就必须留痕**（FR-4.5），且人工改过的要能回答"为什么和 BOM 不一样"：
 *    变动记录带 `expected_quantity`（原应入库量）+ `intake_quantity`（实际入库量）+ `edited_by_human`。
 *
 * ④ **出库不得超库存**（FR-7.2）：超了直接拒绝，**库存不变、也不产生变动记录**。
 *
 * 职责边界：本模块**不碰文件系统、不调用 store 的写函数**（只用它的纯 helper：`nowIso`/`nextId`）。
 * 它算出一份"应该变成什么样"（新 parts + 待追加的 movements），**由 IPC 层交给 store 落盘**——
 * 唯一写入口这条线不能破。变动记录的 `id`/`at` 也留给 store 赋：
 * 本模块决定"发生了什么"，store 决定"身份与时间"。
 */

const { dedupeKey, buildLibraryIndex, findLibraryMatch } = require("./compare");
const { nowIso } = require("./store");
const ids = require("./ids");
const { toInt, clone, str, isBlank } = require("./value_util");

/**
 * 位号前缀 → 分类（spec §5.3 的 14 类）。
 * **顺序即优先级，长前缀必须在前**：`CN1` 要判成连接器而不是电容 `C`、
 * `LED1` 要判成指示灯而不是电感 `L`、`SW4` 判成按键、`BUZZER1` 判成蜂鸣器（plan §5.2 明确要求）。
 * 返回的键与 plan §3.3 / spec §5.3 的分类键**同名**，这样它可以直接当
 * `settings.default_min_quantity` 的查询键用（测试里有跨模块一致性断言防漂移）。
 */
const CATEGORY_PREFIXES = [
  ["BUZZER", "BUZZER"],
  ["KEY", "KEY"],
  ["SW", "KEY"],
  ["LED", "LED"],
  ["CN", "CN"],
  ["C", "C"],
  ["R", "R"],
  ["L", "L"],
  ["D", "D"],
  ["Q", "Q"],
  ["U", "U"],
  ["X", "X"],
  ["Y", "X"],
  ["F", "F"],
  ["H", "H"],
  ["J", "CN"],
  ["P", "CN"],
];

const DEFAULT_CATEGORY = "_default";

/** 位号 → 分类；多个位号时取出现最多的分类（并列取先出现的） */
function inferCategory(designators) {
  const list = Array.isArray(designators)
    ? designators
    : String(designators == null ? "" : designators).split(/[,;，；、\s]+/).filter((s) => s !== "");
  const counts = new Map();
  for (const raw of list) {
    const name = String(raw).trim().toUpperCase();
    if (name === "") continue;
    const hit = CATEGORY_PREFIXES.find(([prefix]) => name.startsWith(prefix));
    const category = hit ? hit[1] : DEFAULT_CATEGORY;
    counts.set(category, (counts.get(category) || 0) + 1);
  }
  let best = DEFAULT_CATEGORY;
  let bestCount = 0;
  for (const [category, count] of counts) {
    if (count > bestCount) { best = category; bestCount = count; }
  }
  return best;
}

/** 从 BOM 条目建一条新器件（字段照 plan §3.1 全给，空值留空而不是省略） */
function newPartFromItem(item, id, when) {
  const at = nowIso(when);
  const mpn = {
    part_number: str(item.manufacturer_part),
    manufacturer: str(item.manufacturer),
    supplier_part: str(item.supplier_part),
    supplier: str(item.supplier),
  };
  return {
    id,
    category: inferCategory(item.designators),
    value: str(item.value),
    footprint: str(item.footprint),
    voltage: str(item.voltage),
    dielectric: str(item.dielectric),
    tolerance: str(item.tolerance),
    power: str(item.power),
    current: "",
    polarity: "",
    mount_type: "",
    part_number: mpn.part_number,
    manufacturer: mpn.manufacturer,
    supplier_part: mpn.supplier_part,
    supplier: mpn.supplier,
    mpn_list: hasMpn(mpn) ? [mpn] : [],
    quantity: 0,
    // v1.5 实现期补记：这两项**可由 BOM 条目带过来**（spec FR-1.6 允许核对阶段改库位/阈值）。
    // 留空语义：min_quantity 空 = 继承分类默认（FR-4.8）；location 空 = 未指定库位。
    min_quantity: isBlank(item.min_quantity) ? null : toInt(item.min_quantity),
    location: str(item.location),
    datasheet: "",
    substitute: "",
    batch: "",
    // v1.5 实现期补记（审计发现）：spec FR-1.6 ④ 把「备注」列为核对阶段**可改字段**、
    // AC-1 要求"均可改并生效"，但这里原来硬编码成空串 → 用户写的备注**静默消失**（同类静默丢数据缺口）。
    note: str(item.note),
    created_at: at,
    updated_at: at,
  };
}

/** 把 BOM 上的料号信息并入已有器件（AML 模式：一条器件 ↔ 多个厂商料号，spec §5.2） */
function mergePartInfo(part, item, when) {
  const fill = (field, value) => {
    const v = str(value);
    if (v !== "" && str(part[field]) === "") part[field] = v; // 只补空，不覆盖用户已填的
  };
  fill("voltage", item.voltage);
  fill("dielectric", item.dielectric);
  fill("tolerance", item.tolerance);
  fill("power", item.power);
  // v1.5 实现期补记（spec FR-1.6）：核对时填的「库位」并入已有器件——仍然只补空，不覆盖用户填过的
  fill("location", item.location);
  // 「低库存阈值」是**数字**字段，不能走 fill()（那会把它变成字符串）；只在原有为空时补
  if (!isBlank(item.min_quantity) && isBlank(part.min_quantity)) part.min_quantity = toInt(item.min_quantity);
  fill("part_number", item.manufacturer_part);
  fill("manufacturer", item.manufacturer);
  fill("supplier_part", item.supplier_part);
  fill("supplier", item.supplier);
  // v1.5 实现期补记（审计发现）：备注也要并入（同样只补空）——
  // 漏掉这一个字段时，用户在核对表里写的备注既不入库、也不进导出，且**没有任何提示**。
  fill("note", item.note);
  const candidate = {
    part_number: str(item.manufacturer_part),
    manufacturer: str(item.manufacturer),
    supplier_part: str(item.supplier_part),
    supplier: str(item.supplier),
  };
  if (hasMpn(candidate)) {
    if (!Array.isArray(part.mpn_list)) part.mpn_list = [];
    const dup = part.mpn_list.some((m) => str(m.part_number) === candidate.part_number
      && str(m.supplier_part) === candidate.supplier_part);
    if (!dup) part.mpn_list.push(candidate);
  }
  part.updated_at = nowIso(when);
}

function hasMpn(mpn) {
  return str(mpn.part_number) !== "" || str(mpn.supplier_part) !== "";
}

/** 空值判定：null / undefined / 纯空白串都算空（核对表的输入可能是 `""` 也可能是 `null`） */
/* ==================================================================== 入库 */

/**
 * BOM 入库（plan §6 `bom:commit`）。
 * @param {string} batchId 批次号（由调用方生成，plan §3.2）；所有变动记录共用它作 ref
 * @param {Array<object>} items 人工确认后的 BomItem[]
 * @param {Array<object>} parts 当前库存（**不会被就地修改**）
 * @param {{sets?: number, source?: string, reason?: string, now?: Date}} [options]
 * @returns {{parts: object[], movements: object[], added: number, merged: number,
 *            skipped: number, skip_details: object[], errors: string[],
 *            summary: {total: number, added: number, merged: number, skipped: number}}}
 */
function commitBom(batchId, items, parts, options = {}) {
  if (str(batchId) === "") {
    throw new Error("commitBom: 需要 batch_id（批次号由调用方生成，见 plan §3.2）");
  }
  if (!Array.isArray(items)) throw new Error("commitBom: items 必须是数组");
  const library = (Array.isArray(parts) ? parts : []).map(clone);
  const index = new Map();
  library.forEach((part, i) => {
    const key = dedupeKey(part);
    if (!index.has(key)) index.set(key, i);
  });

  const movements = [];
  const skipDetails = [];
  const errors = [];
  let added = 0;
  let merged = 0;
  const reasonBase = str(options.reason) !== ""
    ? str(options.reason)
    : `BOM 导入: ${str(options.source) || "未命名"} 套数${toInt(options.sets, 1)}`;

  for (const item of items) {
    const src = item || {};
    const rowNo = toInt(src.row_no, 0);
    const intakeRaw = src.intake_quantity;

    if (str(src.action) === "skip") {
      // FR-1.7：跳过要记原因。契约里没有独立字段，用人工备注 `note` 承载（plan §6 BomItem）
      skipDetails.push({ row_no: rowNo, reason: str(src.note) || "人工跳过", kind: "skip" });
      continue;
    }
    const intake = Number(intakeRaw);
    const intakeText = intakeRaw == null ? "" : String(intakeRaw).trim();
    // 注意区分两种"0"：
    //   显式的 0  = 人工把本次入库量填 0 → 视同跳过（AC-1 明文规定）
    //   缺失的空值（null/undefined/""）→ **报错**，不能当成 0 静默跳过
    //   ——"字段没传"被当成"用户想跳过"，会在导入时悄悄丢掉一整行数据，这比报错危险得多。
    if (intakeText === "" || !Number.isInteger(intake) || intake < 0) {
      // AC-1 异常路径：本次入库量填 -1 / abc → 拒绝该条并提示（该条不入库）
      const message = `第 ${rowNo} 行：本次入库量「${intakeRaw}」必须是非负整数，该条未入库`;
      errors.push(message);
      skipDetails.push({ row_no: rowNo, reason: message, kind: "invalid" });
      continue;
    }
    if (intake === 0) {
      // AC-1：填 0 视同跳过并提示，**不产生变动记录**
      skipDetails.push({ row_no: rowNo, reason: "本次入库量为 0，视同跳过", kind: "zero" });
      continue;
    }

    const expected = toInt(src.total_quantity); // 原应入库量 = BOM 单套 × 套数（只读）
    const edited = src.edited_by_human === true || intake !== expected;
    const key = dedupeKey(src);
    const at = index.get(key);
    let part;
    let before;

    if (at == null) {
      part = newPartFromItem(src, nextPartId(library, options.movements), options.now);
      library.push(part);
      index.set(key, library.length - 1);
      before = 0;
      added += 1;
    } else {
      part = library[at];
      before = toInt(part.quantity);
      mergePartInfo(part, src, options.now);
      merged += 1;
    }
    part.quantity = before + intake; // ← 只按「本次入库量」累加（FR-1.6 v1.4）
    movements.push({
      part_id: part.id,
      kind: "in",
      delta: intake,
      before,
      after: part.quantity,
      reason: reasonBase,
      ref: batchId,
      // v1.4 留痕：事后能回答"这条为什么和 BOM 不一样"
      expected_quantity: expected,
      intake_quantity: intake,
      edited_by_human: edited,
    });
  }

  const summary = {
    total: items.length,
    added,
    merged,
    skipped: skipDetails.length,
  };
  return {
    parts: library,
    movements,
    added,
    merged,
    skipped: skipDetails.length,
    skip_details: skipDetails,
    errors,
    summary,
  };
}

/** `p_0001` 形态（实现统一在 ./ids；**变动记录里的 part_id 也要算**，删掉的号不复用） */
function nextPartId(library, movements) {
  return ids.nextPartId(library, movements);
}

/* ============================================================== 出入库 */

/**
 * 出入库（plan §6 `stock:move`）。delta 正数入库、负数出库。
 * @returns {{parts: object[], movement: object}} 新的 parts 副本 + 一条变动记录（id/at 由 store 赋）
 * @throws 器件不存在 / 数量非法 / **未填原因** / **库存不足**（后者不产生任何变动，FR-7.2）
 */
function moveStock(partId, delta, reason, parts, options = {}) {
  const library = (Array.isArray(parts) ? parts : []).map(clone);
  const idx = library.findIndex((p) => str(p.id) === str(partId));
  if (idx < 0) throw new Error(`器件不存在：${partId}`);
  const d = Number(delta);
  if (!Number.isInteger(d) || d === 0) throw new Error(`数量变动必须是非 0 整数（收到「${delta}」）`);
  // plan §6 把 reason 标为**必填**（spec FR-7.1「填写数量与原因」、AC-7「含原因」）。
  // 界面（renderer/model/stock_model.js）本就会挡，但**校验必须在服务端也成立**——
  // 否则任何绕过界面的调用都能留下一条"不知道为什么"的变动记录，事后对账查不出所以然。
  if (str(reason) === "") {
    throw new Error("出入库必须填写原因（plan §6：reason 必填；变动记录要能对账，FR-7.1）");
  }
  const part = library[idx];
  const before = toInt(part.quantity);
  const after = before + d;
  if (after < 0) {
    // 整条拒绝：不改变库存、不产生变动记录
    throw new Error(`库存不足：${str(part.value) || part.id} 当前 ${before}，本次出库 ${-d}（拒绝，库存未变）`);
  }
  part.quantity = after;
  part.updated_at = nowIso(options.now);
  const kind = options.kind || (d > 0 ? "in" : "out");
  // kind 与 delta 的方向必须自洽（审计发现：`kind:"out"` 配 `delta:+10` 会记成"出库却加多了库存"）。
  // adjust 是盘点修正，方向任意，所以只约束 in / out 两个方向性 kind。
  const expectedSign = { in: 1, out: -1 }[kind];
  if (expectedSign !== undefined && Math.sign(d) !== expectedSign) {
    throw new Error(`变动记录的方向自相矛盾：kind「${kind}」配 delta=${d}（${kind === "in" ? "入库" : "出库"}必须${expectedSign > 0 ? "为正" : "为负"}）`);
  }
  return {
    parts: library,
    movement: {
      part_id: part.id,
      kind,
      delta: d,
      before,
      after,
      reason: str(reason),
      ref: str(options.ref),
    },
  };
}

/* ============================================================ 按 BOM 领料 */

/**
 * 按 BOM 领料（plan §6 `stock:pick_by_bom` / spec FR-7.4、FR-7.5）。
 * - 库中**没有**的条目 → 列入 `unknown`（明确列出，不静默跳过）
 * - 库存不足 → 逐条列入 `insufficient`；`allow_partial=false` 时**整单拒绝且不产生任何变动**
 * - 所有扣减共用 `pick_id` 作 ref（AC-7：同一批次）
 * @param {Array<object>} items BOM 条目（只需 row_no/designators/quantity_per_board/…）
 * @param {number} sets 套数
 * @param {Array<object>} parts 当前库存
 * @param {{pick_id: string, reason?: string, allow_partial?: boolean, now?: Date}} options
 */
function pickByBom(items, sets, parts, options = {}) {
  const setCount = Number(sets);
  if (!Number.isInteger(setCount) || setCount < 1) {
    throw new Error(`套数必须是 ≥1 的整数（收到「${sets}」）`);
  }
  const pickId = str(options.pick_id);
  if (pickId === "") {
    throw new Error("pickByBom: 需要 options.pick_id（领料批次号由调用方生成，AC-7 要求同一批次 ref）");
  }
  // plan §6 把「原因」标为**必填**（spec FR-7.1「填写数量与原因」）——与 moveStock 同一套要求。
  // 审计发现：这里原来没校验，服务端能一次领料落库 35 条 reason:"" 的出库记录，
  // 而界面挡着，于是"界面拦了、服务端没拦"（违反 plan §6.4「校验在服务端做」）。
  if (!str(options.reason)) {
    throw new Error("领料必须填写原因（plan §6：reason 必填；变动记录要能对账，FR-7.1）");
  }
  const allowPartial = options.allow_partial === true;
  const reason = str(options.reason);
  const library = (Array.isArray(parts) ? parts : []).map(clone);
  // **与比对共用同一套"怎么算同一颗料"**（compare.buildLibraryIndex / findLibraryMatch）：
  // 判定键归一（封装 EDA↔立创写法）+ 型号兜底。否则会出现同一份 BOM：
  // 比对页说"够用"，按 BOM 领料却说"库里没有"——两个入口结论互相矛盾（实测跨来源数据就会这样）。
  const index = buildLibraryIndex(library);

  const unknown = [];
  const insufficient = [];
  const planned = [];
  /** 器件 id → 本批已规划扣减量（同判定键多行会指向同一器件，必须累计，见下面的注释） */
  const plannedByPart = new Map();

  for (const raw of items) {
    const item = raw || {};
    const required = toInt(item.quantity_per_board) * setCount;
    if (required <= 0) continue; // 需求 0：无可领
    const found = findLibraryMatch(index, item);
    if (!found) {
      unknown.push({
        row_no: item.row_no,
        part_number: str(item.manufacturer_part),
        value: str(item.value),
        footprint: str(item.footprint),
        required,
      });
      continue;
    }
    // entry.first 就是 library 里的那条器件对象（clone 后的），后续按它扣减/留痕
    const part = found.entry.first;
    // **同一判定键的多行必须累计着算**：一份 BOM 里两行同规格（不同位号/不同厂）完全合法，
    // 两行会指向同一个器件。若每行都拿"原始库存"去比，就会出现
    // 「各 10 个、库存 15 → 两行都判定为够，实际扣成 −5」——库存变负数，
    // 而且 allow_partial=false 的整单拒绝也拦不住（FR-7.2 直接被击穿）。
    // 所以这里按器件累计"本批已规划扣减"，只用**剩余可用量**做判断。
    const already = plannedByPart.get(part.id) || 0;
    const available = toInt(part.quantity) - already;
    const deducted = Math.max(0, Math.min(required, available));
    if (deducted < required) {
      // 报"有"的时候给的是**本轮可用量**（扣掉本批前面几行之后），
      // 否则错误信息会写成"需 22 有 15 缺 7"却其实只该缺 7 之外的部分，用户对不上账。
      insufficient.push({ part_id: part.id, required, stock: available, shortfall: required - available });
    }
    plannedByPart.set(part.id, already + deducted);
    planned.push({ part, required, stock: available, deducted });
  }

  if (!allowPartial && insufficient.length > 0) {
    // plan §6：只要有一条不足就整单拒绝，且不产生任何变动
    return {
      ok: false,
      error: `库存不足，整单拒绝（${insufficient.length} 条）：`
        + insufficient.map((x) => `${x.part_id} 需 ${x.required} 有 ${x.stock} 缺 ${x.shortfall}`).join("；"),
      pick_id: pickId,
      picked: [],
      insufficient,
      unknown,
      movements: [],
      parts: library,
    };
  }

  const picked = [];
  const movements = [];
  for (const plan of planned) {
    if (plan.deducted <= 0) continue;
    const before = toInt(plan.part.quantity);
    plan.part.quantity = before - plan.deducted;
    plan.part.updated_at = nowIso(options.now);
    picked.push({
      part_id: plan.part.id,
      part_number: str(plan.part.part_number),
      required: plan.required,
      deducted: plan.deducted,
      after: plan.part.quantity,
    });
    movements.push({
      part_id: plan.part.id,
      kind: "out",
      delta: -plan.deducted,
      before,
      after: plan.part.quantity,
      reason,
      ref: pickId, // AC-7：同一次领料的每条扣减共用同一批次号
    });
  }

  return { ok: true, error: "", pick_id: pickId, picked, insufficient, unknown, movements, parts: library };
}

/* ============================================================== 变动查询 */

/**
 * `movements:list` 的纯实现：按 part_id / ref 过滤，按时间**倒序**（plan §6.3）。
 *
 * 同一秒内的多条（很常见：一次导入里同一规格出现两行、或连续录入）光比 `at` 是平局，
 * 而 `Array.sort` 稳定会保留**插入顺序**（= 最旧在前），详情页看起来就是"历史倒着排错了"。
 * 因此平局时按**插入位置倒序**——后写入的更新，排前面。
 *
 * **排序必须按"真时间"而不是字符串**（审计发现）：`at` 是带时区偏移的 ISO 串，
 * 偏移不同时字符串大小顺序与真实先后**不一致**——
 * `2026-10-15T23:00:00+08:00`（= 15:00Z）比 `2026-10-15T16:00:00+00:00`（= 16:00Z）**早**，
 * 但字符串比较会把它排在前面。触发路径不需要用户做错事：**换台机器恢复备份**（备份来自别的时区）、
 * 或系统时区/DST 变化，库里就会混着两种偏移。
 */
function movementTime(value) {
  const parsed = Date.parse(str(value));
  return Number.isFinite(parsed) ? parsed : null;
}

function filterMovements(movements, filter = {}) {
  const list = Array.isArray(movements) ? movements : [];
  const partId = str(filter.part_id);
  const ref = str(filter.ref);
  const indexed = [];
  list.forEach((m, index) => {
    if (partId !== "" && str(m && m.part_id) !== partId) return;
    if (ref !== "" && str(m && m.ref) !== ref) return;
    indexed.push({ m, index });
  });
  indexed.sort((a, b) => {
    const ta = movementTime(a.m && a.m.at);
    const tb = movementTime(b.m && b.m.at);
    if (ta !== null && tb !== null && ta !== tb) return tb - ta; // 真时间倒序（跨时区也对）
    // 解析不出来的脏数据退回字符串比较：顺序至少是确定的、可复现的
    const byText = String(str(b.m && b.m.at)).localeCompare(String(str(a.m && a.m.at)));
    if (byText !== 0) return byText;
    return b.index - a.index; // 同一时间：后写入的排前面
  });
  return indexed.map((x) => x.m);
}

module.exports = {
  CATEGORY_PREFIXES,
  DEFAULT_CATEGORY,
  inferCategory,
  commitBom,
  nextPartId,
  moveStock,
  pickByBom,
  filterMovements,
};
