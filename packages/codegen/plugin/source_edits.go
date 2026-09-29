package main

import (
	"fmt"
	"sort"
)

// Every range refers to the original source. Wrappers use boundary insertions
// so edits inside their expressions remain independent.
type sourceEdit struct {
	start int
	end   int
	text  string
}

func applySourceEdits(text string, edits []sourceEdit) (string, error) {
	ordered := append([]sourceEdit(nil), edits...)
	sort.SliceStable(ordered, func(i, j int) bool {
		if ordered[i].start != ordered[j].start {
			return ordered[i].start > ordered[j].start
		}
		// Replace first, then insert before the replacement at the same offset.
		return ordered[i].end > ordered[j].end
	})
	boundary := len(text)
	for _, edit := range ordered {
		if edit.start < 0 || edit.end < edit.start || edit.end > boundary {
			return text, fmt.Errorf("ttsc-plugin-iobject-serde: conflicting source edit at %d:%d", edit.start, edit.end)
		}
		boundary = edit.start
	}
	for _, edit := range ordered {
		text = text[:edit.start] + edit.text + text[edit.end:]
	}
	return text, nil
}
