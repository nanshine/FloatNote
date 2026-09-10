use chrono::NaiveDateTime;
use serde::Serialize;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::UNIX_EPOCH;

#[derive(Serialize, Debug, PartialEq)]
pub struct NoteEntry {
    pub name: String,
    pub path: String,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct NoteContent {
    pub content: String,
    pub mtime: Option<u64>,
}

#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WriteOutcome {
    pub conflict: bool,
    pub mtime: Option<u64>,
}

pub fn timestamp_stem(now: NaiveDateTime) -> String {
    now.format("%Y-%m-%d %H-%M").to_string()
}

pub fn unique_filename(dir: &Path, stem: &str) -> String {
    let mut candidate = format!("{stem}.md");
    let mut n = 2;
    while dir.join(&candidate).exists() {
        candidate = format!("{stem} {n}.md");
        n += 1;
    }
    candidate
}

pub fn list_markdown(dir: &Path) -> std::io::Result<Vec<NoteEntry>> {
    let mut entries: Vec<(std::time::SystemTime, NoteEntry)> = Vec::new();
    for entry in std::fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) == Some("md") {
            let modified = entry.metadata()?.modified()?;
            let name = path.file_stem().unwrap().to_string_lossy().to_string();
            entries.push((
                modified,
                NoteEntry {
                    name,
                    path: path.to_string_lossy().to_string(),
                },
            ));
        }
    }
    Ok(sort_newest_first(entries))
}

/// Sort `(modified, entry)` pairs newest-first and drop the timestamps.
/// Shared by `list_markdown` / `list_projects` / `list_pieces`, which all want
/// their entries ordered by descending modification time.
pub(crate) fn sort_newest_first<T>(mut entries: Vec<(std::time::SystemTime, T)>) -> Vec<T> {
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.into_iter().map(|(_, entry)| entry).collect()
}

pub fn rename_note(dir: &Path, old_name: &str, new_stem: &str) -> std::io::Result<String> {
    let target = dir.join(format!("{new_stem}.md"));
    // 大小写不敏感的文件系统（Windows NTFS、默认 macOS）上，把 "floatnote.md" 改名为
    // "Floatnote.md" 时 target.exists() 会命中源文件本身，误报“已存在”。仅大小写
    // 不同的改名是合法操作（重命名同一文件），不应视为冲突。
    let case_only_rename = old_name.to_lowercase() == new_stem.to_lowercase();
    if target.exists() && !case_only_rename {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target exists",
        ));
    }
    std::fs::rename(dir.join(format!("{old_name}.md")), &target)?;
    Ok(target.to_string_lossy().to_string())
}

/// Move a note file (a piece or a standalone document) to the OS trash.
/// No-op if the file is already gone — keeps the UI forgiving when the file
/// vanished externally. Version-history cleanup is the caller's responsibility;
/// this function only touches the `.md` file itself.
pub fn delete_note(path: &Path) -> std::io::Result<()> {
    delete_note_with(path, &crate::trash::SystemTrash)
}

pub fn delete_note_with(path: &Path, trash: &impl crate::trash::Trash) -> std::io::Result<()> {
    if !path.exists() {
        return Ok(());
    }
    trash.move_to_trash(path)
}

/// 进程级临时文件序号，保证并发写不撞名。
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// 原子写入：先写同目录临时文件（`.tmp` 后缀，watcher 与 list 均忽略）→
/// `sync_all` fsync → 平台原子替换目标。任一步失败都清理临时文件并返回错误，
/// 原文件不被破坏（替换在同一文件系统中完成）。
pub fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "note.md".to_string());
    let n = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!("{file_name}.{n}.tmp"));

    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::File::create(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        Ok(())
    })();
    if let Err(error) = write_result {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }

    if let Err(error) = replace_file(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        return Err(error);
    }
    Ok(())
}

/// Atomically publish a brand-new file without ever replacing an existing one.
/// The completed bytes are fsynced in a same-directory temporary file, then a
/// hard link claims the final name with create-only semantics on macOS/Windows.
pub fn write_new_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    let dir = path.parent().unwrap_or_else(|| Path::new("."));
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "note.md".into());
    let sequence = TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp = dir.join(format!(
        ".{file_name}.{}.{sequence}.tmp",
        std::process::id()
    ));

    let write_result = (|| -> std::io::Result<()> {
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        std::fs::hard_link(&tmp, path)?;
        Ok(())
    })();
    let _ = std::fs::remove_file(&tmp);
    write_result
}

