#!/usr/bin/env node
'use strict';

// terraformdrift-ci — self-contained, dependency-free (Node 18+, no npm install).
// Checks whether the Terraform CLI version your team THINKS a project targets agrees across
// every place a project can declare one: .terraform-version (an EXACT pin, read natively by
// tfenv's `tfenv install` with no argument — tfenv's own README), a `terraform { required_version
// = "..." }` block in any *.tf file (a VERSION-CONSTRAINT STRING, not a bare pin — operators
// =, !=, >, >=, <, <=, ~>, per hashicorp/web-unified-docs' language/terraform.mdx and
// language/expressions/version-constraints.mdx), any Dockerfile's "FROM hashicorp/terraform:
// X.Y[.Z]" (confirmed real tag shape from Docker Hub's hashicorp/terraform tags listing), and
// any GitHub Actions workflow's hashicorp/setup-terraform step's "terraform_version:" input
// (that action's own README: accepts either a full version or the same constraint-string
// syntax as required_version). Each of these is edited by a different person at a different
// time, so they drift silently — the same "works on my laptop, breaks in CI" bug this lane
// already shipped for Node, Python, Go, Ruby, Java, Rust, Swift, Elixir, and .NET, ported to
// Terraform's own files.
//
// required_version's "~>" operator (the pessimistic/"optimistic upgrade" operator) is the SAME
// vocabulary as RubyGems' Gemfile dependency constraints: "~> 1.1" allows 1.2/1.10 but not 2.0
// (locks the MAJOR, floors at the given minor); "~> 1.1.4" allows only patch bumps (locks the
// MINOR, floors at the given patch). At this family's major.minor comparison granularity
// (patch is a bugfix/security release only and never changes compatibility — same granularity
// choice godrift-ci/rubydrift-ci/rustdrift-ci already made), "~> 1.1.4" collapses to an exact
// pin on minor 1.1 and "~> 1.1" collapses to a floor-with-next-major-cap. Note: rubydrift-ci's
// own Gemfile "ruby" directive does NOT use "~>" (it is an exact pin per guides.rubygems.org —
// confirmed by reading that file directly, not assumed from the charter's framing of it), so
// there was no literal "~>" parser to copy from that sibling; the two-case shape below (a
// floor-with-major-cap when patch is omitted, an exact-at-minor-granularity pin when patch is
// given) matches elixirdrift-ci's own "~>" implementation, which — despite that file's comment
// calling it "the INVERSE of pydrift-ci's ~="  — produces identical results to Terraform's real
// "~>" semantics at major.minor granularity, verified by hand against the two examples above.
//
// FREE: compares .terraform-version against required_version only. No key needed.
// PRO: also scans every Dockerfile and GitHub Actions workflow in the repo and cross-checks
//      every source against every other source. Unlocked by a valid offline license key — no
//      network call, no account, no phone-home.
//
// Usage:
//   node cli.js check [--dir <path>] [--json]
//
// Exit codes:
//   0 - no drift found
//   1 - a drift finding exists (any rule)
//   2 - configuration/usage error (--dir does not exist or is not a directory)

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

// ---------------------------------------------------------------------------------------
// License (BP-001 offline ECDSA-P256 verify) — same chassis as every other D-lane standalone
// CLI, including the canonical-base64url round-trip check from the first line (the tamper-
// bypass coin-flip bug this lane found and fixed 2026-09-07, re-introduced once in
// localbolt-ci before being caught 2026-10-13, ported in from day one on every build since).
// ---------------------------------------------------------------------------------------
const PUBLIC_KEY_PEM = '-----BEGIN PUBLIC KEY-----\nMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEI+p5zLzoHbm/neU7Yvyh0dW9iCjYugtodA/FnBIwWXgwT+sJZa6c+xoZsxKAs2+ClqHSIMaD4h22yfLepHEtVA==\n-----END PUBLIC KEY-----';
const LICENSE_PRODUCT = 'terraformdrift-pro';

function b64urlToBuf(s) {
  const buf = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const canonical = buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (canonical !== s) throw new Error('non-canonical base64url');
  return buf;
}

