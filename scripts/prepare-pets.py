"""把原型图加工成桌宠素材（透明背景 + 紧致裁切 + 多物种清单）。

用法：
    python scripts/prepare-pets.py "C:\\path\\a.png" "C:\\path\\b.png"

做法：
  1. 采样四角的中位色作为背景参考色（粉底）
  2. 在 1/4 分辨率上从边界做 flood fill，得到「与外界连通的背景区」
     —— 用连通性而不是纯色键，是为了不误删角色内部的粉色（腮红、肤色）
  3. 回到全分辨率按颜色距离生成 alpha，并在边界做一段软过渡（JPEG 噪点不外溢成硬边）
  4. 裁到内容外接框 → 缩放到目标高度 → 存 assets/pet/<id>/idle.png
  5. 汇总 assets/pet/species.json（含每张图的 heightRatio，供窗口几何使用）

heightRatio = 高 / 宽，窗口按 size × heightRatio 计算精灵高度。
"""
from __future__ import annotations

import json
import sys
from collections import deque
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
PET_DIR = ROOT / "assets" / "pet"

# 物种定义：输出目录名 / 显示名
SPECIES = [
    {"id": "foxboy", "name": "狐狸卫衣少年"},
    {"id": "policegirl", "name": "警帽狐耳少女"},
]

TARGET_H = 720  # 输出贴图高度（px）
SCALE = 4  # flood fill 降采样倍率
T_CORE = 34  # 颜色距离 < 它 → 完全背景
T_SOFT = 78  # 距离 > 它 → 完全前景


def background_reference(arr: np.ndarray) -> np.ndarray:
    """四角小块的中位色。"""
    k = 48
    patches = [arr[:k, :k], arr[:k, -k:], arr[-k:, :k], arr[-k:, -k:]]
    px = np.concatenate([p.reshape(-1, 3) for p in patches], axis=0)
    return np.median(px, axis=0)


def outside_region(bg_like: np.ndarray, scale: int) -> np.ndarray:
    """从边界 flood fill，返回「与图像外边界连通的背景」掩码（降采样后）。"""
    h, w = bg_like.shape
    hs, ws = h // scale, w // scale
    # 用 min 池化：一个降采样像素只有在整块都是背景色时才算背景 → 不会渗进角色
    small = bg_like[: hs * scale, : ws * scale].reshape(hs, scale, ws, scale).min(axis=(1, 3))

    vis = np.zeros_like(small, dtype=bool)
    dq: deque[tuple[int, int]] = deque()
    for x in range(ws):
        for y in (0, hs - 1):
            if small[y, x] and not vis[y, x]:
                vis[y, x] = True
                dq.append((y, x))
    for y in range(hs):
        for x in (0, ws - 1):
            if small[y, x] and not vis[y, x]:
                vis[y, x] = True
                dq.append((y, x))
    while dq:
        y, x = dq.popleft()
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < hs and 0 <= nx < ws and small[ny, nx] and not vis[ny, nx]:
                vis[ny, nx] = True
                dq.append((ny, nx))
    return vis


def largest_fg_component(fg: np.ndarray, scale: int) -> np.ndarray:
    """只保留最大的前景连通块（角色本体），用来甩掉水印、噪点和零散碎块。

    为什么必须做：原图右下角有「豆包AI生成」水印，它是灰色文字、离粉底很远，
    纯色键抠不掉；留着它会把裁切框往下拉长，宠物就踩不到地面线了。
    """
    h, w = fg.shape
    hs, ws = h // scale, w // scale
    # max 池化：一块里只要有一个前景像素就算前景（保守，不会削掉细部件）
    small = fg[: hs * scale, : ws * scale].reshape(hs, scale, ws, scale).max(axis=(1, 3))

    labels = np.zeros((hs, ws), dtype=np.int32)
    best_label = 0
    best_size = 0
    current = 0
    for sy in range(hs):
        for sx in range(ws):
            if not small[sy, sx] or labels[sy, sx]:
                continue
            current += 1
            size = 0
            dq: deque[tuple[int, int]] = deque([(sy, sx)])
            labels[sy, sx] = current
            while dq:
                y, x = dq.popleft()
                size += 1
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < hs and 0 <= nx < ws and small[ny, nx] and not labels[ny, nx]:
                        labels[ny, nx] = current
                        dq.append((ny, nx))
            if size > best_size:
                best_size = size
                best_label = current

    keep = labels == best_label
    full = np.repeat(np.repeat(keep, scale, axis=0), scale, axis=1)
    pad_h, pad_w = h - full.shape[0], w - full.shape[1]
    if pad_h or pad_w:
        full = np.pad(full, ((0, pad_h), (0, pad_w)), mode="edge")
    return full


