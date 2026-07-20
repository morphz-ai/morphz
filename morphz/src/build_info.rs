/// Cargo package version combined with the source revision embedded at build time.
pub const VERSION: &str = concat!(
    env!("CARGO_PKG_VERSION"),
    " (git ",
    env!("MORPHZ_GIT_COMMIT"),
    ")"
);

/// Source revision embedded at build time.
pub const GIT_COMMIT: &str = env!("MORPHZ_GIT_COMMIT");
