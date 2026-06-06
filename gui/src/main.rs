// forensic-gui — native investigator UI
// Rust egui (eframe 0.29) + libmpv via Win32 child-window --wid embedding
//
// Video plays INLINE: we create a Win32 child HWND, tell mpv to render into
// it with --wid=<hwnd>, and keep it positioned over the egui video panel rect
// on every frame. No separate video popup window; no console windows.
//
// Python (cmd_no_window subprocess) is used for Qwen3-Embedding because that
// is the same model used during ingestion — vectors must match. fastembed-rs
// is the planned migration target (NATIVE-STACK.md) but is not yet wired.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use base64::Engine;
use eframe::egui;
use rusqlite::{Connection, OpenFlags, params};
use serde_json::Value;
use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

// ── Win32 FFI — child-window creation for embedded mpv ───────────────────────
// No external crate needed: raw link to user32 via extern "system".
// The child window is created as a child of our eframe HWND. mpv renders into
// it via --wid. We call MoveWindow every frame to keep it aligned with the
// egui panel rect.
#[cfg(windows)]
mod win_video {
    use std::ffi::c_void;

    pub type Hwnd = isize; // NULL = 0

    type RawHWND = *mut c_void;
    const WS_CHILD:       u32 = 0x4000_0000;
    const WS_CLIPCHILDREN:u32 = 0x0200_0000;

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(std::iter::once(0)).collect()
    }

    #[allow(non_snake_case)]
    #[link(name = "user32")]
    extern "system" {
        fn FindWindowW(lpClassName: *const u16, lpWindowName: *const u16) -> RawHWND;
        fn CreateWindowExW(
            dwExStyle: u32,
            lpClassName: *const u16, lpWindowName: *const u16,
            dwStyle: u32,
            X: i32, Y: i32, nWidth: i32, nHeight: i32,
            hWndParent: RawHWND,
            hMenu: *mut c_void, hInstance: *mut c_void, lpParam: *mut c_void,
        ) -> RawHWND;
        fn MoveWindow(hWnd: RawHWND, X: i32, Y: i32, nWidth: i32, nHeight: i32, bRepaint: i32) -> i32;
        fn ShowWindow(hWnd: RawHWND, nCmdShow: i32) -> i32;
        fn DestroyWindow(hWnd: RawHWND) -> i32;
        fn SetWindowPos(
            hWnd: RawHWND, hWndInsertAfter: RawHWND,
            X: i32, Y: i32, cx: i32, cy: i32, uFlags: u32,
        ) -> i32;
    }

    pub fn find_by_title(title: &str) -> Hwnd {
        let t = wide(title);
        unsafe { FindWindowW(std::ptr::null(), t.as_ptr()) as Hwnd }
    }

    /// Create a child window (STATIC class, invisible) parented to `parent`.
    pub fn create_child(parent: Hwnd) -> Hwnd {
        let cls = wide("STATIC");
        unsafe {
            CreateWindowExW(
                0, cls.as_ptr(), std::ptr::null(),
                WS_CHILD | WS_CLIPCHILDREN,
                0, 0, 16, 16,
                parent as RawHWND,
                std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut(),
            ) as Hwnd
        }
    }

    pub fn show(hwnd: Hwnd) {
        if hwnd != 0 { unsafe { ShowWindow(hwnd as RawHWND, 5 /* SW_SHOW */); } }
    }

    pub fn hide(hwnd: Hwnd) {
        if hwnd != 0 { unsafe { ShowWindow(hwnd as RawHWND, 0 /* SW_HIDE */); } }
    }

    /// Keep the child window covering [x,y,w,h] (client-area physical pixels).
    pub fn move_to(hwnd: Hwnd, x: i32, y: i32, w: i32, h: i32) {
        if hwnd != 0 {
            unsafe { MoveWindow(hwnd as RawHWND, x, y, w.max(16), h.max(16), 1); }
        }
    }

    /// Bring child window to the top of Z-order (above egui OpenGL surface).
    pub fn bring_to_top(hwnd: Hwnd) {
        if hwnd != 0 {
            // SWP_NOSIZE|SWP_NOMOVE = 0x0003; HWND_TOP = null ptr
            unsafe { SetWindowPos(hwnd as RawHWND, std::ptr::null_mut(), 0, 0, 0, 0, 0x0003); }
        }
    }

    pub fn destroy(hwnd: Hwnd) {
        if hwnd != 0 { unsafe { DestroyWindow(hwnd as RawHWND); } }
    }
}

// ── colours ───────────────────────────────────────────────────────────────────
const BG:      egui::Color32 = egui::Color32::from_rgb(0x0a, 0x0b, 0x12);
const SURFACE: egui::Color32 = egui::Color32::from_rgb(0x12, 0x14, 0x1d);
const TEXT:    egui::Color32 = egui::Color32::from_rgb(0xe6, 0xe8, 0xef);
const MUTED:   egui::Color32 = egui::Color32::from_rgb(0x8b, 0x90, 0xa3);
const CYAN:    egui::Color32 = egui::Color32::from_rgb(0x2d, 0xd4, 0xff);
const MAGENTA: egui::Color32 = egui::Color32::from_rgb(0xff, 0x5c, 0xf0);
const VIOLET:  egui::Color32 = egui::Color32::from_rgb(0xa7, 0x8b, 0xfa);
const GREEN:   egui::Color32 = egui::Color32::from_rgb(0x34, 0xd3, 0x99);
const AMBER:   egui::Color32 = egui::Color32::from_rgb(0xfb, 0xbf, 0x24);
const RED:     egui::Color32 = egui::Color32::from_rgb(0xf8, 0x71, 0x71);

// ── data types ────────────────────────────────────────────────────────────────
#[derive(Clone, Debug)]
struct SearchResult {
    file_name: String,
    abs_path: String,
    start_sec: f64,
    end_sec: f64,
    content: String,
    speaker_name: Option<String>,
    speaker_confidence: Option<f64>,
    needs_review: bool,
    attribution_conflict: bool,
    similarity: f64,
    utterance_id: Option<String>,
}

#[derive(Clone, Debug)]
struct QueueItem {
    file_name: String,
    #[allow(dead_code)]
    abs_path: String,
    start_sec: f64,
    end_sec: f64,
    label: String,
}

