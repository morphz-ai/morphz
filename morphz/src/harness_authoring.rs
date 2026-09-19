//! Offline authoring services. No Runtime, provider, store or physical Tool is initialized.

use crate::harness_package::HarnessPackage;
use crate::yao::{AnalysisLimits, AnalysisProfile, Expr, ParseLimits, ToolSignature, Type};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

type Error = Box<dyn std::error::Error + Send + Sync>;

struct Profile {
    tools: BTreeMap<String, ToolSignature>,
}
impl AnalysisProfile for Profile {
    fn tool_signature(&self, name: &str) -> Option<ToolSignature> {
        self.tools.get(name).cloned()
    }
    fn host_signature(&self, name: &str) -> Option<ToolSignature> {
        crate::sexpr_eval::offline_host_signature(name)
    }
    fn implicit_binding(&self, name: &str) -> Option<Type> {
        (name == "runtime").then(crate::sexpr_eval::runtime_environment_type)
    }
}

fn root_name(form: &Expr) -> Option<&str> {
    form.as_list()?.first()?.as_symbol()
}

/// Syntax/type/effect validation is always performed. Unknown external Tool input
/// contracts are explicitly reported, never presented as fully validated schemas.
pub fn check(path: &Path, schema_path: Option<&Path>) -> Result<Value, Error> {
    let package = HarnessPackage::load(path)?;
    let catalog: BTreeMap<String, Value> = match schema_path {
        Some(path) => serde_json::from_str(&std::fs::read_to_string(path)?)?,
        None => BTreeMap::new(),
    };
    let mut unresolved = Vec::new();
    let mut profile = Profile {
        tools: BTreeMap::new(),
    };
    for name in &package.manifest.tools {
        let signature = match catalog.get(name) {
            Some(schema) => {
                if schema.get("type").and_then(Value::as_str) != Some("object")
                    || !schema["properties"].is_object()
                {
                    return Err(format!(
                        "Tool '{name}' needs an object JSON input schema with properties"
                    )
                    .into());
                }
                crate::sexpr_eval::tool_signature_from_json_schema(schema)
            }
            None => {
                unresolved.push(name.clone());
                ToolSignature::dynamic_json()
            }
        };
        profile.tools.insert(name.clone(), signature);
    }
    let mut function_files = BTreeMap::new();
    let (entry, functions, entry_path) = if path.is_file() {
        let source = std::fs::read_to_string(path)?;
        let forms = crate::yao::parse_all(&source, ParseLimits::default())?;
        let entry = forms
            .iter()
            .find(|form| matches!(root_name(form), Some("eval" | "infer")))
            .ok_or("missing entry")?
            .clone();
        let functions = forms
            .into_iter()
            .filter(|form| root_name(form) == Some("fn"))
            .collect::<Vec<_>>();
        (entry, functions, path.to_path_buf())
    } else {
        let base = std::fs::canonicalize(path)?;
        let entry_path = base.join(
            package
                .manifest
                .entry
                .as_deref()
                .ok_or("missing entry path")?,
        );
        let entry = read_form(&base, &entry_path)?;
        let mut functions = Vec::new();
        if base.join("functions").exists() {
            let mut paths = std::fs::read_dir(base.join("functions"))?
                .map(|e| e.map(|e| e.path()))
                .collect::<Result<Vec<_>, _>>()?;
            paths.sort();
            for path in paths {
                let form = read_form(&base, &path)?;
                if let Some(name) = form
                    .as_list()
                    .and_then(|items| items.get(1))
                    .and_then(Expr::as_symbol)
                {
                    function_files.insert(name.to_string(), path.clone());
                }
                functions.push(form);
            }
        }
        (entry, functions, entry_path)
    };
    match crate::yao::sema::analyze_module_forms(
        &entry,
        &functions,
        &profile,
        AnalysisLimits::default(),
    ) {
        Ok(program) => Ok(json!({
            "valid": true, "id": package.manifest.id, "version":package.manifest.version,
            "artifact_hash":package.artifact_hash, "program_hash":crate::yao::program_hash(&program),
            "output_type":program.output, "effects":program.effects,
            "tool_contracts_verified":unresolved.is_empty(), "unresolved_tool_schemas":unresolved,
            "scope":"offline syntax, types and static effects only; live availability and authority are checked at execution"
        })),
        Err(diagnostic) => {
            let source = diagnostic
                .function
                .as_ref()
                .and_then(|name| function_files.get(name.as_ref()))
                .unwrap_or(&entry_path);
            Ok(
                json!({"valid":false, "source":source, "diagnostic":diagnostic, "message":format!("{}:{diagnostic}", source.display())}),
            )
        }
    }
}

fn read_form(base: &Path, path: &Path) -> Result<Expr, Error> {
    let canonical = std::fs::canonicalize(path)?;
    if !canonical.starts_with(base) || !canonical.is_file() {
        return Err("source must be a regular file inside package".into());
    }
    Ok(crate::yao::parse_one(
        &std::fs::read_to_string(canonical)?,
        ParseLimits::default(),
    )?)
}