#[cfg(not(windows))]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    std::fs::rename(source, destination)
}

#[cfg(windows)]
fn replace_file(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// 取文件 `modified()` 的 UNIX_EPOCH 毫秒；文件不存在或不可读返回 None。
pub fn mtime_millis(path: &Path) -> Option<u64> {
    std::fs::metadata(path)
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as u64)
}

use base64::Engine as _;

/// Image extensions accepted by the import/drag-drop path.
pub const IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

/// Per the spec: images live in `<note-dir>/_assets/`. This is the canonical
/// subdirectory name and also the safety gate for the custom protocol.
pub const ASSETS_DIR: &str = "_assets";

/// Unique filename for an image: `<stem>.<ext>`, or `<stem>-<n>.<ext>` on conflict.
pub fn unique_image_filename(dir: &Path, stem: &str, ext: &str) -> String {
    let ext = ext.trim_start_matches('.');
    let mut candidate = format!("{stem}.{ext}");
    let mut n = 0;
    while dir.join(ASSETS_DIR).join(&candidate).exists() {
        n += 1;
        candidate = format!("{stem}-{n}.{ext}");
    }
    candidate
}

/// MIME for an image extension (lowercased, no dot). Falls back to octet-stream.
pub fn image_content_type(ext: &str) -> &'static str {
    match ext.trim_start_matches('.').to_ascii_lowercase().as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "bmp" => "image/bmp",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// Decode a base64 image payload and atomically write it into `<dir>/_assets/<filename>`.
/// Returns `(filename, "./_assets/<filename>")`. Creates `_assets/` if missing.
pub fn save_pasted_image(
    dir: &Path,
    suggested_stem: &str,
    data_base64: &str,
    mime: &str,
) -> std::io::Result<(String, String)> {
    let data = base64::engine::general_purpose::STANDARD
        .decode(data_base64)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e.to_string()))?;
    let ext = mime_to_ext(mime).unwrap_or("png");
    let assets = dir.join(ASSETS_DIR);
    std::fs::create_dir_all(&assets)?;
    let filename = unique_image_filename(dir, suggested_stem, ext);
    let path = assets.join(&filename);
    // write_atomic is text-oriented (str); images are bytes, so write directly
    // with fsync, then the file is brand-new (no rename needed).
    {
        use std::io::Write;
        let mut file = std::fs::File::create(&path)?;
        file.write_all(&data)?;
        file.sync_all()?;
    }
    let rel = format!("./{ASSETS_DIR}/{filename}");
    Ok((filename, rel))
}

fn mime_to_ext(mime: &str) -> Option<&'static str> {
    match mime {
        "image/png" => Some("png"),
        "image/jpeg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/svg+xml" => Some("svg"),
        "image/bmp" => Some("bmp"),
        "image/avif" => Some("avif"),
        _ => None,
    }
}

/// Per-source import result: `(source_path, rel_path, error_or_none)`.
pub type ImportResult = (String, String, Option<String>);

/// Copy each source image file into `<dir>/_assets/` (deduped). Non-image
/// extensions and copy failures are recorded per-item, not fatal.
pub fn import_image_files(source_paths: &[String], dir: &Path) -> Vec<ImportResult> {
    let assets = dir.join(ASSETS_DIR);
    let _ = std::fs::create_dir_all(&assets);
    source_paths
        .iter()
        .map(|src| {
            let p = std::path::Path::new(src);
            let ext = p
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_ascii_lowercase())
                .unwrap_or_default();
            if !IMAGE_EXTS.contains(&ext.as_str()) {
                return (src.clone(), String::new(), Some("not an image".into()));
            }
            let stem = p
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "image".into());
            let slug = slugify(&stem);
            let filename = unique_image_filename(dir, &slug, &ext);
            let dest = assets.join(&filename);
            match std::fs::copy(p, &dest) {
                Ok(_) => (src.clone(), format!("./{ASSETS_DIR}/{filename}"), None),
                Err(e) => (src.clone(), String::new(), Some(e.to_string())),
            }
        })
        .collect()
}

/// Replace path separators and spaces with `-`; preserve Unicode letters.
fn slugify(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_whitespace() || c == '/' || c == '\\' || c == ':' {
                '-'
            } else {
                c
            }
        })
        .collect::<String>()
        .trim_matches('-')
        .to_string()
}

