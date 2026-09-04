//! Verified, explicit self-updates for the Morphz CLI.
//!
//! Update commands run before Runtime/configuration initialization. The updater
//! treats the GitHub Release archive and its adjacent SHA-256 file as one
//! immutable input, validates the staged binary, then replaces the installed
//! executable in the same filesystem. Windows delegates the final rename to a
//! short-lived PowerShell helper because a running `.exe` cannot replace itself.

use crate::cli::Invocation;
use crate::i18n::Locale;
use fd_lock::RwLock;
use futures_util::StreamExt;
use reqwest::header::{ACCEPT, USER_AGENT};
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
#[cfg(any(test, windows))]
use tempfile::TempDir;
use tokio::io::AsyncWriteExt;

type UpdateError = Box<dyn std::error::Error + Send + Sync>;
type Result<T> = std::result::Result<T, UpdateError>;

const DEFAULT_REPOSITORY: &str = "morphz-ai/morphz";
const GITHUB_API: &str = "https://api.github.com";
const RECEIPT_FILE: &str = ".morphz-update.json";
const LOCK_FILE: &str = ".morphz-update.lock";
#[cfg(windows)]
const PENDING_FILE: &str = ".morphz-update.pending";
const MAX_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_CHECKSUM_BYTES: u64 = 64 * 1024;

#[derive(Debug, Clone, Deserialize)]
struct GitHubRelease {
    tag_name: String,
    assets: Vec<GitHubAsset>,
}

