/**
 * Static asset checks: everything the SPA needs at runtime is served from
 * public/, and no standalone HTML pages remain (the React app is the only
 * entry point — index.html is Vite's shell). These run before the build,
 * so a broken deployment never ships.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

function listFilesRecursive(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) out.push(...listFilesRecursive(full));
        else out.push(full);
    }
    return out;
}

describe('no standalone HTML', () => {
    test('public/ contains no .html files (everything runs through the React app)', () => {
        const htmlFiles = listFilesRecursive(PUBLIC).filter((f) => f.endsWith('.html'));
        expect(htmlFiles).toEqual([]);
    });

    test('index.html is only the Vite shell (no app scripts beyond the entry)', () => {
        const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
        const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
        expect(scripts).toEqual(['/src/main.tsx']);
    });
});

describe('served assets', () => {
    test('all three pose models exist in public/', () => {
        for (const complexity of ['lite', 'full', 'heavy']) {
            const modelFile = `pose_landmarker_${complexity}.task`;
            expect(existsSync(join(PUBLIC, modelFile)), `missing model: ${modelFile}`).toBe(true);
        }
    });

    test('config.json is served from public/', () => {
        expect(existsSync(join(PUBLIC, 'config.json'))).toBe(true);
    });

    test('every sound file referenced by the game exists', () => {
        const source = readFileSync(join(ROOT, 'src', 'game', 'sounds.ts'), 'utf8');
        const sfx = [...source.matchAll(/'(\/assets\/sfx\/[^']+)'/g)].map((m) => m[1]);
        expect(sfx.length).toBeGreaterThan(0);
        for (const file of sfx) {
            expect(existsSync(join(PUBLIC, file)), `missing sound file: ${file}`).toBe(true);
        }
    });
});

describe('shipped choreographies', () => {
    for (const file of ['choreographies/maniac.json', 'choreographies/adore.json']) {
        test(`${file} parses and matches the choreography schema`, () => {
            const data = JSON.parse(readFileSync(join(PUBLIC, file), 'utf8'));
            expect(data.metadata?.name).toBeTruthy();
            expect(Array.isArray(data.poses) && data.poses.length > 0).toBe(true);
            expect(data.stats?.total_poses).toBe(data.poses.length);

            const pose = data.poses[0];
            expect(typeof pose.timestamp).toBe('number');
            expect(Array.isArray(pose.landmarks) && pose.landmarks.length > 0).toBe(true);
            expect(pose.landmarks.every((lm: object) => 'id' in lm && 'x' in lm && 'y' in lm && 'visibility' in lm)).toBe(true);
            expect(typeof pose.angles).toBe('object');
        });
    }
});
