package main

import (
	"os"
	"strings"
	"testing"
	"time"
)

func TestSentinelEligibility_LicenseGating(t *testing.T) {
	_ = os.Remove(sentinelConfigPath())
	t.Cleanup(func() { _ = os.Remove(sentinelConfigPath()) })

	// 1. Without sentinel feature
	activeLicenseMu.Lock()
	activeLicense = &LicensePayload{
		Customer:  "test-basic",
		Features:  []string{"base_tunnel"},
		ExpiresAt: time.Now().Add(24 * time.Hour).Unix(),
	}
	licenseCheckedAt = time.Now()
	activeLicenseMu.Unlock()

	ok, reason := CheckSentinelEligibility("iran (server)", "IR")
	if ok {
		t.Errorf("expected eligibility failure without 'sentinel' feature, got ok=true")
	}
	if !strings.Contains(reason, "license") && !strings.Contains(reason, "License") {
		t.Errorf("expected license-related failure reason, got: %s", reason)
	}

	// 2. With sentinel feature but foreign server
	activeLicenseMu.Lock()
	activeLicense = &LicensePayload{
		Customer:  "test-pro",
		Features:  []string{"sentinel"},
		ExpiresAt: time.Now().Add(24 * time.Hour).Unix(),
	}
	licenseCheckedAt = time.Now()
	activeLicenseMu.Unlock()

	okForeign, reasonForeign := CheckSentinelEligibility("foreign (client)", "DE")
	if okForeign {
		t.Errorf("expected foreign server to be rejected, got ok=true")
	}
	if !strings.Contains(reasonForeign, "Iran") {
		t.Errorf("expected Iran restriction in failure reason, got: %s", reasonForeign)
	}

	// 3. With sentinel feature on verified Iran server (role = iran)
	okIran, _ := CheckSentinelEligibility("iran (server)", "XX")
	if !okIran {
		t.Errorf("expected Iran role to be eligible")
	}

	// 4. With sentinel feature on verified Iran server (country = IR)
	okCountry, _ := CheckSentinelEligibility("standalone", "IR")
	if !okCountry {
		t.Errorf("expected Iran country code to be eligible")
	}

	// 5. With wildcard license
	activeLicenseMu.Lock()
	activeLicense = &LicensePayload{
		Customer:  "test-enterprise",
		Features:  []string{"*"},
		ExpiresAt: time.Now().Add(24 * time.Hour).Unix(),
	}
	licenseCheckedAt = time.Now()
	activeLicenseMu.Unlock()

	okWildcard, _ := CheckSentinelEligibility("iran (backhaul)", "IR")
	if !okWildcard {
		t.Errorf("expected wildcard license to be eligible")
	}
}

func TestSentinel_RandomPortAllocation(t *testing.T) {
	port, err := PickRandomSentinelPort(30000, 39999)
	if err != nil {
		t.Fatalf("failed picking random port: %v", err)
	}
	if port < 30000 || port > 39999 {
		t.Errorf("port %d outside expected range [30000, 39999]", port)
	}
}

func TestSentinel_AlertFormatting(t *testing.T) {
	event := alertEvent{
		From: "healthy",
		To:   "down",
		Host: "my-node",
		Link: "gre-tunnel",
		Why:  "loss > 50%",
	}

	msg := formatSentinelTunnelAlert(event)
	if !strings.Contains(msg, "🚨 <b>[Hashem Tunnel Alert]</b>") {
		t.Errorf("expected alert header, got: %s", msg)
	}
	if !strings.Contains(msg, "HEALTHY ➔ <b>DOWN</b>") {
		t.Errorf("expected status transition, got: %s", msg)
	}
}