/// Format only one explicitly selected source. Default callers print to stdout.
/// Writing is opt-in, atomic, preserves permissions and refuses a concurrent edit.
pub fn format(path: &Path, write: bool, check_only: bool) -> Result<(String, bool), Error> {
    if write && check_only {
        return Err("--write and --check are mutually exclusive".into());
    }
    let path: PathBuf = std::fs::canonicalize(path)?;
    if !path.is_file()
        || !matches!(
            path.extension().and_then(|e| e.to_str()),
            Some("hns" | "yao")
        )
    {
        return Err(
            "format expects one .hns or .yao file; select each directory source explicitly".into(),
        );
    }
    let original = std::fs::read_to_string(&path)?;
    let formatted = crate::yao::format::format_source(&original)?;
    let changed = formatted != original;
    if write && changed {
        use std::io::Write;
        let mut temporary =
            tempfile::NamedTempFile::new_in(path.parent().ok_or("missing parent")?)?;
        temporary.write_all(formatted.as_bytes())?;
        temporary
            .as_file()
            .set_permissions(std::fs::metadata(&path)?.permissions())?;
        temporary.as_file().sync_all()?;
        if std::fs::read_to_string(&path)? != original {
            return Err("source changed during formatting; no write performed".into());
        }
        temporary.persist(&path)?;
    }
    Ok((formatted, changed))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn offline_check_reports_real_source_line_and_function_without_installing() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.hns");
        std::fs::write(&path, "(manifest (id test) (version \"1\") (title \"test\"))\n(contract (identity \"test\"))\n(fn wrong (params) (returns Int) (body \"oops\"))\n(eval (requires (tools)) (wrong))").unwrap();
        let result = check(&path, None).unwrap();
        assert_eq!(result["valid"], false);
        assert_eq!(result["diagnostic"]["function"], "wrong");
        assert_eq!(result["diagnostic"]["primary"]["start"]["line"], 3);
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn directory_check_reports_the_innermost_function_file_and_original_line() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("test.hns");
        std::fs::create_dir_all(root.join("functions")).unwrap();
        std::fs::create_dir_all(root.join("programs")).unwrap();
        std::fs::write(
            root.join("manifest.yao"),
            "(manifest (id test) (version \"1\") (title \"test\") (entry \"programs/main.yao\"))",
        )
        .unwrap();
        std::fs::write(
            root.join("contract.yao"),
            "(contract (identity \"\"\"first\nsecond\"\"\"))",
        )
        .unwrap();
        std::fs::write(
            root.join("programs/main.yao"),
            "(eval (requires (tools)) (outer))",
        )
        .unwrap();
        std::fs::write(
            root.join("functions/outer.yao"),
            "(fn outer (params) (returns Int) (body (wrong)))",
        )
        .unwrap();
        let wrong = root.join("functions/wrong.yao");
        std::fs::write(&wrong, "; original line numbers must survive loading\n(fn wrong\n  (params) (returns Int)\n  (body \"oops\"))").unwrap();
        let result = check(&root, None).unwrap();
        assert_eq!(result["valid"], false);
        assert_eq!(
            result["source"],
            std::fs::canonicalize(wrong).unwrap().to_str().unwrap()
        );
        assert_eq!(result["diagnostic"]["function"], "wrong");
        assert_eq!(result["diagnostic"]["primary"]["start"]["line"], 4);
    }

    #[test]
    fn format_is_explicit_and_package_identity_is_preserved() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.hns");
        let source = "(manifest (id test)(version \"1\")(title \"test\"))\n; keep\n(contract (identity \"test\"))\n(eval 1)";
        std::fs::write(&path, source).unwrap();
        let before = HarnessPackage::load(&path).unwrap().artifact_hash;
        assert!(format(&path, false, true).unwrap().1);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), source);
        format(&path, true, false).unwrap();
        assert!(!format(&path, false, true).unwrap().1);
        assert_eq!(HarnessPackage::load(&path).unwrap().artifact_hash, before);
    }

    #[test]
    fn block_metadata_survives_storage_encoding_without_changing_legacy_identity() {
        let source = "(manifest (id test) (version \"1\") (title \"test\"))\n(contract (identity \"\"\"first\nsecond\\line;third\"\"\") (short \";\"))\n(eval \"done\")";
        let package = HarnessPackage::from_source("test.hns", source).unwrap();
        let restored = HarnessPackage::from_source("test.hns", &package.loadable_source()).unwrap();
        assert_eq!(restored.artifact_hash, package.artifact_hash);
        assert_eq!(restored.contract, package.contract);
        assert_eq!(restored.loadable_source(), package.loadable_source());
    }

    #[test]
    fn declared_tool_schemas_are_checked_without_claiming_missing_schemas_are_verified() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.hns");
        std::fs::write(&path, "(manifest (id test) (version \"1\") (title \"test\") (capabilities (tools read)))\n(contract (identity \"test\"))\n(eval (requires (tools read)) (call read (path 12)))").unwrap();
        let result = check(&path, None).unwrap();
        assert_eq!(result["valid"], true);
        assert_eq!(result["tool_contracts_verified"], false);
        let schema_path = dir.path().join("tools.json");
        std::fs::write(&schema_path, r#"{"read":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}"#).unwrap();
        assert_eq!(check(&path, Some(&schema_path)).unwrap()["valid"], false);
    }
}
