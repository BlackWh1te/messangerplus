const https = require('https');
https.get('https://messangerplus.vercel.app/chat', (res) => {
  let data = '';
  res.on('data', (chunk) => data += chunk);
  res.on('end', () => {
    const chunks = [...data.matchAll(/src=\"(\/_next\/static\/chunks\/app\/chat\/[^\"]+)\"/g)].map(m => m[1]);
    let checks = chunks.length;
    let found = false;
    chunks.forEach(chunk => {
      https.get('https://messangerplus.vercel.app' + chunk, (jsRes) => {
        let jsData = '';
        jsRes.on('data', (c) => jsData += c);
        jsRes.on('end', () => {
          if (jsData.includes('gatherClientTelemetry') || jsData.includes('nonce')) {
            found = true;
          }
          checks--;
          if (checks === 0) {
            console.log(found ? 'SUCCESS_DEPLOYED' : 'PENDING_OR_FAILED');
          }
        });
      });
    });
    if (chunks.length === 0) console.log('NO_CHUNKS');
  });
});
