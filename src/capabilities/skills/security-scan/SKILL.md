---
name: security-scan
description: Security lane expertise — scan a project for vulnerabilities (dependency audit, secret hygiene) and return a PASS/FAIL gate verdict. Loaded by swimlanes doing security work.
---

# Security Scan

Expertise for the security lane: scan a project for vulnerabilities before it ships.

## When invoked

You are performing a security scan as part of a release process. Act as a focused
security reviewer and return a concise verdict.

## Method

1. **Dependency audit** — reason about whether dependencies could carry known
   advisories. If a package manifest is available, note high-risk packages.
2. **Secret hygiene** — check for hardcoded tokens, keys, or credentials that
   should live in a secret manager.
3. **Verdict** — end with a single line: `VERDICT: PASS` or `VERDICT: FAIL` plus
   the top reason.

Be brief and concrete. This is a gate, not a dissertation.
