package config

import (
	"bufio"
	"os"
	"strings"
)

// LoadEnv 零依赖的极简 .env 环境变量加载器，读取文件并注入到系统环境变量中
func LoadEnv(filepath string) error {
	file, err := os.Open(filepath)
	if err != nil {
		return err
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}

		parts := strings.SplitN(line, "=", 2)
		if len(parts) == 2 {
			key := strings.TrimSpace(parts[0])
			val := strings.TrimSpace(parts[1])

			// 剥离行尾的 # 注释
			if idx := strings.Index(val, "#"); idx != -1 {
				val = strings.TrimSpace(val[:idx])
			}

			// 剥离单双引号
			val = strings.Trim(val, `"'`)
			_ = os.Setenv(key, val)
		}
	}
	return scanner.Err()
}
