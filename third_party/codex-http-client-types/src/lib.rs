//! Exact reqwest type aliases consumed by the pinned Windows protocol.
//! No HTTP client, request compressor, proxy or telemetry implementation.

pub type HttpError = reqwest::Error;
pub type HttpResponse = reqwest::Response;
