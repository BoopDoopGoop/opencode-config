import fs from 'node:fs';
import path from 'node:path';
import { destination, json, stat } from './ownership.mjs';

const bundledSkills = new Set([
  'simplify', 'codemap', 'clonedeps', 'deepwork',
  'verification-planning', 'reflect', 'oh-my-opencode-slim', 'worktrees',
]);

function readManifest(file) {
  const info = stat(file);
  if (!info) return null;
  if (!info.isFile()) throw new Error(`Invalid Slim ownership manifest: ${file}`);
  const manifest = json(file);
  if (manifest.schemaVersion !== 1 || !manifest.skills ||
      typeof manifest.skills !== 'object' || Array.isArray(manifest.skills)) {
    throw new Error(`Invalid Slim ownership manifest: ${file}`);
  }
  return manifest;
}

function namesIn(manifest) {
  const names = new Set([...bundledSkills, ...Object.keys(manifest?.skills ?? {})]);
  for (const name of names) {
    if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid Slim skill name: ${name}`);
  }
  return names;
}

// Park copies outside every OpenCode skill-discovery path. Keep bytes and
// Slim's manifest together so setup can restore the same state later.
export function planSlimPark(ctx) {
  const manifest = readManifest(ctx.slimManifestPath);
  const parkedManifest = path.join(ctx.slimParkDir, 'skills-manifest.json');
  if (stat(ctx.slimParkDir)?.isSymbolicLink() || stat(path.join(ctx.slimParkDir, 'skills'))?.isSymbolicLink()) {
    throw new Error(`Refusing symlinked Slim parking location: ${ctx.slimParkDir}`);
  }
  if (stat(parkedManifest)) throw new Error(`Slim skills already parked: ${parkedManifest}`);

  const moves = [];
  for (const name of namesIn(manifest)) {
    const current = destination(ctx, `skills/${name}`);
    const info = stat(current);
    if (!info) continue;
    if (!manifest?.skills[name] || !info.isDirectory()) {
      throw new Error(`Cannot identify Slim-owned skill to park: ${current}`);
    }
    const parked = path.join(ctx.slimParkDir, 'skills', name);
    if (stat(parked)) throw new Error(`Slim skill already parked: ${parked}`);
    moves.push([current, parked]);
  }
  return { moves, manifest: manifest ? [ctx.slimManifestPath, parkedManifest] : null };
}

export function planSlimRestore(ctx) {
  const parkedManifest = path.join(ctx.slimParkDir, 'skills-manifest.json');
  if (stat(ctx.slimParkDir)?.isSymbolicLink() || stat(path.join(ctx.slimParkDir, 'skills'))?.isSymbolicLink()) {
    throw new Error(`Refusing symlinked Slim parking location: ${ctx.slimParkDir}`);
  }
  const manifest = readManifest(parkedManifest);
  const parkedSkills = path.join(ctx.slimParkDir, 'skills');
  const names = stat(parkedSkills) ? fs.readdirSync(parkedSkills) : [];
  if (names.length && !manifest) throw new Error(`Missing parked Slim manifest: ${parkedManifest}`);

  const moves = [];
  for (const name of names) {
    if (!namesIn(manifest).has(name) || !manifest.skills[name]) {
      throw new Error(`Unknown parked Slim skill: ${name}`);
    }
    const parked = path.join(parkedSkills, name);
    const current = destination(ctx, `skills/${name}`);
    if (!stat(parked)?.isDirectory() || stat(current)) {
      throw new Error(`Cannot restore parked Slim skill: ${current}`);
    }
    moves.push([parked, current]);
  }
  if (manifest && stat(ctx.slimManifestPath)) {
    throw new Error(`Slim ownership manifest already exists: ${ctx.slimManifestPath}`);
  }
  return { moves, manifest: manifest ? [parkedManifest, ctx.slimManifestPath] : null };
}

export function moveSlimState(ctx, plan, action) {
  if (!plan.moves.length && !plan.manifest) return;
  for (const [from, to] of plan.moves) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.renameSync(from, to);
    console.log(`${action} Slim skill: ${path.basename(to)}`);
  }
  if (plan.manifest) {
    fs.mkdirSync(path.dirname(plan.manifest[1]), { recursive: true });
    fs.renameSync(...plan.manifest);
  }
  if (action === 'Restored' && stat(path.join(ctx.slimParkDir, 'skills')) &&
      fs.readdirSync(path.join(ctx.slimParkDir, 'skills')).length === 0) {
    fs.rmdirSync(path.join(ctx.slimParkDir, 'skills'));
  }
  if (action === 'Restored' && stat(ctx.slimParkDir) && fs.readdirSync(ctx.slimParkDir).length === 0) {
    fs.rmdirSync(ctx.slimParkDir);
  }
  if (action === 'Parked' && stat(ctx.slimDir) && fs.readdirSync(ctx.slimDir).length === 0) {
    fs.rmdirSync(ctx.slimDir);
  }
}
