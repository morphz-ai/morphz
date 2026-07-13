#[derive(Debug, Clone, PartialEq, Eq)]
pub enum JobState {
    Ready,
    Leased { until_ms: u64 },
    Waiting { ready_at_ms: u64 },
    Succeeded,
    FailedPermanently,
    Cancelled,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Job {
    pub id: u64,
    /// Number of executions already started, including the current lease.
    pub attempts: u32,
    /// Total number of executions allowed, including the first execution.
    pub max_attempts: u32,
    pub state: JobState,
}

impl Job {
    pub fn new(id: u64, max_attempts: u32) -> Self {
        Self {
            id,
            attempts: 0,
            max_attempts: max_attempts.max(1),
            state: JobState::Ready,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FailureKind {
    Transient { retry_after_ms: Option<u64> },
    Permanent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecutionResult {
    Succeeded,
    Failed(FailureKind),
}
