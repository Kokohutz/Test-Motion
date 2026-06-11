import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import {
    DIFFICULTY_KEYS,
    DIFFICULTY_LABELS,
    getDifficultyPresets,
    resolveDifficultyKey,
    resolveGameConfig
} from '../core/gameConfig';
import type { DifficultyKey, DifficultyPreset } from '../core/gameConfig';
import type { LegacyChoreography } from '../core/types';
import { GameEngine } from '../game/engine';
import type { GameSnapshot } from '../game/engine';
import { useAppConfig } from '../hooks/useAppConfig';
import { usePoseLandmarker } from '../hooks/usePoseLandmarker';
import './game.css';

type TuningField = {
    key: keyof DifficultyPreset;
    label: string;
    min: number;
    max: number;
    step: number;
    integer?: boolean;
};

const TUNING_FIELDS: TuningField[] = [
    { key: 'SCORE_ACCURACY_THRESHOLD', label: 'Accuracy Threshold', min: 0, max: 1, step: 0.01 },
    { key: 'SCORE_POINTS_PER_SECOND', label: 'Score Points / Sec', min: 0, max: 1000, step: 1, integer: true },
    { key: 'COMBO_SECONDS', label: 'Combo Seconds', min: 0.1, max: 10, step: 0.05 },
    { key: 'MAX_COMBO', label: 'Max Combo', min: 1, max: 20, step: 1, integer: true },
    { key: 'PERFORMANCE_FEEDBACK_INTERVAL_SEC', label: 'Feedback Interval (s)', min: 0, max: 5, step: 0.05 },
    { key: 'PERFORMANCE_FEEDBACK_THRESHOLD_GOOD', label: 'GOOD Threshold', min: 0, max: 1, step: 0.01 },
    { key: 'PERFORMANCE_FEEDBACK_THRESHOLD_GREAT', label: 'GREAT Threshold', min: 0, max: 1, step: 0.01 },
    { key: 'PERFORMANCE_FEEDBACK_THRESHOLD_PERFECT', label: 'PERFECT Threshold', min: 0, max: 1, step: 0.01 },
    { key: 'VISUAL_FEEDBACK_SCALE', label: 'Feedback Scale', min: 0.6, max: 1.8, step: 0.01 },
    { key: 'VISUAL_FEEDBACK_ANIMATION_SEC', label: 'Feedback Anim (s)', min: 0.2, max: 2, step: 0.01 },
    { key: 'VISUAL_COMBO_PULSE_SCALE', label: 'Combo Pulse Scale', min: 1, max: 1.6, step: 0.01 }
];

const EMPTY_SNAPSHOT: GameSnapshot = {
    phase: 'calibration',
    hud: { score: 0, combos: 0, accuracyPct: 0, warning: '' },
    combo: { value: 0, visible: false },
    feedback: null,
    countdownValue: null,
    calibration: { progressPct: 0, status: 'Detecting pose...', currentTimeSec: 0, durationSec: 0 },
    stats: null,
    debug: null,
    needsUserPlay: false
};

