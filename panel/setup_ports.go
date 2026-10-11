package main

import (
	"fmt"
	"net"
	"os/exec"
	"strconv"
	"strings"
)

// allowUFWPorts opens both tcp and udp ports in UFW firewall if UFW is active.
func allowUFWPorts(ports []int) {
	if out, err := exec.Command("ufw", "status").CombinedOutput(); err == nil && strings.Contains(string(out), "Status: active") {
		for _, p := range ports {
			exec.Command("ufw", "allow", fmt.Sprintf("%d/tcp", p)).CombinedOutput()
			exec.Command("ufw", "allow", fmt.Sprintf("%d/udp", p)).CombinedOutput()
		}
	}
}

// rewriteTomlPorts rebuilds the [[proxies]] sections of an frps/frpc TOML file
// with the new port list. Non-proxy lines (header, [server], bindPort, etc.)
// are kept verbatim; only the [[proxies]] blocks are replaced.
func rewriteTomlPorts(src string, ports []int) string {
	var header strings.Builder
	inProxy := false
	for _, line := range strings.Split(src, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "[[proxies]]") {
			inProxy = true
			continue
		}
		if strings.HasPrefix(trimmed, "[") && !strings.HasPrefix(trimmed, "[[proxies]]") {
			inProxy = false
		}
		if !inProxy {
			header.WriteString(line)
			header.WriteByte('\n')
		}
	}
	result := strings.TrimRight(header.String(), "\n") + "\n"
	for _, port := range ports {
		result += fmt.Sprintf("\n[[proxies]]\nname = \"tcp_%d\"\ntype = \"tcp\"\nlocalIP = \"127.0.0.1\"\nlocalPort = %d\nremotePort = %d\n\n[[proxies]]\nname = \"udp_%d\"\ntype = \"udp\"\nlocalIP = \"127.0.0.1\"\nlocalPort = %d\nremotePort = %d\n", port, port, port, port, port, port)
	}
	return result
}

func isV4(s string) bool {
	ip := net.ParseIP(s)
	return ip != nil && ip.To4() != nil
}

// peerPortClash reports "PORT (peer NAME)" for the first requested port that
// another registered tunnel already serves. excludeID skips one peer (<0 = none).
func peerPortClash(want []int, excludeID int) string {
	claimed := map[int]string{}
	for _, p := range loadPeers() {
		if p.ID == excludeID {
			continue
		}
		for _, port := range p.Ports {
			claimed[port] = p.Name
		}
	}
	for _, port := range want {
		if name, ok := claimed[port]; ok {
			return fmt.Sprintf("%d (peer %s)", port, name)
		}
	}
	return ""
}

// peerDuplicateIPClash reports the name of an existing peer that already
// uses the given remote IP, skipping excludeID.
func peerDuplicateIPClash(remoteIP string, excludeID int) string {
	for _, p := range loadPeers() {
		if p.ID == excludeID {
			continue
		}
		if p.RemotePub == remoteIP {
			return p.Name
		}
	}
	return ""
}

func parsePorts(s string) []int {
	var out []int
	seen := map[int]bool{}
	for _, p := range strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	}) {
		n, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || n < 1 || n > 65535 || seen[n] {
			continue
		}
		seen[n] = true
		out = append(out, n)
	}
	return out
}

func isValidPortOrRangeOrMapping(s string) bool {
	s = strings.TrimSpace(s)
	if s == "" {
		return false
	}
	// Case 1: single port "443"
	if p, err := strconv.Atoi(s); err == nil {
		return p >= 1 && p <= 65535
	}
	// Case 2: range "10000-10050"
	if strings.Contains(s, "-") {
		parts := strings.Split(s, "-")
		if len(parts) == 2 {
			p1, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
			p2, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
			return err1 == nil && err2 == nil && p1 >= 1 && p2 <= 65535 && p1 < p2
		}
	}
	// Case 3: mapping "2083=8443"
	if strings.Contains(s, "=") {
		parts := strings.Split(s, "=")
		if len(parts) == 2 {
			p1, err1 := strconv.Atoi(strings.TrimSpace(parts[0]))
			p2, err2 := strconv.Atoi(strings.TrimSpace(parts[1]))
			return err1 == nil && err2 == nil && p1 >= 1 && p1 <= 65535 && p2 >= 1 && p2 <= 65535
		}
	}
	return false
}

func parseRawPorts(s string) []string {
	var out []string
	seen := map[string]bool{}
	for _, p := range strings.FieldsFunc(s, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	}) {
		p = strings.TrimSpace(p)
		if p == "" || seen[p] {
			continue
		}
		if isValidPortOrRangeOrMapping(p) {
			seen[p] = true
			out = append(out, p)
		}
	}
	return out
}

func extractNumericPorts(rawPorts []string) []int {
	var out []int
	seen := map[int]bool{}
	for _, rp := range rawPorts {
		if p, err := strconv.Atoi(rp); err == nil && p >= 1 && p <= 65535 {
			if !seen[p] {
				seen[p] = true
				out = append(out, p)
			}
		} else if strings.Contains(rp, "=") {
			parts := strings.Split(rp, "=")
			if p, err := strconv.Atoi(strings.TrimSpace(parts[0])); err == nil && p >= 1 && p <= 65535 {
				if !seen[p] {
					seen[p] = true
					out = append(out, p)
				}
			}
		} else if strings.Contains(rp, "-") {
			parts := strings.Split(rp, "-")
			if p, err := strconv.Atoi(strings.TrimSpace(parts[0])); err == nil && p >= 1 && p <= 65535 {
				if !seen[p] {
					seen[p] = true
					out = append(out, p)
				}
			}
		}
	}
	return out
}

func rewriteBackhaulTomlPorts(src string, ports []string) string {
	lines := strings.Split(src, "\n")
	var out []string
	inPorts := false
	portsAdded := false
	var portsBlock []string
	portsBlock = append(portsBlock, "ports = [")
	for i, p := range ports {
		comma := ","
		if i == len(ports)-1 {
			comma = ""
		}
		portsBlock = append(portsBlock, fmt.Sprintf("  %q%s", strings.TrimSpace(p), comma))
	}
	portsBlock = append(portsBlock, "]")

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "ports =") || strings.HasPrefix(trimmed, "ports=") {
			inPorts = true
			if !portsAdded {
				out = append(out, portsBlock...)
				portsAdded = true
			}
			if strings.HasSuffix(trimmed, "]") && strings.Contains(trimmed, "[") {
				inPorts = false
			}
			continue
		}
		if inPorts {
			if strings.HasPrefix(trimmed, "]") || strings.Contains(trimmed, "]") {
				inPorts = false
			}
			continue
		}
		out = append(out, line)
	}
	if !portsAdded {
		out = append(out, "")
		out = append(out, portsBlock...)
	}
	return strings.Join(out, "\n")
}
