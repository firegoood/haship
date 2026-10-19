package main

// A lab test of the cluster's kernel rules: it needs root, iptables and a
// network namespace of its own, so it only runs with HASHEM_LB_LAB=1, e.g.
//   docker run --rm --privileged -v $PWD:/src -w /src/panel golang:1.24 \
//     sh -c 'apt-get update && apt-get install -y iptables iproute2 && HASHEM_LB_LAB=1 go test -run TestLBLab .'
// Backends listen on private addresses of the hashem-lb dummy interface;
// connections to this host's own address must reach them the way the pools,
// the stickiness and the pass-through ports say.

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func labServe(t *testing.T, addr string) {
	t.Helper()
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("listen %s: %v", addr, err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			fmt.Fprintf(c, "%s\n", addr)
			c.Close()
		}
	}()
}

func labAsk(t *testing.T, addr string) string {
	t.Helper()
	c, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return "refused"
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	line, _ := bufio.NewReader(c).ReadString('\n')
	return strings.TrimSpace(line)
}

func labHostIP(t *testing.T) string {
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if ip, ok := a.(*net.IPNet); ok && ip.IP.To4() != nil && !ip.IP.IsLoopback() && !strings.HasPrefix(ip.IP.String(), "169.254.") {
			return ip.IP.String()
		}
	}
	t.Skip("no IPv4 address")
	return ""
}

func TestLBLab(t *testing.T) {
	if os.Getenv("HASHEM_LB_LAB") != "1" {
		t.Skip("lab test: set HASHEM_LB_LAB=1 (root, iptables, own network namespace)")
	}
	configDir = t.TempDir()
	old := runner
	runner = execRunner // TestMain stubs host commands; this test is about them
	defer func() { runner = old }()
	a2, a3 := "169.254.77.2", "169.254.77.3"
	if err := lbEnsureAddrs([]string{a2, a3}); err != nil {
		t.Fatal(err)
	}
	defer lbEnsureAddrs(nil)
	labServe(t, a2+":18080")
	labServe(t, a3+":18080")
	labServe(t, a3+":18443")
	labServe(t, a2+":19000")
	labServe(t, a2+":19001")
	host := labHostIP(t)

	two := []lbTarget{{Link: 1, Addr: a2, Port: 18080, Weight: 1}, {Link: 2, Addr: a3, Port: 18080, Weight: 1}}
	plan := lbPlan{
		Pools: []lbPoolPlan{
			{Port: 18080, Proto: "both", Mode: lbBalance, Targets: two},
			{Port: 18081, Proto: "tcp", Mode: lbSticky, Targets: two},
			{Port: 18082, Proto: "tcp", Mode: lbFailover, Targets: []lbTarget{{Link: 2, Addr: a3, Port: 18443, Weight: 1}}},
		},
		Pass: []lbPortRange{{Proto: "tcp", From: 19000, To: 19001, Addr: a2, Link: 1}},
	}
	text := lbRulesText(plan)
	if err := lbApplyRules(text, nil); err != nil {
		t.Fatalf("apply: %v\n%s", err, text)
	}
	defer lbClearRules(lbChainsIn(text))

	// balance: both members get connections
	hits := map[string]int{}
	for i := 0; i < 200; i++ {
		hits[labAsk(t, host+":18080")]++
	}
	if hits[a2+":18080"] < 50 || hits[a3+":18080"] < 50 {
		t.Fatalf("balance spread: %v", hits)
	}
	// sticky: one source address always lands on the same member
	sticky := map[string]int{}
	for i := 0; i < 50; i++ {
		sticky[labAsk(t, host+":18081")]++
	}
	if len(sticky) != 1 || sticky["refused"] > 0 {
		t.Fatalf("sticky moved a user: %v", sticky)
	}
	// failover target with its own port, and pass-through ports of a bound relay
	if got := labAsk(t, host+":18082"); got != a3+":18443" {
		t.Fatalf("failover: %s", got)
	}
	if got := labAsk(t, host+":19001"); got != a2+":19001" {
		t.Fatalf("pass-through: %s", got)
	}
	// the relays' private addresses still answer locally
	if got := labAsk(t, a2+":18080"); got != a2+":18080" {
		t.Fatalf("local to private address: %s", got)
	}
	// re-applying a changed plan swaps atomically; a removed pool's chain goes
	plan.Pools = plan.Pools[:1]
	plan.Pools[0].Targets = two[1:]
	text2 := lbRulesText(plan)
	if err := lbApplyRules(text2, lbChainsIn(text)); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 20; i++ {
		if got := labAsk(t, host+":18080"); got != a3+":18080" {
			t.Fatalf("after the swap: %s", got)
		}
	}
	if out, _ := runCmdTimeout(5*time.Second, "iptables", "-t", "nat", "-S"); strings.Contains(string(out), "HLB-T18081") {
		t.Fatal("the removed pool's chain is still there")
	}
	// clearing removes every hook: the port is closed again
	lbClearRules(lbChainsIn(text2))
	if got := labAsk(t, host+":18080"); got != "refused" {
		t.Fatalf("after clear: %s", got)
	}
	if out, _ := runCmdTimeout(5*time.Second, "iptables", "-t", "nat", "-S"); strings.Contains(string(out), "HASHEM-LB") {
		t.Fatalf("leftovers:\n%s", out)
	}
}

