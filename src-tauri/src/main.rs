// Hide the console window on Windows release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod server;

use serde::Serialize;
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

/// ffmpeg is downloaded once on first launch into the app's local data folder,
/// so app updates stay small (~5 MB) instead of re-shipping 78 MB of ffmpeg.
const FFMPEG_URL: &str = "https://github.com/NoahHendrickson/quickcut/releases/download/ffmpeg-8.1/ffmpeg-8.1-win64.zip";
const FFMPEG_SHA256: &str = "255fbc96564b7e72c816bc289f49b0aa2fb670690e8ff12f1c871bb40b3e64db";
const FFMPEG_BYTES: u64 = 78_393_898;
static ENGINE_DIR: OnceLock<PathBuf> = OnceLock::new();

const VIDEO_EXTS: &[&str] = &["mp4", "mov", "mkv", "m4v", "webm", "avi", "ts", "m2ts", "mts", "flv", "wmv"];
const AUDIO_EXTS: &[&str] = &["mp3", "wav", "ogg", "opus", "m4a", "aac", "flac", "wma"];

struct AppState {
    server: server::MediaServer,
    job: Mutex<Option<Child>>,
    cancelled: Mutex<bool>,
}

type CmdResult<T> = Result<T, String>;

// ---------------------------------------------------------------------------
// ffmpeg / ffprobe discovery and spawning
// ---------------------------------------------------------------------------

/// Find ffmpeg / ffprobe: next to the app (portable zip), in the downloaded
/// engine folder, else on PATH.
fn tool_path(name: &str) -> PathBuf {
    let file = if cfg!(windows) { format!("{name}.exe") } else { name.to_string() };
    let mut candidates = vec![];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.extend([dir.join(&file), dir.join("ffmpeg").join(&file), dir.join("bin").join(&file)]);
        }
    }
    if let Some(dir) = ENGINE_DIR.get() {
        candidates.push(dir.join(&file));
    }
    candidates.into_iter().find(|c| c.is_file()).unwrap_or_else(|| PathBuf::from(file))
}

