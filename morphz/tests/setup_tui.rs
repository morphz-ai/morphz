//! Real PTY tests: isolated Morphz home, synthetic credentials, loopback-only
//! provider. No account login, operating-system credential store or live model.
#![cfg(unix)]

use axum::{
    routing::{get, post},
    Json, Router,
};
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    mpsc, Arc,
};
use std::time::{Duration, Instant};
use tempfile::TempDir;

struct Wizard {
    child: Box<dyn Child + Send + Sync>,
    _master: Box<dyn MasterPty + Send>,
    input: Box<dyn Write + Send>,
    output: mpsc::Receiver<Vec<u8>>,
    screen: vt100::Parser,
    raw: Vec<u8>,
    home: TempDir,
}

impl Wizard {
    fn start(locale: &str) -> Self {
        let home = TempDir::new().unwrap();
        let pty = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new(env!("CARGO_BIN_EXE_morphz"));
        command.args(["--language", locale, "setup", "--tui"]);
        command.cwd(home.path());
        command.env("MORPHZ_HOME", home.path());
        command.env("MORPHZ_TUI_APPEARANCE", "dark");
        command.env("MORPHZ_HTTP_PROXY_MODE", "direct");
        command.env("MORPHZ_PROVIDER_PROXY_MODE", "direct");
        command.env("TERM", "xterm-256color");
        let child = pty.slave.spawn_command(command).unwrap();
        drop(pty.slave);
        let mut reader = pty.master.try_clone_reader().unwrap();
        let input = pty.master.take_writer().unwrap();
        let (tx, output) = mpsc::channel();
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            while let Ok(count) = reader.read(&mut buffer) {
                if count == 0 || tx.send(buffer[..count].to_vec()).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            _master: pty.master,
            input,
            output,
            screen: vt100::Parser::new(24, 80, 0),
            raw: vec![],
            home,
        }
    }

    fn send(&mut self, keys: &str) {
        self.input.write_all(keys.as_bytes()).unwrap();
        self.input.flush().unwrap();
    }

    fn expect(&mut self, text: &str) {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if self.screen.screen().contents().contains(text) {
                return;
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            match self.output.recv_timeout(remaining) {
                Ok(bytes) => {
                    self.screen.process(&bytes);
                    self.raw.extend(bytes);
                }
                Err(error) => panic!(
                    "Expected {text:?}: {error}\n{}",
                    self.screen.screen().contents()
                ),
            }
        }
    }

    fn custom_provider(&mut self, url: &str) {
        self.expect("Choose a provider");
        self.send("/custom\r");
        self.expect("Provider ID");
        self.send("setup-fixture\r");
        self.expect("Choose a protocol");
        self.send("\r"); // OpenAI Chat Completions, the explicit initial selection
        self.expect("Provider URL");
        self.send(&format!("{url}\r"));
        self.expect("Configure credentials");
    }

    fn enter_secret(&mut self) {
        self.send("/Morphz secrets\r");
        self.expect("Environment variable");
        self.send("MORPHZ_SETUP_TEST_KEY\r");
        self.expect("Enter API key");
        self.send("synthetic-setup-key-not-a-credential\r");
    }

