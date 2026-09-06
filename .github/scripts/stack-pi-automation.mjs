import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OWNER = 'jorgehn98';
const STACK = `${OWNER}/jorgex-stack`;
const PI = `${OWNER}/jorgex-pi`;
const MAX_BYTES = 12 * 1024 * 1024;
const SHA = /^[0-9a-f]{40}$/;
const VERSION = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/;
const snapshotPaths = ['snapshot', 'skills', 'assets/system-prompt', 'prompts', 'agents', 'deferred/agents', 'primary'];
const snapshotFiles = ['contract/parity.v2.json', 'contract/runtime-agents.v1.json',
  'contract/schemas/quality-receipt.v1.schema.json', 'contract/schemas/quality-capabilities.v1.schema.json',
  'scripts/generate-snapshot.mjs', 'tests/fixtures/snapshot-parity.expected.json'];
const adoptionFiles = ['src/lib/pi-runtime-pin.json', 'tests/fixtures/pi-runtime-artifacts.json'];
const full = (pattern, value) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const exact = (value, keys) => {
  assert(value && typeof value === 'object' && !Array.isArray(value), 'Expected object');
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), 'Unexpected fields');
};
const repository = (direction) => direction === 'snapshot' ? PI : STACK;
const prefix = (direction) => `codex/stack-pi-${direction}-`;
const branch = (p) => `${prefix(p.direction)}${p.sourceSha}${p.version === null ? '' : `-v${p.version}`}`;

export function validateWake(eventName, event) {
  assert.equal(event?.repository?.full_name, STACK, 'Unexpected event repository');
  if (eventName === 'push' || eventName === 'workflow_dispatch') {
    assert(event.ref === 'refs/heads/main' || (eventName === 'workflow_dispatch' && event.ref === 'main'), 'Only main can coordinate proposals');
  } else {
    assert.equal(eventName, 'repository_dispatch', 'Unsupported event');
    assert.equal(event.action, 'pi-published-v1', 'Unsupported dispatch');
    const payload = event.client_payload;
    exact(payload, ['version', 'producer_sha', 'run_id']);
    assert(full(VERSION, payload.version) && full(SHA, payload.producer_sha), 'Invalid producer');
    assert(full(/^[1-9][0-9]{0,19}$/, payload.run_id), 'Invalid run ID');
  }
  return event;
}

export function validateProposal(p) {
  exact(p, ['schema', 'direction', 'baseSha', 'treeSha', 'sourceSha', 'version', 'files']);
  assert.equal(p.schema, 1);
  assert(['snapshot', 'adoption'].includes(p.direction), 'Invalid direction');
  assert([p.baseSha, p.treeSha, p.sourceSha].every((s) => full(SHA, s)), 'Invalid SHA');
  assert(p.direction === 'snapshot' ? p.version === null : full(VERSION, p.version), 'Invalid version');
  assert(Array.isArray(p.files) && p.files.length > 0 && p.files.length <= 1000, 'Invalid file count');
  assert(Buffer.byteLength(JSON.stringify(p)) <= MAX_BYTES, 'Proposal too large');
  const names = new Set();
  for (const file of p.files) {
    exact(file, ['path', 'content', 'mode']);
    assert(full(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/, file.path), 'Unsafe path');
    assert(!file.path.split('/').some((part) => part === '.' || part === '..' || part.endsWith('.') || part.toLowerCase() === '.git'), 'Unsafe path component');
    assert(!names.has(file.path.toLowerCase()), 'Duplicate path');
    names.add(file.path.toLowerCase());
    const allowed = p.direction === 'adoption' ? adoptionFiles.includes(file.path)
      : snapshotFiles.includes(file.path) || snapshotPaths.some((dir) => file.path.startsWith(`${dir}/`));
    assert(allowed, 'Path outside preparer scope');
    assert.equal(file.mode, '100644', 'Only regular text files');
    assert(file.content === null || (typeof file.content === 'string' && !file.content.includes('\0')
      && Buffer.byteLength(file.content) <= 1024 * 1024
      && Buffer.from(file.content).toString('utf8') === file.content), 'Invalid text content');
    if (p.direction === 'adoption') {
      assert.notEqual(file.content, null, 'Pin files cannot be deleted');
      JSON.parse(file.content);
    }
  }
  if (p.direction === 'adoption') assert.equal(p.files.length, 2, 'Both pin files required');
  return p;
}

