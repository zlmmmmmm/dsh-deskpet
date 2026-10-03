"""把「AI 生成的精灵图」修成可用的透明帧动画素材。

用法：
    python scripts/import-frames.py <源目录>
    # 或设 DESKPET_FRAMES_SRC 环境变量

源目录结构：`manifest.json` + `<前缀>-<mood>.png`（每张是横向排列的精灵图）。
本脚本起源于排查另一套桌宠实现的素材：它每个状态是一张位图精灵图，
但透明通道有两处硬伤（见下）。想复用请自备同结构的源目录。

修三个真实缺陷（那套素材里量到过）：
  1. **角色内部有 alpha=0 的洞**（那份 girl-idle 有 13058 个，占角色面积 14.8%，RGB 是纯黑）
     —— 桌面上看起来像脸被糊了一块黑面具。修法：从四边 flood fill 找出「与外界连通」的
     透明区，剩下的封闭透明区就是洞 → alpha 补 255。
  2. **洞里的 RGB 是黑的** —— 直接补成不透明会变黑斑。修法：用邻域做多轮高斯扩散把周围
     颜色渗进洞里（纯 PIL，无需 scipy）。
  3. **半透明像素过多**（35.5%，正常描边抗锯齿约 3%）—— 在深色桌面上整体发暗发黑。
     修法：对 alpha 做对比度拉伸，内部拉满成不透明，只保留真正的边缘过渡。

输出到本插件的 assets/pet/<species>/：sheet.<mood>.png + frames.json + species.json，
源什么格式就照什么格式写，便于两边互换。
"""
from __future__ import annotations

import json
import os
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

ROOT = Path(__file__).resolve().parent.parent
PET_DIR = ROOT / "assets" / "pet"

# 源目录：命令行第一个参数，或环境变量 DESKPET_FRAMES_SRC。
# 结构约定：<src>/manifest.json + <src>/<前缀>-<mood>.png（每张是横向排列的精灵图）。
# 不设默认值——路径因人而异，写死一个只会让脚本在别人机器上莫名失败。
DEFAULT_SRC = Path(os.environ.get("DESKPET_FRAMES_SRC", "")) if os.environ.get("DESKPET_FRAMES_SRC") else None

# 物种 id（本插件用）→ 源文件前缀
SPECIES = [("policegirl", "girl"), ("foxboy", "boy")]
MOODS = ["idle", "busy", "celebrate"]

# alpha 对比度拉伸：< LO 视为真透明，> HI 拉满成不透明，中间保留过渡
ALPHA_LO, ALPHA_HI = 60, 150
# 扩散补色的轮数（洞越大需要越多轮；240×560 的洞 4 轮足够）
INPAINT_ROUNDS = 4
INPAINT_RADIUS = 6


