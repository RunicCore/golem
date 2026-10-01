package main

import (
	"strings"
	"testing"
)

// A class links to its model by what it extends, so its name need not match the alias stem.
func TestClassNamedApartFromItsAliasRegistersThroughItsKeyEntry(t *testing.T) {
	prog, dir := loadTestProgram(t, map[string]string{
		"order.model.generated.ts": "export abstract class OrderBaseModel {}\n",
		"order.model.ts": `import { OrderBaseModel } from './order.model.generated.js';
export class PurchaseOrder extends OrderBaseModel {}
`,
		"iobject-plugin-keys.ts": `export const IOBJECT_PLUGIN_KEYS = {
  "order.model.ts#Order": "Order_aaaaaaaa",
  "order.model.ts#PurchaseOrder": "Order_aaaaaaaa",
} as const;
`,
	})
	rewritten, errs := rewriteProgramSources(dir, prog, true, true)
	if len(errs) > 0 {
		t.Fatalf("rewrite errors: %v", errs)
	}
	var text string
	for name, content := range rewritten {
		if strings.HasSuffix(name, "order.model.ts") {
			text = content
		}
	}
	want := `registerIModelClass("Order_aaaaaaaa", PurchaseOrder);`
	if !strings.Contains(text, want) {
		t.Fatalf("rewritten order.model.ts lacks %s:\n%s", want, text)
	}
}

func TestClassWithoutAKeyEntryRegistersNothing(t *testing.T) {
	prog, dir := loadTestProgram(t, map[string]string{
		"order.model.generated.ts": "export abstract class OrderBaseModel {}\n",
		"order.model.ts": `import { OrderBaseModel } from './order.model.generated.js';
export class PurchaseOrder extends OrderBaseModel {}
`,
		"iobject-plugin-keys.ts": `export const IOBJECT_PLUGIN_KEYS = {
  "order.model.ts#Order": "Order_aaaaaaaa",
} as const;
`,
	})
	rewritten, errs := rewriteProgramSources(dir, prog, true, true)
	if len(errs) > 0 {
		t.Fatalf("rewrite errors: %v", errs)
	}
	for name, content := range rewritten {
		if strings.Contains(content, "registerIModelClass(") {
			t.Fatalf("%s registers a class without a key entry:\n%s", name, content)
		}
	}
}
