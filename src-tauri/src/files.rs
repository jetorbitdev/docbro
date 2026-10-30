use std::{
    fs::{self, File, OpenOptions},
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

use percent_encoding::percent_decode_str;

use crate::CmdResult;

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// A new, empty file next to `path` that no other write owns. The name differs per call, so
/// two saves of one path at once never share a temp file.
/// With `private`, only the user can read it (unix), from its first byte on.
fn create_temp(path: &Path, name: &str, private: bool) -> io::Result<(File, PathBuf)> {
    let mut options = OpenOptions::new();
    // `create_new` never reuses a file that is already there, e.g. left by a crashed run
    options.write(true).create_new(true);
    #[cfg(unix)]
    if private {
        std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    }
    #[cfg(not(unix))]
    let _ = private;
    loop {
        let n = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
        let temp = path.with_file_name(format!(".{name}.{}-{n}.docbro-tmp", std::process::id()));
        match options.open(&temp) {
            Err(e) if e.kind() == ErrorKind::AlreadyExists => continue,
            opened => return opened.map(|file| (file, temp)),
        }
    }
}

/// Writes `data` to `path` so a crash or a full disk never leaves half a file behind: the
/// bytes go to a hidden file in the same folder first, which then replaces `path` in one step.
/// Writes to one path may overlap: the last rename wins and the file is always one complete payload.
pub fn write_atomic(path: &Path, data: &[u8]) -> CmdResult<()> {
    write_replacing(path, data, false)
}

/// `write_atomic` for a file holding secrets: it is readable by the user only (mode 0600 on
/// unix), and replacing a file that was readable by others leaves it private too.
pub fn write_private(path: &Path, data: &[u8]) -> CmdResult<()> {
    write_replacing(path, data, true)
}

fn write_replacing(path: &Path, data: &[u8], private: bool) -> CmdResult<()> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("Cannot write {}: it has no file name", path.display()))?;
    let failed = |e: io::Error| format!("Cannot write {}: {e}", path.display());
    let (mut file, temp) = create_temp(path, &name.to_string_lossy(), private).map_err(failed)?;
    let written = (|| -> io::Result<()> {
        file.write_all(data)?;
        file.sync_all()?;
        // Windows cannot rename a file that is still open
        drop(file);
        fs::rename(&temp, path)
    })();
    written.map_err(|e| {
        let _ = fs::remove_file(&temp);
        failed(e)
    })
}

pub fn read_bytes(path: &Path) -> CmdResult<Vec<u8>> {
    fs::read(path).map_err(|e| match e.kind() {
        ErrorKind::NotFound => "Not found".to_string(),
        _ => format!("Cannot read {}: {e}", path.display()),
    })
}

/// The `x-path` header holds the path run through `encodeURIComponent`.
pub fn path_from_header(raw: &str) -> CmdResult<PathBuf> {
    let text = percent_decode_str(raw)
        .decode_utf8()
        .map_err(|_| "The file path is not valid text".to_string())?;
    let path = PathBuf::from(text.as_ref());
    // a relative path would land in the app's working folder
    if !path.is_absolute() {
        return Err(format!("The file path must be absolute: {text}"));
    }
    Ok(path)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("docbro-test-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_files() {
        let dir = tmp("atomic");
        let p = dir.join("a.docx");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"two");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_private_write_is_private_even_over_a_public_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tmp("private");
        let p = dir.join("servers.json");
        let mode = |p: &Path| fs::metadata(p).unwrap().permissions().mode() & 0o777;
        write_private(&p, b"one").unwrap();
        assert_eq!(mode(&p), 0o600);
        fs::set_permissions(&p, fs::Permissions::from_mode(0o644)).unwrap();
        write_private(&p, b"two").unwrap();
        assert_eq!((fs::read(&p).unwrap(), mode(&p)), (b"two".to_vec(), 0o600));
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn write_into_a_missing_folder_fails_with_the_path_in_the_message() {
        let err = write_atomic(Path::new("/nope/x/a.docx"), b"x").unwrap_err();
        assert!(err.contains("/nope/x"), "{err}");
    }

    #[test]
    fn a_failed_write_leaves_no_temp_file() {
        let dir = tmp("failed");
        // a folder where the file should go: the final rename cannot succeed
        let target = dir.join("a.docx");
        fs::create_dir(&target).unwrap();
        assert!(write_atomic(&target, b"x").is_err());
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn concurrent_writes_to_one_path_leave_one_complete_payload() {
        use std::sync::{Arc, Barrier};

        // different sizes and bytes: a mix of two writes, or a longer one's tail, shows
        let payloads: Vec<Vec<u8>> =
            [(1024, 0x11), (64 * 1024, 0x22), (3 * 1024, 0x33), (16 * 1024, 0x44), (512, 0x55)]
                .into_iter()
                .map(|(len, byte)| vec![byte; len])
                .collect();
        let dir = tmp("concurrent");
        let target = dir.join("a.docx");
        for round in 0..40 {
            let start = Arc::new(Barrier::new(payloads.len()));
            let writers: Vec<_> = payloads
                .iter()
                .cloned()
                .map(|payload| {
                    let (target, start) = (target.clone(), start.clone());
                    std::thread::spawn(move || {
                        start.wait();
                        write_atomic(&target, &payload)
                    })
                })
                .collect();
            for writer in writers {
                writer.join().unwrap().unwrap_or_else(|e| panic!("round {round}: {e}"));
            }
            let content = fs::read(&target).unwrap();
            assert!(
                payloads.contains(&content),
                "round {round}: {} bytes, not one payload",
                content.len()
            );
            let names: Vec<_> =
                fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name()).collect();
            assert_eq!(names, vec![std::ffi::OsString::from("a.docx")], "round {round}");
        }
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn reading_returns_the_bytes_and_says_not_found_for_a_missing_file() {
        let dir = tmp("read");
        let p = dir.join("a.md");
        fs::write(&p, [0u8, 159, 146, 150]).unwrap();
        assert_eq!(read_bytes(&p).unwrap(), vec![0u8, 159, 146, 150]);
        assert_eq!(read_bytes(&dir.join("missing.md")).unwrap_err(), "Not found");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn the_path_header_is_decoded_back_to_the_path() {
        let raw = encode_like_the_webview("/Users/me/My Docs/näme & co #1.docx");
        assert_eq!(raw, "%2FUsers%2Fme%2FMy%20Docs%2Fn%C3%A4me%20%26%20co%20%231.docx");
        assert_eq!(
            path_from_header(&raw).unwrap(),
            PathBuf::from("/Users/me/My Docs/näme & co #1.docx")
        );
    }

    #[test]
    fn a_relative_or_broken_path_header_is_refused() {
        assert!(path_from_header("a.docx").is_err());
        assert!(path_from_header("").is_err());
        // %FF is not UTF-8
        assert!(path_from_header("%2Ftmp%2F%FF.docx").is_err());
    }

    /// What `encodeURIComponent` does, for the characters these tests use.
    fn encode_like_the_webview(text: &str) -> String {
        text.bytes()
            .map(|b| match b {
                b'A'..=b'Z'
                | b'a'..=b'z'
                | b'0'..=b'9'
                | b'-'
                | b'_'
                | b'.'
                | b'!'
                | b'~'
                | b'*'
                | b'\''
                | b'('
                | b')' => (b as char).to_string(),
                _ => format!("%{b:02X}"),
            })
            .collect()
    }
}
