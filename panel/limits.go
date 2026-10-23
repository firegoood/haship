package main

// Speed and volume limits per foreign server (Hashem Pro).
//
// A server is its public IPv4: every tunnel to it (GRE, FRP, Backhaul,
// Bagher, Xray) leaves and arrives on the default-route interface with that
// address, so one rule covers them all.
//
//   - Speed: a tc policer on the interface's clsact hooks, egress for
//     dst IP and ingress for src IP, one rate for both directions. The root
//     qdisc (fq for BBR) is not touched. Filters carry pref limitsTCPref.
//   - Volume: the HASHEM_LIMIT filter chain, jumped to from INPUT, OUTPUT and
//     FORWARD, holds two counting rules per server (-s IP in, -d IP out).
//     The panel adds the counters up in limits.json. When a server's quota is
//     used up both rules become DROP: the server's links are cut until the
//     next reset (monthly on a day, or by hand). Other servers are untouched.
//
// Rules are enforced with or without a license (and limits can always be
// removed); setting them needs Pro. IPv4 only. hashem.sh limits_drop removes
// the chain and the filters on uninstall.

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	limitsChain  = "HASHEM_LIMIT"
	limitsTCPref = "4917"
	proLimitsTxt = "Speed and volume limits"
	gb           = 1e9
)

type limitRule struct {
	IP       string  `json:"ip"`
	RateMbit float64 `json:"rate_mbit"` // 0 = unlimited
	QuotaGB  float64 `json:"quota_gb"`  // 0 = unlimited
	Reset    string  `json:"reset"`     // "monthly" | "never"
	ResetDay int     `json:"reset_day,omitempty"`
	// Usage in the current period, in bytes (rx: from the server).
	UsedRx      uint64 `json:"used_rx"`
	UsedTx      uint64 `json:"used_tx"`
	PeriodStart int64  `json:"period_start"`
	Blocked     bool   `json:"blocked,omitempty"`
	Warned      bool   `json:"warned,omitempty"` // the 90% alert went out this period
}

func (r limitRule) used() uint64 { return r.UsedRx + r.UsedTx }

func (r limitRule) quotaBytes() uint64 { return uint64(math.Round(r.QuotaGB * gb)) }

// nextReset is when a monthly period that started at start ends: the next
// ResetDay at 00:00 local time after start. Zero for "never".
func (r limitRule) nextReset(start time.Time) time.Time {
	if r.Reset != "monthly" || r.ResetDay < 1 {
		return time.Time{}
	}
	t := time.Date(start.Year(), start.Month(), r.ResetDay, 0, 0, 0, 0, start.Location())
	if !t.After(start) {
		t = t.AddDate(0, 1, 0)
	}
	return t
}

func (r limitRule) validate() error {
	if ip := net.ParseIP(r.IP); ip == nil || ip.To4() == nil {
		return fmt.Errorf("server address must be an IPv4 address")
	}
	if r.RateMbit < 0 || r.RateMbit > 100000 || (r.RateMbit > 0 && r.RateMbit < 0.1) {
		return fmt.Errorf("speed: 0.1 to 100000 Mbit/s, or 0 for unlimited")
	}
	if r.QuotaGB < 0 || r.QuotaGB > 1e6 || (r.QuotaGB > 0 && r.QuotaGB < 0.01) {
		return fmt.Errorf("volume: 0.01 to 1000000 GB, or 0 for unlimited")
	}
	switch r.Reset {
	case "never":
	case "monthly":
		if r.ResetDay < 1 || r.ResetDay > 28 {
			return fmt.Errorf("reset day: 1 to 28")
		}
	default:
		return fmt.Errorf("reset: monthly or never")
	}
	return nil
}

type limitsFile struct {
	Rules []limitRule `json:"rules"`
}

func limitsPath() string { return filepath.Join(configDir, "limits.json") }

var limits = struct {
	sync.Mutex
	loaded bool
	rules  map[string]*limitRule
	last   map[string]uint64     // counter at the last tick, by limitKey
	speed  map[string][2]float64 // bytes/s by IP: [0] from, [1] to the server
	at     time.Time
	dirty  bool
	saved  time.Time
	err    string // the last enforcement error, "" when fine
}{}

// limitsTickMu serialises the ticks (the loop and a POST that applies at once).
var limitsTickMu sync.Mutex

