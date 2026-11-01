//! Wakeup hints for the bounded durable Event tail. Never a second ledger.
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::sync::watch;
type StoreError = Box<dyn std::error::Error + Send + Sync>;

pub(crate) struct SqliteEventChanges {
    sender: Arc<watch::Sender<u64>>,
    // The OS subscription must live as long as the Store, not one page/socket.
    _watcher: Option<RecommendedWatcher>,
}

pub(crate) fn wake(sender: &watch::Sender<u64>) {
    sender.send_modify(|generation| *generation = generation.wrapping_add(1));
}

fn relevant(event: &notify::Event, database: &Path, wal: &Path) -> bool {
    // SHM/access notifications are caused by readers too: accepting them
    // would feed tail reads back into tail reads indefinitely.
    !matches!(event.kind, EventKind::Access(_))
        && (event.need_rescan()
            || event
                .paths
                .iter()
                .any(|path| path == database || path == wal))
}

impl SqliteEventChanges {
    pub(crate) fn new(database: Option<&Path>) -> Result<Self, StoreError> {
        let sender = Arc::new(watch::channel(0).0);
        let watcher = if let Some(database) = database {
            let database = database.canonicalize()?;
            let wal = PathBuf::from(format!("{}-wal", database.display()));
            let directory = database
                .parent()
                .ok_or("SQLite database has no parent directory")?
                .to_owned();
            let notification = Arc::clone(&sender);
            let mut watcher = notify::recommended_watcher(
                move |result: notify::Result<notify::Event>| match result {
                    Ok(event) if relevant(&event, &database, &wal) => wake(&notification),
                    Ok(_) => {}
                    Err(error) => {
                        tracing::error!(%error, event_code="memory.sqlite.event_watch_failed", "SQLite change notification failed; waking the retained durable tail for gap recovery");
                        wake(&notification);
                    }
                },
            )?;
            // Watch the parent so WAL creation/rotation is not a lost inode.
            watcher.watch(&directory, RecursiveMode::NonRecursive)?;
            Some(watcher)
        } else {
            None
        };
        Ok(Self {
            sender,
            _watcher: watcher,
        })
    }
    pub(crate) fn subscribe(&self) -> watch::Receiver<u64> {
        self.sender.subscribe()
    }
    pub(crate) fn committed(&self) {
        wake(&self.sender);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    #[ignore = "child process used only by sqlite_peer_commits_wake_without_a_database_poll"]
    async fn sqlite_peer_commit_helper() {
        use crate::memory::EventStore;
        let started = std::time::Instant::now();
        let path = std::env::var("MORPHZ_NOTIFICATION_TEST_DATABASE")
            .expect("explicit test database required");
        eprintln!("peer open at {:?}", started.elapsed());
        let store = crate::memory::sqlite::SqliteStore::new(&path)
            .await
            .unwrap();
        eprintln!("peer opened at {:?}", started.elapsed());
        store
            .append(crate::event::Event::new(
                "peer-committed".into(),
                "fixture".into(),
                "test".into(),
                "test/peer".into(),
                Default::default(),
            ))
            .await
            .unwrap();
        eprintln!("peer committed at {:?}", started.elapsed());
    }
    #[tokio::test]
    async fn sqlite_peer_commits_wake_without_a_database_poll() {
        use crate::memory::{EventStore, QueryFilter};
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("test.sqlite");
        let store = crate::memory::sqlite::SqliteStore::new(path.to_str().unwrap())
            .await
            .unwrap();
        let mut changes = store.subscribe_event_changes().unwrap();
        let child_output = temporary.path().join("peer-output.log");
        let output = std::fs::File::create_new(&child_output).unwrap();
        let mut child = tokio::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "memory::event_changes::tests::sqlite_peer_commit_helper",
                "--exact",
                "--ignored",
                "--nocapture",
            ])
            .env("MORPHZ_NOTIFICATION_TEST_DATABASE", &path)
            .stdout(output.try_clone().unwrap())
            .stderr(output)
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let mut reads = 0;
        let started = std::time::Instant::now();
        let outcome = tokio::time::timeout(std::time::Duration::from_secs(15), async {
            loop {
                // Every read below requires an OS hint, never a test timer.
                changes.changed().await.unwrap();
                changes.borrow_and_update();
                reads += 1;
                eprintln!("peer hint {reads} at {:?}", started.elapsed());
                if !store
                    .query(QueryFilter {
                        event_id: Some("peer-committed".into()),
                        top_k: Some(1),
                        ..Default::default()
                    })
                    .await
                    .unwrap()
                    .is_empty()
                {
                    break;
                }
            }
        })
        .await;
        if let Err(error) = outcome {
            // Failure diagnosis only: never turn a missed hint into a pass
            // by checking for rows on a timer or waiting for the writer first.
            let status = child.try_wait().unwrap();
            let visible = !store
                .query(QueryFilter {
                    event_id: Some("peer-committed".into()),
                    top_k: Some(1),
                    ..Default::default()
                })
                .await
                .unwrap()
                .is_empty();
            if status.is_none() {
                child.kill().await.unwrap();
                child.wait().await.unwrap();
            }
            use std::io::{Read, Seek, SeekFrom};
            let mut output = std::fs::File::open(&child_output).unwrap();
            let length = output.metadata().unwrap().len();
            output
                .seek(SeekFrom::Start(length.saturating_sub(8192)))
                .unwrap();
            let mut tail = Vec::new();
            output.take(8192).read_to_end(&mut tail).unwrap();
            panic!(
                "peer commit must wake the native subscription: {error}; child={status:?}; event_visible={visible}; hint_reads={reads}; child_output={}",
                String::from_utf8_lossy(&tail)
            );
        }
        assert!(child.wait().await.unwrap().success());
        assert!(reads > 0);
        let mut late = store.subscribe_event_changes().unwrap();
        // A bounded reconnect gap is closed explicitly from the retained
        // physical cursor; subscriptions are not an Event history source.
        let events = store
            .query(QueryFilter {
                after_sequence: Some(0),
                top_k: Some(2),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, "peer-committed");
        late.borrow_and_update();
    }
    #[test]
    fn only_database_content_and_wal_changes_wake_the_tail() {
        use notify::event::{AccessKind, AccessMode, DataChange, ModifyKind};
        let database = Path::new("/test/runtime.sqlite");
        let wal = Path::new("/test/runtime.sqlite-wal");
        let modify = notify::Event::new(EventKind::Modify(ModifyKind::Data(DataChange::Any)));
        assert!(relevant(
            &modify.clone().add_path(wal.into()),
            database,
            wal
        ));
        assert!(relevant(
            &modify.clone().add_path(database.into()),
            database,
            wal
        ));
        assert!(!relevant(
            &modify.add_path("/test/runtime.sqlite-shm".into()),
            database,
            wal
        ));
        let read = notify::Event::new(EventKind::Access(AccessKind::Open(AccessMode::Read)))
            .add_path(database.into());
        assert!(!relevant(&read, database, wal));
    }
    #[tokio::test]
    async fn changes_received_while_busy_are_retained_for_every_reader() {
        let changes = SqliteEventChanges::new(None).unwrap();
        let mut a = changes.subscribe();
        let mut b = changes.subscribe();
        changes.committed();
        changes.committed();
        a.changed().await.unwrap();
        b.changed().await.unwrap();
        assert_eq!(*a.borrow_and_update(), 2);
        assert_eq!(*b.borrow_and_update(), 2);
        assert!(!a.has_changed().unwrap());
    }
}