fn tool(name: &str) -> Command {
    let mut c = Command::new(tool_path(name));
    c.stdin(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

fn run_capture(mut c: Command) -> CmdResult<String> {
    let out = c
        .output()
        .map_err(|e| format!("Couldn't start ffmpeg/ffprobe ({e}). Make sure ffmpeg.exe and ffprobe.exe are next to QuickCut.exe."))?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> CmdResult<T> + Send + 'static) -> CmdResult<T> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// A video passed on the command line ("Open with QuickCut", drag onto the exe).
#[tauri::command]
fn startup_file() -> Option<String> {
    std::env::args().skip(1).find(|a| Path::new(a).is_file())
}

#[tauri::command]
async fn probe(path: String) -> CmdResult<String> {
    blocking(move || {
        let mut c = tool("ffprobe");
        c.args(["-v", "error", "-show_format", "-show_streams", "-of", "json"]).arg(&path);
        run_capture(c)
    })
    .await
}

/// Keyframes near `t` as [pts, dts] pairs (seconds, relative to file start).
/// Only reads packet headers in a window around `t`, so it is fast on huge files.
/// The dts matters for splitting: a lossless part must stop reading *before*
/// the next part's keyframe in decode order, or B-frame reordering drags it in.
#[tauri::command]
async fn keyframes_near(path: String, t: f64, start: f64) -> CmdResult<Vec<[f64; 2]>> {
    blocking(move || {
        for window in [8.0, 30.0, 120.0, f64::INFINITY] {
            let from = (t - window).max(0.0);
            let interval = if window.is_infinite() {
                format!("%{:.3}", start + t + 0.5)
            } else {
                format!("{:.3}%{:.3}", start + from, start + t + 0.5)
            };
            let mut c = tool("ffprobe");
            c.args(["-v", "error", "-select_streams", "v:0", "-read_intervals", &interval])
                .args(["-show_entries", "packet=pts_time,dts_time,flags", "-of", "csv=p=0"])
                .arg(&path);
            let out = run_capture(c)?;
            let kfs: Vec<[f64; 2]> = out
                .lines()
                .filter_map(|l| {
                    let mut f = l.split(',');
                    let (pts, dts, flags) = (f.next()?, f.next()?, f.next()?);
                    if !flags.contains('K') {
                        return None;
                    }
                    let pts = pts.trim().parse::<f64>().ok()? - start;
                    let dts = dts.trim().parse::<f64>().map(|d| d - start).unwrap_or(pts);
                    Some([pts, dts])
                })
                .collect();
            if kfs.iter().any(|k| k[0] <= t + 0.0005) {
                return Ok(kfs);
            }
        }
        Ok(vec![[0.0, 0.0]])
    })
    .await
}

/// Which of the candidate encoders actually work on this machine.
/// Hardware encoders are listed by ffmpeg even without a matching GPU, so each
/// one is test-encoded briefly (in parallel).
#[tauri::command]
async fn detect_encoders(candidates: Vec<String>) -> CmdResult<Vec<String>> {
    blocking(move || {
        let mut c = tool("ffmpeg");
        c.args(["-hide_banner", "-encoders"]);
        let listing = run_capture(c)?;
        let listed: Vec<String> = candidates
            .into_iter()
            .filter(|name| listing.split_whitespace().any(|w| w == name))
            .collect();

        let handles: Vec<_> = listed
            .into_iter()
            .map(|name| {
                std::thread::spawn(move || {
                    if name.starts_with("lib") {
                        return Some(name);
                    }
                    let mut c = tool("ffmpeg");
                    c.args(["-v", "error", "-f", "lavfi", "-i", "color=black:s=1280x720:r=30:d=0.2"])
                        .args(["-frames:v", "3", "-c:v", &name, "-f", "null", "-"])
                        .stdout(Stdio::null())
                        .stderr(Stdio::null());
                    match c.status() {
                        Ok(s) if s.success() => Some(name),
                        _ => None,
                    }
                })
            })
            .collect();
        Ok(handles.into_iter().filter_map(|h| h.join().ok().flatten()).collect())
    })
    .await
}

#[derive(Clone, Serialize)]
struct Progress {
    ratio: f64,
    speed: String,
}

/// Run ffmpeg with the given args, streaming progress events ("ffmpeg-progress").
/// `duration` is the expected output length in seconds (for the progress ratio).
#[tauri::command]
async fn run_ffmpeg(app: AppHandle, state: State<'_, AppState>, args: Vec<String>, duration: f64) -> CmdResult<()> {
    let mut child = tool("ffmpeg")
        .args(&args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Couldn't start ffmpeg ({e}). Make sure ffmpeg.exe is next to QuickCut.exe."))?;

    let stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    {
        let mut job = state.job.lock().unwrap();
        if let Some(mut old) = job.take() {
            let _ = old.kill();
        }
        *job = Some(child);
        *state.cancelled.lock().unwrap() = false;
    }

    // Drain stderr on its own thread so ffmpeg never blocks on a full pipe.
    let err_thread = std::thread::spawn(move || {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s);
        s
    });

    let app2 = app.clone();
    let progress_thread = std::thread::spawn(move || {
        let mut speed = String::new();
        let mut last_emit = std::time::Instant::now() - std::time::Duration::from_secs(1);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(v) = line.strip_prefix("speed=") {
                speed = v.trim().to_string();
            } else if let Some(v) = line.strip_prefix("out_time_us=") {
                if let Ok(us) = v.trim().parse::<f64>() {
                    if last_emit.elapsed().as_millis() >= 100 {
                        last_emit = std::time::Instant::now();
                        let ratio = if duration > 0.0 { (us / 1e6 / duration).clamp(0.0, 1.0) } else { 0.0 };
                        let _ = app2.emit("ffmpeg-progress", Progress { ratio, speed: speed.clone() });
                    }
                }
            }
        }
    });

    // Wait for exit without holding the lock (so cancel can kill it).
    let status = loop {
        {
            let mut job = state.job.lock().unwrap();
            match job.as_mut() {
                Some(c) => match c.try_wait() {
                    Ok(Some(status)) => {
                        job.take();
                        break Some(status);
                    }
                    Ok(None) => {}
                    Err(_) => break None,
                },
                None => break None, // killed by cancel
            }
        }
        tokio_sleep(50).await;
    };
    let _ = progress_thread.join();
    let err = err_thread.join().unwrap_or_default();

    if *state.cancelled.lock().unwrap() {
        return Err("cancelled".into());
    }
    match status {
        Some(s) if s.success() => {
            let _ = app.emit("ffmpeg-progress", Progress { ratio: 1.0, speed: String::new() });
            Ok(())
        }
        _ => {
            let tail: Vec<&str> = err.lines().rev().take(12).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            Err(if tail.is_empty() { "ffmpeg failed".into() } else { tail.join("\n") })
        }
    }
}

async fn tokio_sleep(ms: u64) {
    tokio::time::sleep(std::time::Duration::from_millis(ms)).await;
}

#[tauri::command]
fn cancel_ffmpeg(state: State<'_, AppState>) {
    *state.cancelled.lock().unwrap() = true;
    if let Some(mut c) = state.job.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

#[tauri::command]
fn media_url(state: State<'_, AppState>, path: String) -> String {
    state.server.url_for(Path::new(&path))
}

/// Where the low-res preview copy of an unplayable video lives (temp dir, keyed
/// by path + size + mtime). Returns (path, already_exists).
#[tauri::command]
fn proxy_path(path: String) -> CmdResult<(String, bool)> {
    let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    let mut h = DefaultHasher::new();
    path.hash(&mut h);
    meta.len().hash(&mut h);
    if let Ok(m) = meta.modified() {
        m.hash(&mut h);
    }
    let dir = std::env::temp_dir().join("QuickCut-previews");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // "-1080": copies from older versions (720p, lower quality) are never reused.
    let p = dir.join(format!("{:016x}-1080.mp4", h.finish()));
    let exists = p.is_file() && p.metadata().map(|m| m.len() > 0).unwrap_or(false);
    Ok((p.to_string_lossy().to_string(), exists))
}

/// Filmstrip for the timeline: `count` thumbnails `height` px tall, evenly spread
/// over [start, start + duration], stacked side by side in one JPEG. Cached.
///
/// * Long ranges (the whole video): one keyframe per thumbnail via fast seeks, so a
///   1-hour video costs the same as a 1-minute one.
/// * Short ranges (zoomed in, <= 30 s): decode that stretch and take exact frames,
///   so precise trimming shows the real frames, not repeated keyframes.
#[tauri::command]
async fn filmstrip(path: String, start: Option<f64>, duration: f64, count: u32, height: u32) -> CmdResult<String> {
    blocking(move || {
        let start = start.unwrap_or(0.0).max(0.0);
        let count = count.clamp(2, 96);
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let mut h = DefaultHasher::new();
        (&path, meta.len(), count, height, (start * 1000.0) as i64, (duration * 1000.0) as i64).hash(&mut h);
        if let Ok(m) = meta.modified() {
            m.hash(&mut h);
        }
        let dir = std::env::temp_dir().join("QuickCut-previews");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(format!("strip-{:016x}.jpg", h.finish()));
        if out.is_file() {
            return Ok(out.to_string_lossy().to_string());
        }

        let mut c = tool("ffmpeg");
        c.args(["-v", "error", "-y"]);
        if duration <= 30.0 {
            c.args(["-hwaccel", "auto", "-ss", &format!("{start:.3}"), "-t", &format!("{duration:.3}"), "-i"]).arg(&path);
            let vf = format!(
                "fps={count}/{duration:.4},scale=-2:{height}:flags=fast_bilinear,setsar=1,tile={count}x1,scale=out_range=full,format=yuvj420p"
            );
            c.args(["-an", "-vf", &vf]);
        } else {
            let mut graph = String::new();
            let mut stack = String::new();
            for i in 0..count {
                let t = start + (i as f64 + 0.5) * duration / count as f64;
                c.args(["-ss", &format!("{t:.3}"), "-noaccurate_seek", "-i"]).arg(&path);
                graph.push_str(&format!(
                    "[{i}:V:0]trim=end_frame=1,setpts=0,scale=-2:{height}:flags=fast_bilinear,setsar=1[t{i}];"
                ));
                stack.push_str(&format!("[t{i}]"));
            }
            graph.push_str(&format!("{stack}hstack=inputs={count},scale=out_range=full,format=yuvj420p"));
            c.args(["-filter_complex", &graph]);
        }
        c.args(["-frames:v", "1", "-update", "1", "-q:v", "5"]).arg(&out);
        run_capture(c)?;
        if !out.is_file() {
            return Err("no thumbnails produced".into());
        }
        Ok(out.to_string_lossy().to_string())
    })
    .await
}

/// Audio waveform of the whole video (all tracks mixed) as a transparent PNG,
/// used to show loudness under the filmstrip. Cached. None if there's no audio.
#[tauri::command]
async fn waveform(path: String, tracks: u32, width: u32, height: u32) -> CmdResult<Option<String>> {
    blocking(move || {
        if tracks == 0 {
            return Ok(None);
        }
        let meta = std::fs::metadata(&path).map_err(|e| e.to_string())?;
        let mut h = DefaultHasher::new();
        (&path, meta.len(), tracks, width, height).hash(&mut h);
        if let Ok(m) = meta.modified() {
            m.hash(&mut h);
        }
        let dir = std::env::temp_dir().join("QuickCut-previews");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let out = dir.join(format!("wave-{:016x}.png", h.finish()));
        if out.is_file() {
            return Ok(Some(out.to_string_lossy().to_string()));
        }
        let mix = if tracks > 1 {
            let ins: String = (0..tracks).map(|i| format!("[0:a:{i}]")).collect();
            format!("{ins}amix=inputs={tracks}:normalize=0,")
        } else {
            "[0:a:0]".to_string()
        };
        let graph = format!(
            "{mix}aformat=channel_layouts=mono,showwavespic=s={width}x{height}:colors=white:scale=sqrt:draw=full:filter=peak"
        );
        let mut c = tool("ffmpeg");
        c.args(["-v", "error", "-y", "-i"]).arg(&path);
        c.args(["-vn", "-filter_complex", &graph, "-frames:v", "1", "-update", "1"]).arg(&out);
        run_capture(c)?;
        Ok(out.is_file().then(|| out.to_string_lossy().to_string()))
    })
    .await
}

#[tauri::command]
fn remove_file(path: String) {
    let _ = std::fs::remove_file(path);
}

fn has_ext(p: &Path, exts: &[&str]) -> bool {
    p.extension()
        .and_then(|e| e.to_str())
        .map(|e| exts.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

/// All videos in the same folder as `path`, sorted by name (for prev/next clip).
#[tauri::command]
fn sibling_videos(path: String) -> Vec<String> {
    let p = Path::new(&path);
    let Some(dir) = p.parent() else { return vec![] };
    let Ok(rd) = std::fs::read_dir(dir) else { return vec![] };
    let mut v: Vec<String> = rd
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && has_ext(p, VIDEO_EXTS))
        .map(|p| p.to_string_lossy().to_string())
        .collect();
    v.sort_by_key(|s| s.to_lowercase());
    v
}

/// Strip characters Windows doesn't allow in file names.
fn clean_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if "<>:\"/\\|?*".contains(c) || c.is_control() { '_' } else { c })
        .collect();
    cleaned.trim().trim_end_matches('.').to_string()
}

fn unique(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{stem}.{ext}"));
    let mut n = 2;
    while candidate.exists() {
        candidate = dir.join(format!("{stem} ({n}).{ext}"));
        n += 1;
    }
    candidate
}

/// Path for a *new* video: `<dir or source dir>/<name>.<ext>`, adding " (2)",
/// " (3)"… if that name is taken. Never returns the source path or any existing file.
#[tauri::command]
fn output_path(src: String, ext: String, name: String, dir: Option<String>) -> CmdResult<String> {
    let src = Path::new(&src);
    let dir = match dir.filter(|d| !d.is_empty() && Path::new(d).is_dir()) {
        Some(d) => PathBuf::from(d),
        None => src.parent().map(Path::to_path_buf).ok_or("bad path")?,
    };
    let mut stem = clean_name(&name);
    if stem.is_empty() {
        stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("clip").to_string() + "_edit";
    }
    Ok(unique(&dir, &stem, &ext).to_string_lossy().to_string())
}

/// Temporary file next to the original, used when replacing it. The original is
/// only touched after this has been fully written (see `replace_original`).
#[tauri::command]
fn temp_output_path(src: String, ext: String) -> CmdResult<String> {
    let src = Path::new(&src);
    let dir = src.parent().ok_or("bad path")?;
    let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("clip");
    Ok(unique(dir, &format!("{stem}.quickcut-tmp"), &ext).to_string_lossy().to_string())
}

/// Swap a finished export in for the original: the original goes to the Recycle
/// Bin (restorable), the export takes its name and its modified date (so the clip
/// keeps its place when sorted by date). Returns the final path.
#[tauri::command]
async fn replace_original(original: String, temp: String) -> CmdResult<String> {
    blocking(move || {
        let orig = PathBuf::from(&original);
        let tmp = PathBuf::from(&temp);
        if !tmp.is_file() {
            return Err("The exported file is missing.".into());
        }
        let modified = std::fs::metadata(&orig).and_then(|m| m.modified()).ok();
        let ext = tmp.extension().and_then(|e| e.to_str()).unwrap_or("mp4").to_string();

        trash::delete(&orig).map_err(|e| {
            format!("Couldn't move the original to the Recycle Bin ({e}). Nothing was replaced; your edit is saved as {temp}")
        })?;

        // Same name as the original; if the container changed (e.g. .ts -> .mkv)
        // and that name is already taken by another file, don't overwrite it.
        let mut target = orig.with_extension(&ext);
        if target != orig && target.exists() {
            let stem = orig.file_stem().and_then(|s| s.to_str()).unwrap_or("clip").to_string();
            target = unique(orig.parent().unwrap_or(Path::new(".")), &stem, &ext);
        }
        std::fs::rename(&tmp, &target).map_err(|e| {
            format!("The original is in the Recycle Bin, but renaming the edit failed ({e}). Your edit is saved as {temp}")
        })?;
        if let Some(m) = modified {
            if let Ok(f) = std::fs::OpenOptions::new().write(true).open(&target) {
                let _ = f.set_modified(m);
            }
        }
        Ok(target.to_string_lossy().to_string())
    })
    .await
}

#[tauri::command]
fn reveal(path: String) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("explorer").raw_arg(format!("/select,\"{path}\"")).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg("-R").arg(&path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        if let Some(dir) = Path::new(&path).parent() {
            let _ = Command::new("xdg-open").arg(dir).spawn();
        }
    }
}

#[tauri::command]
fn open_external(path: String) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        let _ = Command::new("explorer").raw_arg(format!("\"{path}\"")).spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = Command::new("open").arg(&path).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = Command::new("xdg-open").arg(&path).spawn();
    }
}

