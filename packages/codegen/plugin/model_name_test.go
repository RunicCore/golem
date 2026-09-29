package main

import "testing"

func TestModelNameMatchesTypeScript(t *testing.T) {
	cases := map[string]string{
		"Payment":       "Payment",
		"TPayment":      "Payment",
		"PaymentModel":  "Payment",
		"TPaymentModel": "Payment",
		"Model":         "Model",
		"TModel":        "Model",
	}
	for alias, want := range cases {
		if got := modelName(alias); got != want {
			t.Errorf("modelName(%q) = %q, want %q", alias, got, want)
		}
	}
}
