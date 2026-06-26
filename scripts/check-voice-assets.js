const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const singleVoiceDir = path.join(root, 'sfx', 'voice');
const multiplayerVoiceDir = path.join(root, 'multiplayer', 'public', 'sfx', 'voice');

function listMp3(dir) {
  return fs.readdirSync(dir).filter((name) => name.endsWith('.mp3')).sort();
}

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

const singleFiles = listMp3(singleVoiceDir);
const multiplayerFiles = listMp3(multiplayerVoiceDir);
const names = [...new Set([...singleFiles, ...multiplayerFiles])].sort();
const problems = [];

for (const name of names) {
  const singlePath = path.join(singleVoiceDir, name);
  const multiplayerPath = path.join(multiplayerVoiceDir, name);
  if (!fs.existsSync(singlePath)) {
    problems.push(`missing in sfx/voice: ${name}`);
    continue;
  }
  if (!fs.existsSync(multiplayerPath)) {
    problems.push(`missing in multiplayer/public/sfx/voice: ${name}`);
    continue;
  }
  if (fileHash(singlePath) !== fileHash(multiplayerPath)) {
    problems.push(`content differs: ${name}`);
  }
}

if (problems.length > 0) {
  console.error('Voice asset check failed:');
  for (const problem of problems) console.error(`- ${problem}`);
  process.exit(1);
}

console.log(`Voice asset check passed (${names.length} files).`);
