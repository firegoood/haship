package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"
)

// withRunner swaps the command runner for one test and resets exec stats.
func withRunner(t *testing.T, r cmdRunner) {
	t.Helper()
	old := runner
	runner = r
	resetExecStats()
	t.Cleanup(func() { runner = old; resetExecStats() })
}

func execStatFor(name string) (execStatJSON, bool) {
	for _, e := range execSnapshot() {
		if e.Command == name {
			return e, true
		}
	}
	return execStatJSON{}, false
}

func TestRunCmdCountsAndOutput(t *testing.T) {
	withRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "bad" {
			return []byte("boom"), errors.New("exit 1")
		}
		return []byte(strings.Join(args, " ")), nil
	})
	out, err := runCmdTimeout(time.Second, "echo", "a", "b")
	if err != nil || string(out) != "a b" {
		t.Fatalf("got %q %v", out, err)
	}
	out, err = runCmdTimeout(time.Second, "bad")
	if err == nil || string(out) != "boom" {
		t.Fatalf("error output must pass through, got %q %v", out, err)
	}
	e, ok := execStatFor("echo")
	if !ok || e.Calls != 1 || e.Errors != 0 || e.CallsLast60s != 1 {
		t.Fatalf("echo stats: %+v", e)
	}
	if b, _ := execStatFor("bad"); b.Errors != 1 {
		t.Fatalf("bad stats: %+v", b)
	}
}

func TestRunCmdTimeout(t *testing.T) {
	withRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		<-ctx.Done()
		return nil, ctx.Err()
	})
	start := time.Now()
	_, err := runCmdTimeout(40*time.Millisecond, "slow")
	if err == nil || time.Since(start) > time.Second {
		t.Fatalf("expected quick timeout, err=%v after %v", err, time.Since(start))
	}
	e, _ := execStatFor("slow")
	if e.Timeouts != 1 || e.Errors != 1 || e.MaxMs < 30 {
		t.Fatalf("slow stats: %+v", e)
	}
}

func TestRunCmdOutSelectsStdoutOnly(t *testing.T) {
	var got bool
	withRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		got = ctx.Value(stdoutOnlyKey{}) != nil
		return nil, nil
	})
	_, _ = runCmdTimeoutOut(time.Second, "x")
	if !got {
		t.Fatal("runCmdTimeoutOut must mark the context stdout-only")
	}
	_, _ = runCmdTimeout(time.Second, "x")
	if got {
		t.Fatal("runCmdTimeout must not be stdout-only")
	}
}

func TestRunCmdConcurrent(t *testing.T) {
	withRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) { return nil, nil })
	var wg sync.WaitGroup
	for i := 0; i < 50; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); _, _ = runCmdTimeout(time.Second, "c") }()
	}
	wg.Wait()
	if e, _ := execStatFor("c"); e.Calls != 50 {
		t.Fatalf("calls=%d", e.Calls)
	}
}

func realExitError(t *testing.T, code int) error {
	t.Helper()
	var cmd *exec.Cmd
	if runtime.GOOS == "windows" {
		cmd = exec.Command("cmd", "/c", fmt.Sprintf("exit %d", code))
	} else {
		cmd = exec.Command("sh", "-c", fmt.Sprintf("exit %d", code))
	}
	err := cmd.Run()
	if err == nil {
		t.Fatalf("exit %d command unexpectedly succeeded", code)
	}
	return err
}

func captureLog(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	old := log.Writer()
	log.SetOutput(&buf)
	t.Cleanup(func() { log.SetOutput(old) })
	return &buf
}

func TestExpectedProbeExit(t *testing.T) {
	cases := []struct {
		name string
		args []string
		code int
		want bool
	}{
		{"systemctl", []string{"is-active", "frps"}, 3, true},
		{"systemctl", []string{"is-active", "frps", "frpc"}, 4, true},
		{"systemctl", []string{"is-active", "frps"}, 1, false},
		{"systemctl", []string{"restart", "frps"}, 4, false},
		{"systemctl", nil, 4, false},
		{"ping", []string{"-c", "1", "1.1.1.1"}, 4, false},
	}
	for _, c := range cases {
		if got := expectedProbeExit(c.name, c.args, c.code); got != c.want {
			t.Errorf("expectedProbeExit(%q, %v, %d) = %v, want %v", c.name, c.args, c.code, got, c.want)
		}
	}
}

func TestRunCmdSilencesInactiveUnitProbe(t *testing.T) {
	for _, code := range []int{3, 4} {
		t.Run(fmt.Sprintf("exit_%d", code), func(t *testing.T) {
			withRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
				return []byte("inactive"), realExitError(t, code)
			})
			logs := captureLog(t)
			out, err := runCmdTimeoutOut(time.Second, "systemctl", "is-active", "frps")
			if err == nil || string(out) != "inactive" {
				t.Fatalf("probe must still return output and error, got %q %v", out, err)
			}
			if strings.Contains(logs.String(), "CMD-ERROR") {
				t.Fatalf("exit %d polluted the log: %s", code, logs.String())
			}
		})
	}
}

func TestRunCmdLogsUnexpectedSystemctlExit(t *testing.T) {
	withRunner(t, func(ctx context.Context, name string, args ...string) ([]byte, error) {
		return []byte("denied"), realExitError(t, 1)
	})
	logs := captureLog(t)
	if _, err := runCmdTimeoutOut(time.Second, "systemctl", "is-active", "frps"); err == nil {
		t.Fatal("expected the command error to pass through")
	}
	if !strings.Contains(logs.String(), "[CMD-ERROR]") {
		t.Fatalf("unexpected systemctl failure must still be logged: %q", logs.String())
	}
}

func TestRunCmdRealExec(t *testing.T) {
	old := runner
	runner = execRunner
	defer func() { runner = old }()
	out, err := runCmdTimeout(5*time.Second, "sh", "-c", "echo out; echo err 1>&2")
	if err != nil || !strings.Contains(string(out), "out") || !strings.Contains(string(out), "err") {
		t.Fatalf("combined: %q %v", out, err)
	}
	out, _ = runCmdTimeoutOut(5*time.Second, "sh", "-c", "echo out; echo err 1>&2")
	if strings.Contains(string(out), "err") {
		t.Fatalf("stdout-only leaked stderr: %q", out)
	}
}
