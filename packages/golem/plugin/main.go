package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

type options struct {
	cwd         string
	emit        bool
	noEmit      bool
	outDir      string
	tsconfig    string
	pluginsJSON string
	serde       bool
	nest        bool
}

type transformResult struct {
	Diagnostics []any             `json:"diagnostics,omitempty"`
	TypeScript  map[string]string `json:"typescript"`
}

var serdeImport = regexp.MustCompile(`import \{([^}]+)\} from '@exprtlabs/golem/serde';`)
var namedImport = regexp.MustCompile(`(?m)^import\s+(type\s+)?\{([^}]+)\}\s+from\s+('[^']+'|"[^"]+")\s*;?\s*$`)

func main() {
	os.Exit(run(os.Args[1:]))
}

func run(args []string) int {
	if len(args) == 0 {
		fmt.Fprintln(os.Stderr, "ttsc-plugin-iobject-serde: command required")
		return 2
	}
	switch args[0] {
	case "version", "-v", "--version":
		fmt.Fprintln(os.Stdout, "ttsc-plugin-iobject-serde 1.0.0-rc")
		return 0
	case "check":
		return runCheck(args[1:])
	case "transform":
		return runTransform(args[1:])
	case "build":
		return runBuild(args[1:])
	default:
		fmt.Fprintf(os.Stderr, "ttsc-plugin-iobject-serde: unknown command %q\n", args[0])
		return 2
	}
}

func runBuild(args []string) int {
	opts, ok := parseOptions("build", args)
	if !ok {
		return 2
	}
	prog, ok := loadProgram(opts)
	if !ok {
		return 2
	}
	rewritten, unresolved := rewriteProgramSources(opts.cwd, prog, opts.serde, opts.nest)
	failed := reportProgramDiagnostics(prog, opts.cwd)
	if printUnresolved(unresolved) != 0 || failed || opts.noEmit {
		prog.Close()
		if failed || len(unresolved) > 0 {
			return 2
		}
		return 0
	}
	emitProg := prog
	if overlay := overlayRewrites(prog, rewritten); overlay != nil {
		prog.Close()
		emitProg, ok = loadProgramFS(opts, overlay)
		if !ok {
			return 2
		}
	}
	defer emitProg.Close()
	_, emitDiags, err := emitProg.EmitAllRaw(nil)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ttsc-plugin-iobject-serde: emit failed: %v\n", err)
		return 3
	}
	driver.WritePrettyDiagnostics(os.Stderr, emitDiags, opts.cwd)
	if driver.CountErrors(emitDiags) > 0 {
		return 2
	}
	return 0
}

// reportProgramDiagnostics prints the source program's option, global, syntactic
// and semantic diagnostics as TypeScript does (path:line:col and TS code), before
// any rewrite, and reports whether one is an error. Errors block emit, matching
// ttsc's own noEmitOnError default for builds without a transform plugin.
func reportProgramDiagnostics(prog *driver.Program, cwd string) bool {
	diagnostics := prog.Diagnostics()
	driver.WritePrettyDiagnostics(os.Stderr, diagnostics, cwd)
	return driver.CountErrors(diagnostics) > 0
}

func runTransform(args []string) int {
	opts, ok := parseOptions("transform", args)
	if !ok {
		return 2
	}
	prog, ok := loadProgram(opts)
	if !ok {
		return 2
	}
	defer prog.Close()
	out := transformResult{TypeScript: map[string]string{}}
	rewritten, unresolved := rewriteProgramSources(opts.cwd, prog, opts.serde, opts.nest)
	if code := printUnresolved(unresolved); code != 0 {
		return code
	}
	for _, file := range prog.SourceFiles() {
		if file == nil || file.IsDeclarationFile {
			continue
		}
		out.TypeScript[outputKey(opts.cwd, file.FileName())] = rewritten[file.FileName()]
	}
	data, err := json.Marshal(out)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ttsc-plugin-iobject-serde: transform marshal failed: %v\n", err)
		return 3
	}
	fmt.Fprintln(os.Stdout, string(data))
	return 0
}

type rewriteEnv struct {
	keys    codecKeys
	checker *shimchecker.Checker
	file    *shimast.SourceFile
	cwd     string
	classes map[string]bool
	serde   bool
	nest    bool
}

func (env rewriteEnv) resolve(ident string) string {
	return env.keys.resolve(ident, env.checker, env.file, env.cwd)
}

func printUnresolved(errs []string) int {
	if len(errs) == 0 {
		return 0
	}
	for _, err := range errs {
		fmt.Fprintln(os.Stderr, err)
	}
	return 2
}

