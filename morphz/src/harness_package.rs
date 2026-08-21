//! Loader for `.hns` Harness packages.
//!
//! A Harness may be distributed as one compact file or as a directory with
//! separate Yao artifacts.  Both forms normalize into [`HarnessPackage`];
//! downstream attachment and execution must not branch on the physical form.

use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use crate::event::Event;
use crate::harness::{
    DomainHarness, HarnessBinding, HarnessBindingScope, HarnessDescriptor, HarnessError,
    HarnessRegistry,
};
use crate::memory::{EventStore, QueryFilter};
use crate::sexpr::SExpr;
use crate::sexpr_eval::{inspect_program_source, EvaluationOwner};
use serde_json::json;
use sha2::{Digest, Sha256};

pub const HARNESS_PACKAGE_TOPIC: &str = "runtime/harness_package_registered";
pub const HARNESS_BINDING_TOPIC: &str = "runtime/harness_binding";
pub const EVALUATION_HARNESS_BINDING_TOPIC: &str = "runtime/evaluation_harness_binding";

#[derive(Debug)]
pub struct HarnessPackageError {
    message: String,
}

impl HarnessPackageError {
    fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for HarnessPackageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HarnessPackageError {}

impl From<std::io::Error> for HarnessPackageError {
    fn from(error: std::io::Error) -> Self {
        Self::new(error.to_string())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessManifest {
    pub id: String,
    pub version: String,
    pub title: String,
    pub entry: Option<String>,
    pub tools: Vec<String>,
    pub skills: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessProgram {
    /// Logical ID after both package forms have been normalized.
    pub id: String,
    pub owner: EvaluationOwner,
    pub declared_tools: Option<Vec<String>>,
    /// Canonical Yao source. The full validator lowers this into Typed Plan IR
    /// when an Objective/Evaluation activates the Harness.
    pub source: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HarnessPackageOrigin {
    File(PathBuf),
    Directory(PathBuf),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HarnessPackage {
    pub manifest: HarnessManifest,
    pub contract: SExpr,
    pub mind: Option<SExpr>,
    pub entry: HarnessProgram,
    /// Hash of the normalized logical package, independent from whether it was
    /// loaded from one `.hns` file or a directory.
    pub artifact_hash: String,
    pub origin: HarnessPackageOrigin,
}

impl HarnessPackage {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, HarnessPackageError> {
        let path = path.as_ref();
        require_hns_suffix(path)?;
        if path.is_file() {
            Self::load_file(path)
        } else if path.is_dir() {
            Self::load_directory(path)
        } else {
            Err(HarnessPackageError::new(format!(
                "Harness package 不存在或不是文件/目录：{}",
                path.display()
            )))
        }
    }

    pub fn from_source(
        source_name: impl Into<PathBuf>,
        source: &str,
    ) -> Result<Self, HarnessPackageError> {
        let source_name = source_name.into();
        require_hns_suffix(&source_name)?;
        let forms = crate::sexpr::parse_all(source).map_err(|error| {
            HarnessPackageError::new(format!("{} 不是合法的 Yao：{error}", source_name.display()))
        })?;
        let typed_forms = crate::yao::parse_all(source, crate::yao::ParseLimits::default())
            .map_err(|error| {
                HarnessPackageError::new(format!(
                    "{} 不是合法的 Typed Yao：{error}",
                    source_name.display()
                ))
            })?;
        if forms.len() != typed_forms.len() {
            return Err(HarnessPackageError::new(
                "Harness artifact parser disagreement".to_string(),
            ));
        }

        let mut manifest = None;
        let mut contract = None;
        let mut mind = None;
        let mut program_source = None;

        for (form, typed_form) in forms.into_iter().zip(typed_forms) {
            match root_name(&form)? {
                "manifest" => set_once(&mut manifest, form, "manifest")?,
                "contract" => set_once(&mut contract, form, "contract")?,
                "mind" => set_once(&mut mind, form, "mind")?,
                "eval" | "infer" => {
                    if program_source
                        .replace(crate::yao::canonical_source(&typed_form))
                        .is_some()
                    {
                        return Err(HarnessPackageError::new(
                            "单文件 .hns 只能包含一个 (eval/infer ...)".to_string(),
                        ));
                    }
                }
                other => {
                    return Err(HarnessPackageError::new(format!(
                        "单文件 .hns 包含未知顶层 artifact '({other} ...)'; v1 只接受 manifest、contract、mind、eval/infer"
                    )))
                }
            }
        }

        let manifest = parse_manifest(
            &manifest.ok_or_else(|| HarnessPackageError::new("单文件 .hns 缺少 (manifest ...)"))?,
        )?;
        let contract =
            contract.ok_or_else(|| HarnessPackageError::new("单文件 .hns 缺少 (contract ...)"))?;
        let program_source = program_source.ok_or_else(|| {
            HarnessPackageError::new("单文件 .hns 缺少 (eval ...) 或 (infer ...)")
        })?;
        let header = inspect_program_source(&program_source)
            .map_err(|error| HarnessPackageError::new(error.to_string()))?;
        validate_model_entry_declaration(header.owner, header.declared_tools.as_deref())?;
        validate_program_capabilities(&manifest, header.declared_tools.as_deref())?;
        let program_id = manifest.entry.clone().unwrap_or_else(|| "main".to_string());

        Ok(Self::from_normalized_parts(
            manifest,
            contract,
            mind,
            HarnessProgram {
                id: program_id,
                owner: header.owner,
                declared_tools: header.declared_tools,
                source: program_source,
            },
            HarnessPackageOrigin::File(source_name),
        ))
    }

    fn load_file(path: &Path) -> Result<Self, HarnessPackageError> {
        let source = fs::read_to_string(path).map_err(|error| {
            HarnessPackageError::new(format!("读取 {} 失败：{error}", path.display()))
        })?;
        Self::from_source(path.to_path_buf(), &source)
    }

    fn load_directory(path: &Path) -> Result<Self, HarnessPackageError> {
        let manifest_form = read_one_artifact(&path.join("manifest.yao"), "manifest")?;
        let manifest = parse_manifest(&manifest_form)?;
        let entry = manifest.entry.as_deref().ok_or_else(|| {
            HarnessPackageError::new("目录 .hns 的 manifest 必须声明 (entry \"相对路径\")")
        })?;
        let entry_path = resolve_package_path(path, entry)?;
        let program_source = read_program_artifact(&entry_path)?;
        let header = inspect_program_source(&program_source)
            .map_err(|error| HarnessPackageError::new(error.to_string()))?;
        validate_model_entry_declaration(header.owner, header.declared_tools.as_deref())?;
        validate_program_capabilities(&manifest, header.declared_tools.as_deref())?;

        let contract = read_one_artifact(&path.join("contract.yao"), "contract")?;
        let mind_path = path.join("mind.yao");
        let mind = if mind_path.exists() {
            Some(read_one_artifact(&mind_path, "mind")?)
        } else {
            None
        };
        let program_id = Path::new(entry)
            .file_stem()
            .and_then(|name| name.to_str())
            .unwrap_or("main")
            .to_string();

        Ok(Self::from_normalized_parts(
            manifest,
            contract,
            mind,
            HarnessProgram {
                id: program_id,
                owner: header.owner,
                declared_tools: header.declared_tools,
                source: program_source,
            },
            HarnessPackageOrigin::Directory(path.to_path_buf()),
        ))
    }

    fn from_normalized_parts(
        manifest: HarnessManifest,
        contract: SExpr,
        mind: Option<SExpr>,
        entry: HarnessProgram,
        origin: HarnessPackageOrigin,
    ) -> Self {
        let mut package = Self {
            manifest,
            contract,
            mind,
            entry,
            artifact_hash: String::new(),
            origin,
        };
        package.artifact_hash = format!(
            "sha256:{:x}",
            Sha256::digest(package.canonical_source().as_bytes())
        );
        package
    }

    /// Canonical single-file representation used by persistence, hashing and
    /// migration. Filesystem layout and source whitespace deliberately do not
    /// participate in package identity.
    pub fn canonical_source(&self) -> String {
        let mut manifest = vec![
            SExpr::Atom("manifest".to_string()),
            scalar_form("id", &self.manifest.id),
            scalar_form("version", &self.manifest.version),
            scalar_form("title", &self.manifest.title),
            scalar_form("entry", &self.entry.id),
        ];
        let mut capabilities = vec![SExpr::Atom("capabilities".to_string())];
        if !self.manifest.tools.is_empty() {
            let mut tools = vec![SExpr::Atom("tools".to_string())];
            tools.extend(self.manifest.tools.iter().cloned().map(SExpr::Atom));
            capabilities.push(SExpr::List(tools));
        }
        if !self.manifest.skills.is_empty() {
            let mut skills = vec![SExpr::Atom("skills".to_string())];
            skills.extend(self.manifest.skills.iter().cloned().map(SExpr::Atom));
            capabilities.push(SExpr::List(skills));
        }
        if capabilities.len() > 1 {
            manifest.push(SExpr::List(capabilities));
        }
        let mut artifacts = vec![SExpr::List(manifest).to_string(), self.contract.to_string()];
        if let Some(mind) = &self.mind {
            artifacts.push(mind.to_string());
        }
        artifacts.push(self.entry.source.clone());
        artifacts.join("\n")
    }

    pub fn descriptor(&self) -> HarnessDescriptor {
        let mut capabilities = self.manifest.tools.clone();
        capabilities.extend(self.manifest.skills.iter().cloned());
        capabilities.sort();
        capabilities.dedup();
        HarnessDescriptor {
            id: self.manifest.id.clone(),
            version: self.manifest.version.clone(),
            title: self.manifest.title.clone(),
            capabilities,
        }
    }
}

struct LoadedDomainHarness {
    package: Arc<HarnessPackage>,
}

impl DomainHarness for LoadedDomainHarness {
    fn descriptor(&self) -> HarnessDescriptor {
        self.package.descriptor()
    }

    fn compact_contract(&self) -> String {
        self.package.contract.to_string()
    }

    fn artifact_hash(&self) -> Option<String> {
        Some(self.package.artifact_hash.clone())
    }

    fn default_mind(&self) -> Option<String> {
        self.package.mind.as_ref().map(ToString::to_string)
    }

    fn entry_program(&self) -> Option<String> {
        Some(self.package.entry.source.clone())
    }
}

impl HarnessRegistry {
    /// Registers a normalized package at the existing Domain Harness boundary.
    ///
    /// This does not activate its program or grant its declared capabilities.
    pub fn register_package(
        &self,
        package: HarnessPackage,
    ) -> Result<Arc<HarnessPackage>, HarnessError> {
        let package = Arc::new(package);
        self.register(Arc::new(LoadedDomainHarness {
            package: Arc::clone(&package),
        }))?;
        Ok(package)
    }
}

/// Persist one normalized installable package in the immutable Runtime
/// catalog. The Event ID is stable for `(id, version)`, so trying to mutate an
/// installed version is rejected rather than silently creating split-brain
/// bindings.
pub async fn persist_harness_package(
    store: &dyn EventStore,
    package: &HarnessPackage,
) -> Result<bool, HarnessError> {
    let event_id = stable_catalog_event_id(
        "harness_package",
        &format!("{}\0{}", package.manifest.id, package.manifest.version),
    );
    let existing = store
        .query(QueryFilter {
            event_id: Some(event_id.clone()),
            ..Default::default()
        })
        .await?;
    if let Some(existing) = existing.first() {
        let existing_hash = existing
            .payload
            .get("artifact_hash")
            .and_then(|value| value.as_str());
        if existing_hash == Some(package.artifact_hash.as_str()) {
            return Ok(false);
        }
        return Err(format!(
            "Harness '{}@{}' 已持久化为不同 artifact",
            package.manifest.id, package.manifest.version
        )
        .into());
    }

    store
        .append(Event::new(
            event_id,
            "Runtime-HarnessRegistry".to_string(),
            "harness_package".to_string(),
            HARNESS_PACKAGE_TOPIC.to_string(),
            [
                ("harness_id".to_string(), json!(package.manifest.id)),
                (
                    "harness_version".to_string(),
                    json!(package.manifest.version),
                ),
                ("artifact_hash".to_string(), json!(package.artifact_hash)),
                (
                    "canonical_source".to_string(),
                    json!(package.canonical_source()),
                ),
            ]
            .into_iter()
            .collect(),
        ))
        .await?;
    Ok(true)
}

pub async fn load_persisted_harness_packages(
    store: &dyn EventStore,
) -> Result<Vec<HarnessPackage>, HarnessError> {
    let events = store
        .query(QueryFilter {
            topic: Some(HARNESS_PACKAGE_TOPIC.to_string()),
            ..Default::default()
        })
        .await?;
    let mut packages = Vec::with_capacity(events.len());
    for event in events {
        let id = required_event_string(&event, "harness_id")?;
        let version = required_event_string(&event, "harness_version")?;
        let expected_hash = required_event_string(&event, "artifact_hash")?;
        let source = required_event_string(&event, "canonical_source")?;
        let package = HarnessPackage::from_source(format!("{id}.hns"), source)?;
        if package.manifest.version != version || package.artifact_hash != expected_hash {
            return Err(format!(
                "持久 Harness '{}@{}' 的 canonical source 与 catalog identity 不一致",
                id, version
            )
            .into());
        }
        packages.push(package);
    }
    packages.sort_by(|left, right| {
        left.manifest
            .id
            .cmp(&right.manifest.id)
            .then_with(|| left.manifest.version.cmp(&right.manifest.version))
    });
    Ok(packages)
}

/// Establishes the v1 Primary Harness binding. It is immutable for the
/// Objective lifetime: every later Evaluation inherits the same exact package
/// identity and hash.
pub fn objective_harness_binding_event(
    context_id: &str,
    objective_id: &str,
    harness: &dyn DomainHarness,
) -> Result<(HarnessBinding, Event), HarnessError> {
    let descriptor = harness.descriptor();
    let artifact_hash = harness.artifact_hash().ok_or_else(|| {
        format!(
            "Harness '{}@{}' 没有 artifact hash，不能建立持久 Objective binding",
            descriptor.id, descriptor.version
        )
    })?;
    let binding = HarnessBinding {
        harness_id: descriptor.id,
        harness_version: descriptor.version,
        artifact_hash,
        scope: HarnessBindingScope::ObjectiveDefault,
        objective_id: Some(objective_id.to_string()),
        evaluation_id: None,
        inherited_from_objective_id: None,
    };
    let event = Event::new(
        stable_catalog_event_id("harness_binding", objective_id),
        "Runtime-HarnessRegistry".to_string(),
        "harness_binding".to_string(),
        HARNESS_BINDING_TOPIC.to_string(),
        [
            ("context_id".to_string(), json!(context_id)),
            ("objective_id".to_string(), json!(objective_id)),
            ("harness_id".to_string(), json!(binding.harness_id)),
            (
                "harness_version".to_string(),
                json!(binding.harness_version),
            ),
            ("artifact_hash".to_string(), json!(binding.artifact_hash)),
            ("scope".to_string(), json!("objective")),
        ]
        .into_iter()
        .collect(),
    );
    Ok((binding, event))
}

pub async fn persist_objective_harness_binding(
    store: &dyn EventStore,
    context_id: &str,
    objective_id: &str,
    harness: &dyn DomainHarness,
) -> Result<HarnessBinding, HarnessError> {
    let (binding, event) = objective_harness_binding_event(context_id, objective_id, harness)?;
    let existing = store
        .query(QueryFilter {
            event_id: Some(event.id.clone()),
            ..Default::default()
        })
        .await?;
    if let Some(event) = existing.first() {
        let current = binding_from_event(event)?;
        if current == binding {
            return Ok(current);
        }
        return Err(format!(
            "Objective '{}' 已绑定 '{}@{}'，不能改绑为 '{}@{}'",
            objective_id,
            current.harness_id,
            current.harness_version,
            binding.harness_id,
            binding.harness_version
        )
        .into());
    }
    store.append(event).await?;
    Ok(binding)
}

pub async fn load_objective_harness_binding(
    store: &dyn EventStore,
    context_id: &str,
    objective_id: &str,
) -> Result<Option<HarnessBinding>, HarnessError> {
    let events = store
        .query(QueryFilter {
            context_id: Some(context_id.to_string()),
            topic: Some(HARNESS_BINDING_TOPIC.to_string()),
            objective_id: Some(objective_id.to_string()),
            latest_k: Some(1),
            ..Default::default()
        })
        .await?;
    events.first().map(binding_from_event).transpose()
}

/// Persists the exact package identity used by one concrete Runtime
/// Evaluation. The binding is immutable: retries and successor Activations
/// may repeat the same request, but cannot silently replace it.
pub async fn persist_evaluation_harness_binding(
    store: &dyn EventStore,
    context_id: &str,
    evaluation_id: &str,
    objective_id: Option<&str>,
    inherited_from_objective_id: Option<&str>,
    harness: &dyn DomainHarness,
) -> Result<HarnessBinding, HarnessError> {
    let descriptor = harness.descriptor();
    let artifact_hash = harness.artifact_hash().ok_or_else(|| {
        format!(
            "Harness '{}@{}' 没有 artifact hash，不能建立持久 Evaluation binding",
            descriptor.id, descriptor.version
        )
    })?;
    let binding = HarnessBinding {
        harness_id: descriptor.id,
        harness_version: descriptor.version,
        artifact_hash,
        scope: HarnessBindingScope::Evaluation,
        objective_id: objective_id.map(str::to_string),
        evaluation_id: Some(evaluation_id.to_string()),
        inherited_from_objective_id: inherited_from_objective_id.map(str::to_string),
    };
    let mut payload = serde_json::Map::from_iter([
        ("context_id".to_string(), json!(context_id)),
        ("evaluation_id".to_string(), json!(evaluation_id)),
        ("harness_id".to_string(), json!(binding.harness_id)),
        (
            "harness_version".to_string(),
            json!(binding.harness_version),
        ),
        ("artifact_hash".to_string(), json!(binding.artifact_hash)),
        ("scope".to_string(), json!("evaluation")),
    ]);
    if let Some(objective_id) = objective_id {
        payload.insert("objective_id".to_string(), json!(objective_id));
    }
    if let Some(inherited) = inherited_from_objective_id {
        payload.insert("inherited_from_objective_id".to_string(), json!(inherited));
    }
    let event = Event::new(
        stable_catalog_event_id("harness_evaluation_binding", evaluation_id),
        "Runtime-HarnessRegistry".to_string(),
        "harness_binding".to_string(),
        EVALUATION_HARNESS_BINDING_TOPIC.to_string(),
        payload,
    );
    let existing = store
        .query(QueryFilter {
            event_id: Some(event.id.clone()),
            ..Default::default()
        })
        .await?;
    if let Some(event) = existing.first() {
        let current = binding_from_event(event)?;
        if current == binding {
            return Ok(current);
        }
        return Err(format!(
            "Evaluation '{}' 已绑定 '{}@{}'，不能改绑为 '{}@{}'",
            evaluation_id,
            current.harness_id,
            current.harness_version,
            binding.harness_id,
            binding.harness_version
        )
        .into());
    }
    store.append(event).await?;
    Ok(binding)
}

pub async fn load_evaluation_harness_binding(
    store: &dyn EventStore,
    evaluation_id: &str,
) -> Result<Option<HarnessBinding>, HarnessError> {
    let events = store
        .query(QueryFilter {
            event_id: Some(stable_catalog_event_id(
                "harness_evaluation_binding",
                evaluation_id,
            )),
            ..Default::default()
        })
        .await?;
    events.first().map(binding_from_event).transpose()
}

fn binding_from_event(event: &Event) -> Result<HarnessBinding, HarnessError> {
    let scope = match event
        .payload
        .get("scope")
        .and_then(|value| value.as_str())
        .unwrap_or("objective")
    {
        "objective" | "objective_default" => HarnessBindingScope::ObjectiveDefault,
        "evaluation" => HarnessBindingScope::Evaluation,
        value => return Err(format!("未知 Harness binding scope '{value}'").into()),
    };
    Ok(HarnessBinding {
        harness_id: required_event_string(event, "harness_id")?.to_string(),
        harness_version: required_event_string(event, "harness_version")?.to_string(),
        artifact_hash: required_event_string(event, "artifact_hash")?.to_string(),
        scope,
        objective_id: event
            .payload
            .get("objective_id")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        evaluation_id: event
            .payload
            .get("evaluation_id")
            .and_then(|value| value.as_str())
            .map(str::to_string),
        inherited_from_objective_id: event
            .payload
            .get("inherited_from_objective_id")
            .and_then(|value| value.as_str())
            .map(str::to_string),
    })
}

fn required_event_string<'a>(event: &'a Event, key: &str) -> Result<&'a str, HarnessError> {
    event
        .payload
        .get(key)
        .and_then(|value| value.as_str())
        .ok_or_else(|| format!("Harness catalog Event '{}' 缺少 '{key}'", event.id).into())
}

fn stable_catalog_event_id(prefix: &str, key: &str) -> String {
    format!(
        "{prefix}_{:x}",
        Sha256::digest(format!("morphz.{prefix}.v1\0{key}").as_bytes())
    )
}

fn require_hns_suffix(path: &Path) -> Result<(), HarnessPackageError> {
    if path.extension().and_then(|extension| extension.to_str()) == Some("hns") {
        Ok(())
    } else {
        Err(HarnessPackageError::new(format!(
            "Harness package 必须使用 .hns 后缀：{}",
            path.display()
        )))
    }
}

fn scalar_form(name: &str, value: &str) -> SExpr {
    SExpr::List(vec![
        SExpr::Atom(name.to_string()),
        SExpr::Atom(value.to_string()),
    ])
}

fn root_name(form: &SExpr) -> Result<&str, HarnessPackageError> {
    let SExpr::List(items) = form else {
        return Err(HarnessPackageError::new(
            "Harness 顶层 artifact 必须是 S 表达式列表",
        ));
    };
    let Some(SExpr::Atom(name)) = items.first() else {
        return Err(HarnessPackageError::new("Harness 顶层 artifact 缺少根名称"));
    };
    Ok(name)
}

fn set_once(
    target: &mut Option<SExpr>,
    value: SExpr,
    name: &str,
) -> Result<(), HarnessPackageError> {
    if target.replace(value).is_some() {
        return Err(HarnessPackageError::new(format!(
            "单文件 .hns 只能包含一个 ({name} ...)"
        )));
    }
    Ok(())
}

fn read_one_artifact(path: &Path, expected: &str) -> Result<SExpr, HarnessPackageError> {
    let source = fs::read_to_string(path).map_err(|error| {
        HarnessPackageError::new(format!("读取 {} 失败：{error}", path.display()))
    })?;
    let forms = crate::sexpr::parse_all(&source).map_err(|error| {
        HarnessPackageError::new(format!("{} 不是合法的 Yao：{error}", path.display()))
    })?;
    let [form] = forms.as_slice() else {
        return Err(HarnessPackageError::new(format!(
            "{} 必须恰好包含一个 ({expected} ...) artifact",
            path.display()
        )));
    };
    let actual = root_name(form)?;
    if actual != expected {
        return Err(HarnessPackageError::new(format!(
            "{} 应以 ({expected} ...) 为根，实际是 ({actual} ...)",
            path.display()
        )));
    }
    Ok(form.clone())
}

fn read_program_artifact(path: &Path) -> Result<String, HarnessPackageError> {
    let source = fs::read_to_string(path).map_err(|error| {
        HarnessPackageError::new(format!("读取 {} 失败：{error}", path.display()))
    })?;
    let form =
        crate::yao::parse_one(&source, crate::yao::ParseLimits::default()).map_err(|error| {
            HarnessPackageError::new(format!("{} 不是合法的 Typed Yao：{error}", path.display()))
        })?;
    match form
        .as_list()
        .and_then(|items| items.first())
        .and_then(crate::yao::Expr::as_symbol)
    {
        Some("eval" | "infer") => Ok(crate::yao::canonical_source(&form)),
        Some(actual) => Err(HarnessPackageError::new(format!(
            "{} 应以 (eval ...) 或 (infer ...) 为根，实际是 ({actual} ...)",
            path.display()
        ))),
        None => Err(HarnessPackageError::new(format!(
            "{} 必须恰好包含一个 (eval ...) 或 (infer ...)",
            path.display()
        ))),
    }
}

fn parse_manifest(form: &SExpr) -> Result<HarnessManifest, HarnessPackageError> {
    if root_name(form)? != "manifest" {
        return Err(HarnessPackageError::new(
            "Manifest artifact 必须以 (manifest ...) 为根",
        ));
    }
    let SExpr::List(items) = form else {
        unreachable!()
    };
    let id = required_scalar(items, "id")?;
    let version = required_scalar(items, "version")?;
    let title = required_scalar(items, "title")?;
    let entry = optional_scalar(items, "entry")?;
    let (tools, skills) = parse_capabilities(items)?;
    Ok(HarnessManifest {
        id,
        version,
        title,
        entry,
        tools,
        skills,
    })
}

fn required_scalar(items: &[SExpr], name: &str) -> Result<String, HarnessPackageError> {
    optional_scalar(items, name)?
        .ok_or_else(|| HarnessPackageError::new(format!("(manifest ...) 缺少 ({name} VALUE)")))
}

fn optional_scalar(items: &[SExpr], name: &str) -> Result<Option<String>, HarnessPackageError> {
    let mut value = None;
    for item in &items[1..] {
        let SExpr::List(parts) = item else {
            continue;
        };
        if parts.first() != Some(&SExpr::Atom(name.to_string())) {
            continue;
        }
        let [_, SExpr::Atom(found)] = parts.as_slice() else {
            return Err(HarnessPackageError::new(format!(
                "(manifest ... ({name} ...)) 必须恰好有一个标量值"
            )));
        };
        if value.replace(found.clone()).is_some() {
            return Err(HarnessPackageError::new(format!(
                "(manifest ...) 重复声明 ({name} ...)"
            )));
        }
    }
    Ok(value)
}

fn parse_capabilities(items: &[SExpr]) -> Result<(Vec<String>, Vec<String>), HarnessPackageError> {
    let mut seen = false;
    let mut tools = Vec::new();
    let mut skills = Vec::new();
    for item in &items[1..] {
        let SExpr::List(parts) = item else {
            continue;
        };
        if parts.first() != Some(&SExpr::Atom("capabilities".to_string())) {
            continue;
        }
        if seen {
            return Err(HarnessPackageError::new(
                "(manifest ...) 只能声明一次 (capabilities ...)",
            ));
        }
        seen = true;
        for capability in &parts[1..] {
            let SExpr::List(values) = capability else {
                return Err(HarnessPackageError::new(
                    "(capabilities ...) 子项必须是列表",
                ));
            };
            let Some(SExpr::Atom(kind)) = values.first() else {
                return Err(HarnessPackageError::new("(capabilities ...) 子项缺少名称"));
            };
            let destination = match kind.as_str() {
                "tools" => &mut tools,
                "skills" => &mut skills,
                _ => continue,
            };
            for value in &values[1..] {
                let SExpr::Atom(value) = value else {
                    return Err(HarnessPackageError::new(format!(
                        "(capabilities ({kind} ...)) 里只能是名称原子"
                    )));
                };
                if !destination.contains(value) {
                    destination.push(value.clone());
                }
            }
        }
    }
    Ok((tools, skills))
}

fn resolve_package_path(root: &Path, relative: &str) -> Result<PathBuf, HarnessPackageError> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| matches!(component, Component::ParentDir))
    {
        return Err(HarnessPackageError::new(format!(
            "Harness entry 必须留在包目录内：{relative:?}"
        )));
    }
    let path = root.join(relative);
    let canonical_root = fs::canonicalize(root)?;
    let canonical_path = fs::canonicalize(&path).map_err(|error| {
        HarnessPackageError::new(format!(
            "解析 Harness entry {} 失败：{error}",
            path.display()
        ))
    })?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(HarnessPackageError::new(format!(
            "Harness entry 逃逸包目录：{}",
            path.display()
        )));
    }
    Ok(canonical_path)
}

fn validate_program_capabilities(
    manifest: &HarnessManifest,
    declared_tools: Option<&[String]>,
) -> Result<(), HarnessPackageError> {
    let Some(declared_tools) = declared_tools else {
        return Ok(());
    };
    for tool in declared_tools {
        if !manifest.tools.contains(tool) {
            return Err(HarnessPackageError::new(format!(
                "程序 requires 声明的工具 '{tool}' 不在 Harness Manifest 的包级 capabilities 中"
            )));
        }
    }
    Ok(())
}

fn validate_model_entry_declaration(
    owner: EvaluationOwner,
    declared_tools: Option<&[String]>,
) -> Result<(), HarnessPackageError> {
    if owner == EvaluationOwner::Model && declared_tools.is_none() {
        return Err(HarnessPackageError::new(
            "Model-owned Harness entry 必须显式声明 (requires (tools ...))；空列表表示纯推理",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::sqlite::SqliteStore;

    const SINGLE: &str = r#"
        (manifest
          (id coding)
          (version "1.0.0")
          (title "Coding Harness")
          (capabilities
            (tools read search)
            (skills rust testing)))
        (contract
          (identity "coding"))
        (mind
          (frame (id coding/evidence)))
        (eval
          (requires (tools read))
          (call read (path "README.md")))
    "#;

    #[test]
    fn single_file_normalizes_into_one_package() {
        let package = HarnessPackage::from_source("coding.hns", SINGLE).unwrap();
        assert_eq!(package.manifest.id, "coding");
        assert_eq!(package.entry.id, "main");
        assert_eq!(package.entry.owner, EvaluationOwner::Runtime);
        assert_eq!(package.entry.declared_tools, Some(vec!["read".to_string()]));
        assert!(package.mind.is_some());
        assert!(matches!(package.origin, HarnessPackageOrigin::File(_)));
    }

    #[test]
    fn directory_and_single_file_share_the_same_logical_fields() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("coding.hns");
        fs::create_dir_all(root.join("programs")).unwrap();
        fs::write(
            root.join("manifest.yao"),
            r#"(manifest
                (id coding)
                (version "1.0.0")
                (title "Coding Harness")
                (entry "programs/main.yao")
                (capabilities (tools read search) (skills rust testing)))"#,
        )
        .unwrap();
        fs::write(
            root.join("contract.yao"),
            r#"(contract (identity "coding"))"#,
        )
        .unwrap();
        fs::write(
            root.join("mind.yao"),
            r#"(mind (frame (id coding/evidence)))"#,
        )
        .unwrap();
        fs::write(
            root.join("programs/main.yao"),
            r#"(eval (requires (tools read)) (call read (path "README.md")))"#,
        )
        .unwrap();

        let package = HarnessPackage::load(&root).unwrap();
        let single = HarnessPackage::from_source("coding.hns", SINGLE).unwrap();
        assert_eq!(package.manifest.id, single.manifest.id);
        assert_eq!(package.manifest.version, single.manifest.version);
        assert_eq!(package.contract, single.contract);
        assert_eq!(package.mind, single.mind);
        assert_eq!(package.entry.owner, single.entry.owner);
        assert_eq!(package.entry.declared_tools, single.entry.declared_tools);
        assert!(matches!(package.origin, HarnessPackageOrigin::Directory(_)));
    }

    #[test]
    fn duplicate_or_unknown_top_level_artifacts_are_rejected() {
        let duplicate = format!("{SINGLE}\n(contract (identity duplicate))");
        assert!(HarnessPackage::from_source("coding.hns", &duplicate)
            .unwrap_err()
            .to_string()
            .contains("只能包含一个"));
        let unknown = format!("{SINGLE}\n(prompt \"hidden side channel\")");
        assert!(HarnessPackage::from_source("coding.hns", &unknown)
            .unwrap_err()
            .to_string()
            .contains("未知顶层"));
    }

    #[test]
    fn directory_entry_cannot_escape_the_package() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().join("coding.hns");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("manifest.yao"),
            r#"(manifest
                (id coding)
                (version "1")
                (title "Coding")
                (entry "../outside.yao"))"#,
        )
        .unwrap();
        fs::write(root.join("contract.yao"), "(contract)").unwrap();
        let error = HarnessPackage::load(&root).unwrap_err().to_string();
        assert!(error.contains("包目录内"), "{error}");
    }

    #[test]
    fn a_loaded_package_registers_at_the_existing_boundary() {
        let package = HarnessPackage::from_source("coding.hns", SINGLE).unwrap();
        let registry = HarnessRegistry::default();
        registry.register_package(package).unwrap();
        let descriptor = registry.descriptors().pop().unwrap();
        assert_eq!(descriptor.id, "coding");
        assert!(descriptor.capabilities.contains(&"read".to_string()));
        assert_eq!(
            registry.get("coding", "1.0.0").unwrap().compact_contract(),
            "(contract (identity coding))"
        );
    }

    #[test]
    fn package_hash_is_independent_from_whitespace_and_origin_path() {
        let first = HarnessPackage::from_source("first.hns", SINGLE).unwrap();
        let second = HarnessPackage::from_source(
            "elsewhere.hns",
            &first.canonical_source().replace('\n', "\n\n"),
        )
        .unwrap();
        assert_eq!(first.artifact_hash, second.artifact_hash);
        assert_eq!(first.canonical_source(), second.canonical_source());
    }

    #[test]
    fn typed_program_string_identity_survives_package_normalization() {
        let source = SINGLE.replace("\"README.md\"", "\"/tmp/no-spaces.txt\"");
        let package = HarnessPackage::from_source("coding.hns", &source).unwrap();

        assert!(package.entry.source.contains("\"/tmp/no-spaces.txt\""));
        assert!(!package.entry.source.contains("(path /tmp/no-spaces.txt)"));
        assert_eq!(
            inspect_program_source(&package.entry.source).unwrap().owner,
            EvaluationOwner::Runtime
        );
    }

    #[test]
    fn model_owned_entry_requires_an_explicit_tool_upper_bound() {
        let source = SINGLE
            .replace("(capabilities\n            (tools read search)\n            (skills rust testing))", "(capabilities (tools read search) (skills rust testing))")
            .replace(
                "(eval\n          (requires (tools read))\n          (call read (path \"README.md\")))",
                "(infer (task \"decide\") (returns String))",
            );
        let error = HarnessPackage::from_source("coding.hns", &source)
            .unwrap_err()
            .to_string();
        assert!(
            error.contains("必须显式声明 (requires (tools ...))"),
            "{error}"
        );

        let pure = source.replace(
            "(infer (task \"decide\") (returns String))",
            "(infer (requires (tools)) (task \"decide\") (returns String))",
        );
        HarnessPackage::from_source("coding.hns", &pure).unwrap();
    }

    #[test]
    fn registry_accepts_idempotent_same_package_and_rejects_version_replacement() {
        let registry = HarnessRegistry::default();
        let package = HarnessPackage::from_source("coding.hns", SINGLE).unwrap();
        registry.register_package(package.clone()).unwrap();
        registry.register_package(package).unwrap();

        let changed = HarnessPackage::from_source(
            "coding.hns",
            &SINGLE.replace("(identity \"coding\")", "(identity \"changed\")"),
        )
        .unwrap();
        let error = registry.register_package(changed).unwrap_err();
        assert!(error.to_string().contains("不能用不同 artifact 覆盖"));
    }

    #[test]
    fn a_program_can_only_narrow_manifest_capabilities() {
        let source = SINGLE.replace("(requires (tools read))", "(requires (tools read exec))");
        let error = HarnessPackage::from_source("coding.hns", &source)
            .unwrap_err()
            .to_string();
        assert!(error.contains("'exec'"), "{error}");
        assert!(error.contains("包级 capabilities"), "{error}");
    }

    #[tokio::test]
    async fn package_catalog_and_objective_binding_survive_store_reopen() {
        let directory = tempfile::tempdir().unwrap();
        let database = directory.path().join("harness-catalog.db");
        let package = HarnessPackage::from_source("coding.hns", SINGLE).unwrap();
        let registry = HarnessRegistry::default();
        let registered = registry.register_package(package.clone()).unwrap();

        {
            let store = SqliteStore::new(database.to_str().unwrap()).await.unwrap();
            assert!(persist_harness_package(&store, &package).await.unwrap());
            assert!(!persist_harness_package(&store, &package).await.unwrap());
            let binding = persist_objective_harness_binding(
                &store,
                "context-1",
                "objective-1",
                registry.get("coding", "1.0.0").unwrap().as_ref(),
            )
            .await
            .unwrap();
            assert_eq!(binding.artifact_hash, registered.artifact_hash);
        }

        let reopened = SqliteStore::new(database.to_str().unwrap()).await.unwrap();
        let loaded = load_persisted_harness_packages(&reopened).await.unwrap();
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].artifact_hash, package.artifact_hash);
        assert_eq!(loaded[0].canonical_source(), package.canonical_source());

        let binding = load_objective_harness_binding(&reopened, "context-1", "objective-1")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(binding.harness_id, "coding");
        assert_eq!(binding.harness_version, "1.0.0");
        assert_eq!(binding.scope, HarnessBindingScope::ObjectiveDefault);
        assert_eq!(binding.evaluation_id, None);

        let evaluation = persist_evaluation_harness_binding(
            &reopened,
            "context-1",
            "evaluation-2",
            Some("objective-1"),
            Some("objective-1"),
            registry.get("coding", "1.0.0").unwrap().as_ref(),
        )
        .await
        .unwrap();
        assert_eq!(evaluation.scope, HarnessBindingScope::Evaluation);
        assert_eq!(evaluation.evaluation_id.as_deref(), Some("evaluation-2"));
        assert_eq!(
            load_evaluation_harness_binding(&reopened, "evaluation-2")
                .await
                .unwrap(),
            Some(evaluation)
        );
    }
}
