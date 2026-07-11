use crate::{Job, JobState};
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub struct JobStore {
    jobs: BTreeMap<u64, Job>,
}

impl JobStore {
    pub fn insert(&mut self, job: Job) {
        self.jobs.insert(job.id, job);
    }

    pub fn get(&self, id: u64) -> Option<&Job> {
        self.jobs.get(&id)
    }

    pub fn claim(&mut self, id: u64, now_ms: u64, lease_ms: u64) -> Option<Job> {
        let job = self.jobs.get_mut(&id)?;
        let eligible = match job.state {
            JobState::Ready => true,
            JobState::Waiting { ready_at_ms } => ready_at_ms <= now_ms,
            JobState::Leased { until_ms } => until_ms <= now_ms,
            JobState::Succeeded | JobState::FailedPermanently | JobState::Cancelled => false,
        };
        if !eligible || job.attempts >= job.max_attempts {
            return None;
        }

        job.attempts += 1;
        job.state = JobState::Leased {
            until_ms: now_ms.saturating_add(lease_ms),
        };
        Some(job.clone())
    }

    pub fn cancel(&mut self, id: u64) -> bool {
        let Some(job) = self.jobs.get_mut(&id) else {
            return false;
        };
        if matches!(job.state, JobState::Succeeded | JobState::FailedPermanently) {
            return false;
        }
        job.state = JobState::Cancelled;
        true
    }

    pub fn finish_success(&mut self, id: u64, expected_attempt: u32) -> bool {
        self.transition_leased(id, expected_attempt, JobState::Succeeded)
    }

    pub fn finish_permanent(&mut self, id: u64, expected_attempt: u32) -> bool {
        self.transition_leased(id, expected_attempt, JobState::FailedPermanently)
    }

    pub fn schedule_retry(&mut self, id: u64, expected_attempt: u32, ready_at_ms: u64) -> bool {
        let Some(job) = self.jobs.get_mut(&id) else {
            return false;
        };
        if job.attempts != expected_attempt {
            return false;
        }
        job.state = JobState::Waiting { ready_at_ms };
        true
    }

    fn transition_leased(&mut self, id: u64, expected_attempt: u32, next: JobState) -> bool {
        let Some(job) = self.jobs.get_mut(&id) else {
            return false;
        };
        if job.attempts != expected_attempt || !matches!(job.state, JobState::Leased { .. }) {
            return false;
        }
        job.state = next;
        true
    }
}
