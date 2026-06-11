/**
 * Unit tests for game config resolution (src/core/gameConfig.ts).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { validateAppConfig } from '../src/core/config';
import {
    DIFFICULTY_KEYS,
    getDifficultyPresets,
    resolveDifficultyKey,
    resolveGameConfig
} from '../src/core/gameConfig';

const appConfig = validateAppConfig(
    JSON.parse(readFileSync(join(__dirname, '..', 'public', 'config.json'), 'utf8'))
);

describe('resolveDifficultyKey', () => {
    test('normalizes and falls back', () => {
        expect(resolveDifficultyKey(' EXPERT ')).toBe('expert');
        expect(resolveDifficultyKey('nope')).toBe('medium');
        expect(resolveDifficultyKey(undefined, 'easy')).toBe('easy');
    });
});

describe('resolveGameConfig', () => {
    test('works with a null config (built-in defaults)', () => {
        const cfg = resolveGameConfig(null, 'medium');
        expect(cfg.angleWeight).toBeGreaterThan(0);
        expect(cfg.maxCombo).toBeGreaterThan(0);
        expect(cfg.modelComplexity).toBe('full');
        expect(Object.keys(cfg.angleJoints).length).toBeGreaterThan(0);
    });

    test('difficulty presets change the scoring parameters', () => {
        const easy = resolveGameConfig(appConfig, 'easy');
        const expert = resolveGameConfig(appConfig, 'expert');
        expect(easy.accuracyThreshold).toBeLessThan(expert.accuracyThreshold);
        expect(easy.pointsPerSecond).toBeLessThan(expert.pointsPerSecond);
    });

    test('preset overrides win over the preset', () => {
        const cfg = resolveGameConfig(appConfig, 'medium', { SCORE_ACCURACY_THRESHOLD: 0.99, MAX_COMBO: 12 });
        expect(cfg.accuracyThreshold).toBe(0.99);
        expect(cfg.maxCombo).toBe(12);
    });

    test('maps MEDIAPIPE_MODEL_COMPLEXITY index to a model name', () => {
        const cfg = resolveGameConfig(appConfig, 'medium');
        expect(['lite', 'full', 'heavy']).toContain(cfg.modelComplexity);
    });

    test('landmark tables come from config.json', () => {
        const cfg = resolveGameConfig(appConfig, 'medium');
        expect(cfg.activeLandmarks).toEqual(appConfig.common.ACTIVE_LANDMARKS);
        expect(cfg.angleJoints).toEqual(appConfig.common.ANGLE_JOINTS);
        expect(cfg.keypointsMirrorSwap).toEqual(appConfig.common.KEYPOINTS_MIRROR_SWAP);
    });

    test('every difficulty resolves with sane ranges', () => {
        for (const key of DIFFICULTY_KEYS) {
            const cfg = resolveGameConfig(appConfig, key);
            expect(cfg.accuracyThreshold).toBeGreaterThan(0);
            expect(cfg.accuracyThreshold).toBeLessThanOrEqual(1);
            expect(cfg.comboSeconds).toBeGreaterThan(0);
            expect(cfg.calibrationFrames).toBeGreaterThan(0);
        }
    });

    test('presets merge config.json over fallbacks', () => {
        const presets = getDifficultyPresets(appConfig);
        for (const key of DIFFICULTY_KEYS) {
            expect(presets[key].SCORE_ACCURACY_THRESHOLD).toBe(
                (appConfig.game.DIFFICULTY_PRESETS as Record<string, Record<string, number>>)[key].SCORE_ACCURACY_THRESHOLD
            );
        }
    });
});
