use morphz_coding_eval::parse_retry_after;

#[test]
fn parses_plain_seconds() {
    assert_eq!(parse_retry_after("120"), Some(120));
}

#[test]
fn accepts_surrounding_http_whitespace() {
    assert_eq!(parse_retry_after("  120\t"), Some(120));
}

#[test]
fn rejects_empty_or_negative_values() {
    assert_eq!(parse_retry_after("   "), None);
    assert_eq!(parse_retry_after("-1"), None);
}