#[tauri::command]
fn is_file(path: String) -> bool {
    Path::new(&path).is_file()
}

#[tauri::command]
fn classify(paths: Vec<String>) -> (Vec<String>, Vec<String>) {
    let mut videos = vec![];
    let mut audio = vec![];
    for p in paths {
        let path = Path::new(&p);
        if has_ext(path, VIDEO_EXTS) {
            videos.push(p);
        } else if has_ext(path, AUDIO_EXTS) {
            audio.push(p);
        }
    }
    (videos, audio)
}

#[tauri::command]
async fn pick_video(app: AppHandle, dir: Option<String>) -> Option<String> {
    let mut d = app.dialog().file().set_title("Open video").add_filter("Videos", VIDEO_EXTS);
    if let Some(dir) = dir.filter(|d| Path::new(d).is_dir()) {
        d = d.set_directory(dir);
    }
    d.blocking_pick_file().and_then(|f| f.into_path().ok()).map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
async fn pick_sounds(app: AppHandle) -> Vec<String> {
    app.dialog()
        .file()
        .set_title("Add sound effects")
        .add_filter("Audio", AUDIO_EXTS)
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
        .collect()
}

#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("Choose export folder")
        .blocking_pick_folder()
        .and_then(|f| f.into_path().ok())
        .map(|p| p.to_string_lossy().to_string())
}

