// Run this once to turn your chosen admin password into a hash for .env
//   node hash-password.js "yourPasswordHere"
// Then copy the printed hash into ADMIN_PASSWORD_HASH in your .env file.

const bcrypt = require('bcryptjs');

const password = process.argv[2];

if (!password) {
  console.log('\nUsage: node hash-password.js "yourPasswordHere"\n');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);

console.log('\nAdd this line to your .env file:\n');
console.log('ADMIN_PASSWORD_HASH=' + hash);
console.log('');
