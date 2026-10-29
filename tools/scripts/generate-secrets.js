#!/usr/bin/env node
'use strict';
// Prints fresh values for the collector's secrets, ready to paste into Render.
//   node tools/scripts/generate-secrets.js
const crypto = require('node:crypto');

const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

console.log('# Paste these into the collector service on Render (Environment tab).');
console.log('# JWT_PRIVATE_KEY is on one line with \\n escapes; the collector restores the newlines.\n');
console.log('ADMIN_TOKEN=' + crypto.randomBytes(32).toString('base64url'));
console.log('JWT_PRIVATE_KEY=' + pem.trim().replace(/\n/g, '\\n'));