def dilate(mask: np.ndarray, rounds: int = 2) -> np.ndarray:
    """形态学膨胀（4 邻域，numpy roll 实现），用来把角色外圈那一两像素收进来。"""
    out = mask.copy()
    for _ in range(rounds):
        out = (
            out
            | np.roll(out, 1, axis=0)
            | np.roll(out, -1, axis=0)
            | np.roll(out, 1, axis=1)
            | np.roll(out, -1, axis=1)
        )
    return out


def cut_out(path: Path) -> Image.Image:
    rgb = np.asarray(Image.open(path).convert("RGB"))
    arr = rgb.astype(np.int16)
    h, w, _ = arr.shape
    ref = background_reference(arr)

    # 每像素与背景参考色的最大通道差
    dist = np.abs(arr - ref).max(axis=2)
    bg_like = dist < T_SOFT

    vis = outside_region(bg_like, SCALE)
    reach = np.repeat(np.repeat(vis, SCALE, axis=0), SCALE, axis=1)
    pad_h, pad_w = h - reach.shape[0], w - reach.shape[1]
    if pad_h or pad_w:
        reach = np.pad(reach, ((0, pad_h), (0, pad_w)), mode="edge")

    fg = ~(reach & bg_like)  # 前景 = 非「与外界连通的背景」
    body = largest_fg_component(fg, SCALE)  # 只留角色本体
    ring = dilate(body, 2) & ~body  # 角色外圈 1~2 像素

    alpha = np.zeros((h, w), dtype=np.float32)
    alpha[body] = 255.0
    # 软边：外圈像素按离背景色的距离给部分透明度，避免 JPEG 噪点变成硬锯齿
    ring_soft = ring & (dist > T_CORE) & (dist < T_SOFT)
    if ring_soft.any():
        t = (dist[ring_soft] - T_CORE) / float(T_SOFT - T_CORE)
        alpha[ring_soft] = np.clip(t, 0.0, 1.0) * 255.0

    rgba = np.dstack([rgb, alpha.astype(np.uint8)])
    img = Image.fromarray(rgba, mode="RGBA")

    # 裁到内容外接框
    bbox = img.getchannel("A").point(lambda v: 255 if v > 8 else 0).getbbox()
    if bbox is None:
        raise SystemExit(f"抠图失败：{path} 整张都被判成背景了")
    img = img.crop(bbox)

    # 缩放到目标高度（保持宽高比，Lanczos 抗锯齿）
    cw, ch = img.size
    if ch != TARGET_H:
        tw = max(1, round(cw * TARGET_H / ch))
        img = img.resize((tw, TARGET_H), Image.LANCZOS)
    return img


def main() -> None:
    srcs = sys.argv[1:]
    if len(srcs) != len(SPECIES):
        raise SystemExit(f"需要 {len(SPECIES)} 张原型图，收到 {len(srcs)} 张")

    PET_DIR.mkdir(parents=True, exist_ok=True)
    for spec, src in zip(SPECIES, srcs):
        img = cut_out(Path(src))
        out_dir = PET_DIR / spec["id"]
        out_dir.mkdir(parents=True, exist_ok=True)
        out_file = out_dir / "idle.png"
        img.save(out_file)
        w, h = img.size
        # 每个形象目录自带一份元数据：宿主与助手都按「目录即形象」扫描，
        # 用户往 $DSH_HOME/dsh-deskpet/pet/<id>/ 丢个 idle.png 也能直接出现（零配置 pet pack）
        (out_dir / "species.json").write_text(
            json.dumps(
                {"name": spec["name"], "width": w, "height": h, "heightRatio": round(h / w, 4)},
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )
        print(f"{spec['id']:<11} {w}x{h}  heightRatio={h / w:.4f}  -> {out_file}")

    # 旧版的顶层清单已被「目录即形象」取代，清掉避免两处事实来源
    legacy = PET_DIR / "species.json"
    if legacy.exists():
        legacy.unlink()
        print(f"removed legacy manifest: {legacy}")


if __name__ == "__main__":
    main()