#[derive(Debug, Clone, Deserialize)]
struct GitHubAsset {
    name: String,
    url: String,
    browser_download_url: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArchiveKind {
    TarGz,
    #[cfg_attr(not(windows), allow(dead_code))]
    Zip,
}

#[derive(Debug, Clone, Copy)]
struct Bundle {
    asset_name: &'static str,
    archive_kind: ArchiveKind,
    entries: &'static [&'static str],
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UpdateReceipt {
    schema_version: u32,
    installed_version: String,
    previous_version: String,
    release_tag: String,
    archive_sha256: String,
    components: Vec<ComponentReceipt>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ComponentReceipt {
    current: String,
    backup: String,
    existed_before: bool,
}

#[derive(Debug, Clone)]
struct Replacement {
    source: PathBuf,
    current: PathBuf,
    backup: PathBuf,
    existed_before: bool,
}

/// Handles `morphz update ...` before the Runtime is initialized.
pub async fn handle(invocation: &Invocation, locale: Locale) -> Result<bool> {
    let command = invocation.command_path();
    if !command.first().is_some_and(|part| part == "update") {
        return Ok(false);
    }

    match command {
        [update] if update == "update" => {
            install_release(
                invocation
                    .option("update-version")
                    .and_then(|option| option.last_value()),
                invocation.has_option("allow-downgrade"),
                locale,
            )
            .await?;
        }
        [update, action] if update == "update" && action == "status" => {
            if invocation.has_option("update-version") || invocation.has_option("allow-downgrade") {
                return Err(message(locale.text(
                    "--to and --allow-downgrade apply to `morphz update`, not `morphz update status`",
                    "--to 和 --allow-downgrade 只适用于 `morphz update`，不适用于 `morphz update status`",
                )));
            }
            print_status(locale).await?;
        }
        [update, action] if update == "update" && action == "rollback" => {
            if invocation.has_option("update-version") || invocation.has_option("allow-downgrade") {
                return Err(message(locale.text(
                    "--to and --allow-downgrade cannot be used with rollback",
                    "rollback 不能与 --to 或 --allow-downgrade 同时使用",
                )));
            }
            rollback(locale)?;
        }
        _ => unreachable!("Clap accepts only declared update commands"),
    }
    Ok(true)
}

async fn print_status(locale: Locale) -> Result<()> {
    let current = current_version()?;
    let release = fetch_release(None).await?;
    let latest = release_version(&release)?;

    if locale.is_chinese() {
        println!("当前版本：{current}");
        println!("最新版本：{latest}");
        match latest.cmp(&current) {
            std::cmp::Ordering::Greater => println!("有新版本可用。运行 `morphz update` 安装。"),
            std::cmp::Ordering::Equal => println!("当前已经是最新版本。"),
            std::cmp::Ordering::Less => println!("当前版本比最新公开发行版更新。"),
        }
    } else {
        println!("Current version: {current}");
        println!("Latest version: {latest}");
        match latest.cmp(&current) {
            std::cmp::Ordering::Greater => {
                println!("An update is available. Run `morphz update` to install it.")
            }
            std::cmp::Ordering::Equal => println!("Morphz is up to date."),
            std::cmp::Ordering::Less => {
                println!("This build is newer than the latest public release.")
            }
        }
    }
    Ok(())
}

async fn install_release(
    requested_version: Option<&str>,
    allow_downgrade: bool,
    locale: Locale,
) -> Result<()> {
    let requested = requested_version.map(parse_requested_version).transpose()?;
    let current = current_version()?;
    let executable = std::env::current_exe()?;
    let install_dir = executable
        .parent()
        .ok_or_else(|| message("the current Morphz executable has no parent directory"))?;
    ensure_no_pending_update(install_dir)?;
    let lock_file = update_lock_file(install_dir)?;
    let mut update_lock = RwLock::new(lock_file);
    let _guard = update_lock.try_write().map_err(|error| {
        if error.kind() == io::ErrorKind::WouldBlock {
            message(locale.text(
                "another Morphz update is already running",
                "另一个 Morphz 更新正在运行",
            ))
        } else {
            error.into()
        }
    })?;

    let release = fetch_release(requested.as_ref()).await?;
    let target = release_version(&release)?;
    if let Some(requested) = requested.as_ref() {
        if &target != requested {
            return Err(message(format!(
                "GitHub returned release {} for requested version {requested}",
                release.tag_name
            )));
        }
    }
    match target.cmp(&current) {
        std::cmp::Ordering::Equal => {
            if locale.is_chinese() {
                println!("Morphz {current} 已安装，无需更新。");
            } else {
                println!("Morphz {current} is already installed; no update is needed.");
            }
            return Ok(());
        }
        std::cmp::Ordering::Less if !allow_downgrade => {
            return Err(message(if locale.is_chinese() {
                format!(
                    "目标版本 {target} 早于当前版本 {current}；若确实要降级，请同时传入 --allow-downgrade"
                )
            } else {
                format!(
                    "target version {target} is older than current version {current}; pass --allow-downgrade to confirm"
                )
            }));
        }
        _ => {}
    }

    let bundle = current_bundle()?;
    let archive_asset = release_asset(&release, bundle.asset_name)?;
    let checksum_name = format!("{}.sha256", bundle.asset_name);
    let checksum_asset = release_asset(&release, &checksum_name)?;
    let stage = tempfile::Builder::new()
        .prefix(".morphz-update-")
        .tempdir_in(install_dir)
        .map_err(|error| {
            message(if locale.is_chinese() {
                format!("无法在 {} 创建更新暂存目录：{error}", install_dir.display())
            } else {
                format!(
                    "cannot create an update staging directory in {}: {error}",
                    install_dir.display()
                )
            })
        })?;
    let archive_path = stage.path().join(bundle.asset_name);
    let client = github_client()?;
    let token = github_token();

    if locale.is_chinese() {
        println!("正在下载 Morphz {target}…");
    } else {
        println!("Downloading Morphz {target}…");
    }
    let expected_checksum = download_checksum(&client, checksum_asset, token.as_deref()).await?;
    let actual_checksum =
        download_archive(&client, archive_asset, token.as_deref(), &archive_path).await?;
    if actual_checksum != expected_checksum {
        return Err(message(if locale.is_chinese() {
            format!("下载归档的 SHA-256 校验失败：期望 {expected_checksum}，实际 {actual_checksum}")
        } else {
            format!(
                "downloaded archive failed SHA-256 verification: expected {expected_checksum}, got {actual_checksum}"
            )
        }));
    }

    let unpacked = stage.path().join("unpacked");
    fs::create_dir(&unpacked)?;
    extract_bundle(&archive_path, &unpacked, bundle)?;
    validate_staged_binary(&unpacked.join(binary_name("morphz")), &target)?;

    let replacements = replacements_for_bundle(bundle, &unpacked, &executable, install_dir)?;
    let receipt = UpdateReceipt {
        schema_version: 1,
        installed_version: target.to_string(),
        previous_version: current.to_string(),
        release_tag: release.tag_name,
        archive_sha256: actual_checksum,
        components: replacements
            .iter()
            .map(|replacement| {
                Ok(ComponentReceipt {
                    current: file_name_string(&replacement.current)?,
                    backup: file_name_string(&replacement.backup)?,
                    existed_before: replacement.existed_before,
                })
            })
            .collect::<Result<Vec<_>>>()?,
    };

    #[cfg(unix)]
    apply_unix_update(&replacements, &receipt, stage.path(), install_dir)?;
    #[cfg(windows)]
    schedule_windows_update(replacements, receipt, stage, install_dir)?;

    if locale.is_chinese() {
        #[cfg(unix)]
        println!("Morphz 已从 {current} 更新到 {target}。可用 `morphz update rollback` 回滚。");
        #[cfg(windows)]
        println!("Morphz {target} 已下载并校验；当前进程退出后将完成替换。");
    } else {
        #[cfg(unix)]
        println!(
            "Morphz was updated from {current} to {target}. Use `morphz update rollback` to roll back."
        );
        #[cfg(windows)]
        println!(
            "Morphz {target} is downloaded and verified; replacement will finish after this process exits."
        );
    }
    Ok(())
}

fn rollback(locale: Locale) -> Result<()> {
    let executable = std::env::current_exe()?;
    let install_dir = executable
        .parent()
        .ok_or_else(|| message("the current Morphz executable has no parent directory"))?;
    ensure_no_pending_update(install_dir)?;
    let lock_file = update_lock_file(install_dir)?;
    let mut update_lock = RwLock::new(lock_file);
    let _guard = update_lock.try_write().map_err(|error| {
        if error.kind() == io::ErrorKind::WouldBlock {
            message(locale.text(
                "another Morphz update is already running",
                "另一个 Morphz 更新正在运行",
            ))
        } else {
            error.into()
        }
    })?;
    let receipt_path = install_dir.join(RECEIPT_FILE);
    let receipt: UpdateReceipt =
        serde_json::from_slice(&fs::read(&receipt_path).map_err(|error| {
            message(if locale.is_chinese() {
                format!("没有可回滚的 Morphz 更新：{error}")
            } else {
                format!("no Morphz update is available to roll back: {error}")
            })
        })?)?;
    validate_receipt(&receipt)?;
    let running = current_version()?;
    if running.to_string() != receipt.installed_version {
        return Err(message(if locale.is_chinese() {
            format!(
                "当前二进制版本 {running} 与更新记录中的 {} 不一致；为避免覆盖手工安装，已拒绝回滚",
                receipt.installed_version
            )
        } else {
            format!(
                "the running binary is {running}, but the update receipt records {}; refusing to overwrite a manual installation",
                receipt.installed_version
            )
        }));
    }

    #[cfg(unix)]
    rollback_unix(&receipt, install_dir)?;
    #[cfg(windows)]
    schedule_windows_rollback(receipt.clone(), install_dir)?;

    if locale.is_chinese() {
        #[cfg(unix)]
        println!("Morphz 已回滚到 {}。", receipt.previous_version);
        #[cfg(windows)]
        println!(
            "Morphz {} 的回滚已准备好；当前进程退出后将完成替换。",
            receipt.previous_version
        );
    } else {
        #[cfg(unix)]
        println!("Morphz was rolled back to {}.", receipt.previous_version);
        #[cfg(windows)]
        println!(
            "Rollback to Morphz {} is ready and will finish after this process exits.",
            receipt.previous_version
        );
    }
    Ok(())
}

fn current_version() -> Result<Version> {
    Version::parse(env!("CARGO_PKG_VERSION")).map_err(Into::into)
}

fn parse_requested_version(raw: &str) -> Result<Version> {
    let normalized = raw.trim().strip_prefix('v').unwrap_or(raw.trim());
    Version::parse(normalized)
        .map_err(|error| message(format!("invalid Morphz version '{raw}': {error}")))
}

fn release_version(release: &GitHubRelease) -> Result<Version> {
    parse_requested_version(&release.tag_name)
}

fn repository() -> Result<String> {
    let value = std::env::var("MORPHZ_GITHUB_REPOSITORY")
        .unwrap_or_else(|_| DEFAULT_REPOSITORY.to_string());
    let mut parts = value.split('/');
    let valid_part = |part: &str| {
        !part.is_empty()
            && part
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    };
    match (parts.next(), parts.next(), parts.next()) {
        (Some(owner), Some(repo), None) if valid_part(owner) && valid_part(repo) => Ok(value),
        _ => Err(message(format!(
            "invalid MORPHZ_GITHUB_REPOSITORY '{value}'; expected owner/repository"
        ))),
    }
}

fn github_client() -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::limited(10))
        .build()
        .map_err(Into::into)
}

