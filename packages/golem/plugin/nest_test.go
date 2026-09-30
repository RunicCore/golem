package main

import (
	"encoding/json"
	"testing"
)

func TestPluginFeaturesReadsSerdeOption(t *testing.T) {
	cases := []struct {
		plugin    string
		serde     any
		wantSerde bool
		wantNest  bool
	}{
		{codegenPluginName, nil, true, false},
		{codegenPluginName, true, true, false},
		{codegenPluginName, false, false, false},
		{nestPluginName, nil, true, true},
		{nestPluginName, true, true, true},
		{nestPluginName, false, false, true},
	}
	for _, c := range cases {
		config := map[string]any{"transform": c.plugin}
		if c.serde != nil {
			config["serde"] = c.serde
		}
		raw, err := json.Marshal([]pluginManifestEntry{{Name: c.plugin, Config: config}})
		if err != nil {
			t.Fatal(err)
		}
		serde, nest := pluginFeatures(string(raw))
		if serde != c.wantSerde || nest != c.wantNest {
			t.Errorf("pluginFeatures(%s) = serde %v, nest %v; want serde %v, nest %v", raw, serde, nest, c.wantSerde, c.wantNest)
		}
	}
}
