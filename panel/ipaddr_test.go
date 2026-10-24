package main

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestIPFamily(t *testing.T) {
	for in, want := range map[string]int{
		"1.2.3.4": 4, " 1.2.3.4 ": 4, "::ffff:1.2.3.4": 4,
		"2001:db8::1": 6, "::1": 6, "fd00::5": 6,
		"": 0, "example.com": 0, "[2001:db8::1]": 0, "1.2.3.4/32": 0, "1.2.3": 0,
	} {
		if got := ipFamily(in); got != want {
			t.Errorf("ipFamily(%q) = %d, want %d", in, got, want)
		}
	}
}

func TestHostPortAndURLHost(t *testing.T) {
	for _, c := range []struct {
		host string
		port int
		hp   string
		uh   string
	}{
		{"1.2.3.4", 443, "1.2.3.4:443", "1.2.3.4"},
		{"2001:db8::1", 8443, "[2001:db8::1]:8443", "[2001:db8::1]"},
		{"[2001:db8::1]", 22, "[2001:db8::1]:22", "[2001:db8::1]"},
		{"example.com", 80, "example.com:80", "example.com"},
		{"0.0.0.0", 9000, "0.0.0.0:9000", "0.0.0.0"},
		{"::", 9000, "[::]:9000", "[::]"},
	} {
		if got := hostPort(c.host, c.port); got != c.hp {
			t.Errorf("hostPort(%q, %d) = %q, want %q", c.host, c.port, got, c.hp)
		}
		if got := urlHost(c.host); got != c.uh {
			t.Errorf("urlHost(%q) = %q, want %q", c.host, got, c.uh)
		}
	}
}

func TestValidPublicIP(t *testing.T) {
	for _, c := range []struct {
		ip   string
		fam  int
		want bool
	}{
		{"203.0.113.7", 4, true},
		{"203.0.113.7", 6, false},
		{"203.0.113.7", 0, true},
		{"10.0.0.1", 4, false},
		{"2001:db8::1", 6, true},
		{"2001:db8::1", 4, false},
		{"fd12:3456::1", 6, false}, // unique local
		{"fe80::1", 6, false},      // link local
		{"::1", 6, false},
		{"ff02::1", 6, false},
		{"::", 6, false},
		{"example.com", 0, false},
	} {
		if got := validPublicIP(c.ip, c.fam); got != c.want {
			t.Errorf("validPublicIP(%q, %d) = %v, want %v", c.ip, c.fam, got, c.want)
		}
	}
}

// TestNoBareHostPort keeps "%s:%d" host:port builders out of the panel: they
// break with IPv6 literals; hostPort / net.JoinHostPort bracket them.
func TestNoBareHostPort(t *testing.T) {
	files, _ := filepath.Glob("*.go")
	bad := regexp.MustCompile(`Sprintf\("(?:[a-z]+://)?%s:%d`)
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		for i, line := range strings.Split(string(data), "\n") {
			if bad.MatchString(line) && !strings.Contains(line, "typ, ") {
				t.Errorf("%s:%d builds host:port without brackets: %s", f, i+1, strings.TrimSpace(line))
			}
		}
	}
}
