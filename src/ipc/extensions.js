"use strict";
/**
 * extensions.js — **契约扩展登记表**
 *
 * 为什么需要这份文件：plan §6 的 IPC 契约是冻结的（AGENTS.md：改字段名=破坏前后端约定），
 * 但实现过程中会撞上几种情况——spec 要求的能力在契约里**没有载体**（如 FR-5.5 导出当前库），
 * 或者某个字段语义上必须传、契约里却没写（如 `confirm_data_dir`）。
 *
 * 这些扩展不能"悄悄加上就完事"：那样 plan §6 就不再是唯一信源，下一个人读契约会被误导。
 * 所以统一登记在这里，一处可见，并且：
 *   · `tests/test_ipc_handlers.js` 用 `CHANNELS == plan §6 ∪ 登记的新增通道` 来断言——
 *     任何人加通道而不登记，测试立刻红；
 *   · 每条都写清 spec 出处、为什么必须加、以及**待并入 plan §6 的任务号**（`T_388b0941`）。
 *
 * 本文件**不改 plan.md**（plan 正在评审中）；等 T3 评审落定、T5 统一修订时并入。
 * 并入之后，对应的登记项应从这里删掉——**登记表是过渡态，不是长期方案**。
 */

/**
 * 超出 plan §6 通道清单的**新增通道**。
 *
 * **当前为空**：唯一一条 `parts:export` 已在 **v1.5（实现期补记 2）并入 plan §6**，
 * 按本文件的约定——**并入之后必须把登记项删掉**（登记表是过渡态，不是长期方案）。
 *
 * 机制保留：以后再有"必须越界"的通道，仍在这里登记，
 * `tests/test_ipc_handlers.js` 会断言「实际通道 == plan §6 ∪ 登记表」，
 * 加通道而不登记 / 登记了却没实现 / 已并入却还挂着，三种情况都会红。
 *
 * 历史（已并入，留作追溯）：
 *   `parts:export`  ← FR-5.5 / AC-5 第 5 行（导出当前库，条数与库中一致）  2026-10-15 并入 §6.3
 */
const CHANNEL_EXTENSIONS = [];

/**
 * 契约内通道上的**字段级扩展**。
 *
 * **当前为空**：4 处已在 **v1.5（实现期补记 2）** 写进 plan §6 与 §6.5：
 *   · `parts:list.sort_by / sort_dir`      ← FR-5.1（列表按任意关键信息列排序）
 *   · `settings:set.confirm_data_dir`      ← AGENTS.md「更改数据目录位置」属需人工确认操作
 *   · `bom:commit.sets / source / reason`  ← FR-1.8（能看出这批是哪份 BOM）与 v1.4 留痕要求
 *   · `compare:export.include_uncertain`   ← **本来就在 §6.2 里**，实现期曾误登记为扩展，已更正
 */
const FIELD_EXTENSIONS = [];

/** 新增通道的名单（测试与文档都用它，避免两处各写一份） */
const EXTENSION_CHANNELS = CHANNEL_EXTENSIONS.map((e) => e.channel);

/** 全部扩展的扁平清单，便于打表 */
function listExtensions() {
  return [
    ...CHANNEL_EXTENSIONS.map((e) => ({ kind: "通道", where: e.channel, what: "(新增通道)", spec: e.spec_ref, merge: e.merge_task })),
    ...FIELD_EXTENSIONS.map((e) => ({ kind: "字段", where: e.channel, what: e.field, spec: e.spec_ref, merge: e.merge_task })),
  ];
}

module.exports = { CHANNEL_EXTENSIONS, FIELD_EXTENSIONS, EXTENSION_CHANNELS, listExtensions };
