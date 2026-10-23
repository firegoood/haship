package main

import (
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// fakeLimitsKernel stands in for iptables and tc: it keeps the chain loaded
// by iptables-restore, its byte counters and the tc commands.
type fakeLimitsKernel struct {
	rules []string          // "-s 1.2.3.4/32" / "-d 1.2.3.4/32 -j DROP"
	ctr   map[string]uint64 // by limitKey
	tc    []string
	loads int
}

func (k *fakeLimitsKernel) save() string {
	if k.rules == nil {
		return "*filter\n:INPUT ACCEPT [0:0]\nCOMMIT\n"
	}
	var b strings.Builder
	b.WriteString("*filter\n:INPUT ACCEPT [0:0]\n:" + limitsChain + " - [0:0]\n")
	for _, h := range []string{"INPUT", "OUTPUT", "FORWARD"} {
		b.WriteString("[9:999] -A " + h + " -j " + limitsChain + "\n")
	}
	for _, r := range k.rules {
		f := strings.Fields(r)
		fmt.Fprintf(&b, "[1:%d] -A %s %s\n", k.ctr[limitKey(strings.TrimSuffix(f[1], "/32"), f[0] == "-d")], limitsChain, r)
	}
	b.WriteString("COMMIT\n")
	return b.String()
}

func useFakeLimits(t *testing.T, servers ...string) *fakeLimitsKernel {
	t.Helper()
	k := &fakeLimitsKernel{ctr: map[string]uint64{}}
	oldDir, oldRun, oldSave, oldIf, oldAlert, oldServers := configDir, limitsRun, limitsSaveOut, limitsIface, limitsAlert, limitServers
	configDir = t.TempDir()
	limitsRun = func(name string, args ...string) ([]byte, error) {
		switch name {
		case "iptables-restore":
			data, err := os.ReadFile(args[len(args)-1])
			if err != nil {
				return nil, err
			}
			k.rules, k.ctr = []string{}, map[string]uint64{}
			k.loads++
			for _, l := range strings.Split(string(data), "\n") {
				if r, ok := strings.CutPrefix(l, "-A "+limitsChain+" "); ok {
					k.rules = append(k.rules, r)
				}
			}
		case "tc":
			k.tc = append(k.tc, strings.Join(args, " "))
			if args[0] == "filter" && args[1] == "show" {
				// like some iproute2 versions: both directions for either,
				// "police" twice per filter
				var b strings.Builder
				for _, c := range k.tc {
					if f := strings.Fields(c); f[0] == "filter" && f[1] == "add" {
						at := map[string]string{"dst": "16", "src": "12"}[f[12]]
						fmt.Fprintf(&b, "filter protocol ip pref 4917 u32 fh 800::800\n  match %s at %s\n\taction order 1:  police 0x1 rate 20Mbit\n\t police 0x1\n", f[13], at)
					}
				}
				return []byte(b.String()), nil
			}
		}
		return nil, nil
	}
	limitsSaveOut = func() ([]byte, error) { return []byte(k.save()), nil }
	limitsIface = func() string { return "eth0" }
	limitsAlert = func(e limitEvent) { t.Logf("alert %s: %s (%s)", e.ip, e.to, e.why) }
	limitServers = func() []limitServer {
		var out []limitServer
		for _, ip := range servers {
			out = append(out, limitServer{IP: ip, Name: "srv-" + ip, Links: []string{"main"}})
		}
		return out
	}
	resetLimitsState()
	t.Cleanup(func() {
		configDir, limitsRun, limitsSaveOut, limitsIface, limitsAlert, limitServers = oldDir, oldRun, oldSave, oldIf, oldAlert, oldServers
		resetLimitsState()
	})
	return k
}

func resetLimitsState() {
	limits.Lock()
	limits.loaded, limits.rules, limits.last, limits.speed, limits.at, limits.dirty, limits.err = false, nil, nil, nil, time.Time{}, false, ""
	limits.Unlock()
	limitsApplied.ipt, limitsApplied.tc, limitsApplied.tcIf, limitsApplied.tcCheck, limitsApplied.cleaned = "", "", "", time.Time{}, false
}

func limitsPost(t *testing.T, body string) (int, map[string]any) {
	t.Helper()
	rr := httptest.NewRecorder()
	handleLimitsPost(rr, httptest.NewRequest("POST", "/api/limits", strings.NewReader(body)))
	var m map[string]any
	_ = json.Unmarshal(rr.Body.Bytes(), &m)
	return rr.Code, m
}

func limitRuleOf(ip string) limitRule {
	limits.Lock()
	defer limits.Unlock()
	if r, ok := limits.rules[ip]; ok {
		return *r
	}
	return limitRule{}
}

func TestLimitsNextReset(t *testing.T) {
	loc := time.Local
	r := limitRule{Reset: "monthly", ResetDay: 5}
	for _, c := range []struct{ start, want time.Time }{
		{time.Date(2026, 10, 20, 13, 0, 0, 0, loc), time.Date(2026, 11, 5, 0, 0, 0, 0, loc)},
		{time.Date(2026, 10, 3, 13, 0, 0, 0, loc), time.Date(2026, 10, 5, 0, 0, 0, 0, loc)},
		{time.Date(2026, 10, 5, 0, 0, 0, 0, loc), time.Date(2026, 11, 5, 0, 0, 0, 0, loc)},
		{time.Date(2026, 12, 9, 0, 0, 0, 0, loc), time.Date(2027, 1, 5, 0, 0, 0, 0, loc)},
	} {
		if got := r.nextReset(c.start); !got.Equal(c.want) {
			t.Errorf("from %v: %v, want %v", c.start, got, c.want)
		}
	}
	if !(limitRule{Reset: "never"}).nextReset(time.Now()).IsZero() {
		t.Error("never has a reset")
	}
}

func TestLimitsValidate(t *testing.T) {
	ok := []limitRule{
		{IP: "203.0.113.7", RateMbit: 50, Reset: "never"},
		{IP: "203.0.113.7", QuotaGB: 500, Reset: "monthly", ResetDay: 28},
		{IP: "203.0.113.7", RateMbit: 0.5, QuotaGB: 0.5, Reset: "never"},
	}
	bad := []limitRule{
		{IP: "2001:db8::1", RateMbit: 5, Reset: "never"},
		{IP: "nope", RateMbit: 5, Reset: "never"},
		{IP: "203.0.113.7", RateMbit: -1, Reset: "never"},
		{IP: "203.0.113.7", RateMbit: 0.01, Reset: "never"},
		{IP: "203.0.113.7", QuotaGB: 5, Reset: "monthly", ResetDay: 31},
		{IP: "203.0.113.7", QuotaGB: 5, Reset: "weekly"},
	}
	for _, r := range ok {
		if err := r.validate(); err != nil {
			t.Errorf("%+v: %v", r, err)
		}
	}
	for _, r := range bad {
		if r.validate() == nil {
			t.Errorf("%+v accepted", r)
		}
	}
}

func TestLimitsRulesAndParse(t *testing.T) {
	text := limitsRules([]limitRule{{IP: "198.51.100.2"}, {IP: "203.0.113.7", Blocked: true}})
	for _, want := range []string{
		"-A HASHEM_LIMIT -s 198.51.100.2/32\n", "-A HASHEM_LIMIT -d 198.51.100.2/32\n",
		"-A HASHEM_LIMIT -s 203.0.113.7/32 -j DROP\n", "-A HASHEM_LIMIT -d 203.0.113.7/32 -j DROP\n",
	} {
		if !strings.Contains(text, want) {
			t.Errorf("rules lack %q:\n%s", want, text)
		}
	}
	save := `*filter
:INPUT ACCEPT [0:0]
:HASHEM_LIMIT - [0:0]
[5:500] -A INPUT -j HASHEM_LIMIT
[5:500] -A OUTPUT -j HASHEM_LIMIT
[5:500] -A FORWARD -j HASHEM_LIMIT
[10:1000] -A HASHEM_LIMIT -s 198.51.100.2/32
[20:2000] -A HASHEM_LIMIT -d 198.51.100.2/32
[3:300] -A HASHEM_LIMIT -s 203.0.113.7/32 -j DROP
[4:400] -A HASHEM_ACCT_IN -s 203.0.113.7/32 -p tcp -m tcp --sport 22
COMMIT
`
	m, ready := parseLimitsSave(save)
	if !ready || m["198.51.100.2<"] != 1000 || m["198.51.100.2>"] != 2000 || m["203.0.113.7<"] != 300 || len(m) != 3 {
		t.Fatalf("ready=%v %v", ready, m)
	}
	if _, ready := parseLimitsSave(strings.Replace(save, "[5:500] -A FORWARD -j HASHEM_LIMIT\n", "", 1)); ready {
		t.Error("ready without the FORWARD jump")
	}
}

func TestLimitsTCArgs(t *testing.T) {
	cmds := limitsTCArgs("eth0", map[string]float64{"203.0.113.7": 100, "198.51.100.2": 0.5})
	if len(cmds) != 4 {
		t.Fatalf("%d commands", len(cmds))
	}
	got := make([]string, len(cmds))
	for i, c := range cmds {
		got[i] = strings.Join(c, " ")
	}
	want := []string{
		"filter add dev eth0 egress pref 4917 protocol ip u32 match ip dst 198.51.100.2/32 action police rate 500kbit burst 65536 mtu 65535 conform-exceed drop/pass",
		"filter add dev eth0 ingress pref 4917 protocol ip u32 match ip src 198.51.100.2/32 action police rate 500kbit burst 65536 mtu 65535 conform-exceed drop/pass",
		"filter add dev eth0 egress pref 4917 protocol ip u32 match ip dst 203.0.113.7/32 action police rate 100000kbit burst 1250000 mtu 65535 conform-exceed drop/pass",
		"filter add dev eth0 ingress pref 4917 protocol ip u32 match ip src 203.0.113.7/32 action police rate 100000kbit burst 1250000 mtu 65535 conform-exceed drop/pass",
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("cmd %d:\n got %s\nwant %s", i, got[i], want[i])
		}
	}
}

