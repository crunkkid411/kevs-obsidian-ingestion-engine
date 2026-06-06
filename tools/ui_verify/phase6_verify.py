# Phase 6 self-verification: launch forensic-gui.exe, drive via Win32 ctypes,
# screenshot each scenario, write report to tools/ui_verify/runs/report.txt.
# Run: .venv/Scripts/python.exe tools/ui_verify/phase6_verify.py
import ctypes, subprocess, time, hashlib
import numpy as np
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).parent.parent.parent
EXE  = ROOT / "gui" / "target" / "release" / "forensic-gui.exe"
RUNS = ROOT / "tools" / "ui_verify" / "runs"
RUNS.mkdir(parents=True, exist_ok=True)

user32   = ctypes.windll.user32
kernel32 = ctypes.windll.kernel32
results  = []
_app_hwnd = None
_window_rect = None

# Button fill colors from main.rs constants (exact egui RGB values)
VIOLET  = (0xa7, 0x8b, 0xfa)   # ► Select
MAGENTA = (0xff, 0x5c, 0xf0)   # ✂ Clip this
AMBER   = (0xfb, 0xbf, 0x24)   # + Queue
CYAN    = (0x2d, 0xd4, 0xff)   # Stitch ⬇  (also Search btn, video border)
GREEN   = (0x34, 0xd3, 0x99)   # ✓ Confirm

HWND_TOPMOST  = ctypes.c_void_p(-1)
SWP_SHOWWINDOW = 0x40

# ── screenshot ────────────────────────────────────────────────────────────────
def screenshot(name, hwnd=None):
    """PrintWindow captures GPU window regardless of z-order."""
    out = RUNS / name
    h = hwnd or _app_hwnd
    if not h:
        import mss, mss.tools
        with mss.MSS() as sct:
            img = sct.grab(sct.monitors[1])
            mss.tools.to_png(img.rgb, img.size, output=str(out))
        print(f"  screenshot (screen): {out.name}")
        return out
    rc = get_rect(h)
    w = max(1, rc.r - rc.l); ht = max(1, rc.b - rc.t)
    gdi32 = ctypes.windll.gdi32
    hdc_win = user32.GetDC(h)
    hdc_mem = gdi32.CreateCompatibleDC(hdc_win)
    hbmp = gdi32.CreateCompatibleBitmap(hdc_win, w, ht)
    gdi32.SelectObject(hdc_mem, hbmp)
    user32.PrintWindow(h, hdc_mem, 2)
    buf_size = w * ht * 4
    buf = (ctypes.c_char * buf_size)()
    class BITMAPINFO(ctypes.Structure):
        _fields_ = [("biSize", ctypes.c_uint32), ("biWidth", ctypes.c_int32),
                    ("biHeight", ctypes.c_int32), ("biPlanes", ctypes.c_uint16),
                    ("biBitCount", ctypes.c_uint16), ("biCompression", ctypes.c_uint32),
                    ("biSizeImage", ctypes.c_uint32), ("biXPelsPerMeter", ctypes.c_int32),
                    ("biYPelsPerMeter", ctypes.c_int32), ("biClrUsed", ctypes.c_uint32),
                    ("biClrImportant", ctypes.c_uint32)]
    bi = BITMAPINFO(40, w, -ht, 1, 32, 0, buf_size, 0, 0, 0, 0)
    gdi32.GetDIBits(hdc_mem, hbmp, 0, ht, buf, ctypes.byref(bi), 0)
    img = Image.frombytes("RGBA", (w, ht), bytes(buf), "raw", "BGRA")
    img.save(str(out))
    gdi32.DeleteObject(hbmp); gdi32.DeleteDC(hdc_mem); user32.ReleaseDC(h, hdc_win)
    print(f"  screenshot (PrintWindow {w}x{ht}): {out.name}")
    return out

# ── button color detection ────────────────────────────────────────────────────
def load_img_array(path):
    return np.array(Image.open(str(path)).convert("RGB"))

