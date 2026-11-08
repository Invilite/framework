'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const SOURCE = path.join(ROOT, 'src');

function fail(message) {
    console.error(message);
    process.exit(1);
}

function copyRequired(fileName) {
    const sourcePath = path.join(ROOT, fileName);
    if (!fs.existsSync(sourcePath)) {
        fail(`${fileName} does not exist; the package cannot be staged without it.`);
    }
    fs.copyFileSync(sourcePath, path.join(BUILD, fileName));
}

function copyNonTsFiles(directory, relativeDirectory = '') {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
        const relativePath = path.join(relativeDirectory, entry.name);
        const sourcePath = path.join(directory, entry.name);
        const targetPath = path.join(BUILD, relativePath);
        if (entry.isDirectory()) {
            copyNonTsFiles(sourcePath, relativePath);
        } else if (entry.isFile() && !entry.name.startsWith('.') && path.extname(entry.name) !== '.ts') {
            fs.mkdirSync(path.dirname(targetPath), {recursive: true});
            fs.copyFileSync(sourcePath, targetPath);
        }
    }
}

function main() {
    if (!fs.existsSync(BUILD) || !fs.statSync(BUILD).isDirectory()) {
        fail('build/ does not exist. Run "tsc -p tsconfig.json" before staging the package.');
    }

    const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    delete packageJson.scripts;
    delete packageJson.devDependencies;
    fs.writeFileSync(path.join(BUILD, 'package.json'), JSON.stringify(packageJson, null, 2) + '\n');

    for (const fileName of ['LICENSE', 'README.md', 'CHANGELOG.md']) {
        copyRequired(fileName);
    }

    // The socket client is plain JavaScript, so tsc does not emit it; SocketRegistry loads it at runtime.
    copyNonTsFiles(SOURCE);
}

main();
