package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRunIncludesSingleCharacterExports(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "main.go"), []byte("package main\ntype T struct{}\nfunc F() {}\n"), 0644); err != nil {
		t.Fatal(err)
	}
	var stdout, stderr bytes.Buffer
	if err := run([]string{"-root", root, "-quiet"}, &stdout, &stderr); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stdout.String(), "main.go->T F") {
		t.Fatalf("output = %q", stdout.String())
	}
}

func TestRunRejectsInvalidRootAndOutput(t *testing.T) {
	var stdout, stderr bytes.Buffer
	if err := run([]string{"-root", filepath.Join(t.TempDir(), "missing"), "-quiet"}, &stdout, &stderr); err == nil {
		t.Fatal("expected invalid root error")
	}

	root := t.TempDir()
	badParent := filepath.Join(root, "not-a-directory")
	if err := os.WriteFile(badParent, nil, 0644); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-root", root, "-out", filepath.Join(badParent, "graph.txt"), "-quiet"}, &stdout, &stderr); err == nil {
		t.Fatal("expected output error")
	}
}