// The whole cycle: a quota counted from the chain, the 90% warning, the cut
// (DROP, no policer), a manual reset, and a monthly period ending.
func TestLimitsQuotaCycle(t *testing.T) {
	withPro(t)
	const ip = "203.0.113.7"
	k := useFakeLimits(t, ip)
	now := time.Now()

	if code, m := limitsPost(t, `{"action":"set","ip":"198.51.100.99","quota_gb":1,"reset":"never"}`); code == 200 {
		t.Fatalf("unknown server accepted: %v", m)
	}
	if code, m := limitsPost(t, `{"action":"set","ip":"`+ip+`","rate_mbit":20,"quota_gb":1,"reset":"monthly","reset_day":1}`); code != 200 {
		t.Fatalf("set: %d %v", code, m)
	}
	if k.loads != 1 || len(k.rules) != 2 || strings.Contains(strings.Join(k.rules, ";"), "DROP") {
		t.Fatalf("chain: loads %d %v", k.loads, k.rules)
	}
	if n := strings.Count(strings.Join(k.tc, "\n"), "filter add"); n != 2 {
		t.Fatalf("tc: %v", k.tc)
	}

	tick := func(in, out uint64) {
		k.ctr[limitKey(ip, false)] += in
		k.ctr[limitKey(ip, true)] += out
		now = now.Add(10 * time.Second)
		limitsTick(now)
	}
	tick(300e6, 300e6)
	if r := limitRuleOf(ip); r.used() != 600e6 || r.Warned || r.Blocked {
		t.Fatalf("after 600 MB: %+v", r)
	}
	tick(200e6, 150e6)
	if r := limitRuleOf(ip); r.used() != 950e6 || !r.Warned || r.Blocked {
		t.Fatalf("after 950 MB: %+v", r)
	}
	tc0 := len(k.tc)
	tick(25e6, 25e6)
	r := limitRuleOf(ip)
	if !r.Blocked || r.used() != 1e9 {
		t.Fatalf("after 1 GB: %+v", r)
	}
	if !strings.Contains(strings.Join(k.rules, ";"), "-s "+ip+"/32 -j DROP") || k.loads != 2 {
		t.Fatalf("not cut: %v", k.rules)
	}
	if strings.Contains(strings.Join(k.tc[tc0:], "\n"), "filter add") {
		t.Errorf("a cut server still gets a policer: %v", k.tc[tc0:])
	}
	tick(5e6, 5e6) // dropped packets do not count
	if r := limitRuleOf(ip); r.used() != 1e9 {
		t.Fatalf("usage grew while cut: %d", r.used())
	}
	// it was saved
	limitsFlush()
	data, _ := os.ReadFile(limitsPath())
	if !strings.Contains(string(data), `"blocked": true`) {
		t.Fatalf("limits.json: %s", data)
	}

	if code, m := limitsPost(t, `{"action":"reset","ip":"`+ip+`"}`); code != 200 {
		t.Fatalf("reset: %d %v", code, m)
	}
	if r := limitRuleOf(ip); r.Blocked || r.used() != 0 || strings.Contains(strings.Join(k.rules, ";"), "DROP") {
		t.Fatalf("after reset: %+v %v", r, k.rules)
	}
	tick(1e6, 1e6)
	if r := limitRuleOf(ip); r.used() != 2e6 {
		t.Fatalf("counting after reset: %d", r.used())
	}

	// the month ends
	limits.Lock()
	limits.rules[ip].PeriodStart = time.Date(2026, 1, 15, 0, 0, 0, 0, time.Local).Unix()
	limits.rules[ip].Blocked = true
	limits.Unlock()
	tick(0, 0)
	if r := limitRuleOf(ip); r.Blocked || r.used() != 0 || r.PeriodStart < now.Unix()-1 {
		t.Fatalf("period did not end: %+v", r)
	}

	// raising the quota above the usage reconnects a cut server
	tick(2e9, 0)
	if r := limitRuleOf(ip); !r.Blocked {
		t.Fatalf("not cut at 2 GB: %+v", r)
	}
	if code, m := limitsPost(t, `{"action":"set","ip":"`+ip+`","rate_mbit":0,"quota_gb":5,"reset":"never"}`); code != 200 {
		t.Fatalf("raise: %d %v", code, m)
	}
	if r := limitRuleOf(ip); r.Blocked || r.used() != 2e9 || r.RateMbit != 0 {
		t.Fatalf("after raising: %+v", r)
	}

	// unlimited both ways removes the rule, and the chain with it
	if code, m := limitsPost(t, `{"action":"set","ip":"`+ip+`","rate_mbit":0,"quota_gb":0,"reset":"never"}`); code != 200 {
		t.Fatalf("unlimited: %d %v", code, m)
	}
	limits.Lock()
	n := len(limits.rules)
	limits.Unlock()
	if n != 0 || limitsApplied.ipt != "" {
		t.Fatalf("rule left: %d %q", n, limitsApplied.ipt)
	}
}

