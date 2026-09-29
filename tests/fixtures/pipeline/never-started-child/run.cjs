const fs = require('node:fs');
fs.writeFileSync(process.argv[2], 'started');
setInterval(() => {}, 1000);
