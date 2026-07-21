use std::process::{Command, ExitCode};

fn main() -> ExitCode {
    let status = Command::new("python3")
        .arg("forgedepot.py")
        .args(std::env::args_os().skip(1))
        .status();
    match status {
        Ok(status) => ExitCode::from(status.code().unwrap_or(1) as u8),
        Err(error) => {
            eprintln!("failed to start reference implementation: {error}");
            ExitCode::FAILURE
        }
    }
}
