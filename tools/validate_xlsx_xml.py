# -*- coding: utf-8 -*-
"""validate_xlsx_xml.py — 用**独立的实现**校验一个 .xlsx 是否合规（T13b 的第三方判卷）

为什么需要它：本项目的 xlsx 读写器是**自己写的**（零依赖，见 docs/plan.md §10.1）。
自写读取器是**宽容的**——正则扫 XML，非法控制字符它照读不误；
而 Excel / 立创用的是**严格**解析器，遇到 XML 1.0 非法字符会直接判定"文件损坏"。
只用自己的读取器验自己的写出器，等于"两个错误互相作证"。

这里用 Python 标准库当**独立判卷人**：
  · `zipfile.testzip()` —— 逐条 CRC 校验（独立实现）
  · `xml.etree.ElementTree` —— 严格 XML 1.0 解析（独立实现）

用法：
    python tools/validate_xlsx_xml.py <file.xlsx> [more.xlsx ...]
退出码：0 = 全部合规；1 = 有问题（并打印问题所在的部件与原因）
"""
import io
import os
import sys
import zipfile
import xml.etree.ElementTree as ET


def validate(path):
    """返回问题列表（空 = 合规）"""
    problems = []
    if not os.path.isfile(path):
        return ["文件不存在：%s" % path]
    try:
        zf = zipfile.ZipFile(path)
    except zipfile.BadZipFile as exc:
        return ["不是合法 zip：%s" % str(exc)[:120]]
    with zf:
        bad_crc = zf.testzip()
        if bad_crc:
            problems.append("CRC 校验失败：%s" % bad_crc)
        names = zf.namelist()
        if not any(n.endswith("[Content_Types].xml") for n in names):
            problems.append("缺少 [Content_Types].xml")
        if not any(n.startswith("xl/worksheets/") for n in names):
            problems.append("缺少工作表部件（xl/worksheets/*.xml）")
        for name in names:
            if not (name.endswith(".xml") or name.endswith(".rels")):
                continue
            raw = zf.read(name)
            try:
                ET.fromstring(raw)
            except ET.ParseError as exc:
                problems.append("%s：XML 解析失败 —— %s" % (name, str(exc)[:140]))
    return problems


def main(argv):
    args = []
    out_path = None
    rest = list(argv[1:])
    while rest:
        item = rest.pop(0)
        if item == "--out":
            out_path = rest.pop(0) if rest else None
        else:
            args.append(item)
    if not args:
        sys.stderr.write(__doc__)
        return 2
    lines = []
    failed = 0
    for path in args:
        problems = validate(path)
        if problems:
            failed += 1
            lines.append("FAIL  %s" % path)
            for p in problems:
                lines.append("      · %s" % p)
        else:
            lines.append("PASS  %s（zip 结构 + 全部 XML 部件均通过独立解析器）" % os.path.basename(path))
    report = "\n".join(lines)
    print(report)
    # `--out` 让调用方（测试）能在**不捕获管道**的前提下读到结论
    # ——本机沙箱下 Node 的 child_process 管道 stdio 会 EPERM，只能用 inherit + 落文件。
    if out_path:
        with io.open(out_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(report + "\n")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