async function pendingProposal(p, api) {
  const repo = repository(p.direction);
  // Include closed PRs: an intentionally rejected input must not be recreated.
  for (let page = 1; page <= 100; page++) {
    const pulls = await api('GET', `/repos/${repo}/pulls?state=all&per_page=100&page=${page}`);
    assert(Array.isArray(pulls), 'Invalid PR list');
    for (const pr of pulls) {
      if (pr.head?.ref === branch(p)) return { status: 'existing', number: pr.number };
      if (pr.state === 'open' && pr.head?.ref?.startsWith(prefix(p.direction))) return { status: 'blocked', number: pr.number };
    }
    if (pulls.length < 100) {
      const refs = await api('GET', `/repos/${repo}/git/matching-refs/heads/${branch(p)}`);
      assert(Array.isArray(refs), 'Invalid ref list');
      return refs.some((ref) => ref.ref === `refs/heads/${branch(p)}`) ? { status: 'blocked' } : null;
    }
  }
  throw new Error('PR history limit reached; inspect proposals manually');
}

export async function publishProposal(value, api) {
  const p = validateProposal(value), repo = repository(p.direction), root = `/repos/${repo}`;
  const pending = await pendingProposal(p, api);
  if (pending) return pending;
  const checkBase = async () => assert.equal((await api('GET', `${root}/git/ref/heads/main`)).object?.sha, p.baseSha, 'Target main moved; prepare again');
  await checkBase();
  const base = await api('GET', `${root}/git/commits/${p.baseSha}`);
  assert(full(SHA, base.tree?.sha), 'Invalid base tree');
  const tree = await api('POST', `${root}/git/trees`, {
    base_tree: base.tree.sha,
    tree: p.files.map((file) => ({ path: file.path, mode: file.mode, type: 'blob',
      ...(file.content === null ? { sha: null } : { content: file.content }) })),
  });
  assert.equal(tree.sha, p.treeSha, 'Remote tree differs from verified tree');
  const title = p.direction === 'snapshot' ? `chore(pi): sync Stack ${p.sourceSha.slice(0, 12)}` : `chore(pi): adopt ${p.version}`;
  const commit = await api('POST', `${root}/git/commits`, { message: title, tree: p.treeSha, parents: [p.baseSha] });
  assert(full(SHA, commit.sha), 'Invalid candidate SHA');
  await checkBase();
  // Atomic create, never update/force/delete an existing branch, even an orphan.
  await api('POST', `${root}/git/refs`, { ref: `refs/heads/${branch(p)}`, sha: commit.sha });
  const pr = await api('POST', `${root}/pulls`, { title, head: branch(p), base: 'main', draft: true,
    body: `## Resumen\n${p.direction === 'snapshot' ? 'Actualiza la proyección Pi del canon fusionado de Stack.' : 'Adopta el paquete Pi publicado y verificado; conserva el candidato anterior para rollback.'}\n\nBase: ${p.baseSha}\nÁrbol verificado: ${p.treeSha}\nFuente: ${p.sourceSha}\n\nPreparador, diff permitido y verificaciones locales completados sin credenciales de escritura. Los checks remotos deben pasar sobre este candidato antes del merge humano. No se instala nada ni se autoriza auto-merge.\n\nSi falla la transición a ready, conservar esta PR draft y comprobar base, head y gates antes de recuperarla; no volver a publicar paquetes.`,
  });
  assert(Number.isSafeInteger(pr.number) && pr.number > 0, 'Invalid PR number');
  const url = `https://github.com/${repo}/pull/${pr.number}`;
  try {
    await checkBase();
    const current = await api('GET', `${root}/pulls/${pr.number}`);
    assert.equal(current.state, 'open');
    assert.equal(current.draft, true);
    assert.equal(current.head?.sha, commit.sha);
    assert.equal(current.head?.repo?.full_name, repo);
    assert.equal(current.base?.repo?.full_name, repo);
    assert.equal(current.base?.ref, 'main');
    assert.equal(current.base?.sha, p.baseSha);
    assert(full(/^[A-Za-z0-9_=-]{1,200}$/, current.node_id), 'Invalid PR node ID');
    const ready = await api('POST', '/graphql', {
      query: 'mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{isDraft}}}',
      variables: { id: current.node_id },
    });
    assert.equal(ready.data?.markPullRequestReadyForReview?.pullRequest?.isDraft, false, 'Ready transition not confirmed');
    const confirmed = await api('GET', `${root}/pulls/${pr.number}`);
    assert.equal(confirmed.head?.sha, commit.sha, 'Candidate changed after ready');
    assert.equal(confirmed.base?.sha, p.baseSha, 'Base changed after ready');
    assert.equal(confirmed.draft, false, 'Ready state not confirmed');
    return { status: 'ready-pending-checks', url, head: commit.sha };
  } catch {
    throw new Error(`Proposal created at ${url}; verify its state and recover manually. No further writes attempted.`);
  }
}

