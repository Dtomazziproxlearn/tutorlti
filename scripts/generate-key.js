// Prints a new RSA private key for LTI_PRIVATE_KEY, as one line with \n
// escapes so it can be pasted straight into Render's environment settings.
const { generateKeyPairSync } = require('crypto');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
console.log(pem.trim().replace(/\n/g, '\\n'));
