use serde::Serialize;
use std::path::{Path, PathBuf};

use crate::notes::NoteEntry;

pub const INBOX_FILE: &str = "_inbox.md";
pub const TASKS_FILE: &str = "_tasks.md";

#[derive(Serialize, Debug, PartialEq)]
pub struct ProjectEntry {
    /// Folder name (display label).
    pub name: String,
    /// Absolute folder path.
    pub path: String,
}

/// A directory counts as a project space when it holds an `_inbox.md`.
pub fn is_project_dir(dir: &Path) -> bool {
    dir.join(INBOX_FILE).is_file()
}

/// List the project-space subfolders of `root` (those containing `_inbox.md`),
/// newest-modified first. Loose files and non-project folders are skipped.
pub fn list_projects(root: &Path) -> std::io::Result<Vec<ProjectEntry>> {
    let mut entries: Vec<(std::time::SystemTime, ProjectEntry)> = Vec::new();
    for entry in std::fs::read_dir(root)? {
        let entry = entry?;
        let path = entry.path();
        if !path.is_dir() || !is_project_dir(&path) {
            continue;
        }
        let modified = entry.metadata()?.modified()?;
        let name = path.file_name().unwrap().to_string_lossy().to_string();
        entries.push((
            modified,
            ProjectEntry {
                name,
                path: path.to_string_lossy().to_string(),
            },
        ));
    }
    Ok(crate::notes::sort_newest_first(entries))
}

/// Given an ordered list of candidate project paths (MRU), keep only those that
/// still exist as project folders, preserving order. Used to back the switcher
/// menu from `config.recent_projects` while silently dropping deleted projects.
pub fn resolve_projects(paths: &[String]) -> Vec<ProjectEntry> {
    paths
        .iter()
        .filter_map(|raw| {
            let path = Path::new(raw);
            if !is_project_dir(path) {
                return None;
            }
            let name = path.file_name()?.to_string_lossy().to_string();
            Some(ProjectEntry {
                name,
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect()
}

/// Given an ordered list of standalone-document paths (MRU), keep only those that
/// still exist as `.md` files, preserving order. Mirrors `resolve_projects` but
/// for loose documents that live outside any project space.
pub fn resolve_documents(paths: &[String]) -> Vec<NoteEntry> {
    paths
        .iter()
        .filter_map(|raw| {
            let path = Path::new(raw);
            if !path.is_file() || path.extension().and_then(|e| e.to_str()) != Some("md") {
                return None;
            }
            let name = path.file_stem()?.to_string_lossy().to_string();
            Some(NoteEntry {
                name,
                path: path.to_string_lossy().to_string(),
            })
        })
        .collect()
}

/// List the 成品 notes inside a project folder: `.md` files whose name does not
/// start with `_`, newest-modified first. Returns `NoteEntry` so it slots into
/// the existing note-switching UI.
pub fn list_pieces(project: &Path) -> std::io::Result<Vec<NoteEntry>> {
    let mut entries: Vec<(std::time::SystemTime, NoteEntry)> = Vec::new();
    for entry in std::fs::read_dir(project)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            continue;
        }
        let file_name = path.file_name().unwrap().to_string_lossy().to_string();
        if file_name.starts_with('_') {
            continue;
        }
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
    Ok(crate::notes::sort_newest_first(entries))
}

/// Pick a folder name under `root` that does not collide, appending " 2", " 3", …
fn unique_dir(root: &Path, base: &str) -> PathBuf {
    let mut candidate = root.join(base);
    let mut n = 2;
    while candidate.exists() {
        candidate = root.join(format!("{base} {n}"));
        n += 1;
    }
    candidate
}

/// Create a new project-space folder under `root`, scaffolding only `_inbox.md`
/// (empty). `_tasks.md` is created lazily on first task entry, and the first
/// piece is created on demand from the NO_PIECE empty state — so a brand-new
/// project lands in the empty-state flow rather than with a placeholder piece.
/// Returns the created folder.
pub fn create_project(root: &Path, name: &str) -> std::io::Result<ProjectEntry> {
    let base = sanitize_folder_name(name);
    let dir = unique_dir(root, &base);
    std::fs::create_dir_all(&dir)?;
    crate::notes::write_atomic(&dir.join(INBOX_FILE), "")?;
    Ok(ProjectEntry {
        name: dir.file_name().unwrap().to_string_lossy().to_string(),
        path: dir.to_string_lossy().to_string(),
    })
}

/// Create tutorial contents only inside a newly allocated project folder.
pub fn create_starter_project(root: &Path, name: &str) -> std::io::Result<ProjectEntry> {
    let entry = create_project(root, name)?;
    let dir = Path::new(&entry.path);
    let result = (|| {
        crate::notes::write_atomic(
            &dir.join(INBOX_FILE),
            include_str!("../resources/onboarding/inbox.md"),
        )?;
        crate::notes::write_atomic(
            &dir.join(TASKS_FILE),
            include_str!("../resources/onboarding/tasks.md"),
        )?;
        crate::notes::write_atomic(
            &dir.join("FloatNote 入门.md"),
            include_str!("../resources/onboarding/guide.md"),
        )?;
        Ok(())
    })();
    if let Err(error) = result {
        // This directory was just created by us; never clean up an existing project.
        let _ = std::fs::remove_dir_all(dir);
        return Err(error);
    }
    Ok(entry)
}

/// Turn a user-supplied project name into a safe, cross-platform folder name.
/// Path separators and characters illegal on Windows become `-`; surrounding
/// whitespace and dots are trimmed; an empty result falls back to "未命名".
pub fn sanitize_folder_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() {
        "未命名".to_string()
    } else {
        trimmed.to_string()
    }
}

/// Open an existing folder as a project space. If it lacks `_inbox.md`, scaffold
/// an empty one (written atomically so a crash can't leave a half-written
/// inbox); if it already has one, return as-is. Unlike `create_project`, the
/// folder itself is user-supplied — this never creates the directory, only the
/// inbox file inside it, and surfaces `NotADirectory` when the path isn't a
/// folder. `_tasks.md` and the first piece stay lazily-created, matching
/// `create_project`.
pub fn open_existing_project(dir: &Path) -> std::io::Result<ProjectEntry> {
    if !dir.is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotADirectory,
            "所选路径不是文件夹",
        ));
    }
    let inbox = dir.join(INBOX_FILE);
    if !inbox.is_file() {
        crate::notes::write_atomic(&inbox, "")?;
    }
    let name = dir
        .file_name()
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "无法解析文件夹名"))?
        .to_string_lossy()
        .to_string();
    Ok(ProjectEntry {
        name,
        path: dir.to_string_lossy().to_string(),
    })
}