function verifyLicenseWith(key, pubPem) {
  try {
    if (typeof key !== 'string') return false;
    const parts = key.trim().split('.');
    if (parts.length !== 3 || parts[0] !== 'TF1') return false;
    const signedData = `TF1.${parts[1]}`;
    const payload = JSON.parse(b64urlToBuf(parts[1]).toString('utf8'));
    if (payload.product !== LICENSE_PRODUCT) return false;
    if (payload.exp && Date.now() > payload.exp) return false;
    const v = crypto.createVerify('SHA256');
    v.update(signedData); v.end();
    return v.verify(pubPem, b64urlToBuf(parts[2]));
  } catch (e) { return false; }
}

function verifyLicense(key) {
  if (PUBLIC_KEY_PEM.includes('PLACEHOLDER')) return false;
  return verifyLicenseWith(key, PUBLIC_KEY_PEM);
}

function readLicenseKey() {
  if (process.env.TERRAFORMDRIFT_KEY) return process.env.TERRAFORMDRIFT_KEY.trim();
  try {
    return fs.readFileSync(path.join(os.homedir(), '.terraformdrift', 'license'), 'utf8').trim();
  } catch (e) {
    return null;
  }
}

function hasPro() {
  const key = readLicenseKey();
  return !!(key && verifyLicense(key));
}

// ---------------------------------------------------------------------------------------
// Version-source parsing — Terraform versions are compared at MAJOR.MINOR granularity (1.5 vs
// 1.6 matter; a patch, e.g. 1.5.1 vs 1.5.9, is a bugfix/security release only and never changes
// compatibility — same granularity choice as every sibling in this family). Every version
// folds into a single comparable integer key: major*100 + minor.
// ---------------------------------------------------------------------------------------

// First "X.Y" (or "X.Y.Z", patch ignored) pair in a string -> integer key, or null.
// "1.5.7" -> 105, "1.5" -> 105, "latest" / "1" (no minor) -> null (ambiguous, not a real pin).
function parseVersionKey(s) {
  if (typeof s !== 'string') return null;
  const m = s.trim().match(/(\d+)\.(\d+)/);
  if (!m) return null;
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
}

// A bare version string with no constraint operator — "1.5", "1.5.7", optionally "v"-prefixed.
// Anything else (an operator, a channel word, a matrix expression) is not a bare version.
function isBareVersion(s) {
  return typeof s === 'string' && /^v?\d+\.\d+(?:\.\d+)?$/.test(s.trim());
}

// Single comma-separated constraint term -> { min, max, exact, excludes } (nulls/empty when
// not applicable). Operators per hashicorp/web-unified-docs' version-constraints.mdx: =, !=,
// >, >=, <, <=, ~>, and a bare version (implicit "=").
function parseSingleConstraint(part) {
  part = part.trim();
  let m;
  if ((m = part.match(/^~>\s*(\d+)\.(\d+)\.(\d+)$/))) {
    // patch given: locks the MINOR — at major.minor granularity this is an exact pin.
    return { exact: parseInt(m[1], 10) * 100 + parseInt(m[2], 10) };
  }
  if ((m = part.match(/^~>\s*(\d+)\.(\d+)$/))) {
    // patch omitted: locks the MAJOR — floor at the given minor, cap at the next major.
    const major = parseInt(m[1], 10);
    return { min: major * 100 + parseInt(m[2], 10), max: (major + 1) * 100 };
  }
  if ((m = part.match(/^!=\s*(\d+)\.(\d+)/))) {
    return { excludes: [parseInt(m[1], 10) * 100 + parseInt(m[2], 10)] };
  }
  if ((m = part.match(/^>=\s*(\d+)\.(\d+)/))) {
    return { min: parseInt(m[1], 10) * 100 + parseInt(m[2], 10) };
  }
  if ((m = part.match(/^<=\s*(\d+)\.(\d+)/))) {
    return { max: parseInt(m[1], 10) * 100 + parseInt(m[2], 10) + 1 };
  }
  if ((m = part.match(/^>\s*(\d+)\.(\d+)/))) {
    return { min: parseInt(m[1], 10) * 100 + parseInt(m[2], 10) + 1 };
  }
  if ((m = part.match(/^<\s*(\d+)\.(\d+)/))) {
    return { max: parseInt(m[1], 10) * 100 + parseInt(m[2], 10) };
  }
  if ((m = part.match(/^=\s*(\d+)\.(\d+)/)) || (m = part.match(/^(\d+)\.(\d+)/))) {
    return { exact: parseInt(m[1], 10) * 100 + parseInt(m[2], 10) };
  }
  return null;
}

