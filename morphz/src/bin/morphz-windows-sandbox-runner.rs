#[cfg(windows)]
#[tokio::main]
async fn main() {
    let code = match morphz::sandbox::run_windows_sandbox_helper().await {
        Ok(code) => code,
        Err(error) => {
            eprintln!("Morphz Windows sandbox failed: {error}");
            1
        }
    };
    std::process::exit(code);
}

#[cfg(not(windows))]
fn main() {
    eprintln!("morphz-windows-sandbox-runner is available only on Windows");
    std::process::exit(1);
}
