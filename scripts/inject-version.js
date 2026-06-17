const fs = require('fs');
const path = require('path');

// Read package.json to get the version
const packageJsonPath = path.join(__dirname, '..', 'package.json');
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
const version = packageJson.version;

console.log(`Injecting version ${version} from package.json into app.version.ts`);

// Generate app.version.ts
const versionFilePath = path.join(__dirname, '..', 'src', 'app', 'app.version.ts');
const versionContent = `// This file is auto-generated from package.json version during build
// Do not edit manually
export const APP_VERSION = '${version}';
`;
fs.writeFileSync(versionFilePath, versionContent);

console.log('Version injection complete');
