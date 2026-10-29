'use strict';
// Sends a little steady traffic to the shop so traces flow:  npm run traffic -- [baseUrl] [requestsPerSecond] [seconds]
const base = (process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const rps = Number(process.argv[3] || 2);
const seconds = Number(process.argv[4] || 30);

async function once(i) {
  const productId = ['p1', 'p2', 'p3'][i % 3];
  const r = await fetch(`${base}/api/checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ productId, quantity: 1 + (i % 2) }) });
  return r.status;
}

(async () => {
  const counts = {};
  const end = Date.now() + seconds * 1000;
  let i = 0;
  while (Date.now() < end) {
    const started = Date.now();
    await Promise.all(Array.from({ length: rps }, () => once(i++).then((s) => { counts[s] = (counts[s] || 0) + 1; }, () => { counts.network_error = (counts.network_error || 0) + 1; })));
    await new Promise((r) => setTimeout(r, Math.max(0, 1000 - (Date.now() - started))));
  }
  console.log('responses by status:', counts);
})();
