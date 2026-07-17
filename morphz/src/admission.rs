//! Deterministic, in-memory admission policy for the single-node scheduler.
//!
//! This module deliberately knows nothing about Orchestrator records, SQLite,
//! Providers, or executors.  A caller projects any durable queue row into an
//! [`AdmissionKey`], rebuilds the queue after restart, and keeps the payload in
//! its own domain type.
//!
//! There are three important boundaries:
//!
//! - the declared [`AdmissionClass`] is fixed by the Runtime and is not a
//!   model-controlled business priority;
//! - age may only promote an already-declared class, so a continuously busy
//!   high-priority lane cannot starve old work forever;
//! - FIFO order comes exclusively from the persisted `created_at_ms` and `id`.
//!   Loading rows in a different database order therefore produces the same
//!   first admission and the same reconstructed schedule.

use std::collections::{BTreeMap, HashSet};
use std::fmt;

/// Runtime-owned priority classes, ordered from most to least latency
/// sensitive.
///
/// Do not add arbitrary numeric priorities to queue records.  If a new kind of
/// work does not fit one of these classes, its scheduling semantics should be
/// reviewed explicitly.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
#[repr(u8)]
pub enum AdmissionClass {
    InteractiveControl = 0,
    Delivery = 1,
    Objective = 2,
    ScheduledBackground = 3,
    Maintenance = 4,
}

impl AdmissionClass {
    pub const ALL: [Self; 5] = [
        Self::InteractiveControl,
        Self::Delivery,
        Self::Objective,
        Self::ScheduledBackground,
        Self::Maintenance,
    ];

    pub const fn rank(self) -> u8 {
        self as u8
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InteractiveControl => "interactive_control",
            Self::Delivery => "delivery",
            Self::Objective => "objective",
            Self::ScheduledBackground => "scheduled_background",
            Self::Maintenance => "maintenance",
        }
    }

    const fn from_rank(rank: u8) -> Self {
        match rank {
            0 => Self::InteractiveControl,
            1 => Self::Delivery,
            2 => Self::Objective,
            3 => Self::ScheduledBackground,
            _ => Self::Maintenance,
        }
    }

    /// Dialogue/control and completed-work delivery share the capacity which
    /// must stay available while background work is saturated.
    pub const fn uses_reserved_lane(self) -> bool {
        matches!(self, Self::InteractiveControl | Self::Delivery)
    }
}

/// Generic, durable projection used by the admission policy.
///
/// `created_at_ms` must be copied from the persisted record.  Replacing it with
/// the current time during recovery defeats both FIFO and aging guarantees.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AdmissionKey {
    pub id: String,
    pub agent_id: String,
    pub context_id: String,
    pub session_id: String,
    pub class: AdmissionClass,
    pub created_at_ms: i64,
}

impl AdmissionKey {
    pub fn new(
        id: impl Into<String>,
        agent_id: impl Into<String>,
        context_id: impl Into<String>,
        session_id: impl Into<String>,
        class: AdmissionClass,
        created_at_ms: i64,
    ) -> Self {
        Self {
            id: id.into(),
            agent_id: agent_id.into(),
            context_id: context_id.into(),
            session_id: session_id.into(),
            class,
            created_at_ms,
        }
    }
}

/// The payload remains owned by the caller; only [`AdmissionKey`] participates
/// in policy decisions.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AdmissionEntry<T> {
    pub key: AdmissionKey,
    pub payload: T,
}

impl<T> AdmissionEntry<T> {
    pub fn new(key: AdmissionKey, payload: T) -> Self {
        Self { key, payload }
    }
}

/// Generic starvation prevention.  Every full interval promotes a waiting row
/// by one fixed class until it reaches `InteractiveControl`.
///
/// `None` disables aging.  A zero interval is normalized to one millisecond so
/// configuration cannot cause a division by zero.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgingPolicy {
    pub promotion_interval_ms: Option<u64>,
}

impl AgingPolicy {
    pub const fn disabled() -> Self {
        Self {
            promotion_interval_ms: None,
        }
    }

