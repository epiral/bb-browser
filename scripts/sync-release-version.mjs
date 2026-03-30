import fs from 'node:fs';
import path from 'node:path';

const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: node scripts/sync-release-version.mjs <version>');
  process.exit(1);
}

const root = process.cwd();
const files = [
  path.join(root, 'package.json'),
  path.join(root, 'packages/extension/manifest.json'),
];

for (const file of files) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  data.version = version;
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`Updated ${path.relative(root, file)} -> ${version}`);
}
