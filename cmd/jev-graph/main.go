package main

import (
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

var ignoreDirs = map[string]bool{
	".git":               true,
	"node_modules":       true,
	"vendor":             true,
	"dist":               true,
	"build":              true,
	"test-output":        true,
	"tmp":                true,
	"temp":               true,
	".agents":            true,
	".pi":                true,
	".gitnexus":          true,
	"subagent-artifacts": true,
}

func isTestFile(path string) bool {
	lower := strings.ToLower(filepath.ToSlash(path))
	base := strings.ToLower(filepath.Base(path))
	if strings.HasSuffix(base, "_test.go") ||
		strings.HasSuffix(base, ".test.ts") ||
		strings.HasSuffix(base, ".spec.ts") ||
		strings.HasSuffix(base, ".test.js") ||
		strings.HasSuffix(base, ".spec.js") ||
		strings.HasSuffix(base, "_test.py") ||
		strings.HasPrefix(base, "test_") ||
		strings.HasPrefix(lower, "tests/") ||
		strings.HasPrefix(lower, "test/") ||
		strings.Contains(lower, "/test/") ||
		strings.Contains(lower, "/tests/") ||
		strings.Contains(lower, "/mocks/") ||
		strings.Contains(lower, "/fixtures/") {
		return true
	}
	return false
}

func extractGoSymbols(filePath string) []string {
	fset := token.NewFileSet()
	node, err := parser.ParseFile(fset, filePath, nil, parser.ParseComments)
	if err != nil {
		return nil
	}

	var structs []string
	var funcs []string

	for _, decl := range node.Decls {
		switch d := decl.(type) {
		case *ast.GenDecl:
			if d.Tok == token.TYPE {
				for _, spec := range d.Specs {
					if ts, ok := spec.(*ast.TypeSpec); ok {
						if ast.IsExported(ts.Name.Name) {
							if _, isStruct := ts.Type.(*ast.StructType); isStruct {
								structs = append(structs, ts.Name.Name)
							}
						}
					}
				}
			}
		case *ast.FuncDecl:
			if ast.IsExported(d.Name.Name) {
				funcs = append(funcs, d.Name.Name)
			}
		}
	}

	if len(structs) > 3 {
		structs = structs[:3]
	}
	if len(funcs) > 5 {
		funcs = funcs[:5]
	}

	return append(structs, funcs...)
}

func run(args []string, stdout, stderr io.Writer) error {
	flags := flag.NewFlagSet("jev-graph", flag.ContinueOnError)
	flags.SetOutput(stderr)
	rootDir := flags.String("root", ".", "Project root directory")
	outPath := flags.String("out", "", "Output path for Trie-Folded DSL (optional)")
	quiet := flags.Bool("quiet", false, "Suppress stdout stats")
	if err := flags.Parse(args); err != nil {
		if err == flag.ErrHelp {
			return nil
		}
		return err
	}

	rootInfo, err := os.Stat(*rootDir)
	if err != nil {
		return fmt.Errorf("invalid root %q: %w", *rootDir, err)
	}
	if !rootInfo.IsDir() {
		return fmt.Errorf("invalid root %q: not a directory", *rootDir)
	}

	t0 := time.Now()
	dirClusters := make(map[string][]string)
	totalFiles := 0
	totalSymbols := 0

	err = filepath.Walk(*rootDir, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info == nil {
			return fmt.Errorf("missing file info for %s", path)
		}
		rel, err := filepath.Rel(*rootDir, path)
		if err != nil {
			return err
		}
		if rel == "." {
			return nil
		}

		if info.IsDir() {
			if strings.HasPrefix(info.Name(), ".") || ignoreDirs[info.Name()] {
				return filepath.SkipDir
			}
			return nil
		}

		if isTestFile(rel) {
			return nil
		}

		ext := strings.ToLower(filepath.Ext(info.Name()))
		if ext == ".go" {
			// Surface read errors instead of silently producing an incomplete graph.
			if _, err := os.ReadFile(path); err != nil {
				return err
			}
			symbols := extractGoSymbols(path)
			if len(symbols) > 0 {
				dir := filepath.ToSlash(filepath.Dir(rel))
				if dir == "." {
					dir = ""
				}
				clusterKey := dir
				if clusterKey == "" {
					clusterKey = "."
				}
				dirClusters[clusterKey] = append(dirClusters[clusterKey], fmt.Sprintf("%s->%s", info.Name(), strings.Join(symbols, " ")))
				totalFiles++
				totalSymbols += len(symbols)
			}
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("walk %q: %w", *rootDir, err)
	}

	var sortedDirs []string
	for d := range dirClusters {
		sortedDirs = append(sortedDirs, d)
	}
	sort.Strings(sortedDirs)

	var lines []string
	for _, d := range sortedDirs {
		lines = append(lines, fmt.Sprintf("[%s]", d))
		flist := dirClusters[d]
		sort.Strings(flist)
		for _, fitem := range flist {
			lines = append(lines, fmt.Sprintf("  %s", fitem))
		}
	}

	dsl := strings.Join(lines, "\n")
	duration := time.Since(t0)

	if *outPath != "" {
		if err := os.MkdirAll(filepath.Dir(*outPath), 0755); err != nil {
			return fmt.Errorf("create output directory: %w", err)
		}
		if err := os.WriteFile(*outPath, []byte(dsl), 0644); err != nil {
			return fmt.Errorf("write output: %w", err)
		}
	}

	if !*quiet {
		if _, err := fmt.Fprintf(stderr, "⚡ [Native Jev Graph Extractor] %d files, %d symbols in %v (~%d tokens)\n",
			totalFiles, totalSymbols, duration, len(dsl)/4); err != nil {
			return fmt.Errorf("write stats: %w", err)
		}
	}

	if *outPath == "" {
		if _, err := fmt.Fprintln(stdout, dsl); err != nil {
			return fmt.Errorf("write output: %w", err)
		}
	}
	return nil
}

func main() {
	if err := run(os.Args[1:], os.Stdout, os.Stderr); err != nil {
		fmt.Fprintf(os.Stderr, "jev-graph: %v\n", err)
		os.Exit(1)
	}
}
