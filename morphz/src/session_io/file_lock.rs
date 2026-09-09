//! Cooperating IO writers serialize filesystem preparation for a deterministic
//! output identity. This is not a database-version or old-writer fence.
use sha2::{Digest, Sha256};
use std::{fs::File, path::Path, time::Duration};

/// Keep lock files permanently: unlinking one while another process holds its
/// inode would allow a second lock domain. Hash stripes bound the file count to
/// 256 per artifact root; a collision only delays unrelated output preparation.
/// Dropping the handle (including task cancellation/process exit) releases the
/// OS lock. No database table, credential or writer permission is modified.
pub(crate) async fn acquire(root: &Path, event_id: &str) -> std::io::Result<File> {
    let directory = root.join("session-io-output-locks");
    tokio::fs::create_dir_all(&directory).await?;
    let path = directory.join(format!(
        "{:02x}.lock",
        Sha256::digest(event_id.as_bytes())[0]
    ));
    let file = tokio::task::spawn_blocking(move || {
        let mut options = std::fs::OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
        }
        options.open(path)
    })
    .await
    .map_err(std::io::Error::other)??;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) => {
                tokio::time::sleep(Duration::from_millis(5)).await
            }
            Err(std::fs::TryLockError::Error(error)) => return Err(error),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn recovery_waits_for_live_io_output_before_checking_ownership() {
        use std::sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        };
        let temp = tempfile::TempDir::new().unwrap();
        let event = "io_output_recovery_fixture";
        let lock = acquire(temp.path(), event).await.unwrap();
        let prepared = crate::model_input::prepare_message_input_attachments(
            temp.path(),
            "session",
            event,
            vec![crate::sdk::MessageAttachmentInput {
                name: "fixture.pdf".into(),
                media_type: "application/pdf".into(),
                data: b"%PDF-1.4\nfixture".to_vec(),
            }],
            crate::llm::ModelInputLimits::default(),
        )
        .await
        .unwrap();
        let committed = Arc::new(AtomicBool::new(false));
        let queried = Arc::new(AtomicBool::new(false));
        let task = {
            let (root, committed, queried) = (
                temp.path().to_path_buf(),
                committed.clone(),
                queried.clone(),
            );
            tokio::spawn(async move {
                crate::model_input::recover_pending_message_attachments(
                    &root,
                    Duration::ZERO,
                    move |_| {
                        queried.store(true, Ordering::SeqCst);
                        let exists = committed.load(Ordering::SeqCst);
                        async move { Ok(exists) }
                    },
                )
                .await
                .unwrap()
            })
        };
        tokio::time::sleep(Duration::from_millis(30)).await;
        assert!(!task.is_finished());
        assert!(!queried.load(Ordering::SeqCst));
        // Simulate a crash after the Event commit, before manifest cleanup.
        committed.store(true, Ordering::SeqCst);
        drop(lock);
        let recovery = tokio::time::timeout(Duration::from_secs(5), task)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(recovery.committed_manifests, 1);
        assert_eq!(recovery.orphaned_imports, 0);
        assert_eq!(
            crate::model_input::read_stored_attachment(temp.path(), &prepared.metadata()[0])
                .await
                .unwrap()
                .data,
            b"%PDF-1.4\nfixture"
        );
    }
}
