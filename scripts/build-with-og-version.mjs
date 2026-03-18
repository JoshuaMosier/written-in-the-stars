import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ogImagePath = resolve('static/og-image.png');

const buildVersion = process.env.PUBLIC_OG_IMAGE_VERSION ?? getOgImageVersion(ogImagePath);

console.log(`Using OG image version: ${buildVersion}`);

const result =
	process.platform === 'win32'
		? spawnSync('cmd.exe', ['/d', '/s', '/c', 'npm.cmd run build:vite'], {
				stdio: 'inherit',
				env: {
					...process.env,
					PUBLIC_OG_IMAGE_VERSION: buildVersion
				}
			})
		: spawnSync('npm', ['run', 'build:vite'], {
				stdio: 'inherit',
				env: {
					...process.env,
					PUBLIC_OG_IMAGE_VERSION: buildVersion
				}
			});

if (result.error) {
	throw result.error;
}

process.exit(result.status ?? 1);

function getOgImageVersion(filePath) {
	if (!existsSync(filePath)) {
		return 'missing-og-image';
	}

	return createHash('sha1').update(readFileSync(filePath)).digest('hex').slice(0, 12);
}
