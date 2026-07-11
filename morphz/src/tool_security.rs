use crate::config::ToolSecurityConfig;
use std::path::{Component, Path, PathBuf};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolAccess {
    Read,
    Write,
}

/// 解析并校验工具访问路径。
///
/// 默认启用 workspace jail：路径必须落在 workspace_root 或对应 extra roots 内。
/// 当 workspace_jail_enabled=false 时，不做 workspace 限制，但 deny_patterns 仍然生效。
pub fn resolve_tool_path(
    input: &str,
    access: ToolAccess,
    config: &ToolSecurityConfig,
) -> Result<PathBuf, String> {
    let raw = Path::new(input);

    if !config.allow_parent_traversal && raw.components().any(|c| c == Component::ParentDir) {
        return Err(format!("路径安全策略拒绝父目录跳转 '..': {}", input));
    }

    let workspace_root = canonicalize_or_current(&config.workspace_root)?;
    let candidate = if raw.is_absolute() {
        raw.to_path_buf()
    } else {
        workspace_root.join(raw)
    };

    let resolved = resolve_existing_or_parent(&candidate)?;
    let extra_roots = match access {
        ToolAccess::Read => &config.extra_read_roots,
        ToolAccess::Write => &config.extra_write_roots,
    };
    let canonical_extra_roots: Vec<PathBuf> = extra_roots
        .iter()
        .filter_map(|root| std::fs::canonicalize(root).ok())
        .collect();

    if raw.is_absolute()
        && !config.allow_absolute_paths
        && !canonical_extra_roots
            .iter()
            .any(|root| resolved.starts_with(root))
    {
        return Err(format!("路径安全策略拒绝绝对路径: {}", input));
    }

    // 同时检查用户输入路径与 canonical 路径，防止通过工作区内软链接绕过敏感路径规则。
    if matches_deny_patterns(&candidate, &config.deny_patterns)
        || matches_deny_patterns(&resolved, &config.deny_patterns)
    {
        return Err(format!(
            "路径安全策略拒绝访问敏感路径: {}",
            candidate.display()
        ));
    }

    if config.workspace_jail_enabled {
        let mut allowed_roots = vec![workspace_root];
        allowed_roots.extend(canonical_extra_roots);

        if !allowed_roots.iter().any(|root| resolved.starts_with(root)) {
            return Err(format!(
                "路径安全策略拒绝访问 workspace/extra roots 之外的路径: {}",
                candidate.display()
            ));
        }
    }

    Ok(candidate)
}

fn canonicalize_or_current(path: &str) -> Result<PathBuf, String> {
    if path == "." {
        std::env::current_dir().map_err(|e| format!("无法获取当前目录: {}", e))
    } else {
        std::fs::canonicalize(path)
            .map_err(|e| format!("无法解析 workspace_root '{}': {}", path, e))
    }
}

fn resolve_existing_or_parent(path: &Path) -> Result<PathBuf, String> {
    if path.exists() {
        return std::fs::canonicalize(path)
            .map_err(|e| format!("无法解析路径 '{}': {}", path.display(), e));
    }

    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    if parent.exists() {
        return std::fs::canonicalize(parent)
            .map_err(|e| format!("无法解析父目录 '{}': {}", parent.display(), e));
    }

    // 对于尚不存在的写入路径，逐级寻找最近存在的父目录。
    let mut current = parent;
    while let Some(next) = current.parent() {
        if next.exists() {
            return std::fs::canonicalize(next)
                .map_err(|e| format!("无法解析祖先目录 '{}': {}", next.display(), e));
        }
        current = next;
    }

    Err(format!("路径 '{}' 没有可解析的父目录", path.display()))
}

fn matches_deny_patterns(path: &Path, patterns: &[String]) -> bool {
    let path_str = path.to_string_lossy();
    let file_name = path.file_name().and_then(|s| s.to_str()).unwrap_or("");
    let components: Vec<String> = path
        .components()
        .filter_map(|c| c.as_os_str().to_str().map(|s| s.to_string()))
        .collect();

    for pattern in patterns {
        if matches_simple_pattern(&path_str, file_name, &components, pattern) {
            return true;
        }
    }
    false
}