// After a restart the chain still holds the bytes counted before it; the
// first tick must not add them again.
func TestLimitsFirstTickDoesNotRecount(t *testing.T) {
	const ip = "203.0.113.7"
	k := useFakeLimits(t, ip)
	rule := limitRule{IP: ip, QuotaGB: 10, Reset: "never", UsedRx: 1e9, PeriodStart: time.Now().Unix()}
	data, _ := json.Marshal(limitsFile{Rules: []limitRule{rule}})
	if err := os.WriteFile(limitsPath(), data, 0o600); err != nil {
		t.Fatal(err)
	}
	k.rules = strings.Split(strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(limitsRules([]limitRule{rule}), "*filter\n:HASHEM_LIMIT - [0:0]\n-F HASHEM_LIMIT\n", ""), "COMMIT\n", "")), "\n")
	for i := range k.rules {
		k.rules[i] = strings.TrimPrefix(k.rules[i], "-A "+limitsChain+" ")
	}
	k.ctr[limitKey(ip, false)] = 1e9 // already in UsedRx
	limitsApplied.ipt = limitsRules([]limitRule{rule})
	now := time.Now()
	limitsTick(now)
	if r := limitRuleOf(ip); r.UsedRx != 1e9 {
		t.Fatalf("first tick counted again: %d", r.UsedRx)
	}
	k.ctr[limitKey(ip, false)] += 5e6
	limitsTick(now.Add(10 * time.Second))
	if r := limitRuleOf(ip); r.UsedRx != 1e9+5e6 {
		t.Fatalf("second tick: %d", r.UsedRx)
	}
	if k.loads != 0 {
		t.Errorf("the chain was rebuilt (%d) though it matched", k.loads)
	}
}

// Without a license limits stay enforced and can be removed, not set.
func TestLimitsRemoveWithoutLicense(t *testing.T) {
	setTestLicense(t, nil)
	const ip = "203.0.113.7"
	useFakeLimits(t, ip)
	limits.Lock()
	limitsLoadLocked()
	limits.rules[ip] = &limitRule{IP: ip, RateMbit: 10, Reset: "never"}
	limits.Unlock()
	if code, _ := limitsPost(t, `{"action":"set","ip":"`+ip+`","rate_mbit":50,"reset":"never"}`); code != 403 {
		t.Fatalf("set without a license: %d", code)
	}
	if code, m := limitsPost(t, `{"action":"remove","ip":"`+ip+`"}`); code != 200 {
		t.Fatalf("remove: %d %v", code, m)
	}
	if r := limitRuleOf(ip); r.IP != "" {
		t.Fatalf("still limited: %+v", r)
	}
}
