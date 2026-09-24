import fs from 'node:fs';
import path from 'node:path';

const legacySkills = [
  'cavecrew', 'caveman', 'caveman-commit', 'caveman-compress',
  'caveman-help', 'caveman-review', 'caveman-stats',
];
const knownPaths = new Set([
  'opencode.jsonc', 'oh-my-opencode-slim.json', 'tui.json', 'AGENTS.md',
  'plugins', 'plugins/caveman', 'agents', 'commands', 'commands/caveman.md',
  ...legacySkills.map((name) => `skills/${name}`),
]);

export const source = (ctx, name) => path.join(ctx.repo, 'opencode', name);
export const destination = (ctx, name) => path.join(ctx.configDir, name);

export function stat(file) {
  try { return fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function json(file) {
  const input = fs.readFileSync(file, 'utf8');
  let clean = '';
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      clean += char;
      if (char === '\\') clean += input[++i] ?? '';
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      clean += char;
    } else if (char === '/' && input[i + 1] === '/') {
      while (i < input.length && input[i] !== '\n') i++;
      clean += '\n';
    } else if (char === '/' && input[i + 1] === '*') {
      i += 2;
      while (i < input.length && !(input[i] === '*' && input[i + 1] === '/')) i++;
      i++;
    } else clean += char;
  }
  let normalized = '';
  quoted = false;
  for (let i = 0; i < clean.length; i++) {
    const char = clean[i];
    if (quoted) {
      normalized += char;
      if (char === '\\') normalized += clean[++i] ?? '';
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
      normalized += char;
    } else if (char === ',') {
      let next = i + 1;
      while (/\s/.test(clean[next] ?? '')) next++;
      if (!'}]'.includes(clean[next] ?? '')) normalized += char;
    } else normalized += char;
  }
  return JSON.parse(normalized);
}

export function loadOwnership(ctx) {
  if (!stat(ctx.ownedFile)) return { version: 1, repo: ctx.repo, links: {} };
  if (stat(ctx.ownedFile).isSymbolicLink()) {
    throw new Error(`Refusing symlinked ownership manifest: ${ctx.ownedFile}`);
  }
  const data = json(ctx.ownedFile);
  if (data.version !== 1 || !path.isAbsolute(data.repo) || !data.links ||
      typeof data.links !== 'object' || Array.isArray(data.links)) {
    throw new Error(`Invalid ownership manifest: ${ctx.ownedFile}`);
  }
  for (const [name, target] of Object.entries(data.links)) {
    if (!knownPaths.has(name) || target !== source({ repo: data.repo }, name)) {
      throw new Error(`Invalid ownership record: ${name}`);
    }
  }
  return data;
}

export function desiredLinks(ctx) {
  const config = source(ctx, 'opencode.jsonc');
  if (!stat(config)?.isFile()) throw new Error(`Missing configuration: ${config}`);
  let plugins;
  try { plugins = json(config).plugin ?? []; }
  catch (error) { throw new Error(`Cannot parse ${config}: ${error.message}`); }
  if (!Array.isArray(plugins)) throw new Error('plugin must be an array');
  const slimSpec = plugins.find((entry) => typeof entry === 'string' &&
    /^oh-my-opencode-slim(?:@[^/]+)?$/.test(entry));
  const slim = Boolean(slimSpec);
  const links = { 'opencode.jsonc': config };
  if (stat(source(ctx, 'AGENTS.md'))?.isFile()) links['AGENTS.md'] = source(ctx, 'AGENTS.md');
  if (slim) {
    const settings = source(ctx, 'oh-my-opencode-slim.json');
    if (!stat(settings)?.isFile()) throw new Error(`Missing Slim settings: ${settings}`);
    links['oh-my-opencode-slim.json'] = settings;
  }
  if (stat(source(ctx, 'tui.json'))) {
    const badge = json(source(ctx, 'tui.json')).plugin ?? [];
    if (!Array.isArray(badge)) throw new Error('TUI plugin must be an array');
    const slimBadge = badge.filter((entry) => typeof entry === 'string' &&
      /^oh-my-opencode-slim(?:@[^/]+)?$/.test(entry));
    if (slim && (slimBadge.length !== 1 || slimBadge[0] !== slimSpec)) {
      throw new Error('Slim plugin and TUI version entries disagree');
    }
    if (!slim && slimBadge.length && badge.length !== slimBadge.length) {
      throw new Error('Remove Slim from TUI config while preserving other TUI plugins');
    }
    if (slim || badge.length > slimBadge.length) links['tui.json'] = source(ctx, 'tui.json');
  }
  return links;
}