fn github_token() -> Option<String> {
    ["GH_TOKEN", "GITHUB_TOKEN"].into_iter().find_map(|name| {
        std::env::var(name)
            .ok()
            .filter(|value| !value.trim().is_empty())
    })
}

async fn fetch_release(version: Option<&Version>) -> Result<GitHubRelease> {
    let repository = repository()?;
    let endpoint = if let Some(version) = version {
        format!("{GITHUB_API}/repos/{repository}/releases/tags/v{version}")
    } else {
        format!("{GITHUB_API}/repos/{repository}/releases/latest")
    };
    let client = github_client()?;
    let mut request = client
        .get(endpoint)
        .header(USER_AGENT, format!("morphz/{}", env!("CARGO_PKG_VERSION")))
        .header(ACCEPT, "application/vnd.github+json");
    if let Some(token) = github_token() {
        request = request.bearer_auth(token);
    }
    let response = request.send().await?;
    let status = response.status();
    if !status.is_success() {
        let detail = response.text().await.unwrap_or_default();
        let hint = if status == reqwest::StatusCode::NOT_FOUND {
            " The release may not exist yet; for a private repository, set GH_TOKEN or GITHUB_TOKEN."
        } else {
            ""
        };
        return Err(message(format!(
            "GitHub Release request failed with {status}: {}.{hint}",
            detail.trim().chars().take(300).collect::<String>()
        )));
    }
    response.json().await.map_err(Into::into)
}

fn release_asset<'a>(release: &'a GitHubRelease, name: &str) -> Result<&'a GitHubAsset> {
    release
        .assets
        .iter()
        .find(|asset| asset.name == name)
        .ok_or_else(|| {
            message(format!(
                "GitHub Release {} does not contain required asset {name}",
                release.tag_name
            ))
        })
}

fn asset_request(
    client: &reqwest::Client,
    asset: &GitHubAsset,
    token: Option<&str>,
) -> Result<reqwest::RequestBuilder> {
    let (url, api_download) = if token.is_some() {
        (&asset.url, true)
    } else {
        (&asset.browser_download_url, false)
    };
    let parsed = reqwest::Url::parse(url)?;
    if parsed.scheme() != "https" {
        return Err(message(format!("release asset URL must use HTTPS: {url}")));
    }
    let mut request = client
        .get(parsed)
        .header(USER_AGENT, format!("morphz/{}", env!("CARGO_PKG_VERSION")));
    if api_download {
        request = request.header(ACCEPT, "application/octet-stream");
    }
    if let Some(token) = token {
        request = request.bearer_auth(token);
    }
    Ok(request)
}

async fn checked_asset_response(
    client: &reqwest::Client,
    asset: &GitHubAsset,
    token: Option<&str>,
    max_bytes: u64,
) -> Result<reqwest::Response> {
    let response = asset_request(client, asset, token)?.send().await?;
    let status = response.status();
    if !status.is_success() {
        return Err(message(format!(
            "download of {} failed with {status}",
            asset.name
        )));
    }
    if response
        .content_length()
        .is_some_and(|length| length > max_bytes)
    {
        return Err(message(format!(
            "release asset {} exceeds the {} byte safety limit",
            asset.name, max_bytes
        )));
    }
    Ok(response)
}

async fn download_checksum(
    client: &reqwest::Client,
    asset: &GitHubAsset,
    token: Option<&str>,
) -> Result<String> {
    let response = checked_asset_response(client, asset, token, MAX_CHECKSUM_BYTES).await?;
    let bytes = response.bytes().await?;
    if bytes.len() as u64 > MAX_CHECKSUM_BYTES {
        return Err(message("release checksum response is unexpectedly large"));
    }
    let text = std::str::from_utf8(&bytes)?;
    parse_checksum(text)
}

async fn download_archive(
    client: &reqwest::Client,
    asset: &GitHubAsset,
    token: Option<&str>,
    destination: &Path,
) -> Result<String> {
    let response = checked_asset_response(client, asset, token, MAX_ARCHIVE_BYTES).await?;
    let mut stream = response.bytes_stream();
    let mut file = tokio::fs::File::create(destination).await?;
    let mut hasher = Sha256::new();
    let mut received = 0_u64;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        received = received
            .checked_add(chunk.len() as u64)
            .ok_or_else(|| message("release archive length overflow"))?;
        if received > MAX_ARCHIVE_BYTES {
            return Err(message("release archive exceeds the 1 GiB safety limit"));
        }
        hasher.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    file.sync_all().await?;
    Ok(format!("{:x}", hasher.finalize()))
}

fn parse_checksum(value: &str) -> Result<String> {
    let checksum = value
        .split_whitespace()
        .next()
        .ok_or_else(|| message("release checksum file is empty"))?
        .to_ascii_lowercase();
    if checksum.len() != 64 || !checksum.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(message("release checksum is not a valid SHA-256 digest"));
    }
    Ok(checksum)
}