// ---------------------------------------------------------------------------
// One-time ffmpeg download ("video engine")
// ---------------------------------------------------------------------------

/// True when ffmpeg and ffprobe can be started.
#[tauri::command]
async fn engine_ready() -> bool {
    blocking(|| {
        let ok = |n: &str| tool(n).arg("-version").stdout(Stdio::null()).stderr(Stdio::null()).status().map(|s| s.success()).unwrap_or(false);
        Ok(ok("ffmpeg") && ok("ffprobe"))
    })
    .await
    .unwrap_or(false)
}

#[derive(Clone, Serialize)]
struct EngineProgress {
    ratio: f64,
    stage: &'static str,
}

/// Download, verify (SHA-256) and unpack ffmpeg into the app's data folder.
/// Uses curl.exe and tar.exe, which ship with Windows 10 and 11.
#[tauri::command]
async fn install_engine(app: AppHandle) -> CmdResult<()> {
    blocking(move || {
        if !cfg!(windows) {
            return Err("Install ffmpeg with your package manager (e.g. brew install ffmpeg).".into());
        }
        let dir = ENGINE_DIR.get().ok_or("no data folder")?.clone();
        let parent = dir.parent().ok_or("bad data folder")?.to_path_buf();
        std::fs::create_dir_all(&parent).map_err(|e| e.to_string())?;
        let zip = parent.join("ffmpeg-download.zip");
        let _ = std::fs::remove_file(&zip);

        let mut child = Command::new("curl.exe");
        child.args(["-L", "--fail", "--silent", "--show-error", "--retry", "3", "-o"]).arg(&zip).arg(FFMPEG_URL);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            child.creation_flags(0x0800_0000);
        }
        let mut child = child.stdin(Stdio::null()).stderr(Stdio::piped()).spawn().map_err(|e| format!("Couldn't start the download ({e})"))?;
        let status = loop {
            if let Some(st) = child.try_wait().map_err(|e| e.to_string())? {
                break st;
            }
            let got = std::fs::metadata(&zip).map(|m| m.len()).unwrap_or(0);
            let _ = app.emit("engine-progress", EngineProgress { ratio: (got as f64 / FFMPEG_BYTES as f64).min(0.99), stage: "download" });
            std::thread::sleep(std::time::Duration::from_millis(200));
        };
        if !status.success() {
            let mut err = String::new();
            if let Some(mut e) = child.stderr.take() {
                let _ = e.read_to_string(&mut err);
            }
            let _ = std::fs::remove_file(&zip);
            return Err(format!("Download failed. Check your internet connection and try again. ({})", err.trim()));
        }

        let _ = app.emit("engine-progress", EngineProgress { ratio: 1.0, stage: "verify" });
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        let mut f = std::fs::File::open(&zip).map_err(|e| e.to_string())?;
        std::io::copy(&mut f, &mut hasher).map_err(|e| e.to_string())?;
        drop(f);
        let hash = format!("{:x}", hasher.finalize());
        if hash != FFMPEG_SHA256 {
            let _ = std::fs::remove_file(&zip);
            return Err("The download was corrupted (checksum mismatch). Please try again.".into());
        }

        let _ = app.emit("engine-progress", EngineProgress { ratio: 1.0, stage: "unpack" });
        let tmp = parent.join("ffmpeg-unpacking");
        let _ = std::fs::remove_dir_all(&tmp);
        std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;
        let mut t = Command::new("tar.exe");
        t.arg("-xf").arg(&zip).arg("-C").arg(&tmp);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            t.creation_flags(0x0800_0000);
        }
        run_capture(t).map_err(|e| format!("Couldn't unpack ffmpeg: {e}"))?;
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::rename(&tmp, &dir).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&zip);
        Ok(())
    })
    .await
}

