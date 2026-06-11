/**
 * Canvas skeleton drawing shared by the extractor preview and the
 * visualizer. Works on either raw MediaPipe landmarks (indexed 0..32)
 * or stored landmarks ({id, ...}[]) after conversion.
 */

import { VISIBILITY_THRESHOLD } from './choreography';
import type { RawLandmark, StoredLandmark } from './types';

export interface SkeletonStyle {
    color: string;
    thickness: number;
    opacity?: number;
}

/** Convert stored [{id, ...}] landmarks to an array indexed by landmark id. */
export function toIndexedLandmarks(landmarks: StoredLandmark[]): (StoredLandmark | undefined)[] {
    const indexed: (StoredLandmark | undefined)[] = new Array(33);
    for (const lm of landmarks) indexed[lm.id] = lm;
    return indexed;
}

export function drawSkeleton(
    ctx: CanvasRenderingContext2D,
    landmarks: (RawLandmark | StoredLandmark | undefined)[],
    connections: [number, number][],
    keypoints: number[],
    style: SkeletonStyle
): void {
    const { width, height } = ctx.canvas;
    const previousAlpha = ctx.globalAlpha;

    ctx.globalAlpha = style.opacity ?? 1;
    ctx.lineWidth = style.thickness;
    ctx.strokeStyle = style.color;
    ctx.fillStyle = style.color;
    ctx.lineCap = 'round';

    for (const [start, end] of connections) {
        const a = landmarks[start];
        const b = landmarks[end];
        if (!a || !b) continue;
        if ((a.visibility ?? 1) < VISIBILITY_THRESHOLD || (b.visibility ?? 1) < VISIBILITY_THRESHOLD) continue;

        ctx.beginPath();
        ctx.moveTo(a.x * width, a.y * height);
        ctx.lineTo(b.x * width, b.y * height);
        ctx.stroke();
    }

    for (const id of keypoints) {
        const lm = landmarks[id];
        if (!lm || (lm.visibility ?? 1) < VISIBILITY_THRESHOLD) continue;
        ctx.beginPath();
        ctx.arc(lm.x * width, lm.y * height, Math.max(4, style.thickness * 1.7), 0, 2 * Math.PI);
        ctx.fill();
    }

    ctx.globalAlpha = previousAlpha;
}

/** Joint landmark used as the anchor for each angle label. */
export const ANGLE_LABEL_ANCHORS: Record<string, number> = {
    left_shoulder: 11,
    right_shoulder: 12,
    left_elbow: 13,
    right_elbow: 14,
    left_knee: 25,
    right_knee: 26,
    left_hip: 23,
    right_hip: 24
};

export function drawAngleLabels(
    ctx: CanvasRenderingContext2D,
    landmarks: (StoredLandmark | undefined)[],
    angles: Record<string, number | null>
): void {
    const { width, height } = ctx.canvas;
    ctx.font = '14px monospace';
    ctx.fillStyle = '#ffd700';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 3;

    for (const [angleName, jointId] of Object.entries(ANGLE_LABEL_ANCHORS)) {
        const angle = angles[angleName];
        if (angle === null || angle === undefined) continue;

        const joint = landmarks[jointId];
        if (!joint || joint.visibility < VISIBILITY_THRESHOLD) continue;

        const x = joint.x * width + 10;
        const y = joint.y * height - 10;
        const text = `${angle.toFixed(0)}°`;
        ctx.strokeText(text, x, y);
        ctx.fillText(text, x, y);
    }
}
