//! A source page is a merge of bounded indexed tails, never a window over
//! every historical Event. Shared by SQLite and PostgreSQL adapters.
use crate::event::Event;
use std::collections::{BTreeMap, BTreeSet};

pub(super) const PAIR_BATCH: usize = 128;

pub(super) fn pairs(thread_ids: &[String], topics: &[&str]) -> Vec<(String, String)> {
    let ids = thread_ids.iter().take(2_000).collect::<BTreeSet<_>>();
    let topics = topics.iter().copied().collect::<BTreeSet<_>>();
    ids.into_iter()
        .flat_map(|id| {
            topics
                .iter()
                .map(move |topic| (id.to_string(), topic.to_string()))
        })
        .collect()
}

pub(super) struct Sources {
    limit: usize,
    threads: BTreeMap<String, BTreeMap<i64, Event>>,
}
impl Sources {
    pub(super) fn new(limit: usize) -> Self {
        Self {
            limit: limit.clamp(1, 129),
            threads: BTreeMap::new(),
        }
    }
    pub(super) fn insert(&mut self, thread_id: String, sequence: i64, event: Event) {
        let tail = self.threads.entry(thread_id).or_default();
        tail.insert(sequence, event);
        if tail.len() > self.limit {
            tail.pop_first();
        }
    }
    pub(super) fn finish(self) -> Vec<Event> {
        let mut rows = self
            .threads
            .into_values()
            .flat_map(BTreeMap::into_iter)
            .collect::<Vec<_>>();
        rows.sort_unstable_by_key(|(sequence, _)| *sequence);
        rows.into_iter().map(|(_, event)| event).collect()
    }
}
