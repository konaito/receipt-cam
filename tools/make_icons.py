# /// script
# requires-python = ">=3.11"
# ///
"""アイコン（白地に領収書の形）を標準ライブラリだけで PNG に書き出す。uv run tools/make_icons.py"""
import struct
import zlib
from pathlib import Path


def png(size: int) -> bytes:
    s = size / 512
    def inside(x, y):
        # 用紙（中央 50%、マスカブルの安全域に収める）
        if not (160 * s <= x < 352 * s and 120 * s <= y < 392 * s):
            return None
        # 文字の行
        for top in (170, 215, 260):
            if 190 * s <= x < 322 * s and top * s <= y < (top + 16) * s:
                return (250, 250, 250)
        if 250 * s <= x < 322 * s and 320 * s <= y < 344 * s:
            return (250, 250, 250)
        return (31, 31, 31)
    rows = bytearray()
    for y in range(size):
        rows.append(0)
        for x in range(size):
            rows.extend(inside(x, y) or (250, 250, 250))
    chunk = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(bytes(rows), 9)) + chunk(b"IEND", b""))


root = Path(__file__).resolve().parent.parent / "app"
for n in (192, 512):
    (root / f"icon-{n}.png").write_bytes(png(n))
