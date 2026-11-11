"""技術検証: detect.py の結果から、自動配置＋目元ぼかしの4分割画像を試作する。

使い方: .venv/bin/python compose.py
出力: out/collage_setX.jpg（3840x2160）
"""
import json
from pathlib import Path

import cv2
import numpy as np

OUT = Path(__file__).parent / "out"
CW, CH = 1920, 1080  # 1セル（16:9 / 4K の 1/4）
# 種類ごとの配置ルール: 頭頂部〜顎先の高さ（セル高さ比）、頭頂部の位置（セル上端からの比）
RULE = {
    "front":   {"head": 0.76, "top": 0.07},
    "oblique": {"head": 0.76, "top": 0.07},
    "profile": {"head": 0.76, "top": 0.07},
    "aori":    {"head": 0.52, "top": 0.16},
}
SLOT = {"front": (0, 0), "oblique": (1, 0), "aori": (0, 1), "profile": (1, 1)}


def kind_of(stem):
    for k in RULE:
        if k in stem:
            return k


def head_geometry(r, mask):
    """頭頂部・顎先・頭の横中心・使った手がかりを返す。"""
    x, y, bw, bh = r["face_detector"]["box"]
    flm = r["face_landmarker"]
    chin = flm["chin"][1] if flm else y + bh            # 顎先: 顔ランドマーク → 無ければ顔枠の下端
    band = mask[:, max(0, int(x - bw * 0.3)):int(x + bw * 1.3)]
    rows = np.nonzero(band.any(axis=1))[0]
    top = rows.min() if len(rows) else y - bh * 0.5    # 頭頂部: 人物領域の上端（顔の横幅の範囲内）
    eye_y = int(y + bh * 0.35)
    cols = np.nonzero(mask[int(top):eye_y].any(axis=0))[0]  # 頭頂〜目の高さの頭の幅
    cx = (cols.min() + cols.max()) / 2 if len(cols) else x + bw / 2
    return top, chin, cx


def eye_blurs(r):
    """ぼかし楕円 [(cx, cy, rx, ry)] と、使った手がかり。"""
    flm = r["face_landmarker"]
    out = []
    if flm:
        for k in ("eyeA", "eyeB"):
            p = np.array(flm[k])
            (x0, y0), (x1, y1) = p.min(0), p.max(0)
            w = x1 - x0
            if w < 5:
                continue
            out.append(((x0 + x1) / 2, (y0 + y1) / 2, w * 0.85, max(y1 - y0, w * 0.45) * 1.3))
        return out, "顔ランドマーク"
    po = r["pose"]
    bw = r["face_detector"]["box"][2]
    ex = (po["eyeL"][0] + po["eyeR"][0]) / 2
    ey = (po["eyeL"][1] + po["eyeR"][1]) / 2
    return [(ex, ey, bw * 0.17, bw * 0.10)], "姿勢推定（予備）"


def apply_blur(img, blurs):
    if not blurs:
        return img
    k = max(61, int(img.shape[1] * 0.04) | 1)
    blurred = cv2.GaussianBlur(img, (k, k), 0)
    blurred = cv2.GaussianBlur(blurred, (k, k), 0)
    m = np.zeros(img.shape[:2], np.float32)
    for cx, cy, rx, ry in blurs:
        cv2.ellipse(m, (int(cx), int(cy)), (int(rx), int(ry)), 0, 0, 360, 1.0, -1)
    m = cv2.GaussianBlur(m, (0, 0), max(rx, ry) * 0.25)[..., None]
    return (img * (1 - m) + blurred * m).astype(np.uint8)


KNEE = 64  # この明るさ以上（顔・肌）は一切変えない


def black_background(img, mask):
    """背景を真っ黒にする。顔の明るさは変えず、白飛びも増やさない。

    1) シャドウだけを締めるトーンカーブ: 背景の明るさ(B)以下 → 0、B〜KNEE をなめらかにつなぐ、KNEE 以上はそのまま
    2) 人物から十分離れた背景は、人物領域マスクで完全に 0 にする（黒幕の端・しわ対策）
    """
    g = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    b = float(np.clip(np.percentile(g[mask == 0], 99) + 4, 8, 45))  # 写真ごとの黒幕の明るさ
    v = np.arange(256, dtype=np.float32)
    t = np.clip((v - b) / (KNEE - b), 0, 1)
    curve = np.where(v >= KNEE, v, KNEE * t ** 1.6)  # B 以下は 0、KNEE で元の値に連続
    lum = g.astype(np.float32)
    gain = np.where(lum > 0, curve[g] / np.maximum(lum, 1), 0)[..., None]  # 色味を保ったまま明るさだけ変える
    out = np.clip(img.astype(np.float32) * gain, 0, 255)
    # 人物領域を少し広げてぼかし、その外側を 0 に
    m = cv2.dilate(mask, np.ones((25, 25), np.uint8))
    m = cv2.GaussianBlur(m.astype(np.float32), (0, 0), 12)[..., None]
    return (out * m).astype(np.uint8)


def render_cell(r, kind):
    src = cv2.imread(r["file"])
    mask = np.load(OUT / (Path(r["file"]).parent.name + "_" + Path(r["file"]).stem + "_mask.npy"))
    top, chin, cx = head_geometry(r, mask)
    blurs, how = eye_blurs(r)
    src = apply_blur(src, blurs)
    s = RULE[kind]["head"] * CH / (chin - top)
    # 変換: 頭頂部がセル上端から top 比、頭の横中心がセル中央
    tx = CW / 2 - cx * s
    ty = RULE[kind]["top"] * CH - top * s
    M = np.float32([[s, 0, tx], [0, s, ty]])
    src = black_background(src, mask)
    cell = cv2.warpAffine(src, M, (CW, CH), flags=cv2.INTER_AREA, borderValue=(0, 0, 0))
    return cell, {"scale": round(s, 3), "eye": how, "n_blur": len(blurs)}


def main():
    res = json.loads((OUT / "detect.json").read_text())
    sets = {}
    for r in res:
        p = Path(r["file"])
        sets.setdefault(p.parent.name, {})[kind_of(p.stem)] = r
    for name, d in sorted(sets.items()):
        canvas = np.zeros((CH * 2, CW * 2, 3), np.uint8)
        for kind, r in d.items():
            cell, info = render_cell(r, kind)
            cx, cy = SLOT[kind]
            canvas[cy * CH:(cy + 1) * CH, cx * CW:(cx + 1) * CW] = cell
            print(name, kind, info)
        cv2.imwrite(str(OUT / f"collage_{name}.jpg"), canvas, [cv2.IMWRITE_JPEG_QUALITY, 92])


if __name__ == "__main__":
    main()
