//! Own the complete directory of a temporary SQLite database, not just its main
//! file. SQLite WAL/SHM files may outlive an asynchronous pool's last handle,
//! especially when the test's Tokio runtime is shut down before pool teardown.
//! `NamedTempFile` only removes the main file and strands those sidecars.
//!
//! Keep this fixture alive for the whole test, including any reopen assertions.
//! It is test-only: it must never be used to open or clean up a user database.

use std::io;
use std::path::{Path, PathBuf};

pub struct TempSqliteDb {
    // Declared after `path` so the directory remains owned until the path is
    // dropped. TempDir removes only this newly created, private directory.
    path: PathBuf,
    _directory: tempfile::TempDir,
}

impl TempSqliteDb {
    pub fn new() -> io::Result<Self> {
        let directory = tempfile::Builder::new()
            .prefix("morphz-test-sqlite-")
            .tempdir()?;
        let path = directory.path().join("database.sqlite");
        // Preserve the empty-file starting state of the old NamedTempFile
        // fixtures, including tests that inspect/migrate the file before open.
        let mut options = std::fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.open(&path)?;
        Ok(Self {
            path,
            _directory: directory,
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}
