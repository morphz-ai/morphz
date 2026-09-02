use std::path::{Path, PathBuf};

use clap::{Arg, ArgAction, ArgMatches, Command};
use morphz::config;
use morphz::edge_app::{
    bootstrap_edge_node, build_standalone_edge_runtime, default_edge_bootstrap_receipt_path,
    edge_node_status, list_edge_local_leases, load_edge_bootstrap_receipt, pair_edge_node,
    revoke_edge_local_lease, rotate_edge_node_key, start_edge_node, BootstrapEdgeNodeOptions,
    EdgeBootstrapReceipt, PairEdgeNodeOptions, RunEdgeNodeOptions,
};
use morphz::edge_node::EdgeNodeCredentials;
use morphz::permission::{ApprovalPolicy, PermissionMode, ReviewerKind, SandboxMode};
use tracing_subscriber::{fmt, EnvFilter};

type AppError = Box<dyn std::error::Error + Send + Sync>;

fn edge_command() -> Command {
    Command::new("morphz-edge")
        .about("Morphz execution-only Edge Node")
        .version(morphz::build_info::VERSION)
        .arg_required_else_help(false)
        .arg(
            Arg::new("config")
                .long("config")
                .value_name("PATH")
                .global(true)
                .help("Use an explicit Morphz policy configuration file"),
        )
        .arg(
            Arg::new("profile")
                .long("profile")
                .value_name("NAME")
                .global(true)
                .help("Use a named Morphz configuration profile"),
        )
        .arg(
            Arg::new("cwd")
                .long("cwd")
                .value_name("PATH")
                .global(true)
                .help("Set the Execution Target workspace before loading project policy"),
        )
        .arg(
            Arg::new("workspace")
                .long("workspace")
                .value_name("PATH")
                .global(true)
                .help("Override the advertised and sandboxed workspace root"),
        )
        .arg(
            Arg::new("credential-file")
                .long("credential-file")
                .value_name("PATH")
                .global(true)
                .help("Override the Edge device credential file"),
        )
        .arg(
            Arg::new("log-level")
                .long("log-level")
                .value_name("FILTER")
                .global(true)
                .help("Set the tracing filter"),
        )
        .subcommand(
            Command::new("bootstrap")
                .about(
                    "Pair and prepare this computer for user-level background service installation",
                )
                .arg(
                    Arg::new("server-url")
                        .long("server-url")
                        .value_name("URL")
                        .required(true),
                )
                .arg(
                    Arg::new("pairing-code")
                        .long("pairing-code")
                        .value_name("CODE")
                        .required(true),
                )
                .arg(Arg::new("node-name").long("node-name").value_name("NAME"))
                .arg(
                    Arg::new("workers")
                        .long("workers")
                        .value_name("COUNT")
                        .value_parser(clap::value_parser!(usize)),
                )
                .arg(
                    Arg::new("receipt-file")
                        .long("receipt-file")
                        .value_name("PATH"),
                )
                .arg(
                    Arg::new("full-access")
                        .long("full-access")
                        .action(ArgAction::SetTrue)
                        .help("Explicitly allow execution outside the workspace sandbox"),
                )
                .arg(Arg::new("json").long("json").action(ArgAction::SetTrue)),
        )
        .subcommand(
            Command::new("pair")
                .about("Pair this execution node with a Morphz Server")
                .arg(
                    Arg::new("server-url")
                        .long("server-url")
                        .value_name("URL")
                        .required(true),
                )
                .arg(
                    Arg::new("pairing-code")
                        .long("pairing-code")
                        .value_name("CODE")
                        .required(true),
                )
                .arg(Arg::new("node-id").long("node-id").value_name("ID"))
                .arg(Arg::new("node-name").long("node-name").value_name("NAME")),
        )
        .subcommand(
            Command::new("run")
                .about("Run the outbound Execution Target worker")
                .arg(Arg::new("target-id").long("target-id").value_name("ID"))
                .arg(
                    Arg::new("target-name")
                        .long("target-name")
                        .value_name("NAME"),
                )
                .arg(
                    Arg::new("workers")
                        .long("workers")
                        .value_name("COUNT")
                        .value_parser(clap::value_parser!(usize)),
                ),
        )
        .subcommand(
            Command::new("service-run")
                .about("Run from a verified bootstrap receipt (for user-level service managers)")
                .hide(true)
                .arg(
                    Arg::new("receipt-file")
                        .long("receipt-file")
                        .value_name("PATH"),
                ),
        )
        .subcommand(Command::new("status").about("Show the paired Edge Node identity"))
        .subcommand(Command::new("rotate-key").about("Rotate the Edge device identity key"))
        .subcommand(
            Command::new("local-leases")
                .about("List Provider-local capability leases")
                .arg(Arg::new("json").long("json").action(ArgAction::SetTrue)),
        )
        .subcommand(
            Command::new("revoke-local-lease")
                .about("Revoke one Provider-local capability lease")
                .arg(Arg::new("lease-id").value_name("LEASE_ID").required(true)),
        )
}

