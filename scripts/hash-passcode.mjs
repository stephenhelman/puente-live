// Usage: pnpm hash-passcode "your passcode"  ->  prints CHAPTER_PASSCODE_HASH value
import { randomBytes, scryptSync } from "node:crypto";

const pass = process.argv[2];
if (!pass) {
  console.error('Usage: pnpm hash-passcode "your passcode"');
  process.exit(1);
}
const salt = randomBytes(16);
const hash = scryptSync(pass.normalize("NFKC"), salt, 32, { N: 16384, r: 8, p: 1 });
console.log(`scrypt:${salt.toString("hex")}:${hash.toString("hex")}`);
