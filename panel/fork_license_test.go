package main

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// licenseManagerFixture is test-only output from the standalone license
// manager's signing code. A copy lives under panel/testdata so the panel
// repository stays self-contained when the manager lives outside it.
type licenseManagerFixture struct {
	PublicKey string         `json:"public_key"`
	Token     string         `json:"token"`
	Payload   LicensePayload `json:"payload"`
}

func loadLicenseManagerFixture(t *testing.T) licenseManagerFixture {
	t.Helper()
	path := filepath.Join("testdata", "compat.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read license-manager fixture %s: %v", path, err)
	}
	var fixture licenseManagerFixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		t.Fatalf("decode license-manager fixture: %v", err)
	}
	return fixture
}

func TestForkPublicKeyIsTrusted(t *testing.T) {
	keyBytes, err := base64.StdEncoding.DecodeString(forkLicensePublicKeyB64)
	if err != nil || len(keyBytes) != ed25519.PublicKeySize {
		t.Fatalf("fork public key is not a valid Ed25519 key: len=%d err=%v", len(keyBytes), err)
	}

	found := false
	legacyFound := false
	const legacyPublicKeyB64 = "U2gUVDmihrylZPVlScgPGP28pFMkEwAXtJODjAKoFLs="
	for _, configured := range defaultTrustedMasterPublicKeysB64 {
		if configured == forkLicensePublicKeyB64 {
			found = true
		}
		if configured == legacyPublicKeyB64 {
			legacyFound = true
		}
	}
	if !found {
		t.Fatal("fork public key is missing from defaultTrustedMasterPublicKeysB64")
	}
	if !legacyFound {
		t.Fatal("legacy v2.3.4 public key is missing from defaultTrustedMasterPublicKeysB64")
	}
	if defaultTrustedMasterPublicKeysB64[0] != defaultMasterPublicKeyB64 {
		t.Fatal("upstream active master key is no longer first in the trusted list")
	}
	if len(defaultTrustedMasterPublicKeysB64) < 3 {
		t.Fatal("legacy or fork trusted keys were removed")
	}

	origMaster, origTrusted := masterPublicKeyB64, trustedMasterPublicKeysB64
	masterPublicKeyB64, trustedMasterPublicKeysB64 = defaultMasterPublicKeyB64, defaultTrustedMasterPublicKeysB64
	defer func() { masterPublicKeyB64, trustedMasterPublicKeysB64 = origMaster, origTrusted }()

	loaded := false
	for _, candidate := range getTrustedPublicKeys() {
		if bytes.Equal(candidate, keyBytes) {
			loaded = true
		}
	}
	if !loaded {
		t.Fatal("fork public key is not returned by getTrustedPublicKeys")
	}
}

func TestLicenseManagerFixtureAccepted(t *testing.T) {
	fixture := loadLicenseManagerFixture(t)
	testKey, err := base64.StdEncoding.DecodeString(fixture.PublicKey)
	if err != nil || len(testKey) != ed25519.PublicKeySize {
		t.Fatalf("fixture public key invalid: %v", err)
	}

	origMaster, origTrusted := masterPublicKeyB64, trustedMasterPublicKeysB64
	masterPublicKeyB64 = fixture.PublicKey
	trustedMasterPublicKeysB64 = nil
	defer func() {
		masterPublicKeyB64, trustedMasterPublicKeysB64 = origMaster, origTrusted
		activeLicenseMu.Lock()
		activeLicense = nil
		licenseCheckedAt = time.Now()
		activeLicenseMu.Unlock()
	}()

	payload, err := verifyLicenseKey(fixture.Token)
	if err != nil {
		t.Fatalf("panel rejected a license produced by license-manager: %v", err)
	}
	if payload.Customer != fixture.Payload.Customer ||
		payload.ExpiresAt != fixture.Payload.ExpiresAt ||
		len(payload.Features) != len(fixture.Payload.Features) {
		t.Fatalf("verified payload mismatch: %+v", payload)
	}

	parts := splitTokenForTest(t, fixture.Token)
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	var tampered LicensePayload
	if err := json.Unmarshal(payloadBytes, &tampered); err != nil {
		t.Fatal(err)
	}
	tampered.Customer = "Attacker"
	tamperedBytes, err := json.Marshal(tampered)
	if err != nil {
		t.Fatal(err)
	}
	tamperedToken := base64.RawURLEncoding.EncodeToString(tamperedBytes) + "." + parts[1]
	if _, err := verifyLicenseKey(tamperedToken); err == nil {
		t.Fatal("panel accepted a modified payload with the original signature")
	}
}

func splitTokenForTest(t *testing.T, token string) [2]string {
	t.Helper()
	for i := 0; i < len(token); i++ {
		if token[i] == '.' {
			return [2]string{token[:i], token[i+1:]}
		}
	}
	t.Fatalf("token has no separator: %s", token)
	return [2]string{}
}