#[tokio::main]
async fn main() -> Result<(), AppError> {
    if let Some(path) = config::host_env_path() {
        if let Err(error) = config::load_env(&path.to_string_lossy()) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.into());
            }
        }
    }
    let matches = edge_command().get_matches();
    if let Some(cwd) = matches.get_one::<String>("cwd") {
        std::env::set_current_dir(cwd)?;
    }
    init_logging(matches.get_one::<String>("log-level").map(String::as_str))?;
    let command = matches.subcommand_name().unwrap_or("status");
    let service_receipt = if command == "service-run" {
        let child = matches
            .subcommand_matches("service-run")
            .expect("Clap validated the selected subcommand");
        let path = child
            .get_one::<String>("receipt-file")
            .map(PathBuf::from)
            .map(Ok)
            .unwrap_or_else(default_edge_bootstrap_receipt_path)?;
        Some((path.clone(), load_edge_bootstrap_receipt(&path)?))
    } else {
        None
    };
    let credential_path = matches
        .get_one::<String>("credential-file")
        .map(PathBuf::from)
        .or_else(|| {
            service_receipt
                .as_ref()
                .map(|(_, receipt)| receipt.credential_path.clone())
        })
        .map(Ok)
        .unwrap_or_else(EdgeNodeCredentials::default_path)?;

    if command == "status" {
        print_status(&credential_path)?;
        return Ok(());
    }
    if command == "local-leases" {
        print_local_leases(&matches, &credential_path)?;
        return Ok(());
    }
    if command == "revoke-local-lease" {
        let child = matches
            .subcommand_matches("revoke-local-lease")
            .expect("Clap validated the selected subcommand");
        let lease_id = child
            .get_one::<String>("lease-id")
            .expect("Clap requires lease-id");
        if !revoke_edge_local_lease(&credential_path, lease_id)? {
            return Err(
                format!("Provider-local Capability Lease '{lease_id}' does not exist").into(),
            );
        }
        println!("Revoked Provider-local Capability Lease: {lease_id}");
        return Ok(());
    }

    let cwd = matches
        .get_one::<String>("workspace")
        .map(PathBuf::from)
        .or_else(|| {
            service_receipt
                .as_ref()
                .map(|(_, receipt)| receipt.workspace.clone())
        })
        .unwrap_or(std::env::current_dir()?);
    let cwd = if command == "bootstrap" || command == "service-run" {
        let canonical = std::fs::canonicalize(&cwd).map_err(|error| {
            format!(
                "Edge workspace '{}' is not accessible: {error}",
                cwd.display()
            )
        })?;
        if !canonical.is_dir() {
            return Err(format!(
                "Edge workspace '{}' is not a directory",
                canonical.display()
            )
            .into());
        }
        canonical
    } else {
        cwd
    };
    let explicit_config = matches.get_one::<String>("config").map(PathBuf::from);
    let profile = matches.get_one::<String>("profile").map(String::as_str);
    let resolved = config::resolve_config(&cwd, explicit_config.as_deref(), profile)?;
    let workspace_is_default =
        resolved.source_for("permissions.workspace_root") == "built-in-default";
    let protected_paths = resolved
        .loaded_paths()
        .map(Path::to_path_buf)
        .collect::<Vec<_>>();
    let mut source_config = resolved.config;
    let explicit_workspace = matches.get_one::<String>("workspace").map(String::as_str);
    let persistent_workspace =
        if command == "run" && workspace_is_default && explicit_workspace.is_none() {
            Some(config::ensure_morphz_workspace_dir()?)
        } else {
            None
        };
    if command == "bootstrap" || command == "service-run" {
        source_config.permissions.workspace_root = cwd.to_string_lossy().into_owned();
        let full_access = if command == "bootstrap" {
            matches
                .subcommand_matches("bootstrap")
                .is_some_and(|child| child.get_flag("full-access"))
        } else {
            service_receipt
                .as_ref()
                .is_some_and(|(_, receipt)| receipt.full_access)
        };
        apply_service_permission_mode(&mut source_config, full_access);
    } else {
        apply_edge_workspace_policy(
            command,
            explicit_workspace,
            workspace_is_default,
            persistent_workspace.as_deref(),
            &mut source_config,
        );
    }
    if !source_config
        .permissions
        .protected_paths
        .contains(&credential_path.to_string_lossy().into_owned())
    {
        source_config
            .permissions
            .protected_paths
            .push(credential_path.to_string_lossy().into_owned());
    }
    let (runtime, edge_config) =
        build_standalone_edge_runtime(&source_config, protected_paths).await?;

    match command {
        "bootstrap" => {
            let child = matches
                .subcommand_matches("bootstrap")
                .expect("Clap validated the selected subcommand");
            let workspace = matches
                .get_one::<String>("workspace")
                .map(PathBuf::from)
                .ok_or("morphz-edge bootstrap requires --workspace")?;
            let receipt_path = child
                .get_one::<String>("receipt-file")
                .map(PathBuf::from)
                .map(Ok)
                .unwrap_or_else(default_edge_bootstrap_receipt_path)?;
            let requested_workers = child
                .get_one::<usize>("workers")
                .copied()
                .unwrap_or(edge_config.edge_execution.max_in_flight_per_node);
            let workers = requested_workers
                .clamp(1, edge_config.edge_execution.max_in_flight_per_node.max(1));
            let full_access = child.get_flag("full-access");
            if full_access {
                eprintln!(
                    "WARNING: --full-access disables the workspace sandbox for this Edge Node"
                );
            }
            let receipt = bootstrap_edge_node(
                &runtime,
                BootstrapEdgeNodeOptions {
                    server_url: required(child, "server-url").to_string(),
                    pairing_code: required(child, "pairing-code").to_string(),
                    node_name: child
                        .get_one::<String>("node-name")
                        .cloned()
                        .or_else(|| std::env::var("HOSTNAME").ok())
                        .unwrap_or_else(|| "Morphz Edge Node".to_string()),
                    workspace,
                    workers,
                    full_access,
                    credential_path,
                    receipt_path,
                },
            )
            .await?;
            print_bootstrap_receipt(&receipt, child.get_flag("json"))?;
        }
        "pair" => {
            let child = matches
                .subcommand_matches("pair")
                .expect("Clap validated the selected subcommand");
            let paired = pair_edge_node(
                &runtime,
                PairEdgeNodeOptions {
                    server_url: required(child, "server-url").to_string(),
                    pairing_code: required(child, "pairing-code").to_string(),
                    node_id: child.get_one::<String>("node-id").cloned(),
                    node_name: child
                        .get_one::<String>("node-name")
                        .cloned()
                        .or_else(|| std::env::var("HOSTNAME").ok())
                        .unwrap_or_else(|| "Morphz Edge Node".to_string()),
                    credential_path,
                },
            )
            .await?;
            println!(
                "Paired Edge Node '{}' ({})\nCredentials: {}",
                paired.node.name,
                paired.node.id,
                paired.credential_path.display()
            );
        }
        "run" => {
            let child = matches
                .subcommand_matches("run")
                .expect("Clap validated the selected subcommand");
            let running = start_edge_node(
                runtime,
                &edge_config,
                RunEdgeNodeOptions {
                    credential_path,
                    target_id: child.get_one::<String>("target-id").cloned(),
                    target_name: child.get_one::<String>("target-name").cloned(),
                    workers: child.get_one::<usize>("workers").copied(),
                },
            )
            .await?;
            println!(
                "Morphz Edge {} is online; target={} workers={} (Ctrl+C to stop)",
                running.node_id, running.target_id, running.worker_count
            );
            tokio::signal::ctrl_c().await?;
            running.shutdown().await?;
        }
        "service-run" => {
            let (_, receipt) = service_receipt.expect("service-run loaded its receipt");
            let running = start_edge_node(
                runtime,
                &edge_config,
                RunEdgeNodeOptions {
                    credential_path,
                    target_id: None,
                    target_name: Some("Edge Workspace".to_string()),
                    workers: Some(receipt.workers),
                },
            )
            .await?;
            println!(
                "Morphz Edge {} is online; target={} workers={}",
                running.node_id, running.target_id, running.worker_count
            );
            tokio::signal::ctrl_c().await?;
            running.shutdown().await?;
        }
        "rotate-key" => {
            let status = rotate_edge_node_key(&runtime, &credential_path).await?;
            println!(
                "Rotated Edge Node device key: {}\nCredentials: {}",
                status.node_id,
                status.credential_path.display()
            );
        }
        _ => unreachable!("Clap accepts only the declared morphz-edge commands"),
    }
    Ok(())
}