func importedIdent(text, ident string) bool {
	for _, match := range namedImport.FindAllStringSubmatch(text, -1) {
		if strings.TrimSpace(match[1]) == "type" {
			continue
		}
		for _, part := range strings.Split(match[2], ",") {
			binding := strings.TrimSpace(part)
			if strings.HasPrefix(binding, "type ") {
				continue
			}
			if alias := strings.Split(binding, " as "); len(alias) == 2 {
				binding = strings.TrimSpace(alias[1])
			}
			if binding == ident {
				return true
			}
		}
	}
	return false
}

func importStmtFor(source, ident string) string {
	for _, match := range namedImport.FindAllStringSubmatch(source, -1) {
		from := match[3]
		importTypeOnly := strings.TrimSpace(match[1]) == "type"
		for _, part := range strings.Split(match[2], ",") {
			binding := strings.TrimSpace(part)
			if binding == "" {
				continue
			}
			specifierTypeOnly := strings.HasPrefix(binding, "type ")
			binding = strings.TrimSpace(strings.TrimPrefix(binding, "type "))
			exportedName := binding
			localName := binding
			if alias := strings.Split(binding, " as "); len(alias) == 2 {
				exportedName = strings.TrimSpace(alias[0])
				localName = strings.TrimSpace(alias[1])
			}
			if localName == ident && (importTypeOnly || specifierTypeOnly) {
				valueSpecifier := exportedName
				if localName != exportedName {
					valueSpecifier += " as " + localName
				}
				return "import { " + valueSpecifier + " } from " + from + ";"
			}
		}
	}
	return ""
}

func constructOptionEdits(text string, call *shimast.CallExpression, ident string) []sourceEdit {
	if ident == "" || call.Arguments == nil {
		return nil
	}
	args := call.Arguments.Nodes
	if len(args) == 0 {
		return nil
	}
	if len(args) == 1 {
		at := args[0].End()
		return []sourceEdit{{at, at, ", { construct: " + ident + " }"}}
	}
	second := args[1]
	start, end := skipTrivia(text, second.Pos()), second.End()
	if strings.Contains(text[start:end], "construct:") {
		return nil
	}
	// Boundary insertions preserve any serde calls nested inside the options.
	return []sourceEdit{{start, start, "{ ..."}, {end, end, ", construct: " + ident + " }"}}
}