// limitsApplied is what is loaded in the kernel; only the tick touches it.
var limitsApplied = struct {
	ipt, tc, tcIf string
	tcCheck       time.Time
	cleaned       bool
}{}

func limitsLoadLocked() {
	if limits.loaded {
		return
	}
	limits.loaded = true
	limits.rules = map[string]*limitRule{}
	limits.last = map[string]uint64{}
	limits.speed = map[string][2]float64{}
	var f limitsFile
	if data, err := os.ReadFile(limitsPath()); err == nil {
		_ = json.Unmarshal(data, &f)
	}
	for i := range f.Rules {
		r := f.Rules[i]
		if r.validate() == nil {
			limits.rules[r.IP] = &r
		}
	}
}

func limitsSaveLocked() error {
	f := limitsFile{Rules: []limitRule{}}
	for _, r := range limits.rules {
		f.Rules = append(f.Rules, *r)
	}
	sort.Slice(f.Rules, func(i, j int) bool { return f.Rules[i].IP < f.Rules[j].IP })
	data, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return err
	}
	if err := writeFileAtomic(limitsPath(), data, 0o600); err != nil {
		return err
	}
	limits.dirty, limits.saved = false, time.Now()
	return nil
}

// limitsFlush saves the usage counted since the last save (shutdown).
func limitsFlush() {
	limits.Lock()
	defer limits.Unlock()
	if limits.loaded && limits.dirty {
		_ = limitsSaveLocked()
	}
}

func limitKey(ip string, out bool) string {
	if out {
		return ip + ">"
	}
	return ip + "<"
}

// limitsRules renders the chain as iptables-restore input.
func limitsRules(rules []limitRule) string {
	var b strings.Builder
	fmt.Fprintf(&b, "*filter\n:%s - [0:0]\n-F %s\n", limitsChain, limitsChain)
	for _, r := range rules {
		target := ""
		if r.Blocked {
			target = " -j DROP"
		}
		fmt.Fprintf(&b, "-A %s -s %s/32%s\n", limitsChain, r.IP, target)
		fmt.Fprintf(&b, "-A %s -d %s/32%s\n", limitsChain, r.IP, target)
	}
	b.WriteString("COMMIT\n")
	return b.String()
}

// parseLimitsSave reads the byte counters of the chain's rules from
// `iptables-save -c` output (by limitKey) and whether the chain and its three
// jumps exist.
func parseLimitsSave(out string) (map[string]uint64, bool) {
	m := map[string]uint64{}
	chain, hooks := false, 0
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		if strings.HasPrefix(line, ":"+limitsChain+" ") {
			chain = true
			continue
		}
		if !strings.HasPrefix(line, "[") {
			continue
		}
		end := strings.Index(line, "]")
		if end < 0 {
			continue
		}
		rule := strings.TrimSpace(line[end+1:])
		switch rule {
		case "-A INPUT -j " + limitsChain, "-A OUTPUT -j " + limitsChain, "-A FORWARD -j " + limitsChain:
			hooks++
			continue
		}
		if !strings.HasPrefix(rule, "-A "+limitsChain+" ") {
			continue
		}
		_, bytesStr, _ := strings.Cut(line[1:end], ":")
		n, err := strconv.ParseUint(bytesStr, 10, 64)
		if err != nil {
			continue
		}
		f := strings.Fields(rule)
		for i := 0; i+1 < len(f); i++ {
			if f[i] == "-s" || f[i] == "-d" {
				m[limitKey(strings.TrimSuffix(f[i+1], "/32"), f[i] == "-d")] += n
				break
			}
		}
	}
	return m, chain && hooks == 3
}

// Commands, swappable for tests.
var (
	limitsRun     = func(name string, args ...string) ([]byte, error) { return runCmdTimeout(10*time.Second, name, args...) }
	limitsSaveOut = func() ([]byte, error) { return runCmdTimeoutOut(5*time.Second, "iptables-save", "-c", "-t", "filter") }
	limitsIface   = primaryInterface
	limitsAlert   = sendLimitAlert
)

