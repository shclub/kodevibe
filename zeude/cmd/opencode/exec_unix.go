//go:build !windows

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

// execBinary runs the binary as a subprocess (not syscall.Exec) so we can
// post-process (read SQLite, send telemetry) after opencode exits.
// Returns (exitCode, error): error is non-nil only if the binary couldn't be launched.
func execBinary(path string, args []string, env []string) (int, error) {
	cmd := exec.Command(path, args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = env

	// Forward terminal signals to the child process so Ctrl+C / resize etc. work.
	sigCh := make(chan os.Signal, 8)
	signal.Notify(sigCh,
		syscall.SIGTERM,
		syscall.SIGINT,
		syscall.SIGQUIT,
		syscall.SIGHUP,
		syscall.SIGWINCH,
	)
	go func() {
		for sig := range sigCh {
			if cmd.Process != nil {
				_ = cmd.Process.Signal(sig)
			}
		}
	}()

	err := cmd.Run()
	signal.Stop(sigCh)
	close(sigCh)

	if err != nil {
		if exitErr, ok := err.(*exec.ExitError); ok {
			// Process exited with non-zero — normal (e.g. Ctrl+C).
			return exitErr.ExitCode(), nil
		}
		return 1, err
	}
	return 0, nil
}