#[derive(Debug, Clone)]
enum SearchState { Idle, Searching, Done(Vec<SearchResult>), Error(String) }

#[derive(Debug, Clone, PartialEq)]
enum IngestState { Idle, Running(String), Done(String), Error(String) }

// ── app state ─────────────────────────────────────────────────────────────────
struct ForensicApp {
    project_root: PathBuf,
    db_path: PathBuf,
    vec_ext_path: PathBuf,
    python_bin: PathBuf,
    ffmpeg_bin: String,
    node_bin: PathBuf,
    log_path: PathBuf,

    query: String,
    search_state: Arc<Mutex<SearchState>>,
    selected: Option<SearchResult>,
    queue: Vec<QueueItem>,

    status_message: String,
    status_at: Instant,
    speaker_edit: String,
    show_speaker_edit: bool,
    db_action: Arc<Mutex<Option<DbAction>>>,
    ingest_state: Arc<Mutex<IngestState>>,
    auto_search: bool,

    // Embedded mpv player (Win32 child-window approach)
    main_hwnd: isize,           // eframe window HWND (0 until found)
    video_hwnd: isize,          // child HWND for mpv --wid (0 until created)
    mpv_process: Option<Child>, // running mpv process
    last_video_rect: [i32; 4],  // cached [x,y,w,h] — avoids redundant MoveWindow calls
    mpv_available: Option<bool>,// cached: is mpv.exe on PATH?
}

#[derive(Debug)]
enum DbAction {
    Confirm(String),
    Reject(String),
    SetSpeaker(String, String),
}

// ── helpers ───────────────────────────────────────────────────────────────────

/// Spawn a command with CREATE_NO_WINDOW so no console terminal appears.
fn cmd_no_window(program: impl AsRef<OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    cmd
}

fn read_env_var(root: &Path, key: &str) -> Option<String> {
    let c = std::fs::read_to_string(root.join(".env")).ok()?;
    for line in c.lines() {
        let line = line.trim();
        if line.starts_with('#') || line.is_empty() { continue; }
        if let Some((k, v)) = line.split_once('=') {
            if k.trim() == key {
                let v = v.trim().trim_matches('"').trim_matches('\'');
                if !v.is_empty() { return Some(v.to_string()); }
            }
        }
    }
    None
}

fn resolve_path(root: &Path, val: Option<String>, default_rel: &str) -> PathBuf {
    let s = val.unwrap_or_else(|| default_rel.to_string());
    let p = PathBuf::from(&s);
    if p.is_absolute() { p } else {
        root.join(s.trim_start_matches("./").trim_start_matches(".\\"))
    }
}

fn fmt_ts(sec: f64) -> String {
    let sec = sec as u64;
    let (h, m, s) = (sec / 3600, (sec % 3600) / 60, sec % 60);
    if h > 0 { format!("{h}:{m:02}:{s:02}") } else { format!("{m}:{s:02}") }
}

fn log_line(path: &Path, msg: &str) {
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(path) {
        use std::time::{SystemTime, UNIX_EPOCH};
        let secs = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_secs();
        let _ = writeln!(f, "[{:02}:{:02}:{:02}] {msg}",
            (secs / 3600) % 24, (secs / 60) % 60, secs % 60);
    }
}

fn find_ffmpeg() -> String {
    let candidates = [
        r"C:\Program Files\ffmpeg\ffmpeg-2025-05-05-git-f4e72eb5a3-full_build\bin\ffmpeg.exe",
        r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
        r"C:\ProgramData\chocolatey\bin\ffmpeg.exe",
        r"C:\ProgramData\anaconda3\Library\bin\ffmpeg.exe",
    ];
    for c in &candidates { if Path::new(c).exists() { return c.to_string(); } }
    "ffmpeg".to_string()
}

fn find_node() -> PathBuf {
    let candidates = [
        r"C:\Program Files\nodejs\node.exe",
        r"C:\Program Files (x86)\nodejs\node.exe",
    ];
    for c in &candidates { if Path::new(c).exists() { return PathBuf::from(c); } }
    PathBuf::from("node")
}

fn find_ffplay(ffmpeg_bin: &str) -> String {
    PathBuf::from(ffmpeg_bin)
        .parent()
        .map(|d| d.join("ffplay.exe"))
        .filter(|p| p.exists())
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|| "ffplay".to_string())
}

fn find_mpv() -> String {
    let candidates = [
        r"C:\Program Files\MPV Player\mpv.exe",
        r"C:\Program Files (x86)\MPV Player\mpv.exe",
        r"C:\mpv\mpv.exe",
        r"C:\tools\mpv\mpv.exe",
    ];
    for c in &candidates {
        if Path::new(c).exists() { return c.to_string(); }
    }
    // Check LOCALAPPDATA\Programs\mpv\mpv.exe
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let p = PathBuf::from(&local).join("Programs").join("mpv").join("mpv.exe");
        if p.exists() { return p.to_string_lossy().to_string(); }
    }
    "mpv".to_string() // fall back to PATH
}