// A full constraint string (comma-separated terms, ANDed together) -> { min, max, exact,
// excludes } or null if any term fails to parse. e.g. ">= 1.5.0, < 2.0.0".
function parseConstraint(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;
  let min = null, max = null, exact = null;
  const excludes = [];
  for (const part of parts) {
    const r = parseSingleConstraint(part);
    if (!r) return null;
    if (r.exact != null) exact = r.exact;
    if (r.min != null) min = min == null ? r.min : Math.max(min, r.min);
    if (r.max != null) max = max == null ? r.max : Math.min(max, r.max);
    if (r.excludes) excludes.push(...r.excludes);
  }
  return { min, max, exact, excludes };
}

function keySatisfiesRange(key, range) {
  if (key == null || !range) return true;
  if (range.exact != null) return key === range.exact;
  if (range.min != null && key < range.min) return false;
  if (range.max != null && key >= range.max) return false;
  if (range.excludes && range.excludes.includes(key)) return false;
  return true;
}

// .terraform-version — read natively by tfenv's `tfenv install` with no argument (tfenv's own
// README: "if you use a .terraform-version file, tfenv install (no argument) will install the
// version written in it"). An exact pin, never a constraint string.
function readTerraformVersionFile(rootDir) {
  const p = path.join(rootDir, '.terraform-version');
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8').trim().split('\n')[0].trim();
  return { raw, key: parseVersionKey(raw) };
}

const DEFAULT_EXCLUDE_DIRS = new Set(['node_modules', '.git', 'vendor', 'dist', 'build', '.terraform']);
function walk(dir, out) {
  out = out || [];
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir)) {
    if (DEFAULT_EXCLUDE_DIRS.has(e)) continue;
    const p = path.join(dir, e);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// Every `required_version = "..."` declaration in every *.tf file under rootDir (a real repo
// may put the terraform{} block in versions.tf, main.tf, or terraform.tf — any file works,
// same "search every file, don't assume a filename" discipline godrift-ci applies to go.mod).
// More than one DISTINCT constraint string across files is an intentional multi-module matrix
// (each module may pin a different Terraform version on purpose) and is excluded from
// comparison — the same treatment this family already gives every other multi-source case.
function readRequiredVersionDeclarations(rootDir) {
  const decls = [];
  for (const fsPath of walk(rootDir)) {
    if (!/\.tf$/.test(fsPath)) continue;
    const lines = fs.readFileSync(fsPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*required_version\s*=\s*"([^"]+)"/);
      if (!m) continue;
      decls.push({ source: `${path.relative(rootDir, fsPath)}:${i + 1}`, raw: m[1] });
    }
  }
  return decls;
}

function resolveRequiredVersion(rootDir) {
  const decls = readRequiredVersionDeclarations(rootDir);
  if (!decls.length) return { range: null, raw: null, source: null, matrix: false, matrixSources: [] };
  const distinctRaw = new Set(decls.map((d) => d.raw));
  if (distinctRaw.size > 1) {
    return { range: null, raw: null, source: null, matrix: true, matrixSources: decls.map((d) => d.source) };
  }
  const range = parseConstraint(decls[0].raw);
  return { range, raw: decls[0].raw, source: decls[0].source, matrix: false, matrixSources: [] };
}

