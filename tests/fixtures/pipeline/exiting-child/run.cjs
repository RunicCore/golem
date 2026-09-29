const fs = require('node:fs');
fs.writeFileSync(process.argv[2], 'ready');
setTimeout(() => process.exit(17), 120);
