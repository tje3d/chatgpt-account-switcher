#!/usr/bin/env python3
"""Generate the extension icons as PNGs without any third-party dependency.

The mark is two overlapping circles (two accounts) on a rounded dark tile.
Rendered at 4x and box-downsampled for smooth edges.
"""

import os
import struct
import zlib

SS = 4
BG = (14, 17, 23, 255)
WHITE = (232, 237, 242, 255)
GREEN = (16, 163, 127, 255)


def rounded_rect_alpha(x, y, size, radius):
    """Return 1.0 inside the rounded square, 0.0 outside (point sample)."""
    cx = min(max(x, radius), size - radius)
    cy = min(max(y, radius), size - radius)
    dx = x - cx
    dy = y - cy
    return 1.0 if dx * dx + dy * dy <= radius * radius else 0.0


def circle_alpha(x, y, cx, cy, r):
    dx = x - cx
    dy = y - cy
    return 1.0 if dx * dx + dy * dy <= r * r else 0.0


def over(dst, src, alpha):
    if alpha <= 0:
        return dst
    return tuple(
        int(round(src[i] * alpha + dst[i] * (1 - alpha))) for i in range(4)
    )


def render(size):
    big = size * SS
    radius = big * 0.22
    c1 = (big * 0.40, big * 0.40, big * 0.205)
    c2 = (big * 0.61, big * 0.61, big * 0.205)

    rows = []
    for y in range(big):
        row = bytearray()
        for x in range(big):
            px = (0, 0, 0, 0)
            if rounded_rect_alpha(x + 0.5, y + 0.5, big, radius):
                px = BG
                px = over(px, WHITE, circle_alpha(x + 0.5, y + 0.5, *c1))
                px = over(px, GREEN, circle_alpha(x + 0.5, y + 0.5, *c2))
            row.extend(px)
        rows.append(row)

    # Box downsample by SS.
    out = []
    for y in range(size):
        line = bytearray()
        for x in range(size):
            r = g = b = a = 0
            for sy in range(SS):
                source = rows[y * SS + sy]
                for sx in range(SS):
                    i = (x * SS + sx) * 4
                    r += source[i]
                    g += source[i + 1]
                    b += source[i + 2]
                    a += source[i + 3]
            n = SS * SS
            line.extend((r // n, g // n, b // n, a // n))
        out.append(bytes(line))
    return out


def png_bytes(width, height, rows):
    raw = b"".join(b"\x00" + row for row in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(
            ">I", zlib.crc32(body) & 0xFFFFFFFF
        )

    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", ihdr)
        + chunk(b"IDAT", zlib.compress(raw, 9))
        + chunk(b"IEND", b"")
    )


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    out_dir = os.path.join(here, "..", "extension", "icons")
    os.makedirs(out_dir, exist_ok=True)
    for size in (16, 32, 48, 128):
        data = png_bytes(size, size, render(size))
        path = os.path.join(out_dir, f"icon{size}.png")
        with open(path, "wb") as handle:
            handle.write(data)
        print(f"wrote {path} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
