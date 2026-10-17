package main

import (
	"os"
	"regexp"
	"strings"
	"testing"
)

func readUI(t *testing.T, name string) string {
	t.Helper()
	b, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// Nothing in the panel renders below the 12px project minimum.
func TestUINoTextBelow12px(t *testing.T) {
	small := regexp.MustCompile(`font(?:-size)?\s*:(?:[^;"'{}]*?\s)?(?:[0-9]|1[01])(?:\.\d+)?px`)
	for _, f := range []string{"index.html", "app.js", "tokens.css", "base.css", "enterprise.css"} {
		if m := small.FindAllString(readUI(t, f), 5); len(m) > 0 {
			t.Errorf("%s: font sizes below 12px: %v", f, m)
		}
	}
}

// White text sits on --ac-fill, which the default blue darkens to 5.5:1; a raw
// var(--ac) fill under --ac-on is 3.6:1.
func TestUIAccentFillUnderOnText(t *testing.T) {
	if !strings.Contains(readUI(t, "tokens.css"), "--ac-fill:") {
		t.Fatal("tokens.css must define --ac-fill")
	}
	raw := regexp.MustCompile(`background\s*:\s*var\(--ac\)\s*;\s*color\s*:\s*var\(--ac-on\)`)
	for _, f := range []string{"index.html", "tokens.css", "base.css", "enterprise.css"} {
		if raw.MatchString(readUI(t, f)) {
			t.Errorf("%s: --ac-on text on a raw var(--ac) fill; use var(--ac-fill)", f)
		}
	}
}

// Every text field in the static markup has an accessible name.
func TestUIFieldsHaveLabels(t *testing.T) {
	html := readUI(t, "index.html")
	fors := map[string]bool{}
	for _, m := range regexp.MustCompile(`<label[^>]*\bfor="([^"]+)"`).FindAllStringSubmatch(html, -1) {
		fors[m[1]] = true
	}
	field := regexp.MustCompile(`<(?:input|select|textarea)\b[^>]*>`)
	id := regexp.MustCompile(`\bid="([^"]+)"`)
	skip := regexp.MustCompile(`type="(?:hidden|checkbox|radio|button|submit|file)"`)
	// Fields wrapped in a <label> are named by it; strip those first.
	unwrapped := regexp.MustCompile(`(?s)<label\b[^>]*>.*?</label>`).ReplaceAllString(html, "")
	for _, tag := range field.FindAllString(unwrapped, -1) {
		if skip.MatchString(tag) || strings.Contains(tag, "aria-label") || strings.Contains(tag, " title=") {
			continue
		}
		if m := id.FindStringSubmatch(tag); m != nil && fors[m[1]] {
			continue
		}
		t.Errorf("field without a label: %s", tag)
	}
}

// With no saved choice the theme follows the system appearance.
func TestUIThemeFollowsSystem(t *testing.T) {
	if !strings.Contains(readUI(t, "index.html"), "prefers-color-scheme: light") ||
		!strings.Contains(readUI(t, "app.js"), "prefers-color-scheme: light") {
		t.Error("theme bootstrap must consult prefers-color-scheme")
	}
}

// Colors come from tokens.css: hard-coded colors break the light theme and the
// accent presets. White text on a status fill is the only literal allowed.
func TestUINoHardcodedColors(t *testing.T) {
	decl := regexp.MustCompile(`(?:^|[^\w-])(color|background(?:-color)?|border(?:-[a-z]+)?|fill|stroke)\s*:\s*[^;"'{}<>` + "`" + `]*?(#[0-9a-fA-F]{3,6}\b|rgba?\([^)]*\))`)
	canvas := regexp.MustCompile(`fillStyle|strokeStyle|addColorStop|C_[A-Z]+ *=|xterm|selectionBackground`)
	for _, f := range []string{"index.html", "app.js", "enterprise.css", "base.css"} {
		for i, line := range strings.Split(readUI(t, f), "\n") {
			if canvas.MatchString(line) {
				continue
			}
			for _, m := range decl.FindAllStringSubmatch(line, -1) {
				if v := strings.ToLower(m[2]); m[1] == "color" && (v == "#fff" || v == "#ffffff") {
					continue
				}
				t.Errorf("%s:%d: hard-coded color %q", f, i+1, strings.TrimSpace(m[0]))
			}
		}
	}
}

// Icons come from the SVG sprite (#i-*), not emoji: emoji render differently on
// every OS, cannot follow the theme color and read as noise in labels.
// The typographic marks check and cross stay.
func TestUINoEmoji(t *testing.T) {
	emoji := regexp.MustCompile("[\U0001F300-\U0001FAFF☀-➿⭐⏩-⏺]")
	for _, f := range []string{"index.html", "app.js"} {
		for i, line := range strings.Split(readUI(t, f), "\n") {
			for _, m := range emoji.FindAllString(line, -1) {
				if m == "✓" || m == "✗" || m == "☰" { // check, cross, menu
					continue
				}
				t.Errorf("%s:%d: emoji %q in UI", f, i+1, m)
			}
		}
	}
}