// TestLBLabServe is not a test: TestLBLabForward runs the test binary inside
// a network namespace with HASHEM_LB_LAB_SERVE=addr to stand in for the
// other Iran hub.
func TestLBLabServe(t *testing.T) {
	addr := os.Getenv("HASHEM_LB_LAB_SERVE")
	if addr == "" {
		t.Skip("helper")
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatal(err)
	}
	for {
		c, err := ln.Accept()
		if err != nil {
			return
		}
		fmt.Fprintf(c, "far %s\n", c.RemoteAddr().(*net.TCPAddr).IP)
		c.Close()
	}
}

// A pool with no working member is forwarded to another hub: a client in its
// own namespace connects to this host, the hub "far" (another namespace)
// answers, with FORWARD dropped by default as ufw sets it.
func TestLBLabForward(t *testing.T) {
	if os.Getenv("HASHEM_LB_LAB") != "1" {
		t.Skip("lab test: set HASHEM_LB_LAB=1")
	}
	configDir = t.TempDir()
	old := runner
	runner = execRunner
	defer func() { runner = old }()
	sh := func(a ...string) {
		if out, err := runCmdTimeout(10*time.Second, a[0], a[1:]...); err != nil {
			t.Fatalf("%v: %s", a, out)
		}
	}
	for _, ns := range []string{"far", "client"} {
		_, _ = runCmdTimeout(5*time.Second, "ip", "netns", "del", ns)
		sh("ip", "netns", "add", ns)
		defer runCmdTimeout(5*time.Second, "ip", "netns", "del", ns)
	}
	sh("ip", "link", "add", "vfar", "type", "veth", "peer", "name", "vfar0", "netns", "far")
	sh("ip", "addr", "add", "10.99.0.1/24", "dev", "vfar")
	sh("ip", "link", "set", "vfar", "up")
	sh("ip", "netns", "exec", "far", "ip", "addr", "add", "10.99.0.2/24", "dev", "vfar0")
	sh("ip", "netns", "exec", "far", "ip", "link", "set", "vfar0", "up")
	sh("ip", "link", "add", "vcli", "type", "veth", "peer", "name", "vcli0", "netns", "client")
	sh("ip", "addr", "add", "10.98.0.1/24", "dev", "vcli")
	sh("ip", "link", "set", "vcli", "up")
	sh("ip", "netns", "exec", "client", "ip", "addr", "add", "10.98.0.2/24", "dev", "vcli0")
	sh("ip", "netns", "exec", "client", "ip", "link", "set", "vcli0", "up")
	sh("ip", "netns", "exec", "client", "ip", "route", "add", "default", "via", "10.98.0.1")
	sh("iptables", "-P", "FORWARD", "DROP")
	defer runCmdTimeout(5*time.Second, "iptables", "-P", "FORWARD", "ACCEPT")

	exe, _ := os.Executable()
	srv := exec.Command("ip", "netns", "exec", "far", exe, "-test.run", "^TestLBLabServe$")
	srv.Env = append(os.Environ(), "HASHEM_LB_LAB_SERVE=10.99.0.2:18090")
	if err := srv.Start(); err != nil {
		t.Fatal(err)
	}
	defer srv.Process.Kill()
	time.Sleep(500 * time.Millisecond)

	ask := func() string {
		out, _ := runCmdTimeout(5*time.Second, "ip", "netns", "exec", "client", "bash", "-c",
			"exec 3<>/dev/tcp/10.98.0.1/18090 && head -1 <&3")
		return strings.TrimSpace(string(out))
	}
	if got := ask(); strings.HasPrefix(got, "far") {
		t.Fatalf("answered before forwarding: %s", got)
	}
	text := lbRulesText(lbPlan{Forward: []lbForward{{Port: 18090, Proto: "tcp", To: "10.99.0.2"}}})
	if err := lbApplyRules(text, nil); err != nil {
		t.Fatalf("%v\n%s", err, text)
	}
	defer lbClearRules(nil)
	// the far hub sees this hub (MASQUERADE), so its answer comes back here
	if got := ask(); got != "far 10.99.0.1" {
		t.Fatalf("forward: %q", got)
	}
	lbClearRules(nil)
	if got := ask(); strings.HasPrefix(got, "far") {
		t.Fatalf("still forwarded after clear: %s", got)
	}
}
