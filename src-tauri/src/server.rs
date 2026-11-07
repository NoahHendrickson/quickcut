//! Tiny localhost HTTP server that streams local media files to the webview.
//!
//! Tauri's built-in asset protocol buffers responses and has known problems
//! seeking in multi-GB videos. A plain HTTP server with proper `Range` support
//! lets WebView2 stream and seek huge recordings directly from disk.
//! Bound to 127.0.0.1 only, and every URL carries a random per-launch token.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fs::File;
use std::hash::{BuildHasher, Hasher};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

pub struct MediaServer {
    port: u16,
    token: String,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
    next_id: Mutex<u64>,
}

fn random_hex() -> String {
    let mut out = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0),
        );
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

impl MediaServer {
    pub fn start() -> io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let token = random_hex();
        let files: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::default();

        let files_bg = files.clone();
        let token_bg = token.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let files = files_bg.clone();
                let token = token_bg.clone();
                thread::spawn(move || {
                    let _ = handle_connection(stream, &files, &token);
                });
            }
        });

        Ok(Self { port, token, files, next_id: Mutex::new(0) })
    }

    /// Register a file and return a URL the webview can stream it from.
    pub fn url_for(&self, path: &Path) -> String {
        let mut files = self.files.lock().unwrap();
        // Reuse the id if this file is already registered.
        if let Some((id, _)) = files.iter().find(|(_, p)| p.as_path() == path) {
            return format!("http://127.0.0.1:{}/{}/{}", self.port, self.token, id);
        }
        let mut next = self.next_id.lock().unwrap();
        *next += 1;
        let id = next.to_string();
        files.insert(id.clone(), path.to_path_buf());
        format!("http://127.0.0.1:{}/{}/{}", self.port, self.token, id)
    }
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        // Chromium sniffs ISO-BMFF regardless; video/mp4 plays .mov files reliably.
        "mp4" | "m4v" | "mov" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        "ts" | "m2ts" | "mts" => "video/mp2t",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "opus" => "audio/ogg",
        "m4a" | "aac" => "audio/mp4",
        "flac" => "audio/flac",
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

/// Parse `bytes=start-end` / `bytes=start-` / `bytes=-suffix` into an inclusive range.
fn parse_range(header: &str, len: u64) -> Option<(u64, u64)> {
    let spec = header.trim().strip_prefix("bytes=")?;
    let spec = spec.split(',').next()?.trim();
    let (a, b) = spec.split_once('-')?;
    if len == 0 {
        return None;
    }
    if a.is_empty() {
        let suffix: u64 = b.parse().ok()?;
        let start = len.saturating_sub(suffix);
        return Some((start, len - 1));
    }
    let start: u64 = a.parse().ok()?;
    if start >= len {
        return None;
    }
    let end = if b.is_empty() { len - 1 } else { b.parse::<u64>().ok()?.min(len - 1) };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn write_simple(stream: &mut TcpStream, status: &str) -> io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: keep-alive\r\n\r\n"
    )
}

