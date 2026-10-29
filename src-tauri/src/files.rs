use std::{
    fs::{self, File},
    io::{self, ErrorKind, Write},
    path::{Path, PathBuf},
};

use percent_encoding::percent_decode_str;

use crate::CmdResult;

/// Writes `data` to `path` so a crash or a full disk never leaves half a file behind: the
/// bytes go to a hidden file in the same folder first, which then replaces `path` in one step.
pub fn write_atomic(path: &Path, data: &[u8]) -> CmdResult<()> {
    let name = path
        .file_name()
        .ok_or_else(|| format!("Cannot write {}: it has no file name", path.display()))?;
    let temp = path.with_file_name(format!(".{}.docbro-tmp", name.to_string_lossy()));
    let written = (|| -> io::Result<()> {
        let mut file = File::create(&temp)?;
        file.write_all(data)?;
        file.sync_all()?;
        fs::rename(&temp, path)
    })();
    written.map_err(|e| {
        let _ = fs::remove_file(&temp);
        format!("Cannot write {}: {e}", path.display())
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