fn current_bundle() -> Result<Bundle> {
    platform_bundle(std::env::consts::OS, std::env::consts::ARCH).ok_or_else(|| {
        message(format!(
            "Morphz self-update is not published for {}/{}",
            std::env::consts::OS,
            std::env::consts::ARCH
        ))
    })
}

fn platform_bundle(os: &str, arch: &str) -> Option<Bundle> {
    match (os, arch) {
        ("macos", "aarch64") => Some(Bundle {
            asset_name: "morphz-macos-aarch64.tar.gz",
            archive_kind: ArchiveKind::TarGz,
            entries: &["morphz"],
        }),
        ("macos", "x86_64") => Some(Bundle {
            asset_name: "morphz-macos-x86_64.tar.gz",
            archive_kind: ArchiveKind::TarGz,
            entries: &["morphz"],
        }),
        ("linux", "x86_64") => Some(Bundle {
            asset_name: "morphz-linux-x86_64.tar.gz",
            archive_kind: ArchiveKind::TarGz,
            entries: &["morphz"],
        }),
        ("linux", "aarch64") => Some(Bundle {
            asset_name: "morphz-linux-aarch64.tar.gz",
            archive_kind: ArchiveKind::TarGz,
            entries: &["morphz"],
        }),
        ("windows", "x86_64") => Some(Bundle {
            asset_name: "morphz-windows-x86_64.zip",
            archive_kind: ArchiveKind::Zip,
            entries: &[
                "morphz.exe",
                "morphz-windows-sandbox-runner.exe",
                "morphz-windows-command-runner.exe",
                "morphz-windows-sandbox-setup.exe",
            ],
        }),
        _ => None,
    }
}

fn extract_bundle(archive: &Path, destination: &Path, bundle: Bundle) -> Result<()> {
    match bundle.archive_kind {
        ArchiveKind::TarGz => extract_tar_gz(archive, destination, bundle.entries),
        ArchiveKind::Zip => extract_zip(archive, destination, bundle.entries),
    }
}

fn extract_tar_gz(archive: &Path, destination: &Path, expected: &[&str]) -> Result<()> {
    let decoder = flate2::read::GzDecoder::new(File::open(archive)?);
    let mut archive = tar::Archive::new(decoder);
    let mut found = vec![false; expected.len()];
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.into_owned();
        let Some(name) = safe_top_level_name(&path) else {
            continue;
        };
        let Some(index) = expected.iter().position(|expected| *expected == name) else {
            continue;
        };
        if found[index] {
            return Err(message(format!(
                "release archive contains duplicate entry {name}"
            )));
        }
        if !entry.header().entry_type().is_file() {
            return Err(message(format!(
                "release archive entry {name} is not a regular file"
            )));
        }
        let output = destination.join(name);
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&output)?;
        io::copy(&mut entry, &mut file)?;
        file.sync_all()?;
        set_executable(&output)?;
        found[index] = true;
    }
    require_bundle_entries(expected, &found)
}

#[cfg(windows)]
fn extract_zip(archive: &Path, destination: &Path, expected: &[&str]) -> Result<()> {
    let status = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force",
        ])
        .arg(archive)
        .arg(destination)
        .status()?;
    if !status.success() {
        return Err(message(format!(
            "PowerShell could not extract {}",
            archive.display()
        )));
    }
    for name in expected {
        if !destination.join(name).is_file() {
            return Err(message(format!(
                "release archive does not contain required entry {name}"
            )));
        }
    }
    Ok(())
}

#[cfg(not(windows))]
fn extract_zip(_archive: &Path, _destination: &Path, _expected: &[&str]) -> Result<()> {
    Err(message("ZIP extraction is available only on Windows"))
}

fn safe_top_level_name(path: &Path) -> Option<&str> {
    let mut name = None;
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::Normal(value) if name.is_none() => name = value.to_str(),
            _ => return None,
        }
    }
    name
}

fn require_bundle_entries(expected: &[&str], found: &[bool]) -> Result<()> {
    if let Some((name, _)) = expected.iter().zip(found).find(|(_, found)| !**found) {
        Err(message(format!(
            "release archive does not contain required entry {name}"
        )))
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn set_executable(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o755))?;
    Ok(())
}

#[cfg(windows)]
fn set_executable(_path: &Path) -> Result<()> {
    Ok(())
}

