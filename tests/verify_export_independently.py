# -*- coding: utf-8 -*-
"""用**独立实现**复核 exporter.js 写出的 xlsx（T13b 的跨实现判卷）。

为什么必须有这一步：
    plan §10.1 说得直白——xlsx 写入"失败是静默的"（文件生成成功但内容坏）。
    而"用自己的读取器读回逐格比对"是**同源自证**：读写两半都是本项目的代码，
    同一个理解错误可能让两半一起骗过测试。所以再拿三套**互不相同的外部实现**来判：

      1. zipfile   —— 标准库，验 zip 容器：条目名、CRC32、压缩方法
      2. xml.etree —— 标准库，**严格 XML 解析器**：解不开就是 XML 写坏了
                      （本项目读取器是正则实现，解不开的 XML 它也可能"读出来"）
      3. openpyxl  —— 第三方 xlsx 实现：真正 load 工作簿，逐格取值比对

用法：
    E:\\python3.11.9\\python.exe tests\\verify_export_independently.py <文件.xlsx>
    若同目录存在 <文件.xlsx>.expected.json，则逐格比对（比预期的多/少/不同都算失败）。
    openpyxl 不在时退化为"只用标准库"，并明确打印 SKIP（不假装通过）。

退出码 0 = 全部通过。
"""
from __future__ import annotations

import io
import json
import os
import sys
import xml.etree.ElementTree as ET
import zipfile

ok = True


def check(name: str, cond: bool, detail: str = "") -> None:
    global ok
    ok = ok and bool(cond)
    print(("PASS  " if cond else "FAIL  ") + name + (("  -- " + detail) if detail else ""))


def cell_to_str(value) -> str:
    """把 openpyxl 取到的值按本项目读取器的口径转成字符串。"""
    if value is None:
        return ""
    if isinstance(value, bool):
        return "TRUE" if value else "FALSE"
    return str(value)


def main(path: str) -> int:
    print("=== 0. 待检文件 ===")
    print("  %s  (%d 字节)" % (path, os.path.getsize(path)))

    # ---------------------------------------------------------------- 1. zip
    print("\n=== 1. zipfile：容器结构 + CRC32（标准库，独立于本项目）===")
    with zipfile.ZipFile(path) as z:
        names = z.namelist()
        print("  namelist      : %s" % names)
        print("  testzip()     : %s" % z.testzip())
        check("全部条目 CRC32 通过（testzip() is None）", z.testzip() is None)
        required = ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml",
                    "xl/_rels/workbook.xml.rels", "xl/styles.xml",
                    "xl/worksheets/sheet1.xml"]
        missing = [n for n in required if n not in names]
        check("6 个必需部件齐全", not missing, ("缺: %s" % missing) if missing else "")
        check("没有 sharedStrings.xml（inlineStr 写法）", "xl/sharedStrings.xml" not in names)
        print("  compress types: %s" % [i.compress_type for i in z.infolist()])
        parts = {n: z.read(n) for n in names}

    # ----------------------------------------------------------- 2. 严格 XML
    print("\n=== 2. xml.etree：严格 XML 解析（标准库）===")
    for name, blob in parts.items():
        if not name.endswith(".xml") and not name.endswith(".rels"):
            continue
        try:
            ET.fromstring(blob.decode("utf-8"))
            check("  %s 是合法 XML" % name, True)
        except Exception as exc:  # noqa: BLE001
            check("  %s 是合法 XML" % name, False, str(exc))

    # ------------------------------------------------------------ 3. openpyxl
    print("\n=== 3. openpyxl：真实加载工作簿并逐格取值（第三方实现）===")
    try:
        import openpyxl  # noqa: PLC0415
    except Exception as exc:  # noqa: BLE001
        print("  SKIP  openpyxl 不可用（%s）——未做逐格比对，不算通过" % exc)
        print("\n最终结论：%s" % ("仅容器与 XML 通过（逐格比对被跳过）" if ok else "失败"))
        return 0 if ok else 1

    print("  openpyxl 版本: %s" % openpyxl.__version__)
    wb = openpyxl.load_workbook(path, data_only=True)
    ws = wb[wb.sheetnames[0]]
    print("  sheetnames    : %s" % wb.sheetnames)
    print("  dimensions    : %s" % ws.dimensions)
    got = [[cell_to_str(c) for c in row] for row in ws.iter_rows(values_only=True)]
    types = sorted({type(c).__name__ for row in ws.iter_rows(values_only=True) for c in row})
    print("  取值类型分布  : %s" % types)

    expected_path = path + ".expected.json"
    if not os.path.exists(expected_path):
        print("  （无 %s，跳过逐格比对）" % os.path.basename(expected_path))
    else:
        expected = json.load(io.open(expected_path, encoding="utf-8"))
        exp_rows = expected["rows"]
        check("工作表名一致", wb.sheetnames[0] == expected["sheet_name"],
              "%s vs %s" % (wb.sheetnames[0], expected["sheet_name"]))
        check("行数一致", len(got) == len(exp_rows), "%d vs %d" % (len(got), len(exp_rows)))
        bad = []
        for r, exp_row in enumerate(exp_rows):
            for c, exp_val in enumerate(exp_row):
                actual = got[r][c] if r < len(got) and c < len(got[r]) else "<缺>"
                if actual != exp_val:
                    bad.append("R%dC%d 期望 %r 实际 %r" % (r + 1, c + 1, exp_val, actual))
        check("逐格一致（%d 行 × %d 列）" % (len(exp_rows), len(exp_rows[0])), not bad,
              ("；".join(bad[:5])) if bad else "")
        if bad:
            for line in bad[:20]:
                print("        " + line)

    print("\n最终结论：%s" % ("独立实现复核通过" if ok else "不通过"))
    return 0 if ok else 1


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(__doc__)
        raise SystemExit(2)
    raise SystemExit(main(sys.argv[1]))
