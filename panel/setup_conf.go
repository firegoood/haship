package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

func writeBackhaulServerConfig(path string, bindAddr string, transport string, token string, ports []string) error {
	if transport == "" {
		transport = "tcpmux"
	}
	var sb strings.Builder
	sb.WriteString("[server]\n")
	sb.WriteString(fmt.Sprintf("bind_addr = %q\n", bindAddr))
	sb.WriteString(fmt.Sprintf("transport = %q\n", transport))
	if token != "" {
		sb.WriteString(fmt.Sprintf("token = %q\n", token))
	}
	sb.WriteString("keepalive_period = 75\n")
	sb.WriteString("nodelay = true\n")
	sb.WriteString("heartbeat = 40\n")
	sb.WriteString("channel_size = 2048\n")
	sb.WriteString("sniffer = false\n")
	sb.WriteString("web_port = 0\n")
	sb.WriteString("sniffer_log = \"\"\n")
	sb.WriteString("log_level = \"info\"\n")
	if transport == "wss" || transport == "wssmux" {
		sb.WriteString("tls_cert = \"/etc/backhaul/server.crt\"\n")
		sb.WriteString("tls_key = \"/etc/backhaul/server.key\"\n")
	}
	sb.WriteString("ports = [\n")
	for i, p := range ports {
		comma := ","
		if i == len(ports)-1 {
			comma = ""
		}
		sb.WriteString(fmt.Sprintf("  %q%s\n", strings.TrimSpace(p), comma))
	}
	sb.WriteString("]\n")

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(sb.String()), 0600)
}

func writeBackhaulClientConfig(path string, remoteAddr string, transport string, token string) error {
	if transport == "" {
		transport = "tcpmux"
	}
	var sb strings.Builder
	sb.WriteString("[client]\n")
	sb.WriteString(fmt.Sprintf("remote_addr = %q\n", remoteAddr))
	sb.WriteString(fmt.Sprintf("transport = %q\n", transport))
	if token != "" {
		sb.WriteString(fmt.Sprintf("token = %q\n", token))
	}
	sb.WriteString("connection_pool = 8\n")
	sb.WriteString("nodelay = true\n")
	sb.WriteString("retry_interval = 3\n")
	sb.WriteString("keepalive_period = 75\n")
	sb.WriteString("sniffer = false\n")
	sb.WriteString("web_port = 0\n")
	sb.WriteString("sniffer_log = \"\"\n")
	sb.WriteString("log_level = \"info\"\n")

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	return os.WriteFile(path, []byte(sb.String()), 0600)
}

func randomToken(n int) string {
	const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("token-%d", n)
	}
	for i := range b {
		b[i] = chars[int(b[i])%len(chars)]
	}
	return string(b)
}

func randomFrpPort() int {
	var b [2]byte
	if _, err := rand.Read(b[:]); err != nil {
		return defaultFrpPortMin + (os.Getpid() % (defaultFrpPortMax - defaultFrpPortMin + 1))
	}
	val := int(b[0])<<8 | int(b[1])
	return defaultFrpPortMin + (val % (defaultFrpPortMax - defaultFrpPortMin + 1))
}
