// Node 24+: deterministic playback; optional javac never runs archived build scripts or processors.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname, join, extname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { registerHooks } from 'node:module';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import ts from 'typescript';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && context.parentURL?.startsWith(pathToFileURL(repository).href)) {
      const path = fileURLToPath(new URL(specifier, context.parentURL));
      if (!extname(path) && existsSync(path + '.ts')) return next(pathToFileURL(path + '.ts').href, context);
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(pathToFileURL(repository).href) && url.endsWith('.ts')) return { format: 'module', source: ts.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText, shortCircuit: true };
    return next(url, context);
  },
});
const args = process.argv.slice(2), paths = args.filter(arg => !arg.startsWith('--'));
const directory = paths[0];
if (!directory) throw new Error('Usage: node scripts/replay-project.mjs <diagnostic-directory> [output-directory] [--compile] [--classpath=...] [--release=21]');
const root = resolve(directory), output = resolve(paths[1] || join(root, 'replay-output'));
const events = JSON.parse(readFileSync(join(root, 'events.json'), 'utf8'));
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const { applyTreeToolCalls, findNodeByPath } = await import(pathToFileURL(join(repository, 'functions/_lib/projectTree.ts')).href);
const { checkNodeContract } = await import(pathToFileURL(join(repository, 'functions/_lib/projectTreeContract.ts')).href);
const { safeProjectPath, redact, missingBuildLogs } = await import(pathToFileURL(join(repository, 'shared/projectArchive.ts')).href);
const models = new Map(), results = [], gaps = [], files = new Map(); let finalTree;
for (const event of events) {
  if (event.incomplete || event.gap) gaps.push(event.id);
  if (event.kind === 'model.request') models.set(event.data.callId, { request: event.data.request, responses: [] });
  if (event.kind === 'model.response') {
    const call = models.get(event.data.callId);
    if (call) call.responses.push(...event.data.events);
    else gaps.push(`missing-model-request:${event.data.callId}`);
  }
  if (event.kind === 'tree.tools') {
    const replay = applyTreeToolCalls(event.data.before, event.data.calls);
    const matches = JSON.stringify(replay.tree) === JSON.stringify(event.data.after) && JSON.stringify(replay.results) === JSON.stringify(event.data.results);
    results.push({ id: event.id, kind: 'tree.tools', matches });
    finalTree = event.data.after;
  }
  if (event.kind === 'source.checkpoint') for (const file of event.data.files || []) if (file.completed && typeof file.content === 'string') files.set(file.path, file.content);
}
for (const [id, call] of models) if (!call.responses.length) gaps.push(`missing-model-response:${id}`);
gaps.push(...missingBuildLogs(events));
// A resumed task may start from a locked checkpoint without replaying any tree
// tool. Its archived project still supplies the final contracts to validate.
if (existsSync(join(root, 'project.json'))) finalTree = JSON.parse(readFileSync(join(root, 'project.json'), 'utf8')).tree || finalTree;
const sourceRoot = join(root, 'source');
function readSource(directory, prefix = '') {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (!safeProjectPath(path) || entry.isSymbolicLink()) throw new Error('Unsafe archived source path');
    if (entry.isDirectory()) readSource(join(directory, entry.name), path + '/');
    else files.set(path, readFileSync(join(directory, entry.name)));
  }
}
if (existsSync(sourceRoot)) readSource(sourceRoot);
if (existsSync(join(root, 'resources.json'))) for (const file of JSON.parse(readFileSync(join(root, 'resources.json'), 'utf8'))) {
  if (!safeProjectPath(file.path) || file.encoding !== 'base64') throw new Error('Invalid binary resource');
  files.set(file.path, Buffer.from(file.content, 'base64'));
}
const contractChecks = [];
for (const [path, content] of files) {
  if (!safeProjectPath(path)) throw new Error('Unsafe archived source path');
  const target = join(output, 'source', path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, content);
  const node = finalTree && findNodeByPath(finalTree, path);
  if (node && path.endsWith('.java')) contractChecks.push({ path, check: checkNodeContract(finalTree, node, String(content)) });
}
mkdirSync(output, { recursive: true });
writeFileSync(join(output, 'model-playback.json'), JSON.stringify([...models].map(([id, call]) => ({ id, ...call })), null, 2));
writeFileSync(join(output, 'tool-results.json'), JSON.stringify(events.filter(event => ['tree.tools', 'tool.request', 'tool.response', 'tool.error', 'operation.result'].includes(event.kind)), null, 2));
let compile = { status: 'not_run', reason: 'Pass --compile and a dependency --classpath to run javac with annotation processing disabled.' };
if (args.includes('--compile')) {
  const option = name => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1);
  const release = option('--release') || '21'; if (!/^(?:[89]|[1-9][0-9])$/.test(release)) throw new Error('Invalid Java release');
  const java = [...files.keys()].filter(path => path.endsWith('.java')).map(path => join(output, 'source', path));
  if (!java.length) throw new Error('No restored Java source to compile');
  const classes = join(output, 'classes'); mkdirSync(classes, { recursive: true });
  const executable = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac') : 'javac';
  const result = spawnSync(executable, ['-encoding', 'UTF-8', '-proc:none', '--release', release, ...(option('--classpath') ? ['-classpath', option('--classpath')] : []), '-d', classes, ...java], { timeout: 60000, encoding: 'utf8', env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/TOKEN|SECRET|PASSWORD|CREDENTIAL|API_KEY/i.test(key))) });
  writeFileSync(join(output, 'compile.log'), redact((result.stdout || '') + (result.stderr || '') + (result.error ? String(result.error) : '')));
  compile = { status: result.status === 0 ? 'passed' : 'failed', exitCode: result.status, release, dependencies: 'Caller-supplied classpath; changing external artifacts may change the result.' };
}
const report = { schemaVersion: 1, modelCalls: models.size, deterministicTreeReplays: results, contractChecks, sourceFiles: [...files].map(([path, content]) => ({ path, sha256: createHash('sha256').update(content).digest('hex') })), gaps, complete: !manifest.journalIncomplete && !gaps.length, passed: results.every(item => item.matches) && contractChecks.every(item => item.check.passed === item.check.total), compile };
writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (!report.passed || !report.complete || compile.status === 'failed') process.exitCode = 2;
