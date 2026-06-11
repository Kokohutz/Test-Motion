/**
 * Unit tests for the pure choreography-building logic (choreo_core.js).
 * Run with: npm test  (node --test tests/)
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_ACTIVE_LANDMARKS,
    DEFAULT_ANGLE_JOINTS,
    DEFAULT_POSE_CONNECTIONS,
    BEATMAP_ANGLE_NAMES,
    VISIBILITY_THRESHOLD,
    round,
    computeAngle2D,
    serializeLandmarks,
    calculateAngles,
    buildLegacyChoreography,
    buildBeatmap,
    computeDominantJoints,
    sanitizeFileName
} from '../choreo_core.js';

/** Build a full 33-landmark array with every point visible at the origin. */
function makeRawLandmarks(overrides = {}) {
    const landmarks = Array.from({ length: 33 }, () => ({ x: 0.5, y: 0.5, z: 0, visibility: 1 }));
    for (const [id, lm] of Object.entries(overrides)) {
        landmarks[Number(id)] = { x: 0.5, y: 0.5, z: 0, visibility: 1, ...lm };
    }
    return landmarks;
}

describe('computeAngle2D', () => {
    test('right angle is 90 degrees', () => {
        const angle = computeAngle2D({ x: 1, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 1 });
        assert.ok(Math.abs(angle - 90) < 1e-3, `expected ~90, got ${angle}`);
    });

    // The 1e-8 epsilon in the denominator (kept identical to the game's
    // computeAngle) shifts extreme angles by up to ~0.01 degrees.
    test('straight line is 180 degrees', () => {
        const angle = computeAngle2D({ x: -1, y: 0 }, { x: 0, y: 0 }, { x: 1, y: 0 });
        assert.ok(Math.abs(angle - 180) < 0.05, `expected ~180, got ${angle}`);
    });

    test('collinear same-side points are 0 degrees', () => {
        const angle = computeAngle2D({ x: 1, y: 1 }, { x: 0, y: 0 }, { x: 2, y: 2 });
        assert.ok(Math.abs(angle) < 0.05, `expected ~0, got ${angle}`);
    });

    test('degenerate (zero-length) vectors do not produce NaN', () => {
        const angle = computeAngle2D({ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 0 });
        assert.ok(Number.isFinite(angle), `expected finite angle, got ${angle}`);
    });

    test('z coordinate is ignored (2D angles)', () => {
        const flat = computeAngle2D({ x: 1, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, { x: 0, y: 1, z: 0 });
        const deep = computeAngle2D({ x: 1, y: 0, z: 9 }, { x: 0, y: 0, z: -3 }, { x: 0, y: 1, z: 5 });
        assert.ok(Math.abs(flat - deep) < 1e-9);
    });
});

describe('round', () => {
    test('rounds to the requested precision', () => {
        assert.equal(round(1.23456, 2), 1.23);
        assert.equal(round(1.23556, 3), 1.236);
        assert.equal(round(-0.00049, 3), -0);
    });
});

describe('serializeLandmarks', () => {
    test('keeps only active landmarks, in order, with rounded values', () => {
        const raw = makeRawLandmarks({ 11: { x: 0.123456, y: 0.654321, z: -0.111111, visibility: 0.98765 } });
        const serialized = serializeLandmarks(raw);

        assert.equal(serialized.length, DEFAULT_ACTIVE_LANDMARKS.length);
        assert.deepEqual(serialized.map((lm) => lm.id), DEFAULT_ACTIVE_LANDMARKS);

        const shoulder = serialized.find((lm) => lm.id === 11);
        assert.deepEqual(shoulder, { id: 11, x: 0.1235, y: 0.6543, z: -0.1111, visibility: 0.9877 });
    });

    test('missing visibility defaults to fully visible', () => {
        const raw = makeRawLandmarks();
        delete raw[0].visibility;
        const serialized = serializeLandmarks(raw);
        assert.equal(serialized.find((lm) => lm.id === 0).visibility, 1);
    });

    test('skips landmarks absent from the raw array', () => {
        const raw = makeRawLandmarks();
        raw[31] = undefined;
        const serialized = serializeLandmarks(raw);
        assert.equal(serialized.find((lm) => lm.id === 31), undefined);
        assert.equal(serialized.length, DEFAULT_ACTIVE_LANDMARKS.length - 1);
    });
});

describe('calculateAngles', () => {
    test('computes every configured joint angle when all points are visible', () => {
        // T-pose-ish: distinct positions so no degenerate vectors
        const raw = makeRawLandmarks({
            11: { x: 0.4, y: 0.3 }, 12: { x: 0.6, y: 0.3 },
            13: { x: 0.3, y: 0.45 }, 14: { x: 0.7, y: 0.45 },
            15: { x: 0.25, y: 0.6 }, 16: { x: 0.75, y: 0.6 },
            23: { x: 0.45, y: 0.6 }, 24: { x: 0.55, y: 0.6 },
            25: { x: 0.44, y: 0.78 }, 26: { x: 0.56, y: 0.78 },
            27: { x: 0.43, y: 0.95 }, 28: { x: 0.57, y: 0.95 }
        });
        const angles = calculateAngles(serializeLandmarks(raw));

        assert.deepEqual(Object.keys(angles).sort(), Object.keys(DEFAULT_ANGLE_JOINTS).sort());
        for (const [name, value] of Object.entries(angles)) {
            assert.ok(Number.isFinite(value), `${name} should be a number, got ${value}`);
            assert.ok(value >= 0 && value <= 180, `${name} out of range: ${value}`);
        }
    });

    test('elbow angle matches a hand-computed value', () => {
        // left_elbow = angle at 13 between 11 and 15; construct an exact right angle
        const raw = makeRawLandmarks({
            11: { x: 0.5, y: 0.2 },
            13: { x: 0.5, y: 0.5 },
            15: { x: 0.8, y: 0.5 }
        });
        const angles = calculateAngles(serializeLandmarks(raw));
        assert.ok(Math.abs(angles.left_elbow - 90) < 0.1, `expected ~90, got ${angles.left_elbow}`);
    });

    test('angle is null when any point is below the visibility threshold', () => {
        const raw = makeRawLandmarks({ 15: { visibility: VISIBILITY_THRESHOLD - 0.01 } });
        const angles = calculateAngles(serializeLandmarks(raw));
        assert.equal(angles.left_elbow, null);
    });

    test('angle is null when a point is missing entirely', () => {
        const landmarks = serializeLandmarks(makeRawLandmarks()).filter((lm) => lm.id !== 14);
        const angles = calculateAngles(landmarks);
        assert.equal(angles.right_elbow, null);
        assert.equal(angles.right_shoulder, null);
    });
});

function makeTestPoses() {
    const landmarks = serializeLandmarks(makeRawLandmarks());
    return [
        { timestamp: 0, frame: 0, landmarks, angles: { left_elbow: 90, right_elbow: 100, left_knee: 170, right_knee: null } },
        { timestamp: 0.5, frame: 1, landmarks, angles: { left_elbow: 120, right_elbow: 101, left_knee: 170, right_knee: null } },
        { timestamp: 1, frame: 2, landmarks, angles: { left_elbow: 60, right_elbow: 99, left_knee: 171, right_knee: 90 } }
    ];
}

describe('buildLegacyChoreography', () => {
    const legacy = buildLegacyChoreography({
        name: 'test dance',
        poses: makeTestPoses(),
        failedCount: 1,
        duration: 1.5,
        targetFps: 30,
        complexity: 'full',
        resolution: [1280, 720],
        processedAt: '2026-01-01T00:00:00.000Z'
    });

    test('matches the schema clone_dance.js and visualizer.js expect', () => {
        assert.ok(legacy.metadata, 'metadata required');
        assert.ok(Array.isArray(legacy.poses), 'poses array required');
        assert.ok(legacy.stats, 'stats required');

        // visualizer.js reads these directly
        assert.equal(typeof legacy.stats.total_poses, 'number');
        assert.equal(typeof legacy.stats.duration, 'number');
        // game reads pose.timestamp / landmarks / angles
        for (const pose of legacy.poses) {
            assert.equal(typeof pose.timestamp, 'number');
            assert.ok(Array.isArray(pose.landmarks));
            assert.ok(pose.landmarks.every((lm) => 'id' in lm && 'x' in lm && 'y' in lm && 'visibility' in lm));
            assert.equal(typeof pose.angles, 'object');
        }
    });

    test('stats are consistent with the input', () => {
        assert.equal(legacy.stats.total_poses, 3);
        assert.equal(legacy.metadata.total_frames, 4); // poses + failed
        assert.equal(legacy.stats.fps_effective, 2); // 3 poses / 1.5s
        assert.equal(legacy.metadata.fps, 30);
        assert.deepEqual(legacy.metadata.resolution, [1280, 720]);
        assert.equal(legacy.metadata.processing_params.model_complexity, 'full');
    });

    test('survives a JSON round-trip unchanged', () => {
        assert.deepEqual(JSON.parse(JSON.stringify(legacy)), legacy);
    });
});

describe('buildBeatmap', () => {
    const beatmap = buildBeatmap({
        name: 'test dance',
        fileName: 'test.mp4',
        poses: makeTestPoses(),
        duration: 1.5,
        targetFps: 30
    });

    test('top-level schema (section 4) fields are present', () => {
        assert.equal(beatmap.title, 'test dance');
        assert.equal(beatmap.bpm, null);
        assert.equal(beatmap.beatOffsetMs, null);
        assert.equal(beatmap.mirrored, false);
        assert.equal(beatmap.durationMs, 1500);
        assert.ok(Array.isArray(beatmap.steps));
    });

    test('single full-routine step spans the whole video', () => {
        assert.equal(beatmap.steps.length, 1);
        const step = beatmap.steps[0];
        assert.equal(step.id, 1);
        assert.equal(step.startMs, 0);
        assert.equal(step.endMs, 1500);
        assert.equal(step.frames.length, 3);
    });

    test('frames carry millisecond timestamps and short angle names', () => {
        const step = beatmap.steps[0];
        assert.deepEqual(step.frames.map((f) => f.tMs), [0, 500, 1000]);

        const firstAngles = step.frames[0].angles;
        assert.equal(firstAngles.lElbow, 90);
        assert.equal(firstAngles.rElbow, 100);
        assert.equal(firstAngles.lKnee, 170);
        assert.equal(firstAngles.rKnee, null);
        for (const name of Object.keys(firstAngles)) {
            assert.ok(Object.values(BEATMAP_ANGLE_NAMES).includes(name), `unexpected angle name ${name}`);
        }
    });

    test('dominant joints reflect the most-moving angles', () => {
        // left_elbow moves 30 + 60 = 90 deg; right_elbow 1 + 2 = 3; left_knee 0 + 1 = 1
        assert.deepEqual(beatmap.steps[0].dominantJoints, ['lElbow', 'rElbow']);
    });
});

describe('computeDominantJoints', () => {
    test('ignores null angles and handles empty input', () => {
        assert.deepEqual(computeDominantJoints([]), []);
        const frames = [
            { angles: { lElbow: null, rElbow: 10 } },
            { angles: { lElbow: null, rElbow: 50 } }
        ];
        assert.deepEqual(computeDominantJoints(frames), ['rElbow']);
    });
});

describe('sanitizeFileName', () => {
    test('lowercases and replaces spaces/dashes with underscores', () => {
        assert.equal(sanitizeFileName('My Cool-Dance 2'), 'my_cool_dance_2');
    });

    test('strips unsafe characters and never returns empty', () => {
        assert.equal(sanitizeFileName('???!!!'), 'choreography');
        assert.equal(sanitizeFileName('día de baile'), 'da_de_baile');
    });
});

describe('default configuration tables', () => {
    test('every angle joint uses active landmarks', () => {
        for (const [name, triplet] of Object.entries(DEFAULT_ANGLE_JOINTS)) {
            assert.equal(triplet.length, 3, `${name} must have 3 points`);
            for (const id of triplet) {
                assert.ok(DEFAULT_ACTIVE_LANDMARKS.includes(id), `${name}: landmark ${id} not active`);
            }
        }
    });

    test('every pose connection uses active landmarks', () => {
        for (const [a, b] of DEFAULT_POSE_CONNECTIONS) {
            assert.ok(DEFAULT_ACTIVE_LANDMARKS.includes(a), `connection start ${a} not active`);
            assert.ok(DEFAULT_ACTIVE_LANDMARKS.includes(b), `connection end ${b} not active`);
        }
    });

    test('beatmap angle names cover all angle joints', () => {
        assert.deepEqual(Object.keys(BEATMAP_ANGLE_NAMES).sort(), Object.keys(DEFAULT_ANGLE_JOINTS).sort());
    });
});
