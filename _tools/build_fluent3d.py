"""下載 Microsoft Fluent Emoji 的 3D 圖（MIT），縮成 128px PNG → vendor/fluent-3d/<key>.png

    python _tools/build_fluent3d.py
    （需要 Pillow：pip install pillow）

2026-10-19 版面美化「冒險日誌」建立（照 605 500碗 _tools/build_fluent3d.py）：
首屏主視覺、HUD 狀態列、功能圖格、底部分頁、絕招圖鑑鎖頭用 3D 立體圖。
- 來源：https://github.com/microsoft/fluentui-emoji （MIT，全文寫到 vendor/fluent-3d/LICENSE.txt）。
- 顯示最大 96px，存 128px 給高解析螢幕。
- 有膚色變化的圖（Ninja）路徑多一層 Default/，檔名結尾 _3d_default.png。
- 下載後檢查是 PNG 檔頭（不是錯誤頁），不合格就停。
"""
import io
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "vendor" / "fluent-3d"
BASE = "https://raw.githubusercontent.com/microsoft/fluentui-emoji/main"
SIZE = 128

# key → (Fluent 資料夾名，是否有膚色層)。資料夾名大小寫要完全一樣。
ICONS = {
    "ninja": ("Ninja", True),               # 首屏主視覺
    "fire": ("Fire", False),                # HUD 連續天數
    "star": ("Glowing star", False),        # HUD 修行值
    "check": ("Check mark button", False),  # HUD 今日完成
    "calendar": ("Spiral calendar", False), # 分頁：任務曆
    "tearoff": ("Tear-off calendar", False),# 分頁／圖格：今日
    "scroll": ("Scroll", False),            # 分頁／圖格：修行表；未解鎖絕招
    "swords": ("Crossed swords", False),    # 分頁／圖格：忍者等級
    "gear": ("Gear", False),                # 分頁：設定
    "locked": ("Locked", False),            # 未解鎖絕招右上鎖頭
    "timer": ("Timer clock", False),        # 番茄鐘
}


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "curl/8"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for key, (folder, skin) in ICONS.items():
        base = folder.lower().replace(" ", "_") + "_3d"
        q = urllib.parse.quote(folder)
        if skin:
            url = f"{BASE}/assets/{q}/Default/3D/{urllib.parse.quote(base + '_default.png')}"
        else:
            url = f"{BASE}/assets/{q}/3D/{urllib.parse.quote(base + '.png')}"
        raw = fetch(url)
        if not raw.startswith(b"\x89PNG"):
            print(f"[FAIL] {key}：{url} 不是 PNG"); sys.exit(1)
        im = Image.open(io.BytesIO(raw)).convert("RGBA")
        im = im.resize((SIZE, SIZE), Image.LANCZOS)
        dst = OUT / f"{key}.png"
        im.save(dst, optimize=True)
        print(f"OK {key:10s} {dst.stat().st_size // 1024} KB  <- {folder}")
    (OUT / "LICENSE.txt").write_bytes(fetch(f"{BASE}/LICENSE"))
    print("OK LICENSE.txt")


if __name__ == "__main__":
    main()
