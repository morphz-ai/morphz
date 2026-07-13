/// Parse an HTTP Retry-After value expressed as a non-negative number of seconds.
pub fn parse_retry_after(value: &str) -> Option<u64> {
    if value.is_empty() {
        return None;
    }
    value.parse().ok()
}
