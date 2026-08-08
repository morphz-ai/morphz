use chrono::{DateTime, FixedOffset, Local, SecondsFormat, Utc};

/// One coherent view of the host's civil clock for a model request.
///
/// Runtime persistence and ordering remain UTC. This value is only used at
/// human/model presentation boundaries, where a bare UTC timestamp is easy to
/// misread as the user's civil time.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalTimeSnapshot {
    pub current: DateTime<FixedOffset>,
    pub time_zone: String,
}

impl LocalTimeSnapshot {
    pub fn capture() -> Self {
        Self {
            current: Local::now().fixed_offset(),
            time_zone: system_time_zone(),
        }
    }

    pub fn current_rfc3339(&self) -> String {
        self.current.to_rfc3339_opts(SecondsFormat::Secs, false)
    }

    pub fn utc_offset(&self) -> String {
        self.current.format("%:z").to_string()
    }
}

pub fn system_time_zone() -> String {
    iana_time_zone::get_timezone().unwrap_or_else(|_| {
        let abbreviation = Local::now().format("%Z").to_string();
        if abbreviation.trim().is_empty() {
            "local".to_string()
        } else {
            abbreviation
        }
    })
}

pub fn format_utc_for_local(value: DateTime<Utc>) -> String {
    value
        .with_timezone(&Local)
        .to_rfc3339_opts(SecondsFormat::Millis, false)
}

pub fn format_rfc3339_for_local(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|parsed| {
            parsed
                .with_timezone(&Local)
                .to_rfc3339_opts(SecondsFormat::Millis, false)
        })
        .unwrap_or_else(|_| value.to_string())
}

/// Convert timestamp-valued fields in a Runtime-owned JSON receipt before it
/// is shown to a model. Arbitrary command/file output is deliberately not
/// passed through this function: source evidence must remain byte-for-byte
/// faithful even when it contains a timestamp in another time zone.
pub fn localize_runtime_json_timestamps(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::Object(fields) => {
            for (key, value) in fields {
                if timestamp_field(key) {
                    if let Some(timestamp) = value.as_str() {
                        *value = serde_json::Value::String(format_rfc3339_for_local(timestamp));
                        continue;
                    }
                }
                localize_runtime_json_timestamps(value);
            }
        }
        serde_json::Value::Array(values) => {
            for value in values {
                localize_runtime_json_timestamps(value);
            }
        }
        _ => {}
    }
}

/// Localize a Runtime-owned receipt without changing the canonical value kept
/// in persistence or sent over an API boundary.
pub fn localized_runtime_json(mut value: serde_json::Value) -> serde_json::Value {
    localize_runtime_json_timestamps(&mut value);
    value
}

fn timestamp_field(key: &str) -> bool {
    matches!(
        key,
        "timestamp"
            | "deadline"
            | "not_before"
            | "not-before"
            | "start_time"
            | "end_time"
            | "check_at"
            | "wakeup_at"
            | "next_wakeup_at"
    ) || key.ends_with("_at")
        || key.ends_with("-at")
        || key.ends_with("At")
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    #[test]
    fn snapshot_uses_an_explicit_offset_instead_of_a_bare_utc_marker() {
        let snapshot = LocalTimeSnapshot::capture();
        assert!(snapshot.current_rfc3339().ends_with(&snapshot.utc_offset()));
        assert!(!snapshot.current_rfc3339().ends_with('Z'));
        assert!(!snapshot.time_zone.trim().is_empty());
    }

    #[test]
    fn runtime_json_localization_only_changes_timestamp_fields() {
        let mut receipt = serde_json::json!({
            "status": "ok",
            "updated_at": "2026-08-08T00:00:00Z",
            "nested": { "deadline": "2026-08-08T01:00:00Z" },
            "evidence": "2026-08-08T02:00:00Z"
        });
        localize_runtime_json_timestamps(&mut receipt);

        assert_ne!(receipt["updated_at"], "2026-08-08T00:00:00Z");
        assert_ne!(receipt["nested"]["deadline"], "2026-08-08T01:00:00Z");
        assert_eq!(receipt["evidence"], "2026-08-08T02:00:00Z");
    }

    #[test]
    fn fixed_offset_format_documents_the_expected_civil_time_conversion() {
        let utc = Utc.with_ymd_and_hms(2026, 8, 8, 0, 15, 0).single().unwrap();
        let shanghai = FixedOffset::east_opt(8 * 60 * 60).unwrap();
        assert_eq!(
            utc.with_timezone(&shanghai)
                .to_rfc3339_opts(SecondsFormat::Secs, false),
            "2026-08-08T08:15:00+08:00"
        );
    }
}
