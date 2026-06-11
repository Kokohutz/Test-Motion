/**
 * Static wiring checks: the legacy game page (served from public/) still
 * references scripts and element ids that exist, the pose models and sound
 * assets are present, and the shipped choreographies match the schema.
 * These run before the Vite build / Docker image, so a broken page never
 * ships.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = join(__dirname, '..');
const PUBLIC = join(ROOT, 'public');

function read(file: string): string {
    return readFileSync(join(PUBLIC, file), 'utf8');
}

function localScriptSrcs(html: string): string[] {
    return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((src) => !/^https?:\/\//.test(src));
}

describe('legacy game page (public/clone_dance.html)', () => {
    const html = read('clone_dance.html');
    const js = read('clone_dance.js');

    test('every local <script src> exists in public/', () => {
        const srcs = localScriptSrcs(html);
        expect(srcs.length).toBeGreaterThan(0);
        for (const src of srcs) {
            expect(existsSync(join(PUBLIC, src.replace(/^\.\//, ''))), `missing script: ${src}`).toBe(true);
        }
    });

    test('config_loader.js loads before clone_dance.js', () => {
        const srcs = localScriptSrcs(html);
        const loaderIdx = srcs.indexOf('config_loader.js');
        const mainIdx = srcs.findIndex((s) => s.endsWith('clone_dance.js'));
        expect(loaderIdx).toBeGreaterThanOrEqual(0);
        expect(mainIdx).toBeGreaterThan(loaderIdx);
    });

    test('every element id the game looks up exists in the page', () => {
        // Ids created at runtime by the script itself, not present in HTML
        const runtimeCreated = new Set(['angleDebugOverlay']);
        const ids = [...new Set([...js.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
        expect(ids.length).toBeGreaterThan(10);

        for (const id of ids) {
            if (runtimeCreated.has(id)) continue;
            expect(html.includes(`id="${id}"`), `clone_dance.js looks up #${id} but the page has no such element`).toBe(true);
        }
    });

    test('reward sound files referenced by the game exist', () => {
        const sfx = [...js.matchAll(/'(assets\/sfx\/[^']+)'/g)].map((m) => m[1]);
        expect(sfx.length).toBeGreaterThan(0);
        for (const file of sfx) {
            expect(existsSync(join(PUBLIC, file)), `missing sound file: ${file}`).toBe(true);
        }
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
});

describe('shipped choreographies', () => {
    for (const file of ['choreographies/maniac.json', 'choreographies/adore.json']) {
        test(`${file} parses and matches the choreography schema`, () => {
            const data = JSON.parse(read(file));
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
