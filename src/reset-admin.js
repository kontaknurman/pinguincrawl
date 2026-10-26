/**
 * Locked out of the admin panel? Run this on the server:
 *   npm run reset-admin -- <username>
 *   docker compose exec -u pinguincrawl pinguincrawl node src/reset-admin.js <username>
 *
 * That admin gets a new temporary password (printed below), is logged out everywhere and
 * has 2FA turned off; the next login asks for a password of their own. Without a username
 * it lists the admins. Works while the app is running.
 */
const crypto = require('crypto');
const db = require('./models/database');

const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/l/I

const username = String(process.argv[2] || '').trim().toLowerCase();
const names = db.getUsers().map((u) => u.username).join(', ');
const user = username ? db.getUserByUsername(username) : null;

if (!user) {
  console.error(username ? `No admin named "${username}".` : 'Usage: node src/reset-admin.js <username>');
  console.error(`Admins: ${names}`);
  process.exitCode = 1;
} else {
  const password = Array.from({ length: 16 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join('');
  db.setUserPassword(user.id, password, { mustChange: true });
  db.setUserTotp(user.id, null);
  console.log(`Admin "${user.username}" — temporary password: ${password}`);
  console.log('Log in with it to choose a new password. 2FA is off; set it up again in Settings.');
}
db.closeDb();