// Every "FROM hashicorp/terraform:<tag>" line in every Dockerfile under rootDir. A tag with no
// minor component ("hashicorp/terraform:latest") is ambiguous and skipped — same "unversioned
// alias" skip every sibling in this family applies to its own ecosystem's floating tags.
function findDockerfilePins(rootDir) {
  const pins = [];
  for (const fsPath of walk(rootDir)) {
    const base = path.basename(fsPath);
    if (!/^Dockerfile(\..+)?$/.test(base)) continue;
    const lines = fs.readFileSync(fsPath, 'utf8').split('\n');
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/^\s*FROM\s+hashicorp\/terraform:([^\s]+)/i);
      if (!m) continue;
      const tag = m[1];
      const key = parseVersionKey(tag);
      if (key == null) continue;
      pins.push({ source: `${path.relative(rootDir, fsPath)}:${i + 1}`, raw: tag, key });
    }
  }
  return pins;
}

// Every "terraform_version:" input declared under a step that "uses:" hashicorp/setup-terraform,
// in every .github/workflows/*.yml(.yaml) file. Scoped deliberately to that action's own steps
// (confirmed from hashicorp/setup-terraform's own README: "terraform_version" is that action's
// input key) — the bare words "terraform"/"version" are generic enough that matching them
// anywhere in a workflow file would catch unrelated steps, the same discipline rustdrift-ci
// uses for dtolnay/rust-toolchain's "toolchain:" input. A step boundary is any YAML sequence
// item ("- ") at or below the indent of the step that opened the scope. The value may be a
// bare version (exact pin) or a constraint string (hashicorp/setup-terraform's own README: the
// input "accepts either a full version or a constraint ... in the same syntax as
// required_version") — each is classified and returned as the right shape. A matrix-driven
// value (`${{ matrix.terraform }}`) fails both the bare-version and the constraint-string
// check and is naturally excluded as non-comparable, the same outcome rustdrift-ci gets from a
// literal channel name, with no separate matrix-detection path needed.
function findWorkflowTerraformVersionPins(rootDir) {
  const pins = [];
  const wfDir = path.join(rootDir, '.github', 'workflows');
  if (!fs.existsSync(wfDir)) return pins;
  for (const e of fs.readdirSync(wfDir)) {
    if (!/\.ya?ml$/i.test(e)) continue;
    const fsPath = path.join(wfDir, e);
    const lines = fs.readFileSync(fsPath, 'utf8').split('\n');
    let stepIndent = null;
    let inSetupTerraformStep = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stepMarker = line.match(/^(\s*)-\s/);
      if (stepMarker) {
        const indent = stepMarker[1].length;
        if (stepIndent === null || indent <= stepIndent) inSetupTerraformStep = false;
        stepIndent = indent;
      }
      if (/uses:\s*hashicorp\/setup-terraform/.test(line)) {
        inSetupTerraformStep = true;
      }
      if (!inSetupTerraformStep) continue;
      const tm = line.match(/^\s*terraform_version:\s*(.+?)\s*$/);
      if (!tm) continue;
      let raw = tm[1];
      const qm = raw.match(/^(['"])(.*)\1$/);
      if (qm) raw = qm[2];
      const loc = `${path.relative(rootDir, fsPath)}:${i + 1}`;
      if (isBareVersion(raw)) {
        const key = parseVersionKey(raw);
        if (key != null) pins.push({ source: loc, raw, key, kind: 'exact' });
      } else {
        const range = parseConstraint(raw);
        if (range) pins.push({ source: loc, raw, range, kind: 'range' });
      }
    }
  }
  return pins;
}

// ---------------------------------------------------------------------------------------
// Drift check
// ---------------------------------------------------------------------------------------
function buildReport(rootDir, opts) {
  opts = opts || {};
  if (!fs.existsSync(rootDir) || !fs.statSync(rootDir).isDirectory()) {
    throw new ConfigError(`${rootDir} is not a directory`);
  }

  const tfVersionFile = readTerraformVersionFile(rootDir);
  const requiredVersion = resolveRequiredVersion(rootDir);

  const exactPins = [];
  if (tfVersionFile && tfVersionFile.key != null) {
    exactPins.push({ source: '.terraform-version', raw: tfVersionFile.raw, key: tfVersionFile.key });
  }

  const rangeSources = [];
  if (requiredVersion.range) {
    rangeSources.push({ source: requiredVersion.source, raw: requiredVersion.raw, range: requiredVersion.range });
  }
  const matrixSources = requiredVersion.matrix ? requiredVersion.matrixSources.slice() : [];

  const pro = !!opts.pro;
  if (pro) {
    exactPins.push(...findDockerfilePins(rootDir));
    for (const p of findWorkflowTerraformVersionPins(rootDir)) {
      if (p.kind === 'exact') exactPins.push({ source: p.source, raw: p.raw, key: p.key });
      else rangeSources.push({ source: p.source, raw: p.raw, range: p.range });
    }
  }

  const findings = [];

  const distinctKeys = new Set(exactPins.map((p) => p.key));
  if (distinctKeys.size > 1) {
    findings.push({
      rule: 'pinMismatch',
      message: `Pinned Terraform versions disagree: ${exactPins.map((p) => `${p.source}=${p.raw}`).join(', ')}`,
      pins: exactPins,
    });
  }

  for (const rs of rangeSources) {
    for (const p of exactPins) {
      if (!keySatisfiesRange(p.key, rs.range)) {
        findings.push({
          rule: 'requiredVersionMismatch',
          message: `${p.source} pins Terraform ${p.raw}, which does not satisfy ${rs.source}'s constraint "${rs.raw}"`,
          source: p.source,
          raw: p.raw,
          requiredVersion: rs.raw,
          requiredVersionSource: rs.source,
        });
      }
    }
  }

  return {
    breach: findings.length > 0,
    pro,
    sources: {
      terraformVersionFile: tfVersionFile && tfVersionFile.raw,
      requiredVersion: requiredVersion.raw,
      pins: exactPins,
      rangeSources,
    },
    matrixSources,
    findings,
  };
}

class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') args.dir = argv[++i];
    else if (a === '--json') args.json = true;
    else if (a === '--help' || a === '-h') args.help = true;
    else args._.push(a);
  }
  return args;
}

