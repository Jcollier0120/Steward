import type { Employee } from '../../src/settings.ts';

/**
 * A full staff for the tests: the employees the Steward came with before its defaults were emptied (Settings now name
 * yours). Only a fixture: nothing outside test/ reads it.
 */
export const STAFF: Employee[] = [
  {
    "id": "porter",
    "name": "Porter",
    "repo": "Jcollier0120/Porter",
    "checkout": "C:\\Projects\\Porter",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.porter\\app"
  },
  {
    "id": "auditor",
    "name": "Auditor",
    "repo": "Jcollier0120/Auditor",
    "checkout": "C:\\Projects\\Auditor",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.auditor\\app"
  },
  {
    "id": "clerk",
    "name": "Clerk",
    "repo": "Jcollier0120/Clerk",
    "checkout": "C:\\Projects\\Clerk",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.clerk\\app"
  },
  {
    "id": "herald",
    "name": "Herald",
    "repo": "Jcollier0120/Herald",
    "checkout": "C:\\Projects\\Herald",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.herald\\app"
  },
  {
    "id": "warrener",
    "name": "Warrener",
    "repo": "Jcollier0120/Warrener",
    "checkout": "C:\\Projects\\Warrener",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.warrener\\app"
  },
  {
    "id": "aletaster",
    "name": "Aletaster",
    "repo": "Jcollier0120/Aletaster",
    "checkout": "C:\\Projects\\Aletaster",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.aletaster\\app"
  },
  {
    "id": "miller",
    "name": "Miller",
    "repo": "Jcollier0120/Miller",
    "checkout": "C:\\Projects\\Miller",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.miller\\app"
  },
  {
    "id": "pinder",
    "name": "Pinder",
    "repo": "Jcollier0120/Pinder",
    "checkout": "C:\\Projects\\Pinder",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.pinder\\app"
  },
  {
    "id": "reeve",
    "name": "Reeve",
    "repo": "Jcollier0120/Reeve",
    "checkout": "C:\\Projects\\Reeve",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/mcp.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "node %USERPROFILE%\\.reeve\\app\\src\\cli.ts jobs approve {job} --sha256 {sha256}",
    "installed": "%USERPROFILE%\\.reeve\\app"
  },
  {
    "id": "heiward",
    "name": "Heiward",
    "repo": "Jcollier0120/Heiward",
    "checkout": "C:\\Projects\\Heiward",
    "branch": "master",
    "merges": true,
    "usesKit": true,
    "parts": [
      "spec"
    ],
    "fill": "powershell -NoProfile -File tools\\kit.ps1",
    "test": [
      "dotnet test HEI.Core.Tests"
    ],
    "versionFiles": [
      "HEI.Agent/HEI.Agent.csproj"
    ],
    "release": "powershell -NoProfile -File HEI.Agent\\release.ps1 -Publish",
    "install": "",
    "approve": "",
    "installed": ""
  },
  {
    "id": "surveyor",
    "name": "Surveyor",
    "repo": "Jcollier0120/Surveyor",
    "checkout": "C:\\Projects\\Surveyor",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.surveyor\\app"
  },
  {
    "id": "lamplighter",
    "name": "Lamplighter",
    "repo": "Jcollier0120/Lamplighter",
    "checkout": "C:\\Projects\\Lamplighter",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.lamplighter\\app"
  },
  {
    "id": "smith",
    "name": "Smith",
    "repo": "Jcollier0120/Smith",
    "checkout": "C:\\Projects\\Smith",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.smith\\app"
  },
  {
    "id": "developer-herald",
    "name": "Developer Herald",
    "repo": "Jcollier0120/DeveloperHerald",
    "checkout": "C:\\Projects\\DeveloperHerald",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.developer-herald\\app"
  },
  {
    "id": "chamberlain",
    "name": "Chamberlain",
    "repo": "Jcollier0120/Chamberlain",
    "checkout": "C:\\Projects\\Chamberlain",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.chamberlain\\app"
  },
  {
    "id": "thatcher",
    "name": "Thatcher",
    "repo": "Jcollier0120/Thatcher",
    "checkout": "C:\\Projects\\Thatcher",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.thatcher\\app"
  },
  {
    "id": "reckoner",
    "name": "Reckoner",
    "repo": "Jcollier0120/Reckoner",
    "checkout": "C:\\Projects\\Reckoner",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.reckoner\\app"
  },
  {
    "id": "weigher",
    "name": "Weigher",
    "repo": "Jcollier0120/Weigher",
    "checkout": "C:\\Projects\\Weigher",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.weigher\\app"
  },
  {
    "id": "shepherd",
    "name": "Shepherd",
    "repo": "Jcollier0120/Shepherd",
    "checkout": "C:\\Projects\\Shepherd",
    "branch": "main",
    "merges": true,
    "usesKit": true,
    "parts": [
      "node",
      "web",
      "spec"
    ],
    "fill": "node tools/kit.ts",
    "test": [
      "npx tsc -p . --noEmit",
      "npm test"
    ],
    "versionFiles": [
      "package.json",
      "package-lock.json",
      "src/app.ts"
    ],
    "release": "npm run release -- --publish",
    "install": "node src/cli.ts install",
    "approve": "",
    "installed": "%USERPROFILE%\\.shepherd\\app"
  }
];

export const STAFF_STEWARD_REPO = 'Jcollier0120/Steward';
