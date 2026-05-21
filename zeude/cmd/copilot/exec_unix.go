//go:build !windows

package main

import "syscall"

func execBinary(path string, args []string, env []string) error {
	return syscall.Exec(path, args, env)
}