    fn exit(&mut self, success: bool) {
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            while let Ok(bytes) = self.output.try_recv() {
                self.screen.process(&bytes);
                self.raw.extend(bytes);
            }
            if let Some(status) = self.child.try_wait().unwrap() {
                assert_eq!(
                    status.success(),
                    success,
                    "{}",
                    self.screen.screen().contents()
                );
                return;
            }
            assert!(Instant::now() < deadline, "Wizard did not exit promptly");
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for Wizard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

async fn provider(stall_catalog: bool) -> (String, Arc<AtomicUsize>, tokio::task::JoinHandle<()>) {
    let calls = Arc::new(AtomicUsize::new(0));
    let counter = calls.clone();
    let router = Router::new()
        .route("/v1/models", get(move || async move {
            if stall_catalog { std::future::pending::<()>().await; }
            Json(json!({"data": (0..40).map(|i| json!({"id": format!("model-{i:02}")})).collect::<Vec<_>>()}))
        }))
        .route("/v1/chat/completions", post(move |Json(body): Json<Value>| {
            let counter = counter.clone();
            async move {
                counter.fetch_add(1, Ordering::SeqCst);
                let tool = body["tools"].as_array().is_some_and(|tools| !tools.is_empty());
                let delta = if tool {
                    json!({"role":"assistant", "tool_calls":[{"index":0,"id":"probe-1","type":"function","function":{"name":"morphz_probe","arguments":"{\"value\":\"MORPHZ_OK\"}"}}]})
                } else { json!({"role":"assistant", "content":"MORPHZ_OK"}) };
                let chunk = json!({"id":"test-completion", "model":"model-39", "choices":[{"index":0,"delta":delta}]});
                let end = json!({"id":"test-completion", "choices":[{"index":0,"delta":{},"finish_reason":if tool {"tool_calls"} else {"stop"}}]});
                ([("content-type", "text/event-stream")], format!("data: {chunk}\n\ndata: {end}\n\ndata: [DONE]\n\n"))
            }
        }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/v1", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        axum::serve(listener, router).await.unwrap();
    });
    (url, calls, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn setup_pty_checks_full_catalog_verifies_and_saves_only_after_confirmation() {
    let (url, calls, server) = provider(false).await;
    let mut wizard = Wizard::start("en");
    wizard.custom_provider(&url);
    wizard.enter_secret();
    wizard.expect("Choose a model");
    wizard.send("/model-39\r"); // Well beyond the old 18-model truncation.
    wizard.expect("Connection check");
    wizard.send("\r");
    wizard.expect("Review configuration");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    assert!(!wizard.home.path().join(".env").exists());
    assert!(!wizard.home.path().join("models.toml").exists());
    assert!(!String::from_utf8_lossy(&wizard.raw).contains("synthetic-setup-key"));
    wizard.send("\r");
    wizard.expect("Save configuration?");
    wizard.send("\r");
    wizard.expect("Setup complete");
    wizard.send("\x1b"); // Dismissing a saved receipt is success, not cancellation.
    wizard.exit(true);
    let config = std::fs::read_to_string(wizard.home.path().join("models.toml")).unwrap();
    let parsed: Value =
        serde_json::to_value(toml::from_str::<toml::Value>(&config).unwrap()).unwrap();
    assert_eq!(parsed["llm"]["model"], "model-39");
    assert_eq!(
        parsed["credentials"]["setup-fixture"]["name"],
        "MORPHZ_SETUP_TEST_KEY"
    );
    assert!(!config.contains("synthetic-setup-key"));
    let secrets = std::fs::read_to_string(wizard.home.path().join(".env")).unwrap();
    assert!(secrets.contains("MORPHZ_SETUP_TEST_KEY="));
    server.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cancelling_pending_discovery_keeps_credentials_and_configuration_unwritten() {
    let (url, calls, server) = provider(true).await;
    let mut wizard = Wizard::start("en");
    wizard.custom_provider(&url);
    wizard.enter_secret();
    wizard.expect("Discovering models");
    wizard.send("\x03");
    wizard.exit(false);
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!wizard.home.path().join(".env").exists());
    assert!(!wizard.home.path().join("models.toml").exists());
    server.abort();
}

#[test]
fn chinese_oauth_wizard_stops_before_login_without_writes() {
    let mut wizard = Wizard::start("zh-CN");
    wizard.expect("选择模型服务商");
    wizard.send("/codex\r");
    wizard.expect("保存 OAuth 令牌");
    assert!(wizard.screen.screen().contents().contains("2/3"));
    wizard.send("\r");
    wizard.expect("检查配置");
    assert!(wizard.screen.screen().contents().contains("3/3"));
    wizard.send("\x03");
    wizard.exit(false);
    assert!(!wizard.home.path().join("models.toml").exists());
    assert!(!wizard.home.path().join(".env").exists());
}

#[test]
fn non_interactive_tui_returns_actionable_error_before_runtime_start() {
    let home = TempDir::new().unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_morphz"))
        .args(["--language", "en", "setup", "--tui"])
        .current_dir(home.path())
        .env("MORPHZ_HOME", home.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("requires an interactive terminal"));
    assert!(!home.path().join("models.toml").exists());
}