func limitsLoadChain(rules string) error {
	_ = os.MkdirAll(configDir, 0o700)
	f := filepath.Join(configDir, "limits.v4")
	if err := os.WriteFile(f, []byte(rules), 0o600); err != nil {
		return err
	}
	if out, err := limitsRun("iptables-restore", "-w", "5", "-n", f); err != nil {
		return fmt.Errorf("iptables-restore: %s", strings.TrimSpace(string(out)))
	}
	for _, h := range []string{"INPUT", "OUTPUT", "FORWARD"} {
		if _, err := limitsRun("iptables", "-w", "5", "-C", h, "-j", limitsChain); err != nil {
			if out, err := limitsRun("iptables", "-w", "5", "-I", h, "1", "-j", limitsChain); err != nil {
				return fmt.Errorf("iptables -I %s: %s", h, strings.TrimSpace(string(out)))
			}
		}
	}
	return nil
}

func limitsDropChain() {
	for _, h := range []string{"INPUT", "OUTPUT", "FORWARD"} {
		_, _ = limitsRun("iptables", "-w", "5", "-D", h, "-j", limitsChain)
	}
	_, _ = limitsRun("iptables", "-w", "5", "-F", limitsChain)
	_, _ = limitsRun("iptables", "-w", "5", "-X", limitsChain)
}

// limitsTCArgs are the tc commands that give each server its rate (Mbit/s),
// after the old filters are deleted. The burst is 500 ms at the rate (at
// least 64 KB): a smaller bucket drops TCP into backoff, well under the
// rate (the lab saw 9 of 20 Mbit/s at 100 ms). mtu 64k lets GSO/GRO packets
// through the policer.
func limitsTCArgs(ifname string, rates map[string]float64) [][]string {
	ips := make([]string, 0, len(rates))
	for ip := range rates {
		ips = append(ips, ip)
	}
	sort.Strings(ips)
	var cmds [][]string
	for _, ip := range ips {
		kbit := int64(math.Round(rates[ip] * 1000))
		burst := kbit * 1000 / 8 / 2
		if burst < 65536 {
			burst = 65536
		}
		police := []string{"action", "police", "rate", fmt.Sprintf("%dkbit", kbit), "burst", strconv.FormatInt(burst, 10), "mtu", "65535", "conform-exceed", "drop/pass"}
		for _, dir := range [][2]string{{"egress", "dst"}, {"ingress", "src"}} {
			c := []string{"filter", "add", "dev", ifname, dir[0], "pref", limitsTCPref, "protocol", "ip", "u32", "match", "ip", dir[1], ip + "/32"}
			cmds = append(cmds, append(c, police...))
		}
	}
	return cmds
}

func limitsTCClear(ifname string) {
	if ifname == "" {
		return
	}
	for _, dir := range []string{"egress", "ingress"} {
		_, _ = limitsRun("tc", "filter", "del", "dev", ifname, dir, "pref", limitsTCPref)
	}
}

func limitsTCApply(ifname string, rates map[string]float64) error {
	limitsTCClear(ifname)
	if len(rates) == 0 {
		return nil
	}
	if out, err := limitsRun("tc", "qdisc", "show", "dev", ifname); err != nil || !strings.Contains(string(out), "clsact") {
		if out, err := limitsRun("tc", "qdisc", "add", "dev", ifname, "clsact"); err != nil {
			return fmt.Errorf("tc qdisc add clsact: %s", strings.TrimSpace(string(out)))
		}
	}
	for _, c := range limitsTCArgs(ifname, rates) {
		if out, err := limitsRun("tc", c...); err != nil {
			limitsTCClear(ifname)
			return fmt.Errorf("tc %s: %s", strings.Join(c[:6], " "), strings.TrimSpace(string(out)))
		}
	}
	return nil
}

// limitsTCPresent counts our filters on the interface (a reboot or someone
// else's `tc qdisc del` removes them) by their distinct match lines: "dst
// IP" is "match <hex>/ffffffff at 16", "src IP" "at 12". Some iproute2
// versions list both clsact directions for either one, and print "police"
// more than once per filter, so neither lines nor words are counted.
func limitsTCPresent(ifname string) int {
	seen := map[string]bool{}
	for _, dir := range []string{"egress", "ingress"} {
		out, err := limitsRun("tc", "filter", "show", "dev", ifname, dir, "pref", limitsTCPref)
		if err != nil {
			return -1
		}
		for _, l := range strings.Split(string(out), "\n") {
			if l = strings.TrimSpace(l); strings.HasPrefix(l, "match ") {
				seen[l] = true
			}
		}
	}
	return len(seen)
}