    pub const fn every(promotion_interval_ms: u64) -> Self {
        Self {
            promotion_interval_ms: Some(promotion_interval_ms),
        }
    }

    pub fn effective_class(
        self,
        declared: AdmissionClass,
        created_at_ms: i64,
        now_ms: i64,
    ) -> AdmissionClass {
        let Some(interval) = self.promotion_interval_ms else {
            return declared;
        };
        let interval = interval.max(1);
        let waited_ms = now_ms.saturating_sub(created_at_ms).max(0) as u64;
        let promotions = (waited_ms / interval).min(declared.rank() as u64) as u8;
        AdmissionClass::from_rank(declared.rank().saturating_sub(promotions))
    }
}

impl Default for AgingPolicy {
    fn default() -> Self {
        // This is a policy-library default, not a public product promise.  The
        // Runtime should construct the value from its scheduler configuration.
        Self::every(30_000)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AdmissionQueueError {
    EmptyField { id: String, field: &'static str },
    DuplicateId(String),
}

impl fmt::Display for AdmissionQueueError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyField { id, field } => {
                write!(f, "admission row '{id}' has empty {field}")
            }
            Self::DuplicateId(id) => write!(f, "duplicate admission id '{id}'"),
        }
    }
}

impl std::error::Error for AdmissionQueueError {}

/// Optional cursor state for exact in-process fairness continuation.
///
/// Queue correctness does not depend on persisting this checkpoint: rebuilding
/// from durable rows is deterministic and fair.  Persisting it merely avoids a
/// harmless round-robin phase reset after restart.  Stale group ids are ignored
/// automatically.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct FairnessCheckpoint {
    pub last_agent_by_class: Vec<(AdmissionClass, String)>,
    pub last_context_by_agent: Vec<(AdmissionClass, String, String)>,
    pub last_session_by_context: Vec<(AdmissionClass, String, String, String)>,
}

#[derive(Clone, Debug, Default)]
struct FairnessCursor {
    agents: BTreeMap<AdmissionClass, String>,
    contexts: BTreeMap<(AdmissionClass, String), String>,
    sessions: BTreeMap<(AdmissionClass, String, String), String>,
}

impl FairnessCursor {
    fn from_checkpoint(checkpoint: FairnessCheckpoint) -> Self {
        Self {
            agents: checkpoint.last_agent_by_class.into_iter().collect(),
            contexts: checkpoint
                .last_context_by_agent
                .into_iter()
                .map(|(class, agent, context)| ((class, agent), context))
                .collect(),
            sessions: checkpoint
                .last_session_by_context
                .into_iter()
                .map(|(class, agent, context, session)| ((class, agent, context), session))
                .collect(),
        }
    }

    fn checkpoint(&self) -> FairnessCheckpoint {
        FairnessCheckpoint {
            last_agent_by_class: self
                .agents
                .iter()
                .map(|(class, agent)| (*class, agent.clone()))
                .collect(),
            last_context_by_agent: self
                .contexts
                .iter()
                .map(|((class, agent), context)| (*class, agent.clone(), context.clone()))
                .collect(),
            last_session_by_context: self
                .sessions
                .iter()
                .map(|((class, agent, context), session)| {
                    (*class, agent.clone(), context.clone(), session.clone())
                })
                .collect(),
        }
    }
}

/// A deterministic hierarchical round-robin queue.
///
/// Within the currently effective class it rotates in this order:
/// `Agent -> Context -> Session`, then takes the oldest row in that Session.
/// The first group at every level is the group whose oldest row has the lowest
/// persisted `(created_at_ms, id)` key.  This makes recovery independent of DB
/// return order while preventing one busy tenant from monopolizing admission.
#[derive(Clone, Debug)]
pub struct FairAdmissionQueue<T> {
    entries: Vec<AdmissionEntry<T>>,
    ids: HashSet<String>,
    cursor: FairnessCursor,
    aging: AgingPolicy,
}

