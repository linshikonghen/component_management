# -*- coding: utf-8 -*-
"""Spec-doc consistency gate for 元器件管理 (docs/spec.md + docs/plan.md).

Verifies the DOCUMENTS' actual state, independently of any review opinion.

Originally written as a one-off for the v1.2 re-check (archived copy:
<协作工具目录>\\_archive\\tooling-20261014\\
component_management-probes-20261015\\_verify_v12.py). Promoted into tools/ and
made version-agnostic: hardcoding "v1.2" made the version check report a false
failure the moment the docs moved to v1.3.

Usage:
  E:\\python3.11.9\\python.exe tools\\verify_spec_docs.py
Exit code 0 = gate PASS, 1 = FAIL.
"""
from __future__ import annotations

import hashlib
import io
import os
import re

BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(BASE, "docs")

spec = io.open(os.path.join(D, "spec.md"), encoding="utf-8").read()
plan = io.open(os.path.join(D, "plan.md"), encoding="utf-8").read()

_ok = True


def chk(name: str, cond: bool, detail: str = "") -> None:
    global _ok
    _ok = _ok and bool(cond)
    print(("PASS  " if cond else "FAIL  ") + name + (("  -- " + detail) if detail else ""))


print("=== 1. 结构与编号 ===")
chk("FR 组 1..7 有序无重复",
    re.findall(r"^### (FR-\d+)", spec, re.M) == ["FR-%d" % i for i in range(1, 8)],
    str(re.findall(r"^### (FR-\d+)", spec, re.M)))
chk("AC 组连续有序无重复",
    re.findall(r"^### (AC-\d+)", spec, re.M) == ["AC-%d" % i for i in range(1, len(re.findall(r"^### (AC-\d+)", spec, re.M)) + 1)],
    str(re.findall(r"^### (AC-\d+)", spec, re.M)))
chk("§5 子节 5.1/5.2/5.3", re.findall(r"^### (5\.\d)", spec, re.M) == ["5.1", "5.2", "5.3"])
chk("§9 无错位 FR 块",
    not any(x in spec for x in ["### FR-2（新增）", "### FR-4.6（新增）"]))

print()
print("=== 2. 缺口语义（核心行为）===")
chk("spec 用 purchase_quantity", "purchase_quantity" in spec)
chk("spec 分组 = 够用/缺料", "够用" in spec and "缺料" in spec)
chk("plan 有 shortfall_quantity", "shortfall_quantity" in plan)
chk("plan 有 required/stock",
    "required_quantity" in plan and "stock_quantity" in plan)
chk("缺口公式表述正确",
    "max(0, 需求 − 库存)" in spec or "max(0, required − stock)" in plan)
chk("导出数量列不再是 total_quantity",
    "| `数量` | `total_quantity`" not in spec)
chk("缺口行为已由用户确认并冻结",
    "已确认此行为" in spec or "已冻结" in spec)

print()
print("=== 3. 契约完整性 ===")
for c in ["bom:parse", "bom:commit", "compare:run", "compare:export", "stock:move",
          "stock:pick_by_bom", "parts:list", "parts:save", "parts:delete",
          "movements:list", "settings:get", "settings:set", "data:backup", "data:restore"]:
    chk("  " + c, c in plan)
chk("CompareItem 已定义", "### CompareItem" in plan)
chk("export 用 mode 非 format",
    "| 请求 | mode |" in plan and "| 请求 | format |" not in plan)

print()
print("=== 4. 验收覆盖（严格展开斜杠简写）===")
sec7 = spec.split("## 7. 验收标准")[1].split("## 8. 导航映射")[0]
defined = sorted(set(re.findall(r"\| (FR-\d+\.\d+) \|", spec)))
cov: set[str] = set()
# "FR-1.1/1.2" and "FR-4.1/4.2" style shorthand
for m in re.finditer(r"FR-(\d+)\.(\d+)/(\d+)(?:\.(\d+))?", sec7):
    g, a, b, c = m.groups()
    cov.add("FR-%s.%s" % (g, a))
    cov.add("FR-%s.%s" % (g, c if c else b))
for m in re.finditer(r"FR-(\d+\.\d+)", sec7):
    cov.add("FR-%s" % m.group(1))
# "FR-7.2：" inline label form
for m in re.finditer(r"FR-(\d+\.\d+)：", sec7):
    cov.add("FR-%s" % m.group(1))
miss = [f for f in defined if f not in cov]
chk("%d 条 FR 全覆盖" % len(defined), not miss,
    ("缺失: " + str(miss)) if miss else "0 缺口")
print("      已定义 %d 条，验收引用覆盖 %d 条" % (len(defined), len(cov)))

print()
print("=== 5. 版本与陈旧引用 ===")
# version-agnostic: both docs must AGREE, and must not still be the draft.
m_spec = re.search(r"版本：\*\*(v[\d.]+)\*\*", spec)
m_plan = re.search(r"版本：\*\*(v[\d.]+)\*\*", plan)
chk("spec 声明版本号", bool(m_spec), m_spec.group(1) if m_spec else "未找到")
chk("plan 声明版本号", bool(m_plan), m_plan.group(1) if m_plan else "未找到")
chk("spec/plan 版本一致",
    bool(m_spec and m_plan and m_spec.group(1) == m_plan.group(1)),
    "%s vs %s" % (m_spec.group(1) if m_spec else "?",
                  m_plan.group(1) if m_plan else "?"))