type limitEvent struct{ ip, to, why string }

// limitsTick counts usage, ends periods, cuts servers over quota and keeps
// the kernel rules in step. Runs every 10 s and after every change.
func limitsTick(now time.Time) {
	limitsTickMu.Lock()
	defer limitsTickMu.Unlock()

	limits.Lock()
	limitsLoadLocked()
	n := len(limits.rules)
	limits.Unlock()
	if n == 0 {
		if limitsApplied.ipt != "" || !limitsApplied.cleaned {
			limitsDropChain()
			limitsTCClear(limitsApplied.tcIf)
			if ifn := limitsIface(); ifn != limitsApplied.tcIf {
				limitsTCClear(ifn)
			}
			limitsApplied.ipt, limitsApplied.tc, limitsApplied.tcIf, limitsApplied.cleaned = "", "", "", true
		}
		limits.Lock()
		limits.err = ""
		limits.Unlock()
		return
	}
	limitsApplied.cleaned = false

	out, saveErr := limitsSaveOut()
	counters, ready := parseLimitsSave(string(out))

	var events []limitEvent
	limits.Lock()
	elapsed := now.Sub(limits.at).Seconds()
	first := limits.at.IsZero()
	limits.at = now
	var rules []limitRule
	rates := map[string]float64{}
	for ip, r := range limits.rules {
		var d [2]uint64
		for i, out := range []bool{false, true} {
			k := limitKey(ip, out)
			cur, ok := counters[k]
			prev := limits.last[k]
			if ok {
				if cur >= prev {
					d[i] = cur - prev
				} else {
					d[i] = cur
				}
				limits.last[k] = cur
			}
		}
		if saveErr == nil && !r.Blocked && !first {
			r.UsedRx += d[0]
			r.UsedTx += d[1]
			if d[0]+d[1] > 0 {
				limits.dirty = true
			}
		}
		if elapsed > 0 && !first {
			limits.speed[ip] = [2]float64{float64(d[0]) / elapsed, float64(d[1]) / elapsed}
		}
		if next := r.nextReset(time.Unix(r.PeriodStart, 0)); !next.IsZero() && !now.Before(next) {
			if r.Blocked {
				events = append(events, limitEvent{ip, "reconnected", "new period: usage reset to 0"})
			}
			r.UsedRx, r.UsedTx, r.Blocked, r.Warned = 0, 0, false, false
			r.PeriodStart = now.Unix()
			limits.dirty = true
		}
		if q := r.quotaBytes(); q > 0 && !r.Blocked {
			if r.used() >= q {
				r.Blocked = true
				limits.dirty = true
				events = append(events, limitEvent{ip, "cut", fmt.Sprintf("volume used up: %s of %s", fmtBytesDec(r.used()), fmtBytesDec(q))})
			} else if !r.Warned && r.used() >= q/10*9 {
				r.Warned = true
				limits.dirty = true
				events = append(events, limitEvent{ip, "90% used", fmt.Sprintf("%s of %s", fmtBytesDec(r.used()), fmtBytesDec(q))})
			}
		}
		rules = append(rules, *r)
		if r.RateMbit > 0 && !r.Blocked {
			rates[ip] = r.RateMbit
		}
	}
	sort.Slice(rules, func(i, j int) bool { return rules[i].IP < rules[j].IP })
	limits.Unlock()

	var errs []string
	if saveErr != nil {
		errs = append(errs, "iptables-save: "+saveErr.Error())
	}
	text := limitsRules(rules)
	if saveErr == nil && (!ready || text != limitsApplied.ipt) {
		if err := limitsLoadChain(text); err != nil {
			errs = append(errs, err.Error())
			limitsApplied.ipt = ""
		} else {
			limitsApplied.ipt = text
			limits.Lock()
			for k := range limits.last {
				limits.last[k] = 0 // the rebuilt chain counts from zero
			}
			limits.Unlock()
		}
	}

	ifname := limitsIface()
	tcSig := fmt.Sprint(rates)
	if ifname == "" && len(rates) > 0 {
		errs = append(errs, "no default-route interface: speed limits not applied")
	} else if ifname != "" {
		if ifname != limitsApplied.tcIf && limitsApplied.tcIf != "" {
			limitsTCClear(limitsApplied.tcIf)
			limitsApplied.tc = ""
		}
		check := now.Sub(limitsApplied.tcCheck) > time.Minute
		if check {
			limitsApplied.tcCheck = now
		}
		if tcSig != limitsApplied.tc || ifname != limitsApplied.tcIf || (check && limitsTCPresent(ifname) != 2*len(rates)) {
			if err := limitsTCApply(ifname, rates); err != nil {
				errs = append(errs, err.Error())
				limitsApplied.tc = ""
			} else {
				limitsApplied.tc, limitsApplied.tcIf = tcSig, ifname
			}
		}
	}

	limits.Lock()
	limits.err = strings.Join(errs, "; ")
	if limits.dirty && (len(events) > 0 || now.Sub(limits.saved) > time.Minute) {
		_ = limitsSaveLocked()
	}
	limits.Unlock()
	for _, e := range events {
		limitsAlert(e)
	}
}

