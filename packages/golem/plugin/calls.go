package main

import (
	"fmt"
	"path/filepath"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	shimchecker "github.com/microsoft/typescript-go/shim/checker"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

var serdeMethods = map[string]string{
	"stringify":      "stringify",
	"parse":          "parse",
	"validate":       "validate",
	"assertValue":    "assert",
	"toWireFormat":   "toWireFormat",
	"fromWireFormat": "fromWireFormat",
}

type serdeCall struct {
	start       int
	open        int
	method      string
	codecID     string
	construct   string
	importStmt  string
	optionEdits []sourceEdit
}

func rewriteProgramSources(cwd string, prog *driver.Program, serde bool, nest bool) (map[string]string, []string) {
	keys := loadCodecKeys(prog, cwd)
	rewritten := map[string]string{}
	var errs []string
	for _, file := range prog.SourceFiles() {
		if file == nil || file.IsDeclarationFile {
			continue
		}
		env := rewriteEnv{
			keys:    keys,
			checker: prog.Checker,
			file:    file,
			cwd:     cwd,
			classes: classIdents(prog.Checker, file),
			serde:   serde,
			nest:    nest,
		}
		text, fileErrs := rewriteFile(file, env)
		errs = append(errs, fileErrs...)
		rewritten[file.FileName()] = text
	}
	return rewritten, errs
}

func rewriteFile(file *shimast.SourceFile, env rewriteEnv) (string, []string) {
	text := file.Text()
	var errs []string
	var calls []serdeCall
	var edits []sourceEdit
	if env.serde {
		var callErrs []string
		calls, callErrs = collectSerdeCalls(file, env)
		errs = append(errs, callErrs...)
		edits = append(edits, serdeCallEdits(calls)...)
		edits = append(edits, registerIModelClassEdits(text, env)...)
	}
	if env.nest {
		errs = append(errs, collectNestUnresolved(env)...)
		edits = append(edits, nestDecoratorEdits(env)...)
	}
	if len(errs) > 0 {
		return text, errs
	}
	var editErr error
	text, editErr = applySourceEdits(text, edits)
	if editErr != nil {
		return file.Text(), append(errs, editErr.Error())
	}
	if text == file.Text() {
		return text, errs
	}
	if env.serde {
		text = ensureSerdeImport(preserveConstructImports(text, calls))
	}
	if env.nest {
		text = ensureNestImport(text)
	}
	return text, errs
}

func collectSerdeCalls(file *shimast.SourceFile, env rewriteEnv) ([]serdeCall, []string) {
	var calls []serdeCall
	var errs []string
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		if node.Kind == shimast.KindCallExpression {
			if call, err := serdeCallAt(file, env, node); err != "" {
				errs = append(errs, err)
			} else if call != nil {
				calls = append(calls, *call)
			}
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(file.AsNode())
	return calls, errs
}

func serdeCallAt(file *shimast.SourceFile, env rewriteEnv, node *shimast.Node) (*serdeCall, string) {
	if node == nil || node.Kind != shimast.KindCallExpression {
		return nil, ""
	}
	call := node.AsCallExpression()
	if call.QuestionDotToken != nil || call.Expression == nil {
		return nil, ""
	}
	method, ok := serdeMethod(env.checker, call.Expression)
	if !ok {
		return nil, ""
	}
	typeArguments := 0
	if call.TypeArguments != nil {
		typeArguments = len(call.TypeArguments.Nodes)
	}
	if typeArguments == 0 {
		return nil, ""
	}
	text := file.Text()
	where := callSpan(env.cwd, file, node)
	if typeArguments != 1 {
		return nil, fmt.Sprintf("ttsc-plugin-iobject-serde: %s %s type argument must be a single type name or typeof expression", where, method)
	}
	typeNode := call.TypeArguments.Nodes[0]
	codecID, supported := env.keys.resolveType(env.checker, typeNode, env.cwd)
	if !supported {
		return nil, fmt.Sprintf("ttsc-plugin-iobject-serde: %s %s type argument must be a single type name or typeof expression", where, method)
	}
	if codecID == "" {
		shown := strings.TrimSpace(text[skipTrivia(text, typeNode.Pos()):typeNode.End()])
		return nil, fmt.Sprintf("ttsc-plugin-iobject-serde: %s %s<%s> has no unique hashed codec id", where, method, shown)
	}
	start := skipTrivia(text, call.Expression.Pos())
	open := callOpenParen(text, call)
	if start < 0 || open < start {
		return nil, fmt.Sprintf("ttsc-plugin-iobject-serde: %s %s call could not be rewritten", where, method)
	}
	construct := ""
	importStmt := ""
	if method == "parse" || method == "fromWireFormat" {
		if nameNode, ok := serdeTypeName(typeNode); ok {
			symbol := symbolAt(env.checker, nameNode)
			local := strings.TrimSpace(text[skipTrivia(text, nameNode.Pos()):nameNode.End()])
			keyedClass := symbol != nil && symbol.Flags&shimast.SymbolFlagsClass != 0 && codecID != ""
			if symbol != nil && (env.classes[local] || isGeneratedClassSymbol(env.checker, symbol) || keyedClass) && local != "" && !strings.ContainsAny(local, "\n\r") {
				construct = local
				importStmt = importStmtFor(text, local)
			}
		}
	}
	return &serdeCall{
		start:       start,
		open:        open,
		method:      method,
		codecID:     codecID,
		construct:   construct,
		importStmt:  importStmt,
		optionEdits: constructOptionEdits(text, call, construct),
	}, ""
}

func serdeCallEdits(calls []serdeCall) []sourceEdit {
	var edits []sourceEdit
	for _, call := range calls {
		replacement := fmt.Sprintf("requireObjectCodec(%q).%s(", call.codecID, call.method)
		edits = append(edits, sourceEdit{call.start, call.open + 1, replacement})
		edits = append(edits, call.optionEdits...)
	}
	return edits
}

func preserveConstructImports(text string, calls []serdeCall) string {
	seen := map[string]bool{}
	var extra []string
	for _, call := range calls {
		if call.construct == "" || call.importStmt == "" {
			continue
		}
		if importedIdent(text, call.construct) {
			continue
		}
		if seen[call.importStmt] {
			continue
		}
		seen[call.importStmt] = true
		extra = append(extra, call.importStmt)
	}
	if len(extra) == 0 {
		return text
	}
	return strings.Join(extra, "\n") + "\n" + text
}

func serdeMethod(checker *shimchecker.Checker, expression *shimast.Node) (string, bool) {
	symbol := symbolAt(checker, unwrapParentheses(expression))
	if symbol == nil {
		return "", false
	}
	method, ok := serdeMethods[symbol.Name]
	if !ok {
		return "", false
	}
	if symbol.Name == "validate" {
		if !symbolInGolemValidation(symbol) {
			return "", false
		}
		return method, true
	}
	if !symbolInGolemSerde(symbol) {
		return "", false
	}
	return method, true
}

func symbolAt(checker *shimchecker.Checker, node *shimast.Node) *shimast.Symbol {
	if checker == nil || node == nil {
		return nil
	}
	symbol := checker.GetSymbolAtLocation(node)
	if symbol == nil && node.Kind == shimast.KindQualifiedName {
		if qualified := node.AsQualifiedName(); qualified != nil {
			symbol = checker.GetSymbolAtLocation(qualified.Right)
		}
	}
	if symbol == nil && node.Kind == shimast.KindPropertyAccessExpression {
		if access := node.AsPropertyAccessExpression(); access != nil {
			symbol = checker.GetSymbolAtLocation(access.Name())
		}
	}
	return followImportAlias(checker, symbol)
}

func followImportAlias(checker *shimchecker.Checker, symbol *shimast.Symbol) *shimast.Symbol {
	if symbol != nil && symbol.Flags&shimast.SymbolFlagsAlias != 0 {
		if aliased := shimchecker.Checker_getAliasedSymbol(checker, symbol); aliased != nil {
			return aliased
		}
	}
	return symbol
}

func symbolInGolemSerde(symbol *shimast.Symbol) bool {
	if symbol == nil {
		return false
	}
	for _, declaration := range symbol.Declarations {
		if declaration == nil {
			continue
		}
		source := shimast.GetSourceFileOfNode(declaration)
		if source != nil && isGolemSerdeFile(source.FileName()) {
			return true
		}
	}
	return false
}

func isGolemPackageFile(filename string, bases ...string) bool {
	slash := filepath.ToSlash(filename)
	base := filepath.Base(slash)
	matched := false
	for _, candidate := range bases {
		if base == candidate {
			matched = true
			break
		}
	}
	if !matched {
		return false
	}
	return strings.Contains(slash, "@exprtlabs/golem/") || strings.Contains(slash, "/packages/golem/")
}

func isGolemSerdeFile(filename string) bool {
	return isGolemPackageFile(filename, "serde.ts", "serde.d.ts")
}

func symbolInGolemValidation(symbol *shimast.Symbol) bool {
	return symbolInPackageFiles(symbol, "validation.ts", "validation.d.ts")
}

func symbolInPackageFiles(symbol *shimast.Symbol, bases ...string) bool {
	if symbol == nil {
		return false
	}
	for _, declaration := range symbol.Declarations {
		if declaration == nil {
			continue
		}
		source := shimast.GetSourceFileOfNode(declaration)
		if source != nil && isGolemPackageFile(source.FileName(), bases...) {
			return true
		}
	}
	return false
}

func isGeneratedClassSymbol(checker *shimchecker.Checker, symbol *shimast.Symbol) bool {
	if symbol == nil || symbol.Flags&shimast.SymbolFlagsClass == 0 {
		return false
	}
	for _, declaration := range symbol.Declarations {
		if classExtendsGeneratedBase(checker, declaration) {
			return true
		}
	}
	return false
}

func unwrapParentheses(node *shimast.Node) *shimast.Node {
	for node != nil && node.Kind == shimast.KindParenthesizedExpression {
		expression := node.AsParenthesizedExpression()
		if expression == nil {
			return nil
		}
		node = expression.Expression
	}
	return node
}

func callOpenParen(text string, call *shimast.CallExpression) int {
	if call == nil || call.Arguments == nil {
		return -1
	}
	// The argument list starts after the opening parenthesis.
	pos := call.Arguments.Pos()
	if pos > len(text) {
		pos = len(text)
	}
	for pos > 0 {
		prev := pos - 1
		switch text[prev] {
		case ' ', '\t', '\n', '\r':
			pos = prev
			continue
		}
		if strings.HasSuffix(text[:pos], "*/") {
			start := strings.LastIndex(text[:pos-2], "/*")
			if start >= 0 {
				pos = start
				continue
			}
		}
		if text[prev] == '(' {
			return prev
		}
		break
	}
	return -1
}

func callSpan(cwd string, file *shimast.SourceFile, node *shimast.Node) string {
	text := file.Text()
	pos := skipTrivia(text, node.Pos())
	line, column := 1, 1
	if pos < 0 {
		pos = 0
	}
	if pos > len(text) {
		pos = len(text)
	}
	for i := 0; i < pos; i++ {
		if text[i] == '\n' {
			line++
			column = 1
			continue
		}
		column++
	}
	return fmt.Sprintf("%s:%d:%d:", outputKey(cwd, file.FileName()), line, column)
}

func skipTrivia(text string, pos int) int {
	if pos < 0 {
		pos = 0
	}
	for pos < len(text) {
		switch text[pos] {
		case ' ', '\t', '\n', '\r':
			pos++
			continue
		}
		if strings.HasPrefix(text[pos:], "//") {
			for pos < len(text) && text[pos] != '\n' {
				pos++
			}
			continue
		}
		if strings.HasPrefix(text[pos:], "/*") {
			end := strings.Index(text[pos:], "*/")
			if end < 0 {
				return pos
			}
			pos += end + 2
			continue
		}
		break
	}
	return pos
}
