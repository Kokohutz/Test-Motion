import { useCallback, useEffect, useRef } from 'react';
import { FilesetResolver, PoseLandmarker } from '@mediapipe/tasks-vision';
import type { ModelComplexity } from '../core/types';

// Vendored from node_modules by scripts/copy-wasm.mjs (gitignored)
const WASM_PATH = '/mediapipe-wasm';

/**
 * Lazily creates a PoseLandmarker for the requested model complexity and
 * caches it across calls; recreates it only when the complexity changes,
 * and closes it on unmount.
 */
export function usePoseLandmarker() {
    const landmarkerRef = useRef<PoseLandmarker | null>(null);
    const complexityRef = useRef<ModelComplexity | null>(null);

    const getLandmarker = useCallback(async (complexity: ModelComplexity): Promise<PoseLandmarker> => {
        if (landmarkerRef.current && complexityRef.current === complexity) {
            return landmarkerRef.current;
        }
        landmarkerRef.current?.close();
        landmarkerRef.current = null;

        const vision = await FilesetResolver.forVisionTasks(WASM_PATH);
        const options = {
            baseOptions: {
                modelAssetPath: `/pose_landmarker_${complexity}.task`,
                delegate: 'GPU' as const
            },
            runningMode: 'VIDEO' as const,
            numPoses: 1,
            minPoseDetectionConfidence: 0.5,
            minPosePresenceConfidence: 0.5,
            minTrackingConfidence: 0.5,
            outputSegmentationMasks: false
        };

        try {
            landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, options);
        } catch (error) {
            console.warn('GPU delegate failed, retrying with CPU:', error);
            landmarkerRef.current = await PoseLandmarker.createFromOptions(vision, {
                ...options,
                baseOptions: { ...options.baseOptions, delegate: 'CPU' as const }
            });
        }

        complexityRef.current = complexity;
        return landmarkerRef.current;
    }, []);

    useEffect(() => {
        return () => {
            landmarkerRef.current?.close();
            landmarkerRef.current = null;
        };
    }, []);

    return { getLandmarker };
}
