/**
 * Validates config.json — the single source of truth shared by the game,
 * the visualizer and the extractor. Catches typos and broken references
 * before the site is built/served.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_ACTIVE_LANDMARKS, DEFAULT_ANGLE_JOINTS } from '../choreo_core.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(join(ROOT, 'config.json'), 'utf8'));

const DIFFICULTY_KEYS = ['easy', 'medium', 'expert'];
const REQUIRED_PRESET_KEYS = [
    'SCORE_ACCURACY_THRESHOLD',
    'SCORE_POINTS_PER_SECOND',
    'COMBO_SECONDS',
    'MAX_COMBO',
    'PERFORMANCE_FEEDBACK_INTERVAL_SEC',
    'PERFORMANCE_FEEDBACK_THRESHOLD_GOOD',
    'PERFORMANCE_FEEDBACK_THRESHOLD_GREAT',
    'PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT'
];

describe('config.json structure', () => {
    test('has the three required sections', () => {
        for (const section of ['common', 'game', 'visualizer']) {
            assert.equal(typeof config[section], 'object', `missing section: ${section}`);
        }
    });

    test('common landmark groups are consistent', () => {
        const { common } = config;
        assert.ok(Array.isArray(common.ACTIVE_LANDMARKS) && common.ACTIVE_LANDMARKS.length > 0);

        for (const group of ['HEAD_LANDMARKS', 'ARM_LANDMARKS', 'LEG_LANDMARKS']) {
            for (const id of common[group]) {
                assert.ok(common.ACTIVE_LANDMARKS.includes(id), `${group} landmark ${id} not in ACTIVE_LANDMARKS`);
            }
        }

        for (const id of common.ACTIVE_LANDMARKS) {
            assert.ok(Number.isInteger(id) && id >= 0 && id <= 32, `invalid landmark id ${id}`);
        }
    });

    test('ANGLE_JOINTS are valid triplets of active landmarks', () => {
        const { common } = config;
        for (const [name, triplet] of Object.entries(common.ANGLE_JOINTS)) {
            assert.ok(Array.isArray(triplet) && triplet.length === 3, `${name} must be [p1, vertex, p2]`);
            for (const id of triplet) {
                assert.ok(common.ACTIVE_LANDMARKS.includes(id), `${name}: landmark ${id} not in ACTIVE_LANDMARKS`);
            }
        }
    });

    test('KEYPOINTS_MIRROR_SWAP pairs are distinct active landmarks', () => {
        const { common } = config;
        for (const pair of common.KEYPOINTS_MIRROR_SWAP) {
            assert.equal(pair.length, 2);
            const [a, b] = pair;
            assert.notEqual(a, b, 'mirror pair must swap two different landmarks');
            assert.ok(common.ACTIVE_LANDMARKS.includes(a) && common.ACTIVE_LANDMARKS.includes(b));
        }
    });

    test('confidence thresholds are within 0..1', () => {
        const { common } = config;
        for (const key of ['MIN_DETECTION_CONFIDENCE', 'MIN_TRACKING_CONFIDENCE', 'MIN_PRESENCE_CONFIDENCE']) {
            assert.ok(common[key] > 0 && common[key] <= 1, `${key} out of range: ${common[key]}`);
        }
    });

    test('choreo_core.js fallbacks stay in sync with config.json', () => {
        assert.deepEqual(DEFAULT_ACTIVE_LANDMARKS, config.common.ACTIVE_LANDMARKS,
            'DEFAULT_ACTIVE_LANDMARKS drifted from config.json');
        assert.deepEqual(DEFAULT_ANGLE_JOINTS, config.common.ANGLE_JOINTS,
            'DEFAULT_ANGLE_JOINTS drifted from config.json');
    });
});

describe('config.json game section', () => {
    const { game } = config;

    test('scoring weights are usable', () => {
        assert.ok(game.POSITION_WEIGHT >= 0);
        assert.ok(game.ANGLE_WEIGHT >= 0);
        assert.ok(game.POSITION_WEIGHT + game.ANGLE_WEIGHT > 0, 'at least one scoring weight must be positive');
    });

    test('default difficulty exists in the presets', () => {
        assert.ok(DIFFICULTY_KEYS.includes(game.DEFAULT_DIFFICULTY), `unknown DEFAULT_DIFFICULTY ${game.DEFAULT_DIFFICULTY}`);
        for (const key of DIFFICULTY_KEYS) {
            assert.equal(typeof game.DIFFICULTY_PRESETS[key], 'object', `missing difficulty preset: ${key}`);
        }
    });

    test('each difficulty preset has the keys the game reads', () => {
        for (const key of DIFFICULTY_KEYS) {
            const preset = game.DIFFICULTY_PRESETS[key];
            for (const requiredKey of REQUIRED_PRESET_KEYS) {
                assert.ok(requiredKey in preset, `${key} preset missing ${requiredKey}`);
                assert.ok(Number.isFinite(preset[requiredKey]), `${key}.${requiredKey} must be a number`);
            }
        }
    });

    test('feedback tier thresholds are ordered good <= great <= perfect', () => {
        for (const key of DIFFICULTY_KEYS) {
            const p = game.DIFFICULTY_PRESETS[key];
            assert.ok(p.PERFORMANCE_FEEDBACK_THRESHOLD_GOOD <= p.PERFORMANCE_FEEDBACK_THRESHOLD_GREAT, `${key}: good > great`);
            assert.ok(p.PERFORMANCE_FEEDBACK_THRESHOLD_GREAT <= p.PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT, `${key}: great > perfect`);
        }
    });

    test('pose connections reference valid landmark ids', () => {
        for (const [a, b] of game.POSE_CONNECTIONS) {
            for (const id of [a, b]) {
                assert.ok(Number.isInteger(id) && id >= 0 && id <= 32, `invalid landmark id ${id} in POSE_CONNECTIONS`);
            }
        }
    });
});

describe('config.json visualizer section', () => {
    const { visualizer } = config;

    test('keypoints and connections are valid', () => {
        for (const id of visualizer.KEYPOINTS) {
            assert.ok(Number.isInteger(id) && id >= 0 && id <= 32, `invalid keypoint ${id}`);
        }
        for (const [a, b] of visualizer.POSE_CONNECTIONS) {
            for (const id of [a, b]) {
                assert.ok(Number.isInteger(id) && id >= 0 && id <= 32, `invalid connection landmark ${id}`);
            }
        }
    });

    test('opacity and thickness are sane', () => {
        assert.ok(visualizer.SKELETON_OPACITY > 0 && visualizer.SKELETON_OPACITY <= 1);
        assert.ok(visualizer.LINE_THICKNESS > 0);
    });
});