// ---------------------------------------------------------------------------
// In-app updates (signed; see scripts/release.mjs)
// ---------------------------------------------------------------------------

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn check_update(app: AppHandle) -> CmdResult<Option<UpdateInfo>> {
    let update = app.updater().map_err(|e| e.to_string())?.check().await.map_err(|e| e.to_string())?;
    Ok(update.map(|u| UpdateInfo { version: u.version.clone(), notes: u.body.clone() }))
}

#[derive(Clone, Serialize)]
struct UpdateProgress {
    downloaded: u64,
    total: Option<u64>,
}

/// Download + install the update, then restart into the new version.
#[tauri::command]
async fn install_update(app: AppHandle) -> CmdResult<()> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?
        .ok_or("You're already on the latest version.")?;
    let mut downloaded = 0u64;
    let app2 = app.clone();
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk as u64;
                let _ = app2.emit("update-progress", UpdateProgress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())?;
    app.restart();
}

fn main() {
    let server = server::MediaServer::start().expect("failed to start local media server");
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            if let Ok(dir) = app.path().app_local_data_dir() {
                let _ = ENGINE_DIR.set(dir.join("ffmpeg"));
            }
            Ok(())
        })
        .manage(AppState { server, job: Mutex::new(None), cancelled: Mutex::new(false) })
        .invoke_handler(tauri::generate_handler![
            startup_file,
            probe,
            keyframes_near,
            detect_encoders,
            run_ffmpeg,
            cancel_ffmpeg,
            media_url,
            proxy_path,
            filmstrip,
            waveform,
            remove_file,
            sibling_videos,
            output_path,
            temp_output_path,
            replace_original,
            reveal,
            open_external,
            is_file,
            classify,
            pick_video,
            pick_sounds,
            pick_folder,
            engine_ready,
            install_engine,
            app_version,
            check_update,
            install_update,
        ])
        .run(tauri::generate_context!())
        .expect("error while running QuickCut");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_video_paths_never_overwrite() {
        let dir = std::env::temp_dir().join("qc-naming-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("clip.mp4");
        std::fs::write(&src, b"original").unwrap();
        let src_s = src.to_string_lossy().to_string();

        let p = output_path(src_s.clone(), "mp4".into(), "clip_edit".into(), None).unwrap();
        assert_eq!(Path::new(&p), dir.join("clip_edit.mp4"));
        std::fs::write(&p, b"x").unwrap();
        let p2 = output_path(src_s.clone(), "mp4".into(), "clip_edit".into(), None).unwrap();
        assert_eq!(Path::new(&p2), dir.join("clip_edit (2).mp4"));

        // Asking for the source's own name must not return the source.
        let same = output_path(src_s.clone(), "mp4".into(), "clip".into(), None).unwrap();
        assert_eq!(Path::new(&same), dir.join("clip (2).mp4"));

        // Illegal Windows characters are replaced; empty falls back to <stem>_edit.
        let bad = output_path(src_s.clone(), "mp4".into(), "a:b/c?".into(), None).unwrap();
        assert_eq!(Path::new(&bad).file_name().unwrap(), "a_b_c_.mp4");
        let empty = output_path(src_s.clone(), "mp4".into(), "  ".into(), None).unwrap();
        assert_eq!(Path::new(&empty).file_name().unwrap(), "clip_edit (2).mp4");

        let tmp = temp_output_path(src_s, "mp4".into()).unwrap();
        assert_eq!(Path::new(&tmp), dir.join("clip.quickcut-tmp.mp4"));
        assert_eq!(std::fs::read(&src).unwrap(), b"original");
    }
}

