package main

import (
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"testing"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

func writeFiles(t *testing.T, dir string, files map[string]string) {
	t.Helper()
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
}

func loadTestProgram(t *testing.T, files map[string]string) (*driver.Program, string) {
	t.Helper()
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"tsconfig.json": `{"compilerOptions":{"target":"ES2022","module":"ESNext","moduleResolution":"bundler","strict":true,"noEmit":true},"include":["*.ts"]}`,
	})
	writeFiles(t, dir, files)
	prog, diags, err := driver.LoadProgram(dir, filepath.Join(dir, "tsconfig.json"), driver.LoadProgramOptions{})
	if err != nil {
		t.Fatal(err)
	}
	if len(diags) > 0 {
		t.Fatalf("parse diagnostics: %v", diags)
	}
	t.Cleanup(func() { _ = prog.Close() })
	return prog, dir
}

func sourceFile(t *testing.T, prog *driver.Program, name string) *shimast.SourceFile {
	t.Helper()
	for _, file := range prog.SourceFiles() {
		if file != nil && filepath.Base(file.FileName()) == name {
			return file
		}
	}
	t.Fatalf("missing source file %s", name)
	return nil
}

func sortedKeys(set map[string]bool) []string {
	keys := []string{}
	for key := range set {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

var heritageFixture = map[string]string{
	"payment.model.generated.ts": "export abstract class PaymentBase {}\n",
	"fake.ts":                    "export class FakeBase {}\n",
	"ns.ts":                      "export class Thing {}\n",
	"lookalike.ts":               "export class Payment {}\n",
	"main.ts": `import { PaymentBase } from './payment.model.generated.js';
import * as generated from './payment.model.generated.js';
import { FakeBase } from './fake.js';
import * as ns from './ns.js';
function Mixin<T extends new (...args: any[]) => object>(Target: T) { return class extends Target {}; }
class Plain {}
export class WithError extends Error {}
export class WithNamespace extends ns.Thing {}
export class WithMixin extends Mixin(Plain) {}
export class WithParentheses extends (Plain) {}
export class NameOnlyBase extends FakeBase {}
export class Payment extends PaymentBase {}
export class Qualified extends generated.PaymentBase {}
`,
	"consumer.ts": `import { Payment, WithError } from './main.js';
export const values = [Payment, WithError];
`,
	"unrelated.ts": `import { Payment } from './lookalike.js';
export const value = new Payment();
`,
}

func TestGeneratedBaseDetectionHandlesEveryHeritageShape(t *testing.T) {
	prog, _ := loadTestProgram(t, heritageFixture)
	main := sourceFile(t, prog, "main.ts")
	got := map[string]bool{}
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node.Kind == shimast.KindClassDeclaration {
			got[declarationName(node)] = classExtendsGeneratedBase(prog.Checker, node)
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(main.AsNode())
	want := map[string]bool{
		"Plain": false, "WithError": false, "WithNamespace": false, "WithMixin": false,
		"WithParentheses": false, "NameOnlyBase": false, "Payment": true, "Qualified": true,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("classExtendsGeneratedBase = %v, want %v", got, want)
	}
}

func TestClassIdentsResolveImportsBySymbolNotName(t *testing.T) {
	prog, _ := loadTestProgram(t, heritageFixture)
	cases := map[string][]string{
		"main.ts":      {"Payment", "Qualified"},
		"consumer.ts":  {"Payment"},
		"unrelated.ts": {},
	}
	for name, want := range cases {
		if got := sortedKeys(classIdents(prog.Checker, sourceFile(t, prog, name))); !reflect.DeepEqual(got, want) {
			t.Errorf("classIdents(%s) = %v, want %v", name, got, want)
		}
	}
}

func TestRewriteToleratesNonIdentifierHeritageAndDecorators(t *testing.T) {
	files := map[string]string{}
	for name, text := range heritageFixture {
		files[name] = text
	}
	files["decorators.ts"] = `const ns = { Body: () => (_t: object, _k: string | symbol | undefined, _i: number) => {} };
declare namespace Types { type Item = { id: string } }
export class Controller {
  handle(@ns.Body() value: Types.Item, @((() => ns.Body())()) other: Types.Item[]): Types.Item { return value ?? other[0]; }
}
`
	prog, dir := loadTestProgram(t, files)
	// Declaration files (lib.d.ts classes such as `class X extends Error`) are walked too.
	rewritten, errs := rewriteProgramSources(dir, prog, true, true)
	if len(errs) > 0 {
		t.Fatalf("rewrite errors: %v", errs)
	}
	if len(rewritten) == 0 {
		t.Fatal("no files rewritten")
	}
}
