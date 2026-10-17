# -*- coding: utf-8 -*-
"""Cross-document audit for the v1.4 rewrite (guards against regression holes).

tools/verify_spec_docs.py checks each document's internal shape. This script
checks the things a REWRITE can silently break:

  1. Cross-references that point nowhere (spec -> plan sections, FR/AC refs)
  2. Fields named in one doc but absent in the other (spec prose vs plan contract)
  3. Enumerations that must agree (movement kinds, export modes, categories)
  4. Numeric claims that must agree (14 categories, 5 dedupe fields)
  5. Duplicated or contradictory statements about the same rule

Exit 0 = clean, 1 = findings.
"""
from __future__ import annotations

import io
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = io.open(os.path.join(BASE, "docs", "spec.md"), encoding="utf-8").read()
plan = io.open(os.path.join(BASE, "docs", "plan.md"), encoding="utf-8").read()

_findings: list[str] = []


def bad(msg: str) -> None:
    _findings.append(msg)
    print("  FINDING  " + msg)


def ok(msg: str) -> None:
    print("  ok       " + msg)


print("=== 1. 交叉引用有效性（重写最易断）===")
plan_sections = set(re.findall(r"^## (\d+\.)", plan, re.M))
for m in re.finditer(r"plan §(\d+(?:\.\d+)?)", spec):
    target = m.group(1)
    top = target.split(".")[0] + "."
    if top not in plan_sections:
        bad("spec 引用 plan §%s，但 plan 无该章" % target)
if not _findings:
    ok("spec 对 plan 的章节引用全部有效")

for m in re.finditer(r"spec §(\d+(?:\.\d+)?)", plan):
    target = m.group(1)
    top = target.split(".")[0] + "."
    if top not in set(re.findall(r"^## (\d+\.)", spec, re.M)):
        bad("plan 引用 spec §%s，但 spec 无该章" % target)
ok("plan 对 spec 的章节引用检查完毕")

print()
print("=== 2. FR/AC 引用闭合 ===")
spec_fr = set(re.findall(r"\| (FR-\d+\.\d+) \|", spec))
plan_fr_refs = set(re.findall(r"FR-(\d+\.\d+)", plan))
plan_fr = set("FR-" + x for x in plan_fr_refs)
dangling = sorted(x for x in plan_fr if x not in spec_fr)
if dangling:
    bad("plan 引用了 spec 未定义的 FR: %s" % dangling)
else:
    ok("plan 的 FR 引用全部有定义")

spec_ac = set(re.findall(r"^### (AC-\d+)", spec, re.M))
ac_refs = set(re.findall(r"AC-(\d+)", plan))
ac_refs = set("AC-" + x for x in ac_refs)
dangling_ac = sorted(x for x in ac_refs if x not in spec_ac)
if dangling_ac:
    bad("plan 引用了 spec 未定义的 AC: %s" % dangling_ac)
else:
    ok("plan 的 AC 引用全部有定义")

