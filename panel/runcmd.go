package main

import (
	"context"
	"errors"
	"log"
	"os/exec"
	"sort"
	"strings"
	"sync"
	"time"
)

// cmdRunner executes one external command and returns its output. Tests swap
// the package-level runner to stub the host.
type cmdRunner func(ctx context.Context, name string, args ...string) ([]byte, error)

type stdoutOnlyKey struct{}

// runner is the single seam for external commands that go through runCmdTimeout.
var runner cmdRunner = execRunner

// execRunner is the real implementation: combined output, or stdout only when
// the context was built by runCmdTimeoutOut.
func execRunner(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	if ctx.Value(stdoutOnlyKey{}) != nil {
		return cmd.Output()
	}
	return cmd.CombinedOutput()
}

// execStat accumulates per-command counters. buckets is a 60-slot per-second
// ring used for calls_last_60s without storing every call.
type execStat struct {
	calls    uint64
	total    time.Duration
	max      time.Duration
	timeouts uint64
	errors   uint64
	buckets  [60]struct {
		sec int64
		n   uint64
	}
}

var (
	execMu    sync.Mutex
	execStats = map[string]*execStat{}
)

func recordExec(name string, d time.Duration, err error, timedOut bool) {
	now := time.Now().Unix()
	execMu.Lock()
	defer execMu.Unlock()
	s := execStats[name]
	if s == nil {
		s = &execStat{}
		execStats[name] = s
	}
	s.calls++
	s.total += d
	if d > s.max {
		s.max = d
	}
	if timedOut {
		s.timeouts++
	}
	if err != nil {
		s.errors++
	}
	b := &s.buckets[now%60]
	if b.sec != now {
		b.sec, b.n = now, 0
	}
	b.n++
}

// expectedProbeExit reports a status query whose non-zero exit is a normal
// answer, not a failure: systemctl is-active exits 3 for an inactive unit and
// 4 for a unit that is not installed. The panel probes every engine that may
// exist on a host, so those codes must not fill the activity stream with
// CMD-ERROR entries on hosts that only run one engine.
func expectedProbeExit(name string, args []string, exitCode int) bool {
	return name == "systemctl" && len(args) > 0 && args[0] == "is-active" &&
		(exitCode == 3 || exitCode == 4)
}

func runCmdTimeoutCtx(ctx context.Context, timeout time.Duration, name string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	start := time.Now()
	out, err := runner(ctx, name, args...)
	timedOut := errors.Is(ctx.Err(), context.DeadlineExceeded)
	recordExec(name, time.Since(start), err, timedOut)
	if err != nil && !timedOut {
		var exitCode = -1
		var exitErr *exec.ExitError
		if errors.As(err, &exitErr) {
			exitCode = exitErr.ExitCode()
		}
		if !expectedProbeExit(name, args, exitCode) {
			trimmed := strings.TrimSpace(string(out))
			if len(trimmed) > 120 {
				trimmed = trimmed[:120] + "..."
			}
			if trimmed != "" {
				log.Printf("[CMD-ERROR] command %q failed (exit %d): %v | output: %s", name, exitCode, err, trimmed)
			} else {
				log.Printf("[CMD-ERROR] command %q failed (exit %d): %v", name, exitCode, err)
			}
		}
	}
	return out, err
}

// runCmdTimeout runs name with a hard timeout (combined stdout+stderr), counting the
// call in the exec metrics.
func runCmdTimeout(timeout time.Duration, name string, args ...string) ([]byte, error) {
	return runCmdTimeoutCtx(context.Background(), timeout, name, args...)
}

// runCmdTimeoutOut is runCmdTimeout returning stdout only (stderr is dropped).
func runCmdTimeoutOut(timeout time.Duration, name string, args ...string) ([]byte, error) {
	return runCmdTimeoutCtx(context.WithValue(context.Background(), stdoutOnlyKey{}, true), timeout, name, args...)
}

type execStatJSON struct {
	Command      string  `json:"command"`
	Calls        uint64  `json:"calls"`
	AvgMs        float64 `json:"avg_ms"`
	MaxMs        float64 `json:"max_ms"`
	Timeouts     uint64  `json:"timeouts"`
	Errors       uint64  `json:"errors"`
	CallsLast60s uint64  `json:"calls_last_60s"`
}

func execSnapshot() []execStatJSON {
	now := time.Now().Unix()
	execMu.Lock()
	defer execMu.Unlock()
	res := make([]execStatJSON, 0, len(execStats))
	for name, s := range execStats {
		e := execStatJSON{Command: name, Calls: s.calls, MaxMs: ms(s.max), Timeouts: s.timeouts, Errors: s.errors}
		if s.calls > 0 {
			e.AvgMs = ms(s.total) / float64(s.calls)
		}
		for _, b := range s.buckets {
			if now-b.sec < 60 && b.sec <= now {
				e.CallsLast60s += b.n
			}
		}
		res = append(res, e)
	}
	sort.Slice(res, func(i, j int) bool { return res[i].Command < res[j].Command })
	return res
}

func resetExecStats() {
	execMu.Lock()
	execStats = map[string]*execStat{}
	execMu.Unlock()
}

func ms(d time.Duration) float64 { return float64(d.Microseconds()) / 1000 }
