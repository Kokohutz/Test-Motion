/**
 * Reward sound effects. Preloaded on first use (must happen inside a user
 * gesture so autoplay policies allow playback); failures are remembered so
 * a missing file never spams errors.
 */

export type SoundKey = 'feedbackGood' | 'feedbackGreat' | 'feedbackPerfect' | 'comboUp' | 'comboMax';

const SOUND_FILES: Record<SoundKey, string> = {
    feedbackGood: '/assets/sfx/feedback_good.mp3',
    feedbackGreat: '/assets/sfx/feedback_great.mp3',
    feedbackPerfect: '/assets/sfx/feedback_perfect.mp3',
    comboUp: '/assets/sfx/combo_up.mp3',
    comboMax: '/assets/sfx/combo_max.mp3'
};

const SOUND_VOLUMES: Record<SoundKey, number> = {
    feedbackGood: 0.45,
    feedbackGreat: 0.5,
    feedbackPerfect: 0.6,
    comboUp: 0.55,
    comboMax: 0.7
};

export class SoundBank {
    private players: Partial<Record<SoundKey, HTMLAudioElement>> = {};
    private failures = new Set<SoundKey>();
    private initialized = false;

    /** Call from a user gesture (e.g. the Start button). */
    init(): void {
        if (this.initialized) return;
        this.initialized = true;

        for (const [key, src] of Object.entries(SOUND_FILES) as [SoundKey, string][]) {
            const audio = new Audio(src);
            audio.preload = 'auto';
            audio.volume = SOUND_VOLUMES[key];
            audio.addEventListener('error', () => this.failures.add(key), { once: true });
            this.players[key] = audio;
        }
    }

    play(key: SoundKey): void {
        const audio = this.players[key];
        if (!audio || this.failures.has(key)) return;
        try {
            audio.currentTime = 0;
            audio.play()?.catch(() => { /* autoplay blocked: ignore */ });
        } catch {
            // ignore playback failures
        }
    }
}