func fmtBytesDec(n uint64) string {
	switch {
	case n >= 1e12:
		return fmt.Sprintf("%.2f TB", float64(n)/1e12)
	case n >= 1e9:
		return fmt.Sprintf("%.2f GB", float64(n)/1e9)
	case n >= 1e6:
		return fmt.Sprintf("%.1f MB", float64(n)/1e6)
	}
	return fmt.Sprintf("%d KB", n/1000)
}

// sendLimitAlert sends a cut, warning or reconnect through the panel's alerts
// (webhook and/or Telegram), when alerts are on.
func sendLimitAlert(e limitEvent) {
	cfg := loadAlertConfig()
	if !cfg.Enabled {
		return
	}
	name := e.ip
	for _, s := range limitServers() {
		if s.IP == e.ip && s.Name != "" {
			name = s.Name + " (" + e.ip + ")"
		}
	}
	go alertSend(cfg, []alertEvent{{Link: name, From: "limit", To: e.to, Why: e.why, At: time.Now().UTC().Format(time.RFC3339)}})
}

func startLimitsLoop() {
	limitsTick(time.Now())
	t := time.NewTicker(10 * time.Second)
	for now := range t.C {
		limitsTick(now)
	}
}

// ---- the servers that can be limited ----

type limitServer struct {
	IP    string   `json:"ip"`
	Name  string   `json:"name"`
	Links []string `json:"links"` // "main", "peer-2", "bagher-1", "xray-3"
}

// limitServers lists the other servers this server has tunnels to, one per
// IPv4 (links through a CDN have no address of their own and are left out).
var limitServers = func() []limitServer {
	byIP := map[string]*limitServer{}
	var order []string
	add := func(host, link, name string) {
		ip := carrierIPv4(host)
		if ip == "" {
			return
		}
		s, ok := byIP[ip]
		if !ok {
			s = &limitServer{IP: ip}
			byIP[ip] = s
			order = append(order, ip)
		}
		s.Links = append(s.Links, link)
		if s.Name == "" {
			s.Name = name
		}
	}
	if snap := currentSnapshot(); snap != nil && snap.Local.RemotePub != "" {
		add(snap.Local.RemotePub, "main", linkLabel("main"))
	}
	for _, p := range loadPeers() {
		add(p.RemotePub, fmt.Sprintf("peer-%d", p.ID), p.Name)
	}
	sshFwdMu.Lock()
	cfg := loadSSHFwdConfigLocked()
	sshFwdMu.Unlock()
	if cfg.Enabled && strings.TrimSpace(cfg.RemoteHost) != "" {
		add(cfg.RemoteHost, "bagher-1", linkLabel("bagher-1"))
		for _, l := range cfg.Links {
			k := fmt.Sprintf("bagher-%d", l.ID)
			add(l.RemoteHost, k, linkLabel(k))
		}
	}
	for _, l := range loadXrayState().Links {
		if !l.Profile.CDN {
			add(l.Remote, xrayTag(l.ID), l.Name)
		}
	}
	out := make([]limitServer, 0, len(order))
	for _, ip := range order {
		out = append(out, *byIP[ip])
	}
	return out
}

// ---- API ----

type limitView struct {
	limitServer
	Rule      *limitRule `json:"rule"` // nil: unlimited
	SpeedRx   float64    `json:"speed_rx"`
	SpeedTx   float64    `json:"speed_tx"`
	NextReset int64      `json:"next_reset,omitempty"`
	Orphan    bool       `json:"orphan,omitempty"` // a rule for an address no tunnel uses now
}