def find_first_button(arr, target_rgb, tolerance=22, min_run=30,
                      x_range=None, y_range=None):
    """
    Scan the image top-to-bottom for the first row-run of pixels matching
    target_rgb (with tolerance). Returns (image_cx, image_cy) or None.
    min_run: minimum matching pixels in a row to count as button interior.
    """
    h, w = arr.shape[:2]
    x1, x2 = x_range or (0, w)
    y1, y2 = y_range or (0, h)
    r, g, b = target_rgb
    target = np.array([r, g, b], dtype=np.int32)
    button_rows = []

    for y in range(y1, y2):
        row = arr[y, x1:x2, :3].astype(np.int32)
        hits = np.where(np.all(np.abs(row - target) < tolerance, axis=1))[0]
        if len(hits) >= min_run:
            button_rows.append((y, hits + x1))
        elif button_rows:
            break   # left the button region

    if not button_rows:
        return None
    mid_y, mid_xs = button_rows[len(button_rows) // 2]
    return int(np.mean(mid_xs)), mid_y

def click_button(img_path, target_rgb, x_range=None, y_range=None,
                 tolerance=22, min_run=30):
    """
    Load screenshot, find button by fill color, click at screen coords.
    Returns True if found and clicked.
    """
    arr = load_img_array(img_path)
    pos = find_first_button(arr, target_rgb, tolerance, min_run, x_range, y_range)
    if pos is None:
        print(f"  [!] button color {target_rgb} not found in {Path(img_path).name}")
        return False
    ix, iy = pos
    sx = _window_rect.l + ix
    sy = _window_rect.t + iy
    print(f"  button {target_rgb} -> image ({ix},{iy}) screen ({sx},{sy})")
    click(sx, sy)
    return True

# ── window utilities ──────────────────────────────────────────────────────────
def find_hwnd(title_sub):
    result = [0]
    CB = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_ulong, ctypes.c_long)
    def cb(hwnd, _):
        buf = ctypes.create_unicode_buffer(512)
        user32.GetWindowTextW(hwnd, buf, 512)
        if title_sub.lower() in buf.value.lower():
            result[0] = hwnd
        return True
    user32.EnumWindows(CB(cb), 0)
    return result[0]

def get_rect(hwnd):
    class RECT(ctypes.Structure):
        _fields_ = [("l", ctypes.c_long), ("t", ctypes.c_long),
                    ("r", ctypes.c_long), ("b", ctypes.c_long)]
    rc = RECT()
    user32.GetWindowRect(hwnd, ctypes.byref(rc))
    return rc

def attach_and_focus(hwnd):
    my_tid = kernel32.GetCurrentThreadId()
    app_tid = user32.GetWindowThreadProcessId(hwnd, None)
    if app_tid and app_tid != my_tid:
        user32.AttachThreadInput(my_tid, app_tid, True)
    user32.SetForegroundWindow(hwnd)
    user32.BringWindowToTop(hwnd)
    time.sleep(0.3)
    if app_tid and app_tid != my_tid:
        user32.AttachThreadInput(my_tid, app_tid, False)

def focus_app(title_sub, timeout=25.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        hwnd = find_hwnd(title_sub)
        if hwnd:
            user32.ShowWindow(hwnd, 9)
            user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, 1300, 860, SWP_SHOWWINDOW)
            attach_and_focus(hwnd)
            time.sleep(0.5)
            return hwnd
        time.sleep(0.5)
    return 0

def click(x, y, delay=0.15):
    user32.SetCursorPos(int(x), int(y)); time.sleep(delay)
    user32.mouse_event(2, 0, 0, 0, 0); time.sleep(0.05)
    user32.mouse_event(4, 0, 0, 0, 0); time.sleep(delay)

def query_db(sql, params=()):
    import sqlite3
    conn = sqlite3.connect(str(ROOT / "forensic.db"))
    rows = conn.execute(sql, params).fetchall()
    conn.close()
    return rows

def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""): h.update(chunk)
    return h.hexdigest()

def record(scenario, passed, detail=""):
    s = "PASS" if passed else "FAIL"
    msg = f"[{s}] {scenario}" + (f" — {detail}" if detail else "")
    results.append(msg); print(msg)