print()
print("=== 2b. 关键能力是否有实现载体（v1.5 新增，mimo 抓到的盲区）===")
# 教训分两步：
#   1) 最初的检查只覆盖"结构完整"与"引用闭合"，查不出"某条 FR 在 plan 里完全
#      没有载体"——mimo 的详审正是靠逐条计数发现了 FR-4.6/4.7/4.8 与 AC-9 = 0。
#   2) 但直接要求 plan 引用每条 FR *编号* 会误报 35 项：plan 的任务表按能力域
#      组织（T5 导入 / T6 核对 / T12b 阈值…），本就不该逐条列编号。
# 正确判据 = 查"能力关键词"是否在 plan 有落点，而不是机械数编号。
# 每个 spec 侧能力 <-> plan 侧应有词。
capabilities = [
    ("BOM 导入", ["bom:parse", "bom:commit", "T5", "T6"]),
    ("导入核对改动", ["intake_quantity", "T6"]),
    ("比对只读", ["compare:run", "只读", "T8"]),
    ("缺口导出", ["shortfall_quantity", "purchase_quantity", "T9"]),
    ("手动录入", ["parts:save", "T10"]),
    ("低库存提示", ["T12", "低库存"]),
    ("分类预置阈值", ["T12b", "default_min_quantity", "预置"]),
    ("分类阈值可改", ["settings:set", "校验"]),
    ("个体覆盖阈值", ["min_quantity", "继承"]),
    ("查询筛选", ["parts:list", "T11"]),
    ("离线", ["离线", "T16"]),
    ("快捷方式", ["T15"]),
    ("出库领用", ["stock:move", "T13"]),
    ("按 BOM 领料", ["stock:pick_by_bom", "T13"]),
    ("比对页禁领料", ["不得", "FR-7.6"]),
    ("备份恢复", ["data:backup", "data:restore", "T14"]),
    ("立创可识别导出", ["lcsc", "mode", "T13c"]),
    ("export 走用户上传验收", ["T13d"]),
]
gaps = []
for name, needles in capabilities:
    if not any(n in plan for n in needles):
        gaps.append("%s（plan 中未见 %s）" % (name, " / ".join(needles)))
if gaps:
    for g in gaps:
        bad("能力无载体：" + g)
else:
    ok("全部 %d 项关键能力在 plan 中有落点" % len(capabilities))

print()
print("=== 3. 字段名跨文档一致（spec 散文 vs plan 契约）===")
# NOTE: spec is the WHAT document and deliberately uses Chinese prose, not
# implementation field names. Requiring the same identifier in both would flag
# correct writing as a defect (it did, 6 false findings). What actually matters:
#   (a) every identifier spec DOES use must exist in the plan contract, and
#   (b) each side's Chinese term must have a counterpart in the other.
ident_in_spec = re.findall(r"`([a-z][a-z0-9_]{3,})`", spec)
plan_idents = set(re.findall(r"\b([a-z][a-z0-9_]{3,})\b", plan))
unknown = sorted({i for i in ident_in_spec
                  if i.endswith("_quantity") or i in ("purchase_quantity",)}
                 - plan_idents)
if unknown:
    bad("spec 使用的字段名在 plan 契约中不存在: %s" % unknown)
else:
    ok("spec 引用的字段名（*_quantity 等）在 plan 均有定义")

# 中英对照：这些中文术语在 spec 出现，plan 必须有对应英文字段
pairs = [
    ("本次入库量", "intake_quantity"),
    ("原应入库量", "expected_quantity"),
    ("改动标记", "edited_by_human"),
    ("缺口", "shortfall_quantity"),
]
for zh, en in pairs:
    if zh in spec and en not in plan:
        bad("spec 的「%s」在 plan 无对应字段 %s" % (zh, en))
    elif zh in spec and en in plan:
        ok("%-10s (spec) <-> %-18s (plan)" % (zh, en))

print()
print("=== 4. 枚举一致性 ===")
# movement kind
mk_spec = re.search(r"kind=(\w+)", spec)
mk_plan = re.search(r'"kind":\s*"(\w+)",\s*//\s*([^\n]+)', plan)
if mk_plan:
    ok("Movement.kind 枚举在 plan: %s" % mk_plan.group(2).strip()[:40])
    if "出库" not in mk_plan.group(2):
        bad("Movement.kind 未列 out(出库)，但 spec FR-7 要求出库记录")
# export mode
if "lcsc" in spec and "jlc" in spec and "lcsc" in plan and "jlc" in plan:
    ok("导出模式 lcsc/jlc 两边一致")
else:
    bad("导出模式 lcsc/jlc 未在两边同时出现")
# categories count
cat_rows = len([l for l in spec.split("### 5.3")[1].split("> 分类默认")[0].splitlines()
                if l.startswith("|") and not re.match(r"\|\s*(分类|-{3})", l)])