func registerIModelClassEdits(text string, env rewriteEnv) []sourceEdit {
	if env.file == nil {
		return nil
	}
	type placement struct {
		name string
		id   string
		end  int
	}
	var places []placement
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		if node.Kind == shimast.KindClassDeclaration && classExtendsGeneratedBase(env.checker, node) {
			name := declarationName(node)
			id := env.resolve(name)
			if name != "" && id != "" {
				places = append(places, placement{name: name, id: id, end: node.End()})
			}
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(env.file.AsNode())
	var edits []sourceEdit
	for _, place := range places {
		stmt := fmt.Sprintf("registerIModelClass(%q, %s);", place.id, place.name)
		if strings.Contains(text, stmt) || place.end < 0 || place.end > len(text) {
			continue
		}
		edits = append(edits, sourceEdit{place.end, place.end, "\n" + stmt})
	}
	return edits
}

func classIdents(checker *shimchecker.Checker, file *shimast.SourceFile) map[string]bool {
	found := map[string]bool{}
	if file == nil {
		return found
	}
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		switch node.Kind {
		case shimast.KindClassDeclaration:
			if name := declarationName(node); name != "" && classExtendsGeneratedBase(checker, node) {
				found[name] = true
			}
		case shimast.KindImportSpecifier:
			if !importSpecifierTypeOnly(node) {
				if name := declarationName(node); name != "" && isGeneratedModelClass(checker, node) {
					found[name] = true
				}
			}
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(file.AsNode())
	return found
}

func declarationName(node *shimast.Node) string {
	if node == nil {
		return ""
	}
	if symbol := node.Symbol(); symbol != nil && symbol.Name != "" && symbol.Name != "__class" {
		return symbol.Name
	}
	switch node.Kind {
	case shimast.KindClassDeclaration:
		return identifierText(node.AsClassDeclaration().Name())
	case shimast.KindImportSpecifier:
		return identifierText(node.AsImportSpecifier().Name())
	}
	return ""
}

// identifierText returns an Identifier's text and "" for any other node. typescript-go's
// AsX accessors panic on a node of another kind, so every access checks Kind first.
func identifierText(node *shimast.Node) string {
	if node == nil || node.Kind != shimast.KindIdentifier {
		return ""
	}
	return node.AsIdentifier().Text
}

func importSpecifierTypeOnly(node *shimast.Node) bool {
	if node.IsTypeOnly() {
		return true
	}
	for parent := node.Parent; parent != nil; parent = parent.Parent {
		if parent.Kind == shimast.KindImportClause {
			return parent.IsTypeOnly()
		}
	}
	return false
}

// generatedModelModule matches golem-model companions (`x.model.generated.ts`,
// `x.models.generated.ts`, the shared `models.generated.ts`) and their emitted JS and .d.ts.
var generatedModelModule = regexp.MustCompile(`(?:^|[/\\.])models?\.generated\.(?:d\.)?[cm]?[jt]s$`)

// classExtendsGeneratedBase reports whether a class declaration directly extends a
// generated model base: an `XBase` class declared in a generated model module.
func classExtendsGeneratedBase(checker *shimchecker.Checker, node *shimast.Node) bool {
	if checker == nil || node == nil || node.Kind != shimast.KindClassDeclaration {
		return false
	}
	decl := node.AsClassDeclaration()
	if decl.HeritageClauses == nil {
		return false
	}
	for _, clauseNode := range decl.HeritageClauses.Nodes {
		if clauseNode == nil || clauseNode.Kind != shimast.KindHeritageClause {
			continue
		}
		clause := clauseNode.AsHeritageClause()
		if clause.Token != shimast.KindExtendsKeyword || clause.Types == nil {
			continue
		}
		for _, typeNode := range clause.Types.Nodes {
			if typeNode == nil || typeNode.Kind != shimast.KindExpressionWithTypeArguments {
				continue
			}
			if isGeneratedBaseExpression(checker, typeNode.AsExpressionWithTypeArguments().Expression) {
				return true
			}
		}
	}
	return false
}

// isGeneratedBaseExpression resolves `Base` or `ns.Base`; calls such as `Mixin(Base)` never qualify.
func isGeneratedBaseExpression(checker *shimchecker.Checker, expression *shimast.Node) bool {
	expression = unwrapParentheses(expression)
	if expression == nil || (expression.Kind != shimast.KindIdentifier && expression.Kind != shimast.KindPropertyAccessExpression) {
		return false
	}
	symbol := symbolAt(checker, expression)
	if symbol == nil || symbol.Flags&shimast.SymbolFlagsClass == 0 || !strings.HasSuffix(symbol.Name, "Base") {
		return false
	}
	for _, declaration := range symbol.Declarations {
		if declaration == nil || declaration.Kind != shimast.KindClassDeclaration {
			continue
		}
		if source := shimast.GetSourceFileOfNode(declaration); source != nil && generatedModelModule.MatchString(source.FileName()) {
			return true
		}
	}
	return false
}

func isGeneratedModelClass(checker *shimchecker.Checker, node *shimast.Node) bool {
	if checker == nil || node == nil {
		return false
	}
	// An import specifier declares its alias symbol; other nodes resolve at their location.
	symbol := node.Symbol()
	if symbol == nil {
		symbol = checker.GetSymbolAtLocation(node)
	}
	if symbol == nil {
		return false
	}
	if symbol.Flags&shimast.SymbolFlagsAlias != 0 {
		if aliased := shimchecker.Checker_getAliasedSymbol(checker, symbol); aliased != nil {
			symbol = aliased
		}
	}
	if symbol.Flags&shimast.SymbolFlagsClass == 0 {
		return false
	}
	for _, declaration := range symbol.Declarations {
		if declaration != nil && declaration.Kind == shimast.KindClassDeclaration && classExtendsGeneratedBase(checker, declaration) {
			return true
		}
	}
	return false
}

// modelName matches packages/golem/src/model-name.ts. Plugin tests lock the same examples.
func modelName(alias string) string {
	withoutPrefix := alias
	if len(alias) >= 2 && alias[0] == 'T' && alias[1] >= 'A' && alias[1] <= 'Z' {
		withoutPrefix = alias[1:]
	}
	if strings.HasSuffix(withoutPrefix, "Model") && len(withoutPrefix) > 5 {
		return withoutPrefix[:len(withoutPrefix)-5]
	}
	return withoutPrefix
}

func ensureSerdeImport(text string) string {
	body := serdeImport.ReplaceAllString(text, "")
	keep := []string{}
	seen := map[string]struct{}{}
	add := func(name string) {
		if _, exists := seen[name]; exists {
			return
		}
		keep = append(keep, name)
		seen[name] = struct{}{}
	}
	if strings.Contains(body, "requireObjectCodec") {
		add("requireObjectCodec")
	}
	if strings.Contains(body, "registerIModelClass") {
		add("registerIModelClass")
	}
	loc := serdeImport.FindStringSubmatch(text)
	if len(loc) == 2 {
		for _, name := range strings.Split(loc[1], ",") {
			trimmed := strings.TrimSpace(name)
			if trimmed == "" {
				continue
			}
			ident := trimmed
			if strings.HasPrefix(ident, "type ") {
				ident = strings.TrimSpace(strings.TrimPrefix(ident, "type "))
			}
			if alias := strings.Split(ident, " as "); len(alias) == 2 {
				ident = strings.TrimSpace(alias[1])
			}
			if _, exists := seen[ident]; exists {
				continue
			}
			if regexp.MustCompile(`\b` + regexp.QuoteMeta(ident) + `\b`).MatchString(body) {
				add(trimmed)
			}
		}
		if len(keep) == 0 {
			return serdeImport.ReplaceAllString(text, "")
		}
		return serdeImport.ReplaceAllString(text, "import { "+strings.Join(keep, ", ")+" } from '@exprtlabs/golem/serde';")
	}
	if len(keep) == 0 {
		return text
	}
	return "import { " + strings.Join(keep, ", ") + " } from '@exprtlabs/golem/serde';\n" + text
}

func runCheck(args []string) int {
	opts, ok := parseOptions("check", args)
	if !ok {
		return 2
	}
	prog, ok := loadProgram(opts)
	if !ok {
		return 2
	}
	defer prog.Close()
	_, unresolved := rewriteProgramSources(opts.cwd, prog, opts.serde, opts.nest)
	failed := reportProgramDiagnostics(prog, opts.cwd)
	if printUnresolved(unresolved) != 0 || failed {
		return 2
	}
	if opts.nest {
		return checkNestCodecs(opts.cwd, prog)
	}
	return 0
}

func parseOptions(command string, args []string) (options, bool) {
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	cwd := fs.String("cwd", "", "project directory")
	emit := fs.Bool("emit", false, "force emit")
	noEmit := fs.Bool("noEmit", false, "force no emit")
	outDir := fs.String("outDir", "", "emit directory override")
	tsconfig := fs.String("tsconfig", "tsconfig.json", "project tsconfig")
	pluginsJSON := fs.String("plugins-json", "", "ttsc plugin metadata")
	_ = fs.Bool("quiet", true, "suppress summary")
	_ = fs.Bool("verbose", false, "print summary")
	if err := fs.Parse(filterHostArgs(args, fs)); err != nil {
		return options{}, false
	}
	root := *cwd
	if root == "" {
		var err error
		root, err = os.Getwd()
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return options{}, false
		}
	}
	if !filepath.IsAbs(root) {
		abs, err := filepath.Abs(root)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			return options{}, false
		}
		root = abs
	}
	serde, nest := pluginFeatures(*pluginsJSON)
	return options{
		cwd:         filepath.Clean(root),
		emit:        *emit,
		noEmit:      *noEmit,
		outDir:      *outDir,
		tsconfig:    *tsconfig,
		pluginsJSON: *pluginsJSON,
		serde:       serde,
		nest:        nest,
	}, true
}