fn apply_edge_workspace_policy(
    command: &str,
    explicit_workspace: Option<&str>,
    workspace_is_default: bool,
    persistent_workspace: Option<&Path>,
    config: &mut config::AppConfig,
) {
    if let Some(workspace) = explicit_workspace {
        config.permissions.workspace_root = workspace.to_string();
    } else if command == "run" && workspace_is_default {
        if let Some(workspace) = persistent_workspace {
            config.permissions.workspace_root = workspace.to_string_lossy().into_owned();
        }
    }
}

fn apply_service_permission_mode(config: &mut config::AppConfig, full_access: bool) {
    if full_access {
        config.permissions.mode = PermissionMode::FullAccess;
        config.permissions.sandbox_mode = SandboxMode::DangerFullAccess;
        config.permissions.approval_policy = ApprovalPolicy::Never;
        config.permissions.reviewer = ReviewerKind::Deny;
    } else {
        config.permissions.mode = PermissionMode::Custom;
        config.permissions.sandbox_mode = SandboxMode::WorkspaceWrite;
        config.permissions.approval_policy = ApprovalPolicy::Never;
        config.permissions.reviewer = ReviewerKind::Deny;
        config.permissions.network = false;
    }
}

fn print_bootstrap_receipt(receipt: &EdgeBootstrapReceipt, json: bool) -> Result<(), AppError> {
    if json {
        println!("{}", serde_json::to_string_pretty(receipt)?);
    } else {
        println!(
            "Paired Edge Node '{}'\nWorkspace: {}\nCredentials: {}",
            receipt.node_id,
            receipt.workspace.display(),
            receipt.credential_path.display()
        );
    }
    Ok(())
}

