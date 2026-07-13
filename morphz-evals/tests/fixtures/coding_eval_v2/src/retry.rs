const BASE_DELAY_MS: u64 = 100;
const MAX_DELAY_MS: u64 = 10_000;

/// Whether another execution may be started after the completed attempt.
pub fn can_retry(completed_attempts: u32, max_attempts: u32) -> bool {
    completed_attempts <= max_attempts
}

/// Delay after a transient failure. The first failed execution waits one base interval.
pub fn retry_delay_ms(completed_attempts: u32, retry_after_ms: Option<u64>) -> u64 {
    if let Some(delay) = retry_after_ms {
        return delay;
    }

    let shift = completed_attempts.min(20);
    BASE_DELAY_MS
        .saturating_mul(1_u64 << shift)
        .min(MAX_DELAY_MS)
}