function printHumanReport(result) {
  console.log(`terraformdrift-ci — mode: ${result.pro ? 'Pro (terraform-version + required_version + Dockerfile + CI workflows)' : 'free (terraform-version + required_version only)'}`);
  if (result.matrixSources.length) {
    console.log(`  (skipped as intentional multi-module declaration, not drift: ${result.matrixSources.join(', ')})`);
  }
  if (!result.findings.length) {
    console.log('  no drift found.');
  } else {
    for (const f of result.findings) console.log(`  DRIFT  [${f.rule}]  ${f.message}`);
  }
  if (!result.pro) {
    console.log('  (free mode checked .terraform-version + required_version only — Pro also checks every Dockerfile and GitHub Actions workflow: https://terraformdrift-ci.madeforthisday.com)');
  }
}

function main() {
  const argv = process.argv.slice(2);
  const args = parseArgs(argv);
  const command = args._[0];

  if (args.help || !command) {
    console.log('Usage: node cli.js check [--dir <path>] [--json]');
    process.exit(command ? 0 : 2);
    return;
  }
  if (command !== 'check') {
    console.error(`Unknown command "${command}". Only "check" is supported.`);
    process.exit(2);
    return;
  }

  const dir = args.dir ? path.resolve(process.cwd(), args.dir) : process.cwd();
  let result;
  try {
    result = buildReport(dir, { pro: hasPro() });
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`terraformdrift-ci config error: ${e.message}`);
      process.exit(2);
      return;
    }
    throw e;
  }

  if (args.json) console.log(JSON.stringify(result, null, 2));
  else printHumanReport(result);

  process.exit(result.breach ? 1 : 0);
}

if (require.main === module) main();

module.exports = {
  buildReport, verifyLicense, verifyLicenseWith, parseVersionKey, isBareVersion,
  parseSingleConstraint, parseConstraint, keySatisfiesRange, readTerraformVersionFile,
  readRequiredVersionDeclarations, findDockerfilePins, findWorkflowTerraformVersionPins,
};