// ── DB ────────────────────────────────────────────────────────────────────────
fn open_db(db_path: &Path, vec_ext: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open_with_flags(
        db_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    unsafe {
        conn.load_extension_enable()?;
        conn.load_extension(vec_ext, None)?;
        conn.load_extension_disable()?;
    }
    Ok(conn)
}

fn knn_search(conn: &Connection, vec_bytes: &[u8], k: usize) -> rusqlite::Result<Vec<SearchResult>> {
    let sql = format!(r#"
SELECT s.file_name, s.abs_path,
       m.start_sec, m.end_sec, m.content,
       u.speaker_name, u.speaker_confidence,
       u.needs_review, u.attribution_conflict,
       1 - v.distance AS similarity,
       u.id AS utterance_id
FROM (
  SELECT rowid, distance FROM embeddings_vec
  WHERE embedding MATCH ?1 AND k = {k}
  ORDER BY distance
) v
JOIN embeddings_meta m ON m.id = v.rowid
JOIN sources s ON s.id = m.source_id
LEFT JOIN utterances u ON u.id = m.ref_id AND m.ref_kind = 'utterance'
WHERE m.modality = 'text'
ORDER BY v.distance
    "#);
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map(params![vec_bytes], |row| {
        Ok(SearchResult {
            file_name:            row.get::<_, String>(0)?,
            abs_path:             row.get::<_, String>(1)?,
            start_sec:            row.get::<_, f64>(2).unwrap_or(0.0),
            end_sec:              row.get::<_, f64>(3).unwrap_or(0.0),
            content:              row.get::<_, String>(4).unwrap_or_default(),
            speaker_name:         row.get::<_, Option<String>>(5)?,
            speaker_confidence:   row.get::<_, Option<f64>>(6)?,
            needs_review:         row.get::<_, Option<i32>>(7)?.unwrap_or(0) != 0,
            attribution_conflict: row.get::<_, Option<i32>>(8)?.unwrap_or(0) != 0,
            similarity:           row.get::<_, f64>(9).unwrap_or(0.0),
            utterance_id:         row.get::<_, Option<String>>(10)?,
        })
    })?;
    let mut out = Vec::new();
    for r in rows { out.push(r?); }
    Ok(out)
}

fn embed_query(python_bin: &Path, project_root: &Path, query: &str) -> Result<Vec<f32>, String> {
    let b64 = base64::engine::general_purpose::STANDARD
        .encode(serde_json::json!([query]).to_string().as_bytes());
    let output = cmd_no_window(python_bin) // no console window
        .args(["scripts/embed_text.py", "--texts-b64", &b64,
               "--model", "Qwen/Qwen3-Embedding-0.6B"])
        .current_dir(project_root)
        .stdout(Stdio::piped()).stderr(Stdio::piped())
        .output()
        .map_err(|e| format!("python spawn: {e}"))?;
    if !output.status.success() {
        return Err(format!("embed_text.py: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let json: Value = serde_json::from_str(&text).map_err(|e| format!("json: {e}"))?;
    let arr = json["vectors"][0].as_array().ok_or("no vectors[0]")?;
    Ok(arr.iter().map(|v| v.as_f64().unwrap_or(0.0) as f32).collect())
}

fn floats_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut b = Vec::with_capacity(v.len() * 4);
    for f in v { b.extend_from_slice(&f.to_le_bytes()); }
    b
}

// ── ForensicApp ───────────────────────────────────────────────────────────────
impl ForensicApp {
    fn new(_cc: &eframe::CreationContext<'_>, initial_query: String) -> Self {
        let exe = std::env::current_exe().unwrap_or_default();
        let project_root = exe
            .parent().and_then(|p| p.parent())
            .and_then(|p| p.parent()).and_then(|p| p.parent())
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("."));

        let db_path = resolve_path(
            &project_root,
            read_env_var(&project_root, "SQLITE_DB_PATH"),
            "forensic.db",
        );
        let vec_ext = resolve_path(
            &project_root,
            read_env_var(&project_root, "SQLITE_VEC_PATH"),
            "models/sqlite-vec/vec0.dll",
        );
        let python = resolve_path(
            &project_root,
            read_env_var(&project_root, "PYTHON_BIN"),
            ".venv/Scripts/python.exe",
        );

        let _ = std::fs::create_dir_all(project_root.join("tmp"));
        let _ = std::fs::create_dir_all(project_root.join("osint-export").join("clips"));
        let log_path = project_root.join("tmp").join("gui.log");

        let auto_search = !initial_query.is_empty();
        let app = ForensicApp {
            project_root,
            db_path,
            vec_ext_path: vec_ext,
            python_bin: python,
            ffmpeg_bin: find_ffmpeg(),
            node_bin: find_node(),
            log_path: log_path.clone(),
            query: initial_query,
            search_state: Arc::new(Mutex::new(SearchState::Idle)),
            selected: None,
            queue: Vec::new(),
            status_message: "Ready — click '+ Footage' to ingest, or search indexed footage.".to_string(),
            status_at: Instant::now(),
            speaker_edit: String::new(),
            show_speaker_edit: false,
            db_action: Arc::new(Mutex::new(None)),
            ingest_state: Arc::new(Mutex::new(IngestState::Idle)),
            auto_search,
            main_hwnd: 0,
            video_hwnd: 0,
            mpv_process: None,
            last_video_rect: [0; 4],
            mpv_available: None,
        };
        log_line(&log_path, "forensic-gui started");
        app
    }

    fn set_status(&mut self, msg: impl Into<String>) {
        self.status_message = msg.into();
        self.status_at = Instant::now();
        log_line(&self.log_path, &self.status_message);
    }

    /// Try to find/create the Win32 child window for mpv embedding.
    /// Safe to call every frame — no-ops once both HWNDs are found.
    fn init_video_window(&mut self) {
        #[cfg(windows)]
        {
            if self.video_hwnd != 0 { return; }
            if self.main_hwnd == 0 {
                let h = win_video::find_by_title("Forensic Video Intelligence");
                if h != 0 {
                    self.main_hwnd = h;
                    log_line(&self.log_path, &format!("main_hwnd: 0x{:x}", h));
                }
            }
            if self.main_hwnd != 0 {
                let h = win_video::create_child(self.main_hwnd);
                if h != 0 {
                    self.video_hwnd = h;
                    log_line(&self.log_path, &format!("video_hwnd: 0x{:x}", h));
                }
            }
        }
    }

    fn mpv_on_path(&mut self) -> bool {
        if let Some(v) = self.mpv_available { return v; }
        let mpv = find_mpv();
        let ok = cmd_no_window(&mpv)
            .arg("--version")
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false);
        self.mpv_available = Some(ok);
        log_line(&self.log_path, &format!("mpv_available: {ok} (path: {mpv})"));
        ok
    }

    fn start_search(&mut self, ctx: egui::Context) {
        let query = self.query.trim().to_string();
        if query.is_empty() { return; }
        log_line(&self.log_path, &format!("search: {query}"));
        *self.search_state.lock().unwrap() = SearchState::Searching;

        let state  = Arc::clone(&self.search_state);
        let python = self.python_bin.clone();
        let root   = self.project_root.clone();
        let db     = self.db_path.clone();
        let ext    = self.vec_ext_path.clone();

        thread::spawn(move || {
            let result = (|| -> Result<Vec<SearchResult>, String> {
                let floats = embed_query(&python, &root, &query)?;
                let bytes  = floats_to_bytes(&floats);
                let conn   = open_db(&db, &ext).map_err(|e| format!("DB: {e}"))?;
                knn_search(&conn, &bytes, 20).map_err(|e| format!("KNN: {e}"))
            })();
            *state.lock().unwrap() = match result {
                Ok(r)  => SearchState::Done(r),
                Err(e) => SearchState::Error(e),
            };
            ctx.request_repaint();
        });
    }

    /// Open video at timestamp.
    ///
    /// Primary: mpv embedded in the Win32 child window via --wid.
    /// Fallback: ffplay (no console window) in a separate OS window.
    /// Last resort: Windows default player.
    fn open_video_at(&mut self, result: &SearchResult) {
        let abs   = self.resolve_abs(&result.abs_path);
        let start = result.start_sec;

        // Kill any existing mpv
        if let Some(mut child) = self.mpv_process.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        #[cfg(windows)]
        win_video::hide(self.video_hwnd);

        log_line(&self.log_path, &format!("open_video: {abs} @{start:.1}s"));

        // ── Primary: mpv embedded via Win32 --wid ────────────────────────────
        #[cfg(windows)]
        if self.video_hwnd != 0 && self.mpv_on_path() {
            let wid = format!("--wid={}", self.video_hwnd);
            let mpv_exe = find_mpv();
            match cmd_no_window(&mpv_exe)
                .args([
                    &wid,
                    "--no-terminal",
                    "--no-input-default-bindings",
                    "--pause=no",
                    "--keep-open=yes",
                    "--force-window=yes",
                    "--hwdec=auto",
                    &format!("--start={start:.3}"),
                    "--",
                    &abs,
                ])
                .spawn()
            {
                Ok(child) => {
                    self.mpv_process = Some(child);
                    win_video::show(self.video_hwnd);
                    win_video::bring_to_top(self.video_hwnd);
                    self.set_status(format!(
                        "Playing: {} at {}",
                        result.file_name, fmt_ts(start)
                    ));
                    return;
                }
                Err(e) => {
                    log_line(&self.log_path, &format!("mpv spawn failed: {e}"));
                    self.mpv_available = Some(false);
                }
            }
        }

        // Notify user if mpv not installed
        if !self.mpv_on_path() {
            self.set_status(
                "mpv not installed — inline video requires mpv. Run:  winget install mpv"
            );
        }

        // ── Fallback: ffplay (no console terminal) ───────────────────────────
        let ffplay = find_ffplay(&self.ffmpeg_bin);
        if cmd_no_window(&ffplay)
            .args([
                "-ss", &format!("{start:.3}"),
                "-i", &abs,
                "-autoexit",
                "-hide_banner",
                "-loglevel", "quiet",
            ])
            .spawn()
            .is_ok()
        {
            log_line(&self.log_path, &format!("ffplay fallback @{start:.1}s (no terminal)"));
            return;
        }

        // ── Last resort: Windows default player ──────────────────────────────
        let _ = cmd_no_window("cmd").args(["/c", "start", "", &abs]).spawn();
        log_line(&self.log_path, "default player fallback");
    }

    fn clip_result(&mut self, result: &SearchResult) {
        let duration = (result.end_sec - result.start_sec).max(1.0);
        let stem = Path::new(&result.file_name)
            .file_stem().unwrap_or_default().to_string_lossy().to_string();
        let out_name = format!("{stem}_{:.0}-{:.0}.mp4", result.start_sec, result.end_sec);
        let out_path = self.project_root.join("osint-export").join("clips").join(&out_name);
        let abs = self.resolve_abs(&result.abs_path);
        let ok = cmd_no_window(&self.ffmpeg_bin)
            .args([
                "-y",
                "-ss", &format!("{:.3}", result.start_sec),
                "-i", &abs,
                "-t", &format!("{duration:.3}"),
                "-c", "copy",
                out_path.to_str().unwrap_or("clip.mp4"),
            ])
            .current_dir(&self.project_root)
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false);
        if ok {
            self.set_status(format!("Clipped → osint-export/clips/{out_name}"));
            log_line(&self.log_path, &format!("clip: {out_name}"));
        } else {
            self.set_status("Clip failed — check tmp/gui.log");
        }
    }

    fn stitch_queue(&mut self) {
        if self.queue.is_empty() { self.set_status("Queue is empty"); return; }
        let list_path = self.project_root.join("tmp").join("stitch_list.txt");
        let out_path  = self.project_root.join("osint-export").join("clips").join("stitched_output.mp4");
        let list: String = self.queue.iter().map(|i| {
            let stem = Path::new(&i.file_name)
                .file_stem().unwrap_or_default().to_string_lossy().to_string();
            let clip = format!("{stem}_{:.0}-{:.0}.mp4", i.start_sec, i.end_sec);
            let p = self.project_root.join("osint-export").join("clips").join(&clip);
            format!("file '{}'\n", p.display())
        }).collect();
        if std::fs::write(&list_path, &list).is_err() {
            self.set_status("Could not write stitch list");
            return;
        }
        let ok = cmd_no_window(&self.ffmpeg_bin)
            .args([
                "-y", "-f", "concat", "-safe", "0",
                "-i", list_path.to_str().unwrap_or("list.txt"),
                "-c", "copy",
                out_path.to_str().unwrap_or("stitched.mp4"),
            ])
            .stdout(Stdio::null()).stderr(Stdio::null())
            .status().map(|s| s.success()).unwrap_or(false);
        if ok {
            self.set_status("Stitched → osint-export/clips/stitched_output.mp4");
        } else {
            self.set_status("Stitch failed — clip each segment first");
        }
    }

    fn pick_and_ingest(&self, ctx: egui::Context) {
        if matches!(*self.ingest_state.lock().unwrap(), IngestState::Running(_)) { return; }
        let ingest = Arc::clone(&self.ingest_state);
        let node   = self.node_bin.clone();
        let root   = self.project_root.clone();
        let log    = self.log_path.clone();
        thread::spawn(move || {
            let picked = rfd::FileDialog::new()
                .add_filter("Video", &["mp4","mkv","mov","avi","mts","m2ts","mpg","mpeg","wmv"])
                .set_title("Select footage to ingest")
                .pick_file();
            if let Some(path) = picked {
                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                *ingest.lock().unwrap() = IngestState::Running(name.clone());
                ctx.request_repaint();
                log_line(&log, &format!("ingest: {}", path.display()));
                let r = cmd_no_window(&node)
                    .args(["src/ingest.js", &path.to_string_lossy()])
                    .current_dir(&root)
                    .status();
                *ingest.lock().unwrap() = match r {
                    Ok(s) if s.success() =>
                        IngestState::Done(format!("'{name}' indexed — search to find content.")),
                    Ok(s) =>
                        IngestState::Error(format!(
                            "Ingest failed (exit {}). See tmp/gui.log",
                            s.code().unwrap_or(-1)
                        )),
                    Err(e) =>
                        IngestState::Error(format!("Node.js not found: {e}")),
                };
                ctx.request_repaint();
            }
        });
    }

    fn resolve_abs(&self, path: &str) -> String {
        let p = Path::new(path);
        if p.is_absolute() { path.to_string() }
        else { self.project_root.join(path).to_string_lossy().to_string() }
    }

    fn apply_db_action(&mut self) {
        let action = self.db_action.lock().unwrap().take();
        if action.is_none() { return; }
        let conn = match open_db(&self.db_path, &self.vec_ext_path) {
            Ok(c) => c,
            Err(e) => { self.set_status(format!("DB: {e}")); return; }
        };
        match action.unwrap() {
            DbAction::Confirm(id) => {
                let _ = conn.execute(
                    "UPDATE utterances SET needs_review=0 WHERE id=?1",
                    params![id],
                );
                self.set_status(format!("Confirmed {}", &id[..8.min(id.len())]));
            }
            DbAction::Reject(id) => {
                let _ = conn.execute(
                    "UPDATE utterances SET needs_review=1,attribution_conflict=1 WHERE id=?1",
                    params![id],
                );
                self.set_status(format!("Rejected {}", &id[..8.min(id.len())]));
            }
            DbAction::SetSpeaker(id, name) => {
                let _ = conn.execute(
                    "UPDATE utterances SET speaker_name=?1,needs_review=0 WHERE id=?2",
                    params![name, id],
                );
                self.set_status(format!("Speaker → '{name}'"));
            }
        }
    }

    /// Keep the Win32 child window aligned over the egui video panel rect.
    fn sync_video_window(&mut self, video_rect: egui::Rect, scale: f32) {
        #[cfg(windows)]
        if self.video_hwnd != 0 {
            let x = (video_rect.min.x * scale) as i32;
            let y = (video_rect.min.y * scale) as i32;
            let w = (video_rect.width()  * scale) as i32;
            let h = (video_rect.height() * scale) as i32;
            let r = [x, y, w, h];
            if self.last_video_rect != r {
                win_video::move_to(self.video_hwnd, x, y, w, h);
                self.last_video_rect = r;
            }
            if self.mpv_process.is_some() {
                win_video::bring_to_top(self.video_hwnd);
            }
        }
    }
}

impl Drop for ForensicApp {
    fn drop(&mut self) {
        if let Some(mut child) = self.mpv_process.take() {
            let _ = child.kill();
        }
        #[cfg(windows)]
        win_video::destroy(self.video_hwnd);
    }
}

// ── eframe::App ───────────────────────────────────────────────────────────────
impl eframe::App for ForensicApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut eframe::Frame) {
        // Housekeeping
        if self.auto_search { self.auto_search = false; self.start_search(ctx.clone()); }
        self.apply_db_action();
        self.init_video_window();

