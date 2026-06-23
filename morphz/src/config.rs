use std::fs::File;
use std::io::{self, BufRead, BufReader};

/// 零依赖的极简 .env 环境变量加载器，读取文件并注入到系统环境变量中
pub fn load_env(filepath: &str) -> io::Result<()> {
    let file = File::open(filepath)?;
    let reader = BufReader::new(file);

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        if let Some((key, val)) = trimmed.split_once('=') {
            let key = key.trim();
            let mut val_str = val.trim();

            // 剥离行尾的 # 注释
            if let Some(idx) = val_str.find('#') {
                val_str = val_str[..idx].trim();
            }

            // 剥离单双引号
            let val_cleaned = val_str.trim_matches(|c| c == '"' || c == '\'');
            std::env::set_var(key, val_cleaned);
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::NamedTempFile;

    #[test]
    fn test_load_env() {
        let mut tmp_file = NamedTempFile::new().unwrap();
        writeln!(tmp_file, "TEST_KEY_1 = value1").unwrap();
        writeln!(tmp_file, "TEST_KEY_2 = 'value2' # comment").unwrap();
        writeln!(tmp_file, "# TEST_KEY_3 = value3").unwrap();
        writeln!(tmp_file, "TEST_KEY_4 = \"value4\"").unwrap();

        load_env(tmp_file.path().to_str().unwrap()).unwrap();

        assert_eq!(std::env::var("TEST_KEY_1").unwrap(), "value1");
        assert_eq!(std::env::var("TEST_KEY_2").unwrap(), "value2");
        assert!(std::env::var("TEST_KEY_3").is_err());
        assert_eq!(std::env::var("TEST_KEY_4").unwrap(), "value4");
    }
}
