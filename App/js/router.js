// ==========================================
// ROUTER
// ==========================================
const router = {
    currentPage: 'dashboard',
    navigationToken: 0,
    pendingNavigationTimer: null,

    navigate(page, skipHistory = false, immediate = false) {
        if (!ui.container) ui.container = document.getElementById('main-content');
        if (!ui.container) {
            console.error('Main content container not found');
            return;
        }

        const navToken = ++this.navigationToken;

        this.currentPage = page;

        localStorage.setItem('eazytrader_last_page', page);

        // Mantiene coerente lo stato della dock anche per pagine speciali.
        const navPage = page === 'drafts' ? 'journal' : page;

        // Transizione pulita e semplice
        document.querySelectorAll('.dock-icon').forEach(btn => {
            const willBeActive = btn.id === `nav-${navPage}`;
            if (willBeActive) {
                btn.classList.add('active');
            } else {
                btn.classList.remove('active');
            }
        });

        if (!skipHistory) {
            const targetHash = `#${page}`;
            if (window.location.hash !== targetHash || !history.state || history.state.page !== page) {
                history.pushState({ page }, '', targetHash);
            }
        }

        if (ui.container) {
            const renderContent = async () => {
                // Evita render vecchi quando l'utente cambia pagina velocemente.
                if (navToken !== this.navigationToken) return;

                // ✅ FIX CRITICO: reset completo dello stato modal ad ogni navigazione.
                // Previene che app-modal-active / inert / nav-hidden-mode rimangano
                // bloccati se la navigazione avviene durante l'animazione di chiusura.
                document.body.classList.remove('modal-open', 'app-modal-active');
                document.querySelectorAll('[inert]').forEach(el => el.removeAttribute('inert'));
                document.querySelectorAll('[data-modal-aria-managed]').forEach(el => {
                    el.removeAttribute('aria-hidden');
                    el.removeAttribute('data-modal-aria-managed');
                });
                document.querySelectorAll('[data-modal-allowed-root]').forEach(el => {
                    el.removeAttribute('data-modal-allowed-root');
                });
                const navbar = document.querySelector('nav');
                if (navbar) navbar.classList.remove('nav-hidden-mode');

                ui.container.scrollTop = 0;

                // Carica il nuovo contenuto
                if (ui[page]) {
                    try {
                        const result = ui[page]();
                        // Se la funzione ritorna una Promise, attendila
                        if (result && typeof result.then === 'function') {
                            await result;
                        }
                    } catch (e) {
                        console.error('Navigation error:', e);
                        ui.container.innerHTML = `<div class="flex flex-col items-center justify-center h-full text-red-500 gap-4"><i class="ph-bold ph-warning-circle text-6xl mb-2 animate-pulse"></i><p class="text-xl font-bold">Errore di caricamento</p><p class="text-sm opacity-70">Riprova più tardi</p></div>`;
                    }
                } else if (page === 'drafts') {
                    ui.journal();
                } else {
                    ui.container.innerHTML = `<div class="flex flex-col items-center justify-center h-full opacity-50"><i class="ph-bold ph-warning text-4xl mb-2"></i><p>Pagina non trovata: ${page}</p></div>`;
                }

                // Fade-in del nuovo contenuto solo dopo che tutto è renderizzato
                requestAnimationFrame(() => {
                    if (navToken !== this.navigationToken) return;
                    ui.container.style.opacity = '1';
                });
            };

            if (this.pendingNavigationTimer) {
                clearTimeout(this.pendingNavigationTimer);
                this.pendingNavigationTimer = null;
            }

            if (immediate) {
                renderContent();
            } else {
                // Fade-out immediato
                ui.container.style.opacity = '0';
                // Attendi che il fade-out sia completo, poi cambia contenuto
                this.pendingNavigationTimer = setTimeout(() => {
                    this.pendingNavigationTimer = null;
                    renderContent();
                }, 150);
            }
        }
    },

    dashboard() { this.navigate('dashboard'); },
    journal() { this.navigate('journal'); },
    analytics() { this.navigate('analytics'); },
    review() { this.navigate('review'); },
    todo() { this.navigate('todo'); },
    news() { this.navigate('news'); },
    paywall() { this.navigate('paywall'); },
    accounts() { this.navigate('accounts'); },
    settings() { this.navigate('settings'); },
    system() { this.navigate('system'); },
    profile() { this.navigate('profile'); },
    drafts() { this.navigate('journal'); },
    playbook() { this.navigate('playbook'); }
};

// Browser history management
window.addEventListener('popstate', (event) => {
    if (event.state && event.state.page) {
        router.navigate(event.state.page, true);
    } else {
        router.navigate('dashboard', true);
    }
});