fn print_status(credential_path: &Path) -> Result<(), AppError> {
    let status = edge_node_status(credential_path)?;
    println!(
        "Edge Node: {}\nGateway: {}\nCredentials: {}",
        status.node_id,
        status.server_url,
        status.credential_path.display()
    );
    Ok(())
}

fn print_local_leases(matches: &ArgMatches, credential_path: &Path) -> Result<(), AppError> {
    let leases = list_edge_local_leases(credential_path)?;
    let json = matches
        .subcommand_matches("local-leases")
        .is_some_and(|child| child.get_flag("json"));
    if json {
        println!("{}", serde_json::to_string_pretty(&leases)?);
    } else if leases.is_empty() {
        println!("No Provider-local Capability Leases.");
    } else {
        for lease in leases {
            println!(
                "{}\t{}\t{}\t{}\t{}",
                lease.id,
                lease.target_id,
                lease.thread_id,
                lease.capability,
                if lease.revoked_at.is_some() {
                    "revoked"
                } else {
                    "active"
                }
            );
        }
    }
    Ok(())
}

fn required<'a>(matches: &'a ArgMatches, key: &str) -> &'a str {
    matches
        .get_one::<String>(key)
        .map(String::as_str)
        .expect("Clap validates required options")
}

fn init_logging(log_level: Option<&str>) -> Result<(), AppError> {
    let filter = match log_level {
        Some(level) => EnvFilter::try_new(level)?,
        None => EnvFilter::try_from_default_env()
            .unwrap_or_else(|_| EnvFilter::new("info,morphz=debug")),
    };
    fmt().with_env_filter(filter).with_target(true).try_init()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn standalone_run_uses_persistent_workspace_without_overriding_explicit_choices() {
        let mut default = config::AppConfig::default();
        apply_edge_workspace_policy(
            "run",
            None,
            true,
            Some(Path::new("/home/person/.morphz/workspace")),
            &mut default,
        );
        assert_eq!(
            default.permissions.workspace_root,
            "/home/person/.morphz/workspace"
        );

        let mut configured = config::AppConfig::default();
        configured.permissions.workspace_root = "/configured/edge".to_string();
        apply_edge_workspace_policy(
            "run",
            None,
            false,
            Some(Path::new("/home/person/.morphz/workspace")),
            &mut configured,
        );
        assert_eq!(configured.permissions.workspace_root, "/configured/edge");

        apply_edge_workspace_policy(
            "run",
            Some("/cli/edge"),
            true,
            Some(Path::new("/home/person/.morphz/workspace")),
            &mut configured,
        );
        assert_eq!(configured.permissions.workspace_root, "/cli/edge");
    }

    #[test]
    fn standalone_binary_exposes_only_execution_node_commands() {
        let command = edge_command();
        let commands = command
            .get_subcommands()
            .map(|command| command.get_name())
            .collect::<Vec<_>>();
        assert_eq!(
            commands,
            [
                "bootstrap",
                "pair",
                "run",
                "service-run",
                "status",
                "rotate-key",
                "local-leases",
                "revoke-local-lease"
            ]
        );
        assert!(!commands.contains(&"pairing-code"));
        assert!(!commands.contains(&"nodes"));
        assert!(!commands.contains(&"revoke"));
    }

    #[test]
    fn bootstrap_requires_pairing_boundaries_and_explicit_full_access() {
        let matches = edge_command()
            .try_get_matches_from([
                "morphz-edge",
                "--workspace=/tmp/project",
                "bootstrap",
                "--server-url=https://edge.example",
                "--pairing-code=pair_once",
                "--workers=4",
            ])
            .unwrap();
        let bootstrap = matches.subcommand_matches("bootstrap").unwrap();
        assert!(!bootstrap.get_flag("full-access"));
        assert_eq!(bootstrap.get_one::<usize>("workers"), Some(&4));
        assert_eq!(
            matches.get_one::<String>("workspace").map(String::as_str),
            Some("/tmp/project")
        );
    }

    #[test]
    fn standalone_pair_and_run_keep_the_expected_device_options() {
        let pair = edge_command()
            .try_get_matches_from([
                "morphz-edge",
                "pair",
                "--server-url=https://cloud.example",
                "--pairing-code=pair_once",
                "--node-name=desk",
            ])
            .unwrap();
        assert_eq!(pair.subcommand_name(), Some("pair"));
        let run = edge_command()
            .try_get_matches_from([
                "morphz-edge",
                "run",
                "--target-id=target-desk",
                "--workers=3",
            ])
            .unwrap();
        assert_eq!(run.subcommand_name(), Some("run"));
        assert_eq!(
            run.subcommand_matches("run")
                .unwrap()
                .get_one::<usize>("workers"),
            Some(&3)
        );
    }
}