/// Rename a project folder in place (same parent directory). The new name is
/// sanitized; a name equal to the current one is a no-op; a name colliding with
/// an existing sibling errors with `AlreadyExists`. Returns the new path.
/// Version history lives inside the project folder and moves with it, so no
/// separate version handling is needed.
pub fn rename_project(dir: &Path, new_name: &str) -> std::io::Result<String> {
    let parent = dir.parent().ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "project has no parent dir",
        )
    })?;
    let new_folder = sanitize_folder_name(new_name);
    let target = parent.join(&new_folder);
    // 大小写不敏感的文件系统（Windows NTFS、默认 macOS）上，把 "floatnote" 改名为
    // "Floatnote" 时 target.exists() 会命中源目录本身。现有的 `target != dir` 是逐字节
    // （区分大小写）比较，识别不了这种仅大小写不同的改名，故再补一个大小写无关的源名比较。
    let current_folder = dir.file_name().and_then(|name| name.to_str()).unwrap_or("");
    let case_only_rename =
        !current_folder.is_empty() && current_folder.to_lowercase() == new_folder.to_lowercase();
    if target.exists() && target != dir && !case_only_rename {
        return Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "target exists",
        ));
    }
    std::fs::rename(dir, &target)?;
    Ok(target.to_string_lossy().to_string())
}

/// Move a project folder to the OS trash. No-op if the folder is already gone.
/// The frontend confirms before calling. Version history lives inside the
/// folder and is trashed with it.
pub fn delete_project(dir: &Path) -> std::io::Result<()> {
    delete_project_with(dir, &crate::trash::SystemTrash)
}