def enclosed_holes(alpha: np.ndarray) -> np.ndarray:
    """返回「封闭在角色内部的透明像素」掩码（与图像外界不连通的那些）。"""
    transparent = alpha == 0
    h, w = transparent.shape
    seen = np.zeros_like(transparent)
    dq: deque[tuple[int, int]] = deque()
    for x in range(w):
        for y in (0, h - 1):
            if transparent[y, x] and not seen[y, x]:
                seen[y, x] = True
                dq.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if transparent[y, x] and not seen[y, x]:
                seen[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and transparent[ny, nx] and not seen[ny, nx]:
                seen[ny, nx] = True
                dq.append((ny, nx))
    return transparent & ~seen


def inpaint_holes(rgb: np.ndarray, holes: np.ndarray) -> np.ndarray:
    """把洞里的黑像素用周围颜色填掉：多轮「掩掉洞 → 高斯模糊 → 取模糊值」扩散。"""
    if not holes.any():
        return rgb
    keep = (~holes).astype(np.uint8) * 255
    keep_img = Image.fromarray(keep, "L")
    filled = rgb.copy()
    filled[holes] = 0
    for _ in range(INPAINT_ROUNDS):
        blurred = np.asarray(
            Image.fromarray(filled.astype(np.uint8), "RGB").filter(ImageFilter.GaussianBlur(INPAINT_RADIUS))
        )
        # 洞内取模糊（扩散进来）的颜色，洞外保持原样
        filled[holes] = blurred[holes]
        # 下一轮把「已填的洞」也算作可用颜色源，逐圈往里渗
        _ = keep_img
    return filled


def repair_frame(frame: np.ndarray) -> np.ndarray:
    """修一帧（H×W×4 uint8）。"""
    a = frame.astype(np.float32)
    alpha = a[:, :, 3]

    holes = enclosed_holes(alpha.astype(np.uint8))
    if holes.any():
        a[:, :, :3] = inpaint_holes(a[:, :, :3], holes)

    # alpha：填洞 + 对整体做对比度拉伸（内部半透明拉满，保留真实边缘）
    alpha2 = alpha.copy()
    alpha2[holes] = 255.0
    stretched = np.clip((alpha2 - ALPHA_LO) / (ALPHA_HI - ALPHA_LO), 0, 1) * 255.0
    alpha2 = np.where(alpha2 < 20, alpha2, stretched)  # 真正的边缘（极低 alpha）保持原样
    a[:, :, 3] = alpha2
    return a.astype(np.uint8)


def load_sheet(path: Path) -> tuple[np.ndarray, int, int, int]:
    im = Image.open(path).convert("RGBA")
    arr = np.asarray(im)
    manifest = json.loads((path.parent / "manifest.json").read_text(encoding="utf-8"))
    return arr, manifest


def main() -> None:
    if len(sys.argv) > 1:
        src = Path(sys.argv[1])
    elif DEFAULT_SRC is not None:
        src = DEFAULT_SRC
    else:
        raise SystemExit(
            "需要源目录：python scripts/import-frames.py <源目录>\n"
            "（或设环境变量 DESKPET_FRAMES_SRC；目录里要有 manifest.json 与 <前缀>-<mood>.png）"
        )
    if not src.exists():
        raise SystemExit(f"源目录不存在：{src}")
    manifest = json.loads((src / "manifest.json").read_text(encoding="utf-8"))

    for species, prefix in SPECIES:
        info = manifest["characters"][prefix]
        fw = int(info["idle"]["frameWidth"])
        fh = int(info["idle"]["frameHeight"])

        # ---- 先逐帧修好，同时求「所有帧所有 mood」的并集外接框（保证换 mood 不跳位）----
        repaired: dict[str, list[np.ndarray]] = {}
        minx, miny, maxx, maxy = fw, fh, 0, 0
        for mood in MOODS:
            spec = info[mood]
            sheet = np.asarray(Image.open(src / spec["file"]).convert("RGBA"))
            count = int(spec["frames"])
            frames = []
            for i in range(count):
                f = repair_frame(sheet[:, i * fw : (i + 1) * fw, :])
                frames.append(f)
                ys, xs = np.where(f[:, :, 3] > 8)
                if len(xs):
                    minx = min(minx, int(xs.min()))
                    maxx = max(maxx, int(xs.max()))
                    miny = min(miny, int(ys.min()))
                    maxy = max(maxy, int(ys.max()))
            repaired[mood] = frames

        # 统一裁到并集框（脚底对齐、换 mood 不位移）
        cw, ch = maxx - minx + 1, maxy - miny + 1
        out_dir = PET_DIR / species
        out_dir.mkdir(parents=True, exist_ok=True)

        moods_meta = {}
        for mood in MOODS:
            frames = [f[miny : miny + ch, minx : minx + cw, :] for f in repaired[mood]]
            sheet = np.concatenate(frames, axis=1)
            out_file = out_dir / f"sheet.{mood}.png"
            Image.fromarray(sheet, "RGBA").save(out_file)
            moods_meta[mood] = {
                "file": out_file.name,
                "frames": len(frames),
                "frameWidth": cw,
                "frameHeight": ch,
            }
            print(f"{species:<11} {mood:<10} {len(frames):>2} 帧  {cw}x{ch}  -> {out_file.name}")

        (out_dir / "frames.json").write_text(
            json.dumps({"moods": moods_meta}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        # species.json 的宽高 = 单帧尺寸；heightRatio 供窗口几何用
        name = "警帽狐耳少女" if species == "policegirl" else "狐狸卫衣少年"
        (out_dir / "species.json").write_text(
            json.dumps(
                {"name": name, "width": cw, "height": ch, "heightRatio": round(ch / cw, 4)},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"  → {species}: 并集外接框 {cw}x{ch}，moods={list(moods_meta)}\n")


if __name__ == "__main__":
    main()
