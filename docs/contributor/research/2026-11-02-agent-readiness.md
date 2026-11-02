# 2026-11-02: Agent readiness of docs and CLIs

Audience: contributors who need the evidence behind requirements R-AX and decision 0007. Sources
read and tools run between 2026-10-31 and 2026-11-02.

Question: what lets a coding agent that has never seen a tool find the right page or command, run
it without a terminal, read the result, check that it worked and recover from a failure?

## Strength of the evidence

No peer-reviewed study isolates CLI design properties (JSON or text output, help quality, exit
codes) against agent success. [Terminal-Bench](https://arxiv.org/abs/2601.11868) measures agent capability in a shell, not the design
of the tools it calls. The evidence below is practitioner guidance from CLI authors and model
vendors, one controlled docs benchmark run by a docs vendor, and academic work on retrieved
documentation. The rubric checks are testable, which is why they became requirements.

## Sources

| Source                                                                                                                                                                                       | What it says                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Command Line Interface Guidelines](https://clig.dev/) (clig.dev)                                                                                                                            | Primary output on stdout, errors on stderr. Offer `--json`. "Never _require_ a prompt" and prompt only when stdin is a terminal. Offer `--dry-run`. "Do not read secrets directly from flags". Lead help with examples. Suggest the intended command after a typo. "Map the non-zero exit codes to the most important failure modes". The guide predates coding agents and does not mention them.                                                                                                                    |
| [Anthropic, "Writing effective tools for AI agents"](https://www.anthropic.com/engineering/writing-tools-for-agents) (2025-09-11)                                                            | "Return only high signal information". Default limits, pagination or truncation for large output; Claude Code caps a tool response at 25,000 tokens by default. Errors should "communicate specific and actionable improvements, rather than opaque error codes or tracebacks". Build an evaluation to measure tool performance. Written for tool and MCP design.                                                                                                                                                    |
| [Claude Code best practices](https://code.claude.com/docs/en/best-practices)                                                                                                                 | "For a CLI it hasn't seen before, pointing it at `--help` is enough." Help text is the first document an agent reads.                                                                                                                                                                                                                                                                                                                                                                                                |
| [llmstxt.org](https://llmstxt.org/)                                                                                                                                                          | Proposed 2024-09-03. A Markdown index at `/llms.txt`: an H1 (the only required part), a summary blockquote, H2 sections of links, Markdown twins of pages. Intended "mainly" for inference, not training. Not a W3C or IETF standard.                                                                                                                                                                                                                                                                                |
| [Mintlify url-discovery-bench](https://github.com/mintlify/url-discovery-bench), with the [article](https://www.mintlify.com/library/how-to-make-your-documentation-agent-friendly)          | Run in July 2026, published 2026-09-25: 2,400 runs (20 docs sites, 5 questions, 4 serving formats, Claude Code and Codex, 3 attempts). Failed requests per task: HTML 2.23, Markdown 1.42, Markdown with an `llms.txt` link 0.11. Agents probe for `.md` and `/llms.txt` without being told. Markdown with no index gave more wrong guesses than HTML. The metric is whether the agent found the right page, not answer quality. All 20 sites are hosted by the vendor that ran the study; code and data are public. |
| [EZY Research crawler study](https://www.ezy.ai/research/do-ai-bots-read-llms-txt) (2026-07-27)                                                                                              | Logs from 83 sites, 2026-04-27 to 2026-07-19. `llms.txt` fetches against `robots.txt` fetches: GPTBot family 7 against 3,990, ClaudeBot 9 against 3,120, PerplexityBot 0 against 775. Search and training crawlers rarely read `llms.txt`. User-triggered agents were not separated.                                                                                                                                                                                                                                 |
| [Gorilla, arXiv 2305.15334](https://arxiv.org/abs/2305.15334)                                                                                                                                | A model trained to use a documentation retriever adapts to documentation changes at test time and makes fewer wrong API calls. Supports docs that match the installed version.                                                                                                                                                                                                                                                                                                                                       |
| [GitHub CLI skill](https://github.com/cli/cli/blob/trunk/skills/gh/SKILL.md) and `gh help exit-codes`                                                                                        | gh 2.92.0: `--json` with no field list prints the available fields; `--jq`. Without a terminal it skips the pager, strips colour and fails fast instead of prompting, naming the missing flags. Exit codes 0 ok, 1 failed, 2 cancelled, 4 authentication required. List commands cap results at 30 (the `--limit` default). The skill ships in the gh repository.                                                                                                                                                    |
| [Terraform machine-readable UI](https://developer.hashicorp.com/terraform/internals/machine-readable-ui) and [`terraform plan`](https://developer.hashicorp.com/terraform/cli/commands/plan) | `-json` streams one JSON message per line. The first message carries a `ui` version; minor versions are backward compatible and consumers ignore unknown properties. `plan -out` then `apply` separates the check from the change. `-detailed-exitcode`: 0 no changes, 1 error, 2 changes present. `-json` implies `-input=false`.                                                                                                                                                                                   |
| [Pulumi exit codes](https://www.pulumi.com/docs/iac/cli/exit-codes/) and [Automation API](https://www.pulumi.com/docs/iac/concepts/automation-api/)                                          | 0 success, 1 generic, 2 configuration or validation (including a missing `--yes` without a terminal), 3 authentication, 4 resource or deployment, 5 policy, 6 stack not found, 7 no changes, 8 cancelled, 9 timeout, 255 internal. The mapping was introduced in v3.226.1, and v3.254.0 changed a bare `pulumi` from exit 0 to exit 1, so an exit-code contract has to name its version.                                                                                                                             |
| [Cloudflare `cf` agent docs](https://developers.cloudflare.com/cf/agents/)                                                                                                                   | `--dry-run` prints the request without sending it and needs no credentials. When stdout is not a terminal it holds only the result. JSON is the default output (read from the docs, not run).                                                                                                                                                                                                                                                                                                                        |
| [Mario Zechner, "MCP vs CLI"](https://mariozechner.at/posts/2025-08-15-mcp-vs-cli/) (2025-08-15)                                                                                             | 120 runs through Claude Code on three interactive terminal tasks with four tools (terminalcp MCP, terminalcp CLI, tmux, screen); all four reached 100% success, the two terminalcp variants at similar cost. Tool design and docs mattered more than the protocol. One author, one agent family.                                                                                                                                                                                                                     |

## Rubric

22 checks, 8 for docs and 14 for a CLI. Each scores 0 (absent), 1 (partial) or 2 (meets), with the
tool version and the date.

### Docs checks

| Check                     | How to test                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| D1 Index                  | `curl -s <site>/llms.txt` returns 200 with an H1 and a link list. Large sites have section indexes.                |
| D2 Markdown per page      | `<page>.md` returns 200, and `Accept: text/markdown` returns Markdown.                                             |
| D3 Index pointer in pages | Each Markdown page links `llms.txt` near the top.                                                                  |
| D4 Full corpus            | `llms-full.txt` exists, with its size stated and a note to prefer the index.                                       |
| D5 Version match          | The docs state which tool version they describe. The CLI reference comes from the same source as `--help`.         |
| D6 Agent guidance         | A page or `llms.txt` section for agents names the state-changing commands, deprecated features and approval rules. |
| D7 Search or MCP          | A docs search tool works without authentication.                                                                   |
| D8 Measured               | The url-discovery benchmark runs against the site and records failed requests, fetches and tokens.                 |

### CLI checks

| Check                        | How to test                                                                                                                        |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| C1 Machine output            | Every command has `--json`; the schema is documented with a version or a compatibility rule. `cmd --json \| jq .` works.           |
| C2 Field and size control    | Field selection, limits and pagination exist; a capped result says so on stderr.                                                   |
| C3 stdout and stderr         | Piped, stdout holds only the result: `cmd 2>/dev/null \| jq .` works.                                                              |
| C4 Non-terminal hygiene      | Piped output has no ANSI codes, spinner or pager; `NO_COLOR` is honoured. `cmd \| cat -v` shows no `^[`.                           |
| C5 No required prompt        | With stdin not a terminal, the command never hangs; it fails fast and names the flag to pass.                                      |
| C6 Destructive-action safety | A dry run exists for state-changing commands and needs no secret. Without the confirmation flag and a terminal, it exits non-zero. |
| C7 Exit-code contract        | Documented codes separate error, changes present, authentication, cancelled and aborted. Each path is tested.                      |
| C8 Help quality              | `--help` leads with examples and lists environment variables. A typo suggests the closest command.                                 |
| C9 Errors                    | Errors name the cause and the fix. Test five common mistakes and count the actionable ones.                                        |
| C10 Secrets                  | No secret has to be passed as a flag. A dummy key never appears in output, JSON or logs.                                           |
| C11 Version discoverability  | `--version` is machine-readable and the docs URL for that version is printable.                                                    |
| C12 Shipped agent guidance   | A skill or plugin is published and kept in step with releases (compare commit dates with release dates).                           |
| C13 Determinism              | The same input gives the same output: run twice and diff.                                                                          |
| C14 Measured                 | A small agent evaluation records success, turns, tokens and unsafe actions attempted.                                              |

## Mapping to R-AX

| Requirement                | Rubric checks | Reason                                                                                              |
| -------------------------- | ------------- | --------------------------------------------------------------------------------------------------- |
| R-AX-1 `llms.txt`          | D1, D3        | Benchmark: an index cuts failed requests; Markdown without an index does worse than HTML.           |
| R-AX-2 Docs in the package | D5, C11       | Gorilla: docs that match the installed version lead to fewer wrong calls.                           |
| R-AX-3 Agent page          | D6, D3        | Names the one outward step (submit) and the key rules.                                              |
| R-AX-4 Shipped skill       | C12           | A skill shipped in the package is released with the code it describes.                              |
| R-AX-5 `--json` envelope   | C1            | clig.dev; gh `--json`; Terraform's versioned format and its compatibility rule.                     |
| R-AX-6 Streams, no prompt  | C3, C4, C5    | clig.dev; gh's non-terminal behaviour. A prompt that cannot run should name the flag to pass.       |
| R-AX-7 Exit codes          | C7, C6        | A CLI where every failure exits 1 gives an agent no signal to act on; Pulumi and gh document codes. |
| R-AX-8 `--dry-run`         | C6            | clig.dev; Terraform `plan`; `cf --dry-run` needs no credentials.                                    |
| R-AX-9 Keys not in flags   | C10           | clig.dev: no secrets in flags. Output ends up in agent transcripts.                                 |
| R-AX-10 Errors with a fix  | C9, C8        | Anthropic tools guidance: errors with a stable code and a URL that names the fix.                   |
| R-AX-11 Help               | C8, C11       | Claude Code: `--help` is enough for a new CLI; clig.dev: examples first.                            |
| R-AX-12 Determinism        | C13           | clig.dev scripting advice; two runs can be diffed only when key order and timestamps are fixed.     |
| R-AX-13 Agent evaluation   | C14, D8       | Anthropic: build an evaluation. No published study answers the question for this tool.              |

Not adopted, with the reason:

- D2 (Markdown per page): met by construction. The docs are Markdown files, and `llms.txt` links
  their raw source.
- D4 (full corpus): the docs are small enough that the index is sufficient.
- D7 (search or MCP): deferred with the MCP server in decision 0007. A comparison of an MCP server
  and a CLI for the same tasks found no clear difference.
- C2 (field and size control): a verification returns one small result, not a list.
