package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestSentinel_LifecycleAPI(t *testing.T) {
	// 1. Test GET /api/sentinel
	req := httptest.NewRequest("GET", "/api/sentinel", nil)
	rr := httptest.NewRecorder()

	handleSentinelGet(rr, req)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200 OK from GET /api/sentinel, got %d", rr.Code)
	}

	var status SentinelConfig
	if err := json.Unmarshal(rr.Body.Bytes(), &status); err != nil {
		t.Fatalf("failed decoding json response: %v", err)
	}

	// 2. Test POST /api/sentinel install rejection when unlicensed
	activeLicenseMu.Lock()
	activeLicense = nil
	licenseCheckedAt = time.Now()
	activeLicenseMu.Unlock()

	bodyInstall := bytes.NewBufferString(`{"action":"install"}`)
	reqPost := httptest.NewRequest("POST", "/api/sentinel", bodyInstall)
	rrPost := httptest.NewRecorder()

	handleSentinelPost(rrPost, reqPost)
	if rrPost.Code == http.StatusOK {
		t.Errorf("expected POST /api/sentinel install to fail without license, got 200 OK")
	}

	// 3. Test POST /api/sentinel install rejection on foreign server
	activeLicenseMu.Lock()
	activeLicense = &LicensePayload{
		Customer:  "test-user",
		Features:  []string{"sentinel"},
		ExpiresAt: time.Now().Add(24 * time.Hour).Unix(),
	}
	licenseCheckedAt = time.Now()
	activeLicenseMu.Unlock()

	bodyInvalid := bytes.NewBufferString(`{"action":"invalid_action"}`)
	reqInvalid := httptest.NewRequest("POST", "/api/sentinel", bodyInvalid)
	rrInvalid := httptest.NewRecorder()

	handleSentinelPost(rrInvalid, reqInvalid)
	if rrInvalid.Code != http.StatusBadRequest {
		t.Errorf("expected 400 Bad Request on invalid action, got %d", rrInvalid.Code)
	}
}
