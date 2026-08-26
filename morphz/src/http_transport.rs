//! Shared outbound HTTP proxy policy.
//!
//! System proxy discovery is the default. Operators may bypass it globally or
//! for one traffic class without forcing unrelated Provider and Mesh requests
//! onto the same route.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpProxyMode {
    System,
    Direct,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HttpProxyScope {
    Provider,
    OAuth,
    Coordination,
}

pub const GLOBAL_PROXY_MODE_ENV: &str = "MORPHZ_HTTP_PROXY_MODE";
pub const PROVIDER_PROXY_MODE_ENV: &str = "MORPHZ_PROVIDER_PROXY_MODE";
pub const OAUTH_PROXY_MODE_ENV: &str = "MORPHZ_OAUTH_PROXY_MODE";
pub const COORDINATION_PROXY_MODE_ENV: &str = "MORPHZ_COORDINATION_PROXY_MODE";

impl HttpProxyScope {
    fn override_envs(self) -> &'static [&'static str] {
        match self {
            Self::Provider => &[PROVIDER_PROXY_MODE_ENV],
            Self::OAuth => &[OAUTH_PROXY_MODE_ENV, PROVIDER_PROXY_MODE_ENV],
            Self::Coordination => &[COORDINATION_PROXY_MODE_ENV],
        }
    }

    fn label(self) -> &'static str {
        match self {
            Self::Provider => "Provider",
            Self::OAuth => "OAuth",
            Self::Coordination => "Cognitive Coordination",
        }
    }

    fn primary_override_env(self) -> &'static str {
        self.override_envs()[0]
    }
}

fn parse_proxy_mode(value: &str) -> Option<HttpProxyMode> {
    match value.trim().to_ascii_lowercase().as_str() {
        "system" => Some(HttpProxyMode::System),
        "direct" => Some(HttpProxyMode::Direct),
        _ => None,
    }
}

pub fn configured_proxy_mode(scope: HttpProxyScope) -> HttpProxyMode {
    for variable in scope
        .override_envs()
        .iter()
        .copied()
        .chain(std::iter::once(GLOBAL_PROXY_MODE_ENV))
    {
        let Some(value) = std::env::var_os(variable) else {
            continue;
        };
        let value = value.to_string_lossy();
        if let Some(mode) = parse_proxy_mode(&value) {
            return mode;
        }
        tracing::warn!(
            variable,
            value = %value,
            scope = scope.label(),
            event_code = "runtime.http_proxy_mode_invalid",
            "Ignoring an invalid HTTP proxy mode; expected 'system' or 'direct'"
        );
    }
    HttpProxyMode::System
}

pub fn client_builder(scope: HttpProxyScope) -> reqwest::ClientBuilder {
    let builder = reqwest::Client::builder();
    match configured_proxy_mode(scope) {
        HttpProxyMode::System => builder,
        HttpProxyMode::Direct => builder.no_proxy(),
    }
}

pub fn proxy_failure_hint(scope: HttpProxyScope, endpoint: &str) -> Option<String> {
    (configured_proxy_mode(scope) == HttpProxyMode::System).then(|| {
        format!(
            "{} uses the system proxy; if '{endpoint}' must be reached directly, add its host (or '.local') to NO_PROXY, or set {}=direct",
            scope.label(),
            scope.primary_override_env(),
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proxy_mode_parser_accepts_only_explicit_routes() {
        assert_eq!(parse_proxy_mode("system"), Some(HttpProxyMode::System));
        assert_eq!(parse_proxy_mode(" DIRECT "), Some(HttpProxyMode::Direct));
        assert_eq!(parse_proxy_mode("off"), None);
        assert_eq!(parse_proxy_mode(""), None);
    }
}
