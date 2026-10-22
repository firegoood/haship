package main

import (
	"encoding/binary"
	"io"
	"net"
	"os"
	"strings"
	"testing"
	"time"
)

// TestLimitsLab runs inside tests/test_limits_lab.sh's hub namespace, with
// the real iptables and tc, against a sink on the foreign namespace
// (LIMITS_LAB_FOREIGN:9000). The sink reads a 16-byte header (bytes up,
// bytes down), reads the bytes up, then sends one byte or the bytes down.
func TestLimitsLab(t *testing.T) {
	fo := os.Getenv("LIMITS_LAB_FOREIGN")
	if fo == "" {
		t.Skip("set LIMITS_LAB_FOREIGN to run the limits lab")
	}
	withPro(t)
	oldRunner, oldServers := runner, limitServers
	runner = execRunner // the real iptables and tc of this namespace
	limitServers = func() []limitServer { return []limitServer{{IP: fo, Name: "lab", Links: []string{"main"}}} }
	resetLimitsState()
	t.Cleanup(func() {
		runner, limitServers = oldRunner, oldServers
		resetLimitsState()
	})
	addr := net.JoinHostPort(fo, "9000")

	// xfer moves up bytes to the sink and down bytes back; it returns each
	// direction's rate in Mbit/s.
	xfer := func(up, down int64) (upMbit, downMbit float64, err error) {
		c, err := net.DialTimeout("tcp", addr, 3*time.Second)
		if err != nil {
			return 0, 0, err
		}
		defer c.Close()
		_ = c.SetDeadline(time.Now().Add(60 * time.Second))
		hdr := make([]byte, 16)
		binary.BigEndian.PutUint64(hdr, uint64(up))
		binary.BigEndian.PutUint64(hdr[8:], uint64(down))
		if _, err := c.Write(hdr); err != nil {
			return 0, 0, err
		}
		t0 := time.Now()
		buf := make([]byte, 64<<10)
		for left := up; left > 0; {
			n := int64(len(buf))
			if left < n {
				n = left
			}
			if _, err := c.Write(buf[:n]); err != nil {
				return 0, 0, err
			}
			left -= n
		}
		want := down
		if want == 0 {
			want = 1 // the sink's "got it"
		}
		first := make([]byte, 1)
		if _, err := io.ReadFull(c, first); err != nil {
			return 0, 0, err
		}
		t1 := time.Now()
		if _, err := io.CopyN(io.Discard, c, want-1); err != nil {
			return 0, 0, err
		}
		t2 := time.Now()
		if up > 0 {
			upMbit = float64(up) * 8 / 1e6 / t1.Sub(t0).Seconds()
		}
		if down > 1 {
			downMbit = float64(down) * 8 / 1e6 / t2.Sub(t1).Seconds()
		}
		return upMbit, downMbit, nil
	}
	post := func(body string) {
		t.Helper()
		if code, m := limitsPost(t, body); code != 200 {
			t.Fatalf("%s: %d %v", body, code, m)
		}
		limits.Lock()
		e := limits.err
		limits.Unlock()
		if e != "" {
			t.Fatalf("%s: enforcement error: %s", body, e)
		}
	}
	used := func() uint64 { return limitRuleOf(fo).used() }

	up, down, err := xfer(8e6, 8e6)
	if err != nil {
		t.Fatalf("no limit: %v", err)
	}
	t.Logf("no limit: up %.0f Mbit/s, down %.0f Mbit/s", up, down)

	// speed: 20 Mbit/s both ways
	post(`{"action":"set","ip":"` + fo + `","rate_mbit":20,"reset":"never"}`)
	if n := limitsTCPresent(limitsIface()); n != 2 {
		t.Fatalf("policers on %q: %d, want 2", limitsIface(), n)
	}
	up, down, err = xfer(8e6, 8e6)
	if err != nil {
		t.Fatalf("20 Mbit/s: %v", err)
	}
	t.Logf("20 Mbit/s: up %.1f, down %.1f", up, down)
	for _, v := range []float64{up, down} {
		if v < 10 || v > 24 {
			t.Errorf("rate %.1f Mbit/s with a 20 Mbit/s limit", v)
		}
	}

	// volume: 30 MB, counted both ways, then cut
	post(`{"action":"set","ip":"` + fo + `","rate_mbit":0,"quota_gb":0.03,"reset":"never"}`)
	post(`{"action":"reset","ip":"` + fo + `"}`) // the speed test above was counted too
	if out, _ := runCmdTimeout(5*time.Second, "tc", "filter", "show", "dev", limitsIface(), "egress", "pref", limitsTCPref); strings.Contains(string(out), "police") {
		t.Errorf("a policer is left after the speed limit was removed:\n%s", out)
	}
	limitsTick(time.Now())
	base := used()
	if _, _, err := xfer(0, 20e6); err != nil {
		t.Fatalf("20 MB down: %v", err)
	}
	limitsTick(time.Now())
	got := used() - base
	t.Logf("20 MB down counted as %d bytes", got)
	if got < 20e6 || got > 21.6e6 {
		t.Errorf("20 MB down counted as %d bytes", got)
	}
	if r := limitRuleOf(fo); r.Blocked {
		t.Fatalf("cut at %d of 30 MB", r.used())
	}
	if _, _, err := xfer(12e6, 0); err != nil {
		t.Fatalf("12 MB up: %v", err)
	}
	limitsTick(time.Now())
	if r := limitRuleOf(fo); !r.Blocked {
		t.Fatalf("not cut at %d of 30 MB", r.used())
	}
	if _, _, err := xfer(0, 1000); err == nil {
		t.Fatal("a cut server still answers")
	}
	limitsTick(time.Now())
	if u := used(); u > 34e6 {
		t.Errorf("usage grew while cut: %d", u)
	}

	// reset brings it back
	post(`{"action":"reset","ip":"` + fo + `"}`)
	if _, _, err := xfer(0, 1e6); err != nil {
		t.Fatalf("after reset: %v", err)
	}

	// remove leaves nothing in the kernel
	post(`{"action":"remove","ip":"` + fo + `"}`)
	out, _ := runCmdTimeoutOut(5*time.Second, "iptables-save", "-t", "filter")
	if strings.Contains(string(out), limitsChain) {
		t.Errorf("chain left after remove:\n%s", out)
	}
	if n := limitsTCPresent(limitsIface()); n != 0 {
		t.Errorf("%d policers left after remove", n)
	}
	if _, _, err := xfer(0, 1e6); err != nil {
		t.Fatalf("after remove: %v", err)
	}
}
