//! Deliberately inert compatibility surface for `codex-windows-sandbox`.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::error::Error;
use std::path::PathBuf;

#[derive(Clone, Debug)]
pub struct OtelSettings {
    pub environment: String,
    pub service_name: String,
    pub service_version: String,
    pub codex_home: PathBuf,
    pub exporter: OtelExporter,
    pub trace_exporter: OtelExporter,
    pub metrics_exporter: OtelExporter,
    pub runtime_metrics: bool,
    pub span_attributes: BTreeMap<String, String>,
    pub tracestate: BTreeMap<String, BTreeMap<String, String>>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct StatsigMetricsSettings {
    pub environment: String,
}

#[derive(Clone, Debug)]
pub enum OtelExporter {
    None,
    Statsig,
}

pub struct MetricsClient;

impl MetricsClient {
    pub fn counter(
        &self,
        _name: &str,
        _increment: u64,
        _tags: &[(&str, &str)],
    ) -> Result<(), Box<dyn Error>> {
        Ok(())
    }
}

pub struct OtelProvider;

impl OtelProvider {
    pub fn try_new(_settings: &OtelSettings) -> Result<Option<Self>, Box<dyn Error>> {
        Ok(None)
    }

    pub fn metrics(&self) -> Option<&MetricsClient> {
        None
    }

    pub fn shutdown(&self) {}
}

pub fn global_statsig_metrics_settings() -> Option<StatsigMetricsSettings> {
    None
}