        // Detect mpv exit so we can hide the child window
        let mpv_exited = self.mpv_process.as_mut()
            .and_then(|c| c.try_wait().ok())
            .flatten()
            .is_some();
        if mpv_exited {
            self.mpv_process = None;
            #[cfg(windows)]
            win_video::hide(self.video_hwnd);
        }

        let searching = matches!(*self.search_state.lock().unwrap(), SearchState::Searching);
        let ingesting = matches!(*self.ingest_state.lock().unwrap(), IngestState::Running(_));
        if searching || ingesting || self.mpv_process.is_some() {
            ctx.request_repaint_after(Duration::from_millis(100));
        }

        // Style
        let mut style = (*ctx.style()).clone();
        style.visuals.window_fill = BG;
        style.visuals.panel_fill  = BG;
        style.visuals.override_text_color = Some(TEXT);
        style.visuals.widgets.noninteractive.bg_fill = SURFACE;
        style.visuals.widgets.inactive.bg_fill = SURFACE;
        style.visuals.widgets.hovered.bg_fill  = egui::Color32::from_rgb(0x1a, 0x1c, 0x2a);
        style.visuals.widgets.active.bg_fill   = egui::Color32::from_rgb(0x22, 0x25, 0x38);
        style.visuals.selection.bg_fill =
            egui::Color32::from_rgba_premultiplied(0x2d, 0xd4, 0xff, 0x40);
        ctx.set_style(style);

