//go:build !windows

package main

import (
	"os"
	"os/exec"
	"os/signal"
	"syscall"
)

// execBinary runs the binary as a child process (not exec/replace), forwarding
// signals so the TUI works correctly. Returns exit code and any launch error.
func execBinary(path string, args []string, env []string) (int, error) {
	cmd := exec.Command(path, args[1:]...)
	cmd.Stdin = os.Stdin
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = env

	// Forward relevant signals to the child process.
	sigCh := make(chan os.Signal, 8)
	signal.Notify(sigCh, syscall.SIGTERM, syscall.SIGINT, syscall.SIGQUIT, syscall.SIGHUP, syscall.SIGWINCH)
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
			return exitErr.ExitCode(), nil
		}
		return 1, err
	}
	return 0, nil
}
