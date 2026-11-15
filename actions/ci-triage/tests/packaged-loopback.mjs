import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { setTimeout, clearTimeout } from 'node:timers';
import { test } from 'node:test';
import { URL, fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const mvf = 'lukeorellana/mvfprojectunleashed';
const qr = 'feature/intake-qr-303';
const sha = 'a'.repeat(40);
const bundle = process.env.CI_TRIAGE_BUNDLE
  ? resolve(process.env.CI_TRIAGE_BUNDLE)
  : fileURLToPath(new URL('../dist/index.js', import.meta.url));
const eventFile = fileURLToPath(
  new URL('./fixtures/workflow-run.json', import.meta.url),
);
const outputFile = process.env.CI_TRIAGE_LOOPBACK_OUTPUT;
const outputNames = [
  'outcome',
  'reason',
  'task-id',
  'task-url',
  'workflow-run-id',
  'workflow-run-attempt',
  'resolved-mode',
  'target-base-ref',
  'target-head-ref',
  'existing-pr-number',
];

function pull(number, ref, repoId) {
  return {
    number,
    state: 'open',
    html_url: 'http://example.invalid/pr',
    base: { ref: 'main', repo: { id: 1 } },
    head: { ref, sha, repo: { id: repoId } },
  };
}

function output(stdout, name) {
  if (outputFile) {
    const match = stdout.match(
      new RegExp(`^${name}<<([^\\n]+)\\n([^\\n]*)\\n\\1$`, 'm'),
    );
    assert.ok(match, `missing output ${name}`);
    return match[2];
  }
  const match = stdout.match(
    new RegExp(`^::set-output name=${name}::(.*)$`, 'm'),
  );
  assert.ok(match, `missing output ${name}`);
  return match[1];
}

async function replay({
  repository = mvf,
  branch = qr,
  direct = false,
  dryRun = false,
}) {
  const requests = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const path = new URL(req.url, 'http://127.0.0.1').pathname;
      const entry = { method: req.method, path };
      let response;
      let status = 200;
      if (
        path === `/repos/${repository}/actions/runs/102` &&
        req.method === 'GET'
      ) {
        response = {
          id: 102,
          name: 'PR CI',
          run_attempt: 1,
          html_url: 'http://example.invalid/run',
          event: 'pull_request',
          status: 'completed',
          conclusion: 'failure',
          head_branch: direct ? branch : 'feature/fork-other',
          head_sha: sha,
          pull_requests: direct ? [{ number: 303 }] : [],
        };
      } else if (
        path === `/repos/${repository}/commits/${sha}/pulls` &&
        req.method === 'GET'
      ) {
        response = [pull(901, 'feature/fork-other', 2), pull(303, branch, 1)];
      } else if (
        path === `/repos/${repository}/pulls/303` &&
        req.method === 'GET'
      ) {
        response = pull(303, branch, 1);
      } else if (
        path === `/repos/${repository}/copilot/agents` &&
        req.method === 'GET'
      ) {
        response = [];
      } else if (
        path === `/repos/${repository}/copilot/agents` &&
        req.method === 'POST'
      ) {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        entry.body = { base_ref: body.base_ref, head_ref: body.head_ref };
        response = {
          id: 'loopback-only',
          html_url: 'http://example.invalid/task',
        };
        status = 201;
      } else {
        response = { error: 'unexpected loopback request' };
        status = 500;
      }
      requests.push(entry);
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(0, '127.0.0.1', ok);
  });
  try {
    const env = {
      PATH: process.env.PATH,
      GITHUB_API_URL: `http://127.0.0.1:${server.address().port}`,
      GITHUB_REPOSITORY: repository,
      GITHUB_EVENT_NAME: 'workflow_run',
      GITHUB_EVENT_PATH: eventFile,
      GITHUB_STEP_SUMMARY: '/dev/null',
      'INPUT_GITHUB-TOKEN': 'loopback-placeholder',
      'INPUT_AGENT-TOKEN': 'loopback-placeholder',
      'INPUT_PULL-REQUEST-MODE': 'auto',
      'INPUT_INCLUDE-HISTORY': 'false',
      'INPUT_DRY-RUN': String(dryRun),
    };
    if (outputFile) {
      writeFileSync(outputFile, '');
      env.GITHUB_OUTPUT = outputFile;
    }
    const child = spawn(process.execPath, [bundle], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const timer = setTimeout(() => child.kill('SIGTERM'), 15000);
    const result = await new Promise((ok, fail) => {
      child.once('error', fail);
      child.once('close', (exit, signal) => ok({ exit, signal }));
    });
    clearTimeout(timer);
    const diagnostics = `${stdout}\n${stderr}`.replaceAll(
      'loopback-placeholder',
      '[redacted]',
    );
    assert.equal(result.exit, 0, `bundle failed: ${diagnostics}`);
    assert.equal(result.signal, null);
    const outputText = outputFile ? readFileSync(outputFile, 'utf8') : stdout;
    const outputs = Object.fromEntries(
      outputNames.map((name) => [name, output(outputText, name)]),
    );
    return { requests, outputs };
  } finally {
    await new Promise((ok) => server.close(ok));
  }
}

test('packaged shared-SHA QR resolved target is refused before task dispatch', async (t) => {
  const { requests, outputs } = await replay({});
  t.diagnostic(JSON.stringify({ requests, outputs }));
  assert.equal(
    outputs.outcome,
    'needs-human',
    'shared-SHA QR resolved target must be refused before task dispatch',
  );
  assert.deepEqual(
    requests.map(({ method, path }) => [method, path]),
    [
      ['GET', `/repos/${mvf}/actions/runs/102`],
      ['GET', `/repos/${mvf}/commits/${sha}/pulls`],
    ],
  );
  assert.equal(outputs.reason, 'qr-target-refused');
  assert.equal(outputs['target-head-ref'], qr);
  assert.equal(outputs['existing-pr-number'], '303');
  assert.equal(outputs['task-id'], '');
  assert.equal(requests.filter(({ method }) => method === 'POST').length, 0);
});

test('packaged direct QR target is refused', async (t) => {
  const { requests, outputs } = await replay({ direct: true });
  t.diagnostic(JSON.stringify({ requests, outputs }));
  assert.equal(outputs.outcome, 'needs-human');
  assert.equal(outputs.reason, 'qr-target-refused');
  assert.equal(requests.filter(({ method }) => method === 'POST').length, 0);
});

test('packaged unrelated targets start through the Agent Tasks adapter', async (t) => {
  for (const [repository, branch] of [
    [mvf, 'feature/ordinary'],
    ['other/project', qr],
  ]) {
    const { requests, outputs } = await replay({ repository, branch });
    t.diagnostic(JSON.stringify({ requests, outputs }));
    const posts = requests.filter(({ method }) => method === 'POST');
    assert.equal(outputs.outcome, 'started');
    assert.equal(outputs.reason, 'task-started');
    assert.equal(posts.length, 1);
    assert.deepEqual(posts[0].body, { base_ref: 'main', head_ref: branch });
  }
});

test('packaged dry runs are read-only and report the applicable decision', async (t) => {
  for (const [branch, outcome, reason] of [
    [qr, 'needs-human', 'qr-target-refused'],
    ['feature/ordinary', 'dry-run', 'dry-run-preview'],
  ]) {
    const { requests, outputs } = await replay({ branch, dryRun: true });
    t.diagnostic(JSON.stringify({ requests, outputs }));
    assert.equal(outputs.outcome, outcome);
    assert.equal(outputs.reason, reason);
    assert.equal(requests.length, 2);
    assert.equal(requests.filter(({ method }) => method === 'POST').length, 0);
  }
});
