#!/usr/bin/env node
/**
 * Smoke test R2 upload/list/download/delete.
 * Usage:
 *   node scripts/test-r2.js
 */

require('dotenv').config();
const { uploadObject, deleteObject, listObjects, headObject, publicUrl, BUCKET } = require('../r2');

const TEST_KEY = `_smoke-test/${Date.now()}.txt`;
const TEST_BODY = Buffer.from(`hello from theme-be @ ${new Date().toISOString()}`);

(async () => {
  try {
    console.log(`bucket: ${BUCKET}`);
    console.log(`key:    ${TEST_KEY}`);
    console.log(`size:   ${TEST_BODY.length} bytes\n`);

    console.log('1. Upload...');
    await uploadObject(TEST_KEY, TEST_BODY, 'text/plain');
    console.log('   ✓ upload OK\n');

    console.log('2. Head (verify metadata)...');
    const head = await headObject(TEST_KEY);
    console.log(`   ✓ size=${head.size}, contentType=${head.contentType}, lastModified=${head.lastModified.toISOString()}\n`);

    console.log('3. List prefix _smoke-test/ ...');
    const items = await listObjects('_smoke-test/');
    console.log(`   ✓ found ${items.length} object(s)`);
    items.slice(0, 3).forEach((o) => console.log(`     - ${o.key} (${o.size}B)`));
    console.log();

    if (process.env.R2_PUBLIC_BASE_URL) {
      const url = publicUrl(TEST_KEY);
      console.log(`4. Public URL: ${url}`);
      try {
        const res = await fetch(url);
        const text = await res.text();
        const ok = res.ok && text === TEST_BODY.toString();
        console.log(`   ${ok ? '✓' : '✗'} status=${res.status}, body match=${text === TEST_BODY.toString()}\n`);
      } catch (e) {
        console.log(`   ⚠ fetch failed: ${e.message}\n`);
      }
    } else {
      console.log('4. Public URL test skipped — R2_PUBLIC_BASE_URL not set.\n');
    }

    console.log('5. Delete...');
    await deleteObject(TEST_KEY);
    console.log('   ✓ delete OK\n');

    console.log('6. Head after delete (expect null)...');
    const after = await headObject(TEST_KEY);
    console.log(`   ${after === null ? '✓' : '✗'} ${after === null ? 'gone' : 'still exists'}\n`);

    console.log('✅ All checks passed.');
  } catch (err) {
    console.error(`\n✗ FAILED: ${err.name || 'Error'} — ${err.message}`);
    if (err.$metadata) console.error(`  HTTP ${err.$metadata.httpStatusCode}, Code=${err.Code}`);
    process.exit(1);
  }
})();
