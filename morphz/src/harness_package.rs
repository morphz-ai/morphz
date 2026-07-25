//! Loader for `.hns` Harness packages.
//!
//! A Harness may be distributed as one compact file or as a directory with
//! separate Yao artifacts.  Both forms normalize into [`HarnessPackage`];
//! downstream attachment and execution must not branch on the physical form.

use std::fmt;
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use crate::harness::{DomainHarness, HarnessDescriptor, HarnessError, HarnessRegistry};
use crate::sexpr::SExpr;
use crate::sexpr_eval::{inspect_program_source, EvaluationOwner};

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

        let mut manifest = None;
        let mut contract = None;
        let mut mind = None;
        let mut program = None;

        for form in forms {
            match root_name(&form)? {
                "manifest" => set_once(&mut manifest, form, "manifest")?,
                "contract" => set_once(&mut contract, form, "contract")?,
                "mind" => set_once(&mut mind, form, "mind")?,
                "eval" | "infer" => set_once(&mut program, form, "eval/infer")?,
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
        let program = program.ok_or_else(|| {
            HarnessPackageError::new("单文件 .hns 缺少 (eval ...) 或 (infer ...)")
        })?;
        let program_source = program.to_string();
        let header = inspect_program_source(&program_source)
            .map_err(|error| HarnessPackageError::new(error.to_string()))?;
        validate_program_capabilities(&manifest, header.declared_tools.as_deref())?;
        let program_id = manifest.entry.clone().unwrap_or_else(|| "main".to_string());

        Ok(Self {
            manifest,
            contract,
            mind,
            entry: HarnessProgram {
                id: program_id,
                owner: header.owner,
                declared_tools: header.declared_tools,
                source: program_source,
            },
            origin: HarnessPackageOrigin::File(source_name),
        })
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
        let program_form = read_program_artifact(&entry_path)?;
        let program_source = program_form.to_string();
        let header = inspect_program_source(&program_source)
            .map_err(|error| HarnessPackageError::new(error.to_string()))?;
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

        Ok(Self {
            manifest,
            contract,
            mind,
            entry: HarnessProgram {
                id: program_id,
                owner: header.owner,
                declared_tools: header.declared_tools,
                source: program_source,
            },
            origin: HarnessPackageOrigin::Directory(path.to_path_buf()),
        })
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

fn read_program_artifact(path: &Path) -> Result<SExpr, HarnessPackageError> {
    let source = fs::read_to_string(path).map_err(|error| {
        HarnessPackageError::new(format!("读取 {} 失败：{error}", path.display()))
    })?;
    let forms = crate::sexpr::parse_all(&source).map_err(|error| {
        HarnessPackageError::new(format!("{} 不是合法的 Yao：{error}", path.display()))
    })?;
    let [form] = forms.as_slice() else {
        return Err(HarnessPackageError::new(format!(
            "{} 必须恰好包含一个 (eval ...) 或 (infer ...)",
            path.display()
        )));
    };
    match root_name(form)? {
        "eval" | "infer" => Ok(form.clone()),
        actual => Err(HarnessPackageError::new(format!(
            "{} 应以 (eval ...) 或 (infer ...) 为根，实际是 ({actual} ...)",
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

#[cfg(test)]
mod tests {
    use super::*;

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
            registry.get("coding").unwrap().compact_contract(),
            "(contract (identity coding))"
        );
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
}