fn handle_connection(
    stream: TcpStream,
    files: &Mutex<HashMap<String, PathBuf>>,
    token: &str,
) -> io::Result<()> {
    stream.set_nodelay(true)?;
    let mut out = stream.try_clone()?;
    let mut reader = BufReader::new(stream);
    let mut buf = vec![0u8; 1 << 20];

    loop {
        // Request line
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Ok(());
        }
        let mut parts = line.split_whitespace();
        let method = parts.next().unwrap_or("").to_string();
        let target = parts.next().unwrap_or("").to_string();

        // Headers
        let mut range: Option<String> = None;
        loop {
            let mut h = String::new();
            if reader.read_line(&mut h)? == 0 {
                return Ok(());
            }
            let h = h.trim_end();
            if h.is_empty() {
                break;
            }
            if let Some((k, v)) = h.split_once(':') {
                if k.trim().eq_ignore_ascii_case("range") {
                    range = Some(v.trim().to_string());
                }
            }
        }

        if method == "OPTIONS" {
            write!(
                out,
                "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: *\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n"
            )?;
            continue;
        }
        if method != "GET" && method != "HEAD" {
            write_simple(&mut out, "405 Method Not Allowed")?;
            continue;
        }

        // /<token>/<id>
        let path_only = target.split('?').next().unwrap_or("");
        let mut segs = path_only.trim_start_matches('/').split('/');
        let (tok, id) = (segs.next().unwrap_or(""), segs.next().unwrap_or(""));
        let file_path = if tok == token { files.lock().unwrap().get(id).cloned() } else { None };
        let Some(file_path) = file_path else {
            write_simple(&mut out, "404 Not Found")?;
            continue;
        };
        let Ok(mut file) = File::open(&file_path) else {
            write_simple(&mut out, "404 Not Found")?;
            continue;
        };
        let len = file.metadata()?.len();
        let ctype = content_type(&file_path);

        let (status, start, end) = match range.as_deref() {
            Some(r) => match parse_range(r, len) {
                Some((s, e)) => ("206 Partial Content", s, e),
                None => {
                    write!(
                        out,
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{len}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: keep-alive\r\n\r\n"
                    )?;
                    continue;
                }
            },
            None => ("200 OK", 0, len.saturating_sub(1)),
        };
        let body_len = if len == 0 { 0 } else { end - start + 1 };

        let mut head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {ctype}\r\nContent-Length: {body_len}\r\nAccept-Ranges: bytes\r\nAccess-Control-Allow-Origin: *\r\nCache-Control: no-cache\r\nConnection: keep-alive\r\n"
        );
        if status.starts_with("206") {
            head.push_str(&format!("Content-Range: bytes {start}-{end}/{len}\r\n"));
        }
        head.push_str("\r\n");
        out.write_all(head.as_bytes())?;
        if method == "HEAD" || body_len == 0 {
            continue;
        }

        // Stream the body in 1 MiB chunks. The webview often aborts open-ended
        // range requests once it has buffered enough; that surfaces here as a
        // write error and simply ends this connection.
        file.seek(SeekFrom::Start(start))?;
        let mut remaining = body_len;
        while remaining > 0 {
            let want = remaining.min(buf.len() as u64) as usize;
            let n = file.read(&mut buf[..want])?;
            if n == 0 {
                return Ok(());
            }
            out.write_all(&buf[..n])?;
            remaining -= n as u64;
        }
        out.flush()?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read_response(r: &mut BufReader<TcpStream>) -> (String, Vec<u8>) {
        let mut head = String::new();
        let mut len = 0usize;
        loop {
            let mut l = String::new();
            r.read_line(&mut l).unwrap();
            if l.trim().is_empty() {
                break;
            }
            if let Some(v) = l.to_ascii_lowercase().strip_prefix("content-length:") {
                len = v.trim().parse().unwrap();
            }
            head.push_str(&l);
        }
        let mut body = vec![0u8; len];
        r.read_exact(&mut body).unwrap();
        (head, body)
    }

    #[test]
    fn serves_ranges_with_keepalive() {
        let dir = std::env::temp_dir().join("qc-server-test");
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp4");
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(&file, &data).unwrap();

        let server = MediaServer::start().unwrap();
        let url = server.url_for(&file);
        assert_eq!(url, server.url_for(&file), "same file -> same url");
        let path = url.splitn(4, '/').nth(3).unwrap();
        let addr = url.trim_start_matches("http://").split('/').next().unwrap().to_string();

        let stream = TcpStream::connect(&addr).unwrap();
        let mut w = stream.try_clone().unwrap();
        let mut r = BufReader::new(stream);

        write!(w, "GET /{path} HTTP/1.1\r\nRange: bytes=1000000-1000099\r\n\r\n").unwrap();
        let (head, body) = read_response(&mut r);
        assert!(head.starts_with("HTTP/1.1 206"), "{head}");
        assert!(head.contains("Content-Range: bytes 1000000-1000099/3000000"), "{head}");
        assert!(head.contains("Content-Type: video/mp4"));
        assert_eq!(body, &data[1_000_000..1_000_100]);

        // Second request on the same connection (keep-alive), open-ended range.
        write!(w, "GET /{path} HTTP/1.1\r\nRange: bytes=2999990-\r\n\r\n").unwrap();
        let (head, body) = read_response(&mut r);
        assert!(head.starts_with("HTTP/1.1 206"));
        assert_eq!(body, &data[2_999_990..]);

        // Full request without range.
        write!(w, "GET /{path} HTTP/1.1\r\n\r\n").unwrap();
        let (head, body) = read_response(&mut r);
        assert!(head.starts_with("HTTP/1.1 200"));
        assert_eq!(body.len(), data.len());

        // Wrong token -> 404.
        write!(w, "GET /nottoken/1 HTTP/1.1\r\n\r\n").unwrap();
        let (head, _) = read_response(&mut r);
        assert!(head.starts_with("HTTP/1.1 404"));
    }

    #[test]
    fn ranges() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-19", 100), Some((10, 19)));
        assert_eq!(parse_range("bytes=90-200", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=5-2", 100), None);
    }
}
