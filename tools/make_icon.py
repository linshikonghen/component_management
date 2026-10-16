#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_icon.py — 生成 assets/icon.ico（零依赖，只用标准库 struct）

为什么自己画图标：这是个离线项目（AGENTS.md：不联网、不装包），
图标也得自己产出。ICO 是最简单的容器格式之一，不必依赖 Pillow。

格式要点（自己拼字节，所以写清楚）：
  ICONDIR      6 字节：reserved=0, type=1, count=N
  ICONDIRENTRY 16 字节/个：宽, 高, 调色板数, 保留, 平面数=1, 位深=32, 数据长度, 数据偏移
  图像数据      BITMAPINFOHEADER(40) + BGRA 像素（**自下而上**）+ AND 掩码（1bpp，每行 4 字节对齐）
  宽/高填 0 表示 256（本脚本不出 256：那会写 BMP 而非 PNG，体积大且没必要）

用法： python tools/make_icon.py            # 写到 assets/icon.ico
       python tools/make_icon.py out.ico    # 指定输出
"""

import os
import struct
import sys

# 配色
BG = (0x1D, 0x4E, 0xD8)      # 主色（与界面 --accent 一致）
BG_EDGE = (0x17, 0x3C, 0xA8)  # 描边
BODY = (0xF3, 0xF4, 0xF6)     # 芯片本体
PIN = (0x93, 0xC5, 0xFD)      # 引脚

SIZES = (16, 32, 48)


def rounded_alpha(x, y, size, radius):
    """圆角方块的覆盖率（0~255）。用 4x4 超采样做抗锯齿，纯算术、不依赖绘图库。"""
    hits = 0
    for sy in range(4):
        for sx in range(4):
            px = x + (sx + 0.5) / 4.0
            py = y + (sy + 0.5) / 4.0
            cx = min(max(px, radius), size - radius)
            cy = min(max(py, radius), size - radius)
            dx = px - cx
            dy = py - cy
            if dx * dx + dy * dy <= radius * radius:
                hits += 1
    return int(round(hits * 255 / 16.0))


def pixel(x, y, size):
    """返回 (B, G, R, A)。几何图形：圆角蓝底 + 中间浅色芯片 + 两侧引脚。"""
    radius = max(2.0, size * 0.22)
    alpha = rounded_alpha(x, y, size, radius)
    if alpha == 0:
        return (0, 0, 0, 0)

    # 芯片本体：居中矩形，占 46% ~ 62%（不同尺寸下都好看）
    body_x0, body_x1 = size * 0.30, size * 0.70
    body_y0, body_y1 = size * 0.26, size * 0.74
    color = BG
    if body_x0 <= x < body_x1 and body_y0 <= y < body_y1:
        color = BODY
        # 本体左上留一点高光，看着不像纯色块
        if x < body_x0 + size * 0.08 and y < body_y0 + size * 0.08:
            color = (0xFF, 0xFF, 0xFF)

    # 引脚：本体两侧各三条
    pin_len = size * 0.16
    pin_h = max(1.0, size * 0.08)
    for i in range(3):
        cy = size * (0.32 + i * 0.18)
        if abs(y + 0.5 - cy) < pin_h / 2:
            if body_x1 <= x < body_x1 + pin_len or body_x0 - pin_len < x < body_x0:
                color = PIN

    # 外圈描边
    if alpha > 0 and (x < size * 0.06 or y < size * 0.06 or x > size * 0.94 or y > size * 0.94):
        color = BG_EDGE

    # 注意字节序：ICO 里的 BMP 段是 **BGRA**，不是 RGBA。
    # （第一版这里返回了 (r,g,b,a)，结果蓝色底画出来是橙的——R/B 互换了。）
    r, g, b = color
    return (b, g, r, alpha)


def image_bytes(size):
    """一张图的 BITMAPINFOHEADER + BGRA + AND 掩码"""
    header = struct.pack(
        "<IiiHHIIiiII",
        40,            # biSize
        size,          # biWidth
        size * 2,      # biHeight（= 2×高，XOR + AND）
        1,             # biPlanes
        32,            # biBitCount
        0,             # biCompression = BI_RGB
        size * size * 4,  # biSizeImage
        0, 0, 0, 0,
    )
    rows = []
    for y in range(size - 1, -1, -1):  # 自下而上
        row = bytearray()
        for x in range(size):
            b, g, r, a = pixel(x, y, size)
            row += bytes((b, g, r, a))
        rows.append(bytes(row))
    xor = b"".join(rows)

    # AND 掩码：32bpp 下靠 alpha，掩码全 0；每行按 4 字节对齐
    stride = ((size + 31) // 32) * 4
    and_mask = b"\x00" * (stride * size)
    return header + xor + and_mask


def build_ico(sizes=SIZES):
    images = [image_bytes(s) for s in sizes]
    out = bytearray()
    out += struct.pack("<HHH", 0, 1, len(sizes))
    offset = 6 + 16 * len(sizes)
    for size, data in zip(sizes, images):
        out += struct.pack(
            "<BBBBHHII",
            size if size < 256 else 0,
            size if size < 256 else 0,
            0, 0, 1, 32,
            len(data),
            offset,
        )
        offset += len(data)
    for data in images:
        out += data
    return bytes(out)


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "icon.ico")
    os.makedirs(os.path.dirname(target), exist_ok=True)
    data = build_ico()
    with open(target, "wb") as handle:
        handle.write(data)
    print("已生成 %s（%d 字节，含尺寸 %s）" % (target, len(data), ", ".join(str(s) for s in SIZES)))


if __name__ == "__main__":
    main()
