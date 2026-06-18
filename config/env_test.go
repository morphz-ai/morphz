package config

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadEnv_SuccessAndCornerCases(t *testing.T) {
	tmpDir := os.TempDir()
	testEnvFile := filepath.Join(tmpDir, "morphz_test.env")

	envContent := `
# 这是一个注释行
TEST_KEY_1=val1
TEST_KEY_2="val2" # 带引号和行尾注释
TEST_KEY_3='val3'
TEST_KEY_4=val4#no_space_comment
`
	err := os.WriteFile(testEnvFile, []byte(envContent), 0644)
	if err != nil {
		t.Fatalf("failed to write test env file: %v", err)
	}
	defer os.Remove(testEnvFile)

	err = LoadEnv(testEnvFile)
	if err != nil {
		t.Fatalf("failed to load env: %v", err)
	}

	if val := os.Getenv("TEST_KEY_1"); val != "val1" {
		t.Errorf("expected TEST_KEY_1 val1, got %q", val)
	}
	if val := os.Getenv("TEST_KEY_2"); val != "val2" {
		t.Errorf("expected TEST_KEY_2 val2, got %q", val)
	}
	if val := os.Getenv("TEST_KEY_3"); val != "val3" {
		t.Errorf("expected TEST_KEY_3 val3, got %q", val)
	}
	if val := os.Getenv("TEST_KEY_4"); val != "val4" {
		t.Errorf("expected TEST_KEY_4 val4, got %q", val)
	}
}

func TestLoadEnv_NotExist(t *testing.T) {
	err := LoadEnv("/nonexistent/env/file")
	if err == nil {
		t.Error("expected error for nonexistent file path")
	}
	if !os.IsNotExist(err) {
		t.Errorf("expected NotExist error, got %v", err)
	}
}
