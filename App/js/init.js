document.addEventListener('DOMContentLoaded', async () => {
    try {
        await ui.init();
        MobileOptimizer.init();
        MobileGestures.init();

        // ☁️ Cloud Sync: inizializza dopo il caricamento dell'app
        if (typeof CloudSync !== 'undefined') {
            try {
                await CloudSync.init();
                console.log('☁️ CloudSync inizializzato:', CloudSync.getSyncInfo());
            } catch (e) {
                console.warn('⚠️ CloudSync non disponibile:', e.message);
            }
        }
    } catch (error) {
        console.error('Errore inizializzazione app:', error);
        const container = document.getElementById('main-content');
        if (container) {
            container.innerHTML = '<div class="flex flex-col items-center justify-center h-full text-red-500 gap-3"><i class="ph-bold ph-warning-circle text-5xl"></i><p class="text-lg font-bold">Errore di avvio</p><p class="text-sm opacity-70">Ricarica la pagina per riprovare</p></div>';
        }
    }
});
