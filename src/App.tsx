import { useEffect, useState } from 'react';
import ExtractorPage from './pages/ExtractorPage';
import GamePage from './pages/GamePage';
import VisualizerPage from './pages/VisualizerPage';

type Route = 'game' | 'extractor' | 'visualizer';

function routeFromHash(): Route {
    const hash = window.location.hash.replace(/^#\/?/, '');
    if (hash === 'extractor') return 'extractor';
    if (hash === 'visualizer') return 'visualizer';
    return 'game';
}

export default function App() {
    const [route, setRoute] = useState<Route>(routeFromHash);

    useEffect(() => {
        const onHashChange = () => setRoute(routeFromHash());
        window.addEventListener('hashchange', onHashChange);
        return () => window.removeEventListener('hashchange', onHashChange);
    }, []);

    // The game takes over the whole viewport with its own chrome
    if (route === 'game') {
        return <GamePage />;
    }

    return (
        <>
            <header className="app-header">
                <h1>Clone Dance</h1>
                <nav>
                    <a href="#/game">Play the Game</a>
                    <a href="#/extractor" className={route === 'extractor' ? 'active' : ''}>Extractor</a>
                    <a href="#/visualizer" className={route === 'visualizer' ? 'active' : ''}>Visualizer</a>
                </nav>
            </header>
            <main className="container">
                {route === 'extractor' ? <ExtractorPage /> : <VisualizerPage />}
            </main>
        </>
    );
}
