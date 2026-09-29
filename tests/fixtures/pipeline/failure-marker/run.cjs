const fs = require('node:fs');
fs.writeFileSync(process.argv[2], 'bad');
