#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
剥离图片元数据（EXIF / GPS / XMP）
====================================
用途：评论配图上传时调用（server.js 的 stripExif）。
背景（QA LOW-07）：手机拍摄的照片默认写入 EXIF，其中 GPSLatitude /
    GPSLongitude 会精确暴露拍摄地点 —— 用户发一张车站照片就泄露住的街区。
    此外还有 DateTimeOriginal / Make / Model / 甚至部分机型的 OwnerName。

行为：
    从 stdin 读原图字节，把**所有** EXIF/元数据剥干净后，
    以相同格式从 stdout 输出。
    任何异常 → 非 0 退出（调用方会降级为保留原图，不阻断上传）。

用法：
    cat photo.jpg | python3 tools/strip_exif.py > clean.jpg
"""

import sys


def main() -> int:
    try:
        from PIL import Image
    except ImportError:
        print("缺少 Pillow", file=sys.stderr)
        return 2

    raw = sys.stdin.buffer.read()
    if not raw:
        print("stdin 为空", file=sys.stderr)
        return 3

    import io

    src = io.BytesIO(raw)
    try:
        im = Image.open(src)
        im.load()
    except Exception as e:
        print("无法解析图片: %s" % e, file=sys.stderr)
        return 4

    fmt = (im.format or "").upper()
    if fmt not in ("PNG", "JPEG", "JPG", "GIF", "WEBP"):
        print("不支持的格式: %s" % fmt, file=sys.stderr)
        return 5

    # —— 关键：构造一个不含任何元数据的副本 ——
    # 做法是把像素逐位复制到新 Image，再保存。
    # 直接 im.save() 会保留 info 里的 exif/icc_profile 等，必须显式排除。
    clean = Image.new(im.mode, im.size)
    # Pillow 14 起 getdata 废弃，优先用 tobytes/frombytes 这条更快且无警告的路径
    try:
        clean.frombytes(im.tobytes())
    except Exception:
        clean.putdata(list(im.getdata()))

    out = io.BytesIO()
    save_kw = {}
    if fmt in ("JPEG", "JPG"):
        # 保持视觉质量，同时不传任何 exif= 参数
        save_kw.update(quality=90, optimize=True, progressive=True)
        # 透明通道无法存 JPEG，先转 RGB
        if clean.mode in ("RGBA", "LA", "P"):
            clean = clean.convert("RGB")
    elif fmt == "PNG":
        save_kw.update(optimize=True)
    elif fmt == "WEBP":
        save_kw.update(quality=90, method=4)
    # GIF：交给 Pillow 默认（GIF 本身极少含 EXIF）

    try:
        clean.save(out, format=fmt, **save_kw)
    except Exception as e:
        print("重新编码失败: %s" % e, file=sys.stderr)
        return 6

    data = out.getvalue()
    if not data:
        print("输出为空", file=sys.stderr)
        return 7

    sys.stdout.buffer.write(data)
    return 0


if __name__ == "__main__":
    sys.exit(main())
