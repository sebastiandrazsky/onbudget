# Security

onbudget runs inside your Claude Code session. It makes no network calls, runs no commands and reads no credentials; everything it reads, writes and changes is listed in the README under "What it reads, writes and changes".

## Reporting a vulnerability

Please report it privately, not in a public issue:

- on GitHub, with "Report a vulnerability" on the repository's Security tab, or
- by e-mail to sebastian@sebastiandrazsky.com, with "onbudget security" in the subject.

Include the onbudget version (`/onbudget` prints it), the Claude Code version (`claude --version`), and how to reproduce the problem.

## What counts

A vulnerability is anything that lets onbudget, or another plugin through it, read or write outside its own store, make a network call, run a command, expose data, or send a request that a budget should have refused without saying so. A budget passed in one of the two documented ways (README, "What it guarantees") is a known limit, not a vulnerability.

Only the latest release is supported.