impl<T> FairAdmissionQueue<T> {
    pub fn new(aging: AgingPolicy) -> Self {
        Self {
            entries: Vec::new(),
            ids: HashSet::new(),
            cursor: FairnessCursor::default(),
            aging,
        }
    }

    pub fn rebuild(
        entries: impl IntoIterator<Item = AdmissionEntry<T>>,
        aging: AgingPolicy,
    ) -> Result<Self, AdmissionQueueError> {
        Self::rebuild_with_checkpoint(entries, aging, FairnessCheckpoint::default())
    }

    pub fn rebuild_with_checkpoint(
        entries: impl IntoIterator<Item = AdmissionEntry<T>>,
        aging: AgingPolicy,
        checkpoint: FairnessCheckpoint,
    ) -> Result<Self, AdmissionQueueError> {
        let mut queue = Self {
            entries: Vec::new(),
            ids: HashSet::new(),
            cursor: FairnessCursor::from_checkpoint(checkpoint),
            aging,
        };
        for entry in entries {
            queue.push(entry)?;
        }
        // Storage order is not semantically relevant, but keeping a canonical
        // order makes debugging and snapshots reproducible.
        queue
            .entries
            .sort_by(|left, right| fifo_cmp(&left.key, &right.key));
        Ok(queue)
    }

