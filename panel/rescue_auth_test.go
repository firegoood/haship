package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func withRescueTestConfig(t *testing.T, secret, peers string, st rescueState) {
	t.Helper()
	oldDir, oldPort := configDir, cfg.Port
	oldSnap := snapPtr.Load()
	configDir = t.TempDir()
	cfg.Port = 7777
	snapPtr.Store(nil)
	t.Cleanup(func() {
		configDir, cfg.Port = oldDir, oldPort
		snapPtr.Store(oldSnap)
	})
	if err := savePeerConfig(PeerConfig{Role: "master", PeerSecret: secret, AutoPilotExplicit: true}); err != nil {
		t.Fatal(err)
	}
	if peers != "" {
		if err := os.WriteFile(peersFile(), []byte(peers), 0600); err != nil {
			t.Fatal(err)
		}
	}
	rescueMu.Lock()
	err := saveRescueLocked(st)
	rescueMu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
}

func rescueAuthReq(ip, secret string) *http.Request {
	r := httptest.NewRequest("GET", "/base/api/peer/rescue-offer", nil)
	r.RemoteAddr = ip + ":54321"
	if secret != "" {
		r.Header.Set("X-Peer-Secret", secret)
	}
	return r
}

func TestRescuePeerAllowedAcceptsKnownPeersAndTunnelTokens(t *testing.T) {
	const (
		mainSecret = "main-peer-link-secret"
		peerToken  = "peer-two-token"
		mainToken  = "legacy-main-token"
	)
	withRescueTestConfig(t, mainSecret,
		`{"peers":[`+
			`{"id":2,"name":"nl","remote_pub":"198.51.100.23","token":"peer-two-token"},`+
			`{"id":1,"name":"main","legacy":true,"remote_pub":"198.51.100.24","token":"legacy-main-token"}]}`,
		rescueState{RemoteIP: "203.0.113.50"})

	cases := []struct {
		name, ip, secret string
		want             bool
	}{
		{"designated rescue IP", "203.0.113.50", "", true},
		{"peer registry IP", "198.51.100.23", "", true},
		{"legacy peer IP", "198.51.100.24", "", true},
		{"main peer-link secret", "192.0.2.200", mainSecret, true},
		{"per-tunnel token", "192.0.2.200", peerToken, true},
		{"legacy tunnel token", "192.0.2.200", mainToken, true},
		{"wrong secret", "192.0.2.200", "nope", false},
		{"unknown peer without secret", "192.0.2.200", "", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := rescuePeerAllowed(rescueAuthReq(c.ip, c.secret)); got != c.want {
				t.Fatalf("rescuePeerAllowed(%s, %q) = %v, want %v", c.ip, c.secret, got, c.want)
			}
		})
	}
}

func TestRescuePeerAuthWrapper(t *testing.T) {
	withRescueTestConfig(t, "main-peer-link-secret",
		`{"peers":[{"id":2,"name":"nl","remote_pub":"198.51.100.23","token":"peer-two-token"}]}`,
		rescueState{RemoteIP: "203.0.113.50"})

	called := false
	h := requireRescuePeerAuth(func(w http.ResponseWriter, r *http.Request) { called = true })

	rr := httptest.NewRecorder()
	h(rr, rescueAuthReq("198.51.100.23", ""))
	if !called || rr.Code != http.StatusOK {
		t.Fatalf("known peer must pass: called=%v status=%d", called, rr.Code)
	}

	called = false
	rr = httptest.NewRecorder()
	h(rr, rescueAuthReq("192.0.2.200", "bad"))
	if called || rr.Code != http.StatusUnauthorized {
		t.Fatalf("unknown peer must be rejected: called=%v status=%d", called, rr.Code)
	}
}

func TestPeerRescueOfferNonDesignatedPeerGetsNoOffer(t *testing.T) {
	withRescueTestConfig(t, "main-peer-link-secret",
		`{"peers":[{"id":2,"name":"nl","remote_pub":"198.51.100.23","token":"peer-two-token"}]}`,
		rescueState{Role: "origin", RemoteIP: "203.0.113.50", CtrlPort: 31000, Token: randHex(24), Secret: randHex(16)})

	rr := httptest.NewRecorder()
	handlePeerRescueOffer(rr, rescueAuthReq("198.51.100.23", "peer-two-token"))
	if rr.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", rr.Code)
	}
	var body struct {
		Offer bool `json:"offer"`
	}
	if err := json.Unmarshal(rr.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Offer {
		t.Fatal("a peer that is not the designated entry must not receive an offer")
	}
}
