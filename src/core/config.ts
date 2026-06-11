/**
 * Loads and validates public/config.json — the single source of truth
 * shared between the React app and the legacy game page.
 */

import type { AppConfig } from './types';

let configPromise: Promise<AppConfig> | null = null;

export function validateAppConfig(data: unknown): AppConfig {
    if (!data || typeof data !== 'object') {
        throw new Error('Config must be a JSON object');
    }
    const config = data as Record<string, unknown>;
    for (const section of ['common', 'game', 'visualizer']) {
        if (!config[section] || typeof config[section] !== 'object') {
            throw new Error(`Config must include the "${section}" section`);
        }
    }
    return data as AppConfig;
}

export function loadAppConfig(): Promise<AppConfig> {
    if (!configPromise) {
        configPromise = fetch('/config.json', { cache: 'no-store' })
            .then((response) => {
                if (!response.ok) {
                    throw new Error(`Failed to load config.json: ${response.status}`);
                }
                return response.json();
            })
            .then(validateAppConfig)
            .catch((error) => {
                configPromise = null; // allow retry on next call
                throw error;
            });
    }
    return configPromise;
}
