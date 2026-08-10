const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const pass = process.argv[2] || 'InfiNet00$#0$';
const hash = bcrypt.hashSync(pass, 10);
console.log('Add to .env:');
console.log('ADMIN_PASSWORD_HASH=' + hash);
console.log('SESSION_SECRET=' + crypto.randomBytes(32).toString('hex'));
