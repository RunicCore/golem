package main

import (
	"strings"
	"testing"
)

// A class links to its model by what it extends, so its name need not match the alias stem.
func TestClassNamedApartFromItsAliasRegistersThroughItsKeyEntry(t *testing.T) {
	prog, dir := loadTestProgram(t, map[string]string{
		"order.model.generated.ts": "export abstract class TOrderBaseModel {}\n",
		"order.model.ts": `import { TOrderBaseModel } from './order.model.generated.js';
export class PurchaseOrder extends TOrderBaseModel {}
`,
		"iobject-plugin-keys.ts": `export const IOBJECT_PLUGIN_KEYS = {
  "order.model.ts#TOrder": "Order_aaaaaaaa",
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
		"order.model.generated.ts": "export abstract class TOrderBaseModel {}\n",
		"order.model.ts": `import { TOrderBaseModel } from './order.model.generated.js';
export class PurchaseOrder extends TOrderBaseModel {}
`,
		"iobject-plugin-keys.ts": `export const IOBJECT_PLUGIN_KEYS = {
  "order.model.ts#TOrder": "Order_aaaaaaaa",
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

// Names look up exactly: Payment and TPayment are two models, not one stripped name.
func TestAliasesThatDifferOnlyByPrefixResolveToTheirOwnCodecs(t *testing.T) {
	prog, dir := loadTestProgram(t, map[string]string{
		"payment.model.generated.ts": "export abstract class PaymentBaseModel {}\nexport abstract class TPaymentBaseModel {}\n",
		"payment.model.ts": `import { PaymentBaseModel, TPaymentBaseModel } from './payment.model.generated.js';
export class Payment extends PaymentBaseModel {}
export class Ledger extends TPaymentBaseModel {}
`,
		"iobject-plugin-keys.ts": `export const IOBJECT_PLUGIN_KEYS = {
  "payment.model.ts#Payment": "Payment_aaaaaaaa",
  "payment.model.ts#TPayment": "TPayment_bbbbbbbb",
  "payment.model.ts#Ledger": "TPayment_bbbbbbbb",
} as const;
`,
	})
	rewritten, errs := rewriteProgramSources(dir, prog, true, true)
	if len(errs) > 0 {
		t.Fatalf("rewrite errors: %v", errs)
	}
	var text string
	for name, content := range rewritten {
		if strings.HasSuffix(name, "payment.model.ts") {
			text = content
		}
	}
	for _, want := range []string{
		`registerIModelClass("Payment_aaaaaaaa", Payment);`,
		`registerIModelClass("TPayment_bbbbbbbb", Ledger);`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("rewritten payment.model.ts lacks %s:\n%s", want, text)
		}
	}
}

// Several classes extend one generated base: each registers under <id>#<class>, none as the default.
func TestSeveralLinkedClassesRegisterUnderTheirOwnKeys(t *testing.T) {
	prog, dir := loadTestProgram(t, map[string]string{
		"payment.model.generated.ts": "export abstract class TPaymentBaseModel {}\n",
		"payment.model.ts": `import { TPaymentBaseModel } from './payment.model.generated.js';
export class Payment extends TPaymentBaseModel {}
export class AdminPayment extends TPaymentBaseModel {}
export class RushPayment extends AdminPayment {}
`,
		"iobject-plugin-keys.ts": `export const IOBJECT_PLUGIN_KEYS = {
  "payment.model.ts#TPayment": "TPayment_aaaaaaaa",
  "payment.model.ts#Payment": "TPayment_aaaaaaaa",
  "payment.model.ts#AdminPayment": "TPayment_aaaaaaaa",
} as const;
`,
	})
	rewritten, errs := rewriteProgramSources(dir, prog, true, true)
	if len(errs) > 0 {
		t.Fatalf("rewrite errors: %v", errs)
	}
	var text string
	for name, content := range rewritten {
		if strings.HasSuffix(name, "payment.model.ts") {
			text = content
		}
	}
	for _, want := range []string{
		`registerIModelClass("TPayment_aaaaaaaa#Payment", Payment);`,
		`registerIModelClass("TPayment_aaaaaaaa#AdminPayment", AdminPayment);`,
	} {
		if !strings.Contains(text, want) {
			t.Fatalf("rewritten payment.model.ts lacks %s:\n%s", want, text)
		}
	}
	if strings.Contains(text, `registerIModelClass("TPayment_aaaaaaaa", `) || strings.Contains(text, "RushPayment);") {
		t.Fatalf("a default class or a subclass registered:\n%s", text)
	}
}