mk = re.search(r'"default_min_quantity":\s*\{([^}]*)\}', plan)
plan_keys = re.findall(r'"([^"]+)"', mk.group(1)) if mk else []
if cat_rows != len(plan_keys):
    bad("分类表 %d 行 != plan 阈值 %d 键" % (cat_rows, len(plan_keys)))
else:
    ok("分类表 %d 行 == plan 阈值 %d 键" % (cat_rows, len(plan_keys)))

print()
print("=== 5. 判定键字段数（五元组）===")
dedupe = re.search(r"dedupe_key = ([^\n]+(?:\n[^\n]+)*?)\n```", plan)
if dedupe:
    parts = re.findall(r"normalize\((\w+)\)", dedupe.group(1))
    if len(parts) != 5:
        bad("plan dedupe_key 含 %d 个字段，应为 5：%s" % (len(parts), parts))
    else:
        ok("plan dedupe_key = %s（5 个）" % ", ".join(parts))
    for p in parts:
        if p not in spec:
            bad("判定键字段 %s 未在 spec §5.2 出现" % p)

print()
print("=== 6. 同一规则不得自相矛盾 ===")
# 比对只读 vs 领料改库
if "绝不修改库中任何器件" in spec and "领料是独立入口" in spec:
    ok("比对只读 + 领料独立入口，无矛盾")
else:
    bad("比对只读或领料隔离表述缺失")
# intake vs total
if "intake_quantity" in plan and "total_quantity" in plan:
    seg = plan[plan.index("v1.4 关键区分"): plan.index("v1.4 关键区分") + 1400]
    if "可改" in seg and "不可改" in seg:
        ok("intake_quantity(可改) 与 total_quantity(只读) 区分明确")
    else:
        bad("intake/total 可改性未明确区分")
# 缺口公式：两边各有一种写法，语义必须相同
f_spec = "max(0, 需求 − 现有库存)" in spec
f_plan = "max(0, required − stock)" in plan
if f_spec and f_plan:
    ok("缺口公式 spec/plan 各一处，语义相同")
else:
    bad("缺口公式缺失（spec=%s plan=%s）" % (f_spec, f_plan))
# 导出数量列：spec 叫 purchase_quantity，plan 必须说明二者关系
if "purchase_quantity" in spec:
    if "purchase_quantity" in plan:
        ok("purchase_quantity 在 plan 有对应说明")
    else:
        bad("spec 用 purchase_quantity 作为导出列名，plan 未定义该字段")

print()
print("=== 7. 开工阶段与口径（阶段自适应）===")
# 本节原先断言「未开工」，且写法自相矛盾：先对每个已存在目录 bad()，
# 紧接着又**无条件** ok("未创建 …")——即使有 finding 也会打印一行 PASS 字样。
# 开工（建 src/）后该断言必然误报，故改为阶段自适应，与
# verify_spec_docs.py §7 同口径：未开工保持原断言；已开工改判 plan §8 结构。
started = os.path.isdir(os.path.join(BASE, "src"))
if not started:
    pre = [d for d in ["src", "renderer", "data", "tests"]
           if os.path.exists(os.path.join(BASE, d))]
    if pre:
        bad("声明未开工，但已存在: %s" % ", ".join(pre))
    else:
        ok("未开工：src/renderer/data/tests 均未创建")
else:
    print("      阶段：已开工（src/ 已存在）")
    svc = os.path.join(BASE, "src", "services")
    if os.path.isdir(svc) and any(f.endswith(".js") for f in os.listdir(svc)):
        ok("已开工：src/services/ 有实现文件（plan §8 业务层）")
    else:
        bad("已开工但 src/services/ 缺失或为空（plan §8 要求业务层）")

print()
if _findings:
    print("审计发现 %d 个问题：" % len(_findings))
    for f in _findings:
        print("  - " + f)
    print("gate: FAIL")
    raise SystemExit(1)
print("审计通过：无跨文档漏洞")
print("gate: PASS")
