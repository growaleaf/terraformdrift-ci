# terraformdrift-ci

Fail CI when your Terraform version claims disagree with each other.

A project can declare its target Terraform CLI version in four different places —
`.terraform-version` (an exact pin, read natively by `tfenv install` with no argument), a
`terraform { required_version = "..." }` block in any `*.tf` file (a version-constraint
string — `=`, `!=`, `>`, `>=`, `<`, `<=`, `~>`), a `Dockerfile`'s `FROM hashicorp/terraform:
X.Y[.Z]`, and a GitHub Actions workflow's `hashicorp/setup-terraform` step's
`terraform_version:` input — each edited by a different person at a different time. They
drift silently, and the bug that surfaces is `terraform apply` behaving differently in CI than
on a laptop, discovered mid-deploy, not in review. Same shape as this lane's `godrift-ci`
(Go) and `rubydrift-ci` (Ruby), ported to Terraform's own files.

Note on `required_version` specifically: per hashicorp/web-unified-docs, it is a **constraint**,
not a bare pin. `~> 1.7` (patch omitted) allows `1.8`, `1.20`, anything below `2.0` — it floors
at the given minor and caps at the next major. `~> 1.7.4` (patch given) allows only patch bumps
within `1.7`. `terraformdrift-ci` parses the full operator set, not just `~>`.

```
$ npx github:growaleaf/terraformdrift-ci check
terraformdrift-ci — mode: free (terraform-version + required_version only)
  DRIFT  [requiredVersionMismatch]  .terraform-version pins Terraform 1.5.2, which does not satisfy main.tf:2's constraint "~> 1.7"
  (free mode checked .terraform-version + required_version only — Pro also checks every Dockerfile and GitHub Actions workflow: https://terraformdrift-ci.madeforthisday.com)

$ TERRAFORMDRIFT_KEY=... npx github:growaleaf/terraformdrift-ci check
terraformdrift-ci — mode: Pro (terraform-version + required_version + Dockerfile + CI workflows)
  DRIFT  [pinMismatch]  Pinned Terraform versions disagree: .terraform-version=1.5.2, Dockerfile:1=1.7.4, .github/workflows/ci.yml:6=1.6.0
  DRIFT  [requiredVersionMismatch]  .terraform-version pins Terraform 1.5.2, which does not satisfy main.tf:2's constraint "~> 1.7"
  DRIFT  [requiredVersionMismatch]  .github/workflows/ci.yml:6 pins Terraform 1.6.0, which does not satisfy main.tf:2's constraint "~> 1.7"
```

A repo with more than one Terraform module, each declaring a deliberately different
`required_version` on purpose, is detected and reported as skipped — it is never treated as
drift:

```
$ npx github:growaleaf/terraformdrift-ci check
terraformdrift-ci — mode: free (terraform-version + required_version only)
  (skipped as intentional multi-module declaration, not drift: modules/a/versions.tf:2, modules/b/versions.tf:2)
  no drift found.
```

## Install

No npm account needed — install straight from the GitHub repo:

```
npm install github:growaleaf/terraformdrift-ci
```

Or run it without installing:

```
npx github:growaleaf/terraformdrift-ci check
```

## Usage

```
node cli.js check [--dir <path>] [--json]
```

| Exit code | Meaning |
|---|---|
| 0 | no drift found |
| 1 | a drift finding exists — fail the build on this |
| 2 | configuration error — `--dir` does not exist |

`--json` writes the full report (every source checked, every finding, the skipped-matrix
list) to stdout, suited to a PR-comment bot or a lint-results artifact.

## Free vs. Pro

**Free, no key needed:** compares `.terraform-version` against `required_version`'s
constraint. Useful on its own for a project with no Docker image and no CI-declared Terraform
version.

**Pro ($9, one time):** also scans every `Dockerfile` (any file matching `Dockerfile*`,
anywhere in the repo) and every `.github/workflows/*.yml` for a `hashicorp/setup-terraform`
step's `terraform_version:` input, and cross-checks every source against every other source —
this is where the real bugs are, since the Dockerfile and the CI workflow are usually the two
files furthest from active editing.

The license key is checked **offline** — an ECDSA-signed token verified locally; the CLI makes
no network call to check it, ever, and reads neither your source files nor your repository name
over the network at any point.

```
export TERRAFORMDRIFT_KEY=<your key>       # CI secret
# or, on your own machine:
mkdir -p ~/.terraformdrift && echo "<your key>" > ~/.terraformdrift/license
```

Buy a key: https://terraformdrift-ci.madeforthisday.com (one-time purchase, no subscription).

## How this differs from an existing tool you may already know

`hashicorp/setup-terraform` can itself install a version you tell it, but it does not
cross-check the project's own version-declaration files against each other, or notice when a
Dockerfile still pins an older minor than `required_version` now demands. A separate npm
package, `@4cloudguru/terraform-drift-contract`, parses Terraform **plan JSON** for
infrastructure state drift — Terraform's own vocabulary for "actual infra != declared config" —
a completely different meaning of "drift" from a CLI-version mismatch. A search of the npm
registry and GitHub for a tool that cross-checks `.terraform-version`, `required_version`, a
Dockerfile pin, and a CI pin against each other turned up nothing as of 2026-11-10 — this is a
narrow, specific gap, not a crowded one.

## Source

Source is readable here before you buy. The free tier works as shipped; the Pro tier needs a
key (see `LICENSE`).