/// Safety gate for the `floatnote-img://` protocol: the canonicalized path's
/// immediate parent must be `_assets` and its extension must be an image type.
/// Rejects `../` traversal and arbitrary-file reads.
pub fn is_safe_image_path(path: &Path) -> bool {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !IMAGE_EXTS.contains(&ext.as_str()) {
        return false;
    }
    let Ok(canonical) = path.canonicalize() else {
        return false;
    };
    match canonical
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|n| n.to_str())
    {
        Some(name) => name == ASSETS_DIR,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::NaiveDate;

    #[test]
    fn stem_format() {
        let dt = NaiveDate::from_ymd_opt(2026, 6, 8)
            .unwrap()
            .and_hms_opt(14, 30, 0)
            .unwrap();
        assert_eq!(timestamp_stem(dt), "2026-06-08 14-30");
    }

    #[test]
    fn unique_when_no_conflict() {
        let dir = tempdir();
        assert_eq!(unique_filename(dir.path(), "note"), "note.md");
    }

    #[test]
    fn unique_appends_suffix_on_conflict() {
        let dir = tempdir();
        std::fs::write(dir.path().join("note.md"), "x").unwrap();
        assert_eq!(unique_filename(dir.path(), "note"), "note 2.md");
        std::fs::write(dir.path().join("note 2.md"), "x").unwrap();
        assert_eq!(unique_filename(dir.path(), "note"), "note 3.md");
    }

    #[test]
    fn lists_only_markdown_sorted_newest_first() {
        let dir = tempdir();
        std::fs::write(dir.path().join("a.md"), "1").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(dir.path().join("b.md"), "2").unwrap();
        std::fs::write(dir.path().join("ignore.txt"), "x").unwrap();
        let names: Vec<String> = list_markdown(dir.path())
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["b".to_string(), "a".to_string()]);
    }

    #[test]
    fn rename_succeeds_and_errors_on_conflict() {
        let dir = tempdir();
        std::fs::write(dir.path().join("old.md"), "x").unwrap();
        rename_note(dir.path(), "old", "new").unwrap();
        assert!(dir.path().join("new.md").exists());
        std::fs::write(dir.path().join("a.md"), "x").unwrap();
        assert!(rename_note(dir.path(), "a", "new").is_err());
    }

    #[test]
    fn rename_allows_case_only_change() {
        // 大小写不敏感 FS（Windows NTFS / 默认 macOS）上，"Floatnote.md".exists()
        // 会命中源文件 "floatnote.md" 本身；仅大小写不同的改名必须放行，而非误报
        // "target exists"。（在大小写敏感 FS 上，目标本就不存在，同样应成功。）
        let dir = tempdir();
        std::fs::write(dir.path().join("floatnote.md"), "body").unwrap();
        let new_path = rename_note(dir.path(), "floatnote", "Floatnote").unwrap();
        assert!(new_path.ends_with("Floatnote.md"));
        assert!(dir.path().join("Floatnote.md").exists());
        assert_eq!(
            std::fs::read_to_string(dir.path().join("Floatnote.md")).unwrap(),
            "body"
        );
    }

    #[test]
    fn delete_removes_file_and_is_noop_when_missing() {
        struct RemoveFile;
        impl crate::trash::Trash for RemoveFile {
            fn move_to_trash(&self, path: &Path) -> std::io::Result<()> {
                std::fs::remove_file(path)
            }
        }
        let dir = tempdir();
        let path = dir.path().join("doomed.md");
        std::fs::write(&path, "x").unwrap();
        delete_note_with(&path, &RemoveFile).unwrap();
        assert!(!path.exists());
        // Already gone — no error.
        delete_note_with(&path, &RemoveFile).unwrap();
    }

    #[test]
    fn write_atomic_replaces_content_and_leaves_no_tmp() {
        let dir = tempdir();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "old").unwrap();
        write_atomic(&path, "new").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
        let leftovers: Vec<String> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().to_string())
            .filter(|n| n.ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "tmp leftovers: {leftovers:?}");
    }

    #[test]
    fn write_atomic_creates_new_file() {
        let dir = tempdir();
        let path = dir.path().join("fresh.md");
        write_atomic(&path, "first").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
    }

    #[test]
    fn write_atomic_errors_when_parent_missing() {
        let path = std::path::Path::new("/nonexistent-dir-xyz-aaa/note.md");
        assert!(write_atomic(path, "x").is_err());
    }

    #[test]
    fn write_new_atomic_never_replaces_an_existing_file_and_cleans_up() {
        let dir = tempdir();
        let path = dir.path().join("fresh.md");
        write_new_atomic(&path, "first").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        assert!(write_new_atomic(&path, "second").is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        let leftovers = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().into_owned())
            .filter(|name| name.ends_with(".tmp"))
            .collect::<Vec<_>>();
        assert!(leftovers.is_empty(), "tmp leftovers: {leftovers:?}");
    }

    #[test]
    fn mtime_millis_none_for_missing_file() {
        assert_eq!(mtime_millis(std::path::Path::new("/no/such/file.md")), None);
    }

    #[test]
    fn mtime_millis_returns_some_for_existing_file() {
        let dir = tempdir();
        let path = dir.path().join("note.md");
        std::fs::write(&path, "x").unwrap();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        let m = mtime_millis(&path).expect("existing file has mtime");
        // 文件刚创建，mtime 应在 now 附近（容忍文件系统时间戳精度与调度延迟）。
        assert!(m <= now + 60_000, "mtime {m} far in the future");
        assert!(m > now - 60_000, "mtime {m} far in the past");
    }

    #[test]
    fn unique_image_filename_no_conflict() {
        let dir = tempdir();
        assert_eq!(unique_image_filename(dir.path(), "arch", "png"), "arch.png");
    }

    #[test]
    fn unique_image_filename_appends_on_conflict() {
        let dir = tempdir();
        let assets = dir.path().join("_assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(assets.join("arch.png"), b"x").unwrap();
        assert_eq!(
            unique_image_filename(dir.path(), "arch", "png"),
            "arch-1.png"
        );
        std::fs::write(assets.join("arch-1.png"), b"x").unwrap();
        assert_eq!(
            unique_image_filename(dir.path(), "arch", "png"),
            "arch-2.png"
        );
    }

    #[test]
    fn save_pasted_image_decodes_and_writes_to_assets() {
        let dir = tempdir();
        // 1x1 transparent PNG
        let png = base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=")
            .unwrap();
        let (filename, rel) = save_pasted_image(
            dir.path(),
            "paste-1",
            &base64::engine::general_purpose::STANDARD.encode(&png),
            "image/png",
        )
        .unwrap();
        assert_eq!(filename, "paste-1.png");
        assert_eq!(rel, "./_assets/paste-1.png");
        let written = std::fs::read(dir.path().join("_assets").join("paste-1.png")).unwrap();
        assert_eq!(written, png);
    }

    #[test]
    fn import_image_files_copies_and_dedups() {
        let dir = tempdir();
        let src = dir.path().join("_src.png");
        std::fs::write(&src, b"img").unwrap();
        let target = dir.path().to_path_buf(); // _assets created inside
        let results = import_image_files(&[src.to_string_lossy().to_string()], &target);
        assert_eq!(results.len(), 1);
        let (_, rel, err) = &results[0];
        assert!(err.is_none(), "unexpected error: {err:?}");
        assert_eq!(rel, "./_assets/_src.png");
        assert_eq!(
            std::fs::read(dir.path().join("_assets").join("_src.png")).unwrap(),
            b"img"
        );
        // Second import of same path dedups to -1.
        let results2 = import_image_files(&[src.to_string_lossy().to_string()], &target);
        let (_, rel2, _) = &results2[0];
        assert_eq!(rel2, "./_assets/_src-1.png");
    }

    #[test]
    fn import_image_files_rejects_non_image_ext() {
        let dir = tempdir();
        let src = dir.path().join("notes.txt");
        std::fs::write(&src, b"nope").unwrap();
        let results = import_image_files(&[src.to_string_lossy().to_string()], dir.path());
        let (_, _, err) = &results[0];
        assert!(err.is_some());
    }

    #[test]
    fn is_safe_image_path_accepts_assets_inside() {
        let dir = tempdir();
        let p = dir.path().join("_assets").join("x.png");
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(&p, b"x").unwrap();
        assert!(is_safe_image_path(&p));
    }

    #[test]
    fn is_safe_image_path_rejects_outside_assets() {
        let dir = tempdir();
        let p = dir.path().join("secret.png");
        std::fs::write(&p, b"x").unwrap();
        assert!(!is_safe_image_path(&p));
    }

    #[test]
    fn is_safe_image_path_rejects_traversal() {
        // /tmp/floatnote-.../_assets/../secret.png canonicalizes outside _assets
        let dir = tempdir();
        let assets = dir.path().join("_assets");
        std::fs::create_dir_all(&assets).unwrap();
        std::fs::write(dir.path().join("secret.png"), b"x").unwrap();
        let p = assets.join("..").join("secret.png");
        assert!(!is_safe_image_path(&p));
    }

    use crate::testutil::tempdir;
}
