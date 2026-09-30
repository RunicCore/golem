package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	shimast "github.com/microsoft/typescript-go/shim/ast"
	"github.com/samchon/ttsc/packages/ttsc/driver"
)

const codegenPluginName = "@exprtlabs/golem/ttsc-plugin"
const nestPluginName = "@exprtlabs/golem-ts-openapi/ttsc-plugin"
const defaultOperationCodecRegistry = "src/generated/operation-codecs.ts"

var nestImport = regexp.MustCompile(`import \{([^}]+)\} from ['"]@exprtlabs/golem/nest['"];`)

var primitiveIdents = map[string]bool{
	"void": true, "undefined": true, "null": true, "never": true, "any": true,
	"unknown": true, "object": true, "string": true, "number": true, "boolean": true,
	"bigint": true, "symbol": true, "Date": true, "Buffer": true, "Blob": true,
	"Promise": true, "Array": true, "Record": true, "Map": true, "Set": true,
}

type pluginManifestEntry struct {
	Name   string         `json:"name"`
	Config map[string]any `json:"config"`
}

func pluginFeatures(raw string) (serde bool, nest bool) {
	if strings.TrimSpace(raw) == "" {
		return true, false
	}
	var entries []pluginManifestEntry
	if err := json.Unmarshal([]byte(raw), &entries); err != nil || len(entries) == 0 {
		return true, false
	}
	recognized := false
	for _, entry := range entries {
		transform, _ := entry.Config["transform"].(string)
		serdeOn, serdeSet := boolField(entry.Config, "serde")
		nestOn, nestSet := boolField(entry.Config, "nest")
		isCodegen := transform == codegenPluginName || entry.Name == codegenPluginName
		isNest := transform == nestPluginName || entry.Name == nestPluginName || (nestSet && nestOn)
		if isCodegen || isNest {
			recognized = true
		}
		if !serdeSet || serdeOn {
			serde = true
		}
		if isNest {
			nest = true
		}
	}
	if !recognized {
		return true, false
	}
	return serde, nest
}

func boolField(config map[string]any, name string) (bool, bool) {
	value, ok := config[name]
	if !ok {
		return false, false
	}
	flag, ok := value.(bool)
	return flag, ok
}

func checkNestCodecs(cwd string, prog *driver.Program) int {
	expectedPath := filepath.Join(cwd, filepath.FromSlash(defaultOperationCodecRegistry))
	expected, err := os.ReadFile(expectedPath)
	missingRegistry := err != nil
	keys := loadCodecKeys(prog, cwd)
	var unresolved []string
	for _, file := range prog.SourceFiles() {
		if file == nil || file.IsDeclarationFile {
			continue
		}
		env := rewriteEnv{keys: keys, checker: prog.Checker, file: file, cwd: cwd, nest: true}
		unresolved = append(unresolved, collectNestUnresolved(env)...)
		for _, param := range collectNestParams(file) {
			id, primitive, _ := env.nestBinding(param)
			if param.hasCodec || primitive || id == "" {
				continue
			}
			if missingRegistry || !strings.Contains(string(expected), fmt.Sprintf("%q", id)) {
				fmt.Fprintf(os.Stderr, "ttsc-plugin-iobject-serde: %s @%s() type %s disagrees with generated operation keys\n", callSpan(cwd, file, param.typeNode), param.decorator, param.label)
				return 2
			}
		}
	}
	return printUnresolved(unresolved)
}

func collectNestUnresolved(env rewriteEnv) []string {
	var errs []string
	for _, param := range collectNestParams(env.file) {
		id, primitive, known := env.nestBinding(param)
		if param.hasCodec || primitive {
			continue
		}
		if id == "" && known {
			errs = append(errs, fmt.Sprintf("ttsc-plugin-iobject-serde: %s @%s() type %s has no unique hashed codec id", callSpan(env.cwd, env.file, param.typeNode), param.decorator, param.label))
		}
	}
	return errs
}

func nestDecoratorEdits(env rewriteEnv) []sourceEdit {
	var inserts []sourceEdit
	for _, param := range collectNestParams(env.file) {
		id, primitive, _ := env.nestBinding(param)
		if param.hasCodec || primitive || id == "" {
			continue
		}
		inserts = append(inserts, sourceEdit{param.nameStart, param.nameStart, fmt.Sprintf("@nestModelCodec(%q) ", id)})
	}
	for _, method := range collectNestReturns(env.file) {
		id, primitive, _ := env.nestBinding(nestParam{label: method.label, typeNode: method.model})
		if method.hasReturn || primitive || id == "" {
			continue
		}
		call := fmt.Sprintf("@nestModelReturn(%q) ", id)
		if method.array {
			call = fmt.Sprintf("@nestModelReturn(%q, true) ", id)
		}
		inserts = append(inserts, sourceEdit{method.insertAt, method.insertAt, call})
	}
	return inserts
}