pub fn delete_project_with(dir: &Path, trash: &impl crate::trash::Trash) -> std::io::Result<()> {
    if !dir.exists() {
        return Ok(());
    }
    trash.move_to_trash(dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starter_project_has_one_guide_and_does_not_overwrite_existing_content() {
        let root = crate::testutil::tempdir();
        let existing = create_project(root.path(), "入门").unwrap();
        let original = Path::new(&existing.path).join(INBOX_FILE);
        std::fs::write(&original, "我的内容").unwrap();
        let starter = create_starter_project(root.path(), "入门").unwrap();
        let dir = Path::new(&starter.path);
        assert_ne!(starter.path, existing.path);
        assert_eq!(std::fs::read_to_string(original).unwrap(), "我的内容");
        assert_eq!(list_pieces(dir).unwrap().len(), 1);
        assert!(std::fs::read_to_string(dir.join(INBOX_FILE))
            .unwrap()
            .contains("https://floatnote.ink/"));
        let tasks = std::fs::read_to_string(dir.join(TASKS_FILE)).unwrap();
        assert_eq!(
            tasks
                .lines()
                .filter(|line| line.starts_with("- [ ]"))
                .count(),
            3
        );
        assert!(tasks.contains("迭代写作的第二个版本"));
        let guide = std::fs::read_to_string(dir.join("FloatNote 入门.md")).unwrap();
        assert!(guide.contains("_tasks.md"));
        assert!(guide.contains("记录当前版本"));
    }

    #[test]
    fn lists_pieces_excluding_underscore_files_newest_first() {
        let project = tempdir();
        std::fs::write(project.path().join(INBOX_FILE), "").unwrap();
        std::fs::write(project.path().join("_tasks.md"), "").unwrap();
        std::fs::write(project.path().join("piece.md"), "").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        std::fs::write(project.path().join("draft.md"), "").unwrap();
        std::fs::write(project.path().join("ignore.txt"), "x").unwrap();

        let names: Vec<String> = list_pieces(project.path())
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["draft".to_string(), "piece".to_string()]);
    }

    #[test]
    fn creates_project_with_scaffold_and_unique_name() {
        let root = tempdir();
        let entry = create_project(root.path(), "阅读笔记").unwrap();
        assert_eq!(entry.name, "阅读笔记");
        let dir = root.path().join("阅读笔记");
        assert!(is_project_dir(&dir));
        // Only _inbox.md is scaffolded; _tasks.md and the first piece are
        // created lazily so a new project lands in the NO_PIECE empty state.
        assert!(!dir.join("_tasks.md").is_file());
        assert!(!dir.join("piece.md").is_file());

        // A second project with the same name gets a numeric suffix.
        let entry2 = create_project(root.path(), "阅读笔记").unwrap();
        assert_eq!(entry2.name, "阅读笔记 2");
        assert!(root.path().join("阅读笔记 2").join(INBOX_FILE).is_file());
    }

    #[test]
    fn sanitizes_folder_names() {
        assert_eq!(sanitize_folder_name("阅读笔记"), "阅读笔记");
        assert_eq!(sanitize_folder_name("a/b\\c"), "a-b-c");
        assert_eq!(sanitize_folder_name("a:b*c?"), "a-b-c-");
        assert_eq!(sanitize_folder_name("  trimmed  "), "trimmed");
        assert_eq!(sanitize_folder_name("..."), "未命名");
        assert_eq!(sanitize_folder_name("   "), "未命名");
    }

    #[test]
    fn lists_only_project_folders_newest_first() {
        let root = tempdir();
        // A project folder.
        let a = root.path().join("alpha");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join(INBOX_FILE), "").unwrap();
        std::thread::sleep(std::time::Duration::from_millis(10));
        // A newer project folder.
        let b = root.path().join("beta");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join(INBOX_FILE), "").unwrap();
        // A plain folder without _inbox.md (ignored).
        std::fs::create_dir_all(root.path().join("plain")).unwrap();
        // A loose markdown file at the root (ignored — not a directory).
        std::fs::write(root.path().join("legacy.md"), "x").unwrap();

        let names: Vec<String> = list_projects(root.path())
            .unwrap()
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["beta".to_string(), "alpha".to_string()]);
    }

    #[test]
    fn resolve_projects_keeps_existing_in_order_drops_missing() {
        let root = tempdir();
        let a = root.path().join("alpha");
        std::fs::create_dir_all(&a).unwrap();
        std::fs::write(a.join(INBOX_FILE), "").unwrap();
        let b = root.path().join("beta");
        std::fs::create_dir_all(&b).unwrap();
        std::fs::write(b.join(INBOX_FILE), "").unwrap();
        // A plain folder without _inbox.md is not a project.
        let plain = root.path().join("plain");
        std::fs::create_dir_all(&plain).unwrap();

        let paths = vec![
            b.to_string_lossy().to_string(),
            root.path().join("gone").to_string_lossy().to_string(),
            plain.to_string_lossy().to_string(),
            a.to_string_lossy().to_string(),
        ];
        let names: Vec<String> = resolve_projects(&paths)
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["beta".to_string(), "alpha".to_string()]);
    }

    #[test]
    fn detects_project_by_inbox_file() {
        let dir = tempdir();
        assert!(!is_project_dir(dir.path()));
        std::fs::write(dir.path().join(INBOX_FILE), "").unwrap();
        assert!(is_project_dir(dir.path()));
    }

    #[test]
    fn resolve_documents_keeps_existing_md_drops_missing() {
        let root = tempdir();
        let a = root.path().join("a.md");
        std::fs::write(&a, "x").unwrap();
        let b = root.path().join("b.md");
        std::fs::write(&b, "x").unwrap();
        // Non-.md files and directories are dropped.
        std::fs::write(root.path().join("ignore.txt"), "x").unwrap();
        std::fs::create_dir_all(root.path().join("subdir")).unwrap();

        let paths = vec![
            b.to_string_lossy().to_string(),
            root.path().join("gone.md").to_string_lossy().to_string(),
            root.path().join("ignore.txt").to_string_lossy().to_string(),
            a.to_string_lossy().to_string(),
        ];
        let names: Vec<String> = resolve_documents(&paths)
            .into_iter()
            .map(|entry| entry.name)
            .collect();
        assert_eq!(names, vec!["b".to_string(), "a".to_string()]);
    }

    #[test]
    fn rename_project_moves_folder_and_errors_on_conflict() {
        let root = tempdir();
        let dir = root.path().join("old");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(INBOX_FILE), "").unwrap();

        let new_path = rename_project(&dir, "新名").unwrap();
        assert!(new_path.ends_with("新名"));
        assert!(!dir.exists());
        assert!(is_project_dir(Path::new(&new_path)));

        // Rename to a colliding sibling name errors.
        let other = root.path().join("other");
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(other.join(INBOX_FILE), "").unwrap();
        assert!(rename_project(Path::new(&new_path), "other").is_err());
    }

    #[test]
    fn rename_project_allows_case_only_change() {
        // 大小写不敏感 FS（Windows NTFS / 默认 macOS）上，把 "floatnote" 改为
        // "Floatnote" 时 target.exists() 会命中源目录本身，`target != dir`（区分大小写）
        // 也拦不住；必须放行这种仅大小写不同的改名。
        let root = tempdir();
        let dir = root.path().join("floatnote");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(INBOX_FILE), "").unwrap();

        let new_path = rename_project(&dir, "Floatnote").unwrap();
        assert!(new_path.ends_with("Floatnote"));
        assert!(is_project_dir(Path::new(&new_path)));
    }

    #[test]
    fn delete_project_removes_folder_and_is_noop_when_missing() {
        struct RemoveDirectory;
        impl crate::trash::Trash for RemoveDirectory {
            fn move_to_trash(&self, path: &Path) -> std::io::Result<()> {
                std::fs::remove_dir_all(path)
            }
        }
        let root = tempdir();
        let dir = root.path().join("doomed");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(INBOX_FILE), "").unwrap();
        delete_project_with(&dir, &RemoveDirectory).unwrap();
        assert!(!dir.exists());
        // Already gone — no error.
        delete_project_with(&dir, &RemoveDirectory).unwrap();
    }

    #[test]
    fn open_existing_project_scaffolds_inbox_for_plain_folder() {
        let root = tempdir();
        let dir = root.path().join("notes");
        std::fs::create_dir_all(&dir).unwrap();
        // Existing .md files become pieces; _inbox.md is created if missing.
        std::fs::write(dir.join("piece.md"), "x").unwrap();

        assert!(!is_project_dir(&dir));
        let entry = open_existing_project(&dir).unwrap();
        assert_eq!(entry.name, "notes");
        assert!(is_project_dir(&dir));
        // Existing files are left untouched.
        assert!(dir.join("piece.md").is_file());
        // _tasks.md stays lazily-absent.
        assert!(!dir.join("_tasks.md").is_file());
    }

    #[test]
    fn open_existing_project_is_idempotent_when_inbox_exists() {
        let root = tempdir();
        let dir = root.path().join("has-inbox");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(INBOX_FILE), "keep me").unwrap();

        open_existing_project(&dir).unwrap();
        // Second open does not clobber the existing inbox.
        assert_eq!(
            std::fs::read_to_string(dir.join(INBOX_FILE)).unwrap(),
            "keep me"
        );
    }

    #[test]
    fn open_existing_project_errors_on_non_directory() {
        let root = tempdir();
        let file = root.path().join("not-a-folder.md");
        std::fs::write(&file, "x").unwrap();
        let err = open_existing_project(&file).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotADirectory);

        let missing = root.path().join("gone");
        let err = open_existing_project(&missing).unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::NotADirectory);
    }

    use crate::testutil::tempdir;
}