        // ── header ───────────────────────────────────────────────────────────
        egui::TopBottomPanel::top("hdr")
            .frame(egui::Frame::none()
                .fill(SURFACE)
                .inner_margin(egui::Margin::symmetric(12.0, 6.0)))
            .show(ctx, |ui| {
                ui.vertical(|ui| {
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new("FORENSIC INTEL").color(CYAN).strong().size(14.0)
                        );
                        ui.add_space(12.0);
                        let busy = matches!(
                            *self.search_state.lock().unwrap(), SearchState::Searching
                        );
                        ui.add_enabled_ui(!busy, |ui| {
                            let r = ui.add(
                                egui::TextEdit::singleline(&mut self.query)
                                    .hint_text("describe what you're looking for…")
                                    .desired_width(f32::INFINITY)
                                    .font(egui::TextStyle::Monospace),
                            );
                            if r.lost_focus()
                                && ui.input(|i| i.key_pressed(egui::Key::Enter))
                            {
                                self.start_search(ctx.clone());
                            }
                        });
                        ui.add_space(8.0);
                        if ui.add(
                            egui::Button::new(
                                egui::RichText::new(if searching { "…" } else { "Search" })
                                    .color(BG).strong()
                            )
                            .fill(CYAN)
                            .min_size(egui::vec2(70.0, 28.0))
                        ).clicked() {
                            self.start_search(ctx.clone());
                        }
                    });
                    ui.horizontal(|ui| {
                        let ingest = self.ingest_state.lock().unwrap().clone();
                        let busy   = matches!(ingest, IngestState::Running(_));
                        if ui.add(
                            egui::Button::new(
                                egui::RichText::new(
                                    if busy { "Ingesting…" } else { "+ Footage" }
                                ).color(BG).strong()
                            )
                            .fill(if busy { MUTED } else { AMBER })
                            .min_size(egui::vec2(100.0, 24.0))
                        )
                        .on_hover_text("Pick a video file to transcribe and index")
                        .clicked() && !busy {
                            self.pick_and_ingest(ctx.clone());
                        }
                        ui.add_space(8.0);
                        match &ingest {
                            IngestState::Running(n) => {
                                ui.label(
                                    egui::RichText::new(
                                        format!("Processing '{n}'… (may take minutes)")
                                    ).color(AMBER).size(11.0)
                                );
                            }
                            IngestState::Done(m) => {
                                ui.label(egui::RichText::new(m).color(GREEN).size(11.0));
                            }
                            IngestState::Error(m) => {
                                ui.label(egui::RichText::new(m).color(RED).size(11.0));
                            }
                            IngestState::Idle => {}
                        }
                    });
                });
            });

        // ── status bar ───────────────────────────────────────────────────────
        egui::TopBottomPanel::bottom("sb")
            .frame(egui::Frame::none()
                .fill(SURFACE)
                .inner_margin(egui::Margin::symmetric(12.0, 4.0)))
            .show(ctx, |ui| {
                let color = if self.status_at.elapsed().as_secs() < 6 { GREEN } else { MUTED };
                ui.label(egui::RichText::new(&self.status_message).color(color).size(11.0));
            });

        // ── body ─────────────────────────────────────────────────────────────
        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(BG))
            .show(ctx, |ui| {
                let left_w  = ui.available_width() * 0.50 - 4.0;
                let right_w = ui.available_width() - left_w - 8.0;
                ui.horizontal_top(|ui| {
                    ui.allocate_ui(egui::vec2(left_w, ui.available_height()), |ui| {
                        self.draw_results_panel(ui, ctx);
                    });
                    ui.separator();
                    ui.allocate_ui(egui::vec2(right_w, ui.available_height()), |ui| {
                        self.draw_video_panel(ui, ctx);
                    });
                });
            });
    }
}