type nestParam struct {
	decorator string
	label     string
	typeNode  *shimast.Node
	nameStart int
	hasCodec  bool
}

func (env rewriteEnv) nestBinding(param nestParam) (id string, primitive bool, known bool) {
	model := nestModelTypeNode(param.typeNode)
	if model == nil {
		return "", true, false
	}
	label := typeNodeText(env.file, model)
	if label == "" {
		label = param.label
	}
	if primitiveIdents[lastTypeName(label)] {
		return "", true, false
	}
	resolved, supported := env.keys.resolveType(env.checker, model, env.cwd)
	if !supported {
		return "", false, false
	}
	if resolved != "" {
		return resolved, false, true
	}
	nameNode, ok := serdeTypeName(model)
	if !ok {
		return "", false, false
	}
	symbol := symbolAt(env.checker, nameNode)
	if symbol == nil {
		return "", false, false
	}
	return "", false, env.keys.known(symbol.Name)
}

func collectNestParams(file *shimast.SourceFile) []nestParam {
	if file == nil {
		return nil
	}
	var out []nestParam
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		if node.Kind == shimast.KindParameter {
			if param := nestParamAt(file, node); param != nil {
				out = append(out, *param)
			}
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(file.AsNode())
	return out
}

func nestParamAt(file *shimast.SourceFile, node *shimast.Node) *nestParam {
	if node == nil || node.Kind != shimast.KindParameter {
		return nil
	}
	decl := node.AsParameterDeclaration()
	if decl.Type == nil {
		return nil
	}
	decorator := ""
	hasCodec := false
	modifiers := node.Modifiers()
	if modifiers != nil {
		for _, modifier := range modifiers.Nodes {
			name, ok := decoratorCallName(modifier)
			if !ok {
				continue
			}
			switch name {
			case "Body", "Query":
				if decorator == "" {
					decorator = name
				}
			case "nestModelCodec":
				hasCodec = true
			}
		}
	}
	if decorator == "" {
		return nil
	}
	name := node.Name()
	if name == nil {
		return nil
	}
	text := file.Text()
	nameStart := skipTrivia(text, name.Pos())
	if nameStart < 0 || nameStart > len(text) {
		return nil
	}
	return &nestParam{
		decorator: decorator,
		label:     typeNodeText(file, nestModelTypeNode(decl.Type)),
		typeNode:  decl.Type,
		nameStart: nameStart,
		hasCodec:  hasCodec,
	}
}

func decoratorCallName(node *shimast.Node) (string, bool) {
	if node == nil || node.Kind != shimast.KindDecorator {
		return "", false
	}
	expr := node.AsDecorator().Expression
	if expr != nil && expr.Kind == shimast.KindCallExpression {
		expr = expr.AsCallExpression().Expression
	}
	if expr == nil {
		return "", false
	}
	switch expr.Kind {
	case shimast.KindIdentifier:
		return expr.AsIdentifier().Text, true
	case shimast.KindPropertyAccessExpression:
		if name := identifierText(expr.AsPropertyAccessExpression().Name()); name != "" {
			return name, true
		}
	}
	return "", false
}

type nestReturn struct {
	label     string
	model     *shimast.Node
	insertAt  int
	array     bool
	hasReturn bool
}

func collectNestReturns(file *shimast.SourceFile) []nestReturn {
	if file == nil {
		return nil
	}
	var out []nestReturn
	var walk func(*shimast.Node)
	walk = func(node *shimast.Node) {
		if node == nil {
			return
		}
		if node.Kind == shimast.KindMethodDeclaration {
			if method := nestReturnAt(file, node); method != nil {
				out = append(out, *method)
			}
		}
		node.ForEachChild(func(child *shimast.Node) bool {
			walk(child)
			return false
		})
	}
	walk(file.AsNode())
	return out
}

func nestReturnAt(file *shimast.SourceFile, node *shimast.Node) *nestReturn {
	if node == nil || node.Kind != shimast.KindMethodDeclaration {
		return nil
	}
	method := node.AsMethodDeclaration()
	if method.Type == nil {
		return nil
	}
	model, array := nestReturnModel(method.Type)
	if model == nil {
		return nil
	}
	hasReturn := false
	if modifiers := node.Modifiers(); modifiers != nil {
		for _, modifier := range modifiers.Nodes {
			name, ok := decoratorCallName(modifier)
			if ok && name == "nestModelReturn" {
				hasReturn = true
			}
		}
	}
	text := file.Text()
	insertAt := skipTrivia(text, node.Pos())
	if insertAt < 0 || insertAt > len(text) {
		return nil
	}
	return &nestReturn{
		label:     typeNodeText(file, model),
		model:     model,
		insertAt:  insertAt,
		array:     array,
		hasReturn: hasReturn,
	}
}

func nestReturnModel(typeNode *shimast.Node) (model *shimast.Node, array bool) {
	node := typeNode
	for node != nil {
		switch node.Kind {
		case shimast.KindParenthesizedType:
			paren := node.AsParenthesizedTypeNode()
			if paren == nil {
				return nil, false
			}
			node = paren.Type
		case shimast.KindArrayType:
			arrayNode := node.AsArrayTypeNode()
			if arrayNode == nil {
				return nil, false
			}
			array = true
			node = arrayNode.ElementType
		case shimast.KindTypeOperator:
			operator := node.AsTypeOperatorNode()
			if operator == nil || operator.Type == nil || operator.Operator != shimast.KindReadonlyKeyword {
				return nil, false
			}
			node = operator.Type
		case shimast.KindUnionType:
			return nil, false
		case shimast.KindTypeReference:
			ref := node.AsTypeReferenceNode()
			if ref == nil || ref.TypeName == nil {
				return nil, false
			}
			if ref.TypeArguments != nil && len(ref.TypeArguments.Nodes) == 1 {
				name := typeNameText(ref.TypeName)
				switch {
				case name == "Promise" || strings.HasSuffix(name, ".Promise"):
					node = ref.TypeArguments.Nodes[0]
					continue
				case name == "Array" || name == "ReadonlyArray" || strings.HasSuffix(name, ".Array") || strings.HasSuffix(name, ".ReadonlyArray"):
					array = true
					node = ref.TypeArguments.Nodes[0]
					continue
				}
			}
			return node, array
		default:
			return node, array
		}
	}
	return nil, array
}

func nestModelTypeNode(typeNode *shimast.Node) *shimast.Node {
	node := typeNode
	for node != nil {
		switch node.Kind {
		case shimast.KindParenthesizedType:
			paren := node.AsParenthesizedTypeNode()
			if paren == nil {
				return nil
			}
			node = paren.Type
		case shimast.KindArrayType:
			array := node.AsArrayTypeNode()
			if array == nil {
				return nil
			}
			node = array.ElementType
		case shimast.KindTypeReference:
			ref := node.AsTypeReferenceNode()
			if ref == nil || ref.TypeName == nil {
				return nil
			}
			if ref.TypeArguments != nil && len(ref.TypeArguments.Nodes) == 1 {
				name := typeNameText(ref.TypeName)
				if name == "Array" || name == "ReadonlyArray" || strings.HasSuffix(name, ".Array") || strings.HasSuffix(name, ".ReadonlyArray") {
					node = ref.TypeArguments.Nodes[0]
					continue
				}
			}
			return node
		default:
			return node
		}
	}
	return nil
}

func typeNameText(node *shimast.Node) string {
	if node == nil {
		return ""
	}
	switch node.Kind {
	case shimast.KindIdentifier:
		return node.AsIdentifier().Text
	case shimast.KindQualifiedName:
		qualified := node.AsQualifiedName()
		right := identifierText(qualified.Right)
		left := typeNameText(qualified.Left)
		if left == "" {
			return right
		}
		return left + "." + right
	}
	return ""
}

func typeNodeText(file *shimast.SourceFile, node *shimast.Node) string {
	if file == nil || node == nil {
		return ""
	}
	text := file.Text()
	start := skipTrivia(text, node.Pos())
	end := node.End()
	if start < 0 || end > len(text) || start > end {
		return ""
	}
	return strings.TrimSpace(text[start:end])
}

func lastTypeName(text string) string {
	text = strings.TrimSpace(text)
	if i := strings.LastIndex(text, "."); i >= 0 {
		return text[i+1:]
	}
	return text
}

func ensureNestImport(text string) string {
	body := nestImport.ReplaceAllString(text, "")
	keep := []string{}
	seen := map[string]struct{}{}
	add := func(name string) {
		if _, exists := seen[name]; exists {
			return
		}
		keep = append(keep, name)
		seen[name] = struct{}{}
	}
	if strings.Contains(body, "nestModelCodec") {
		add("nestModelCodec")
	}
	if strings.Contains(body, "nestModelReturn") {
		add("nestModelReturn")
	}
	if strings.Contains(body, "nestModelStringifyInterceptor") {
		add("nestModelStringifyInterceptor")
	}
	loc := nestImport.FindStringSubmatch(text)
	if len(loc) == 2 {
		for _, name := range strings.Split(loc[1], ",") {
			trimmed := strings.TrimSpace(name)
			if trimmed == "" {
				continue
			}
			if _, exists := seen[trimmed]; exists {
				continue
			}
			if regexp.MustCompile(`\b` + regexp.QuoteMeta(trimmed) + `\b`).MatchString(body) {
				add(trimmed)
			}
		}
		if len(keep) == 0 {
			return nestImport.ReplaceAllString(text, "")
		}
		return nestImport.ReplaceAllString(text, "import { "+strings.Join(keep, ", ")+" } from '@exprtlabs/golem/nest';")
	}
	if len(keep) == 0 {
		return text
	}
	return "import { " + strings.Join(keep, ", ") + " } from '@exprtlabs/golem/nest';\n" + text
}