export default function GamePage() {
    const { config } = useAppConfig();
    const { getLandmarker } = usePoseLandmarker();

    // Setup form state
    const [videoFile, setVideoFile] = useState<File | null>(null);
    const [jsonFile, setJsonFile] = useState<File | null>(null);
    const [inputMode, setInputMode] = useState<'webcam' | 'video'>('webcam');
    const [playerVideoFile, setPlayerVideoFile] = useState<File | null>(null);
    const [difficulty, setDifficulty] = useState<DifficultyKey>('medium');
    const [difficultyTouched, setDifficultyTouched] = useState(false);
    const [tuning, setTuning] = useState<Record<DifficultyKey, Partial<DifficultyPreset>>>({
        easy: {}, medium: {}, expert: {}
    });
    const [mirror, setMirror] = useState<boolean | null>(null);
    const [effectsEnabled, setEffectsEnabled] = useState<boolean | null>(null);
    const [debugEnabled, setDebugEnabled] = useState(false);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    // Game state
    const [isRunning, setIsRunning] = useState(false);
    const [snapshot, setSnapshot] = useState<GameSnapshot>(EMPTY_SNAPSHOT);
    const [controlsVisible, setControlsVisible] = useState(true);

    const engineRef = useRef<GameEngine | null>(null);
    const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const containerRef = useRef<HTMLDivElement>(null);
    const referenceVideoRef = useRef<HTMLVideoElement>(null);
    const gameCanvasRef = useRef<HTMLCanvasElement>(null);
    const effectsCanvasRef = useRef<HTMLCanvasElement>(null);
    const calibrationVideoRef = useRef<HTMLVideoElement>(null);
    const calibrationCanvasRef = useRef<HTMLCanvasElement>(null);
    const inputVideoRef = useRef<HTMLVideoElement>(null);

    // Defaults from config.json once it loads
    useEffect(() => {
        if (!config) return;
        const baseCfg = resolveGameConfig(config, difficulty);
        if (mirror === null) setMirror(baseCfg.mirrorInputDefault);
        if (effectsEnabled === null) setEffectsEnabled(baseCfg.effectsEnabledDefault);
        if (!difficultyTouched) {
            setDifficulty(resolveDifficultyKey(config.game.DEFAULT_DIFFICULTY, 'medium'));
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [config]);

    useEffect(() => {
        const onResize = () => engineRef.current?.resize();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    useEffect(() => {
        return () => {
            engineRef.current?.destroy();
            if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
        };
    }, []);

    const presets = useMemo(() => getDifficultyPresets(config), [config]);
    const effectivePreset: DifficultyPreset = useMemo(
        () => ({ ...presets[difficulty], ...tuning[difficulty] }),
        [presets, difficulty, tuning]
    );

    const cssVars = {
        '--feedback-scale': String(effectivePreset.VISUAL_FEEDBACK_SCALE),
        '--feedback-animation-sec': `${effectivePreset.VISUAL_FEEDBACK_ANIMATION_SEC}s`,
        '--combo-pulse-scale': String(effectivePreset.VISUAL_COMBO_PULSE_SCALE)
    } as React.CSSProperties;

    function onFile(setter: (f: File | null) => void) {
        return (e: ChangeEvent<HTMLInputElement>) => setter(e.target.files?.[0] ?? null);
    }

    function onTuningChange(field: TuningField, rawValue: string) {
        const parsed = Number(rawValue);
        if (!Number.isFinite(parsed)) return;
        let value = Math.max(field.min, Math.min(field.max, parsed));
        if (field.integer) value = Math.round(value);
        setTuning((prev) => ({
            ...prev,
            [difficulty]: { ...prev[difficulty], [field.key]: value }
        }));
    }

    function notifyControlsActivity() {
        setControlsVisible(true);
        if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
        const hideSec = config ? resolveGameConfig(config, difficulty).controlsIdleHideSec : 1.5;
        if (hideSec > 0) {
            controlsTimerRef.current = setTimeout(() => setControlsVisible(false), hideSec * 1000);
        }
    }

    async function startGame() {
        if (!videoFile || !jsonFile) {
            setError('Please select both reference video and choreography JSON');
            return;
        }
        if (inputMode === 'video' && !playerVideoFile) {
            setError('Please select a player video file');
            return;
        }
        setError(null);
        setIsLoading(true);

        try {
            const gameConfig = resolveGameConfig(config, difficulty, tuning[difficulty]);
            const choreography = JSON.parse(await jsonFile.text()) as LegacyChoreography;
            if (!Array.isArray(choreography.poses) || choreography.poses.length === 0) {
                throw new Error('Choreography JSON contains no poses');
            }

            const landmarker = await getLandmarker(gameConfig.modelComplexity);

            const els = {
                referenceVideo: referenceVideoRef.current!,
                gameCanvas: gameCanvasRef.current!,
                calibrationVideo: calibrationVideoRef.current!,
                calibrationCanvas: calibrationCanvasRef.current!,
                effectsCanvas: effectsCanvasRef.current!,
                inputVideo: inputVideoRef.current!,
                videoContainer: containerRef.current!
            };

            engineRef.current?.destroy();
            const engine = new GameEngine(els, {
                inputMode,
                referenceVideoFile: videoFile,
                playerVideoFile,
                choreography,
                config: gameConfig,
                landmarker,
                mirror: mirror ?? false,
                effectsEnabled: effectsEnabled ?? false,
                debugEnabled
            }, setSnapshot);

            engineRef.current = engine;
            await engine.start();
            setIsRunning(true);
            notifyControlsActivity();
        } catch (err) {
            console.error('Game start error:', err);
            setError((err as Error).message);
            engineRef.current?.destroy();
            engineRef.current = null;
        } finally {
            setIsLoading(false);
        }
    }

    function backToSetup() {
        engineRef.current?.destroy();
        engineRef.current = null;
        setIsRunning(false);
        setSnapshot(EMPTY_SNAPSHOT);
    }

    function onCalibrationSlider(e: ChangeEvent<HTMLInputElement>) {
        const pct = Number(e.target.value) / 100;
        const duration = snapshot.calibration.durationSec;
        engineRef.current?.setCalibrationTime(pct * duration);
    }

    const playButtonLabel = snapshot.phase === 'playing' ? 'Pause' : 'Play';
    const summary =
        `${DIFFICULTY_LABELS[difficulty]}: ` +
        `Accuracy >= ${Math.round(effectivePreset.SCORE_ACCURACY_THRESHOLD * 100)}% | ` +
        `+${Math.round(effectivePreset.SCORE_POINTS_PER_SECOND)} pts/s | ` +
        `Combo ${effectivePreset.COMBO_SECONDS.toFixed(2)}s (max ${effectivePreset.MAX_COMBO})`;

    return (
        <div className="game-root" style={cssVars}>
            {/* Hidden pose input (webcam stream or player test video) */}
            <video ref={inputVideoRef} className="webcam-hidden" muted playsInline />

            <div className="game-screen" hidden={!isRunning}>
                <header>
                    <div className="score-display">
                        <div>
                            <div className="stat-label">Score</div>
                            <div className="stat-value">{snapshot.hud.score}</div>
                        </div>
                        <div>
                            <div className="stat-label">Combos</div>
                            <div className="stat-value">{snapshot.hud.combos}</div>
                        </div>
                        <div>
                            <div className="stat-label">Accuracy</div>
                            <div className="stat-value">
                                {snapshot.hud.accuracyPct}%
                                {snapshot.hud.warning && <span className="accuracy-warning">{snapshot.hud.warning}</span>}
                            </div>
                        </div>
                    </div>
                </header>

                <div
                    ref={containerRef}
                    className="game-video-container"
                    onMouseMove={notifyControlsActivity}
                    onTouchStart={notifyControlsActivity}
                    onClick={notifyControlsActivity}
                >
                    <video ref={referenceVideoRef} playsInline />
                    <div className="effects-layer">
                        <canvas ref={effectsCanvasRef} />
                    </div>
                    <canvas ref={gameCanvasRef} />

                    <div className={'combo-indicator' + (snapshot.combo.visible ? ' active' : '')}>
                        COMBO x{snapshot.combo.value}!
                    </div>

                    {snapshot.feedback && (
                        <div key={snapshot.feedback.seq} className={`feedback feedback-${snapshot.feedback.tier}`}>
                            {snapshot.feedback.text}
                        </div>
                    )}

                    {snapshot.countdownValue && (
                        <div className="countdown-overlay">
                            <div className="countdown-value">{snapshot.countdownValue}</div>
                        </div>
                    )}

                    {snapshot.debug && (
                        <div className="debug-overlay">
                            <div style={{ color: 'var(--neon-green)', marginBottom: 6 }}>
                                Accuracy {snapshot.debug.accuracyPct}%
                            </div>
                            <div className="debug-match">MATCH: {snapshot.debug.matchText}</div>
                            <div className="debug-miss">MISS: {snapshot.debug.missText}</div>
                        </div>
                    )}

                    {snapshot.needsUserPlay && (
                        <div className="autoplay-overlay" onClick={() => engineRef.current?.resumePlayback()}>
                            <div>🎵 Click to Start Music</div>
                            <small>(Browser requires interaction for audio)</small>
                        </div>
                    )}

                    <div className={'game-controls' + (controlsVisible ? ' visible' : '')}>
                        <button
                            className="btn-primary"
                            disabled={snapshot.phase === 'countdown' || snapshot.phase === 'calibration'}
                            onClick={() => engineRef.current?.togglePlayPause()}
                        >
                            {playButtonLabel}
                        </button>
                        <button className="btn-secondary" onClick={() => engineRef.current?.reset()}>Reset</button>
                        <button className="btn-secondary" onClick={() => engineRef.current?.startCalibration()}>
                            Recalibrate
                        </button>
                        <button className="btn-secondary" onClick={backToSetup}>Exit</button>
                    </div>
                </div>
            </div>

            {isRunning && snapshot.phase === 'calibration' && (
                <div className="calibration-screen">
                    <div className="calibration-content">
                        <h2>Initial Calibration. Match the pose</h2>

                        <div className="calibration-preview">
                            <video ref={calibrationVideoRef} className="calibration-video" loop muted playsInline />
                            <canvas ref={calibrationCanvasRef} className="calibration-canvas" />
                            <div className="frame-slider-container">
                                <input
                                    type="range"
                                    className="frame-slider"
                                    min={0}
                                    max={100}
                                    defaultValue={0}
                                    onChange={onCalibrationSlider}
                                />
                                <div className="frame-time-display">
                                    {snapshot.calibration.currentTimeSec.toFixed(1)}s
                                    {' / '}
                                    {snapshot.calibration.durationSec.toFixed(1)}s
                                </div>
                            </div>
                        </div>

                        <div className="calibration-status">
                            <div className="calibration-progress-bar">
                                <div
                                    className="calibration-progress-fill"
                                    style={{ width: `${snapshot.calibration.progressPct}%` }}
                                />
                            </div>
                            <div className="calibration-status-text">{snapshot.calibration.status}</div>
                            <button className="btn-secondary" onClick={() => engineRef.current?.skipCalibration()}>
                                Skip calibration
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {isRunning && snapshot.phase === 'ended' && snapshot.stats && (
                <div className="game-stats-screen">
                    <div className="stats-card">
                        <h2>Song Complete</h2>
                        <div className="stats-grid">
                            <div className="stats-item">
                                <div className="stat-label">Final Score</div>
                                <div className="stats-value">{snapshot.stats.score}</div>
                            </div>
                            <div className="stats-item">
                                <div className="stat-label">Avg Accuracy</div>
                                <div className="stats-value">{snapshot.stats.avgAccuracyPct}%</div>
                            </div>
                            <div className="stats-item">
                                <div className="stat-label">Max Combo</div>
                                <div className="stats-value">{snapshot.stats.maxCombo}</div>
                            </div>
                            <div className="stats-item">
                                <div className="stat-label">Time Danced</div>
                                <div className="stats-value">{snapshot.stats.dancedSec.toFixed(1)}s</div>
                            </div>
                            <div className="stats-item">
                                <div className="stat-label">Difficulty</div>
                                <div className="stats-value">{DIFFICULTY_LABELS[difficulty]}</div>
                            </div>
                        </div>
                        <div className="stats-actions">
                            <button className="btn-primary" onClick={() => engineRef.current?.retry()}>Retry Song</button>
                            <button className="btn-secondary" onClick={backToSetup}>Back to Start</button>
                        </div>
                    </div>
                </div>
            )}

            {!isRunning && (
                <div className="setup-screen">
                    <div className="setup-content">
                        <a className="setup-exit" href="#/extractor">&larr; Extractor &amp; Visualizer</a>
                        <h2>Clone Dance</h2>

                        <div className="game-file-group">
                            <label>Reference Video (MP4)</label>
                            <input type="file" accept="video/mp4,video/webm" onChange={onFile(setVideoFile)} />
                        </div>

                        <div className="game-file-group">
                            <label>Choreography (JSON)</label>
                            <input type="file" accept="application/json" onChange={onFile(setJsonFile)} />
                        </div>

                        <div className="game-file-group">
                            <label>Player Input</label>
                            <select
                                value={inputMode}
                                onChange={(e) => setInputMode(e.target.value as 'webcam' | 'video')}
                                style={{ marginBottom: 10 }}
                            >
                                <option value="webcam">Webcam (Live)</option>
                                <option value="video">Video File (Testing)</option>
                            </select>
                            {inputMode === 'video' && (
                                <input type="file" accept="video/mp4,video/webm" onChange={onFile(setPlayerVideoFile)} />
                            )}
                        </div>

                        <div className="game-file-group">
                            <label>Difficulty</label>
                            <select
                                value={difficulty}
                                onChange={(e) => {
                                    setDifficulty(resolveDifficultyKey(e.target.value));
                                    setDifficultyTouched(true);
                                }}
                            >
                                {DIFFICULTY_KEYS.map((key) => (
                                    <option key={key} value={key}>{DIFFICULTY_LABELS[key]}</option>
                                ))}
                            </select>
                            <p className="difficulty-summary">{summary}</p>

                            <details className="difficulty-config-card">
                                <summary>Difficulty Tuning (Dev)</summary>
                                <div className="difficulty-config-grid">
                                    {TUNING_FIELDS.map((field) => (
                                        <label key={field.key} className="difficulty-config-field">
                                            {field.label}
                                            <input
                                                type="number"
                                                min={field.min}
                                                max={field.max}
                                                step={field.step}
                                                value={effectivePreset[field.key]}
                                                onChange={(e) => onTuningChange(field, e.target.value)}
                                            />
                                        </label>
                                    ))}
                                </div>
                                <button
                                    type="button"
                                    className="btn-secondary difficulty-reset-btn"
                                    onClick={() => setTuning((prev) => ({ ...prev, [difficulty]: {} }))}
                                >
                                    Reset Selected Difficulty Values
                                </button>
                            </details>
                        </div>

                        <div className="toggle-container">
                            <span className="toggle-label" title="Mirror input (recommended for webcam)">Mirror:</span>
                            <div
                                className={'toggle-switch' + (mirror ? ' active' : '')}
                                onClick={() => setMirror(!mirror)}
                            />
                            <span className="toggle-label" title="Visual and sound effects">VFX &amp; SFX:</span>
                            <div
                                className={'toggle-switch' + (effectsEnabled ? ' active' : '')}
                                onClick={() => setEffectsEnabled(!effectsEnabled)}
                            />
                            <span className="toggle-label" title="Show pose match debug overlay">Debug:</span>
                            <div
                                className={'toggle-switch' + (debugEnabled ? ' active' : '')}
                                onClick={() => setDebugEnabled(!debugEnabled)}
                            />
                        </div>

                        {isLoading && (
                            <div className="game-loading">
                                <div className="game-spinner" />
                                <p style={{ marginTop: 10, color: 'var(--neon-blue)' }}>Loading MediaPipe...</p>
                            </div>
                        )}
                        {error && <div className="game-error">{error}</div>}

                        <button
                            className="btn-primary"
                            style={{ width: '100%' }}
                            disabled={isLoading}
                            onClick={startGame}
                        >
                            Start Game
                        </button>
                    </div>
                </div>
            )}
        </div>
    );
}
