// Go standard-library consumer; no Node JSON parser.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"
)

type Case struct {
	Name     string
	Args     []string
	Scenario string
	Log      string
	ExitCode int
	Expected string
}
type Config struct {
	Command     []string
	Environment map[string]string
	Cases       []Case
}
type Error struct {
	Code      string
	Retryable bool
	Handle    string
	Hint      string
	Details   struct{ Code string }
}
type Result struct {
	Status  string
	Backend string
	Match   string
	Reason  string
}
type Envelope struct {
	SchemaVersion int
	Ok            bool
	Result        *Result
	Error         *Error
	NextCommand   []string
}
type Record struct {
	Name     string          `json:"name"`
	Success  bool            `json:"success"`
	ExitCode int             `json:"exitCode"`
	Envelope json.RawMessage `json:"envelope"`
	Stderr   string          `json:"stderr"`
}

func require(ok bool, message string) {
	if !ok {
		panic(message)
	}
}
func main() {
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		panic(err)
	}
	var config Config
	if err = json.Unmarshal(data, &config); err != nil {
		panic(err)
	}
	records := []Record{}
	handle := ""
	for _, c := range config.Cases {
		args := append([]string{}, config.Command[1:]...)
		for _, a := range c.Args {
			if a == "$HANDLE" {
				a = handle
			}
			args = append(args, a)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		cmd := exec.CommandContext(ctx, config.Command[0], args...)
		for k, v := range config.Environment {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
		cmd.Env = append(cmd.Env, "POLYGLOT_SCENARIO="+c.Scenario, "POLYGLOT_LOG="+c.Log)
		var out, stderr bytes.Buffer
		cmd.Stdout = &out
		cmd.Stderr = &stderr
		cmd.Stdin = strings.NewReader("")
		err = cmd.Run()
		code := cmd.ProcessState.ExitCode()
		require(ctx.Err() == nil, "CLI timed out")
		cancel()
		if err != nil {
			require(code == c.ExitCode, stderr.String())
		}
		var e Envelope
		if err = json.Unmarshal(out.Bytes(), &e); err != nil {
			panic(err)
		}
		require(code == c.ExitCode && e.SchemaVersion == 1 && e.Ok == (code == 0), out.String())
		if e.Result != nil {
			require(e.Result.Status == c.Expected && e.Error == nil, out.String())
			if c.Expected == "verified" {
				require(e.Result.Backend == "sourcify" && e.Result.Match == "exact", out.String())
			}
			if c.Expected == "failed" {
				require(strings.Contains(e.Result.Reason, "no_match"), out.String())
			}
		} else {
			require(e.Error != nil && e.Error.Code == c.Expected, out.String())
			if c.Expected == "not-confirmed" {
				handle = e.Error.Handle
				require(e.Error.Retryable && strings.HasPrefix(handle, "ev1:sourcify:11155111:"), out.String())
				expected, _ := json.Marshal([]string{"explorer-verify", "status", handle, "--json"})
				actual, _ := json.Marshal(e.NextCommand)
				require(bytes.Equal(expected, actual), out.String())
			} else {
				require(!e.Error.Retryable && e.Error.Hint != "" && e.Error.Details.Code == c.Expected, out.String())
			}
		}
		records = append(records, Record{c.Name, true, code, json.RawMessage(out.Bytes()), stderr.String()})
	}
	output, err := json.Marshal(struct {
		Language  string   `json:"language"`
		Success   bool     `json:"success"`
		Scenarios []Record `json:"scenarios"`
	}{"go", true, records})
	if err != nil {
		panic(err)
	}
	fmt.Println(string(output))
}