var valueFlags = map[string]bool{
	"--cwd":          true,
	"--tsconfig":     true,
	"--outDir":       true,
	"--plugins-json": true,
}

func filterHostArgs(args []string, fs *flag.FlagSet) []string {
	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			out = append(out, a)
			continue
		}
		name, _, hasEq := strings.Cut(a, "=")
		if fs.Lookup(strings.TrimLeft(name, "-")) != nil {
			out = append(out, a)
			if !hasEq && valueFlags[name] && i+1 < len(args) {
				out = append(out, args[i+1])
				i++
			}
			continue
		}
		if !hasEq && valueFlags[name] && i+1 < len(args) {
			i++
		}
	}
	return out
}

func overlayRewrites(prog *driver.Program, rewritten map[string]string) *driver.OverlayFS {
	var overlay *driver.OverlayFS
	for _, file := range prog.SourceFiles() {
		if file == nil {
			continue
		}
		next, ok := rewritten[file.FileName()]
		if !ok || next == file.Text() {
			continue
		}
		if overlay == nil {
			overlay = driver.NewOverlayFS(driver.DefaultFS())
		}
		overlay.Set(file.FileName(), next)
	}
	return overlay
}

func loadProgram(opts options) (*driver.Program, bool) {
	return loadProgramFS(opts, nil)
}

func loadProgramFS(opts options, overlay *driver.OverlayFS) (*driver.Program, bool) {
	load := driver.LoadProgramOptions{
		ForceEmit:   opts.emit,
		ForceNoEmit: opts.noEmit,
		OutDir:      opts.outDir,
	}
	if overlay != nil {
		load.FS = overlay
	}
	prog, parseDiags, err := driver.LoadProgram(opts.cwd, opts.tsconfig, load)
	if err != nil {
		fmt.Fprintf(os.Stderr, "ttsc-plugin-iobject-serde: %v\n", err)
		return nil, false
	}
	if len(parseDiags) > 0 {
		driver.WritePrettyDiagnostics(os.Stderr, parseDiags, opts.cwd)
		prog.Close()
		return nil, false
	}
	return prog, true
}

func outputKey(cwd, fileName string) string {
	rel, err := filepath.Rel(cwd, fileName)
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return filepath.ToSlash(fileName)
	}
	return filepath.ToSlash(rel)
}
