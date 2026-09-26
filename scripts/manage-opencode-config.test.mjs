import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';

const script = fileURLToPath(new URL('./manage-opencode-config.mjs', import.meta.url));
const temp = fs.mkdtempSync(path.join(process.env.OPENCODE_CONFIG_TEST_TMPDIR || os.tmpdir(), 'opencode-config-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));
const cavemanFeatures = ['caveman', 'caveman-commit', 'caveman-review',
  'caveman-compress', 'caveman-stats', 'caveman-help'];
const managedCommands = ['check-practices', 'grounded-plan', 'checkpoint'];

function fixture(name) {
  const base = path.join(temp, name);
  const repo = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const global = path.join(home, '.config', 'opencode');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(repo, 'opencode'), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  for (const name of ['manage-opencode-config.mjs', 'ownership.mjs', 'slim-skills.mjs']) {
    fs.copyFileSync(path.join(path.dirname(script), name), path.join(repo, 'scripts', name));
  }
  fs.writeFileSync(path.join(repo, 'opencode', 'opencode.jsonc'), JSON.stringify({ plugin: ['oh-my-opencode-slim@2.2.24'] }));
  fs.writeFileSync(path.join(repo, 'opencode', 'oh-my-opencode-slim.json'), '{}');
  fs.writeFileSync(path.join(repo, 'opencode', 'tui.json'), '{"plugin":["oh-my-opencode-slim@2.2.24"]}');
  fs.writeFileSync(path.join(repo, 'opencode', 'AGENTS.md'), 'Respond tersely.\n');
  fs.mkdirSync(path.join(repo, 'opencode', 'commands'), { recursive: true });
  for (const name of managedCommands) {
    fs.writeFileSync(path.join(repo, 'opencode', 'commands', `${name}.md`), 'fixture');
  }
  return { repo: fs.realpathSync(repo), home, global };
}

function run(f, mode, repo = f.repo) {
  return execFileSync(process.execPath, [path.join(repo, 'scripts', 'manage-opencode-config.mjs'), mode], {
    env: { ...process.env, HOME: f.home }, encoding: 'utf8', stdio: 'pipe',
  });
}

function addSlimSkill(f) {
  const folder = path.join(f.global, 'skills', 'worktrees');
  fs.mkdirSync(folder, { recursive: true, mode: 0o755 });
  fs.chmodSync(folder, 0o755);
  fs.writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: worktrees\n---\n', { mode: 0o644 });
  const hash = crypto.createHash('sha256');
  hash.update('file\0SKILL.md\0' + String(fs.statSync(path.join(folder, 'SKILL.md')).mode & 0o7777) + '\0');
  hash.update(fs.readFileSync(path.join(folder, 'SKILL.md')));
  const manifestDir = path.join(f.global, '.oh-my-opencode-slim');
  fs.mkdirSync(manifestDir);
  fs.writeFileSync(path.join(manifestDir, 'skills-manifest.json'), JSON.stringify({
    schemaVersion: 1,
    skills: { worktrees: { status: 'managed', lastManagedHash: hash.digest('hex') } },
  }));
  return folder;
}

test('fresh setup, repeated setup and disable preserve unrelated files', () => {
  const f = fixture('lifecycle');
  fs.mkdirSync(path.join(f.global, 'commands'), { recursive: true });
  fs.writeFileSync(path.join(f.global, 'commands', 'mine.md'), 'mine');
  fs.writeFileSync(path.join(f.repo, 'opencode', 'opencode.jsonc'), '{// comment\n"plugin":["oh-my-opencode-slim@2.2.24",],}');
  run(f, 'setup');
  run(f, 'setup');
  for (const name of managedCommands) {
    assert.equal(fs.readlinkSync(path.join(f.global, 'commands', `${name}.md`)),
      path.join(f.repo, 'opencode', 'commands', `${name}.md`));
  }
  assert.equal(fs.readlinkSync(path.join(f.global, 'AGENTS.md')), path.join(f.repo, 'opencode', 'AGENTS.md'));
  const skill = addSlimSkill(f);
  assert.throws(() => run(f, 'disable'), /Non-native global configuration remains/);
  assert.equal(fs.existsSync(path.join(f.global, 'AGENTS.md')), false);
  assert.equal(fs.existsSync(path.join(f.global, '.opencode-config-owned.json')), false);
  assert.equal(fs.existsSync(skill), false);
  assert.equal(fs.existsSync(path.join(f.home, '.local/share/opencode-config/parked-slim/skills/worktrees/SKILL.md')), true);
  assert.equal(fs.readFileSync(path.join(f.global, 'commands', 'mine.md'), 'utf8'), 'mine');
  for (const name of managedCommands) {
    assert.equal(fs.existsSync(path.join(f.global, 'commands', `${name}.md`)), false);
  }
});

test('conflicting files are rejected before creating links', () => {
  const f = fixture('conflict');
  fs.mkdirSync(f.global, { recursive: true });
  fs.writeFileSync(path.join(f.global, 'tui.json'), 'user content');
  assert.throws(() => run(f, 'setup'), /Refusing existing unowned path/);
  assert.equal(fs.existsSync(path.join(f.global, 'AGENTS.md')), false);
  assert.equal(fs.readFileSync(path.join(f.global, 'tui.json'), 'utf8'), 'user content');
});

test('setup replaces an existing regular global config with the canonical link', () => {
  const f = fixture('existing-config');
  fs.mkdirSync(f.global, { recursive: true });
  fs.writeFileSync(path.join(f.global, 'opencode.jsonc'), '{"plugin":[]}');
  run(f, 'setup');
  assert.equal(fs.readlinkSync(path.join(f.global, 'opencode.jsonc')),
    path.join(f.repo, 'opencode', 'opencode.jsonc'));
  assert.equal(fs.readdirSync(f.global).some((name) => name.startsWith('opencode.jsonc.')), false);
});

test('removing Slim from repo config parks its skill, then setup restores it', () => {
  const f = fixture('reconcile');
  run(f, 'setup');
  const skill = addSlimSkill(f);
  fs.writeFileSync(path.join(f.repo, 'opencode', 'opencode.jsonc'), JSON.stringify({ plugin: [] }));
  run(f, 'setup');
  assert.equal(fs.existsSync(skill), false);
  assert.equal(fs.existsSync(path.join(f.home, '.local/share/opencode-config/parked-slim/skills/worktrees/SKILL.md')), true);
  assert.equal(fs.existsSync(path.join(f.global, 'oh-my-opencode-slim.json')), false);
  assert.equal(fs.existsSync(path.join(f.global, 'tui.json')), false);
  assert.equal(fs.existsSync(path.join(f.global, 'AGENTS.md')), true);
  fs.writeFileSync(path.join(f.repo, 'opencode', 'opencode.jsonc'), JSON.stringify({ plugin: ['oh-my-opencode-slim@2.2.24'] }));
  run(f, 'setup');
  assert.equal(fs.existsSync(skill), true);
  assert.equal(fs.existsSync(path.join(f.global, '.oh-my-opencode-slim/skills-manifest.json')), true);
  fs.rmSync(path.join(f.repo, 'opencode', 'AGENTS.md'));
  run(f, 'setup');
  assert.equal(fs.existsSync(path.join(f.global, 'AGENTS.md')), false);
});

test('setup unlinks previously owned Caveman paths but retains global style rules', () => {
  const f = fixture('caveman-reconcile');
  run(f, 'setup');
  const ownedFile = path.join(f.global, '.opencode-config-owned.json');
  const ownership = JSON.parse(fs.readFileSync(ownedFile, 'utf8'));
  const legacyPaths = [
    'plugins/caveman', 'caveman-config.json',
    ...cavemanFeatures.map((name) => `commands/${name}.md`),
    ...cavemanFeatures.map((name) => `skills/${name}`),
  ];
  for (const name of legacyPaths) {
    const target = path.join(f.repo, 'opencode', name);
    const link = name === 'caveman-config.json'
      ? path.join(f.home, '.config', 'caveman', 'config.json')
      : path.join(f.global, name);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link);
    ownership.links[name] = target;
  }
  fs.writeFileSync(ownedFile, `${JSON.stringify(ownership)}\n`);
  run(f, 'setup');
  for (const name of legacyPaths) {
    const link = name === 'caveman-config.json'
      ? path.join(f.home, '.config', 'caveman', 'config.json')
      : path.join(f.global, name);
    assert.throws(() => fs.lstatSync(link), { code: 'ENOENT' });
  }
  assert.equal(fs.readlinkSync(path.join(f.global, 'AGENTS.md')), path.join(f.repo, 'opencode', 'AGENTS.md'));
  assert.equal(fs.existsSync(path.join(f.global, 'oh-my-opencode-slim.json')), true);
  for (const name of managedCommands) {
    assert.equal(fs.existsSync(path.join(f.global, 'commands', `${name}.md`)), true);
  }
});

test('modified Slim skills remain byte-for-byte intact across disable and setup', () => {
  const f = fixture('modified');
  run(f, 'setup');
  const skill = addSlimSkill(f);
  fs.writeFileSync(path.join(skill, 'notes.md'), 'user changes');
  run(f, 'disable');
  assert.equal(fs.existsSync(skill), false);
  assert.equal(fs.readFileSync(path.join(f.home, '.local/share/opencode-config/parked-slim/skills/worktrees/notes.md'), 'utf8'), 'user changes');
  run(f, 'setup');
  assert.equal(fs.readFileSync(path.join(skill, 'notes.md'), 'utf8'), 'user changes');
});

test('unowned skill directories block disabling before any link changes', () => {
  const f = fixture('unowned-skill');
  run(f, 'setup');
  fs.mkdirSync(path.join(f.global, 'skills', 'worktrees'), { recursive: true });
  assert.throws(() => run(f, 'disable'), /Cannot identify Slim-owned skill to park/);
  assert.equal(fs.existsSync(path.join(f.global, 'AGENTS.md')), true);
});

test('clone moved after installation can reclaim recorded links', () => {
  const f = fixture('moved');
  run(f, 'setup');
  const movedPath = path.join(temp, 'moved-clone');
  fs.cpSync(f.repo, movedPath, { recursive: true });
  const moved = fs.realpathSync(movedPath);
  run(f, 'setup', moved);
  assert.equal(fs.readlinkSync(path.join(f.global, 'AGENTS.md')), path.join(moved, 'opencode', 'AGENTS.md'));
  run(f, 'disable', moved);
});