    pub fn push(&mut self, entry: AdmissionEntry<T>) -> Result<(), AdmissionQueueError> {
        validate_key(&entry.key)?;
        if !self.ids.insert(entry.key.id.clone()) {
            return Err(AdmissionQueueError::DuplicateId(entry.key.id));
        }
        self.entries.push(entry);
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn iter(&self) -> impl Iterator<Item = &AdmissionEntry<T>> {
        self.entries.iter()
    }

    pub fn checkpoint(&self) -> FairnessCheckpoint {
        self.cursor.checkpoint()
    }

    pub fn remove(&mut self, id: &str) -> Option<AdmissionEntry<T>> {
        let index = self.entries.iter().position(|entry| entry.key.id == id)?;
        self.ids.remove(id);
        Some(self.entries.swap_remove(index))
    }

    pub fn peek_next(&self, now_ms: i64) -> Option<&AdmissionEntry<T>> {
        self.peek_next_where(now_ms, |_, _| true)
    }

    pub fn peek_next_where(
        &self,
        now_ms: i64,
        mut admissible: impl FnMut(&AdmissionKey, &T) -> bool,
    ) -> Option<&AdmissionEntry<T>> {
        let index = select_index(
            &self.entries,
            &self.cursor,
            self.aging,
            now_ms,
            &mut admissible,
        )?;
        self.entries.get(index)
    }

    pub fn pop_next(&mut self, now_ms: i64) -> Option<AdmissionEntry<T>> {
        self.pop_next_where(now_ms, |_, _| true)
    }

    /// Selects the next row among entries accepted by a caller-owned capacity
    /// predicate.  A rejected row stays queued and does not advance cursors.
    pub fn pop_next_where(
        &mut self,
        now_ms: i64,
        mut admissible: impl FnMut(&AdmissionKey, &T) -> bool,
    ) -> Option<AdmissionEntry<T>> {
        let index = select_index(
            &self.entries,
            &self.cursor,
            self.aging,
            now_ms,
            &mut admissible,
        )?;
        let selected = &self.entries[index].key;
        let class = self
            .aging
            .effective_class(selected.class, selected.created_at_ms, now_ms);
        self.cursor.agents.insert(class, selected.agent_id.clone());
        self.cursor.contexts.insert(
            (class, selected.agent_id.clone()),
            selected.context_id.clone(),
        );
        self.cursor.sessions.insert(
            (
                class,
                selected.agent_id.clone(),
                selected.context_id.clone(),
            ),
            selected.session_id.clone(),
        );
        self.ids.remove(&selected.id);
        Some(self.entries.swap_remove(index))
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReservedLaneCapacity {
    /// Total simultaneously admitted work at this resource boundary.
    pub total_slots: usize,
    /// Slots protected collectively for InteractiveControl and Delivery.
    pub dialogue_delivery_slots: usize,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct InFlightUsage {
    pub total: usize,
    pub dialogue_delivery: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CapacityDecision {
    Admit,
    AtCapacity,
    ReservedForDialogueDelivery,
}

/// Pure capacity decision for a latency-sensitive reserved lane.
///
/// Reserved work may use any physically free slot.  General work may only use a
/// slot if doing so still leaves enough free capacity to satisfy the currently
/// unused reservation.  The reservation is clamped to total capacity.
pub const fn reserved_lane_decision(
    class: AdmissionClass,
    capacity: ReservedLaneCapacity,
    in_flight: InFlightUsage,
) -> CapacityDecision {
    if capacity.total_slots == 0 || in_flight.total >= capacity.total_slots {
        return CapacityDecision::AtCapacity;
    }
    if class.uses_reserved_lane() {
        return CapacityDecision::Admit;
    }

    let reserved = if capacity.dialogue_delivery_slots > capacity.total_slots {
        capacity.total_slots
    } else {
        capacity.dialogue_delivery_slots
    };
    let unused_reservation = reserved.saturating_sub(in_flight.dialogue_delivery);
    let free_slots = capacity.total_slots.saturating_sub(in_flight.total);
    if free_slots > unused_reservation {
        CapacityDecision::Admit
    } else {
        CapacityDecision::ReservedForDialogueDelivery
    }
}

fn validate_key(key: &AdmissionKey) -> Result<(), AdmissionQueueError> {
    for (field, value) in [
        ("id", key.id.as_str()),
        ("agent_id", key.agent_id.as_str()),
        ("context_id", key.context_id.as_str()),
        ("session_id", key.session_id.as_str()),
    ] {
        if value.is_empty() {
            return Err(AdmissionQueueError::EmptyField {
                id: key.id.clone(),
                field,
            });
        }
    }
    Ok(())
}

fn fifo_cmp(left: &AdmissionKey, right: &AdmissionKey) -> std::cmp::Ordering {
    left.created_at_ms
        .cmp(&right.created_at_ms)
        .then_with(|| left.id.cmp(&right.id))
        .then_with(|| left.agent_id.cmp(&right.agent_id))
        .then_with(|| left.context_id.cmp(&right.context_id))
        .then_with(|| left.session_id.cmp(&right.session_id))
}

#[derive(Clone, Debug)]
struct GroupHead {
    id: String,
    oldest_created_at_ms: i64,
    oldest_id: String,
}

impl GroupHead {
    fn update_if_older(&mut self, key: &AdmissionKey) {
        if (key.created_at_ms, key.id.as_str())
            < (self.oldest_created_at_ms, self.oldest_id.as_str())
        {
            self.oldest_created_at_ms = key.created_at_ms;
            self.oldest_id.clone_from(&key.id);
        }
    }
}

fn ordered_group_ids(groups: BTreeMap<String, GroupHead>) -> Vec<String> {
    let mut heads: Vec<_> = groups.into_values().collect();
    heads.sort_by(|left, right| {
        left.oldest_created_at_ms
            .cmp(&right.oldest_created_at_ms)
            .then_with(|| left.oldest_id.cmp(&right.oldest_id))
            .then_with(|| left.id.cmp(&right.id))
    });
    heads.into_iter().map(|head| head.id).collect()
}

fn next_group(groups: &[String], last: Option<&String>) -> Option<String> {
    if groups.is_empty() {
        return None;
    }
    let index = last
        .and_then(|last| groups.iter().position(|group| group == last))
        .map(|index| (index + 1) % groups.len())
        .unwrap_or(0);
    Some(groups[index].clone())
}

fn group_heads<T>(
    entries: &[AdmissionEntry<T>],
    indices: impl IntoIterator<Item = usize>,
    id: impl Fn(&AdmissionKey) -> &str,
) -> BTreeMap<String, GroupHead> {
    let mut groups: BTreeMap<String, GroupHead> = BTreeMap::new();
    for index in indices {
        let key = &entries[index].key;
        let group_id = id(key).to_string();
        groups
            .entry(group_id.clone())
            .and_modify(|head| head.update_if_older(key))
            .or_insert_with(|| GroupHead {
                id: group_id,
                oldest_created_at_ms: key.created_at_ms,
                oldest_id: key.id.clone(),
            });
    }
    groups
}

fn select_index<T>(
    entries: &[AdmissionEntry<T>],
    cursor: &FairnessCursor,
    aging: AgingPolicy,
    now_ms: i64,
    admissible: &mut impl FnMut(&AdmissionKey, &T) -> bool,
) -> Option<usize> {
    let eligible: Vec<_> = entries
        .iter()
        .enumerate()
        .filter(|(_, entry)| admissible(&entry.key, &entry.payload))
        .map(|(index, entry)| {
            (
                index,
                aging.effective_class(entry.key.class, entry.key.created_at_ms, now_ms),
            )
        })
        .collect();
    let class = eligible.iter().map(|(_, class)| *class).min()?;
    let class_indices: Vec<_> = eligible
        .iter()
        .filter_map(|(index, effective)| (*effective == class).then_some(*index))
        .collect();

    let agents = ordered_group_ids(group_heads(entries, class_indices.iter().copied(), |key| {
        &key.agent_id
    }));
    let agent = next_group(&agents, cursor.agents.get(&class))?;
    let agent_indices: Vec<_> = class_indices
        .iter()
        .copied()
        .filter(|index| entries[*index].key.agent_id == agent)
        .collect();

    let contexts = ordered_group_ids(group_heads(entries, agent_indices.iter().copied(), |key| {
        &key.context_id
    }));
    let context = next_group(&contexts, cursor.contexts.get(&(class, agent.clone())))?;
    let context_indices: Vec<_> = agent_indices
        .iter()
        .copied()
        .filter(|index| entries[*index].key.context_id == context)
        .collect();

    let sessions = ordered_group_ids(group_heads(
        entries,
        context_indices.iter().copied(),
        |key| &key.session_id,
    ));
    let session = next_group(
        &sessions,
        cursor
            .sessions
            .get(&(class, agent.clone(), context.clone())),
    )?;

    context_indices
        .into_iter()
        .filter(|index| entries[*index].key.session_id == session)
        .min_by(|left, right| fifo_cmp(&entries[*left].key, &entries[*right].key))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(
        id: &str,
        agent: &str,
        context: &str,
        session: &str,
        class: AdmissionClass,
        created_at_ms: i64,
    ) -> AdmissionEntry<&'static str> {
        AdmissionEntry::new(
            AdmissionKey::new(id, agent, context, session, class, created_at_ms),
            "payload",
        )
    }

    fn drain_ids<T>(queue: &mut FairAdmissionQueue<T>, now_ms: i64) -> Vec<String> {
        let mut ids = Vec::new();
        while let Some(entry) = queue.pop_next(now_ms) {
            ids.push(entry.key.id);
        }
        ids
    }

    #[test]
    fn fixed_classes_are_admitted_in_runtime_order() {
        let mut queue = FairAdmissionQueue::rebuild(
            [
                entry("maintenance", "a", "c", "s", AdmissionClass::Maintenance, 1),
                entry(
                    "scheduled",
                    "a",
                    "c",
                    "s",
                    AdmissionClass::ScheduledBackground,
                    2,
                ),
                entry("objective", "a", "c", "s", AdmissionClass::Objective, 3),
                entry("delivery", "a", "c", "s", AdmissionClass::Delivery, 4),
                entry(
                    "interactive",
                    "a",
                    "c",
                    "s",
                    AdmissionClass::InteractiveControl,
                    5,
                ),
            ],
            AgingPolicy::disabled(),
        )
        .unwrap();

        assert_eq!(
            drain_ids(&mut queue, 10),
            [
                "interactive",
                "delivery",
                "objective",
                "scheduled",
                "maintenance"
            ]
        );
    }

    #[test]
    fn persisted_timestamp_and_id_are_the_fifo_tie_break() {
        let mut queue = FairAdmissionQueue::rebuild(
            [
                entry("b", "a", "c", "s", AdmissionClass::Objective, 10),
                entry("c", "a", "c", "s", AdmissionClass::Objective, 9),
                entry("a", "a", "c", "s", AdmissionClass::Objective, 10),
            ],
            AgingPolicy::disabled(),
        )
        .unwrap();
        assert_eq!(drain_ids(&mut queue, 10), ["c", "a", "b"]);
    }

    #[test]
    fn busy_agent_cannot_monopolize_a_class() {
        let mut queue = FairAdmissionQueue::rebuild(
            [
                entry("a1", "agent-a", "c", "s", AdmissionClass::Objective, 1),
                entry("a2", "agent-a", "c", "s", AdmissionClass::Objective, 2),
                entry("a3", "agent-a", "c", "s", AdmissionClass::Objective, 3),
                entry("b1", "agent-b", "c", "s", AdmissionClass::Objective, 4),
                entry("b2", "agent-b", "c", "s", AdmissionClass::Objective, 5),
            ],
            AgingPolicy::disabled(),
        )
        .unwrap();
        assert_eq!(drain_ids(&mut queue, 10), ["a1", "b1", "a2", "b2", "a3"]);
    }

    #[test]
    fn contexts_and_sessions_rotate_hierarchically() {
        let mut queue = FairAdmissionQueue::rebuild(
            [
                entry("s1-a", "a", "c1", "s1", AdmissionClass::Objective, 1),
                entry("s1-b", "a", "c1", "s1", AdmissionClass::Objective, 2),
                entry("s2-a", "a", "c1", "s2", AdmissionClass::Objective, 3),
                entry("s2-b", "a", "c1", "s2", AdmissionClass::Objective, 4),
                entry("c2-a", "a", "c2", "s3", AdmissionClass::Objective, 5),
                entry("c2-b", "a", "c2", "s3", AdmissionClass::Objective, 6),
            ],
            AgingPolicy::disabled(),
        )
        .unwrap();

        assert_eq!(
            drain_ids(&mut queue, 10),
            ["s1-a", "c2-a", "s2-a", "c2-b", "s1-b", "s2-b"]
        );
    }

    #[test]
    fn aging_eventually_promotes_old_maintenance_work() {
        let aging = AgingPolicy::every(100);
        assert_eq!(
            aging.effective_class(AdmissionClass::Maintenance, 0, 99),
            AdmissionClass::Maintenance
        );
        assert_eq!(
            aging.effective_class(AdmissionClass::Maintenance, 0, 100),
            AdmissionClass::ScheduledBackground
        );
        assert_eq!(
            aging.effective_class(AdmissionClass::Maintenance, 0, 400),
            AdmissionClass::InteractiveControl
        );

        let mut queue = FairAdmissionQueue::rebuild(
            [
                entry(
                    "new-interactive",
                    "a",
                    "c",
                    "s",
                    AdmissionClass::InteractiveControl,
                    390,
                ),
                entry(
                    "old-maintenance",
                    "b",
                    "c",
                    "s",
                    AdmissionClass::Maintenance,
                    0,
                ),
            ],
            aging,
        )
        .unwrap();
        // Both are now in the effective interactive class; persisted FIFO and
        // hierarchical fairness choose the old row first.
        assert_eq!(queue.pop_next(400).unwrap().key.id, "old-maintenance");
    }

    #[test]
    fn rebuild_is_independent_of_database_return_order() {
        let rows = [
            entry("a1", "a", "c", "s", AdmissionClass::Objective, 1),
            entry("b1", "b", "c", "s", AdmissionClass::Objective, 2),
            entry("a2", "a", "c", "s", AdmissionClass::Objective, 3),
            entry("b2", "b", "c", "s", AdmissionClass::Objective, 4),
        ];
        let mut forward =
            FairAdmissionQueue::rebuild(rows.clone(), AgingPolicy::disabled()).unwrap();
        let mut reverse =
            FairAdmissionQueue::rebuild(rows.into_iter().rev(), AgingPolicy::disabled()).unwrap();
        assert_eq!(drain_ids(&mut forward, 10), drain_ids(&mut reverse, 10));
    }

    #[test]
    fn checkpoint_preserves_round_robin_phase() {
        let rows = [
            entry("a1", "a", "c", "s", AdmissionClass::Objective, 1),
            entry("a2", "a", "c", "s", AdmissionClass::Objective, 2),
            entry("b1", "b", "c", "s", AdmissionClass::Objective, 3),
        ];
        let mut original = FairAdmissionQueue::rebuild(rows, AgingPolicy::disabled()).unwrap();
        assert_eq!(original.pop_next(10).unwrap().key.id, "a1");
        let checkpoint = original.checkpoint();
        let remaining: Vec<_> = original.iter().cloned().collect();
        let mut restored = FairAdmissionQueue::rebuild_with_checkpoint(
            remaining,
            AgingPolicy::disabled(),
            checkpoint,
        )
        .unwrap();
        assert_eq!(restored.pop_next(10).unwrap().key.id, "b1");
    }

    #[test]
    fn duplicate_and_empty_identity_are_rejected() {
        let duplicate = FairAdmissionQueue::rebuild(
            [
                entry("same", "a", "c", "s", AdmissionClass::Objective, 1),
                entry("same", "b", "c", "s", AdmissionClass::Objective, 2),
            ],
            AgingPolicy::disabled(),
        );
        assert!(matches!(duplicate, Err(AdmissionQueueError::DuplicateId(id)) if id == "same"));

        let empty = FairAdmissionQueue::rebuild(
            [entry("id", "", "c", "s", AdmissionClass::Objective, 1)],
            AgingPolicy::disabled(),
        );
        assert!(matches!(
            empty,
            Err(AdmissionQueueError::EmptyField {
                field: "agent_id",
                ..
            })
        ));
    }

    #[test]
    fn reserved_lane_keeps_capacity_for_dialogue_and_delivery() {
        let capacity = ReservedLaneCapacity {
            total_slots: 4,
            dialogue_delivery_slots: 1,
        };
        assert_eq!(
            reserved_lane_decision(
                AdmissionClass::Objective,
                capacity,
                InFlightUsage {
                    total: 3,
                    dialogue_delivery: 0,
                },
            ),
            CapacityDecision::ReservedForDialogueDelivery
        );
        assert_eq!(
            reserved_lane_decision(
                AdmissionClass::Delivery,
                capacity,
                InFlightUsage {
                    total: 3,
                    dialogue_delivery: 0,
                },
            ),
            CapacityDecision::Admit
        );
        assert_eq!(
            reserved_lane_decision(
                AdmissionClass::Maintenance,
                capacity,
                InFlightUsage {
                    total: 3,
                    dialogue_delivery: 1,
                },
            ),
            CapacityDecision::Admit
        );
        assert_eq!(
            reserved_lane_decision(
                AdmissionClass::InteractiveControl,
                capacity,
                InFlightUsage {
                    total: 4,
                    dialogue_delivery: 1,
                },
            ),
            CapacityDecision::AtCapacity
        );
    }

    #[test]
    fn selector_can_skip_general_work_while_reserved_lane_is_needed() {
        let capacity = ReservedLaneCapacity {
            total_slots: 2,
            dialogue_delivery_slots: 1,
        };
        let usage = InFlightUsage {
            total: 1,
            dialogue_delivery: 0,
        };
        let mut queue = FairAdmissionQueue::rebuild(
            [
                entry("objective", "a", "c", "s", AdmissionClass::Objective, 1),
                entry("delivery", "b", "c", "s", AdmissionClass::Delivery, 2),
            ],
            AgingPolicy::disabled(),
        )
        .unwrap();
        let selected = queue
            .pop_next_where(10, |key, _| {
                reserved_lane_decision(key.class, capacity, usage) == CapacityDecision::Admit
            })
            .unwrap();
        assert_eq!(selected.key.id, "delivery");
        assert_eq!(queue.len(), 1);
        assert_eq!(queue.peek_next(10).unwrap().key.id, "objective");
    }
}
