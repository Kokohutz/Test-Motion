/**
 * Pose comparison logic for the live game, ported from the legacy
 * clone_dance.js. Pure functions over landmark arrays — smoothing state is
 * passed in explicitly so everything stays deterministic and testable.
 */

import { computeAngle2D } from './choreography';
import type { AngleJointMap, AngleSet, PoseFrame, RawLandmark, StoredLandmark } from './types';

export interface Normalization {
    scaleX: number;
    scaleY: number;
    offsetX: number;
    offsetY: number;
}

export const IDENTITY_NORMALIZATION: Normalization = { scaleX: 1, scaleY: 1, offsetX: 0, offsetY: 0 };

export type IndexedLandmarks = (RawLandmark | StoredLandmark | undefined)[];

export interface AngleComparison {
    accuracy: number;
    matches: Record<string, boolean>;
    similarities: Record<string, number>;
    diffs: Record<string, number | null>;
    matchedCount: number;
    totalAngles: number;
}

export interface PositionComparison {
    accuracy: number;
    matches: Record<number, boolean | null>;
    avgDistance: number;
    matchedCount: number;
    totalJoints: number;
}

export interface AngleCompareConfig {
    angleSmoothing: number;
    matchSimilarity: number;
    similarityRange: number;
    allowedMisses: number;
}

export interface PositionCompareConfig {
    positionSmoothing: number;
    positionThreshold: number;
    scoringJoints: number[];
}

/** Mirror live landmarks: flip x, then swap left/right identities. */
export function mirrorLandmarks<T extends { x: number }>(
    landmarks: T[],
    swapPairs: [number, number][]
): T[] {
    const mirrored = landmarks.map((lm) => ({ ...lm, x: 1 - lm.x }));
    for (const [a, b] of swapPairs) {
        const tmp = mirrored[a];
        mirrored[a] = mirrored[b];
        mirrored[b] = tmp;
    }
    return mirrored;
}

export function getTorsoSize(landmarks: IndexedLandmarks, minTorsoSize: number): { width: number; height: number } {
    const leftShoulder = landmarks[11]!;
    const rightShoulder = landmarks[12]!;
    const leftHip = landmarks[23]!;
    const rightHip = landmarks[24]!;

    const width = Math.max(Math.abs(rightShoulder.x - leftShoulder.x), minTorsoSize);
    const height = Math.max(
        Math.abs((leftHip.y + rightHip.y) / 2 - (leftShoulder.y + rightShoulder.y) / 2),
        minTorsoSize
    );
    return { width, height };
}

export function getTorsoCenter(landmarks: IndexedLandmarks): { x: number; y: number } {
    const leftShoulder = landmarks[11]!;
    const rightShoulder = landmarks[12]!;
    const leftHip = landmarks[23]!;
    const rightHip = landmarks[24]!;

    return {
        x: (leftShoulder.x + rightShoulder.x + leftHip.x + rightHip.x) / 4,
        y: (leftShoulder.y + rightShoulder.y + leftHip.y + rightHip.y) / 4
    };
}

export function hasTorso(landmarks: IndexedLandmarks): boolean {
    return Boolean(landmarks[11] && landmarks[12] && landmarks[23] && landmarks[24]);
}

/**
 * Calibration result: average torso scale plus the offset that maps the
 * player's torso center onto the reference's.
 */
export function calculateNormalization(
    playerLandmarks: IndexedLandmarks,
    referenceLandmarks: IndexedLandmarks,
    minTorsoSize: number
): Normalization {
    const playerTorso = getTorsoSize(playerLandmarks, minTorsoSize);
    const refTorso = getTorsoSize(referenceLandmarks, minTorsoSize);

    const avgScale = (refTorso.width / playerTorso.width + refTorso.height / playerTorso.height) / 2;
    const playerCenter = getTorsoCenter(playerLandmarks);
    const refCenter = getTorsoCenter(referenceLandmarks);

    return {
        scaleX: avgScale,
        scaleY: avgScale,
        offsetX: refCenter.x - playerCenter.x * avgScale,
        offsetY: refCenter.y - playerCenter.y * avgScale
    };
}

export function normalizePose<T extends { x: number; y: number }>(landmarks: T[], n: Normalization): T[] {
    return landmarks.map((lm) => ({
        ...lm,
        x: lm.x * n.scaleX + n.offsetX,
        y: lm.y * n.scaleY + n.offsetY
    }));
}