chk("版本非初稿 v1.0", bool(m_spec and m_spec.group(1) != "v1.0"))
chk("无 v1.0（初稿）残留",
    "v1.0（初稿）" not in spec and "v1.0（初稿）" not in plan)
chk("无过时指向 §9", "下面 §9 会请你确认" not in spec)
chk("§5.3 唯一", spec.count("### 5.3 预置分类表") == 1)
# changelog must mention the declared version
if m_spec:
    chk("spec 沿革含当前版本", ("| **%s** |" % m_spec.group(1)) in spec)
if m_plan:
    chk("plan 变更记录含当前版本", ("**%s** |" % m_plan.group(1)) in plan)

print()
print("=== 6. v1.3 遗留项（入口隔离 / xlsx 写入 / 版本控制）===")
chk("spec FR-7.6 入口隔离", "| FR-7.6 |" in spec and "领料是独立入口" in spec)
chk("plan §10.1 xlsx 写入风险建章", "### 10.1 未验证环节" in plan)
chk("plan 有 .csv 回退方案", ".csv" in plan and "回退" in plan)
chk("plan §10.2 版本控制现状", "### 10.2 版本控制" in plan)
chk("plan 含 T13d 外部验收", "T13d" in plan)
chk("plan 标注关键路径", "关键路径" in plan)

print()
print("=== 7. 开工阶段（阶段自适应，原「未开工确认」）===")
# v1.6（实现期）：本节原先硬断言「未创建 src/renderer/data/tests」——开工第一步建 src/
# 就会让门禁报 FAIL。那是**假失败**（文档没坏），会让「跑门禁确认现场」失去意义。
# 改为阶段自适应：未开工时保持原否定断言（强度不变）；已开工时改判 plan §8 结构存在性，
# 并新增两项「只有开工后才可能违反」的硬约束校验（零 npm 依赖、运行时数据不入库）。
# 注意：本改动**不放松**任何文档类断言（§1~§6、§8~§9 原样）。
STARTED = os.path.isdir(os.path.join(BASE, "src"))
if not STARTED:
    print("      阶段：未开工")
    for d in ["src", "renderer", "data", "tests"]:
        chk("  未创建 %s/" % d, not os.path.exists(os.path.join(BASE, d)))
else:
    print("      阶段：已开工（src/ 已存在）")
    svc = os.path.join(BASE, "src", "services")
    chk("  src/services/ 含实现文件（plan §8 业务层）",
        os.path.isdir(svc) and any(f.endswith(".js") for f in os.listdir(svc)))
    chk("  tests/ 已建（禁跳过测试改核心逻辑）",
        os.path.isdir(os.path.join(BASE, "tests")))
    # 零 npm 依赖（AGENTS.md 硬约束）：除 .mimocode/（MiMo 运行时，非本项目依赖）
    # 与 .git/ 外，不得存在 node_modules/
    found_nm = []
    for dirpath, dirnames, _ in os.walk(BASE):
        parts = os.path.relpath(dirpath, BASE).split(os.sep)
        if ".mimocode" in parts or ".git" in parts:
            dirnames[:] = []
            continue
        if "node_modules" in dirnames:
            found_nm.append(os.path.relpath(os.path.join(dirpath, "node_modules"), BASE))
            dirnames.remove("node_modules")
    chk("  零 npm 依赖（无 node_modules/）", not found_nm, str(found_nm))
    pkg = os.path.join(BASE, "package.json")
    declared = []
    if os.path.exists(pkg):
        import json as _json
        try:
            _pkg = _json.load(io.open(pkg, encoding="utf-8"))
            declared = sorted(set(_pkg.get("dependencies") or {})
                              | set(_pkg.get("devDependencies") or {}))
        except Exception as exc:  # package.json 坏了也要报，不能静默通过
            declared = ["<package.json 解析失败: %s>" % exc]
    chk("  除 Electron 外无第三方依赖声明", not declared, str(declared))
    _gi = os.path.join(BASE, ".gitignore")
    _gtxt = io.open(_gi, encoding="utf-8").read() if os.path.exists(_gi) else ""
    chk("  运行时数据不入库（.gitignore 含 data/）", "/data/" in _gtxt or "data/" in _gtxt)

print()
print("=== 8. 历史编号仅存在于沿革说明 ===")
for i, line in enumerate(spec.splitlines(), 1):
    if "FR-2.9" in line:
        is_hist = ("FR-2.9~2.13" in line) and any(
            k in line for k in ["独立成组", "移出", "结构修订", "原 FR-2.9"])
        print("  L%-4d %-10s %s" % (i, "[沿革]" if is_hist else "[活引用!]",
                                    line.strip()[:74]))
        if not is_hist:
            _ok = False

print()
print("=== 9. 文档指纹 ===")
for n in ["spec.md", "plan.md"]:
    p = os.path.join(D, n)
    h = hashlib.sha256(open(p, "rb").read()).hexdigest()
    print("  %-9s %6d 字节  sha256=%s" % (n, os.path.getsize(p), h[:16]))

print()
print("gate:", "PASS" if _ok else "FAIL")
raise SystemExit(0 if _ok else 1)