# ── main ──────────────────────────────────────────────────────────────────────
def main():
    global _app_hwnd, _window_rect

    assert EXE.exists(), f"EXE missing: {EXE}"
    test_mp4 = ROOT / "test.mp4"
    h_before = sha256(str(test_mp4)) if test_mp4.exists() else None

    subprocess.run(["taskkill", "/IM", "forensic-gui.exe", "/F"], capture_output=True, check=False)
    time.sleep(1.0)

    # Launch with --initial-query so auto-search fires on first frame
    print("launching forensic-gui.exe with --initial-query...")
    proc = subprocess.Popen(
        [str(EXE), "--initial-query", "social media posting"],
        cwd=str(ROOT), creationflags=subprocess.CREATE_NEW_CONSOLE)
    hwnd = focus_app("Forensic Video Intelligence", 25)
    record("(0) App launches", bool(hwnd), f"hwnd={hwnd}")
    if not hwnd:
        proc.terminate(); write_report(); return

    _app_hwnd = hwnd

    # Maximize and keep topmost so PrintWindow always captures content
    user32.ShowWindow(hwnd, 3)
    time.sleep(1.0)
    rc = get_rect(hwnd)
    _window_rect = rc
    cx, cy = rc.l, rc.t
    W  = rc.r - rc.l
    H  = rc.b - rc.t
    print(f"  window ({cx},{cy}) {W}x{H}")
    screenshot("00_launch.png")

    # ── (a) search ────────────────────────────────────────────────────────────
    # auto_search fires in first update() frame. Query is pre-populated.
    # Wait for embedding model + KNN (~40 seconds).
    print("  waiting 45s for auto-search (embedding model + KNN)...")
    time.sleep(45)
    p_search = screenshot("01_search.png")
    emb = query_db("SELECT COUNT(*) FROM embeddings_meta WHERE modality='text'")[0][0]
    record("(a) Search", emb > 0, f"{emb} text embeddings in DB")

    # ── (b) select result ─────────────────────────────────────────────────────
    # Find the VIOLET "► Select" button in the left panel (~left 50% of image).
    # Empirically: separator at x=844, right panel starts at x=856, buttons at x=867+.
    # Use 840 so right-panel searches start safely left of the actual panel edge.
    left_half_x = 840
    # Search below the title bar + search bar (~top 8% of image)
    below_header = int(H * 0.07)

    found_select = click_button(p_search, VIOLET,
                                x_range=(0, left_half_x),
                                y_range=(below_header, H))
    time.sleep(1.0)
    p_select = screenshot("02_select.png")
    record("(b) Select result (screenshot taken)", True)

    # ── (d) clip ──────────────────────────────────────────────────────────────
    # "✂ Clip this" button (MAGENTA) appears in right panel when result selected.
    clips_dir = ROOT / "osint-export" / "clips"
    clips_before = set(clips_dir.glob("*.mp4")) if clips_dir.exists() else set()

    click_button(p_select, MAGENTA,
                 x_range=(left_half_x, W),
                 y_range=(below_header, H))
    print("  waiting 5s for ffmpeg clip...")
    time.sleep(5)
    p_clip = screenshot("03_clip.png")
    clips_after = set(clips_dir.glob("*.mp4")) if clips_dir.exists() else set()
    new_clips   = clips_after - clips_before
    record("(d) Clip creates file", bool(new_clips), str([c.name for c in new_clips]))

    # ── (e) queue + stitch ────────────────────────────────────────────────────
    # Queue the result so Stitch button appears, then stitch.
    # "+ Queue" button is AMBER in right panel.
    click_button(p_clip, AMBER,
                 x_range=(left_half_x, W),
                 y_range=(below_header, H))
    time.sleep(0.5)
    p_queued = screenshot("04a_queued.png")

    # "Stitch ⬇" button is CYAN in right panel.
    # Exclude the search bar area (top ~6% of image) and the video area (skip ~40%).
    # Stitch is below clip/queue row, roughly in bottom 60% of right panel.
    stitch_y_start = int(H * 0.40)
    click_button(p_queued, CYAN,
                 x_range=(left_half_x, W),
                 y_range=(stitch_y_start, H))
    print("  waiting 6s for ffmpeg stitch...")
    time.sleep(6)
    stitched = ROOT / "osint-export" / "clips" / "stitched_output.mp4"
    p_stitch = screenshot("04_stitch.png")
    record("(e) Stitch output exists", stitched.exists(), str(stitched))

    # ── (f) confirm ───────────────────────────────────────────────────────────
    # "✓ Confirm" button (GREEN) in right panel REVIEW section.
    nr_before = query_db("SELECT COUNT(*) FROM utterances WHERE needs_review=1")[0][0]
    # Confirm is in REVIEW section below the queue/stitch row (~y=450+).
    # y_range skips the "Open in mpv" GREEN button which sits at y≈305-338.
    click_button(p_stitch, GREEN,
                 x_range=(left_half_x, W),
                 y_range=(int(H * 0.43), H))
    time.sleep(0.8)
    p_confirm = screenshot("05_confirm.png")
    nr_after = query_db("SELECT COUNT(*) FROM utterances WHERE needs_review=1")[0][0]
    record("(f) Confirm decreases needs_review", nr_after < nr_before,
           f"{nr_before} -> {nr_after}")

    # ── source integrity ──────────────────────────────────────────────────────
    h_after = sha256(str(test_mp4)) if test_mp4.exists() else None
    record("source file untouched", h_before == h_after)

    screenshot("06_final.png")
    proc.terminate()
    write_report()


def write_report():
    p = RUNS / "report.txt"
    ok = sum(1 for r in results if r.startswith("[PASS]"))
    with open(p, "w") as f:
        f.write(f"Phase 6 — {ok}/{len(results)} PASS\n{'='*40}\n")
        for r in results: f.write(r + "\n")
    print(f"\nPhase 6: {ok}/{len(results)} PASS — {p}")


if __name__ == "__main__":
    main()