/** Live joint angles from indexed landmarks (visibility-gated, 2D). */
export function calculateLiveAngles(landmarks: IndexedLandmarks, angleJoints: AngleJointMap): AngleSet {
    const angles: AngleSet = {};
    for (const [angleName, [p1, vertex, p2]] of Object.entries(angleJoints)) {
        const pt1 = landmarks[p1];
        const vtx = landmarks[vertex];
        const pt2 = landmarks[p2];

        if (!pt1 || !vtx || !pt2 ||
            (pt1.visibility ?? 1) < 0.5 || (vtx.visibility ?? 1) < 0.5 || (pt2.visibility ?? 1) < 0.5) {
            angles[angleName] = null;
            continue;
        }
        angles[angleName] = computeAngle2D(pt1, vtx, pt2);
    }
    return angles;
}

export function countDetectedAngles(angles: AngleSet | undefined, angleJoints: AngleJointMap): number {
    if (!angles) return 0;
    let detected = 0;
    for (const angleName of Object.keys(angleJoints)) {
        if (Number.isFinite(angles[angleName])) detected++;
    }
    return detected;
}

/**
 * Compare player vs reference angles. `smoothHistory` is mutated (EMA per
 * joint across calls) — pass a fresh object to reset smoothing.
 */
export function compareAngles(
    playerAngles: AngleSet,
    refAngles: AngleSet,
    smoothHistory: Record<string, number>,
    cfg: AngleCompareConfig
): AngleComparison {
    const matches: Record<string, boolean> = {};
    const similarities: Record<string, number> = {};
    const diffs: Record<string, number | null> = {};
    let count = 0;
    let matchedCount = 0;

    for (const [angleName, refAngle] of Object.entries(refAngles)) {
        if (refAngle === null || refAngle === undefined) continue;

        const playerAngle = playerAngles[angleName];
        if (playerAngle === null || playerAngle === undefined) {
            matches[angleName] = false;
            similarities[angleName] = 0;
            diffs[angleName] = null;
            count++;
            continue;
        }

        let smoothed = playerAngle;
        if (smoothHistory[angleName] !== undefined) {
            smoothed = cfg.angleSmoothing * playerAngle + (1 - cfg.angleSmoothing) * smoothHistory[angleName];
        }
        smoothHistory[angleName] = smoothed;

        const angleDiff = Math.abs(smoothed - refAngle);
        const similarity = Math.max(0, 1 - angleDiff / cfg.similarityRange);
        const isMatch = similarity >= cfg.matchSimilarity;

        matches[angleName] = isMatch;
        similarities[angleName] = similarity;
        diffs[angleName] = angleDiff;
        if (isMatch) matchedCount++;
        count++;
    }

    if (count === 0) {
        return { accuracy: 0, matches: {}, similarities: {}, diffs: {}, matchedCount: 0, totalAngles: 0 };
    }

    const effectiveTotal = Math.max(1, count - cfg.allowedMisses);
    const accuracy = Math.max(0, Math.min(1, matchedCount / effectiveTotal));
    return { accuracy, matches, similarities, diffs, matchedCount, totalAngles: count };
}

/**
 * Compare landmark positions (used for the debug skeleton coloring and,
 * when POSITION_WEIGHT > 0, for scoring). `smoothHistory` is mutated.
 */
export function comparePositions(
    playerLandmarks: IndexedLandmarks,
    refLandmarks: IndexedLandmarks,
    smoothHistory: Record<number, number>,
    cfg: PositionCompareConfig
): PositionComparison {
    const matches: Record<number, boolean | null> = {};
    let totalDistance = 0;
    let count = 0;
    let matchedCount = 0;

    for (const jointIdx of cfg.scoringJoints) {
        const playerJoint = playerLandmarks[jointIdx];
        const refJoint = refLandmarks[jointIdx];

        if (!playerJoint || !refJoint ||
            (playerJoint.visibility ?? 1) < 0.5 || (refJoint.visibility ?? 1) < 0.5) {
            matches[jointIdx] = null;
            continue;
        }

        let distance = Math.hypot(
            playerJoint.x - refJoint.x,
            playerJoint.y - refJoint.y,
            (playerJoint.z ?? 0) - (refJoint.z ?? 0)
        );

        if (smoothHistory[jointIdx] !== undefined) {
            distance = cfg.positionSmoothing * distance + (1 - cfg.positionSmoothing) * smoothHistory[jointIdx];
        }
        smoothHistory[jointIdx] = distance;

        totalDistance += distance;
        count++;

        const isMatch = distance < cfg.positionThreshold;
        matches[jointIdx] = isMatch;
        if (isMatch) matchedCount++;
    }

    return {
        accuracy: count > 0 ? matchedCount / count : 0,
        matches,
        avgDistance: count > 0 ? totalDistance / count : 1,
        matchedCount,
        totalJoints: count
    };
}

