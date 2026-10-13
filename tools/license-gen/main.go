package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Default master public key (embedded in panel binary)
const defaultMasterPublicKeyB64 = "U2gUVDmihrylZPVlScgPGP28pFMkEwAXtJODjAKoFLs="

type LicensePayload struct {
	Customer    string   `json:"customer"`
	MachineHash string   `json:"machine_hash"`
	Features    []string `json:"features"`
	ExpiresAt   int64    `json:"expires_at"`
	IssuedAt    int64    `json:"issued_at"`
}

func main() {
	customer := flag.String("customer", "", "Customer name or identifier")
	machineHash := flag.String("machine-hash", "*", "Target machine hash (32-char hex, or * for all machines)")
	days := flag.Int("days", 30, "License validity duration in days (0 for lifetime)")
	features := flag.String("features", "frp_ssh,watchdog", "Comma-separated list of enabled features")
	privKeyB64 := flag.String("privkey", "", "Base64 Ed25519 private key (or via env HASHEM_LICENSE_PRIVKEY)")
	verifyToken := flag.String("verify", "", "Verify an existing license token")
	genKeypair := flag.Bool("gen-keypair", false, "Generate a new Ed25519 master keypair")

	flag.Parse()

	if *genKeypair {
		pub, priv, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error generating keypair: %v\n", err)
			os.Exit(1)
		}
		fmt.Printf("NEW_PUBLIC_KEY:  %s\n", base64.StdEncoding.EncodeToString(pub))
		fmt.Printf("NEW_PRIVATE_KEY: %s\n", base64.StdEncoding.EncodeToString(priv))
		return
	}

	if *verifyToken != "" {
		verifyLicense(*verifyToken, defaultMasterPublicKeyB64)
		return
	}

	if *customer == "" {
		fmt.Println("Usage: license-gen -customer <name> [-machine-hash <hex>] [-days 30] [-features frp_ssh,...]")
		fmt.Println("\nTo verify:  license-gen -verify <token>")
		fmt.Println("To gen key: license-gen -gen-keypair")
		os.Exit(1)
	}

	keyStr := strings.TrimSpace(*privKeyB64)
	if keyStr == "" {
		keyStr = strings.TrimSpace(os.Getenv("HASHEM_LICENSE_PRIVKEY"))
	}
	if keyStr == "" {
		// Try reading from ~/.hashem-license/master.key
		home, _ := os.UserHomeDir()
		if data, err := os.ReadFile(filepath.Join(home, ".hashem-license", "master.key")); err == nil {
			keyStr = strings.TrimSpace(string(data))
		}
	}

	if keyStr == "" {
		fmt.Fprintln(os.Stderr, "Error: Master private key required to sign license.")
		fmt.Fprintln(os.Stderr, "Provide via -privkey flag, HASHEM_LICENSE_PRIVKEY env, or ~/.hashem-license/master.key file.")
		os.Exit(1)
	}

	privBytes, err := base64.StdEncoding.DecodeString(keyStr)
	if err != nil || len(privBytes) != ed25519.PrivateKeySize {
		fmt.Fprintf(os.Stderr, "Error: invalid private key (length %d, expected %d)\n", len(privBytes), ed25519.PrivateKeySize)
		os.Exit(1)
	}
	privKey := ed25519.PrivateKey(privBytes)

	featList := []string{}
	for _, f := range strings.Split(*features, ",") {
		f = strings.TrimSpace(f)
		if f != "" {
			featList = append(featList, f)
		}
	}

	now := time.Now()
	var exp int64
	if *days > 0 {
		exp = now.Add(time.Duration(*days) * 24 * time.Hour).Unix()
	} else {
		exp = -1 // Lifetime
	}

	payload := LicensePayload{
		Customer:    *customer,
		MachineHash: strings.TrimSpace(*machineHash),
		Features:    featList,
		ExpiresAt:   exp,
		IssuedAt:    now.Unix(),
	}

	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error serializing JSON: %v\n", err)
		os.Exit(1)
	}

	sig := ed25519.Sign(privKey, payloadJSON)

	token := fmt.Sprintf("%s.%s",
		base64.RawURLEncoding.EncodeToString(payloadJSON),
		base64.RawURLEncoding.EncodeToString(sig),
	)

	fmt.Println("==================================================")
	fmt.Printf("Customer:     %s\n", payload.Customer)
	fmt.Printf("Machine Hash: %s\n", payload.MachineHash)
	fmt.Printf("Features:     %s\n", strings.Join(payload.Features, ", "))
	if payload.ExpiresAt > 0 {
		fmt.Printf("Expires:      %s (%d days)\n", time.Unix(payload.ExpiresAt, 0).Format("2006-01-02 15:04:05 UTC"), *days)
	} else {
		fmt.Println("Expires:      Lifetime (never)")
	}
	fmt.Println("--------------------------------------------------")
	fmt.Printf("LICENSE KEY:\n\n%s\n\n", token)
	fmt.Println("==================================================")
}

func verifyLicense(token, pubB64 string) {
	parts := strings.Split(strings.TrimSpace(token), ".")
	if len(parts) != 2 {
		fmt.Println("FAIL: Invalid format (not payload.sig)")
		os.Exit(1)
	}
	payloadBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		fmt.Printf("FAIL: Payload decode error: %v\n", err)
		os.Exit(1)
	}
	sigBytes, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		fmt.Printf("FAIL: Signature decode error: %v\n", err)
		os.Exit(1)
	}
	pubBytes, _ := base64.StdEncoding.DecodeString(pubB64)
	if !ed25519.Verify(pubBytes, payloadBytes, sigBytes) {
		fmt.Println("FAIL: Signature mismatch / tampered token!")
		os.Exit(1)
	}

	var p LicensePayload
	_ = json.Unmarshal(payloadBytes, &p)
	fmt.Println("VALID LICENSE:")
	fmt.Printf("  Customer:     %s\n", p.Customer)
	fmt.Printf("  Machine Hash: %s\n", p.MachineHash)
	fmt.Printf("  Features:     %s\n", strings.Join(p.Features, ", "))
	if p.ExpiresAt > 0 {
		fmt.Printf("  Expires:      %s\n", time.Unix(p.ExpiresAt, 0).Format("2006-01-02 15:04:05 UTC"))
		if time.Now().Unix() > p.ExpiresAt {
			fmt.Println("  STATUS:       EXPIRED")
		} else {
			fmt.Println("  STATUS:       ACTIVE")
		}
	} else {
		fmt.Println("  Expires:      Lifetime")
		fmt.Println("  STATUS:       ACTIVE")
	}
}

// Helper to hash raw machine ID
func hashRawID(rawID string) string {
	h := sha256.Sum256([]byte("hashem-lic-v1:" + strings.TrimSpace(rawID)))
	return hex.EncodeToString(h[:16])
}
