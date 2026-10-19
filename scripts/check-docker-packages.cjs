'use strict';
// Verify every package in the Dockerfile's apt-get line exists in the Debian
// suite the image uses. A wrong name costs a full 10-minute build.
//
// Usage: node scripts/check-docker-packages.cjs [Packages.gz] [Dockerfile] [suite]
// The Packages.gz is the suite index from
//   http://deb.debian.org/debian/dists/<suite>/main/binary-amd64/Packages.gz
const fs = require('node:fs');
const zlib = require('node:zlib');
const path = require('node:path');

const indexPath = process.argv[2] || path.join(process.env.TEMP || '.', 'Packages.gz');
const dockerfilePath = process.argv[3] || 'Dockerfile';
const suite = process.argv[4] || 'bookworm';

const index = zlib.gunzipSync(fs.readFileSync(indexPath)).toString('utf8');
const available = new Set(
    index.split('\n').filter(line => line.startsWith('Package: ')).map(line => line.slice(9).trim())
);

const packages = fs.readFileSync(dockerfilePath, 'utf8')
    .split('\n')
    .map(line => line.trim().replace(/\\$/, '').trim())
    .filter(line => /^[a-z0-9][a-z0-9.+-]*$/.test(line));

const missing = packages.filter(name => !available.has(name));
const ffmpeg = packages.filter(name => /^(libav|libsw|libpost)/.test(name));
process.stdout.write(
    `suite ${suite}: ${packages.length} paquetes verificados, ` +
    `${missing.length} inexistentes` +
    (missing.length ? `: ${missing.join(', ')}` : ' ✅') +
    `\nffmpeg: ${ffmpeg.join(', ') || '(ninguno)'}\n`
);
process.exit(missing.length ? 1 : 0);
