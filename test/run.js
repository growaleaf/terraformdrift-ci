'use strict';
// Standalone-package test suite for terraformdrift-ci. Exercises the exact exported functions
// the shipped cli.js ships against real fixture trees on disk (.terraform-version, *.tf,
// Dockerfile, .github/workflows/*.yml) — never a mocked file tree.
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const {
  buildReport, verifyLicenseWith, parseVersionKey, isBareVersion, parseConstraint,
  keySatisfiesRange, readTerraformVersionFile, readRequiredVersionDeclarations,
  findDockerfilePins, findWorkflowTerraformVersionPins,
} = require('../cli.js');

let passed = 0;
const failures = [];
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => {
    passed++;
    console.log('  ok -', name);
  }).catch((err) => {
    failures.push({ name, err });
    console.log('FAIL -', name, '\n       ', err.message);
  });
}

const FIXTURES = path.join(__dirname, 'fixtures');

async function main() {
  await check('parseVersionKey extracts major.minor as a comparable integer, null when ambiguous', () => {
    assert.equal(parseVersionKey('1.7.4'), 107);
    assert.equal(parseVersionKey('1.7'), 107);
    assert.equal(parseVersionKey('hashicorp/terraform:1.7-alpine'), 107);
    assert.equal(parseVersionKey('1'), null);
    assert.equal(parseVersionKey('latest'), null);
  });

  await check('isBareVersion distinguishes a plain pin from a constraint string', () => {
    assert.equal(isBareVersion('1.7.4'), true);
    assert.equal(isBareVersion('1.7'), true);
    assert.equal(isBareVersion('~> 1.7'), false);
    assert.equal(isBareVersion('>= 1.7.0'), false);
    assert.equal(isBareVersion('latest'), false);
  });

  await check('parseConstraint: "~> 1.1" (patch omitted) floors at the minor, caps at the next major', () => {
    const range = parseConstraint('~> 1.1');
    assert.deepEqual(range, { min: 101, max: 200, exact: null, excludes: [] });
    assert.equal(keySatisfiesRange(102, range), true); // 1.2 allowed
    assert.equal(keySatisfiesRange(110, range), true); // 1.10 allowed
    assert.equal(keySatisfiesRange(200, range), false); // 2.0 not allowed
    assert.equal(keySatisfiesRange(101, range), true); // 1.1 itself allowed
  });

  await check('parseConstraint: "~> 1.1.4" (patch given) allows only patch bumps — exact at minor granularity', () => {
    const range = parseConstraint('~> 1.1.4');
    assert.deepEqual(range, { min: null, max: null, exact: 101, excludes: [] });
    assert.equal(keySatisfiesRange(101, range), true); // any 1.1.x
    assert.equal(keySatisfiesRange(102, range), false); // 1.2.0 not allowed
  });

  await check('parseConstraint handles >=, <, and comma-separated ranges', () => {
    const range = parseConstraint('>= 1.5.0, < 2.0.0');
    assert.deepEqual(range, { min: 105, max: 200, exact: null, excludes: [] });
    assert.equal(keySatisfiesRange(105, range), true);
    assert.equal(keySatisfiesRange(199, range), true);
    assert.equal(keySatisfiesRange(200, range), false);
    assert.equal(keySatisfiesRange(104, range), false);
  });

  await check('parseConstraint handles != as an exclusion', () => {
    const range = parseConstraint('>= 1.0, != 1.3');
    assert.equal(keySatisfiesRange(103, range), false);
    assert.equal(keySatisfiesRange(104, range), true);
  });

  await check('parseConstraint returns null for an unparseable string', () => {
    assert.equal(parseConstraint('whatever this is'), null);
    assert.equal(parseConstraint(''), null);
  });

  await check('readTerraformVersionFile reads the first line, null when absent', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terraformdrift-tv-'));
    fs.writeFileSync(path.join(dir, '.terraform-version'), '1.7.4\n');
    assert.deepEqual(readTerraformVersionFile(dir), { raw: '1.7.4', key: 107 });
    assert.equal(readTerraformVersionFile(os.tmpdir() + '/does-not-exist-terraformdrift'), null);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('readRequiredVersionDeclarations finds required_version across any *.tf file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terraformdrift-tf-'));
    fs.writeFileSync(path.join(dir, 'versions.tf'), 'terraform {\n  required_version = "~> 1.7"\n}\n');
    const decls = readRequiredVersionDeclarations(dir);
    assert.equal(decls.length, 1);
    assert.equal(decls[0].raw, '~> 1.7');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findDockerfilePins finds every "FROM hashicorp/terraform:X.Y" across any Dockerfile*, skips unversioned tags', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terraformdrift-docker-'));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM hashicorp/terraform:1.7.4-alpine\nRUN echo hi\n');
    fs.mkdirSync(path.join(dir, 'services', 'plan'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'services', 'plan', 'Dockerfile.ci'), 'FROM hashicorp/terraform:latest\nFROM hashicorp/terraform:1.6\n');
    const pins = findDockerfilePins(dir);
    assert.equal(pins.length, 2); // the unversioned "hashicorp/terraform:latest" FROM is skipped
    assert.deepEqual(pins.map((p) => p.key).sort(), [106, 107]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowTerraformVersionPins only reads terraform_version under a hashicorp/setup-terraform step', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terraformdrift-wf-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), [
      'jobs:', '  plan:', '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: hashicorp/setup-terraform@v3',
      '        with:', "          terraform_version: '1.7.4'",
      '', 'env:', '  SOME_OTHER_VERSION_VAR: "9.9"', '',
    ].join('\n'));
    const pins = findWorkflowTerraformVersionPins(dir);
    assert.equal(pins.length, 1);
    assert.equal(pins[0].kind, 'exact');
    assert.equal(pins[0].key, 107);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('findWorkflowTerraformVersionPins classifies a constraint-string input as a range, not an exact pin', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'terraformdrift-wf-range-'));
    fs.mkdirSync(path.join(dir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), [
      'jobs:', '  plan:', '    steps:',
      '      - uses: hashicorp/setup-terraform@v3',
      '        with:', "          terraform_version: '~> 1.7'", '',
    ].join('\n'));
    const pins = findWorkflowTerraformVersionPins(dir);
    assert.equal(pins.length, 1);
    assert.equal(pins[0].kind, 'range');
    assert.deepEqual(pins[0].range, { min: 107, max: 200, exact: null, excludes: [] });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  await check('buildReport free mode (no Pro): consistent fixture has zero findings', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: false });
    assert.equal(result.breach, false);
    assert.equal(result.pro, false);
    assert.equal(result.sources.pins.length, 1); // Dockerfile/CI pins not collected in free mode
  });

  await check('buildReport Pro mode: consistent fixture (terraform-version 1.7.4 satisfies ~> 1.7, Dockerfile/CI agree) is clean', () => {
    const result = buildReport(path.join(FIXTURES, 'consistent'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.pins.length, 3);
  });

  await check('buildReport Pro mode: drift fixture flags both pinMismatch and requiredVersionMismatch', () => {
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: true });
    assert.equal(result.breach, true);
    assert.ok(result.findings.some((f) => f.rule === 'pinMismatch'));
    assert.ok(result.findings.some((f) => f.rule === 'requiredVersionMismatch'));
  });

  await check('buildReport free mode on the drift fixture: .terraform-version alone already fails required_version\'s "~> 1.7"', () => {
    const result = buildReport(path.join(FIXTURES, 'drift'), { pro: false });
    assert.equal(result.breach, true);
    assert.equal(result.findings.every((f) => f.rule === 'requiredVersionMismatch'), true);
    assert.equal(result.sources.pins.length, 1); // .terraform-version only
  });

  await check('buildReport: a multi-module repo with DIFFERENT required_version strings is reported as skipped, never as drift', () => {
    const result = buildReport(path.join(FIXTURES, 'matrix'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.matrixSources.length, 2);
  });

  await check('buildReport on a tree with only .terraform-version (no *.tf, no Docker, no CI) is clean, not an error', () => {
    const result = buildReport(path.join(FIXTURES, 'minimal'), { pro: true });
    assert.equal(result.breach, false);
    assert.equal(result.sources.requiredVersion, null);
  });

  await check('buildReport throws ConfigError when --dir does not exist', () => {
    assert.throws(() => buildReport(path.join(FIXTURES, 'does-not-exist'), {}), /is not a directory/);
  });

  await check('CLI end-to-end via real subprocess: free mode runs with no key, Pro mode engages with a real minted key', () => {
    const cliPath = path.join(__dirname, '..', 'cli.js');

    const runCli = (args, env) => {
      try {
        const out = execFileSync('node', [cliPath, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });
        return { code: 0, out };
      } catch (e) {
        return { code: e.status, out: (e.stdout || '') + (e.stderr || '') };
      }
    };

    // Free mode, no key at all: consistent fixture is still clean (exit 0), and the CLI runs
    // successfully rather than refusing outright — license absence narrows scope, it is not a
    // hard gate on the whole tool.
    const freeRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { TERRAFORMDRIFT_KEY: '' });
    assert.equal(freeRun.code, 0);
    assert.ok(freeRun.out.includes('free'));

    // Pro mode with a real minted key: the drift fixture now fails (Dockerfile/CI pins disagree
    // with each other and with required_version's "~> 1.7" constraint, which free mode alone
    // could not fully see).
    const devVarsPath = path.join(__dirname, '..', 'worker', '.dev.vars');
    const devVars = fs.readFileSync(devVarsPath, 'utf8');
    const privB64 = devVars.match(/LICENSE_PRIVATE_KEY=(\S+)/)[1];
    const privateKey = crypto.createPrivateKey({ key: Buffer.from(privB64, 'base64'), format: 'der', type: 'pkcs8' });
    const payload = Buffer.from(JSON.stringify({ product: 'terraformdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`TF1.${payload}`).end().sign(privateKey).toString('base64url');
    const realKey = `TF1.${payload}.${sig}`;

    const proRun = runCli(['check', '--dir', path.join(FIXTURES, 'drift')], { TERRAFORMDRIFT_KEY: realKey });
    assert.equal(proRun.code, 1);
    assert.ok(proRun.out.includes('Pro'));

    const proCleanRun = runCli(['check', '--dir', path.join(FIXTURES, 'consistent')], { TERRAFORMDRIFT_KEY: realKey });
    assert.equal(proCleanRun.code, 0);
  });

  await check('license: a key signed by the real private key verifies true against the matching public key', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'terraformdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`TF1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`TF1.${payload}.${sig}`, pubPem), true);
  });

  await check('license: a tampered key is rejected', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'terraformdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`TF1.${payload}`).end().sign(privateKey).toString('base64url');
    const tamperedPayload = Buffer.from(JSON.stringify({ product: 'terraformdrift-pro', iat: 0 })).toString('base64url');
    assert.equal(verifyLicenseWith(`TF1.${tamperedPayload}.${sig}`, pubPem), false);
  });

  await check('license: non-canonical base64url (coin-flip tamper-bypass shape) is rejected, not accepted by luck', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'terraformdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`TF1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`TF1.${payload}.${sig}AB`, pubPem), false);
  });

  await check('license: a key signed by a DIFFERENT private key is rejected by this public key', () => {
    const { publicKey: pubA } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const { privateKey: privB } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPemA = pubA.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'terraformdrift-pro', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`TF1.${payload}`).end().sign(privB).toString('base64url');
    assert.equal(verifyLicenseWith(`TF1.${payload}.${sig}`, pubPemA), false);
  });

  await check('license: wrong product in the payload is rejected even with a valid signature', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pubPem = publicKey.export({ type: 'spki', format: 'pem' });
    const payload = Buffer.from(JSON.stringify({ product: 'some-other-product', iat: Date.now() })).toString('base64url');
    const sig = crypto.createSign('SHA256').update(`TF1.${payload}`).end().sign(privateKey).toString('base64url');
    assert.equal(verifyLicenseWith(`TF1.${payload}.${sig}`, pubPem), false);
  });

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length) process.exitCode = 1;
  else console.log('All terraformdrift-ci standalone test groups passed.');
}

main();
