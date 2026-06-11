import { useEffect, useState } from 'react';
import { loadAppConfig } from '../core/config';
import type { AppConfig } from '../core/types';

export interface AppConfigState {
    config: AppConfig | null;
    error: string | null;
}

/** Loads public/config.json once; components render fallbacks until ready. */
export function useAppConfig(): AppConfigState {
    const [config, setConfig] = useState<AppConfig | null>(null);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        let alive = true;
        loadAppConfig()
            .then((loaded) => {
                if (alive) setConfig(loaded);
            })
            .catch((err: Error) => {
                if (alive) setError(err.message);
            });
        return () => {
            alive = false;
        };
    }, []);

    return { config, error };
}
