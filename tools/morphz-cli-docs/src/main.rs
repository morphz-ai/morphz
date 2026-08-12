use std::path::PathBuf;

// The generator consumes only the product CLI boundary. It deliberately does
// not depend on the Morphz Runtime crate, so refreshing documentation never
// compiles or links the scheduler, provider stack, storage engines or executor.
#[allow(dead_code)]
#[path = "../../../morphz/src/cli.rs"]
mod cli;
#[allow(dead_code)]
#[path = "../../../morphz/src/i18n.rs"]
mod i18n;
mod render;

mod build_info {
    pub const VERSION: &str = env!("CARGO_PKG_VERSION");
}

use render::write_cli_reference_files;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let content_root = std::env::args_os()
        .nth(1)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("website/content/docs"));
    write_cli_reference_files(&content_root)?;
    println!(
        "Generated bilingual CLI reference under {}",
        content_root.display()
    );
    Ok(())
}