func limitsView() map[string]any {
	servers := limitServers()
	limits.Lock()
	limitsLoadLocked()
	seen := map[string]bool{}
	var list []limitView
	view := func(s limitServer, orphan bool) limitView {
		v := limitView{limitServer: s, Orphan: orphan}
		if r, ok := limits.rules[s.IP]; ok {
			c := *r
			v.Rule = &c
			if t := c.nextReset(time.Unix(c.PeriodStart, 0)); !t.IsZero() {
				v.NextReset = t.Unix()
			}
		}
		sp := limits.speed[s.IP]
		v.SpeedRx, v.SpeedTx = sp[0], sp[1]
		return v
	}
	for _, s := range servers {
		seen[s.IP] = true
		list = append(list, view(s, false))
	}
	var orphans []string
	for ip := range limits.rules {
		if !seen[ip] {
			orphans = append(orphans, ip)
		}
	}
	sort.Strings(orphans)
	for _, ip := range orphans {
		list = append(list, view(limitServer{IP: ip, Links: []string{}}, true))
	}
	errText := limits.err
	limits.Unlock()
	if list == nil {
		list = []limitView{}
	}
	return map[string]any{"servers": list, "licensed": hasPro(proLimits), "error": errText, "iface": limitsIface()}
}

func handleLimitsGet(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, limitsView())
}

func handleLimitsPost(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Action   string  `json:"action"`
		IP       string  `json:"ip"`
		RateMbit float64 `json:"rate_mbit"`
		QuotaGB  float64 `json:"quota_gb"`
		Reset    string  `json:"reset"`
		ResetDay int     `json:"reset_day"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096)).Decode(&body); err != nil {
		writeAPIError(w, r, "E-LIMIT-01", "invalid json")
		return
	}
	body.IP = strings.TrimSpace(body.IP)
	// Removing a limit is always allowed, so a lapsed license never leaves a
	// server limited for good.
	if body.Action != "remove" && proRequired(w, r, proLimits, proLimitsTxt) {
		return
	}
	now := time.Now()
	limits.Lock()
	limitsLoadLocked()
	cur, exists := limits.rules[body.IP]
	var err error
	switch body.Action {
	case "set":
		known := exists
		for _, s := range limitServers() {
			known = known || s.IP == body.IP
		}
		nr := limitRule{IP: body.IP, RateMbit: body.RateMbit, QuotaGB: body.QuotaGB, Reset: body.Reset, ResetDay: body.ResetDay}
		if nr.Reset == "never" {
			nr.ResetDay = 0
		}
		switch {
		case !known:
			err = fmt.Errorf("%s is not a server this panel has a tunnel to", body.IP)
		case nr.validate() != nil:
			err = nr.validate()
		case nr.RateMbit == 0 && nr.QuotaGB == 0:
			delete(limits.rules, body.IP) // unlimited both ways: no rule
		default:
			nr.PeriodStart = now.Unix()
			if exists {
				nr.UsedRx, nr.UsedTx, nr.PeriodStart, nr.Warned = cur.UsedRx, cur.UsedTx, cur.PeriodStart, cur.Warned
			}
			// A higher quota (or none) reconnects a cut server; a lower one cuts
			// it on the next tick.
			q := nr.quotaBytes()
			nr.Blocked = exists && cur.Blocked && q > 0 && nr.used() >= q
			if q > 0 && nr.used() < q/10*9 {
				nr.Warned = false
			}
			limits.rules[body.IP] = &nr
		}
	case "reset":
		if !exists {
			err = fmt.Errorf("no limit on %s", body.IP)
		} else {
			cur.UsedRx, cur.UsedTx, cur.Blocked, cur.Warned, cur.PeriodStart = 0, 0, false, false, now.Unix()
		}
	case "remove":
		delete(limits.rules, body.IP)
	default:
		err = fmt.Errorf("unknown action %q", body.Action)
	}
	if err == nil {
		err = limitsSaveLocked()
	}
	limits.Unlock()
	if err != nil {
		writeAPIError(w, r, "E-LIMIT-01", err.Error())
		return
	}
	limitsTick(now)
	writeJSON(w, limitsView())
}