fn validate_staged_binary(binary: &Path, expected: &Version) -> Result<()> {
    let output = Command::new(binary)
        .arg("version")
        .output()
        .map_err(|error| {
            message(format!(
                "could not start staged Morphz binary {}: {error}",
                binary.display()
            ))
        })?;
    if !output.status.success() {
        return Err(message(format!(
            "staged Morphz binary failed its version check with {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    let stdout = String::from_utf8(output.stdout)?;
    let actual = stdout.split_whitespace().nth(1).ok_or_else(|| {
        message(format!(
            "staged Morphz binary returned an invalid version line: {}",
            stdout.trim()
        ))
    })?;
    if actual != expected.to_string() {
        return Err(message(format!(
            "staged Morphz binary reports version {actual}, expected {expected}"
        )));
    }
    Ok(())
}

fn replacements_for_bundle(
    bundle: Bundle,
    unpacked: &Path,
    executable: &Path,
    install_dir: &Path,
) -> Result<Vec<Replacement>> {
    let executable_name = executable
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| message("the current Morphz executable has an invalid file name"))?;
    bundle
        .entries
        .iter()
        .map(|entry| {
            let install_name = if *entry == binary_name("morphz") {
                executable_name
            } else {
                entry
            };
            let current = install_dir.join(install_name);
            Ok(Replacement {
                source: unpacked.join(entry),
                backup: install_dir.join(backup_name(install_name)?),
                existed_before: current.is_file(),
                current,
            })
        })
        .collect()
}

fn binary_name(stem: &str) -> &'static str {
    match stem {
        "morphz" => {
            #[cfg(windows)]
            {
                "morphz.exe"
            }
            #[cfg(not(windows))]
            {
                "morphz"
            }
        }
        _ => unreachable!("only the Morphz binary name is selected dynamically"),
    }
}

fn backup_name(name: &str) -> Result<String> {
    let path = Path::new(name);
    if path.components().count() != 1 {
        return Err(message(format!("invalid installed component name {name}")));
    }
    match (path.file_stem(), path.extension()) {
        (Some(stem), Some(extension)) => Ok(format!(
            "{}.previous.{}",
            stem.to_string_lossy(),
            extension.to_string_lossy()
        )),
        _ => Ok(format!("{name}.previous")),
    }
}

fn file_name_string(path: &Path) -> Result<String> {
    path.file_name()
        .and_then(|name| name.to_str())
        .map(ToOwned::to_owned)
        .ok_or_else(|| message(format!("invalid component path {}", path.display())))
}

fn update_lock_file(install_dir: &Path) -> Result<File> {
    OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(install_dir.join(LOCK_FILE))
        .map_err(Into::into)
}

#[cfg(unix)]
fn ensure_no_pending_update(_install_dir: &Path) -> Result<()> {
    Ok(())
}

#[cfg(windows)]
fn ensure_no_pending_update(install_dir: &Path) -> Result<()> {
    if install_dir.join(PENDING_FILE).exists() {
        Err(message(
            "a Windows update is still pending; wait a moment and run the command again",
        ))
    } else {
        Ok(())
    }
}

fn validate_receipt(receipt: &UpdateReceipt) -> Result<()> {
    if receipt.schema_version != 1 || receipt.components.is_empty() {
        return Err(message("unsupported or incomplete Morphz update receipt"));
    }
    Version::parse(&receipt.installed_version)?;
    Version::parse(&receipt.previous_version)?;
    for component in &receipt.components {
        for name in [&component.current, &component.backup] {
            let path = Path::new(name);
            if path.components().count() != 1
                || !matches!(path.components().next(), Some(Component::Normal(_)))
            {
                return Err(message("unsafe component path in Morphz update receipt"));
            }
        }
    }
    Ok(())
}

#[cfg(unix)]
fn apply_unix_update(
    replacements: &[Replacement],
    receipt: &UpdateReceipt,
    stage: &Path,
    install_dir: &Path,
) -> Result<()> {
    #[derive(Debug)]
    struct State<'a> {
        replacement: &'a Replacement,
        saved_backup: PathBuf,
        backup_saved: bool,
        backup_created: bool,
        new_installed: bool,
    }

    let receipt_path = install_dir.join(RECEIPT_FILE);
    let saved_receipt = stage.join("previous-receipt.json");
    let new_receipt = stage.join("new-receipt.json");
    write_receipt(&new_receipt, receipt)?;
    let mut receipt_saved = false;
    let mut new_receipt_installed = false;
    let mut states = replacements
        .iter()
        .enumerate()
        .map(|(index, replacement)| State {
            replacement,
            saved_backup: stage.join(format!("saved-backup-{index}")),
            backup_saved: false,
            backup_created: false,
            new_installed: false,
        })
        .collect::<Vec<_>>();

    let apply = (|| -> Result<()> {
        if receipt_path.exists() {
            fs::rename(&receipt_path, &saved_receipt)?;
            receipt_saved = true;
        }
        for state in &mut states {
            if state.replacement.backup.exists() {
                fs::rename(&state.replacement.backup, &state.saved_backup)?;
                state.backup_saved = true;
            }
            if state.replacement.existed_before {
                copy_synced(&state.replacement.current, &state.replacement.backup)?;
                state.backup_created = true;
            }
            // `source` lives in a temporary directory inside `install_dir`, so
            // this rename atomically replaces the Unix executable without a
            // moment in which its public path is absent.
            fs::rename(&state.replacement.source, &state.replacement.current)?;
            state.new_installed = true;
        }
        fs::rename(&new_receipt, &receipt_path)?;
        new_receipt_installed = true;
        sync_directory(install_dir)?;
        Ok(())
    })();

    if let Err(error) = apply {
        let mut repair_errors = Vec::new();
        for state in states.iter().rev() {
            if state.new_installed && state.backup_created && state.replacement.backup.exists() {
                if let Err(repair) =
                    fs::rename(&state.replacement.backup, &state.replacement.current)
                {
                    repair_errors.push(repair.to_string());
                }
            } else if state.new_installed && state.replacement.current.exists() {
                if let Err(repair) = fs::remove_file(&state.replacement.current) {
                    repair_errors.push(repair.to_string());
                }
            } else if state.backup_created && state.replacement.backup.exists() {
                if let Err(repair) = fs::remove_file(&state.replacement.backup) {
                    repair_errors.push(repair.to_string());
                }
            }
            if state.backup_saved && state.saved_backup.exists() {
                if let Err(repair) = fs::rename(&state.saved_backup, &state.replacement.backup) {
                    repair_errors.push(repair.to_string());
                }
            }
        }
        if receipt_saved && saved_receipt.exists() {
            if let Err(repair) = fs::rename(&saved_receipt, &receipt_path) {
                repair_errors.push(repair.to_string());
            }
        } else if new_receipt_installed && receipt_path.exists() {
            if let Err(repair) = fs::remove_file(&receipt_path) {
                repair_errors.push(repair.to_string());
            }
        }
        let repair = if repair_errors.is_empty() {
            String::new()
        } else {
            format!(
                "; restoring the previous installation also failed: {}",
                repair_errors.join("; ")
            )
        };
        return Err(message(format!(
            "could not apply Morphz update: {error}{repair}"
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn rollback_unix(receipt: &UpdateReceipt, install_dir: &Path) -> Result<()> {
    let stage = tempfile::Builder::new()
        .prefix(".morphz-rollback-")
        .tempdir_in(install_dir)?;
    #[derive(Debug)]
    struct State {
        current: PathBuf,
        backup: PathBuf,
        displaced: PathBuf,
        current_saved: bool,
        backup_restored: bool,
        existed_before: bool,
    }
    let mut states = receipt
        .components
        .iter()
        .enumerate()
        .map(|(index, component)| State {
            current: install_dir.join(&component.current),
            backup: install_dir.join(&component.backup),
            displaced: stage.path().join(format!("displaced-{index}")),
            current_saved: false,
            backup_restored: false,
            existed_before: component.existed_before,
        })
        .collect::<Vec<_>>();
    for state in &states {
        if state.existed_before && !state.backup.is_file() {
            return Err(message(format!(
                "rollback binary is missing: {}",
                state.backup.display()
            )));
        }
    }

    let receipt_path = install_dir.join(RECEIPT_FILE);
    let saved_receipt = stage.path().join("rollback-receipt.json");
    let mut receipt_saved = false;
    let apply = (|| -> Result<()> {
        for state in &mut states {
            if state.current.exists() {
                copy_synced(&state.current, &state.displaced)?;
                state.current_saved = true;
            }
            if state.existed_before {
                // The backup and current executable share a filesystem. This
                // replacement is atomic on supported Unix platforms.
                fs::rename(&state.backup, &state.current)?;
                state.backup_restored = true;
            } else if state.current.exists() {
                fs::remove_file(&state.current)?;
            }
        }
        fs::rename(&receipt_path, &saved_receipt)?;
        receipt_saved = true;
        sync_directory(install_dir)?;
        Ok(())
    })();

    if let Err(error) = apply {
        let mut repair_errors = Vec::new();
        for state in states.iter().rev() {
            if state.backup_restored && state.current.exists() {
                if let Err(repair) = copy_synced(&state.current, &state.backup) {
                    repair_errors.push(repair.to_string());
                }
            }
            if state.current_saved && state.displaced.exists() {
                if let Err(repair) = fs::rename(&state.displaced, &state.current) {
                    repair_errors.push(repair.to_string());
                }
            }
        }
        if receipt_saved && saved_receipt.exists() {
            if let Err(repair) = fs::rename(&saved_receipt, &receipt_path) {
                repair_errors.push(repair.to_string());
            }
        }
        let repair = if repair_errors.is_empty() {
            String::new()
        } else {
            format!(
                "; restoring the installed version also failed: {}",
                repair_errors.join("; ")
            )
        };
        return Err(message(format!(
            "could not roll back Morphz: {error}{repair}"
        )));
    }
    Ok(())
}

#[cfg(unix)]
fn copy_synced(source: &Path, destination: &Path) -> Result<()> {
    fs::copy(source, destination)?;
    File::open(destination)?.sync_all()?;
    Ok(())
}

fn write_receipt(path: &Path, receipt: &UpdateReceipt) -> Result<()> {
    let bytes = serde_json::to_vec_pretty(receipt)?;
    let mut file = OpenOptions::new().create_new(true).write(true).open(path)?;
    file.write_all(&bytes)?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(windows)]
#[derive(Debug, Serialize)]
struct WindowsPlan {
    mode: &'static str,
    parent_pid: u32,
    install_dir: String,
    receipt_path: String,
    new_receipt_path: Option<String>,
    pending_path: String,
    stage_dir: String,
    components: Vec<WindowsComponent>,
}

#[cfg(windows)]
#[derive(Debug, Serialize)]
struct WindowsComponent {
    source: Option<String>,
    current: String,
    backup: String,
    existed_before: bool,
}

#[cfg(windows)]
fn schedule_windows_update(
    replacements: Vec<Replacement>,
    receipt: UpdateReceipt,
    stage: TempDir,
    install_dir: &Path,
) -> Result<()> {
    let receipt_source = stage.path().join("new-receipt.json");
    write_receipt(&receipt_source, &receipt)?;
    let components = replacements
        .into_iter()
        .map(|replacement| WindowsComponent {
            source: Some(replacement.source.to_string_lossy().into_owned()),
            current: replacement.current.to_string_lossy().into_owned(),
            backup: replacement.backup.to_string_lossy().into_owned(),
            existed_before: replacement.existed_before,
        })
        .collect();
    schedule_windows_plan(
        "update",
        Some(receipt_source),
        components,
        stage,
        install_dir,
    )
}

#[cfg(windows)]
fn schedule_windows_rollback(receipt: UpdateReceipt, install_dir: &Path) -> Result<()> {
    let stage = tempfile::Builder::new()
        .prefix(".morphz-rollback-")
        .tempdir_in(install_dir)?;
    let components = receipt
        .components
        .into_iter()
        .map(|component| WindowsComponent {
            source: None,
            current: install_dir
                .join(&component.current)
                .to_string_lossy()
                .into_owned(),
            backup: install_dir
                .join(&component.backup)
                .to_string_lossy()
                .into_owned(),
            existed_before: component.existed_before,
        })
        .collect();
    schedule_windows_plan("rollback", None, components, stage, install_dir)
}

#[cfg(windows)]
fn schedule_windows_plan(
    mode: &'static str,
    new_receipt_path: Option<PathBuf>,
    components: Vec<WindowsComponent>,
    stage: TempDir,
    install_dir: &Path,
) -> Result<()> {
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let script_path = stage.path().join("apply-update.ps1");
    let plan_path = stage.path().join("update-plan.json");
    let pending_path = install_dir.join(PENDING_FILE);
    let plan = WindowsPlan {
        mode,
        parent_pid: std::process::id(),
        install_dir: install_dir.to_string_lossy().into_owned(),
        receipt_path: install_dir
            .join(RECEIPT_FILE)
            .to_string_lossy()
            .into_owned(),
        new_receipt_path: new_receipt_path.map(|path| path.to_string_lossy().into_owned()),
        pending_path: pending_path.to_string_lossy().into_owned(),
        stage_dir: stage.path().to_string_lossy().into_owned(),
        components,
    };
    fs::write(&script_path, WINDOWS_APPLY_SCRIPT)?;
    fs::write(&plan_path, serde_json::to_vec_pretty(&plan)?)?;
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&pending_path)?
        .write_all(plan_path.to_string_lossy().as_bytes())?;
    let persistent_stage = stage.keep();
    let spawn = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
        ])
        .arg(&script_path)
        .arg("-PlanPath")
        .arg(&plan_path)
        .creation_flags(DETACHED_PROCESS | CREATE_NO_WINDOW)
        .spawn();
    if let Err(error) = spawn {
        let _ = fs::remove_file(&pending_path);
        let _ = fs::remove_dir_all(&persistent_stage);
        return Err(error.into());
    }
    Ok(())
}

#[cfg(windows)]
const WINDOWS_APPLY_SCRIPT: &str = r#"
param([Parameter(Mandatory=$true)][string]$PlanPath)
$ErrorActionPreference = "Stop"
$plan = Get-Content -LiteralPath $PlanPath -Raw | ConvertFrom-Json
$states = @()
$savedReceipt = Join-Path $plan.stage_dir "saved-receipt.json"
$errorFile = Join-Path $plan.install_dir ".morphz-update-error.txt"
$newReceiptInstalled = $false

try {
  Wait-Process -Id $plan.parent_pid -ErrorAction SilentlyContinue
  if ($plan.mode -eq "update") {
    if (Test-Path -LiteralPath $plan.receipt_path) {
      Move-Item -LiteralPath $plan.receipt_path -Destination $savedReceipt -Force
    }
    $index = 0
    foreach ($component in $plan.components) {
      $savedBackup = Join-Path $plan.stage_dir ("saved-backup-" + $index)
      $state = [pscustomobject]@{ Component=$component; SavedBackup=$savedBackup; BackupSaved=$false; CurrentMoved=$false; NewInstalled=$false }
      $states += $state
      if (Test-Path -LiteralPath $component.backup) {
        Move-Item -LiteralPath $component.backup -Destination $savedBackup -Force
        $state.BackupSaved = $true
      }
      if ($component.existed_before -and (Test-Path -LiteralPath $component.current)) {
        Move-Item -LiteralPath $component.current -Destination $component.backup -Force
        $state.CurrentMoved = $true
      }
      Move-Item -LiteralPath $component.source -Destination $component.current -Force
      $state.NewInstalled = $true
      $index += 1
    }
    Move-Item -LiteralPath $plan.new_receipt_path -Destination $plan.receipt_path -Force
    $newReceiptInstalled = $true
  } elseif ($plan.mode -eq "rollback") {
    $index = 0
    foreach ($component in $plan.components) {
      $displaced = Join-Path $plan.stage_dir ("displaced-" + $index)
      $state = [pscustomobject]@{ Component=$component; Displaced=$displaced; CurrentMoved=$false; BackupRestored=$false }
      $states += $state
      if (Test-Path -LiteralPath $component.current) {
        Move-Item -LiteralPath $component.current -Destination $displaced -Force
        $state.CurrentMoved = $true
      }
      if ($component.existed_before) {
        if (-not (Test-Path -LiteralPath $component.backup)) { throw "Rollback binary is missing: $($component.backup)" }
        Move-Item -LiteralPath $component.backup -Destination $component.current -Force
        $state.BackupRestored = $true
      }
      $index += 1
    }
    Remove-Item -LiteralPath $plan.receipt_path -Force
  } else {
    throw "Unknown Morphz update plan mode: $($plan.mode)"
  }
  Remove-Item -LiteralPath $errorFile -Force -ErrorAction SilentlyContinue
} catch {
  if ($plan.mode -eq "update") {
    [array]::Reverse($states)
    foreach ($state in $states) {
      if ($state.NewInstalled -and (Test-Path -LiteralPath $state.Component.current)) {
        Remove-Item -LiteralPath $state.Component.current -Force
      }
      if ($state.CurrentMoved -and (Test-Path -LiteralPath $state.Component.backup)) {
        Move-Item -LiteralPath $state.Component.backup -Destination $state.Component.current -Force
      }
      if ($state.BackupSaved -and (Test-Path -LiteralPath $state.SavedBackup)) {
        Move-Item -LiteralPath $state.SavedBackup -Destination $state.Component.backup -Force
      }
    }
    if (Test-Path -LiteralPath $savedReceipt) {
      Move-Item -LiteralPath $savedReceipt -Destination $plan.receipt_path -Force
    } elseif ($newReceiptInstalled -and (Test-Path -LiteralPath $plan.receipt_path)) {
      Remove-Item -LiteralPath $plan.receipt_path -Force
    }
  } else {
    [array]::Reverse($states)
    foreach ($state in $states) {
      if ($state.BackupRestored -and (Test-Path -LiteralPath $state.Component.current)) {
        Move-Item -LiteralPath $state.Component.current -Destination $state.Component.backup -Force
      }
      if ($state.CurrentMoved -and (Test-Path -LiteralPath $state.Displaced)) {
        Move-Item -LiteralPath $state.Displaced -Destination $state.Component.current -Force
      }
    }
  }
  ($_ | Out-String) | Set-Content -LiteralPath $errorFile
} finally {
  Remove-Item -LiteralPath $plan.pending_path -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $plan.stage_dir -Recurse -Force -ErrorAction SilentlyContinue
}
"#;

fn message(value: impl Into<String>) -> UpdateError {
    io::Error::other(value.into()).into()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_release_versions_with_or_without_v_prefix() {
        assert_eq!(
            parse_requested_version("v1.2.3").unwrap(),
            Version::new(1, 2, 3)
        );
        assert_eq!(
            parse_requested_version("1.2.3").unwrap(),
            Version::new(1, 2, 3)
        );
        assert!(parse_requested_version("latest").is_err());
    }

    #[test]
    fn platform_assets_match_the_release_matrix() {
        let mac = platform_bundle("macos", "aarch64").unwrap();
        assert_eq!(mac.asset_name, "morphz-macos-aarch64.tar.gz");
        assert_eq!(mac.entries, &["morphz"]);
        let windows = platform_bundle("windows", "x86_64").unwrap();
        assert_eq!(windows.asset_name, "morphz-windows-x86_64.zip");
        assert!(!windows.entries.contains(&"morphz-edge.exe"));
        let linux_arm = platform_bundle("linux", "aarch64").unwrap();
        assert_eq!(linux_arm.asset_name, "morphz-linux-aarch64.tar.gz");
        assert_eq!(linux_arm.entries, &["morphz"]);
    }

    #[test]
    fn checksum_parser_is_strict() {
        let digest = "a".repeat(64);
        assert_eq!(
            parse_checksum(&format!("{digest}  morphz.tar.gz\n")).unwrap(),
            digest
        );
        assert!(parse_checksum("abc").is_err());
        assert!(parse_checksum(&format!("{}z", "a".repeat(63))).is_err());
    }

    #[test]
    fn release_asset_selection_is_exact() {
        let release = GitHubRelease {
            tag_name: "v1.0.0".to_string(),
            assets: vec![
                GitHubAsset {
                    name: "morphz-linux-x86_64.tar.gz".to_string(),
                    url: "https://api.github.com/assets/1".to_string(),
                    browser_download_url: "https://github.com/download/1".to_string(),
                },
                GitHubAsset {
                    name: "morphz-linux-aarch64.tar.gz".to_string(),
                    url: "https://api.github.com/assets/2".to_string(),
                    browser_download_url: "https://github.com/download/2".to_string(),
                },
            ],
        };
        assert!(release_asset(&release, "morphz-linux-x86_64.tar.gz").is_ok());
        assert!(release_asset(&release, "morphz-linux-aarch64.tar.gz").is_ok());
    }

    #[test]
    fn tar_extraction_ignores_metadata_and_rejects_missing_binary() {
        let temporary = TempDir::new().unwrap();
        let archive_path = temporary.path().join("bundle.tar.gz");
        let encoder = flate2::write::GzEncoder::new(
            File::create(&archive_path).unwrap(),
            flate2::Compression::default(),
        );
        let mut builder = tar::Builder::new(encoder);
        let payload = b"binary";
        let mut header = tar::Header::new_gnu();
        header.set_size(payload.len() as u64);
        header.set_mode(0o755);
        header.set_cksum();
        builder
            .append_data(&mut header, "morphz", &payload[..])
            .unwrap();
        builder.finish().unwrap();
        drop(builder);

        let destination = temporary.path().join("unpacked");
        fs::create_dir(&destination).unwrap();
        extract_tar_gz(&archive_path, &destination, &["morphz"]).unwrap();
        assert_eq!(fs::read(destination.join("morphz")).unwrap(), payload);
        assert!(extract_tar_gz(&archive_path, &destination, &["missing"]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn unix_update_and_rollback_replace_only_the_declared_binary() {
        let temporary = TempDir::new().unwrap();
        let install_dir = temporary.path().join("bin");
        let stage_dir = install_dir.join("stage");
        fs::create_dir_all(&stage_dir).unwrap();
        let current = install_dir.join("morphz");
        let source = stage_dir.join("morphz");
        fs::write(&current, b"old").unwrap();
        fs::write(&source, b"new").unwrap();
        let replacement = Replacement {
            source,
            current: current.clone(),
            backup: install_dir.join("morphz.previous"),
            existed_before: true,
        };
        let receipt = UpdateReceipt {
            schema_version: 1,
            installed_version: "1.1.0".to_string(),
            previous_version: "1.0.0".to_string(),
            release_tag: "v1.1.0".to_string(),
            archive_sha256: "a".repeat(64),
            components: vec![ComponentReceipt {
                current: "morphz".to_string(),
                backup: "morphz.previous".to_string(),
                existed_before: true,
            }],
        };

        apply_unix_update(&[replacement], &receipt, &stage_dir, &install_dir).unwrap();
        assert_eq!(fs::read(&current).unwrap(), b"new");
        assert_eq!(
            fs::read(install_dir.join("morphz.previous")).unwrap(),
            b"old"
        );
        rollback_unix(&receipt, &install_dir).unwrap();
        assert_eq!(fs::read(&current).unwrap(), b"old");
        assert!(!install_dir.join(RECEIPT_FILE).exists());
    }

    #[cfg(unix)]
    #[test]
    fn failed_unix_update_restores_the_binary_backup_and_receipt() {
        let temporary = TempDir::new().unwrap();
        let install_dir = temporary.path().join("bin");
        let stage_dir = install_dir.join("stage");
        fs::create_dir_all(&stage_dir).unwrap();
        let current = install_dir.join("morphz");
        let backup = install_dir.join("morphz.previous");
        fs::write(&current, b"current").unwrap();
        fs::write(&backup, b"older-backup").unwrap();
        fs::write(install_dir.join(RECEIPT_FILE), b"prior receipt").unwrap();
        let replacement = Replacement {
            source: stage_dir.join("missing-source"),
            current: current.clone(),
            backup: backup.clone(),
            existed_before: true,
        };
        let receipt = UpdateReceipt {
            schema_version: 1,
            installed_version: "1.1.0".to_string(),
            previous_version: "1.0.0".to_string(),
            release_tag: "v1.1.0".to_string(),
            archive_sha256: "a".repeat(64),
            components: vec![ComponentReceipt {
                current: "morphz".to_string(),
                backup: "morphz.previous".to_string(),
                existed_before: true,
            }],
        };

        assert!(apply_unix_update(&[replacement], &receipt, &stage_dir, &install_dir).is_err());
        assert_eq!(fs::read(current).unwrap(), b"current");
        assert_eq!(fs::read(backup).unwrap(), b"older-backup");
        assert_eq!(
            fs::read(install_dir.join(RECEIPT_FILE)).unwrap(),
            b"prior receipt"
        );
    }

    #[test]
    fn receipt_paths_cannot_escape_the_install_directory() {
        let receipt = UpdateReceipt {
            schema_version: 1,
            installed_version: "1.1.0".to_string(),
            previous_version: "1.0.0".to_string(),
            release_tag: "v1.1.0".to_string(),
            archive_sha256: "a".repeat(64),
            components: vec![ComponentReceipt {
                current: "../morphz".to_string(),
                backup: "morphz.previous".to_string(),
                existed_before: true,
            }],
        };
        assert!(validate_receipt(&receipt).is_err());
    }
}