function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  return execFileSync('git', ['--no-replace-objects', '--no-optional-locks', '-c', 'core.hooksPath=/dev/null', '-C', root, ...args],
    { env, encoding: 'utf8', maxBuffer: MAX_BYTES, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function githubApi(method, path, body) {
  assert(path.startsWith('/repos/') || path === '/graphql', 'Invalid API route');
  const token = process.env.AUTOMATION_TOKEN;
  const response = await fetch(`https://api.github.com${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(30000),
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  // Do not echo error bodies or retry uncertain external writes.
  assert(response.ok, `GitHub request failed (${response.status}); inspect run before retrying`);
  const data = await boundedJson(response);
  assert(!data.errors, 'GitHub GraphQL operation failed');
  return data;
}

async function boundedJson(response) {
  let size = 0;
  const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    assert(size <= MAX_BYTES, 'Response too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function readEnvelope(file) {
  const stat = lstatSync(file);
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_BYTES, 'Invalid proposal file');
  const data = JSON.parse(readFileSync(file, 'utf8'));
  if (data.status === 'prepared') {
    exact(data, ['status', 'proposal']);
    validateProposal(data.proposal);
    assert.equal(data.proposal.direction, process.env.AUTOMATION_DIRECTION, 'Wrong artifact direction');
  } else {
    exact(data, ['status']);
    assert(['unchanged', 'blocked', 'existing'].includes(data.status), 'Invalid status');
  }
  return data;
}

function report(result) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `status=${result.status}\n`);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `### Stack ↔ Pi\nEstado: ${result.status}${result.url ? `\nPR: ${result.url}\nCandidato: ${result.head}\nChecks remotos pendientes; merge exclusivamente humano.` : ''}\n`);
  console.log(JSON.stringify(result));
}

async function prepare(stackRoot, piRoot, output) {
  validateWake(process.env.GITHUB_EVENT_NAME, JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')));
  assert(!process.env.AUTOMATION_TOKEN, 'Preparation must not receive the App token');
  const direction = process.env.AUTOMATION_DIRECTION;
  assert(['snapshot', 'adoption'].includes(direction));
  const target = direction === 'snapshot' ? piRoot : stackRoot;
  // actions/checkout with a branch ref is not detached; helpers reject main.
  for (const root of [stackRoot, piRoot]) {
    assert.equal(git(root, ['status', '--porcelain']).trim(), '', 'Checkout must be clean');
    git(root, ['checkout', '--detach', 'origin/main']);
  }
  const baseSha = git(target, ['rev-parse', 'HEAD']).trim();
  let sourceSha, version = null;
  if (direction === 'snapshot') {
    sourceSha = git(stackRoot, ['log', '--first-parent', '-1', '--format=%H', 'origin/main', '--', 'stack/']).trim();
  } else {
    const tags = git(piRoot, ['tag', '--merged', 'origin/main', '--sort=-version:refname']).trim().split('\n');
    version = tags.find((tag) => tag.startsWith('v') && full(VERSION, tag.slice(1)))?.slice(1);
    assert(version, 'No published version tag available');
    sourceSha = git(piRoot, ['rev-parse', `refs/tags/v${version}^{commit}`]).trim();
  }
  assert(full(SHA, sourceSha));
  mkdirSync(output, { recursive: true });
  const identity = { direction, sourceSha, version };
  const pending = await pendingProposal(identity, githubApi);
  let result = pending;
  if (!result) {
    const helper = direction === 'snapshot'
      ? await import(pathToFileURL(join(piRoot, 'scripts/prepare-stack-snapshot.mjs')).href)
      : await import(pathToFileURL(join(stackRoot, '.github/scripts/prepare-pi-adoption.mjs')).href);
    result = direction === 'snapshot'
      ? await helper.prepareStackSnapshot({ root: piRoot, stackDir: stackRoot, sourceCommit: sourceSha, apply: true })
      : await helper.preparePiAdoption({ root: stackRoot, piDir: piRoot, version, apply: true });
  }
  let envelope = { status: result.status };
  if (result.status === 'prepared') {
    assert(result.changedPaths.length > 0);
    git(target, ['add', '--', ...result.changedPaths]);
    const paths = git(target, ['diff', '--cached', '--name-only', '--no-renames', '-z']).split('\0').filter(Boolean);
    assert.deepEqual([...paths].sort(), [...result.changedPaths].sort(), 'Unexpected changed paths');
    const files = paths.map((path) => {
      const absolute = join(target, path);
      if (!existsSync(absolute)) return { path, mode: '100644', content: null };
      const stat = lstatSync(absolute);
      assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024 * 1024, 'Unsafe generated file');
      assert(git(target, ['ls-files', '--stage', '--', path]).startsWith('100644 '), 'Unexpected Git mode');
      const bytes = readFileSync(absolute), content = bytes.toString('utf8');
      assert(bytes.equals(Buffer.from(content)), 'Non-UTF8 generated file');
      return { path, mode: '100644', content };
    });
    envelope = { status: 'prepared', proposal: validateProposal({ schema: 1, ...identity, baseSha,
      treeSha: git(target, ['write-tree']).trim(), files }) };
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `target=${direction === 'snapshot' ? 'pi' : 'stack'}\n`);
  }
  writeFileSync(join(output, 'proposal.json'), JSON.stringify(envelope));
  report({ status: result.status });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' || command === 'seal') {
    assert.equal(args.length, 3);
    const [stackRoot, piRoot, output] = args.map((arg) => resolve(arg));
    if (command === 'prepare') return prepare(stackRoot, piRoot, output);
    const { proposal: p } = readEnvelope(join(output, 'proposal.json'));
    assert(p, 'Missing prepared proposal');
    const target = p.direction === 'snapshot' ? piRoot : stackRoot;
    assert.equal(git(target, ['rev-parse', 'HEAD']).trim(), p.baseSha);
    git(target, ['diff', '--exit-code']);
    assert.equal(git(target, ['ls-files', '--others', '--exclude-standard']).trim(), '', 'Unexpected files after verification');
    assert.equal(git(target, ['write-tree']).trim(), p.treeSha, 'Verification changed candidate');
  } else {
    assert(['inspect', 'publish'].includes(command) && args.length === 1, 'Invalid command');
    const envelope = readEnvelope(resolve(args[0]));
    if (command === 'inspect' || envelope.status !== 'prepared') return report({ status: envelope.status });
    assert(process.env.AUTOMATION_TOKEN, 'Writer token missing');
    report(await publishProposal(envelope.proposal, githubApi));
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try { await main(); }
  catch (error) {
    console.error(error.message?.startsWith('Proposal created at https://github.com/') ? error.message : 'Coordination failed. Inspect inputs, refs and checks; do not retry an uncertain write blindly.');
    process.exitCode = 1;
  }
}