export function ownedLink(ctx, name, ownership) {
  const file = destination(ctx, name);
  if (!stat(file)?.isSymbolicLink()) return null;
  const target = fs.readlinkSync(file);
  if (target === ownership.links[name] || target === source(ctx, name)) return target;
  return null;
}

export function preflightLinks(ctx, ownership, desired) {
  for (const name of new Set([...Object.keys(ownership.links), ...Object.keys(desired), ...knownPaths])) {
    const file = destination(ctx, name);
    const info = stat(file);
    if (!info) continue;
    const old = ownedLink(ctx, name, ownership);
    if (desired[name]) {
      if (name === 'opencode.jsonc' && info.isFile()) continue;
      if (!old) throw new Error(`Refusing existing unowned path: ${file}`);
    } else if (ownership.links[name] && !old) {
      throw new Error(`Previously owned path was changed: ${file}`);
    }
  }
}

export function removeLegacyDanglingLinks(ctx) {
  for (const name of ['package.json', 'package-lock.json']) {
    const file = destination(ctx, name);
    const old = path.join(ctx.home, 'Developer', 'archive', 'agent-config', 'opencode', name);
    if (stat(file)?.isSymbolicLink() && fs.readlinkSync(file) === old && !fs.existsSync(file)) {
      fs.unlinkSync(file);
      console.log(`Removed obsolete dangling link: ${file}`);
    }
  }
}

export function reconcileLinks(ctx, ownership, desired) {
  for (const name of [...knownPaths].sort((a, b) => b.length - a.length)) {
    const file = destination(ctx, name);
    const old = ownedLink(ctx, name, ownership);
    if (old && old !== desired[name]) fs.unlinkSync(file);
  }
  for (const [name, target] of Object.entries(desired)) {
    const file = destination(ctx, name);
    if (stat(file)?.isSymbolicLink() && fs.readlinkSync(file) === target) continue;
    if (name === 'opencode.jsonc' && stat(file)?.isFile()) fs.unlinkSync(file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.symlinkSync(target, file);
  }
}

export function saveOwnership(ctx, desired) {
  const data = { version: 1, repo: ctx.repo, links: desired };
  const temp = `${ctx.ownedFile}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temp, ctx.ownedFile);
}

export function auditGlobal(ctx) {
  const leftover = [];
  for (const name of ['opencode.json', 'opencode.jsonc', 'opencode.jsonc.bak', 'AGENTS.md',
    'oh-my-opencode-slim.json', 'tui.json', 'package.json', 'package-lock.json']) {
    const file = destination(ctx, name);
    // Backup, npm dependencies, and lock files are inert without configuration.
    if (!['opencode.jsonc.bak', 'package.json', 'package-lock.json'].includes(name) && stat(file)) leftover.push(file);
  }
  for (const name of ['plugins', 'plugin', 'agents', 'agent', 'commands', 'command', 'skills', 'skill', '.opencode']) {
    const file = destination(ctx, name);
    if (stat(file) && (stat(file).isSymbolicLink() || !stat(file).isDirectory() || fs.readdirSync(file).length)) leftover.push(file);
  }
  for (const file of [path.join(ctx.home, '.claude', 'CLAUDE.md'), path.join(ctx.home, '.opencode', 'AGENTS.md')]) {
    if (stat(file)) leftover.push(file);
  }
  for (const dir of [path.join(ctx.home, '.agents', 'skills'), path.join(ctx.home, '.claude', 'skills')]) {
    if (stat(dir)?.isDirectory() && fs.readdirSync(dir).length) leftover.push(dir);
  }
  return leftover;
}
