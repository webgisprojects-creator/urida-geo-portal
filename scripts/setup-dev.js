#!/usr/bin/env node
/**
 * scripts/setup-dev.js — one-time local development environment setup
 *
 * Run once after cloning:
 *   npm run setup
 *
 * What it does:
 *   - Copies client/.env.example  →  client/.env   (only if .env is missing)
 *   - Copies server/.env.example  →  server/.env   (only if .env is missing)
 *
 * What it does NOT do:
 *   - Overwrite existing .env files  (safe to run multiple times)
 *   - Run automatically              (not a postinstall hook)
 *   - Run on the server              (deploy.yml never calls this script)
 */

const fs   = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

const envFiles = [
  {
    example : path.join(root, 'client', '.env.example'),
    target  : path.join(root, 'client', '.env'),
    label   : 'client/.env',
    note    : 'Defaults work for local development — no edits needed.',
  },
  {
    example : path.join(root, 'server', '.env.example'),
    target  : path.join(root, 'server', '.env'),
    label   : 'server/.env',
    note    : 'Fill in DB_HOST, DB_USER, DB_PASS, DB_NAME, GEOSERVER_PROXY_TARGET, JWT_SECRET\n' +
              '     Ask the team lead for these values.',
  },
];

console.log('\nURIDA Geo Portal — developer setup\n');

let created = 0;
let skipped = 0;

for (const { example, target, label, note } of envFiles) {
  if (fs.existsSync(target)) {
    console.log(`  ⏭  ${label} already exists — skipped`);
    skipped++;
  } else if (!fs.existsSync(example)) {
    console.error(`  ✗  ${label}.example not found — cannot copy`);
  } else {
    fs.copyFileSync(example, target);
    console.log(`  ✅ Created ${label}`);
    console.log(`     → ${note}`);
    created++;
  }
}

console.log('');

if (created > 0) {
  console.log('─'.repeat(60));
  console.log('Next steps:');
  console.log('');
  console.log('  1. Open server/.env and fill in the values from the team lead');
  console.log('     (DB_HOST, DB_USER, DB_PASS, DB_NAME, GEOSERVER_PROXY_TARGET)');
  console.log('');
  console.log('  2. Generate a JWT_SECRET and paste it into server/.env:');
  console.log('     node -e "console.log(require(\'crypto\').randomBytes(64).toString(\'hex\'))"');
  console.log('');
  console.log('  3. Start the backend (CMD window 1):');
  console.log('     npm run dev:server');
  console.log('');
  console.log('  4. Start the frontend (CMD window 2):');
  console.log('     npm run dev:client');
  console.log('');
  console.log('  5. Open http://localhost:3000');
  console.log('─'.repeat(60));
} else {
  console.log('All .env files already exist. You are ready to run the project.');
  console.log('  npm run dev:server   (CMD window 1)');
  console.log('  npm run dev:client   (CMD window 2)');
}

console.log('');
