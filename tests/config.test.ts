/**
 * Validates public/config.json — the single source of truth shared by the
 * React app and the legacy game page. Catches typos and broken references
 * before the site is built.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';

import { DEFAULT_ACTIVE_LANDMARKS, DEFAULT_ANGLE_JOINTS } from '../src/core/choreography';
import { validateAppConfig } from '../src/core/config';

const ROOT = join(__dirname, '..');
const config = validateAppConfig(JSON.parse(readFileSync(join(ROOT, 'public', 'config.json'), 'utf8')));

const DIFFICULTY_KEYS = ['easy', 'medium', 'expert'] as const;
const REQUIRED_PRESET_KEYS = [
    'SCORE_ACCURACY_THRESHOLD',
    'SCORE_POINTS_PER_SECOND',
    'COMBO_SECONDS',
    'MAX_COMBO',
    'PERFORMANCE_FEEDBACK_INTERVAL_SEC',
    'PERFORMANCE_FEEDBACK_THRESHOLD_GOOD',
    'PERFORMANCE_FEEDBACK_THRESHOLD_GREAT',
    'PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT'
] as const;

type Presets = Record<string, Record<string, number>>;

describe('validateAppConfig', () => {
    test('rejects non-objects and missing sections', () => {
        expect(() => validateAppConfig(null)).toThrow();
        expect(() => validateAppConfig([])).toThrow(); // arrays are objects, but fail the section check
        expect(() => validateAppConfig({})).toThrow(/common/);
        expect(() => validateAppConfig({ common: {}, game: {} })).toThrow(/visualizer/);
    });

    test('accepts the shipped config', () => {
        expect(config.common).toBeTruthy();
        expect(config.game).toBeTruthy();
        expect(config.visualizer).toBeTruthy();
    });
});

describe('config.json common section', () => {
    test('landmark groups are consistent', () => {
        const { common } = config;
        expect(common.ACTIVE_LANDMARKS.length).toBeGreaterThan(0);

        for (const group of ['HEAD_LANDMARKS', 'ARM_LANDMARKS', 'LEG_LANDMARKS'] as const) {
            for (const id of common[group] as number[]) {
                expect(common.ACTIVE_LANDMARKS, `${group} landmark ${id} not in ACTIVE_LANDMARKS`).toContain(id);
            }
        }

        for (const id of common.ACTIVE_LANDMARKS) {
            expect(Number.isInteger(id) && id >= 0 && id <= 32, `invalid landmark id ${id}`).toBe(true);
        }
    });

    test('ANGLE_JOINTS are valid triplets of active landmarks', () => {
        const { common } = config;
        for (const [name, triplet] of Object.entries(common.ANGLE_JOINTS)) {
            expect(triplet, `${name} must be [p1, vertex, p2]`).toHaveLength(3);
            for (const id of triplet) {
                expect(common.ACTIVE_LANDMARKS, `${name}: landmark ${id} not in ACTIVE_LANDMARKS`).toContain(id);
            }
        }
    });

    test('KEYPOINTS_MIRROR_SWAP pairs are distinct active landmarks', () => {
        const { common } = config;
        for (const pair of common.KEYPOINTS_MIRROR_SWAP) {
            expect(pair).toHaveLength(2);
            const [a, b] = pair;
            expect(a).not.toBe(b);
            expect(common.ACTIVE_LANDMARKS).toContain(a);
            expect(common.ACTIVE_LANDMARKS).toContain(b);
        }
    });

    test('confidence thresholds are within 0..1', () => {
        const { common } = config;
        for (const key of ['MIN_DETECTION_CONFIDENCE', 'MIN_TRACKING_CONFIDENCE', 'MIN_PRESENCE_CONFIDENCE']) {
            const value = common[key] as number;
            expect(value, `${key} out of range`).toBeGreaterThan(0);
            expect(value, `${key} out of range`).toBeLessThanOrEqual(1);
        }
    });

    test('src/core fallbacks stay in sync with config.json', () => {
        expect(DEFAULT_ACTIVE_LANDMARKS).toEqual(config.common.ACTIVE_LANDMARKS);
        expect(DEFAULT_ANGLE_JOINTS).toEqual(config.common.ANGLE_JOINTS);
    });
});

describe('config.json game section', () => {
    const game = config.game;

    test('scoring weights are usable', () => {
        const positionWeight = game.POSITION_WEIGHT as number;
        const angleWeight = game.ANGLE_WEIGHT as number;
        expect(positionWeight).toBeGreaterThanOrEqual(0);
        expect(angleWeight).toBeGreaterThanOrEqual(0);
        expect(positionWeight + angleWeight).toBeGreaterThan(0);
    });

    test('default difficulty exists in the presets', () => {
        const presets = game.DIFFICULTY_PRESETS as Presets;
        expect(DIFFICULTY_KEYS).toContain(game.DEFAULT_DIFFICULTY as string);
        for (const key of DIFFICULTY_KEYS) {
            expect(presets[key], `missing difficulty preset: ${key}`).toBeTypeOf('object');
        }
    });

    test('each difficulty preset has the keys the game reads', () => {
        const presets = game.DIFFICULTY_PRESETS as Presets;
        for (const key of DIFFICULTY_KEYS) {
            for (const requiredKey of REQUIRED_PRESET_KEYS) {
                expect(presets[key], `${key} preset missing ${requiredKey}`).toHaveProperty(requiredKey);
                expect(Number.isFinite(presets[key][requiredKey]), `${key}.${requiredKey} must be a number`).toBe(true);
            }
        }
    });

    test('feedback tier thresholds are ordered good <= great <= perfect', () => {
        const presets = game.DIFFICULTY_PRESETS as Presets;
        for (const key of DIFFICULTY_KEYS) {
            const p = presets[key];
            expect(p.PERFORMANCE_FEEDBACK_THRESHOLD_GOOD).toBeLessThanOrEqual(p.PERFORMANCE_FEEDBACK_THRESHOLD_GREAT);
            expect(p.PERFORMANCE_FEEDBACK_THRESHOLD_GREAT).toBeLessThanOrEqual(p.PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT);
        }
    });

    test('pose connections reference valid landmark ids', () => {
        for (const [a, b] of game.POSE_CONNECTIONS) {
            for (const id of [a, b]) {
                expect(Number.isInteger(id) && id >= 0 && id <= 32, `invalid landmark id ${id}`).toBe(true);
            }
        }
    });
});

describe('config.json visualizer section', () => {
    const { visualizer } = config;

    test('keypoints and connections are valid', () => {
        for (const id of visualizer.KEYPOINTS) {
            expect(Number.isInteger(id) && id >= 0 && id <= 32, `invalid keypoint ${id}`).toBe(true);
        }
        for (const [a, b] of visualizer.POSE_CONNECTIONS) {
            for (const id of [a, b]) {
                expect(Number.isInteger(id) && id >= 0 && id <= 32, `invalid connection landmark ${id}`).toBe(true);
            }
        }
    });

    test('opacity and thickness are sane', () => {
        expect(visualizer.SKELETON_OPACITY).toBeGreaterThan(0);
        expect(visualizer.SKELETON_OPACITY).toBeLessThanOrEqual(1);
        expect(visualizer.LINE_THICKNESS).toBeGreaterThan(0);
    });
});