/** Closest reference pose to `time`, or null beyond the tolerance. */
export function getReferencePoseAtTime(
    poses: PoseFrame[],
    time: number,
    toleranceSec: number
): PoseFrame | null {
    if (!poses || poses.length === 0) return null;

    let closest = poses[0];
    let minDiff = Math.abs(time - closest.timestamp);
    for (const pose of poses) {
        const diff = Math.abs(time - pose.timestamp);
        if (diff < minDiff) {
            minDiff = diff;
            closest = pose;
        }
    }
    return minDiff > toleranceSec ? null : closest;
}

/** Reference poses inside [time-window, time+window], via binary search. */
export function getReferencePosesInWindow(poses: PoseFrame[], time: number, windowSize: number): PoseFrame[] {
    if (!poses || poses.length === 0) return [];

    const windowStart = time - windowSize;
    const windowEnd = time + windowSize;

    let left = 0;
    let right = poses.length - 1;
    let startIdx = poses.length;
    while (left <= right) {
        const mid = Math.floor((left + right) / 2);
        if (poses[mid].timestamp >= windowStart) {
            startIdx = mid;
            right = mid - 1;
        } else {
            left = mid + 1;
        }
    }

    const result: PoseFrame[] = [];
    for (let i = startIdx; i < poses.length; i++) {
        if (poses[i].timestamp > windowEnd) break;
        result.push(poses[i]);
    }
    return result;
}

export interface QuickCompareConfig {
    activeLandmarks: number[];
    angleJoints: AngleJointMap;
    positionThreshold: number;
    angleThreshold: number;
    positionWeight: number;
    angleWeight: number;
}

/** Fast smoothing-free score used to pick the best pose inside a window. */
export function quickCompareScore(
    normalizedPlayer: IndexedLandmarks,
    refPose: PoseFrame,
    refIndexed: IndexedLandmarks,
    playerAngles: AngleSet,
    cfg: QuickCompareConfig
): number {
    let posMatches = 0;
    let posCount = 0;
    const thresholdSq = cfg.positionThreshold * cfg.positionThreshold;

    for (const idx of cfg.activeLandmarks) {
        const player = normalizedPlayer[idx];
        const ref = refIndexed[idx];
        if (!player || !ref || (player.visibility ?? 1) < 0.5 || (ref.visibility ?? 1) < 0.5) continue;

        const dx = player.x - ref.x;
        const dy = player.y - ref.y;
        if (dx * dx + dy * dy < thresholdSq) posMatches++;
        posCount++;
    }

    if (posCount === 0) return 0;
    const positionScore = posMatches / posCount;
    if (cfg.angleWeight === 0) return positionScore;

    let angleMatches = 0;
    let angleCount = 0;
    const refAngles = refPose.angles || {};
    for (const angleName of Object.keys(cfg.angleJoints)) {
        const playerAngle = playerAngles[angleName];
        const refAngle = refAngles[angleName];
        if (playerAngle != null && refAngle != null) {
            if (Math.abs(playerAngle - refAngle) < cfg.angleThreshold) angleMatches++;
            angleCount++;
        }
    }
    const angleScore = angleCount > 0 ? angleMatches / angleCount : 0;

    return (cfg.positionWeight * positionScore + cfg.angleWeight * angleScore) /
        (cfg.positionWeight + cfg.angleWeight);
}

/**
 * Pick the reference pose the player matches best inside the time window
 * (timing forgiveness), falling back to the time-closest pose.
 */
export function pickBestReferencePose(
    poses: PoseFrame[],
    time: number,
    windowSize: number,
    toleranceSec: number,
    normalizedPlayer: IndexedLandmarks | null,
    playerAngles: AngleSet | null,
    cfg: QuickCompareConfig,
    toIndexed: (pose: PoseFrame) => IndexedLandmarks
): PoseFrame | null {
    if (!normalizedPlayer || !playerAngles) {
        return getReferencePoseAtTime(poses, time, toleranceSec);
    }

    const candidates = getReferencePosesInWindow(poses, time, windowSize);
    if (candidates.length === 0) return getReferencePoseAtTime(poses, time, toleranceSec);
    if (candidates.length === 1) return candidates[0];

    let bestPose: PoseFrame | null = null;
    let bestScore = -1;
    for (const refPose of candidates) {
        if (!refPose.landmarks || refPose.landmarks.length === 0) continue;
        const score = quickCompareScore(normalizedPlayer, refPose, toIndexed(refPose), playerAngles, cfg);
        if (score > bestScore) {
            bestScore = score;
            bestPose = refPose;
            if (bestScore >= 0.95) break; // early exit
        }
    }
    return bestPose || candidates[0];
}