impl ForensicApp {
    fn draw_results_panel(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        ui.vertical(|ui| {
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new("RESULTS").color(VIOLET).strong().size(12.0));
                let state = self.search_state.lock().unwrap().clone();
                match &state {
                    SearchState::Done(r) => {
                        ui.label(
                            egui::RichText::new(format!("({} hits)", r.len()))
                                .color(MUTED).size(11.0)
                        );
                    }
                    SearchState::Searching => {
                        ui.label(egui::RichText::new("searching…").color(AMBER).size(11.0));
                        ctx.request_repaint_after(Duration::from_millis(200));
                    }
                    _ => {}
                }
            });
            ui.add_space(4.0);
            egui::ScrollArea::vertical().id_salt("res").show(ui, |ui| {
                let state = self.search_state.lock().unwrap().clone();
                match state {
                    SearchState::Idle       => self.draw_onboarding(ui),
                    SearchState::Searching  => {
                        ui.add_space(8.0);
                        ui.label(egui::RichText::new("Embedding query…").color(AMBER));
                    }
                    SearchState::Error(ref e) => {
                        ui.add_space(8.0);
                        ui.label(egui::RichText::new(format!("Search error: {e}")).color(RED));
                        ui.label(
                            egui::RichText::new("Ingest footage first, or check tmp/gui.log")
                                .color(MUTED).size(11.0)
                        );
                    }
                    SearchState::Done(ref results) => {
                        if results.is_empty() {
                            ui.label(
                                egui::RichText::new("No results — try rephrasing.").color(MUTED)
                            );
                        } else {
                            let cloned = results.clone();
                            for r in &cloned { self.draw_result_row(ui, r); }
                        }
                    }
                }
            });
        });
    }

    fn draw_onboarding(&self, ui: &mut egui::Ui) {
        ui.add_space(16.0);
        ui.label(egui::RichText::new("How to use this tool").color(VIOLET).strong().size(13.0));
        ui.add_space(12.0);

        let steps = [
            (
                "1.  Ingest footage",
                "Click  + Footage  (top-left). Pick any video file.\n\
                 Transcription, speaker diarization, and indexing run in the background.\n\
                 Takes ~2–5 min per hour of footage.",
            ),
            (
                "2.  Search",
                "Type what you're looking for in plain language and press Enter.\n\
                 Examples: 'argument at the door'  ·  'mentions of money'  ·  'phone call'",
            ),
            (
                "3.  Review clips",
                "Click  ► Select & Play  on any result.\n\
                 The video plays inline in the right panel at that exact moment.\n\
                 Requires mpv — if not installed:  winget install mpv",
            ),
            (
                "4.  Export",
                "Clip this  →  saves a standalone clip to osint-export/clips/\n\
                 + Queue  then  Stitch  →  exports multiple clips as one file.",
            ),
        ];
        for (title, body) in &steps {
            ui.label(egui::RichText::new(*title).color(CYAN).strong().size(12.0));
            ui.label(egui::RichText::new(*body).color(TEXT).size(11.0));
            ui.add_space(8.0);
        }
        ui.separator();
        ui.add_space(6.0);
        ui.label(egui::RichText::new(
            "Video player: mpv (inline panel)  ·  fallback: ffplay (separate window, no terminal)\n\
             Embeddings: Qwen3-Embedding runs as a background Python process (no window)\n\
             Clips: osint-export/clips/   ·   Log: tmp/gui.log"
        ).color(MUTED).size(10.0));
    }

    fn draw_result_row(&mut self, ui: &mut egui::Ui, result: &SearchResult) {
        let is_sel = self.selected.as_ref().map(|s| {
            (s.start_sec - result.start_sec).abs() < 0.01 && s.abs_path == result.abs_path
        }).unwrap_or(false);

        egui::Frame::none()
            .fill(if is_sel { egui::Color32::from_rgb(0x18, 0x1b, 0x2c) } else { SURFACE })
            .inner_margin(egui::Margin::same(8.0))
            .rounding(4.0)
            .show(ui, |ui| {
                ui.horizontal(|ui| {
                    ui.label(
                        egui::RichText::new(fmt_ts(result.start_sec))
                            .color(if is_sel { CYAN } else { VIOLET })
                            .strong().monospace()
                    );
                    ui.label(
                        egui::RichText::new(
                            result.speaker_name.as_deref().unwrap_or("unknown")
                        ).color(TEXT).size(12.0)
                    );
                    let sim = (result.similarity * 100.0) as i32;
                    let sc  = if sim >= 80 { GREEN } else if sim >= 60 { AMBER } else { MUTED };
                    ui.label(egui::RichText::new(format!("{sim}%")).color(sc).size(11.0));
                    if result.needs_review {
                        ui.label(egui::RichText::new("verify").color(AMBER).size(10.0));
                    }
                    if result.attribution_conflict {
                        ui.label(egui::RichText::new("conflict").color(RED).size(10.0));
                    }
                });
                let snippet = if result.content.len() > 200 {
                    format!("{}…", &result.content[..200])
                } else {
                    result.content.clone()
                };
                ui.label(egui::RichText::new(format!("\"{snippet}\"")).color(TEXT).size(12.0));
                ui.label(
                    egui::RichText::new(format!("  {}", result.file_name))
                        .color(MUTED).size(10.0)
                );
                ui.add_space(4.0);

                let btn_label = if is_sel { "► Playing" } else { "► Select & Play" };
                if ui.add(
                    egui::Button::new(egui::RichText::new(btn_label).color(BG))
                        .fill(if is_sel { CYAN } else { VIOLET })
                        .min_size(egui::vec2(110.0, 22.0))
                )
                .on_hover_text("Select and play at this exact timestamp")
                .clicked() {
                    let r = result.clone();
                    self.selected = Some(r.clone());
                    self.show_speaker_edit = false;
                    self.open_video_at(&r);
                }
            });
        ui.add_space(4.0);
    }

    fn draw_video_panel(&mut self, ui: &mut egui::Ui, ctx: &egui::Context) {
        let scale = ctx.pixels_per_point();
        ui.vertical(|ui| {
            ui.label(egui::RichText::new("VIDEO").color(VIOLET).strong().size(12.0));
            ui.add_space(4.0);

            // Allocate video rect — Win32 child window will cover this area
            let avail_w = ui.available_width();
            let video_h = (ui.available_height() * 0.50).max(200.0).min(420.0);
            let (video_rect, _) = ui.allocate_exact_size(
                egui::vec2(avail_w, video_h),
                egui::Sense::hover(),
            );

            // Dark background behind child window (visible when mpv is not running)
            ui.painter().rect_filled(
                video_rect, 4.0, egui::Color32::from_rgb(0x05, 0x06, 0x0c)
            );

            // Sync Win32 child window to this rect
            self.sync_video_window(video_rect, scale);

            let playing  = self.mpv_process.is_some();
            let has_sel  = self.selected.is_some();
            let mpv_ok   = self.mpv_available.unwrap_or(true); // assume available until checked

            if !playing {
                let center = video_rect.center();
                if has_sel {
                    if !mpv_ok {
                        ui.painter().text(
                            center - egui::vec2(0.0, 20.0),
                            egui::Align2::CENTER_CENTER,
                            "mpv not installed",
                            egui::FontId::proportional(16.0),
                            AMBER,
                        );
                        ui.painter().text(
                            center + egui::vec2(0.0, 8.0),
                            egui::Align2::CENTER_CENTER,
                            "Run in any terminal:  winget install mpv",
                            egui::FontId::proportional(11.0),
                            MUTED,
                        );
                    } else {
                        ui.painter().text(
                            center,
                            egui::Align2::CENTER_CENTER,
                            "mpv stopped — click ▶ Play Clip to replay",
                            egui::FontId::proportional(12.0),
                            MUTED,
                        );
                    }
                } else {
                    ui.painter().text(
                        center,
                        egui::Align2::CENTER_CENTER,
                        "Select a result to play",
                        egui::FontId::proportional(14.0),
                        MUTED,
                    );
                }
            }

            let selected = self.selected.clone();
            match selected {
                None => {
                    ui.add_space(12.0);
                    ui.label(
                        egui::RichText::new(
                            "Search for something, then click  ► Select & Play  on any result."
                        ).color(MUTED).size(11.0)
                    );
                }
                Some(result) => {
                    ui.add_space(6.0);
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new(
                                format!("{}  –  {}", fmt_ts(result.start_sec), fmt_ts(result.end_sec))
                            ).color(CYAN).monospace()
                        );
                        ui.add_space(8.0);
                        if ui.add(
                            egui::Button::new(
                                egui::RichText::new("▶ Play Clip").color(BG)
                            )
                            .fill(GREEN)
                            .min_size(egui::vec2(90.0, 26.0))
                        )
                        .on_hover_text("Open at this timestamp in the inline player")
                        .clicked() {
                            let r = result.clone();
                            self.open_video_at(&r);
                        }
                    });
                    ui.horizontal(|ui| {
                        let _ = ui.button(egui::RichText::new("⏮").color(MUTED).size(16.0));
                        let _ = ui.button(egui::RichText::new("◀▐").color(MUTED).size(14.0));
                        if ui.button(egui::RichText::new("▶").color(CYAN).strong().size(18.0))
                            .on_hover_text("Play at timestamp")
                            .clicked()
                        {
                            let r = result.clone();
                            self.open_video_at(&r);
                        }
                        let _ = ui.button(egui::RichText::new("▐▶").color(MUTED).size(14.0));
                        let _ = ui.button(egui::RichText::new("⏭").color(MUTED).size(16.0));
                        ui.label(
                            egui::RichText::new(fmt_ts(result.start_sec)).color(MUTED).monospace()
                        );
                    });

                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new(
                                result.speaker_name.as_deref().unwrap_or("unknown speaker")
                            ).color(TEXT).size(12.0)
                        );
                        if let Some(conf) = result.speaker_confidence {
                            ui.label(
                                egui::RichText::new(format!("{:.0}% conf", conf * 100.0))
                                    .color(MUTED).size(11.0)
                            );
                        }
                        if result.needs_review {
                            ui.label(egui::RichText::new("⚠ verify").color(AMBER).size(10.0));
                        }
                    });
                    ui.label(
                        egui::RichText::new(&result.file_name).color(MUTED).size(10.0)
                    );

                    ui.add_space(8.0);
                    ui.separator();
                    ui.add_space(4.0);

                    ui.horizontal(|ui| {
                        if ui.add(
                            egui::Button::new(egui::RichText::new("✂ Clip this").color(BG))
                                .fill(MAGENTA)
                                .min_size(egui::vec2(90.0, 26.0))
                        )
                        .on_hover_text("Export this segment as a standalone MP4 (ffmpeg copy)")
                        .clicked() {
                            let r = result.clone();
                            self.clip_result(&r);
                        }
                        if ui.add(
                            egui::Button::new(egui::RichText::new("+ Queue").color(BG))
                                .fill(AMBER)
                                .min_size(egui::vec2(70.0, 26.0))
                        )
                        .on_hover_text("Add to stitch queue")
                        .clicked() {
                            self.queue.push(QueueItem {
                                file_name: result.file_name.clone(),
                                abs_path:  result.abs_path.clone(),
                                start_sec: result.start_sec,
                                end_sec:   result.end_sec,
                                label:     fmt_ts(result.start_sec),
                            });
                            let n = self.queue.len();
                            self.set_status(format!("Queued ({n} clips)"));
                        }
                    });

                    ui.add_space(4.0);
                    ui.horizontal(|ui| {
                        ui.label(
                            egui::RichText::new(format!("QUEUE  {} clips", self.queue.len()))
                                .color(VIOLET).strong().size(11.0)
                        );
                        if !self.queue.is_empty() {
                            if ui.add(
                                egui::Button::new(egui::RichText::new("⬇ Stitch").color(BG))
                                    .fill(CYAN)
                                    .min_size(egui::vec2(70.0, 22.0))
                            )
                            .on_hover_text("Concatenate all queued clips → stitched_output.mp4")
                            .clicked() {
                                self.stitch_queue();
                            }
                            if ui.add(
                                egui::Button::new(egui::RichText::new("Clear").color(MUTED))
                                    .min_size(egui::vec2(50.0, 22.0))
                            ).clicked() {
                                self.queue.clear();
                                self.set_status("Queue cleared");
                            }
                        }
                    });
                    if !self.queue.is_empty() {
                        egui::ScrollArea::vertical().id_salt("q").max_height(60.0).show(ui, |ui| {
                            for item in &self.queue {
                                ui.label(
                                    egui::RichText::new(
                                        format!("  {} @{}", item.file_name, item.label)
                                    ).color(MUTED).size(10.0)
                                );
                            }
                        });
                    }

                    ui.add_space(8.0);
                    ui.separator();
                    ui.add_space(4.0);

                    ui.label(egui::RichText::new("REVIEW").color(VIOLET).strong().size(11.0));
                    if let Some(ref uid) = result.utterance_id {
                        let uid = uid.clone();
                        ui.horizontal(|ui| {
                            if ui.add(
                                egui::Button::new(egui::RichText::new("✓ Confirm").color(BG))
                                    .fill(GREEN)
                                    .min_size(egui::vec2(80.0, 24.0))
                            )
                            .on_hover_text("Mark attribution as verified")
                            .clicked() {
                                *self.db_action.lock().unwrap() =
                                    Some(DbAction::Confirm(uid.clone()));
                            }
                            if ui.add(
                                egui::Button::new(egui::RichText::new("✗ Reject").color(BG))
                                    .fill(RED)
                                    .min_size(egui::vec2(70.0, 24.0))
                            )
                            .on_hover_text("Flag as incorrect attribution")
                            .clicked() {
                                *self.db_action.lock().unwrap() =
                                    Some(DbAction::Reject(uid.clone()));
                            }
                            if ui.button(egui::RichText::new("Set Speaker…").color(CYAN)).clicked() {
                                self.show_speaker_edit = !self.show_speaker_edit;
                            }
                        });
                        if self.show_speaker_edit {
                            ui.horizontal(|ui| {
                                ui.label(egui::RichText::new("Name:").color(MUTED));
                                ui.text_edit_singleline(&mut self.speaker_edit);
                                if ui.add(
                                    egui::Button::new(egui::RichText::new("Set").color(BG))
                                        .fill(VIOLET)
                                ).clicked() && !self.speaker_edit.is_empty() {
                                    let name = self.speaker_edit.clone();
                                    *self.db_action.lock().unwrap() =
                                        Some(DbAction::SetSpeaker(uid.clone(), name));
                                    self.show_speaker_edit = false;
                                    self.speaker_edit.clear();
                                }
                            });
                        }
                    } else {
                        ui.label(
                            egui::RichText::new("(no utterance record)").color(MUTED).size(10.0)
                        );
                    }
                }
            }
        });
    }
}

// ── entry point ───────────────────────────────────────────────────────────────
fn main() -> eframe::Result {
    // Set working directory to project root so relative paths resolve correctly
    let exe = std::env::current_exe().unwrap_or_default();
    if let Some(root) = exe.parent().and_then(|p| p.parent())
        .and_then(|p| p.parent()).and_then(|p| p.parent())
    {
        let _ = std::env::set_current_dir(root);
    }

    let args: Vec<String> = std::env::args().collect();
    let initial_query = args.windows(2)
        .find(|w| w[0] == "--initial-query")
        .map(|w| w[1].clone())
        .unwrap_or_default();

    eframe::run_native(
        "Forensic Video Intelligence",
        eframe::NativeOptions {
            viewport: egui::ViewportBuilder::default()
                .with_title("Forensic Video Intelligence")
                .with_inner_size([1300.0, 860.0])
                .with_min_inner_size([900.0, 600.0]),
            ..Default::default()
        },
        Box::new(|cc| Ok(Box::new(ForensicApp::new(cc, initial_query)))),
    )
}
