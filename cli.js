#!/usr/bin/env node
/**
 * CLI helpers for admin management. Runs against production Postgres.
 * Usage:
 *   node cli.js add-admin <email>            # prompts for password
 *   node cli.js reset-password <email>       # prompts for new password
 *   node cli.js list-admins
 *   node cli.js remove-admin <email>
 */

require('dotenv').config();

const readline = require('readline');
const bcrypt = require('bcrypt');
const { pool, query } = require('./db');

const BCRYPT_COST = 12;

function prompt(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    if (hidden) {
      process.stdout.write(question);
      const stdin = process.openStdin();
      let input = '';
      process.stdin.on('data', (char) => {
        const s = char.toString();
        if (s === '\n' || s === '\r' || s === '') {
          stdin.pause();
          rl.close();
          process.stdout.write('\n');
          resolve(input);
        } else {
          input += s.replace(/\n|\r/g, '');
        }
      });
    } else {
      rl.question(question, (answer) => { rl.close(); resolve(answer); });
    }
  });
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'add-admin') {
    if (!arg) return usage();
    const { rows } = await query('SELECT 1 FROM admin_users WHERE email = $1', [arg]);
    if (rows.length) return console.error(`Already exists: ${arg}`);
    const pw = await prompt(`Password for ${arg} (≥10 chars): `, true);
    if (pw.length < 10) return console.error('Password too short (≥10 chars).');
    const hash = bcrypt.hashSync(pw, BCRYPT_COST);
    await query('INSERT INTO admin_users (email, password_hash) VALUES ($1, $2)', [arg, hash]);
    console.log(`✓ added: ${arg}`);
  } else if (cmd === 'reset-password') {
    if (!arg) return usage();
    const { rows } = await query('SELECT 1 FROM admin_users WHERE email = $1', [arg]);
    if (rows.length === 0) return console.error(`Not found: ${arg}`);
    const pw = await prompt(`New password for ${arg} (≥10 chars): `, true);
    if (pw.length < 10) return console.error('Password too short (≥10 chars).');
    const hash = bcrypt.hashSync(pw, BCRYPT_COST);
    await query('UPDATE admin_users SET password_hash = $1 WHERE email = $2', [hash, arg]);
    await query('DELETE FROM admin_sessions WHERE email = $1', [arg]);
    console.log(`✓ password reset for ${arg}. All existing sessions logged out.`);
  } else if (cmd === 'list-admins') {
    const { rows } = await query(
      'SELECT email, created_at, last_login_at FROM admin_users ORDER BY created_at',
    );
    console.table(rows.map((r) => ({
      email: r.email,
      created: r.created_at.toISOString(),
      last_login: r.last_login_at ? r.last_login_at.toISOString() : '—',
    })));
  } else if (cmd === 'remove-admin') {
    if (!arg) return usage();
    const result = await query('DELETE FROM admin_users WHERE email = $1', [arg]);
    if (result.rowCount === 0) return console.error(`Not found: ${arg}`);
    console.log(`✓ removed: ${arg}`);
  } else {
    usage();
  }
}

function usage() {
  console.log(`Usage:
  node cli.js add-admin <email>
  node cli.js reset-password <email>
  node cli.js list-admins
  node cli.js remove-admin <email>`);
  process.exit(1);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => pool.end());
