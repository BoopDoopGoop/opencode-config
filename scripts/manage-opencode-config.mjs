import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  auditGlobal, desiredLinks, loadOwnership, preflightLinks,
  reconcileLinks, removeLegacyDanglingLinks, saveOwnership, stat,
} from './ownership.mjs';

const mode = process.argv[2];
if (!['setup', 'disable'].includes(mode)) throw new Error('Usage: setup.sh | disable.sh');

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.HOME || os.homedir();
const configDir = path.join(home, '.config', 'opencode');
const ctx = {
  repo, home, configDir,
  ownedFile: path.join(configDir, '.opencode-config-owned.json'),
};

function main() {
  const ownership = loadOwnership(ctx);
  const desired = mode === 'setup' ? desiredLinks(ctx) : {};
  // Resolve all ownership conflicts before unlinking or replacing anything.
  preflightLinks(ctx, ownership, desired);
  fs.mkdirSync(configDir, { recursive: true });
  removeLegacyDanglingLinks(ctx);
  reconcileLinks(ctx, ownership, desired);

  if (mode === 'setup') {
    saveOwnership(ctx, desired);
  } else {
    if (stat(ctx.ownedFile)) fs.unlinkSync(ctx.ownedFile);
    const leftover = auditGlobal(ctx);
    if (leftover.length) throw new Error(`Non-native global configuration remains:\n${leftover.join('\n')}`);
  }
  console.log(`${mode === 'setup' ? 'Enabled' : 'Disabled'} managed OpenCode configuration. Restart OpenCode Desktop.`);
}

try { main(); }
catch (error) { console.error(`[opencode-config] ${error.message}`); process.exitCode = 1; }
