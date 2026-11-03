const fs = require('node:fs');
const [ready, received, heartbeat] = process.argv.slice(2);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  fs.writeFileSync(received, signal);
  process.kill(process.pid, signal);
});
fs.writeFileSync(ready, 'ready');
setInterval(() => fs.writeFileSync(heartbeat, String(Date.now())), 75);
