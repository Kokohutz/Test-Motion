/**
 * Static wiring checks for the site: every page references scripts that
 * exist, every element id the JavaScript looks up exists in its page, and
 * the pose model files the extractor loads are present. These run before
 * the Docker/nginx image is built so a broken page never ships.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = {
    'clone_dance.html': ['clone_dance.js'],
    'visualizer.html': ['visualizer.js'],
    'extractor.html': ['extractor.js']
};

function read(file) {
    return readFileSync(join(ROOT, file), 'utf8');
}

function localScriptSrcs(html) {
    return [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
        .map((m) => m[1])
        .filter((src) => !/^https?:\/\//.test(src));
}

function idsLookedUpBy(jsFile) {
    const source = read(jsFile);
    return [...new Set([...source.matchAll(/getElementById\('([^']+)'\)/g)].map((m) => m[1]))];
}

describe('script references', () => {
    for (const page of Object.keys(PAGES)) {
        test(`${page}: every local <script src> exists on disk`, () => {
            for (const src of localScriptSrcs(read(page))) {
                const cleanPath = src.replace(/^\.\//, '');
                assert.ok(existsSync(join(ROOT, cleanPath)), `${page} references missing script: ${src}`);
            }
        });
    }

    test('every page loads config_loader.js before its main script', () => {
        for (const [page, mainScripts] of Object.entries(PAGES)) {
            const srcs = localScriptSrcs(read(page));
            const loaderIdx = srcs.indexOf('config_loader.js');
            assert.notEqual(loaderIdx, -1, `${page} must load config_loader.js`);
            for (const main of mainScripts) {
                const mainIdx = srcs.findIndex((s) => s.endsWith(main));
                assert.ok(mainIdx > loaderIdx, `${page}: config_loader.js must come before ${main}`);
            }
        }
    });
});

describe('element id wiring', () => {
    for (const [page, scripts] of Object.entries(PAGES)) {
        for (const script of scripts) {
            test(`${page}: every id ${script} looks up exists`, () => {
                const html = read(page);
                // Ids created at runtime by the script itself, not present in HTML
                const runtimeCreated = new Set(['angleDebugOverlay']);

                for (const id of idsLookedUpBy(script)) {
                    if (runtimeCreated.has(id)) continue;
                    assert.ok(
                        html.includes(`id="${id}"`),
                        `${script} looks up #${id} but ${page} has no element with that id`
                    );
                }
            });
        }
    }

    test('extractor.html: every id used by the extractor els table exists', () => {
        const source = read('extractor.js');
        const html = read('extractor.html');
        // extractor.js builds its element table from a literal id list
        const listMatch = source.match(/for \(const id of \[([\s\S]*?)\]\)/);
        assert.ok(listMatch, 'could not find the els id list in extractor.js');

        const ids = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
        assert.ok(ids.length >= 10, `suspiciously few ids parsed (${ids.length})`);
        for (const id of ids) {
            assert.ok(html.includes(`id="${id}"`), `extractor.html missing element #${id}`);
        }
    });
});

describe('extractor assets', () => {
    test('all selectable pose models exist on disk', () => {
        const html = read('extractor.html');
        const options = [...html.matchAll(/<option value="(lite|full|heavy)"/g)].map((m) => m[1]);
        assert.ok(options.length === 3, 'expected lite/full/heavy model options');
        for (const complexity of options) {
            const modelFile = `pose_landmarker_${complexity}.task`;
            assert.ok(existsSync(join(ROOT, modelFile)), `missing model file: ${modelFile}`);
        }
    });

    test('reward sound files referenced by the game exist', () => {
        const source = read('clone_dance.js');
        const sfx = [...source.matchAll(/'(assets\/sfx\/[^']+)'/g)].map((m) => m[1]);
        assert.ok(sfx.length > 0, 'expected sfx references in clone_dance.js');
        for (const file of sfx) {
            assert.ok(existsSync(join(ROOT, file)), `missing sound file: ${file}`);
        }
    });

    test('extractor.js only imports modules that exist (besides the CDN)', () => {
        const source = read('extractor.js');
        const imports = [...source.matchAll(/from '([^']+)'/g)].map((m) => m[1]);
        for (const spec of imports) {
            if (/^https?:\/\//.test(spec)) continue;
            assert.ok(existsSync(join(ROOT, spec.replace(/^\.\//, ''))), `missing module: ${spec}`);
        }
    });
});

describe('shipped choreographies', () => {
    for (const file of ['choreographies/maniac.json', 'choreographies/adore.json']) {
        test(`${file} parses and matches the choreography schema`, () => {
            const data = JSON.parse(read(file));
            assert.ok(data.metadata && data.metadata.name, 'metadata.name required');
            assert.ok(Array.isArray(data.poses) && data.poses.length > 0, 'non-empty poses required');
            assert.ok(data.stats && data.stats.total_poses === data.poses.length, 'stats.total_poses must match');

            const pose = data.poses[0];
            assert.equal(typeof pose.timestamp, 'number');
            assert.ok(Array.isArray(pose.landmarks) && pose.landmarks.length > 0);
            assert.ok(pose.landmarks.every((lm) => 'id' in lm && 'x' in lm && 'y' in lm && 'visibility' in lm));
            assert.equal(typeof pose.angles, 'object');
        });
    }
});
