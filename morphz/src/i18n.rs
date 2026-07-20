use serde::{Deserialize, Serialize};
use std::ffi::OsString;

/// Persisted UI language preference. `Auto` follows the host locale each time
/// Morphz starts, while explicit values keep every product surface stable.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
pub enum UiLanguage {
    #[default]
    #[serde(rename = "auto")]
    Auto,
    #[serde(rename = "en")]
    English,
    #[serde(rename = "zh-CN")]
    SimplifiedChinese,
}

impl UiLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::English => "en",
            Self::SimplifiedChinese => "zh-CN",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().replace('_', "-").to_ascii_lowercase().as_str() {
            "auto" | "system" => Some(Self::Auto),
            "en" | "en-us" | "en-gb" | "english" => Some(Self::English),
            "zh" | "zh-cn" | "zh-hans" | "chinese" | "simplified-chinese" => {
                Some(Self::SimplifiedChinese)
            }
            _ => None,
        }
    }

    pub fn resolve(self) -> Locale {
        match self {
            Self::Auto => Locale::detect(),
            Self::English => Locale::English,
            Self::SimplifiedChinese => Locale::SimplifiedChinese,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Locale {
    English,
    SimplifiedChinese,
}

impl Locale {
    pub fn detect() -> Self {
        std::env::var("MORPHZ_LANGUAGE")
            .ok()
            .as_deref()
            .and_then(UiLanguage::parse)
            .and_then(|language| match language {
                UiLanguage::Auto => None,
                explicit => Some(explicit.resolve_explicit()),
            })
            .or_else(|| {
                ["LC_ALL", "LC_MESSAGES", "LANGUAGE", "LANG"]
                    .into_iter()
                    .filter_map(|name| std::env::var(name).ok())
                    .find_map(|value| Self::parse_system_locale(&value))
            })
            .unwrap_or(Self::English)
    }

    fn parse_system_locale(value: &str) -> Option<Self> {
        let normalized = value.trim().replace('_', "-").to_ascii_lowercase();
        if normalized.is_empty() || normalized == "c" || normalized == "posix" {
            None
        } else if normalized.starts_with("zh") {
            Some(Self::SimplifiedChinese)
        } else {
            Some(Self::English)
        }
    }

    pub const fn text(self, english: &'static str, chinese: &'static str) -> &'static str {
        match self {
            Self::English => english,
            Self::SimplifiedChinese => chinese,
        }
    }

    pub const fn is_chinese(self) -> bool {
        matches!(self, Self::SimplifiedChinese)
    }
}

impl UiLanguage {
    fn resolve_explicit(self) -> Locale {
        match self {
            Self::English => Locale::English,
            Self::SimplifiedChinese => Locale::SimplifiedChinese,
            Self::Auto => Locale::English,
        }
    }
}

/// Reads the language override before Clap renders help or parse errors.
pub fn locale_from_cli_args(args: &[OsString]) -> Option<Locale> {
    let mut values = args.iter().filter_map(|value| value.to_str()).peekable();
    while let Some(value) = values.next() {
        let language = if let Some(value) = value
            .strip_prefix("--language=")
            .or_else(|| value.strip_prefix("--lang="))
        {
            Some(value)
        } else if matches!(value, "--language" | "--lang") {
            values.next()
        } else {
            None
        };
        if let Some(language) = language {
            return UiLanguage::parse(language).map(UiLanguage::resolve);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_language_names_are_strict_and_stable() {
        assert_eq!(UiLanguage::parse("auto"), Some(UiLanguage::Auto));
        assert_eq!(UiLanguage::parse("en-US"), Some(UiLanguage::English));
        assert_eq!(
            UiLanguage::parse("zh_CN"),
            Some(UiLanguage::SimplifiedChinese)
        );
        assert_eq!(UiLanguage::parse("fr"), None);
    }

    #[test]
    fn cli_language_is_available_before_normal_argument_parsing() {
        assert_eq!(
            locale_from_cli_args(&[OsString::from("--language=zh-CN")]),
            Some(Locale::SimplifiedChinese)
        );
        assert_eq!(
            locale_from_cli_args(&[
                OsString::from("--lang"),
                OsString::from("en"),
                OsString::from("setup"),
            ]),
            Some(Locale::English)
        );
    }

    #[test]
    fn locale_never_mixes_catalog_sides() {
        assert_eq!(Locale::English.text("Tasks", "任务"), "Tasks");
        assert_eq!(Locale::SimplifiedChinese.text("Tasks", "任务"), "任务");
    }
}