fn matches_simple_pattern(
    path_str: &str,
    file_name: &str,
    components: &[String],
    pattern: &str,
) -> bool {
    match pattern {
        ".env" => file_name == ".env",
        ".env.*" => file_name.starts_with(".env."),
        ".git/**" => components.iter().any(|c| c == ".git"),
        "**/.ssh/**" => components.iter().any(|c| c == ".ssh"),
        "target/**" => components.iter().any(|c| c == "target"),
        "models/**" => components.iter().any(|c| c == "models"),
        other if other.ends_with("/**") => {
            let prefix = other.trim_end_matches("/**");
            components.iter().any(|c| c == prefix)
        }
        other if other.ends_with('*') => {
            let prefix = other.trim_end_matches('*');
            file_name.starts_with(prefix) || path_str.contains(prefix)
        }
        other => file_name == other || path_str.ends_with(other),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    fn base_config(root: &Path) -> ToolSecurityConfig {
        ToolSecurityConfig {
            workspace_jail_enabled: true,
            workspace_root: root.to_string_lossy().to_string(),
            allow_absolute_paths: false,
            allow_parent_traversal: false,
            extra_read_roots: vec![],
            extra_write_roots: vec![],
            deny_patterns: ToolSecurityConfig::default().deny_patterns,
            exec_seatbelt_enabled: false,
            exec_network_enabled: false,
        }
    }

    #[test]
    fn allows_relative_path_inside_workspace() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join("a.txt");
        std::fs::write(&path, "ok").unwrap();
        let cfg = base_config(tmp.path());
        let resolved = resolve_tool_path("a.txt", ToolAccess::Read, &cfg).unwrap();
        assert_eq!(
            std::fs::canonicalize(&resolved).unwrap(),
            std::fs::canonicalize(&path).unwrap()
        );
    }

    #[test]
    fn rejects_parent_traversal_by_default() {
        let tmp = TempDir::new().unwrap();
        let cfg = base_config(tmp.path());
        let err = resolve_tool_path("../x", ToolAccess::Read, &cfg).unwrap_err();
        assert!(err.contains("父目录"));
    }

    #[test]
    fn rejects_absolute_path_by_default() {
        let tmp = TempDir::new().unwrap();
        let cfg = base_config(tmp.path());
        let err = resolve_tool_path("/etc/passwd", ToolAccess::Read, &cfg).unwrap_err();
        assert!(err.contains("绝对路径"));
    }

    #[test]
    fn allows_absolute_path_inside_explicit_extra_root() {
        let workspace = TempDir::new().unwrap();
        let extra = TempDir::new().unwrap();
        let path = extra.path().join("shared.txt");
        std::fs::write(&path, "shared").unwrap();
        let mut cfg = base_config(workspace.path());
        cfg.extra_read_roots = vec![extra.path().to_string_lossy().to_string()];

        let resolved = resolve_tool_path(path.to_str().unwrap(), ToolAccess::Read, &cfg).unwrap();
        assert_eq!(resolved, path);
    }

    #[test]
    fn deny_patterns_apply_even_when_jail_disabled() {
        let tmp = TempDir::new().unwrap();
        let path = tmp.path().join(".env");
        std::fs::write(&path, "secret").unwrap();
        let mut cfg = base_config(tmp.path());
        cfg.workspace_jail_enabled = false;
        cfg.allow_absolute_paths = true;
        let err = resolve_tool_path(path.to_str().unwrap(), ToolAccess::Read, &cfg).unwrap_err();
        assert!(err.contains("敏感路径"));
    }

    #[cfg(unix)]
    #[test]
    fn deny_patterns_cannot_be_bypassed_with_symlink() {
        use std::os::unix::fs::symlink;

        let tmp = TempDir::new().unwrap();
        let env_path = tmp.path().join(".env");
        let alias_path = tmp.path().join("safe-name");
        std::fs::write(&env_path, "secret").unwrap();
        symlink(&env_path, &alias_path).unwrap();

        let cfg = base_config(tmp.path());
        let err = resolve_tool_path("safe-name", ToolAccess::Read, &cfg).unwrap_err();
        assert!(err.contains("敏感路径"));
    }
}
