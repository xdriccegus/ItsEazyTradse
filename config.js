// ==========================================
// FEATURE FLAGS & CONFIGURATION
// ==========================================
const BROKER_FEATURE_ENABLED = true; // Abilitato: supporto Capital.com attivo

// URL del proxy (su Netlify usa percorso relativo '', in file:// o locale usa http://localhost:3030 se disponibile)
const PROXY_BASE_URL = (function() {
    if (typeof window !== 'undefined' && window.location) {
        if (window.location.protocol === 'file:') {
            return 'http://localhost:3030';
        }
    }
    return '';
})();
