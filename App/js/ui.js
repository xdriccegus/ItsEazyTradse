const ui = {
    container: null,
    tempImages: [],
    filters: { account: 'all', status: 'all', time: 'all' },
    dashboardFilter: 'all',
    newsFilter: 'all',
    currentCalendarMonth: new Date(),
    reviewState: { showAllWeekly: false, showAllDaily: false },
    todoTempState: { type: 'Trading', importance: 'normal' },
    todoSwitchTimers: { hideShow: null, cleanup: null },
    currentDayIndex: -1,

    sanitizeText(value, maxLen = 120) {
        if (typeof value !== 'string') return '';
        return value.replace(/[\u0000-\u001F\u007F]/g, '').trim().slice(0, maxLen);
    },

    escapeHtml(value) {
        return String(value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    },

    sanitizeImageUrl(url) {
        if (typeof url !== 'string') return '';
        const trimmed = url.trim();
        if (!trimmed) return '';
        const allowedPrefixes = ['https://', 'http://', 'blob:', 'data:image/'];
        return allowedPrefixes.some((prefix) => trimmed.startsWith(prefix)) ? trimmed : '';
    },

    getStartupPage() {
        const allowedPages = new Set(['dashboard', 'journal', 'review', 'todo', 'news', 'system', 'profile', 'accounts', 'settings', 'paywall', 'drafts']);
        const hashPage = (window.location.hash || '').replace('#', '').trim();
        const storedPage = (localStorage.getItem('eazytrader_last_page') || '').trim();
        const candidate = hashPage || storedPage || 'dashboard';
        return allowedPages.has(candidate) ? candidate : 'dashboard';
    },

    // Aggiorna la pagina corrente sul posto, senza passare dal router: niente
    // dissolvenza, niente scroll che torna in cima, niente cambio di pagina.
    // Serve alle sincronizzazioni, che non devono farsi notare dall'utente.
    refreshViewSilently() {
        // 'drafts' condivide il render del journal: rigenerarlo dal router farebbe
        // saltare l'utente sulla pagina sbagliata.
        const renderers = { dashboard: 'dashboard', journal: 'journal', drafts: 'journal', accounts: 'accounts' };
        const renderer = renderers[router.currentPage];

        if (!renderer || typeof ui[renderer] !== 'function' || !ui.container) return;

        // Mai interrompere l'utente mentre ha un modal aperto o sta scrivendo.
        if (document.body.classList.contains('app-modal-active')) return;
        if (document.querySelector('input:focus, textarea:focus, select:focus')) return;

        const scrollTop = ui.container.scrollTop;
        const restoreScroll = () => { if (ui.container) ui.container.scrollTop = scrollTop; };

        try {
            const result = ui[renderer]();
            if (result && typeof result.then === 'function') {
                result.then(restoreScroll).catch(e => console.error('Refresh silenzioso fallito:', e));
            } else {
                restoreScroll();
            }
        } catch (e) {
            console.error('Refresh silenzioso fallito:', e);
        }
    },

    setBackgroundInteractivity(disabled, allowedRootIds = ['modal-overlay']) {
        const overlay = document.getElementById('modal-overlay');
        const bodyChildren = Array.from(document.body.children || []);
        const allowedSet = new Set(
            (allowedRootIds || [])
                .map((id) => document.getElementById(id))
                .filter(Boolean)
        );

        // Marca i root consentiti per la safety-net CSS sui pointer events.
        bodyChildren.forEach((el) => el.removeAttribute('data-modal-allowed-root'));
        if (disabled) {
            if (overlay) overlay.setAttribute('data-modal-allowed-root', '1');
            allowedSet.forEach((el) => el.setAttribute('data-modal-allowed-root', '1'));
        }

        bodyChildren.forEach((el) => {
            if (el.tagName === 'SCRIPT' || el === overlay || allowedSet.has(el)) return;

            if (disabled) {
                el.setAttribute('inert', '');
                if (!el.hasAttribute('data-modal-aria-managed')) {
                    el.setAttribute('aria-hidden', 'true');
                    el.setAttribute('data-modal-aria-managed', '1');
                }
            } else {
                el.removeAttribute('inert');
                if (el.hasAttribute('data-modal-aria-managed')) {
                    el.removeAttribute('aria-hidden');
                    el.removeAttribute('data-modal-aria-managed');
                }
            }
        });

        document.body.classList.toggle('modal-open', disabled);
        document.body.classList.toggle('app-modal-active', disabled);
    },

    async init() {
        this.container = document.getElementById('main-content');

        // Disabilita temporaneamente le transizioni per evitare flash durante l'init
        if (this.container) {
            this.container.style.transition = 'none';
            this.container.style.opacity = '1';
        }

        // ⚡ IMPORTANTE: Await per il caricamento da IndexedDB
        await DataStore.init();

        // 🔄 AUTO-SYNC BROKERS (DISABILITATO per alcuni, abilitato per Capital.com)
        const hasCapitalCom = DataStore.data.accounts.some(a => a.type === 'live' && a.capitalComConnected);
        if (hasCapitalCom || (BROKER_FEATURE_ENABLED && DataStore.data.settings.brokerConnections && DataStore.data.settings.brokerConnections.mt5.enabled)) {
            // Prima sync dopo 3s per non bloccare il render iniziale
            setTimeout(() => this.syncBrokerTrades(true), 3000);
            // Polling ogni 30 secondi per intercettare trade chiusi rapidamente
            setInterval(() => this.syncBrokerTrades(true), 30000);
        }

        // 💰 CAPITAL.COM BALANCE POLLING (real-time ogni 30s)
        if (hasCapitalCom) {
            setTimeout(() => this.startCapitalComBalancePolling(), 5000);
        }


        // Gestione tema: il riferimento è sempre il sistema operativo. La scelta
        // manuale dal pulsante è solo un'eccezione temporanea, che decade appena
        // il sistema cambia tema.
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
        const manualTheme = localStorage.getItem('eazytrader_theme_manual');

        this.applyTheme(manualTheme || (systemDark.matches ? 'dark' : 'light'));

        systemDark.addEventListener('change', (e) => {
            // Il sistema ha l'ultima parola: dimentica l'eventuale scelta manuale.
            localStorage.removeItem('eazytrader_theme_manual');
            localStorage.removeItem('eazytrader_theme');
            ui.applyTheme(e.matches ? 'dark' : 'light');
        });

        this.setupScrollProgress();
        this.renderInitialModals();
        this.populateSelects();

        const oldAlert = document.getElementById('draft-alert');
        if (oldAlert) oldAlert.style.display = 'none';

        // Pre-carica news e calendario in background (non blocking)
        DataStore.preloadNewsAndCalendar();

        // RENDER HEADER PROFILE
        this.renderHeaderProfile();
        this.renderWelcomeName();

        // LOGICA AVVIO:
        // 1. Se è il PRIMO AVVIO ASSOLUTO (Onboarding non completo):
        //    Mostra direttamente il Wizard (Step 1), saltando la splash screen statica "Benvenuto Trader".
        if (!localStorage.getItem('eazytrader_onboarding_complete')) {
            this.startOnboarding();
            return; // Interrompi qui, il wizard gestirà il resto
        }

        // 2. Se è un AVVIO SUCCESSIVO (Onboarding completo):
        //    Mostra sempre la splash screen "Benvenuto Trader" all'ingresso
    },

    // --- ONBOARDING SYSTEM (v2) ---
    onboardingStep: 0,
    onboardingTotalSteps: 5,
    onboardingLastActionAt: 0,
    onboardingValidationMessage: '',
    onboardingDraft: {
        name: '',
        goal: 'consistenza',
        accountType: 'personal',
        primaryAsset: 'EURUSD',
        primarySession: 'London',
        experienceLevel: 'intermedio'
    },
    appStarted: false, // Guard per prevenire doppi avvii

    canRunOnboardingAction() {
        const now = Date.now();
        if (now - this.onboardingLastActionAt < 420) return false;
        this.onboardingLastActionAt = now;
        return true;
    },

    buildOnboardingDraft() {
        const profile = DataStore.data.profile || {};
        const settings = DataStore.data.settings || {};
        const traderProfile = settings.traderProfile || {};

        const assets = Array.isArray(settings.assets) && settings.assets.length > 0
            ? settings.assets
            : ['EURUSD', 'XAUUSD', 'BTCUSD'];
        const sessions = Array.isArray(settings.sessions) && settings.sessions.length > 0
            ? settings.sessions
            : ['London', 'New York', 'Asian'];

        this.onboardingDraft = {
            name: (profile.name && profile.name !== 'Trader') ? profile.name : '',
            goal: traderProfile.primaryGoal || 'consistenza',
            accountType: traderProfile.accountType || 'personal',
            primaryAsset: traderProfile.primaryAsset || assets[0],
            primarySession: traderProfile.primarySession || sessions[0],
            experienceLevel: traderProfile.experienceLevel || 'intermedio'
        };
    },

    startOnboarding() {
        this.buildOnboardingDraft();
        this.onboardingValidationMessage = '';
        this.onboardingStep = 1;
        this.renderOnboarding();
    },

    prevOnboardingStep() {
        if (!this.canRunOnboardingAction()) return;
        if (this.onboardingStep <= 1) return;
        this.onboardingValidationMessage = '';
        this.onboardingStep--;
        this.renderOnboarding();
    },

    startApp() {
        // Idempotency check: se l'app è già avviata, ignora
        if (this.appStarted) return;

        // Se l'onboarding non è mai stato completato, avvialo
        if (!localStorage.getItem('eazytrader_onboarding_complete')) {
            ui.startOnboarding();
            return;
        }

        // Segna come avviata per bloccare chiamate future
        this.appStarted = true;

        if (DataStore.data.accounts.length === 0) {
            DataStore.addAccount({
                name: 'Conto Principale',
                size: 10000,
                balance: 10000,
                type: 'funded'
            });
        }

        const welcomeScreen = document.getElementById('welcome-screen');
        if (welcomeScreen) {
            welcomeScreen.classList.add('opacity-0');
            // Aumentato timeout per assicurare rimozione completa dopo transizione
            setTimeout(() => {
                if (welcomeScreen) welcomeScreen.style.display = 'none';
            }, 800);
        }

        document.body.classList.remove('overflow-hidden');
        const nav = document.querySelector('nav');
        if (nav) {
            nav.classList.remove('hidden', 'opacity-0', 'pointer-events-none');
            nav.classList.add('opacity-100');
        }

        // Riabilita transizioni container
        if (ui.container) {
            ui.container.style.transition = '';
        }

        const startupPage = this.getStartupPage();

        // Manually update URL first to ensure stable state
        history.replaceState({ page: startupPage }, '', `#${startupPage}`);

        // Navigazione pulita tramite router
        // skipHistory=true per non creare back-loop alla welcome screen
        // immediate=true per render immediato (la dissolvenza la gestisce welcomeScreen)
        router.navigate(startupPage, true, true);
    },

    syncOnboardingStepData() {
        if (this.onboardingStep === 2) {
            const nameInput = document.getElementById('onboarding-name');
            const goalSelect = document.getElementById('onboarding-primary-goal');
            this.onboardingDraft.name = this.sanitizeText((nameInput?.value || '').trim(), 40) || '';
            this.onboardingDraft.goal = goalSelect?.value || this.onboardingDraft.goal || 'consistenza';
            return true;
        }

        if (this.onboardingStep === 3) {
            const accountType = document.querySelector('input[name="onboarding-account-type"]:checked')?.value;
            if (!accountType) {
                this.onboardingValidationMessage = 'Seleziona un tipo di account per continuare.';
                return false;
            }
            this.onboardingDraft.accountType = accountType;
            return true;
        }

        if (this.onboardingStep === 4) {
            const assetSelect = document.getElementById('onboarding-primary-asset');
            const sessionSelect = document.getElementById('onboarding-primary-session');
            const experienceSelect = document.getElementById('onboarding-experience-level');

            this.onboardingDraft.primaryAsset = assetSelect?.value || this.onboardingDraft.primaryAsset || 'EURUSD';
            this.onboardingDraft.primarySession = sessionSelect?.value || this.onboardingDraft.primarySession || 'London';
            this.onboardingDraft.experienceLevel = experienceSelect?.value || this.onboardingDraft.experienceLevel || 'intermedio';
            return true;
        }

        return true;
    },

    persistOnboardingData(options = {}) {
        const { applyAccountPreset = true } = options;
        const draft = this.onboardingDraft;

        DataStore.data.profile.name = draft.name || DataStore.data.profile.name || 'Trader';

        const moveToFirst = (arr, value) => {
            const normalized = Array.isArray(arr) ? [...new Set(arr.filter(Boolean))] : [];
            if (!value) return normalized;
            return [value, ...normalized.filter(item => item !== value)];
        };

        DataStore.data.settings.assets = moveToFirst(DataStore.data.settings.assets, draft.primaryAsset);
        DataStore.data.settings.sessions = moveToFirst(DataStore.data.settings.sessions, draft.primarySession);
        DataStore.data.settings.defaultSession = draft.primarySession;
        DataStore.data.settings.traderProfile = {
            ...(DataStore.data.settings.traderProfile || {}),
            primaryGoal: draft.goal,
            primaryAsset: draft.primaryAsset,
            primarySession: draft.primarySession,
            experienceLevel: draft.experienceLevel,
            accountType: draft.accountType
        };

        if (applyAccountPreset) {
            const accountTypes = {
                funded: { name: 'Funded Account', size: 50000, balance: 50000, type: 'funded' },
                challenge: { name: 'Challenge', size: 10000, balance: 10000, type: 'challenge' },
                personal: { name: 'Conto Principale', size: 10000, balance: 10000, type: 'funded' }
            };

            const selectedAccount = accountTypes[draft.accountType] || accountTypes.personal;
            DataStore.data.accounts = [];
            DataStore.addAccount(selectedAccount);
        }

        DataStore.save();
        this.renderHeaderProfile();
        this.renderWelcomeName();
    },

    nextOnboardingStep() {
        if (!this.canRunOnboardingAction()) return;
        this.onboardingValidationMessage = '';

        const isValid = this.syncOnboardingStepData();
        if (!isValid) {
            this.renderOnboarding();
            return;
        }

        if (this.onboardingStep >= this.onboardingTotalSteps) return;

        this.onboardingStep++;
        this.renderOnboarding();
    },

    skipOnboarding() {
        if (!this.canRunOnboardingAction()) return;

        if (!this.onboardingDraft || !this.onboardingDraft.accountType) {
            this.buildOnboardingDraft();
        }
        if (!this.onboardingDraft.name) this.onboardingDraft.name = 'Trader';

        const isFirstOnboarding = !localStorage.getItem('eazytrader_onboarding_complete');
        this.persistOnboardingData({ applyAccountPreset: isFirstOnboarding });
        this.completeOnboarding(true);
    },

    completeOnboarding(skipTour = false) {
        this.syncOnboardingStepData();
        const isFirstOnboarding = !localStorage.getItem('eazytrader_onboarding_complete');
        this.persistOnboardingData({ applyAccountPreset: isFirstOnboarding });
        localStorage.setItem('eazytrader_onboarding_complete', 'true');

        this.startApp();

        // Avvia il tour interattivo solo se non saltato
        if (!skipTour) {
            setTimeout(() => {
                ui.startFeatureTour();
            }, 800);
        }
    },

    startFeatureTour() {
        if (!window.driver || !window.driver.js || typeof window.driver.js.driver !== 'function') {
            localStorage.setItem('eazytrader_tour_complete', 'true');
            return;
        }

        if (!document.getElementById('driver-custom-styles')) {
            const style = document.createElement('style');
            style.id = 'driver-custom-styles';
            style.innerHTML = `
                .driver-popover {
                    background: linear-gradient(140deg, #0f172a 0%, #111827 55%, #1f2937 100%) !important;
                    border: 1px solid rgba(255,255,255,0.12) !important;
                    border-radius: 22px !important;
                    color: #f9fafb !important;
                    padding: 24px !important;
                    box-shadow: 0 28px 80px rgba(0,0,0,0.5), 0 1px 0 rgba(255,255,255,0.08) inset !important;
                    max-width: 380px !important;
                }
                .driver-popover-title {
                    font-size: 20px !important;
                    font-weight: 800 !important;
                    margin-bottom: 10px !important;
                    color: #ffffff !important;
                    letter-spacing: -0.4px !important;
                }
                .driver-popover-description {
                    font-size: 14px !important;
                    line-height: 1.6 !important;
                    color: #cbd5e1 !important;
                    margin-bottom: 20px !important;
                }
                .driver-popover-footer button {
                    border-radius: 12px !important;
                    font-weight: 700 !important;
                    padding: 10px 16px !important;
                    border: 0 !important;
                }
                .driver-next-btn {
                    background: linear-gradient(135deg, #0ea5e9 0%, #2563eb 100%) !important;
                    color: #fff !important;
                }
                .driver-prev-btn,
                .driver-close-btn {
                    background: rgba(255,255,255,0.08) !important;
                    color: #e5e7eb !important;
                }
            `;
            document.head.appendChild(style);
        }

        const stepCandidates = [
            { element: '#cmd-new-trade', popover: { title: 'Nuovo Trade', description: 'Inserisci subito il tuo trade con dettagli, note e screenshot. E il punto di partenza del diario.' } },
            { element: '#stats-grid', popover: { title: 'Statistiche Live', description: 'Controlla P&L, win rate e andamento settimanale in tempo reale per capire se stai eseguendo bene.' } },
            { element: '#nav-journal', popover: { title: 'Journal', description: 'Rivedi tutti i trade, filtra i risultati e trova pattern ricorrenti.' } },
            { element: '#nav-review', popover: { title: 'Review', description: 'Analizza performance e comportamenti per migliorare ogni settimana.' } },
            { element: '#nav-todo', popover: { title: 'Disciplina', description: 'Definisci regole operative e controlla se le rispetti.' } },
            { element: '#nav-system', popover: { title: 'Sistema', description: 'Personalizza asset, strategie e impostazioni di backup.' } }
        ];

        const steps = stepCandidates.filter(step => !!document.querySelector(step.element));
        if (steps.length === 0) {
            localStorage.setItem('eazytrader_tour_complete', 'true');
            return;
        }

        const driver = window.driver.js.driver;
        const driverObj = driver({
            showProgress: true,
            animate: true,
            doneBtnText: 'Inizia',
            nextBtnText: 'Avanti',
            prevBtnText: 'Indietro',
            allowClose: true,
            overlayColor: 'rgba(2, 6, 23, 0.78)',
            steps,
            onDestroyed: () => {
                localStorage.setItem('eazytrader_tour_complete', 'true');
            }
        });

        driverObj.drive();
    },

    renderOnboarding() {
        const screen = document.getElementById('welcome-screen');
        if (!screen) return;

        const settings = DataStore.data.settings || {};
        const assets = Array.isArray(settings.assets) && settings.assets.length > 0
            ? settings.assets.slice(0, 8)
            : ['EURUSD', 'XAUUSD', 'BTCUSD'];
        const sessions = Array.isArray(settings.sessions) && settings.sessions.length > 0
            ? settings.sessions
            : ['London', 'New York', 'Asian'];

        if (!this.onboardingStep || this.onboardingStep < 1) this.onboardingStep = 1;
        if (this.onboardingStep > this.onboardingTotalSteps) this.onboardingStep = this.onboardingTotalSteps;

        const step = this.onboardingStep;
        const progress = Math.round((step / this.onboardingTotalSteps) * 100);
        const safeName = this.escapeHtml(this.sanitizeText(this.onboardingDraft.name || DataStore.data.profile.name || 'Trader', 40) || 'Trader');
        const validation = this.onboardingValidationMessage
            ? `<div class="w-full max-w-lg mt-3 rounded-xl border border-rose-500/40 bg-rose-500/10 text-rose-200 text-sm px-4 py-3">${this.escapeHtml(this.onboardingValidationMessage)}</div>`
            : '';

        screen.style.display = 'flex';
        screen.style.paddingTop = 'max(12px, env(safe-area-inset-top))';
        screen.style.paddingBottom = 'max(16px, env(safe-area-inset-bottom))';
        screen.scrollTop = 0;
        screen.classList.remove('hidden', 'opacity-0');

        let content = '';

        if (step === 1) {
            content = `
                <section class="w-full max-w-4xl mx-auto px-4 py-6 animate-[fade-in_0.5s_ease-out]">
                    <div class="onboarding-hero relative overflow-hidden rounded-[30px] border border-[var(--glass-border)] bg-gradient-to-br from-slate-900/70 via-slate-800/70 to-blue-900/60 p-6 md:p-10">
                        <div class="absolute -top-20 -right-12 w-64 h-64 bg-cyan-500/20 blur-3xl rounded-full"></div>
                        <div class="absolute -bottom-20 -left-10 w-64 h-64 bg-indigo-500/20 blur-3xl rounded-full"></div>
                        <div class="relative z-10">
                            <div class="onboarding-badge inline-flex items-center gap-2 rounded-full border border-cyan-300/30 bg-cyan-300/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-cyan-200">Setup guidato intelligente</div>
                            <h1 class="mt-4 text-3xl md:text-5xl font-black tracking-tight text-white preserve-white leading-tight">Benvenuto su EazyTrader</h1>
                            <p class="onboarding-subtitle mt-4 max-w-2xl text-sm md:text-base text-slate-200/90 leading-relaxed">In meno di un minuto personalizziamo l'app per il tuo stile: profilo, account, sessione e priorita operative.</p>

                            <div class="mt-7 grid grid-cols-1 md:grid-cols-3 gap-3">
                                <div class="onboarding-feature-card rounded-2xl border border-[var(--glass-border)] bg-[var(--card-hover)] p-4">
                                    <div class="text-cyan-500 text-xl mb-1"><i class="ph-bold ph-chart-line-up"></i></div>
                                    <p class="text-sm font-semibold text-[var(--text-main)]">Dati chiari</p>
                                    <p class="text-xs text-[var(--text-muted)] mt-1">Metriche e review per migliorare in modo misurabile.</p>
                                </div>
                                <div class="onboarding-feature-card rounded-2xl border border-[var(--glass-border)] bg-[var(--card-hover)] p-4">
                                    <div class="text-indigo-500 text-xl mb-1"><i class="ph-bold ph-target"></i></div>
                                    <p class="text-sm font-semibold text-[var(--text-main)]">Focus operativo</p>
                                    <p class="text-xs text-[var(--text-muted)] mt-1">Regole e obiettivi sempre sotto controllo.</p>
                                </div>
                                <div class="onboarding-feature-card rounded-2xl border border-[var(--glass-border)] bg-[var(--card-hover)] p-4">
                                    <div class="text-emerald-500 text-xl mb-1"><i class="ph-bold ph-rocket-launch"></i></div>
                                    <p class="text-sm font-semibold text-[var(--text-main)]">Percorso rapido</p>
                                    <p class="text-xs text-[var(--text-muted)] mt-1">Ottimizzato per mobile, tablet e desktop.</p>
                                </div>
                            </div>

                            <div class="mt-8 flex flex-col sm:flex-row gap-3">
                                <button onclick="ui.nextOnboardingStep()" class="flex-1 rounded-2xl px-6 py-4 font-bold text-white preserve-white bg-gradient-to-r from-cyan-500 to-blue-600 hover:from-cyan-400 hover:to-blue-500 transition-all shadow-[0_15px_40px_-15px_rgba(14,165,233,0.7)]">Inizia il setup</button>
                                <button onclick="ui.skipOnboarding()" class="onboarding-skip-btn sm:w-auto rounded-2xl px-6 py-4 font-semibold text-[var(--text-muted)] border border-[var(--glass-border)] bg-[var(--card-hover)] hover:bg-[var(--input-bg)] transition-all">Salta tutto</button>
                            </div>
                        </div>
                    </div>
                </section>
            `;
        }

        if (step === 2) {
            content = `
                <section class="w-full max-w-2xl mx-auto px-4 py-6 animate-[fade-in_0.45s_ease-out]">
                    <div class="rounded-[28px] border border-[var(--glass-border)] bg-[var(--bg-card)] backdrop-blur-xl p-6 md:p-8">
                        <h2 class="text-2xl md:text-3xl font-extrabold text-[var(--text-main)] tracking-tight">Chi sei come trader?</h2>
                        <p class="mt-2 text-sm md:text-base text-[var(--text-muted)]">Due domande rapide per personalizzare dashboard e suggerimenti.</p>

                        <div class="mt-6 space-y-5">
                            <div>
                                <label for="onboarding-name" class="block text-sm font-semibold text-[var(--text-main)] mb-2">Nome o nickname</label>
                                <input type="text" id="onboarding-name" value="${this.escapeHtml(this.onboardingDraft.name || '')}" placeholder="Es. Marco, TradingPro, Alex"
                                    class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-2xl px-5 py-4 text-lg font-semibold text-[var(--text-main)] placeholder:text-[var(--text-muted)] focus:outline-none focus:border-cyan-500/50 focus:ring-4 focus:ring-cyan-500/15 transition-all" />
                            </div>

                            <div>
                                <label for="onboarding-primary-goal" class="block text-sm font-semibold text-[var(--text-main)] mb-2">Obiettivo principale adesso</label>
                                <select id="onboarding-primary-goal" class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-2xl px-4 py-3 text-[var(--text-main)] focus:outline-none focus:ring-4 focus:ring-indigo-500/15 focus:border-indigo-500/50">
                                    <option value="consistenza" ${this.onboardingDraft.goal === 'consistenza' ? 'selected' : ''}>Essere piu consistente</option>
                                    <option value="disciplina" ${this.onboardingDraft.goal === 'disciplina' ? 'selected' : ''}>Migliorare disciplina e rischio</option>
                                    <option value="crescita" ${this.onboardingDraft.goal === 'crescita' ? 'selected' : ''}>Scalare risultati nel tempo</option>
                                </select>
                            </div>
                        </div>

                        <div class="mt-8 flex flex-col sm:flex-row gap-3">
                            <button onclick="ui.nextOnboardingStep()" class="flex-1 rounded-2xl px-6 py-4 font-bold text-white preserve-white bg-gradient-to-r from-violet-600 to-indigo-600 hover:from-violet-500 hover:to-indigo-500 transition-all">Continua</button>
                            <button onclick="ui.prevOnboardingStep()" class="rounded-2xl px-6 py-4 font-semibold text-[var(--text-main)] border border-[var(--glass-border)] bg-[var(--card-hover)] hover:bg-[var(--input-bg)] transition-all">Indietro</button>
                        </div>
                    </div>
                </section>
            `;
        }

        if (step === 3) {
            const accountType = this.onboardingDraft.accountType || 'personal';
            content = `
                <section class="w-full max-w-3xl mx-auto px-4 py-6 animate-[fade-in_0.45s_ease-out]">
                    <div class="rounded-[28px] border border-[var(--glass-border)] bg-[var(--bg-card)] p-6 md:p-8">
                        <h2 class="text-2xl md:text-3xl font-extrabold text-[var(--text-main)] tracking-tight">Che account vuoi gestire?</h2>
                        <p class="mt-2 text-sm md:text-base text-[var(--text-muted)]">Seleziona una base. Potrai cambiare tutto in seguito.</p>

                        <div class="mt-6 grid grid-cols-1 gap-3">
                            <label class="group cursor-pointer">
                                <input type="radio" name="onboarding-account-type" value="funded" class="sr-only" ${accountType === 'funded' ? 'checked' : ''} onchange="ui.onboardingDraft.accountType='funded'; ui.renderOnboarding();">
                                <div class="rounded-2xl border-2 ${accountType === 'funded' ? 'border-emerald-400 bg-emerald-500/10' : 'border-[var(--glass-border)] bg-[var(--card-hover)]'} p-5 transition-all group-hover:border-emerald-400/60">
                                    <div class="flex items-center justify-between gap-4">
                                        <div>
                                            <p class="text-base font-bold text-[var(--text-main)]">Funded Account</p>
                                            <p class="text-sm text-[var(--text-muted)] mt-1">FTMO, MyFundedFutures e simili</p>
                                        </div>
                                        <i class="ph-bold ph-trophy text-2xl ${accountType === 'funded' ? 'text-emerald-400' : 'text-[var(--text-muted)]'}"></i>
                                    </div>
                                </div>
                            </label>

                            <label class="group cursor-pointer">
                                <input type="radio" name="onboarding-account-type" value="challenge" class="sr-only" ${accountType === 'challenge' ? 'checked' : ''} onchange="ui.onboardingDraft.accountType='challenge'; ui.renderOnboarding();">
                                <div class="rounded-2xl border-2 ${accountType === 'challenge' ? 'border-amber-400 bg-amber-500/10' : 'border-[var(--glass-border)] bg-[var(--card-hover)]'} p-5 transition-all group-hover:border-amber-400/60">
                                    <div class="flex items-center justify-between gap-4">
                                        <div>
                                            <p class="text-base font-bold text-[var(--text-main)]">Challenge Account</p>
                                            <p class="text-sm text-[var(--text-muted)] mt-1">Valutazione in corso verso account funded</p>
                                        </div>
                                        <i class="ph-bold ph-target text-2xl ${accountType === 'challenge' ? 'text-amber-400' : 'text-[var(--text-muted)]'}"></i>
                                    </div>
                                </div>
                            </label>

                            <label class="group cursor-pointer">
                                <input type="radio" name="onboarding-account-type" value="personal" class="sr-only" ${accountType === 'personal' ? 'checked' : ''} onchange="ui.onboardingDraft.accountType='personal'; ui.renderOnboarding();">
                                <div class="rounded-2xl border-2 ${accountType === 'personal' ? 'border-sky-400 bg-sky-500/10' : 'border-[var(--glass-border)] bg-[var(--card-hover)]'} p-5 transition-all group-hover:border-sky-400/60">
                                    <div class="flex items-center justify-between gap-4">
                                        <div>
                                            <p class="text-base font-bold text-[var(--text-main)]">Conto Personale</p>
                                            <p class="text-sm text-[var(--text-muted)] mt-1">Live o demo con il tuo capitale</p>
                                        </div>
                                        <i class="ph-bold ph-user-circle text-2xl ${accountType === 'personal' ? 'text-sky-400' : 'text-[var(--text-muted)]'}"></i>
                                    </div>
                                </div>
                            </label>
                        </div>

                        ${validation}

                        <div class="mt-8 flex flex-col sm:flex-row gap-3">
                            <button onclick="ui.nextOnboardingStep()" class="flex-1 rounded-2xl px-6 py-4 font-bold text-white preserve-white bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 transition-all">Continua</button>
                            <button onclick="ui.prevOnboardingStep()" class="rounded-2xl px-6 py-4 font-semibold text-[var(--text-main)] border border-[var(--glass-border)] bg-[var(--card-hover)] hover:bg-[var(--input-bg)] transition-all">Indietro</button>
                        </div>
                    </div>
                </section>
            `;
        }

        if (step === 4) {
            content = `
                <section class="w-full max-w-2xl mx-auto px-4 py-6 animate-[fade-in_0.45s_ease-out]">
                    <div class="rounded-[28px] border border-[var(--glass-border)] bg-[var(--bg-card)] p-6 md:p-8">
                        <h2 class="text-2xl md:text-3xl font-extrabold text-[var(--text-main)] tracking-tight">Preferenze operative</h2>
                        <p class="mt-2 text-sm md:text-base text-[var(--text-muted)]">Ultime scelte per una home su misura.</p>

                        <div class="mt-6 grid grid-cols-1 gap-4">
                            <div>
                                <label for="onboarding-primary-asset" class="block text-sm font-semibold text-[var(--text-main)] mb-2">Asset principale</label>
                                <select id="onboarding-primary-asset" class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-2xl px-4 py-3 text-[var(--text-main)] focus:outline-none focus:ring-4 focus:ring-cyan-500/15">
                                    ${assets.map(asset => `<option value="${asset}" ${asset === this.onboardingDraft.primaryAsset ? 'selected' : ''}>${asset}</option>`).join('')}
                                </select>
                            </div>
                            <div>
                                <label for="onboarding-primary-session" class="block text-sm font-semibold text-[var(--text-main)] mb-2">Sessione principale</label>
                                <select id="onboarding-primary-session" class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-2xl px-4 py-3 text-[var(--text-main)] focus:outline-none focus:ring-4 focus:ring-emerald-500/15">
                                    ${sessions.map(session => `<option value="${session}" ${session === this.onboardingDraft.primarySession ? 'selected' : ''}>${session}</option>`).join('')}
                                </select>
                            </div>
                            <div>
                                <label for="onboarding-experience-level" class="block text-sm font-semibold text-[var(--text-main)] mb-2">Livello esperienza</label>
                                <select id="onboarding-experience-level" class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-2xl px-4 py-3 text-[var(--text-main)] focus:outline-none focus:ring-4 focus:ring-fuchsia-500/15">
                                    <option value="principiante" ${this.onboardingDraft.experienceLevel === 'principiante' ? 'selected' : ''}>Principiante (0-6 mesi)</option>
                                    <option value="intermedio" ${this.onboardingDraft.experienceLevel === 'intermedio' ? 'selected' : ''}>Intermedio (6-24 mesi)</option>
                                    <option value="avanzato" ${this.onboardingDraft.experienceLevel === 'avanzato' ? 'selected' : ''}>Avanzato (2+ anni)</option>
                                </select>
                            </div>
                        </div>

                        <div class="mt-8 flex flex-col sm:flex-row gap-3">
                            <button onclick="ui.nextOnboardingStep()" class="flex-1 rounded-2xl px-6 py-4 font-bold text-white preserve-white bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-400 hover:to-orange-500 transition-all">Continua</button>
                            <button onclick="ui.prevOnboardingStep()" class="rounded-2xl px-6 py-4 font-semibold text-[var(--text-main)] border border-[var(--glass-border)] bg-[var(--card-hover)] hover:bg-[var(--input-bg)] transition-all">Indietro</button>
                        </div>
                    </div>
                </section>
            `;
        }

        if (step === 5) {
            content = `
                <section class="w-full max-w-2xl mx-auto px-4 py-6 animate-[fade-in_0.45s_ease-out]">
                    <div class="onboarding-complete-card rounded-[30px] border border-[var(--glass-border)] bg-gradient-to-br from-emerald-600/15 via-sky-600/10 to-indigo-600/20 p-7 md:p-10">
                        <div class="onboarding-complete-badge inline-flex items-center gap-2 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-emerald-600">Setup completato</div>
                        <h2 class="mt-4 text-3xl md:text-5xl font-black tracking-tight text-[var(--text-main)]">Perfetto, ${safeName}</h2>
                        <p class="mt-3 text-sm md:text-base text-[var(--text-muted)]">La tua app e pronta. Vuoi un mini tour interattivo da 30 secondi?</p>

                        <div class="mt-8 grid grid-cols-1 gap-3">
                            <button onclick="ui.completeOnboarding(false)" class="rounded-2xl px-6 py-4 font-bold text-white preserve-white bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 transition-all">Si, mostrami il tour</button>
                            <button onclick="ui.completeOnboarding(true)" class="rounded-2xl px-6 py-4 font-semibold text-[var(--text-main)] border border-[var(--glass-border)] bg-[var(--card-hover)] hover:bg-[var(--input-bg)] transition-all">No, entra subito nell'app</button>
                            <button onclick="ui.prevOnboardingStep()" class="rounded-2xl px-6 py-4 font-medium text-[var(--text-muted)] hover:text-[var(--text-main)]">Torna indietro</button>
                        </div>
                    </div>
                </section>
            `;
        }

        const shell = `
            <div class="w-full max-w-5xl mx-auto px-2">
                <div class="sticky top-0 z-20 mb-3 rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-body)] backdrop-blur-md px-3 py-3" style="opacity:0.95">
                    <div class="flex items-center justify-between gap-3 mb-2">
                        <span class="text-xs md:text-sm font-bold text-[var(--text-muted)] uppercase tracking-wider">Setup iniziale</span>
                        <span class="text-xs md:text-sm text-[var(--text-muted)]">Step ${step} / ${this.onboardingTotalSteps}</span>
                    </div>
                    <div class="h-1.5 rounded-full bg-[var(--card-hover)] overflow-hidden">
                        <div class="h-full rounded-full bg-gradient-to-r from-cyan-500 via-indigo-500 to-emerald-500 transition-all duration-500" style="width:${progress}%"></div>
                    </div>
                </div>
                ${content}
            </div>
        `;

        screen.innerHTML = shell;

        setTimeout(() => {
            const input = document.getElementById('onboarding-name');
            if (input && step === 2) input.focus();
        }, 80);
    },

    // Compatibilita con eventuale vecchio markup rimasto.
    selectAccountType(type) {
        if (!this.canRunOnboardingAction()) return;
        this.onboardingDraft.accountType = type;
        this.onboardingStep = 4;
        this.onboardingValidationMessage = '';
        this.renderOnboarding();
    },

    renderHeaderProfile() {
        const profileContainer = document.getElementById('header-profile');
        if (!profileContainer) return;

        const profile = DataStore.data.profile;
        const rawName = this.sanitizeText(profile.name || 'Trader', 40) || 'Trader';
        const name = this.escapeHtml(rawName);
        const safePhotoUrl = this.sanitizeImageUrl(profile.photoUrl || '');
        // Usa avatar se photoUrl non esiste
        const imgContent = safePhotoUrl
            ? `<img src="${this.escapeHtml(safePhotoUrl)}" class="w-full h-full object-cover">`
            : this.escapeHtml(profile.avatar || '👤');

        // Controlla se è un emoji o un'immagine per lo sfondo
        const isEmoji = !safePhotoUrl;

        profileContainer.innerHTML = `
            <div class="flex flex-col items-end mr-1 hidden md:flex">
                <span class="text-[10px] uppercase font-bold text-[var(--text-muted)] tracking-wider leading-none mb-0.5">Profilo</span>
                <span class="text-xs font-bold text-white preserve-white leading-none">${name}</span>
            </div>
            <div class="w-8 h-8 md:w-9 md:h-9 rounded-full ${isEmoji ? 'bg-gradient-to-br from-[var(--accent-blue)] to-purple-600' : ''} flex items-center justify-center text-sm shadow-md border border-white/10 overflow-hidden text-white preserve-white flex-shrink-0">
                ${imgContent}
            </div>
        `;
    },

    renderWelcomeName() {
        const welcomeName = document.getElementById('welcome-name');
        if (!welcomeName) return;

        const rawName = DataStore?.data?.profile?.name;
        const name = this.sanitizeText(typeof rawName === 'string' ? rawName : '', 40);
        welcomeName.textContent = name || 'Trader';
    },

    renderInitialModals() {
        if (!document.getElementById('modal-overlay')) {
            const overlay = document.createElement('div');
            overlay.id = 'modal-overlay';
            overlay.className = 'fixed inset-0 bg-black/60 backdrop-blur-sm z-[1300] hidden items-center justify-center p-4';
            overlay.onclick = (e) => { if (e.target === overlay) ui.closeModals(); };

            overlay.innerHTML = `
                <div id="modal-trade" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-detail" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-day" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-review" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-todo" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-edit-todo" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-edit-weekly-goal" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-goal" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-account" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-payout" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-qr" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-sync" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-edit-profile" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-setup" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-setup-view" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-montecarlo" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
                <div id="modal-license" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>
            `;
            document.body.appendChild(overlay);
        }
    },

    // === QR CODE TRANSFER ===
    qrScanner: null,
    currentQRMode: 'export',

    openQRTransferModal() {
        const modal = document.getElementById('modal-qr');

        modal.innerHTML = `
            <div class="bg-[var(--bg-card)] rounded-3xl p-8 w-full max-w-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-2xl font-bold">Trasferimento Dati QR</h3>
                    <button onclick="ui.closeQRModal()" class="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center">
                        <i class="ph-bold ph-x"></i>
                    </button>
                </div>

                <div class="flex gap-3 mb-6">
                    <button onclick="ui.switchQRMode('export')" id="qr-btn-export" 
                        class="flex-1 py-3 rounded-xl font-bold transition-all bg-[var(--accent-blue)] text-white preserve-white">
                        <i class="ph-bold ph-qr-code"></i> Esporta
                    </button>
                    <button onclick="ui.switchQRMode('import')" id="qr-btn-import" 
                        class="flex-1 py-3 rounded-xl font-bold transition-all bg-[var(--input-bg)] text-[var(--text-muted)]">
                        <i class="ph-bold ph-scan"></i> Importa
                    </button>
                </div>

                <div id="qr-export-section" class="space-y-4">
                    <div class="bg-[var(--input-bg)] rounded-2xl p-6 text-center">
                        <div class="flex items-center justify-center gap-2 mb-4">
                            <i class="ph-bold ph-info text-[var(--accent-blue)]"></i>
                            <p class="text-sm text-[var(--text-muted)]">Dimensione dati: <span class="font-bold text-white preserve-white">${DataStore.getDataSize()} KB</span></p>
                        </div>
                        <div id="qrcode-container" class="flex justify-center items-center min-h-[280px] bg-white rounded-xl p-4"></div>
                        <p class="text-xs text-[var(--text-muted)] mt-4">Scansiona questo QR Code con l'altro dispositivo</p>
                    </div>
                </div>

                <div id="qr-import-section" class="hidden space-y-4">
                    <div class="bg-[var(--input-bg)] rounded-2xl p-6">
                        <div class="flex items-center gap-2 mb-4 text-yellow-500">
                            <i class="ph-bold ph-warning"></i>
                            <p class="text-sm font-bold">Attenzione: Questo sovrascriverà tutti i dati locali</p>
                        </div>
                        <div id="qr-reader" class="rounded-xl overflow-hidden"></div>
                        <div id="qr-scan-status" class="mt-4 text-center text-sm text-[var(--text-muted)]"></div>
                    </div>
                </div>

                <div class="mt-6 p-4 bg-blue-500/10 border border-blue-500/20 rounded-xl">
                    <div class="flex items-start gap-3">
                        <i class="ph-bold ph-shield-check text-blue-500 text-xl"></i>
                        <div>
                            <h4 class="text-sm font-bold text-blue-500 mb-1">Trasferimento Sicuro</h4>
                            <p class="text-xs text-[var(--text-muted)]">I tuoi dati vengono trasferiti direttamente tra dispositivi tramite QR Code, senza passare per server esterni. Nessuna connessione internet richiesta.</p>
                        </div>
                    </div>
                </div>
            </div>
        `;

        ui.openModal('modal-qr');
        ui.currentQRMode = 'export';
        ui.generateQRCode();
    },

    switchQRMode(mode) {
        ui.currentQRMode = mode;
        const exportBtn = document.getElementById('qr-btn-export');
        const importBtn = document.getElementById('qr-btn-import');
        const exportSection = document.getElementById('qr-export-section');
        const importSection = document.getElementById('qr-import-section');

        if (mode === 'export') {
            exportBtn.className = 'flex-1 py-3 rounded-xl font-bold transition-all bg-[var(--accent-blue)] text-white preserve-white';
            importBtn.className = 'flex-1 py-3 rounded-xl font-bold transition-all bg-[var(--input-bg)] text-[var(--text-muted)]';
            exportSection.classList.remove('hidden');
            importSection.classList.add('hidden');
            if (ui.qrScanner) {
                ui.qrScanner.stop();
                ui.qrScanner = null;
            }
            ui.generateQRCode();
        } else {
            exportBtn.className = 'flex-1 py-3 rounded-xl font-bold transition-all bg-[var(--input-bg)] text-[var(--text-muted)]';
            importBtn.className = 'flex-1 py-3 rounded-xl font-bold transition-all bg-[var(--accent-blue)] text-white preserve-white';
            exportSection.classList.add('hidden');
            importSection.classList.remove('hidden');
            ui.startQRScanner();
        }
    },

    generateQRCode() {
        const container = document.getElementById('qrcode-container');
        if (!container) return;

        container.innerHTML = '<div class="flex items-center justify-center"><i class="ph-bold ph-spinner text-4xl text-[var(--accent-blue)] animate-spin"></i></div>';

        setTimeout(() => {
            try {
                const compressed = DataStore.compressData();

                // Verifica se i dati sono troppo grandi per un QR code
                if (compressed.length > 2953) {
                    container.innerHTML = `
                        <div class="text-center space-y-3">
                            <i class="ph-bold ph-warning-circle text-4xl text-yellow-500"></i>
                            <p class="text-sm text-[var(--text-muted)]">I dati sono troppo grandi per essere codificati in un singolo QR code.</p>
                            <p class="text-xs text-[var(--text-muted)]">Dimensione: ${(compressed.length / 1024).toFixed(2)} KB (max 2.9 KB)</p>
                            <button onclick="DataStore.downloadBackup()" class="mt-3 px-4 py-2 rounded-xl bg-[var(--accent-blue)] text-white preserve-white text-sm font-bold">
                                <i class="ph-bold ph-download-simple"></i> Scarica Backup JSON
                            </button>
                        </div>
                    `;
                    return;
                }

                container.innerHTML = '';

                new QRCode(container, {
                    text: compressed,
                    width: 256,
                    height: 256,
                    colorDark: '#000000',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.L
                });
            } catch (e) {
                console.error('QR Code generation error:', e);
                container.innerHTML = `
                    <div class="text-center space-y-3">
                        <i class="ph-bold ph-warning-circle text-4xl text-red-500"></i>
                        <p class="text-sm text-red-500 font-bold">Errore nella generazione del QR Code</p>
                        <p class="text-xs text-[var(--text-muted)]">${e.message || 'Errore sconosciuto'}</p>
                        <button onclick="DataStore.downloadBackup()" class="mt-3 px-4 py-2 rounded-xl bg-[var(--accent-blue)] text-white preserve-white text-sm font-bold">
                            <i class="ph-bold ph-download-simple"></i> Scarica Backup JSON invece
                        </button>
                    </div>
                `;
            }
        }, 100);
    },

    startQRScanner() {
        const readerElement = document.getElementById('qr-reader');
        const statusElement = document.getElementById('qr-scan-status');

        if (!readerElement) return;

        // Pulisci sempre lo scanner precedente per forzare nuova richiesta permessi
        if (ui.qrScanner) {
            try {
                ui.qrScanner.stop().catch(() => { });
                ui.qrScanner.clear();
            } catch (e) {
                // Ignora errori di cleanup
            }
            ui.qrScanner = null;
        }

        // Pulisci il contenitore
        readerElement.innerHTML = '';

        statusElement.innerHTML = '<i class="ph-bold ph-spinner animate-spin"></i> Inizializzazione fotocamera...';

        ui.qrScanner = new Html5Qrcode('qr-reader');

        const config = { fps: 10, qrbox: { width: 250, height: 250 } };

        ui.qrScanner.start(
            { facingMode: 'environment' },
            config,
            (decodedText) => {
                // QR Code rilevato
                statusElement.innerHTML = '<i class="ph-bold ph-check-circle text-green-500"></i> QR Code rilevato! Importazione in corso...';

                ui.qrScanner.stop().then(() => {
                    try {
                        DataStore.decompressAndImport(decodedText);
                        statusElement.innerHTML = '<div class="text-green-500 font-bold"><i class="ph-bold ph-check-circle"></i> Dati importati con successo!</div>';

                        setTimeout(() => {
                            ui.closeQRModal();
                            setTimeout(() => location.reload(), 1500);
                        }, 1500);
                    } catch (e) {
                        statusElement.innerHTML = `<div class="text-red-500"><i class="ph-bold ph-warning-circle"></i> ${e.message}</div>`;
                        setTimeout(() => ui.startQRScanner(), 2000);
                    }
                }).catch(err => {
                    console.error('Stop error:', err);
                });
            },
            (errorMessage) => {
                // Errore di scansione (normale durante la ricerca)
            }
        ).catch(err => {
            console.error('Camera error:', err);

            // Determina il tipo di errore
            const errorMsg = err.message || err.toString();
            const isPermissionDenied = errorMsg.includes('Permission') ||
                errorMsg.includes('denied') ||
                errorMsg.includes('NotAllowedError') ||
                errorMsg.includes('NotFoundError');

            if (isPermissionDenied) {
                statusElement.innerHTML = `
                    <div class="space-y-4 p-4 bg-red-500/10 rounded-xl border border-red-500/30">
                        <div class="text-red-500 text-sm font-bold flex items-center gap-2 justify-center">
                            <i class="ph-bold ph-warning-circle text-xl"></i>
                            <span>Accesso fotocamera negato</span>
                        </div>
                        <div class="text-xs text-[var(--text-muted)] space-y-2">
                            <p>Per scansionare QR code devi permettere l'accesso alla fotocamera.</p>
                            <p class="font-bold">Come risolvere:</p>
                            <ol class="list-decimal list-inside space-y-1 text-left">
                                <li>Clicca sull'icona <i class="ph-bold ph-lock"></i> nella barra degli indirizzi</li>
                                <li>Seleziona "Consenti" per la fotocamera</li>
                                <li>Ricarica la pagina o clicca "Riprova"</li>
                            </ol>
                        </div>
                        <button onclick="ui.startQRScanner()" 
                            class="w-full py-3 rounded-xl bg-[var(--accent-blue)] text-white preserve-white font-bold hover:opacity-90 transition-all">
                            <i class="ph-bold ph-arrow-clockwise"></i> Riprova
                        </button>
                    </div>
                `;
            } else {
                statusElement.innerHTML = `
                    <div class="space-y-4 p-4 bg-yellow-500/10 rounded-xl border border-yellow-500/30">
                        <div class="text-yellow-500 text-sm font-bold">
                            <i class="ph-bold ph-warning-circle"></i> Fotocamera non disponibile
                        </div>
                        <p class="text-xs text-[var(--text-muted)]">${errorMsg}</p>
                        <button onclick="ui.startQRScanner()" 
                            class="w-full py-3 rounded-xl bg-[var(--accent-blue)] text-white preserve-white font-bold">
                            <i class="ph-bold ph-arrow-clockwise"></i> Riprova
                        </button>
                    </div>
                `;
            }

            // Pulisci lo scanner in caso di errore
            ui.qrScanner = null;
        });

        statusElement.innerHTML = '<i class="ph-bold ph-camera text-[var(--accent-blue)]"></i> Inquadra il QR Code...';
    },

    closeQRModal() {
        if (ui.qrScanner) {
            ui.qrScanner.stop().catch(err => console.error('Stop error:', err));
            ui.qrScanner = null;
        }

        const modal = document.getElementById('modal-qr');
        const overlay = document.getElementById('modal-overlay');

        if (modal) {
            modal.classList.add('hidden');
            modal.classList.remove('scale-100');
            modal.classList.add('scale-95');
        }

        if (overlay) {
            overlay.classList.remove('flex');
            overlay.classList.add('hidden');
        }
    },

    // === P2P SYNC SYSTEM ===
    peer: null,
    peerConnection: null,
    syncScanner: null,
    syncMode: null, // 'send' or 'receive'

    openP2PSyncModal() {
        const modal = document.getElementById('modal-sync');

        modal.innerHTML = `
            <div class="bg-[var(--bg-card)] rounded-[32px] w-full max-w-2xl max-h-[90vh] overflow-hidden flex flex-col">
                
                <!-- Header -->
                <div class="flex items-center justify-between px-8 py-6 border-b border-white/5 flex-shrink-0">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500/20 to-blue-500/5 border border-blue-500/30 flex items-center justify-center">
                            <i class="ph-bold ph-arrows-left-right text-xl text-blue-400"></i>
                        </div>
                        <div>
                            <p class="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Sincronizzazione P2P</p>
                            <h3 class="text-xl font-bold text-white preserve-white">Trasferimento Diretto</h3>
                        </div>
                    </div>
                    <button onclick="ui.closeP2PSyncModal()" class="group w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all text-[var(--text-muted)] hover:text-white preserve-white">
                        <i class="ph-bold ph-x text-lg group-hover:rotate-90 transition-transform"></i>
                    </button>
                </div>

                <!-- Content -->
                <div class="flex-1 overflow-y-auto custom-scrollbar px-8 py-6">
                    
                    <!-- Mode Selection -->
                    <div id="sync-mode-selection" class="space-y-4">
                        <div class="bg-gradient-to-br from-blue-500/10 to-blue-500/5 border border-blue-500/20 rounded-2xl p-6">
                            <div class="flex items-start gap-3 mb-6">
                                <i class="ph-bold ph-info text-blue-400 text-xl"></i>
                                <div>
                                    <h4 class="text-sm font-bold text-blue-400 mb-1">Sincronizzazione Peer-to-Peer</h4>
                                    <p class="text-xs text-[var(--text-muted)] leading-relaxed">Trasferisci i tuoi dati in modo sicuro e diretto tra dispositivi. Nessun server, nessuna registrazione, solo una connessione cifrata temporanea.</p>
                                </div>
                            </div>
                            
                            <div class="bg-white/5 rounded-xl p-4 mb-4">
                                <div class="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                                    <i class="ph-bold ph-database"></i>
                                    <span>Dimensione dati: <strong class="text-white preserve-white">${DataStore.getDataSize()} KB</strong></span>
                                </div>
                            </div>
                        </div>

                        <div class="grid grid-cols-2 gap-4">
                            <button onclick="ui.startP2PSend()" class="group relative bg-gradient-to-br from-green-500/10 to-green-500/5 border-2 border-green-500/20 rounded-2xl p-6 hover:border-green-500/40 transition-all">
                                <div class="flex flex-col items-center gap-4">
                                    <div class="w-16 h-16 rounded-2xl bg-green-500/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                                        <i class="ph-bold ph-upload-simple text-3xl text-green-400"></i>
                                    </div>
                                    <div class="text-center">
                                        <p class="text-base font-bold text-white preserve-white mb-1">Invia Dati</p>
                                        <p class="text-xs text-[var(--text-muted)]">Genera codice QR</p>
                                    </div>
                                </div>
                            </button>
                            
                            <button onclick="ui.startP2PReceive()" class="group relative bg-gradient-to-br from-purple-500/10 to-purple-500/5 border-2 border-purple-500/20 rounded-2xl p-6 hover:border-purple-500/40 transition-all">
                                <div class="flex flex-col items-center gap-4">
                                    <div class="w-16 h-16 rounded-2xl bg-purple-500/20 flex items-center justify-center group-hover:scale-110 transition-transform">
                                        <i class="ph-bold ph-download-simple text-3xl text-purple-400"></i>
                                    </div>
                                    <div class="text-center">
                                        <p class="text-base font-bold text-white preserve-white mb-1">Ricevi Dati</p>
                                        <p class="text-xs text-[var(--text-muted)]">Scansiona codice</p>
                                    </div>
                                </div>
                            </button>
                        </div>
                    </div>

                    <!-- Send Mode -->
                    <div id="sync-send-section" class="hidden space-y-4">
                        <button onclick="ui.resetP2PSync()" class="flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-white preserve-white transition-colors mb-4">
                            <i class="ph-bold ph-arrow-left"></i>
                            Indietro
                        </button>
                        
                        <div class="bg-gradient-to-br from-green-500/10 to-green-500/5 border border-green-500/20 rounded-2xl p-6">
                            <div class="text-center mb-4">
                                <h4 class="text-lg font-bold text-green-400 mb-2">Modalità Invio Attiva</h4>
                                <p class="text-sm text-[var(--text-muted)]">In attesa di connessione...</p>
                            </div>
                            
                            <div id="sync-qr-container" class="bg-white rounded-2xl p-6 flex items-center justify-center min-h-[280px]">
                                <i class="ph-bold ph-spinner text-4xl text-gray-400 animate-spin"></i>
                            </div>
                            
                            <div id="sync-connection-status" class="mt-4 text-center">
                                <div class="flex items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
                                    <div class="w-2 h-2 rounded-full bg-yellow-500 animate-pulse"></div>
                                    <span>In attesa di connessione dal dispositivo ricevente...</span>
                                </div>
                            </div>
                            
                            <div id="sync-progress-container" class="hidden mt-4">
                                <div class="bg-white/5 rounded-xl p-4">
                                    <div class="flex items-center justify-between mb-2">
                                        <span class="text-xs font-bold text-[var(--text-muted)]">Invio in corso</span>
                                        <span id="sync-progress-text" class="text-xs font-bold text-green-400">0%</span>
                                    </div>
                                    <div class="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                                        <div id="sync-progress-bar" class="h-full bg-gradient-to-r from-green-500 to-green-400 transition-all duration-300" style="width: 0%"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <!-- Receive Mode -->
                    <div id="sync-receive-section" class="hidden space-y-4">
                        <button onclick="ui.resetP2PSync()" class="flex items-center gap-2 text-sm text-[var(--text-muted)] hover:text-white preserve-white transition-colors mb-4">
                            <i class="ph-bold ph-arrow-left"></i>
                            Indietro
                        </button>
                        
                        <div class="bg-gradient-to-br from-purple-500/10 to-purple-500/5 border border-purple-500/20 rounded-2xl p-6">
                            <div class="text-center mb-4">
                                <h4 class="text-lg font-bold text-purple-400 mb-2">Modalità Ricezione Attiva</h4>
                                <p class="text-sm text-[var(--text-muted)]">Scansiona il codice QR del dispositivo mittente</p>
                            </div>
                            
                            <div class="bg-gradient-to-br from-blue-500/10 to-blue-500/5 border border-blue-500/30 rounded-xl p-4 mb-4">
                                <div class="flex items-start gap-3">
                                    <i class="ph-bold ph-info text-blue-400 text-lg"></i>
                                    <div>
                                        <p class="text-xs font-bold text-blue-400 mb-1">Sincronizzazione Intelligente</p>
                                        <p class="text-xs text-[var(--text-muted)]">Solo i dati nuovi o modificati verranno sincronizzati. I tuoi dati esistenti saranno preservati. L'app si ricaricherà automaticamente.</p>
                                    </div>
                                </div>
                            </div>
                            
                            <div id="sync-scanner-container" class="bg-black rounded-2xl overflow-hidden"></div>
                            
                            <div id="sync-receive-status" class="mt-4 text-center">
                                <div class="flex items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
                                    <i class="ph-bold ph-camera text-purple-400"></i>
                                    <span>Inizializzazione fotocamera...</span>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>

                <!-- Footer -->
                <div class="px-8 py-5 border-t border-white/5 flex-shrink-0">
                    <div class="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                        <i class="ph-bold ph-lock-simple text-blue-400"></i>
                        <span>Connessione cifrata end-to-end • Nessun dato salvato su server</span>
                    </div>
                </div>

            </div>
        `;

        ui.openModal('modal-sync');
    },

    async startP2PSend() {
        document.getElementById('sync-mode-selection').classList.add('hidden');
        document.getElementById('sync-send-section').classList.remove('hidden');

        ui.syncMode = 'send';

        // Mostra dettagli dei dati da inviare
        const dataToSend = {
            trades: DataStore.data.trades.length,
            accounts: DataStore.data.accounts.length,
            reviews: DataStore.data.reviews.length,
            todos: DataStore.data.todos.length,
            weeklyGoals: DataStore.data.weeklyGoals.length
        };

        const totalItems = Object.values(dataToSend).reduce((a, b) => a + b, 0);
        const dataSize = DataStore.getDataSize();

        // Recupera storico invii
        const sendHistory = JSON.parse(localStorage.getItem('p2p_send_history') || '[]');

        // Mostra preview dati
        const qrContainer = document.getElementById('sync-qr-container');
        qrContainer.innerHTML = `
            <div class="space-y-4">
                <!-- Dati da inviare - Design Minimal -->
                <div class="bg-white/5 rounded-2xl p-5 border border-white/10">
                    <div class="flex items-center justify-between mb-4">
                        <span class="text-sm font-medium text-[var(--text-muted)]">Dati da inviare</span>
                        <span class="text-2xl font-bold text-green-400">${totalItems}</span>
                    </div>
                    <div class="flex items-center justify-between text-xs">
                        <span class="text-[var(--text-muted)]">Dimensione totale</span>
                        <span class="font-bold text-white preserve-white">${dataSize} KB</span>
                    </div>
                </div>
                
                <!-- Storico invii -->
                ${sendHistory.length > 0 ? `
                <div class="bg-white/5 rounded-xl p-4">
                    <div class="flex items-center gap-2 mb-3">
                        <i class="ph-bold ph-clock-clockwise text-blue-400"></i>
                        <h4 class="text-xs font-bold text-blue-400">Ultimi Invii</h4>
                    </div>
                    <div class="space-y-2 max-h-32 overflow-y-auto custom-scrollbar">
                        ${sendHistory.slice(-3).reverse().map(h => `
                            <div class="flex items-center justify-between text-xs bg-white/5 rounded-lg p-2">
                                <div>
                                    <div class="font-bold">${h.items} elementi</div>
                                    <div class="text-[var(--text-muted)] text-[10px]">${new Date(h.timestamp).toLocaleString('it-IT', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}</div>
                                </div>
                                <div class="text-green-400">
                                    <i class="ph-fill ph-check-circle"></i>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>
                ` : ''}
                
                <!-- QR Code placeholder -->
                <div id="qr-code-area" class="bg-white rounded-xl p-4 flex items-center justify-center min-h-[200px]">
                    <i class="ph-bold ph-spinner text-4xl text-gray-400 animate-spin"></i>
                </div>
            </div>
        `;

        // Genera un ID peer univoco
        const peerId = 'eazytrader-' + Math.random().toString(36).substring(2, 15);

        // Inizializza PeerJS
        ui.peer = new Peer(peerId, {
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            }
        });

        ui.peer.on('open', (id) => {
            console.log('📱 Peer ID generato:', id);

            // Crea un payload semplice con solo ID
            const peerPayload = {
                action: 'p2p',
                id: id,
                app: 'EazyTrader'
            };

            // Genera QR Code con payload JSON nel nuovo container
            const qrArea = document.getElementById('qr-code-area');
            if (!qrArea) return;
            qrArea.innerHTML = '';

            try {
                new QRCode(qrArea, {
                    text: JSON.stringify(peerPayload),
                    width: 280, // Aumentato da 256
                    height: 280,
                    colorDark: '#000000',
                    colorLight: '#ffffff',
                    correctLevel: QRCode.CorrectLevel.H // Livello massimo correzione errori
                });

                // Scroll automatico per mostrare il QR code
                setTimeout(() => {
                    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 100);
            } catch (e) {
                container.innerHTML = `<div class="text-red-500 text-sm"><i class="ph-bold ph-warning-circle"></i> Errore generazione QR: ${e.message}</div>`;
            }
        });

        ui.peer.on('connection', async (conn) => {
            console.log('📱 Connessione ricevuta da:', conn.peer);
            ui.peerConnection = conn;

            const statusEl = document.getElementById('sync-connection-status');

            // 🔒 CONFERMA DI SICUREZZA - Mostra popup personalizzato
            ui.showP2PAuthorizationModal(async (authorized) => {
                if (!authorized) {
                    console.log('❌ Connessione rifiutata dall\'utente');
                    statusEl.innerHTML = `
                        <div class="flex items-center justify-center gap-2 text-sm text-red-400">
                            <i class="ph-fill ph-warning-circle"></i>
                            <span>Connessione rifiutata</span>
                        </div>
                    `;
                    conn.close();
                    return;
                }

                // AUTORIZZATO - Procedi con l'invio
                statusEl.innerHTML = `
                    <div class="flex items-center justify-center gap-2 text-sm text-green-400">
                        <div class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                        <span>Autorizzato! Preparazione dati...</span>
                    </div>
                `;

                // Variabili accessibili in tutto lo scope
                let compressed, sizeKB, totalItems;

                try {
                    // Ricarica dati freschi da IndexedDB
                    await DataStore.loadFromIndexedDB();

                    // Prepara TUTTI i dati (non incrementale)
                    const fullData = {
                        trades: DataStore.data.trades,
                        accounts: DataStore.data.accounts,
                        reviews: DataStore.data.reviews,
                        todos: DataStore.data.todos,
                        weeklyGoals: DataStore.data.weeklyGoals,
                        settings: DataStore.data.settings,
                        syncTimestamp: Date.now()
                    };

                    totalItems = fullData.trades.length + fullData.accounts.length +
                        fullData.reviews.length + fullData.todos.length +
                        fullData.weeklyGoals.length;

                    statusEl.innerHTML = `
                        <div class="flex items-center justify-center gap-2 text-sm text-green-400">
                            <div class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                            <span>Compressione ${totalItems} elementi...</span>
                        </div>
                    `;

                    // Comprimi i dati
                    compressed = LZString.compressToBase64(JSON.stringify(fullData));
                    sizeKB = (compressed.length / 1024).toFixed(2);

                    console.log(`📦 Dati compressi: ${sizeKB} KB`);
                    console.log('📤 Invio dati compressi:', sizeKB, 'KB');

                    // Mostra progress bar
                    document.getElementById('sync-progress-container').classList.remove('hidden');

                    // Dividi in chunk per evitare il limite "message-too-big"
                    const CHUNK_SIZE = 16000; // 16KB per chunk
                    const chunks = [];

                    for (let i = 0; i < compressed.length; i += CHUNK_SIZE) {
                        chunks.push(compressed.slice(i, i + CHUNK_SIZE));
                    }

                    console.log(`📦 Dati divisi in ${chunks.length} chunk`);

                    // Invia metadata prima
                    conn.send({
                        type: 'eazytrader-sync-start',
                        totalChunks: chunks.length,
                        size: sizeKB,
                        totalItems: totalItems
                    });

                    // Invia chunk uno alla volta
                    let sentChunks = 0;
                    chunks.forEach((chunk, index) => {
                        setTimeout(() => {
                            conn.send({
                                type: 'eazytrader-sync-chunk',
                                index: index,
                                data: chunk,
                                isLast: index === chunks.length - 1
                            });

                            sentChunks++;
                            const progress = Math.round((sentChunks / chunks.length) * 100);
                            document.getElementById('sync-progress-bar').style.width = progress + '%';
                            document.getElementById('sync-progress-text').textContent = progress + '%';

                            console.log(`📤 Chunk ${index + 1}/${chunks.length} inviato`);

                            // Chiudi connessione dopo ultimo chunk + 2 secondi
                            if (index === chunks.length - 1) {
                                setTimeout(() => {
                                    console.log('✅ Trasferimento completato, chiusura connessione');
                                    conn.close();

                                    // Salva nello storico
                                    const sendHistory = JSON.parse(localStorage.getItem('p2p_send_history') || '[]');
                                    sendHistory.push({
                                        timestamp: Date.now(),
                                        items: totalItems,
                                        size: sizeKB,
                                        success: true
                                    });
                                    // Mantieni solo ultimi 10
                                    if (sendHistory.length > 10) sendHistory.shift();
                                    localStorage.setItem('p2p_send_history', JSON.stringify(sendHistory));

                                    statusEl.innerHTML = `
                                        <div class="flex items-center justify-center gap-2 text-sm text-green-400">
                                            <i class="ph-fill ph-check-circle text-xl"></i>
                                            <span>Dati inviati con successo!</span>
                                        </div>
                                    `;

                                    setTimeout(() => {
                                        ui.closeP2PSyncModal();
                                    }, 2000);
                                }, 2000);
                            }
                        }, index * 50); // 50ms di delay tra chunk
                    });

                } catch (err) {
                    console.error('❌ Errore preparazione/invio dati:', err);
                    statusEl.innerHTML = `
                        <div class="flex items-center justify-center gap-2 text-sm text-red-400">
                            <i class="ph-fill ph-warning-circle"></i>
                            <span>Errore: ${err.message}</span>
                        </div>
                    `;
                    conn.close();
                }
            });

            // Handler errori connessione
            conn.on('error', (err) => {
                console.error('❌ Errore connessione P2P:', err);
                const statusEl = document.getElementById('sync-connection-status');
                statusEl.innerHTML = `
                    <div class="flex items-center justify-center gap-2 text-sm text-red-400">
                        <i class="ph-fill ph-warning-circle"></i>
                        <span>Errore connessione: ${err.type || err.message}</span>
                    </div>
                `;
            });
        });

        ui.peer.on('error', (err) => {
            console.error('Peer error:', err);
            const statusEl = document.getElementById('sync-connection-status');
            statusEl.innerHTML = `
                <div class="text-red-500 text-sm">
                    <i class="ph-bold ph-warning-circle"></i> Errore: ${err.message}
                </div>
            `;
        });
    },

    startP2PReceive() {
        document.getElementById('sync-mode-selection').classList.add('hidden');
        document.getElementById('sync-receive-section').classList.remove('hidden');

        ui.syncMode = 'receive';

        const scannerContainer = document.getElementById('sync-scanner-container');
        const statusEl = document.getElementById('sync-receive-status');

        statusEl.innerHTML = `
            <div class="flex items-center justify-center gap-2 text-sm text-[var(--text-muted)]">
                <i class="ph-bold ph-spinner animate-spin"></i>
                <span>Inizializzazione fotocamera...</span>
            </div>
        `;

        ui.syncScanner = new Html5Qrcode('sync-scanner-container');

        const config = {
            fps: 30, // Aumentato per scansione più veloce
            qrbox: { width: 300, height: 300 }, // Area più grande
            disableFlip: false
        };

        ui.syncScanner.start(
            { facingMode: 'environment' },
            config,
            (decodedText) => {
                console.log('📥 QR Code rilevato');

                ui.syncScanner.stop().then(() => {
                    console.log('📷 Scanner fermato');

                    try {
                        const qrData = JSON.parse(decodedText);

                        // Check if it's a valid P2P payload
                        if (qrData.action === 'p2p' && qrData.id) {
                            ui.connectToPeer(qrData.id);
                        } else {
                            throw new Error('QR Code non valido');
                        }
                    } catch (e) {
                        statusEl.innerHTML = `
                            <div class="flex items-center justify-center gap-2 text-sm text-red-500">
                                <i class="ph-bold ph-warning-circle"></i>
                                <span>QR Code non valido</span>
                            </div>
                        `;
                        // Restart scanner after 2 seconds
                        setTimeout(() => ui.startP2PReceive(), 2000);
                    }
                }).catch(err => {
                    console.error('Failed to stop scanner', err);
                });

            },
            (errorMessage) => {
                // Parse error, ignore common errors
            }
        ).catch((err) => {
            console.error('Camera start error:', err);
            statusEl.innerHTML = `
                <div class="flex flex-col items-center justify-center gap-2 text-sm text-red-500 p-4 text-center">
                    <i class="ph-bold ph-warning-circle text-2xl"></i>
                    <span class="font-bold">Errore fotocamera</span>
                    <span class="text-xs opacity-80">${err.message || 'Permesso negato o dispositivo non supportato'}</span>
                    <button onclick="ui.startP2PReceive()" class="mt-2 bg-white/10 px-4 py-2 rounded-lg hover:bg-white/20 transition-all text-xs">Riprova</button>
                </div>
            `;
        });
    },

    connectToPeer(peerId) {
        const statusEl = document.getElementById('sync-receive-status');
        const scannerContainer = document.getElementById('sync-scanner-container');

        statusEl.innerHTML = `
            <div class="flex items-center justify-center gap-2 text-sm text-blue-400">
                <i class="ph-bold ph-spinner animate-spin"></i>
                <span>Connessione in corso...</span>
            </div>
        `;

        // Inizializza PeerJS per ricevere
        const receiverId = 'eazytrader-' + Math.random().toString(36).substring(2, 15);
        ui.peer = new Peer(receiverId, {
            config: {
                iceServers: [
                    { urls: 'stun:stun.l.google.com:19302' },
                    { urls: 'stun:stun1.l.google.com:19302' }
                ]
            }
        });

        ui.peer.on('open', () => {
            console.log('🔌 Connessione a peer:', peerId);

            const conn = ui.peer.connect(peerId, {
                reliable: true,
                serialization: 'json'
            });

            ui.peerConnection = conn;

            conn.on('open', () => {
                console.log('✅ Connessione aperta');
                statusEl.innerHTML = `
                    <div class="flex items-center justify-center gap-2 text-sm text-green-400">
                        <div class="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
                        <span>Connesso! In attesa dati...</span>
                    </div>
                `;
            });

            // Buffer per riassemblare i chunk
            let chunks = [];
            let totalChunks = 0;
            let receivedChunks = 0;
            let syncMetadata = null;

            conn.on('data', async (message) => {
                // Ricevi metadata iniziale
                if (message.type === 'eazytrader-sync-start') {
                    console.log('📦 Inizio ricezione:', message.totalChunks, 'chunk,', message.size, 'KB');
                    totalChunks = message.totalChunks;
                    syncMetadata = message;
                    chunks = new Array(totalChunks);
                    receivedChunks = 0;

                    // Mostra dettagli dati in arrivo
                    scannerContainer.innerHTML = `
                        <div class="bg-gradient-to-br from-purple-500/10 to-purple-500/5 border border-purple-500/20 rounded-xl p-4">
                            <div class="flex items-center gap-2 mb-3">
                                <i class="ph-bold ph-download-simple text-purple-400 text-xl"></i>
                                <h4 class="text-sm font-bold text-purple-400">Ricezione Dati in Corso</h4>
                            </div>
                            <div class="space-y-3">
                                <div class="bg-white/5 rounded-lg p-3">
                                    <div class="flex items-center justify-between mb-2">
                                        <span class="text-xs text-[var(--text-muted)]">Elementi totali</span>
                                        <span class="text-sm font-bold text-purple-400">${message.totalItems || '...'}</span>
                                    </div>
                                    <div class="flex items-center justify-between">
                                        <span class="text-xs text-[var(--text-muted)]">Dimensione</span>
                                        <span class="text-sm font-bold">${message.size} KB</span>
                                    </div>
                                </div>
                                <div class="bg-white/5 rounded-lg p-3">
                                    <div class="flex items-center justify-between mb-2">
                                        <span class="text-xs font-bold text-[var(--text-muted)]">Progresso</span>
                                        <span id="receive-progress-text" class="text-xs font-bold text-purple-400">0%</span>
                                    </div>
                                    <div class="w-full bg-white/10 rounded-full h-2 overflow-hidden">
                                        <div id="receive-progress-bar" class="h-full bg-gradient-to-r from-purple-500 to-purple-400 transition-all duration-300" style="width: 0%"></div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    `;

                    statusEl.innerHTML = `
                        <div class="flex items-center justify-center gap-2 text-sm text-blue-400">
                            <i class="ph-bold ph-spinner animate-spin"></i>
                            <span>Ricezione dati (0/${totalChunks})...</span>
                        </div>
                    `;
                    return;
                }

                // Ricevi chunk di dati
                if (message.type === 'eazytrader-sync-chunk') {
                    chunks[message.index] = message.data;
                    receivedChunks++;

                    const progress = Math.round((receivedChunks / totalChunks) * 100);
                    console.log(`📥 Chunk ${message.index + 1}/${totalChunks} ricevuto (${progress}%)`);

                    // Aggiorna progress bar
                    const progressBar = document.getElementById('receive-progress-bar');
                    const progressText = document.getElementById('receive-progress-text');
                    if (progressBar) progressBar.style.width = progress + '%';
                    if (progressText) progressText.textContent = progress + '%';

                    statusEl.innerHTML = `
                        <div class="flex items-center justify-center gap-2 text-sm text-blue-400">
                            <i class="ph-bold ph-spinner animate-spin"></i>
                            <span>Ricezione dati (${receivedChunks}/${totalChunks})...</span>
                        </div>
                    `;

                    // Se è l'ultimo chunk, riassembla e processa
                    if (message.isLast && receivedChunks === totalChunks) {
                        console.log('✅ Tutti i chunk ricevuti, riassemblaggio...');

                        statusEl.innerHTML = `
                            <div class="flex items-center justify-center gap-2 text-sm text-blue-400">
                                <i class="ph-bold ph-spinner animate-spin"></i>
                                <span>Importazione dati...</span>
                            </div>
                        `;

                        try {
                            // Riassembla i chunk
                            const compressed = chunks.join('');

                            // Decomprimi i dati
                            const decompressed = LZString.decompressFromBase64(compressed);
                            const fullData = JSON.parse(decompressed);

                            console.log('📥 Import completo in corso...');

                            // PULISCI IL DB LOCALE e INSERISCI TUTTI I NUOVI DATI
                            await db.transaction('rw', db.trades, db.accounts, db.reviews, db.todos, db.weeklyGoals, db.settings, async () => {
                                // Pulisci tabelle
                                await db.trades.clear();
                                await db.accounts.clear();
                                await db.reviews.clear();
                                await db.todos.clear();
                                await db.weeklyGoals.clear();

                                // Inserisci nuovi dati
                                if (fullData.trades && fullData.trades.length) await db.trades.bulkPut(fullData.trades);
                                if (fullData.accounts && fullData.accounts.length) await db.accounts.bulkPut(fullData.accounts);
                                if (fullData.reviews && fullData.reviews.length) await db.reviews.bulkPut(fullData.reviews);
                                if (fullData.todos && fullData.todos.length) await db.todos.bulkPut(fullData.todos);
                                if (fullData.weeklyGoals && fullData.weeklyGoals.length) await db.weeklyGoals.bulkPut(fullData.weeklyGoals);

                                // Aggiorna settings
                                if (fullData.settings) {
                                    await db.settings.put({ key: 'main', value: fullData.settings });
                                }
                            });

                            console.log('✅ Database aggiornato con successo');

                            // Ricarica dati in memoria
                            await DataStore.loadFromIndexedDB();

                            statusEl.innerHTML = `
                                <div class="flex items-center justify-center gap-2 text-sm text-green-400">
                                    <i class="ph-fill ph-check-circle text-xl"></i>
                                    <span>Dati importati con successo! (${syncMetadata.totalItems} elementi)</span>
                                </div>
                            `;

                            setTimeout(() => {
                                ui.closeP2PSyncModal();

                                // Ricarica la UI
                                console.log('🔄 Ricaricamento UI...');
                                if (router.currentPage && ui[router.currentPage]) {
                                    ui[router.currentPage]();
                                } else {
                                    location.reload();
                                }
                            }, 2000);

                        } catch (err) {
                            console.error('❌ Errore importazione:', err);
                            statusEl.innerHTML = `
                                <div class="flex items-center justify-center gap-2 text-sm text-red-400">
                                    <i class="ph-fill ph-warning-circle"></i>
                                    <span>Errore durante l'importazione: ${err.message}</span>
                                </div>
                            `;
                        }
                    }
                }
            });

            conn.on('error', (err) => {
                console.error('❌ Errore connessione:', err);
                statusEl.innerHTML = `
                    <div class="flex items-center justify-center gap-2 text-sm text-red-400">
                        <i class="ph-fill ph-warning-circle"></i>
                        <span>Errore durante la connessione</span>
                    </div>
                `;
            });
        });

        ui.peer.on('error', (err) => {
            console.error('❌ Errore Peer:', err);
            statusEl.innerHTML = `
                <div class="flex items-center justify-center gap-2 text-sm text-red-400">
                    <i class="ph-fill ph-warning-circle"></i>
                    <span>Errore durante la connessione P2P</span>
                </div>
            `;
        });
    },

    resetP2PSync() {
        // Ferma lo scanner se attivo
        if (ui.syncScanner) {
            try {
                ui.syncScanner.stop().then(() => {
                    console.log('📷 Scanner fermato da reset');
                    ui.syncScanner.clear().catch(e => console.log('Clear scanner:', e));
                    ui.syncScanner = null;
                }).catch(err => {
                    console.error('Errore stop scanner:', err);
                    ui.syncScanner = null;
                });
            } catch (err) {
                console.error('Errore fermata scanner:', err);
                ui.syncScanner = null;
            }
        }

        // Chiudi connessioni attive
        if (ui.peerConnection) {
            ui.peerConnection.close();
            ui.peerConnection = null;
        }

        if (ui.peer) {
            ui.peer.destroy();
            ui.peer = null;
        }

        // Torna alla selezione modalità
        document.getElementById('sync-send-section').classList.add('hidden');
        document.getElementById('sync-receive-section').classList.add('hidden');
        document.getElementById('sync-mode-selection').classList.remove('hidden');

        ui.syncMode = null;
    },

    closeP2PSyncModal() {
        // Ferma lo scanner se attivo
        if (ui.syncScanner) {
            try {
                ui.syncScanner.stop().then(() => {
                    console.log('📷 Scanner fermato da close');
                    ui.syncScanner.clear().catch(e => console.log('Clear scanner:', e));
                    ui.syncScanner = null;
                }).catch(err => {
                    console.error('Errore stop scanner:', err);
                    ui.syncScanner = null;
                });
            } catch (err) {
                console.error('Errore fermata scanner:', err);
                ui.syncScanner = null;
            }
        }

        // Pulisci connessioni
        if (ui.peerConnection) {
            ui.peerConnection.close();
            ui.peerConnection = null;
        }

        if (ui.peer) {
            ui.peer.destroy();
            ui.peer = null;
        }

        ui.closeModals();
    },

    showP2PAuthorizationModal(callback) {
        // Crea modal di conferma personalizzato
        const modalHTML = `
            <div class="fixed inset-0 z-[200] flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in">
                <div class="bg-[var(--bg-card)] rounded-3xl max-w-md w-full mx-4 overflow-hidden shadow-2xl animate-scale-in">
                    <!-- Header con icona warning -->
                    <div class="bg-gradient-to-br from-orange-500/20 to-red-500/20 border-b border-orange-500/30 px-6 py-6">
                        <div class="flex items-center gap-4">
                            <div class="w-14 h-14 rounded-2xl bg-orange-500/20 border-2 border-orange-500/40 flex items-center justify-center">
                                <i class="ph-fill ph-warning text-3xl text-orange-400"></i>
                            </div>
                            <div>
                                <h3 class="text-xl font-bold text-white preserve-white">Richiesta di Connessione</h3>
                                <p class="text-xs text-orange-400 font-semibold mt-1">Autorizzazione Necessaria</p>
                            </div>
                        </div>
                    </div>
                    
                    <!-- Contenuto -->
                    <div class="px-6 py-6">
                        <div class="bg-gradient-to-br from-blue-500/10 to-blue-500/5 border border-blue-500/20 rounded-xl p-4 mb-6">
                            <p class="text-sm text-white preserve-white leading-relaxed">
                                Un dispositivo vuole connettersi e <strong class="text-blue-400">scaricare tutti i tuoi dati di trading</strong> (trades, account, reviews, ecc.).
                            </p>
                        </div>
                        
                        <div class="space-y-3 mb-6">
                            <div class="flex items-start gap-3 text-xs text-[var(--text-muted)]">
                                <i class="ph-bold ph-check-circle text-green-400 text-base mt-0.5"></i>
                                <span>Connessione diretta P2P cifrata</span>
                            </div>
                            <div class="flex items-start gap-3 text-xs text-[var(--text-muted)]">
                                <i class="ph-bold ph-check-circle text-green-400 text-base mt-0.5"></i>
                                <span>I tuoi dati saranno trasferiti solo dopo l'autorizzazione</span>
                            </div>
                            <div class="flex items-start gap-3 text-xs text-[var(--text-muted)]">
                                <i class="ph-bold ph-warning text-orange-400 text-base mt-0.5"></i>
                                <span>Assicurati che sia il tuo dispositivo prima di autorizzare</span>
                            </div>
                        </div>
                        
                        <p class="text-sm font-bold text-white preserve-white text-center mb-4">
                            Vuoi autorizzare il trasferimento?
                        </p>
                    </div>
                    
                    <!-- Azioni -->
                    <div class="px-6 pb-6 flex gap-3">
                        <button id="p2p-auth-deny" class="flex-1 px-6 py-3.5 rounded-2xl bg-white/5 hover:bg-white/10 border border-white/10 text-white preserve-white font-semibold transition-all">
                            <div class="flex items-center justify-center gap-2">
                                <i class="ph-bold ph-x-circle"></i>
                                <span>Rifiuta</span>
                            </div>
                        </button>
                        <button id="p2p-auth-allow" class="flex-1 px-6 py-3.5 rounded-2xl bg-gradient-to-r from-green-500 to-emerald-500 hover:from-green-600 hover:to-emerald-600 text-white preserve-white font-bold transition-all shadow-lg shadow-green-500/30">
                            <div class="flex items-center justify-center gap-2">
                                <i class="ph-bold ph-check-circle"></i>
                                <span>Autorizza</span>
                            </div>
                        </button>
                    </div>
                </div>
            </div>
        `;

        // Aggiungi al body
        const modalEl = document.createElement('div');
        modalEl.id = 'p2p-auth-modal';
        modalEl.innerHTML = modalHTML;
        document.body.appendChild(modalEl);

        // Event listeners
        document.getElementById('p2p-auth-allow').onclick = () => {
            document.getElementById('p2p-auth-modal').remove();
            callback(true);
        };

        document.getElementById('p2p-auth-deny').onclick = () => {
            document.getElementById('p2p-auth-modal').remove();
            callback(false);
        };
    },

    applyTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);

        const themeIcon = document.getElementById('theme-icon');
        if (themeIcon) {
            themeIcon.className = theme === 'light' ? 'ph-bold ph-sun text-lg' : 'ph-bold ph-moon text-lg';
        }
    },

    toggleTheme() {
        const n = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        ui.applyTheme(n);

        // Eccezione manuale: vale finché il sistema non cambia tema.
        localStorage.setItem('eazytrader_theme_manual', n);
        // Manteniamo anche la vecchia chiave per retrocompatibilità
        localStorage.setItem('eazytrader_theme', n);
    },

    populateSelects() { },

    // --- DASHBOARD ---
    async dashboard() {
        const allTrades = DataStore.data.trades.filter(t => t.status === 'executed');
        let trades = ui.dashboardFilter === 'all' ? allTrades : allTrades.filter(t => t.accountId == ui.dashboardFilter);

        // Filtro temporale
        const timeFilter = ui.dashboardTimeFilter || 'all';
        const now = new Date();
        let cutoffDate = null;

        if (timeFilter !== 'all') {
            cutoffDate = new Date(now);
            switch (timeFilter) {
                case '4h':
                    cutoffDate.setHours(now.getHours() - 4);
                    break;
                case '1d':
                    cutoffDate.setDate(now.getDate() - 1);
                    break;
                case '1w':
                    cutoffDate.setDate(now.getDate() - 7);
                    break;
                case '1m':
                    cutoffDate.setMonth(now.getMonth() - 1);
                    break;
                case '1y':
                    cutoffDate.setFullYear(now.getFullYear() - 1);
                    break;
            }
            // Filtra i trade in base alla data del trade (t.date), non la data di creazione
            trades = trades.filter(t => {
                const tradeDate = new Date(t.date);
                return tradeDate >= cutoffDate;
            });
        }

        const startOfWeek = new Date(now);
        const day = startOfWeek.getDay() || 7;
        if (day !== 1) startOfWeek.setHours(-24 * (day - 1));
        startOfWeek.setHours(0, 0, 0, 0);
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

        // Ottinizzazione: calcolo unico per tutti i periodi e metrica trade avanzata
        let pnl = 0, weeklyPnl = 0, monthlyPnl = 0, winningTrades = 0, losingTrades = 0;
        let winSum = 0, lossSum = 0;
        let bestTrade = 0, worstTrade = 0;

        trades.forEach((t, idx) => {
            const val = parseFloat(t.pnl) || 0;
            pnl += val;
            if (val > 0) {
                winningTrades++;
                winSum += val;
            } else if (val < 0) {
                losingTrades++;
                lossSum += Math.abs(val);
            }

            if (idx === 0) {
                bestTrade = val;
                worstTrade = val;
            } else {
                if (val > bestTrade) bestTrade = val;
                if (val < worstTrade) worstTrade = val;
            }

            const d = new Date(t.date);
            if (!isNaN(d)) {
                if (d >= startOfWeek) weeklyPnl += val;
                if (d >= startOfMonth) monthlyPnl += val;
            }
        });

        const totalTrades = trades.length;
        const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100) : 0;
        const avgWin = winningTrades > 0 ? (winSum / winningTrades) : 0;
        const avgLoss = losingTrades > 0 ? (lossSum / losingTrades) : 0;
        const profitFactor = lossSum > 0 ? (winSum / lossSum).toFixed(2) : (winSum > 0 ? '∞' : '0.00');
        const payoffRatio = avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : '0.00';

        // Calcola equity: totale o dell'account selezionato
        const totalEquity = ui.dashboardFilter === 'all'
            ? DataStore.data.accounts.reduce((sum, acc) => sum + (acc.balance || 0), 0)
            : (DataStore.data.accounts.find(a => a.id == ui.dashboardFilter)?.balance || 0);

        // Helper per visualizzazione eventi
        const getImpactDot = (impact) => {
            if (impact === 'High') return '<span class="w-2 h-2 rounded-full bg-red-500 animate-pulse shadow-lg shadow-red-500/50"></span>';
            if (impact === 'Medium') return '<span class="w-2 h-2 rounded-full bg-orange-500"></span>';
            return '<span class="w-2 h-2 rounded-full bg-white/30"></span>';
        };

        // === POSIZIONI APERTE CAPITAL.COM ===
        // Rileva se l'account selezionato è Capital.com (o se c'è solo un account Capital.com)
        let capitalAccount = null;
        if (ui.dashboardFilter !== 'all') {
            const selectedAcc = DataStore.data.accounts.find(a => a.id == ui.dashboardFilter);
            if (selectedAcc && selectedAcc.capitalComConnected) capitalAccount = selectedAcc;
        } else {
            // In "tutti", mostra se c'è almeno un account Capital.com connesso
            capitalAccount = DataStore.data.accounts.find(a => a.capitalComConnected && a.capitalComApiKey);
        }

        ui.container.innerHTML = `
        <div class="fade-in space-y-8">
            <div class="fade-in flex flex-col gap-4 mb-8">
                <div class="flex flex-col md:flex-row justify-between items-start md:items-end gap-4">
                    <div>
                        <div class="mb-4">
                            <p class="text-[var(--text-muted)] font-bold text-xs uppercase tracking-wide mb-2">Conto Selezionato</p>
                            <div id="account-selector" class="flex gap-2 overflow-x-auto custom-scrollbar p-1">
                                <button onclick="ui.dashboardFilter='all'; ui.dashboard()" class="account-pill px-4 py-1.5 rounded-full text-xs font-bold ${ui.dashboardFilter === 'all' ? 'active' : 'bg-[var(--input-bg)] text-[var(--text-muted)]'}">Tutti</button>
                                ${DataStore.data.accounts.map(a => `<button onclick="ui.dashboardFilter='${a.id}'; ui.dashboard()" class="account-pill px-4 py-1.5 rounded-full text-xs font-bold ${ui.dashboardFilter == a.id ? 'active' : 'bg-[var(--input-bg)] text-[var(--text-muted)]'}">${a.name}</button>`).join('')}
                            </div>
                        </div>
                        <div>
                            <p class="text-[var(--text-muted)] font-bold text-xs uppercase tracking-wide mb-2">Periodo Temporale</p>
                            <div id="time-filters" class="flex gap-2 overflow-x-auto custom-scrollbar p-1">
                                <button onclick="ui.dashboardTimeFilter='4h'; ui.dashboard()" class="px-3 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap ${timeFilter === '4h' ? 'bg-[var(--accent-blue)] text-white preserve-white' : 'bg-[var(--input-bg)] text-[var(--text-muted)] hover:bg-white/10'}">4H</button>
                                <button onclick="ui.dashboardTimeFilter='1d'; ui.dashboard()" class="px-3 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap ${timeFilter === '1d' ? 'bg-[var(--accent-blue)] text-white preserve-white' : 'bg-[var(--input-bg)] text-[var(--text-muted)] hover:bg-white/10'}">1D</button>
                                <button onclick="ui.dashboardTimeFilter='1w'; ui.dashboard()" class="px-3 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap ${timeFilter === '1w' ? 'bg-[var(--accent-blue)] text-white preserve-white' : 'bg-[var(--input-bg)] text-[var(--text-muted)] hover:bg-white/10'}">1W</button>
                                <button onclick="ui.dashboardTimeFilter='1m'; ui.dashboard()" class="px-3 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap ${timeFilter === '1m' ? 'bg-[var(--accent-blue)] text-white preserve-white' : 'bg-[var(--input-bg)] text-[var(--text-muted)] hover:bg-white/10'}">1M</button>
                                <button onclick="ui.dashboardTimeFilter='1y'; ui.dashboard()" class="px-3 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap ${timeFilter === '1y' ? 'bg-[var(--accent-blue)] text-white preserve-white' : 'bg-[var(--input-bg)] text-[var(--text-muted)] hover:bg-white/10'}">1Y</button>
                                <button onclick="ui.dashboardTimeFilter='all'; ui.dashboard()" class="px-3 py-1.5 rounded-full text-xs font-bold transition-all whitespace-nowrap ${timeFilter === 'all' ? 'bg-[var(--accent-blue)] text-white preserve-white' : 'bg-[var(--input-bg)] text-[var(--text-muted)] hover:bg-white/10'}">All</button>
                            </div>
                        </div>
                    </div>
                    <div class="flex gap-2">
                        <button id="cmd-monte-carlo" onclick="PremiumUI.openMonteCarloModal()" class="h-10 px-3.5 md:px-4 rounded-xl bg-[var(--input-bg)] border border-[var(--glass-border)] hover:bg-[var(--card-bg)] text-white preserve-white transition-all flex items-center gap-2 flex-shrink-0 backdrop-blur-sm group" title="Analisi Monte Carlo">
                            <i class="ph-bold ph-chart-scatter text-lg text-indigo-400 group-hover:scale-110 transition-transform"></i>
                            <span class="text-xs font-bold uppercase tracking-wider hidden sm:inline-block">Monte Carlo</span>
                        </button>
                        <button id="cmd-share-dashboard" onclick="ui.shareDashboard(${pnl}, ${winRate}, ${totalEquity})" class="h-10 px-4 rounded-xl bg-[var(--input-bg)] border border-[var(--glass-border)] hover:bg-[var(--card-bg)] text-white preserve-white transition-all flex items-center gap-2 flex-shrink-0 backdrop-blur-sm group" title="Condividi Statistiche">
                            <i class="ph-bold ph-share-network text-lg group-hover:scale-110 transition-transform"></i>
                            <span class="text-xs font-bold uppercase tracking-wider hidden sm:inline-block">Share</span>
                        </button>
                        <button id="cmd-new-trade" onclick="ui.openNewTradeModal()" class="bg-[var(--accent-blue)] text-white preserve-white px-4 py-2 rounded-xl font-bold hover:opacity-90 transition-opacity flex items-center gap-2 flex-shrink-0">
                            <i class="ph-bold ph-plus"></i><span class="hidden md:inline">Nuovo</span>
                        </button>
                    </div>
                </div>
            </div>
            <div id="stats-grid" class="fade-in flex overflow-x-auto snap-x md:grid md:grid-cols-5 gap-3 md:gap-4 md:overflow-visible -mx-4 px-4 md:px-3 scrollbar-hide" style="padding-top: 12px; padding-bottom: 4px;">
                <div class="snap-center min-w-[42vw] md:min-w-0 card-apple p-4 md:p-5 flex-shrink-0"><p class="text-xs text-[var(--text-muted)] mb-1 md:mb-2">Equity ${ui.dashboardFilter === 'all' ? 'Totale' : 'Account'}</p><h3 class="text-lg md:text-2xl font-bold text-[var(--accent-blue)] truncate" data-capital-balance>${ui.formatCurrency(totalEquity)}</h3></div>
                <div class="snap-center min-w-[42vw] md:min-w-0 card-apple p-4 md:p-5 flex-shrink-0"><p class="text-xs text-[var(--text-muted)] mb-1 md:mb-2">P&L Totale</p><h3 class="text-lg md:text-2xl font-bold ${pnl >= 0 ? 'text-green-500' : 'text-red-500'} truncate">${ui.formatCurrency(pnl)}</h3></div>
                <div class="snap-center min-w-[42vw] md:min-w-0 card-apple p-4 md:p-5 flex-shrink-0"><p class="text-xs text-[var(--text-muted)] mb-1 md:mb-2">Settimana</p><h3 class="text-lg md:text-2xl font-bold ${weeklyPnl >= 0 ? 'text-green-500' : 'text-red-500'} truncate">${ui.formatCurrency(weeklyPnl)}</h3></div>
                <div class="snap-center min-w-[42vw] md:min-w-0 card-apple p-4 md:p-5 flex-shrink-0"><p class="text-xs text-[var(--text-muted)] mb-1 md:mb-2">Mese</p><h3 class="text-lg md:text-2xl font-bold ${monthlyPnl >= 0 ? 'text-green-500' : 'text-red-500'} truncate">${ui.formatCurrency(monthlyPnl)}</h3></div>
                <div class="snap-center min-w-[42vw] md:min-w-0 card-apple p-4 md:p-5 flex-shrink-0"><p class="text-xs text-[var(--text-muted)] mb-1 md:mb-2">Win Rate</p><h3 class="text-lg md:text-2xl font-bold truncate">${winRate.toFixed(1)}%</h3><p class="text-xs text-[var(--text-muted)] mt-1">${winningTrades}/${totalTrades}</p></div>
            </div>

            <!-- SEZIONE POSIZIONI APERTE -->
            <div id="open-positions-section" class="fade-in my-5">
                <div class="flex items-center justify-between mb-3">
                    <div class="flex items-center gap-2.5">
                        <div class="w-2 h-2 rounded-full bg-emerald-500 shadow-sm shadow-emerald-500/50"></div>
                        <h3 class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Posizioni Aperte ${capitalAccount ? '· Capital.com' : ''}</h3>
                    </div>
                    ${capitalAccount ? `
                    <div class="flex items-center gap-2">
                        <span id="open-pos-last-update" class="text-[10px] text-[var(--text-muted)] opacity-60"></span>
                        <button onclick="ui.refreshOpenPositions()" class="w-7 h-7 rounded-lg bg-[var(--input-bg)] hover:bg-[var(--glass-border)] flex items-center justify-center transition-all group" title="Aggiorna posizioni">
                            <i id="open-pos-refresh-icon" class="ph-bold ph-arrows-clockwise text-xs text-[var(--text-muted)] group-hover:text-[var(--text-main)] transition-colors"></i>
                        </button>
                    </div>
                    ` : ''}
                </div>
                <div id="open-positions-container">
                    ${capitalAccount ? `
                    <div class="card-apple p-5 flex items-center justify-center gap-3 text-[var(--text-muted)]">
                        <div class="w-4 h-4 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin"></div>
                        <span class="text-xs font-medium">Caricamento posizioni...</span>
                    </div>
                    ` : `
                    <div class="card-apple p-4 md:p-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
                        <div class="flex items-center gap-3.5">
                            <div class="w-10 h-10 rounded-xl bg-[var(--input-bg)] border border-[var(--glass-border)] flex items-center justify-center text-[var(--text-muted)] shrink-0">
                                <i class="ph-bold ph-broadcast text-lg"></i>
                            </div>
                            <div>
                                <h4 class="text-sm font-bold text-[var(--text-main)]">Nessun conto broker collegato</h4>
                                <p class="text-xs text-[var(--text-muted)] mt-0.5">Collega un conto per monitorare le posizioni aperte in tempo reale.</p>
                            </div>
                        </div>
                        <button onclick="router.navigate('accounts')" class="px-4 py-2 rounded-xl bg-[var(--input-bg)] hover:bg-white/10 text-[var(--text-main)] font-semibold text-xs transition-all border border-[var(--glass-border)] flex items-center gap-2 shrink-0">
                            <i class="ph-bold ph-plus text-sm"></i>
                            <span>Collega Conto</span>
                        </button>
                    </div>
                    `}
                </div>
            </div>

            <div class="fade-in grid grid-cols-1 md:grid-cols-4 gap-4 md:overflow-visible" style="padding: 4px 0;">
                <div class="md:col-span-3 card-apple p-6 flex flex-col min-h-[300px] md:min-h-[450px]">
                    <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 mb-6">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500/20 to-purple-500/20 flex items-center justify-center">
                                <i class="ph-bold ph-trend-up text-blue-400 text-lg"></i>
                            </div>
                            <div>
                                <h3 class="text-base font-bold text-[var(--text-main)]">Equity Curve</h3>
                                <p class="text-xs text-[var(--text-muted)]">Andamento P&L</p>
                            </div>
                        </div>

                        <!-- STRISCIA METRICHE MINIMALE -->
                        <div class="flex flex-wrap items-center gap-3 text-xs font-semibold bg-[var(--input-bg)] border border-[var(--glass-border)] px-4 py-2 rounded-xl">
                            <div class="flex items-center gap-1.5" title="Guadagno Medio sui trade vincenti">
                                <span class="text-[var(--text-muted)] text-[10px] uppercase font-bold">Avg Win</span>
                                <span class="text-emerald-400 font-bold">+${ui.formatCurrency(avgWin)}</span>
                            </div>
                            <span class="text-[var(--glass-border)] hidden sm:inline">|</span>
                            <div class="flex items-center gap-1.5" title="Perdita Media sui trade perdenti">
                                <span class="text-[var(--text-muted)] text-[10px] uppercase font-bold">Avg Loss</span>
                                <span class="text-red-400 font-bold">-${ui.formatCurrency(avgLoss)}</span>
                            </div>
                            <span class="text-[var(--glass-border)] hidden sm:inline">|</span>
                            <div class="flex items-center gap-1.5" title="Profit Factor (Vincite / Perdite)">
                                <span class="text-[var(--text-muted)] text-[10px] uppercase font-bold">PF</span>
                                <span class="text-[var(--text-main)] font-bold">${profitFactor}</span>
                            </div>
                            <span class="text-[var(--glass-border)] hidden sm:inline">|</span>
                            <div class="flex items-center gap-1.5" title="Payoff Ratio (Avg Win / Avg Loss)">
                                <span class="text-[var(--text-muted)] text-[10px] uppercase font-bold">R:R</span>
                                <span class="text-blue-400 font-bold">${payoffRatio}</span>
                            </div>
                        </div>
                    </div>
                    <div class="flex-1 w-full"><canvas id="equityChart"></canvas></div>
                </div>
                <div id="calendar-widget" class="card-apple p-5 flex flex-col min-h-[300px] md:min-h-[450px]"><div class="flex justify-between items-center mb-4"><h3 class="text-sm" id="cal-month-year">...</h3><div class="flex gap-1"><button onclick="ui.changeCalendarMonth(-1)" class="w-7 h-7 rounded hover:bg-[var(--input-bg)] flex items-center justify-center"><i class="ph-bold ph-caret-left"></i></button><button onclick="ui.changeCalendarMonth(1)" class="w-7 h-7 rounded hover:bg-[var(--input-bg)] flex items-center justify-center"><i class="ph-bold ph-caret-right"></i></button></div></div><div class="grid grid-cols-7 text-center text-[10px] text-[var(--text-muted)] mb-2"><div>L</div><div>M</div><div>M</div><div>G</div><div>V</div><div>S</div><div>D</div></div><div id="calendar-grid" class="grid grid-cols-7 gap-1 flex-1"></div></div>
            </div>

            <!-- HEATMAP TEMPORALE -->
            <div class="fade-in card-apple p-6 flex flex-col mt-4">
                <div class="flex justify-between items-center mb-6">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500/20 to-red-500/20 flex items-center justify-center">
                            <i class="ph-bold ph-fire text-orange-400 text-lg"></i>
                        </div>
                        <div>
                            <h3 class="text-base font-bold text-[var(--text-main)]">Heatmap Temporale</h3>
                            <p class="text-xs text-[var(--text-muted)]">Analisi Win Rate per giorno e ora</p>
                        </div>
                    </div>
                </div>
                <div id="heatmap-container" class="w-full">
                    <div class="flex items-center justify-center h-32 text-[var(--text-muted)] text-sm">
                        <div class="w-5 h-5 border-2 border-[var(--text-muted)] border-t-transparent rounded-full animate-spin mr-3"></div> Generazione mappa...
                    </div>
                </div>
            </div>

        </div>`;

        // Renderizza chart e calendario immediatamente
        ui.renderChart(trades);
        ui.renderCalendar();
        ui.renderTemporalHeatmap(trades);

        // Avvia il fetch delle posizioni aperte se c'è un account Capital.com
        if (capitalAccount) {
            ui._openPositionsAccount = capitalAccount;
            ui.refreshOpenPositions();
            // Polling ogni 10 secondi per aggiornare il PnL live
            if (ui._openPositionsInterval) clearInterval(ui._openPositionsInterval);
            ui._openPositionsInterval = setInterval(() => {
                if (router.currentPage === 'dashboard' && document.getElementById('open-positions-container')) {
                    ui.refreshOpenPositions(true); // silent=true: nessun spinner
                } else {
                    clearInterval(ui._openPositionsInterval);
                    ui._openPositionsInterval = null;
                }
            }, 10000);
        } else {
            // Pulisci il polling se non siamo più su un account Capital.com
            if (ui._openPositionsInterval) {
                clearInterval(ui._openPositionsInterval);
                ui._openPositionsInterval = null;
            }
        }
    },
    
    // --- TEMPORAL HEATMAP ---
    renderTemporalHeatmap(trades) {
        const heatmapContainer = document.getElementById('heatmap-container');
        if (!heatmapContainer) return;

        if (trades.length === 0) {
            heatmapContainer.innerHTML = '<div class="text-center py-10 text-[var(--text-muted)]">Nessun trade disponibile per la heatmap.</div>';
            return;
        }

        // Inizializza matrice [giorno 1-7][ora 0-23]
        const dataMatrix = Array(7).fill().map(() => Array(24).fill().map(() => ({ pnl: 0, wins: 0, count: 0 })));

        trades.forEach(t => {
            const d = new Date(t.date);
            if(isNaN(d)) return;
            const day = (d.getDay() + 6) % 7; // LUN=0 ... DOM=6
            const hour = d.getHours();
            
            dataMatrix[day][hour].count++;
            dataMatrix[day][hour].pnl += (parseFloat(t.pnl) || 0);
            if((parseFloat(t.pnl) || 0) > 0) dataMatrix[day][hour].wins++;
        });

        const days = ['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'];
        
        let html = '<div class="flex gap-2 w-full">';
        
        // Colonna etichette giorni
        html += '<div class="flex flex-col gap-1 pt-6 pr-2 border-r border-[var(--glass-border)] flex-shrink-0">';
        for(let i = 0; i < 7; i++) {
            html += `<div class="h-8 md:h-10 text-[10px] md:text-xs font-bold text-[var(--text-muted)] flex items-center justify-end">${days[i]}</div>`;
        }
        html += '</div>';

        // Griglia principale scorrevole
        html += '<div class="flex-1 overflow-x-auto custom-scrollbar pb-2">';
        html += '<div class="inline-block min-w-max">';
        
        // Intestazione ore
        html += '<div class="flex gap-1 mb-2 pl-1">';
        for(let h = 0; h < 24; h++) {
            html += `<div class="w-8 md:w-10 text-center text-[10px] font-bold text-[var(--text-muted)]">${h}</div>`;
        }
        html += '</div>';

        // Righe giorni
        for(let d = 0; d < 7; d++) {
            html += '<div class="flex gap-1 mb-1 pl-1">';
            for(let h = 0; h < 24; h++) {
                const cell = dataMatrix[d][h];
                let bgClass = 'bg-[var(--input-bg)]';
                let opacity = '0.3';
                let tooltip = 'Nessun trade';
                
                if (cell.count > 0) {
                    const wr = cell.wins / cell.count;
                    const isProfitable = cell.pnl >= 0;
                    
                    // Intensità base 0.2 + proporzionale
                    opacity = (0.2 + Math.abs(wr) * 0.8).toFixed(2);
                    
                    // Modifica i colori per non dipendere da Tailwind opacity
                    bgClass = isProfitable ? 'bg-emerald-500' : 'bg-red-500';
                    tooltip = `${cell.count} trade | WR: ${(wr*100).toFixed(0)}% | PnL: $${cell.pnl.toFixed(2)}`;
                }
                
                html += `<div class="w-8 h-8 md:w-10 md:h-10 rounded-lg ${bgClass} transition-all hover:scale-[1.15] cursor-help flex items-center justify-center text-[10px] font-bold preserve-white" style="opacity: ${opacity}; color: ${cell.count > 0 ? '#fff' : 'transparent'};" title="${tooltip}">
                            ${cell.count > 0 ? cell.count : ''}
                         </div>`;
            }
            html += '</div>';
        }
        
        html += '</div></div></div>';
        
        // Legenda
        html += `
            <div class="mt-6 flex flex-wrap items-center justify-center gap-6 text-xs text-[var(--text-muted)] font-semibold">
                <div class="flex items-center gap-2"><div class="w-4 h-4 rounded bg-emerald-500 opacity-80"></div> Profitto</div>
                <div class="flex items-center gap-2"><div class="w-4 h-4 rounded bg-red-500 opacity-80"></div> Perdita</div>
                <div class="flex items-center gap-2"><div class="w-4 h-4 rounded bg-[var(--input-bg)]"></div> Nessun Trade</div>
                <div class="ml-4 text-[10px] uppercase tracking-wider opacity-60">L'intensità del colore indica il Win Rate</div>
            </div>
        `;
        
        heatmapContainer.innerHTML = html;
    },

    async exportDashboardPDF() {
        if (window.PDFExport) {
            window.PDFExport.openExportModal();
        } else {
            ui.showToast('Modulo esportazione PDF non trovato.', true);
        }
    },

    // Helper: formatta la durata di una posizione aperta
    _formatPositionDuration(openedAt) {
        if (!openedAt) return '';
        const ms = Date.now() - new Date(openedAt).getTime();
        if (isNaN(ms) || ms < 0) return '';
        const mins = Math.floor(ms / 60000);
        if (mins < 60) return `${mins}m`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h ${mins % 60}m`;
        const days = Math.floor(hrs / 24);
        return `${days}g ${hrs % 24}h`;
    },

    // Aggiorna la sezione delle posizioni aperte (chiamata manualmente o da polling)
    async refreshOpenPositions(silent = false) {
        const container = document.getElementById('open-positions-container');
        if (!container || !ui._openPositionsAccount) return;

        const refreshIcon = document.getElementById('open-pos-refresh-icon');
        if (!silent && refreshIcon) refreshIcon.classList.add('animate-spin');

        try {
            // Verifica proxy disponibile
            const proxyBase = (typeof PROXY_BASE_URL !== 'undefined') ? PROXY_BASE_URL : 'http://localhost:3030';
            let proxyOk = false;
            try {
                const healthResp = await fetch(`${proxyBase}/health`, { signal: AbortSignal.timeout(2000) });
                proxyOk = healthResp.ok;
            } catch { proxyOk = false; }

            if (!proxyOk) {
                if (!silent) {
                    container.innerHTML = `
                        <div class="card-apple p-5 flex items-center gap-4 border border-orange-500/20">
                            <div class="w-10 h-10 rounded-xl bg-orange-500/10 flex items-center justify-center flex-shrink-0">
                                <i class="ph-bold ph-plug text-orange-400 text-lg"></i>
                            </div>
                            <div>
                                <p class="text-sm font-semibold text-[var(--text-main)]">Proxy posizioni non disponibile</p>
                                <p class="text-xs text-[var(--text-muted)] mt-0.5">Le posizioni live saranno attive automaticamente dopo il deploy su Netlify.</p>
                            </div>
                        </div>`;
                }
                return;
            }

            const positions = await DataStore.fetchCapitalComOpenPositions(ui._openPositionsAccount);

            // Aggiorna timestamp
            const lastUpdateEl = document.getElementById('open-pos-last-update');
            if (lastUpdateEl) {
                const now = new Date();
                lastUpdateEl.textContent = `Aggiornato ${now.getHours().toString().padStart(2,'0')}:${now.getMinutes().toString().padStart(2,'0')}:${now.getSeconds().toString().padStart(2,'0')}`;
            }

            if (positions === null) {
                // Errore fetch
                container.innerHTML = `
                    <div class="card-apple p-5 text-center text-[var(--text-muted)]">
                        <i class="ph-bold ph-warning text-2xl text-orange-400 mb-2 block"></i>
                        <p class="text-sm">Impossibile caricare le posizioni. Riprova.</p>
                    </div>`;
                return;
            }

            if (positions.length === 0) {
                container.innerHTML = `
                    <div class="card-apple p-5 flex flex-col items-center justify-center gap-1.5 text-center">
                        <p class="text-sm font-bold text-[var(--text-main)]">Nessuna posizione aperta</p>
                        <p class="text-xs text-[var(--text-muted)]">Nessun trade attivo in questo momento sul conto collegato.</p>
                    </div>`;
                return;
            }

            // Calcola PnL totale posizioni aperte
            const totalOpenPnl = positions.reduce((sum, p) => sum + p.pnl, 0);
            const totalOpenPnlColor = totalOpenPnl >= 0 ? '#10b981' : '#ef4444';

            container.innerHTML = `
                <div class="flex flex-col gap-2">
                    <!-- Header PnL totale posizioni aperte -->
                    <div class="card-apple px-5 py-3 flex items-center justify-between" style="border-left: 3px solid ${totalOpenPnlColor}; flex-shrink: 0;">
                        <div class="flex items-center gap-2">
                            <span class="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Floating P&L</span>
                            <span class="text-[10px] bg-[var(--input-bg)] px-2 py-0.5 rounded-full text-[var(--text-muted)]">${positions.length} posizi${positions.length === 1 ? 'one' : 'oni'}</span>
                        </div>
                        <span class="text-xl font-extrabold tracking-tight" style="color:${totalOpenPnlColor};">${totalOpenPnl >= 0 ? '+' : ''}${ui.formatCurrency(totalOpenPnl)}</span>
                    </div>
                    <!-- Lista posizioni -->
                    <div class="max-h-[240px] md:max-h-[300px] overflow-y-auto custom-scrollbar flex flex-col gap-2 pr-1">
                        ${positions.map(pos => {
                        const isWin = pos.pnl >= 0;
                        const pnlColor = isWin ? '#10b981' : '#ef4444';
                        const dirLabel = pos.direction === 'long' ? '▲ LONG' : '▼ SHORT';
                        const dirColor = pos.direction === 'long' ? 'text-emerald-400' : 'text-red-400';
                        const duration = ui._formatPositionDuration(pos.openedAt);
                        const pnlSign = pos.pnl >= 0 ? '+' : '';
                        return `
                        <div class="card-apple px-5 py-4 flex items-center gap-4 transition-all hover:scale-[1.01]" style="border-left: 3px solid ${pnlColor}20;">
                            <!-- Asset + direzione -->
                            <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="font-bold text-base text-[var(--text-main)] truncate">${pos.asset}</span>
                                    <span class="text-[10px] font-bold ${dirColor} uppercase tracking-wide">${dirLabel}</span>
                                    ${duration ? `<span class="text-[10px] text-[var(--text-muted)] ml-auto bg-[var(--input-bg)] px-2 py-0.5 rounded-full">${duration}</span>` : ''}
                                </div>
                                <div class="flex items-center gap-3 text-xs text-[var(--text-muted)]">
                                    <span>Entry <span class="text-[var(--text-main)] font-medium">${pos.entry > 0 ? pos.entry.toFixed(pos.entry > 100 ? 2 : 5) : '—'}</span></span>
                                    ${pos.size > 0 ? `<span>Lotti <span class="text-[var(--text-main)] font-medium">${pos.size}</span></span>` : ''}
                                    ${pos.stopLevel ? `<span class="text-red-400/70">SL ${pos.stopLevel.toFixed(pos.stopLevel > 100 ? 2 : 5)}</span>` : ''}
                                    ${pos.limitLevel ? `<span class="text-emerald-400/70">TP ${pos.limitLevel.toFixed(pos.limitLevel > 100 ? 2 : 5)}</span>` : ''}
                                </div>
                            </div>
                            <!-- PnL -->
                            <div class="text-right flex-shrink-0">
                                <div class="text-lg font-extrabold tracking-tight" style="color:${pnlColor};">${pnlSign}${ui.formatCurrency(pos.pnl)}</div>
                                <div class="text-[10px] text-[var(--text-muted)] mt-0.5">${pos.currency || ''}</div>
                            </div>
                        </div>`;
                    }).join('')}
                    </div>
                </div>`;

        } catch (e) {
            console.error('❌ refreshOpenPositions error:', e);
        } finally {
            if (refreshIcon) refreshIcon.classList.remove('animate-spin');
        }
    },

    // --- JOURNAL (WITH PAYOUT VISUAL) ---
    journal() {
        const filtered = ui.getFilteredTrades();
        // Ottimizzazione: singolo loop per calcolare tutte le statistiche
        const executedTrades = filtered.filter(t => t.status === 'executed' && t.type !== 'payout');
        const payoutTrades = filtered.filter(t => t.type === 'payout');

        let pnl = 0, winCount = 0;
        const assetMap = {}, stratMap = {};

        executedTrades.forEach(t => {
            const val = parseFloat(t.pnl) || 0;
            pnl += val;
            if (val > 0) winCount++;
            
            // Inizializza o aggiorna le statistiche per l'asset
            if (!assetMap[t.asset]) assetMap[t.asset] = { net: 0, count: 0, wins: 0 };
            assetMap[t.asset].net += val;
            assetMap[t.asset].count += 1;
            if (val > 0) assetMap[t.asset].wins += 1;

            // Inizializza o aggiorna le statistiche per la strategia
            if (t.strategy) {
                if (!stratMap[t.strategy]) stratMap[t.strategy] = { net: 0, count: 0, wins: 0 };
                stratMap[t.strategy].net += val;
                stratMap[t.strategy].count += 1;
                if (val > 0) stratMap[t.strategy].wins += 1;
            }
        });

        // Aggiungi i payout al P&L totale (i payout sono negativi perché sono prelievi)
        payoutTrades.forEach(t => {
            const val = parseFloat(t.pnl) || 0;
            pnl += val;
        });

        const winRate = executedTrades.length ? (winCount / executedTrades.length) * 100 : 0;
        
        // Funzione per calcolare lo score di un asset/strategia penalizzando i single-trade
        const getScore = (stat) => {
            if (stat.net <= 0) return stat.net;
            // Penalizziamo del 50% chi ha 1 solo trade, e del 20% chi ne ha 2, per premiare la consistenza "overall"
            const consistency = stat.count === 1 ? 0.5 : (stat.count === 2 ? 0.8 : 1.0);
            // Leggero bonus win rate per spezzare i pareggi
            const wrBonus = stat.count > 0 ? (stat.wins / stat.count) * 0.1 : 0;
            return stat.net * consistency * (1 + wrBonus);
        };

        const bestAsset = Object.keys(assetMap).length ? Object.keys(assetMap).reduce((a, b) => getScore(assetMap[a]) > getScore(assetMap[b]) ? a : b) : '-';
        const bestStrat = Object.keys(stratMap).length ? Object.keys(stratMap).reduce((a, b) => getScore(stratMap[a]) > getScore(stratMap[b]) ? a : b) : '-';

        ui.container.innerHTML = `
        <div class="fade-in flex flex-col">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-6 md:mb-8">
                <div class="flex items-center justify-between w-full md:w-auto">
                    <h2 class="text-3xl md:text-4xl font-bold tracking-tight">Journal</h2>
                    <div class="flex md:hidden gap-2">
                        <button onclick="ui.syncBrokerTradesToday()" class="bg-blue-500/10 text-blue-500 px-4 py-2 rounded-xl font-bold hover:bg-blue-500 hover:text-white transition-opacity flex items-center gap-2 flex-shrink-0" title="Sync Oggi"><i class="ph-bold ph-arrows-clockwise"></i></button>
                        <button onclick="ui.openNewTradeModal()" class="bg-[var(--accent-blue)] text-white preserve-white px-4 py-2 rounded-xl font-bold hover:opacity-90 transition-opacity flex items-center gap-2 flex-shrink-0"><i class="ph-bold ph-plus"></i></button>
                    </div>
                </div>

                <div class="flex md:flex-row flex-col flex-wrap gap-3 w-full md:w-auto items-start md:items-center md:justify-end">
                    <div class="flex items-center gap-2 w-full md:w-auto">
                        <label class="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider">Account:</label>
                        <select onchange="ui.filters.account=this.value; router.journal()" class="flex-1 md:flex-initial px-4 py-2 rounded-xl bg-[var(--input-bg)] border border-white/10 text-sm font-medium appearance-none outline-none min-w-[150px] cursor-pointer hover:border-blue-500/30 transition-all"><option value="all" ${ui.filters.account === 'all' ? 'selected' : ''}>Tutti i Conti</option>${DataStore.data.accounts.map(a => `<option value="${a.id}" ${ui.filters.account == a.id ? 'selected' : ''}>${a.name}</option>`).join('')}</select>
                    </div>
                    <button onclick="ui.syncBrokerTradesToday()" class="bg-blue-500/10 text-blue-500 px-4 py-2 rounded-xl font-bold hover:bg-blue-500 hover:text-white transition-opacity flex items-center gap-2 flex-shrink-0" title="Sincronizza i trade di oggi"><i class="ph-bold ph-arrows-clockwise"></i><span class="hidden md:inline">Sync Oggi</span></button>
                    <button onclick="ui.openNewTradeModal()" class="bg-[var(--accent-blue)] text-white preserve-white px-4 py-2 rounded-xl font-bold hover:opacity-90 transition-opacity flex items-center gap-2 flex-shrink-0"><i class="ph-bold ph-plus"></i><span class="hidden md:inline">Nuovo</span></button>
                </div>
            </div>
            
            <div class="flex overflow-x-auto snap-x md:grid md:grid-cols-4 gap-3 md:gap-4 mb-1 md:mb-2 md:overflow-visible -mx-4 px-4 md:px-3 scrollbar-hide" style="padding-top: 12px; padding-bottom: 12px;">
                <div class="snap-center min-w-[42vw] md:min-w-0 stat-box flex-shrink-0"><p class="text-[10px] font-bold uppercase text-[var(--text-muted)]">P&L Totale</p><p class="text-lg md:text-xl font-bold mt-1 ${pnl >= 0 ? 'text-green-500' : 'text-red-500'} truncate">${ui.formatCurrency(pnl)}</p></div>
                <div class="snap-center min-w-[42vw] md:min-w-0 stat-box flex-shrink-0"><p class="text-[10px] font-bold uppercase text-[var(--text-muted)]">Win Rate</p><p class="text-lg md:text-xl font-bold mt-1 text-white preserve-white truncate">${winRate.toFixed(1)}%</p><p class="text-xs text-[var(--text-muted)] mt-1">${winCount}/${executedTrades.length}</p></div>
                <div class="snap-center min-w-[42vw] md:min-w-0 stat-box flex-shrink-0"><p class="text-[10px] font-bold uppercase text-[var(--text-muted)]">Best Asset</p><p class="text-lg md:text-xl font-bold mt-1 text-white preserve-white truncate">${bestAsset}</p></div>
                <div class="snap-center min-w-[42vw] md:min-w-0 stat-box flex-shrink-0"><p class="text-[10px] font-bold uppercase text-[var(--text-muted)]">Best Strat</p><p class="text-lg md:text-xl font-bold mt-1 text-white preserve-white truncate">${bestStrat}</p></div>
            </div>
            
            <!-- Filtri Temporali -->
            <div class="flex items-center gap-3 mb-6 overflow-x-auto custom-scrollbar py-4">
                <span class="text-xs font-bold text-[var(--text-muted)] uppercase tracking-wider whitespace-nowrap flex-shrink-0">Periodo:</span>
                <div class="flex gap-2">
                    <button onclick="ui.filters.time='1d'; router.journal()" class="time-filter-pill ${ui.filters.time === '1d' ? 'active' : ''}">1D</button>
                    <button onclick="ui.filters.time='1w'; router.journal()" class="time-filter-pill ${ui.filters.time === '1w' ? 'active' : ''}">1W</button>
                    <button onclick="ui.filters.time='1m'; router.journal()" class="time-filter-pill ${ui.filters.time === '1m' ? 'active' : ''}">1M</button>
                    <button onclick="ui.filters.time='1y'; router.journal()" class="time-filter-pill ${ui.filters.time === '1y' ? 'active' : ''}">1Y</button>
                    <button onclick="ui.filters.time='all'; router.journal()" class="time-filter-pill ${ui.filters.time === 'all' ? 'active' : ''}">All</button>
                </div>
            </div>
            <div class="flex-1 space-y-2">
                ${filtered.length ? filtered.map(t => {

            // PAYOUT CARD RENDERING
            if (t.type === 'payout') {
                return `
                <div class="group flex items-center justify-between p-4 mb-3 rounded-2xl border border-[var(--glass-border)] bg-[var(--bg-card)] hover:border-red-500/50 transition-all shadow-sm">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-xl bg-red-500/10 flex items-center justify-center text-red-500">
                            <i class="ph-fill ph-bank text-xl"></i>
                        </div>
                        <div>
                            <div class="flex items-center gap-2 flex-wrap">
                                <span class="font-bold text-lg text-white preserve-white">PRELIEVO (Payout)</span>
                                <span class="text-xs px-2 py-0.5 rounded text-red-500 bg-red-500/10 font-bold border border-red-500/20">REGISTRATO</span>
                                <span class="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 text-[9px] font-bold uppercase tracking-wide flex-shrink-0 border border-blue-500/20">${DataStore.data.accounts.find(a => a.id == t.accountId)?.name || 'N/D'}</span>
                            </div>
                            <div class="text-xs text-[var(--text-muted)] mt-0.5 flex items-center gap-2">
                                <i class="ph ph-calendar"></i> ${ui.formatDate(t.date)}
                            </div>
                        </div>
                    </div>
                    <div class="flex items-center gap-6">
                        <span class="text-lg font-bold text-red-500">
                            -${ui.formatCurrency(Math.abs(t.pnl))}
                        </span>
                        <button onclick="event.stopPropagation(); ui.deleteTradeWrapper(event, ${t.id})"
                                class="w-8 h-8 rounded-full hover:bg-red-500/10 text-[var(--text-muted)] hover:text-red-500 transition-colors flex items-center justify-center opacity-0 group-hover:opacity-100">
                            <i class="ph-bold ph-trash"></i>
                        </button>
                    </div>
                </div>`;
            }

            // STANDARD TRADE CARD RENDERING
            const isDraft = t.status === 'draft';
            const isBrokerTrade = t.broker && t.broker !== '';
            return `
                    <div onclick="ui.showTradeDetail(${t.id})" class="group flex items-center justify-between p-4 rounded-2xl hover:bg-[var(--input-bg)] transition-all cursor-pointer border border-transparent hover:border-white/5">
                        <div class="flex items-center gap-3 md:gap-4 min-w-0">
                            <div class="w-10 h-10 rounded-xl flex-shrink-0 flex items-center justify-center ${t.direction === 'LONG' ? 'bg-green-500/10 text-green-500' : 'bg-red-500/10 text-red-500'} font-bold text-xs">${t.direction === 'LONG' ? 'L' : 'S'}</div>
                            <div class="min-w-0">
                                <h4 class="font-bold text-base text-white preserve-white flex items-center gap-2 flex-wrap">
                                    <span class="truncate">${t.asset}</span>
                                    ${isDraft ? '<span class="px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-500 text-[9px] font-bold uppercase tracking-wide flex-shrink-0">Bozza</span>' : ''}
                                    ${t.status === 'missed' ? '<span class="px-1.5 py-0.5 rounded bg-gray-500/20 text-gray-500 text-[9px] font-bold uppercase flex-shrink-0">Missed</span>' : ''}
                                    ${isBrokerTrade ? `<span class="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 text-[9px] font-bold uppercase tracking-wide flex-shrink-0 border border-purple-500/20 flex items-center gap-1"><i class="ph-fill ph-link text-[8px]"></i>${t.broker}</span>` : ''}
                                    <span class="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 text-[9px] font-bold uppercase tracking-wide flex-shrink-0 border border-blue-500/20">${DataStore.data.accounts.find(a => a.id == t.accountId)?.name || 'N/D'}</span>
                                </h4>
                                <p class="text-xs text-[var(--text-muted)] truncate">${ui.formatDate(t.date)} • ${t.strategy || '-'}</p>
                            </div>
                        </div>
                        <div class="flex items-center gap-2 md:gap-6 flex-shrink-0 ml-2">
                            <div class="text-right">
                                <p class="font-bold text-base ${t.pnl >= 0 ? 'text-green-500' : (t.pnl < 0 ? 'text-red-500' : 'text-[var(--text-muted)]')}">
                                    ${isDraft ? '-' : (t.status === 'missed' ? 'MISSED' : ui.formatCurrency(t.pnl))}
                                </p>
                                <p class="text-xs text-[var(--text-muted)]">${t.rr ? t.rr + 'R' : ''}</p>
                            </div>
                            <div class="flex gap-1 md:gap-2 opacity-100 md:opacity-0 group-hover:opacity-100 transition-all">
                                <button onclick="event.stopPropagation(); ui.openEditTradeModal(${t.id})" class="w-8 h-8 rounded-full flex items-center justify-center hover:bg-blue-500/20 text-[var(--text-muted)] hover:text-blue-500 p-0"><i class="ph-bold ph-pencil-simple"></i></button>
                                <button onclick="ui.deleteTradeWrapper(event, ${t.id})" class="w-8 h-8 rounded-full flex items-center justify-center hover:bg-red-500/20 text-[var(--text-muted)] hover:text-red-500 p-0"><i class="ph-bold ph-trash"></i></button>
                            </div>
                        </div>
                    </div>`;
        }).join('') : '<div class="text-center py-20 text-[var(--text-muted)]">Nessun trade trovato.</div>'}
            </div>
        </div>`;
    },
    getFilteredTrades() {
        let trades = DataStore.data.trades;

        // Filtra per account
        if (ui.filters.account !== 'all') {
            trades = trades.filter(t => t.accountId == ui.filters.account);
        }

        // Filtra per periodo temporale
        if (ui.filters.time !== 'all') {
            const now = new Date();
            let startDate;

            switch (ui.filters.time) {
                case '1d':
                    startDate = new Date(now.getTime() - 24 * 60 * 60 * 1000);
                    break;
                case '1w':
                    startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                    break;
                case '1m':
                    startDate = new Date(now.getFullYear(), now.getMonth() - 1, now.getDate());
                    break;
                case '1y':
                    startDate = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
                    break;
            }

            if (startDate) {
                trades = trades.filter(t => new Date(t.date) >= startDate);
            }
        }

        return trades.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    },

    // --- BROKER CONNECTIONS MODAL ---
    openBrokerConnectionsModal() {
        // Feature temporaneamente disabilitata
        if (!BROKER_FEATURE_ENABLED) {
            ui.showToast('⚠️ Funzionalità disponibile a breve!');
            return;
        }
        
        const modal = document.getElementById('modal-account');
        const mt = DataStore.data.settings.brokerConnections.mt5;

        modal.innerHTML = `
            <div class="bg-[var(--bg-card)] rounded-3xl p-8 w-full max-w-2xl max-h-[90vh] overflow-y-auto custom-scrollbar">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-2xl font-bold">Connessioni Broker</h3>
                    <button onclick="ui.closeModals()" class="w-10 h-10 rounded-full hover:bg-white/10 flex items-center justify-center"><i class="ph-bold ph-x"></i></button>
                </div>
                
                <div class="space-y-6">
                    <!-- MetaTrader 5 (DISABLED TEMPORARILY) -->
                    <div class="bg-[var(--input-bg)] rounded-2xl p-5 border border-white/5 opacity-60 relative overflow-hidden">
                        <div class="absolute inset-0 bg-black/10 z-10 cursor-not-allowed"></div>
                        <div class="flex items-center justify-between mb-4">
                            <div class="flex items-center gap-3">
                                <div class="w-10 h-10 rounded-xl bg-gray-500/10 flex items-center justify-center">
                                    <i class="ph-fill ph-trend-up text-gray-400"></i>
                                </div>
                                <div>
                                    <h4 class="text-lg font-bold text-gray-400">MetaTrader 5</h4>
                                    <p class="text-xs text-[var(--text-muted)]">In manutenzione</p>
                                </div>
                            </div>
                            <div class="px-2 py-1 rounded bg-yellow-500/10 text-yellow-500 text-[10px] font-bold uppercase tracking-wider border border-yellow-500/20">
                                Presto
                            </div>
                        </div>
                         <!-- Hidden inputs to prevent errors on save -->
                         <div class="hidden">
                            <input type="checkbox" id="mt5-enabled">
                            <input type="text" id="mt5-apiKey" value="${mt.apiKey || ''}">
                            <input type="text" id="mt5-accountId" value="${mt.accountId || ''}">
                            <input type="text" id="mt5-server" value="${mt.server || ''}">
                         </div>
                    </div>
                    
                <div class="flex gap-3 mt-6">
                    <button onclick="ui.saveBrokerConnections()" class="flex-1 py-3 rounded-xl bg-[var(--accent-blue)] text-white preserve-white font-bold hover:opacity-90">
                        <i class="ph-bold ph-floppy-disk"></i> Salva Configurazione
                    </button>
                    <button onclick="ui.syncBrokerTrades()" class="px-6 py-3 rounded-xl bg-green-500 text-white preserve-white font-bold hover:opacity-90">
                        <i class="ph-bold ph-arrows-clockwise"></i> Sincronizza Ora
                    </button>
                </div>
            </div>
        `;

        ui.openModal('modal-account');
    },

    saveBrokerConnections() {
        // MT5
        DataStore.saveBrokerConnection('mt5', {
            enabled: document.getElementById('mt5-enabled').checked,
            apiKey: document.getElementById('mt5-apiKey').value,
            accountId: document.getElementById('mt5-accountId').value,
            server: document.getElementById('mt5-server').value
        });

        DataStore.save();

        ui.showToast('✅ Configurazione salvata');
        ui.closeModals();

        // Trigger auto-sync after save if enabled
        if (DataStore.data.settings.brokerConnections.mt5.enabled) {
            setTimeout(() => ui.syncBrokerTrades(), 500);
        }
    },


    // --- ACCOUNTS ---
    accounts() {
        const accs = DataStore.data.accounts;
        const getProgress = (a) => {
            if (a.type !== 'challenge' || !a.target || a.target <= a.size) return 0;
            const profit = a.balance - a.size;
            const goal = a.target - a.size;
            if (profit <= 0) return 0;
            let pct = (profit / goal) * 100;
            return Math.min(Math.max(pct, 0), 100);
        };

        // Calcola totali
        const totalBalance = accs.reduce((sum, a) => sum + a.balance, 0);
        const totalSize = accs.reduce((sum, a) => sum + a.size, 0);
        const totalProfit = totalBalance - totalSize;
        const totalProfitPercent = totalSize > 0 ? ((totalProfit / totalSize) * 100).toFixed(2) : 0;

        // Controlla se ci sono account che possono fare payout (funded o live)
        const canPayout = accs.some(a => a.type === 'funded' || a.type === 'live');

        ui.container.innerHTML = `
        <div class="fade-in flex flex-col w-full">
            <!-- Header con statistiche globali -->
            <div class="mb-6 px-4 md:px-6">
                <button onclick="router.navigate('system')" class="mb-4 flex items-center gap-2 text-sm font-bold text-[var(--text-muted)] hover:text-white preserve-white transition-all group">
                    <i class="ph-bold ph-arrow-left text-lg group-hover:-translate-x-1 transition-transform"></i>
                    <span>Torna a System</span>
                </button>
                <div class="flex justify-between items-center gap-4 mb-6">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 md:w-12 md:h-12 rounded-2xl bg-[var(--accent-blue)] flex items-center justify-center">
                            <i class="ph-fill ph-wallet text-white preserve-white text-xl md:text-2xl"></i>
                        </div>
                        <div>
                            <h2 class="text-xl md:text-4xl font-bold tracking-tight text-white preserve-white leading-tight">Portfolio</h2>
                            <p class="text-[10px] md:text-sm text-[var(--text-muted)] hidden md:block">Gestisci i tuoi account</p>
                        </div>
                    </div>
                    <div class="flex items-center gap-2">
                        ${canPayout ? `
                        <button onclick="ui.openPayoutModal()" class="group w-10 h-10 md:w-auto md:h-auto md:px-4 md:py-2.5 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 hover:border-green-500/50 text-white preserve-white font-semibold text-sm transition-all flex items-center justify-center gap-2">
                            <i class="ph-bold ph-currency-dollar text-lg text-green-400"></i>
                            <span class="hidden md:inline">Payout</span>
                        </button>
                        ` : ''}

                        <button onclick="ui.openNewAccountModal()" class="bg-[var(--accent-blue)] text-white preserve-white w-10 h-10 md:w-auto md:h-auto md:px-5 md:py-2.5 rounded-xl font-bold hover:opacity-90 transition-all flex items-center justify-center gap-2 shadow-lg shadow-blue-500/20 hover:shadow-blue-500/40">
                            <i class="ph-bold ph-plus-circle text-lg"></i>
                            <span class="hidden md:inline">Nuovo Conto</span>
                        </button>
                    </div>
                </div>
            </div>

            <!-- Lista Conti -->
            <div class="flex-1 overflow-y-auto custom-scrollbar px-4 md:px-6 pb-8">
                ${accs.length > 0 ? `
                <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
                    ${accs.map(a => {
            const isFunded = a.type === 'funded';
            const isLive = a.type === 'live';
            const isChallenge = a.type === 'challenge';
            const progress = isChallenge ? getProgress(a) : 0;
            const hasPayout = isFunded || isLive;
            const profitLoss = a.balance - a.size;
            const profitPercent = ((profitLoss / a.size) * 100).toFixed(2);

            let accentColor, iconName, typeLabel;
            if (isFunded) {
                accentColor = 'blue';
                iconName = 'ph-medal'; typeLabel = 'Funded';
            } else if (isLive) {
                accentColor = 'green';
                iconName = 'ph-broadcast'; typeLabel = 'Live';
            } else {
                accentColor = 'purple';
                iconName = 'ph-trophy'; typeLabel = 'Challenge';
            }

            return `
                        <div class="group relative bg-[var(--bg-card)] rounded-2xl border-2 border-${accentColor}-500/30 hover:border-${accentColor}-500 transition-all p-4 md:p-6 hover:shadow-2xl hover:shadow-${accentColor}-500/20">
                            <!-- Header -->
                            <div class="flex items-center justify-between mb-4 md:mb-6 pb-4 border-b border-white/10">
                                <div class="flex items-center gap-3">
                                    <div class="w-12 h-12 md:w-14 md:h-14 rounded-xl bg-gradient-to-br from-${accentColor}-500 to-${accentColor}-600 flex items-center justify-center shadow-lg shadow-${accentColor}-500/30">
                                        <i class="ph-fill ${iconName} text-white preserve-white text-xl md:text-2xl"></i>
                                    </div>
                                    <div>
                                        <h3 class="font-bold text-lg md:text-xl text-white preserve-white mb-1">${a.name}</h3>
                                        <div class="flex items-center gap-2 flex-wrap">
                                            <span class="inline-flex items-center gap-1.5 px-2 md:px-3 py-1 rounded-full bg-${accentColor}-500/20 text-${accentColor}-400 text-[10px] md:text-xs font-bold uppercase tracking-wide border border-${accentColor}-500/30">
                                                ${typeLabel}
                                            </span>
                                            ${isChallenge && a.phase ? `
                                                <span class="inline-flex items-center gap-1.5 px-2 md:px-2.5 py-1 rounded-full bg-purple-500/20 text-purple-400 text-[10px] md:text-xs font-bold border border-purple-500/30">
                                                    <i class="ph-fill ph-steps text-xs"></i>
                                                    Fase ${a.phase}
                                                </span>
                                            ` : ''}
                                        </div>
                                    </div>
                                </div>
                                <div class="flex items-center gap-2">
                                    <button onclick="ui.openEditAccountModal(${a.id})" class="min-h-[44px] min-w-[44px] rounded-xl hover:bg-blue-500/20 text-[var(--text-muted)] hover:text-blue-400 flex items-center justify-center bg-transparent border border-transparent transition-all">
                                        <i class="ph-bold ph-pencil-simple text-lg"></i>
                                    </button>
                                    <button onclick="ui.deleteAccount(event, ${a.id})" class="min-h-[44px] min-w-[44px] rounded-xl hover:bg-red-500/20 text-[var(--text-muted)] hover:text-red-400 flex items-center justify-center bg-transparent border border-transparent">
                                        <i class="ph-bold ph-trash text-lg"></i>
                                    </button>
                                </div>
                            </div>

                            <!-- Stats Grid -->
                            <div class="grid grid-cols-2 gap-3 md:gap-4 mb-4 md:mb-6">
                                <!-- Saldo -->
                                <div class="col-span-2 p-3 md:p-4 rounded-xl bg-gradient-to-br from-${accentColor}-500/10 to-${accentColor}-600/5 border border-${accentColor}-500/20">
                                    <div class="flex items-center justify-between mb-2">
                                        <span class="text-[10px] md:text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">Saldo Attuale</span>
                                        ${profitLoss !== 0 ? `
                                            <span class="flex items-center gap-1 px-2 py-1 rounded-full ${profitLoss >= 0 ? 'bg-green-500/20 text-green-400 border border-green-500/30' : 'bg-red-500/20 text-red-400 border border-red-500/30'} text-[10px] md:text-xs font-bold">
                                                <i class="ph-fill ph-trend-${profitLoss >= 0 ? 'up' : 'down'}"></i>
                                                ${profitLoss >= 0 ? '+' : ''}${profitPercent}%
                                            </span>
                                        ` : ''}
                                    </div>
                                    <p class="text-2xl md:text-3xl font-bold text-${accentColor}-400">${ui.formatCurrency(a.balance)}</p>
                                </div>
                                
                                <!-- Capital Iniziale -->
                                <div class="p-3 md:p-4 rounded-xl bg-white/5 border border-white/10">
                                    <p class="text-[10px] md:text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2">Capitale</p>
                                    <p class="text-base md:text-lg font-bold text-white preserve-white">${ui.formatCurrency(a.size)}</p>
                                </div>
                                
                                <!-- P&L -->
                                <div class="p-3 md:p-4 rounded-xl bg-white/5 border border-white/10">
                                    <p class="text-[10px] md:text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2">P&L</p>
                                    <p class="text-base md:text-lg font-bold ${profitLoss >= 0 ? 'text-green-400' : 'text-red-400'}">${profitLoss >= 0 ? '+' : ''}${ui.formatCurrency(profitLoss)}</p>
                                </div>
                            </div>


                            ${a.capitalComConnected ? `
                            <!-- Capital.com LIVE Badge -->
                            <div class="mb-4 md:mb-6 p-3 md:p-4 rounded-xl bg-gradient-to-r from-emerald-500/10 to-teal-500/10 border border-emerald-500/20">
                                <div class="flex items-center justify-between">
                                    <div class="flex items-center gap-2">
                                        <div class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse shadow-lg shadow-emerald-400/50"></div>
                                        <span class="text-xs font-bold uppercase tracking-wider text-emerald-400">Capital.com Live</span>
                                    </div>
                                    <span class="text-[10px] text-[var(--text-muted)]">${a.capitalComLastBalanceUpdate ? 'Agg. ' + new Date(a.capitalComLastBalanceUpdate).toLocaleTimeString('it-IT', {hour:'2-digit',minute:'2-digit'}) : 'In attesa...'}</span>
                                </div>
                                ${a.capitalComEquity ? `
                                <div class="mt-2 flex items-center justify-between">
                                    <span class="text-[10px] text-[var(--text-muted)] uppercase tracking-wider">Equity Live</span>
                                    <span class="text-sm font-bold text-emerald-400">${a.capitalComCurrency || 'USD'} ${(a.capitalComEquity || 0).toFixed(2)}</span>
                                </div>` : ''}
                            </div>
                            ` : ''}

                            ${isChallenge && progress > 0 ? `
                            <!-- Progress Bar Challenge -->
                            <div class="mb-6 p-4 rounded-xl bg-gradient-to-r from-purple-500/10 to-purple-600/5 border border-purple-500/30">
                                <div class="flex items-center justify-between mb-3">
                                    <span class="text-xs font-bold uppercase tracking-wider text-purple-400">Progress Challenge</span>
                                    <span class="text-lg font-bold text-purple-400">${progress.toFixed(1)}%</span>
                                </div>
                                <div class="w-full h-3 bg-[var(--input-bg)] rounded-full overflow-hidden mb-2">
                                    <div class="h-full bg-gradient-to-r from-purple-500 to-purple-600 rounded-full transition-all duration-500 shadow-lg shadow-purple-500/50" style="width: ${progress}%"></div>
                                </div>
                                <div class="flex items-center justify-between">
                                    <span class="text-xs text-[var(--text-muted)]">Target: ${ui.formatCurrency(a.target)}</span>
                                    <span class="text-xs font-bold text-purple-400">${ui.formatCurrency(a.target - a.balance)} mancanti</span>
                                </div>
                            </div>
                            ` : ''}

                            <!-- Azioni -->
                            ${hasPayout ? `
                                <button onclick="ui.openPayoutModal(${a.id})"
                                    class="w-full py-3.5 rounded-xl bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white preserve-white text-sm font-bold transition-all flex items-center justify-center gap-2 shadow-lg shadow-green-500/30 hover:shadow-green-500/50">
                                    <i class="ph-bold ph-bank text-lg"></i>
                                    <span>Richiedi Payout</span>
                                </button>
                            ` : `
                                <div class="flex items-center justify-center gap-2 py-3.5 rounded-xl bg-${accentColor}-500/10 border border-${accentColor}-500/30">
                                    <i class="ph-fill ph-check-circle text-${accentColor}-400 text-lg"></i>
                                    <span class="text-sm font-bold text-${accentColor}-400">Account Attivo</span>
                                </div>
                            `}
                        </div>`;
        }).join('')}
                </div>` : `
                <!-- Empty State -->
                <div class="flex flex-col items-center justify-center h-[60vh]">
                    <div class="text-center max-w-lg p-10 rounded-2xl bg-[var(--bg-card)] border border-white/10">
                        <div class="relative mb-6 inline-block">
                            <div class="w-24 h-24 rounded-2xl bg-[var(--accent-blue)]/10 flex items-center justify-center mx-auto">
                                <i class="ph-duotone ph-wallet text-6xl text-[var(--accent-blue)]"></i>
                            </div>
                        </div>
                        <h3 class="text-2xl font-bold text-white preserve-white mb-3">Inizia il Tuo Viaggio</h3>
                        <p class="text-sm text-[var(--text-muted)] mb-8 max-w-sm mx-auto">Aggiungi il tuo primo account di trading per iniziare a monitorare le tue performance</p>
                        <button onclick="ui.openNewAccountModal()" class="px-8 py-4 rounded-xl bg-[var(--accent-blue)] hover:bg-blue-600 text-white preserve-white font-bold text-base transition-all inline-flex items-center gap-3">
                            <i class="ph-bold ph-plus text-xl"></i>
                            <span>Crea il Tuo Primo Conto</span>
                        </button>
                    </div>
                </div>
                `}
            </div>
        </div>`;
    },

    // --- NEWS ---
    async news() {
        ui.container.innerHTML = `
            <div class="flex flex-col items-center justify-center min-h-[50vh] fade-in w-full">
                <i class="ph-duotone ph-globe-hemisphere-east text-6xl text-[var(--accent-blue)] mb-6 animate-pulse"></i>
                <p class="text-xs font-bold text-[var(--text-muted)] tracking-[0.2em] uppercase">Analisi Mercati...</p>
            </div>`;

        try {
            const newsItems = await DataStore.fetchRealNews().catch(err => {
                console.error('Errore caricamento news:', err);
                return [];
            });
            const filteredNews = ui.newsFilter === 'all' ? newsItems : newsItems.filter(n => n.category === ui.newsFilter);

            const getImpactDot = (impact) => {
                if (impact === 'High') return '<span class="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse"></span><span class="text-red-400">High Impact</span>';
                if (impact === 'Medium') return '<span class="w-2 h-2 rounded-full bg-yellow-500"></span><span class="text-yellow-500">Medium</span>';
                return '<span class="w-2 h-2 rounded-full bg-gray-500"></span><span class="text-gray-400">Low</span>';
            };

            // Conta le notizie per categoria
            const newsCounts = {
                'all': newsItems.length,
                'Forex': newsItems.filter(n => n.category === 'Forex').length,
                'Crypto': newsItems.filter(n => n.category === 'Crypto').length,
                'Stocks': newsItems.filter(n => n.category === 'Stocks').length
            };

            const categories = [
                { id: 'all', icon: 'ph-squares-four', label: 'Tutti', color: 'blue' },
                { id: 'Forex', icon: 'ph-currency-dollar', label: 'Forex', color: 'emerald' },
                { id: 'Crypto', icon: 'ph-currency-btc', label: 'Crypto', color: 'orange' },
                { id: 'Stocks', icon: 'ph-chart-line-up', label: 'Stocks', color: 'indigo' }
            ];

            ui.container.innerHTML = `
        <div class="fade-in flex flex-col w-full">
            <div class="flex flex-col xl:flex-row justify-between items-end xl:items-center gap-4 mb-3 pt-2 pb-3 shrink-0 px-2 md:px-4 border-b border-white/5">
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <div class="w-1.5 h-1.5 bg-[var(--accent-blue)] rounded-full animate-pulse"></div>
                        <h2 class="text-[10px] font-bold tracking-[0.2em] uppercase text-[var(--accent-blue)]">Live Feed</h2>
                    </div>
                    <h1 class="text-3xl font-bold text-white preserve-white tracking-tight">Market Pulse</h1>
                </div>

                <!-- Chips con Badge -->
                <div class="flex gap-2 flex-wrap">
                    ${categories.map(cat => {
                const isActive = ui.newsFilter === cat.id;
                const count = newsCounts[cat.id] || 0;
                return `
                        <button 
                            onclick="ui.newsFilter='${cat.id}'; ui.news()" 
                            class="group relative overflow-hidden pl-3 pr-2 py-1.5 rounded-full transition-all duration-200 ${isActive
                        ? `bg-${cat.color}-500/20 border border-${cat.color}-500/40 shadow-lg shadow-${cat.color}-500/20 scale-105`
                        : 'bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20 hover:scale-105'
                    }">
                            <div class="flex items-center gap-2 relative z-10">
                                <i class="ph-fill ${cat.icon} text-xs ${isActive ? `text-${cat.color}-400` : 'text-[var(--text-muted)] group-hover:text-white preserve-white'}"></i>
                                <span class="text-[10px] font-bold uppercase tracking-wide ${isActive ? `text-${cat.color}-400` : 'text-[var(--text-muted)] group-hover:text-white preserve-white'}">${cat.label}</span>
                                <span class="flex items-center justify-center min-w-[18px] h-[18px] px-1.5 rounded-full text-[9px] font-bold ${isActive
                        ? `bg-${cat.color}-500 text-white preserve-white shadow-lg`
                        : 'bg-white/10 text-[var(--text-muted)] group-hover:bg-white/20 group-hover:text-white preserve-white'
                    }">${count}</span>
                            </div>
                        </button>
                        `;
            }).join('')}
                </div>
            </div>

            <div id="news-section" class="flex-1 overflow-y-auto custom-scrollbar px-0 md:px-1 space-y-3 pb-36">
                ${filteredNews.length > 0 ? `
                    ${(() => {
                        const hero = filteredNews[0];
                        return `
                        <a href="${hero.link}" target="_blank" class="group relative block w-full h-[55vh] min-h-[420px] md:rounded-[24px] overflow-hidden mb-3 border-y md:border border-white/10 hover:border-[var(--accent-blue)]/30 transition-all shadow-2xl">
                            <div class="absolute inset-0 bg-cover bg-center transition-transform duration-1000 group-hover:scale-105" style="background-image: url('${hero.image}');"></div>
                            <div class="absolute inset-0 bg-gradient-to-t from-black via-black/50 to-transparent"></div>
                            <div class="absolute bottom-0 left-0 right-0 p-6 md:p-10 flex flex-col items-start gap-3">
                                <div class="flex items-center gap-3">
                                    <div class="flex items-center gap-2 bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10">
                                        <img src="https://www.google.com/s2/favicons?domain=${hero.sourceDomain}&sz=32" class="w-4 h-4 rounded-full" alt="${hero.sourceName}">
                                        <span class="text-[10px] font-bold text-white preserve-white uppercase tracking-wider">${hero.sourceName}</span>
                                    </div>
                                    <div class="flex items-center gap-1.5 bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/5 text-[10px] font-bold uppercase tracking-wide">
                                        ${getImpactDot(hero.impact)}
                                    </div>
                                </div>
                                <h2 class="text-2xl md:text-5xl font-bold text-white preserve-white leading-tight max-w-5xl group-hover:text-[var(--accent-blue)] transition-colors text-shadow drop-shadow-md">${hero.title}</h2>
                                <p class="text-sm md:text-base text-gray-300 max-w-3xl line-clamp-2 hidden md:block">${hero.summary}</p>
                            </div>
                        </a>
                        `;
                    })()}

                    <div class="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 px-2 md:px-0">
                        ${filteredNews.slice(1).map(n => `
                        <a href="${n.link}" target="_blank" class="flex flex-col bg-[var(--bg-card)] rounded-xl overflow-hidden border border-white/5 hover:border-[var(--accent-blue)]/30 hover:-translate-y-1 hover:shadow-xl transition-all duration-300 group h-full">
                            <div class="h-36 relative overflow-hidden shrink-0">
                                <div class="absolute inset-0 bg-cover bg-center transition-transform duration-700 group-hover:scale-110" style="background-image: url('${n.image}');"></div>
                                <div class="absolute inset-0 bg-gradient-to-t from-black/80 to-transparent opacity-60"></div>
                                <div class="absolute bottom-2 left-3 right-3 flex justify-between items-end">
                                       <div class="flex items-center gap-1.5 text-[9px] font-bold uppercase tracking-wider bg-black/60 backdrop-blur-sm px-2 py-0.5 rounded-md border border-white/10">
                                           ${getImpactDot(n.impact)}
                                       </div>
                                </div>
                            </div>
                            <div class="p-4 flex flex-col flex-1">
                                <div class="flex justify-between items-center mb-2">
                                    <div class="flex items-center gap-1.5 opacity-60">
                                            <img src="https://www.google.com/s2/favicons?domain=${n.sourceDomain}&sz=16" class="w-3 h-3 rounded-full" alt="Source">
                                            <span class="text-[9px] font-bold uppercase tracking-wide">${n.sourceName}</span>
                                    </div>
                                    <span class="text-[9px] font-bold text-[var(--text-muted)]">${new Date(n.pubDate).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}</span>
                                </div>
                                <h3 class="text-sm font-bold text-white preserve-white leading-snug mb-1 line-clamp-3 group-hover:text-[var(--accent-blue)] transition-colors">${n.title}</h3>
                            </div>
                        </a>
                        `).join('')}
                    </div>
                ` : `
                    <div class="flex flex-col items-center justify-center py-20 opacity-50">
                        <i class="ph-duotone ph-newspaper-clipping text-6xl text-[var(--text-muted)] mb-4"></i>
                        <p class="text-lg font-bold text-white preserve-white">Nessuna notizia trovata</p>
                        <p class="text-sm text-[var(--text-muted)]">Abbiamo controllato tutte le fonti. Prova a ricaricare tra poco.</p>
                    </div>
                `}
                

                <div class="text-center py-4 opacity-30 hover:opacity-100 transition-opacity">
                    <p class="text-[9px] font-bold text-[var(--text-muted)] uppercase tracking-widest">Powered by EazyTrader AI</p>
                </div>
            </div>
        </div>`;
        } catch (error) {
            console.error('Errore nella sezione news:', error);
            ui.container.innerHTML = `
                <div class="fade-in flex flex-col items-center justify-center gap-6 px-4">
                    <div class="w-20 h-20 rounded-2xl bg-red-500/10 border border-red-500/20 flex items-center justify-center">
                        <i class="ph-bold ph-warning-circle text-4xl text-red-400"></i>
                    </div>
                    <div class="text-center max-w-md">
                        <h3 class="text-xl font-bold text-white preserve-white mb-2">Impossibile caricare le news</h3>
                        <p class="text-sm text-[var(--text-muted)] mb-6">Si è verificato un errore durante il caricamento dei dati. Controlla la connessione internet e riprova.</p>
                        <button onclick="router.news()" class="px-6 py-3 rounded-xl bg-[var(--accent-blue)] text-white preserve-white font-bold hover:opacity-90 transition-all">
                            <i class="ph-bold ph-arrow-clockwise mr-2"></i>Riprova
                        </button>
                    </div>
                </div>
            `;
        }
    },

    // --- SETTINGS ---
    async settings() {
        const s = DataStore.data.settings;
        const renderTags = (type, items) => items.map(i => `<div class="px-3 py-1.5 rounded-lg bg-[var(--input-bg)] border border-white/5 text-xs font-bold flex items-center gap-2 group">${i}<button onclick="DataStore.updateSetting('${type}', 'remove', '${i}'); router.navigate('settings')" class="hover:text-red-500 transition-colors"><i class="ph-bold ph-x"></i></button></div>`).join('');

        // Calcola storage info
        const storageInfo = await DataStore.getStorageInfo();
        const storageColor = storageInfo.percentUsed > 80 ? 'red' : storageInfo.percentUsed > 50 ? 'yellow' : 'green';

        ui.container.innerHTML = `
        <div class="fade-in max-w-4xl mx-auto pb-10">
            <button onclick="router.navigate('system')" class="mb-4 flex items-center gap-2 text-sm font-bold text-[var(--text-muted)] hover:text-white preserve-white transition-all group">
                <i class="ph-bold ph-arrow-left text-lg group-hover:-translate-x-1 transition-transform"></i>
                <span>Torna a System</span>
            </button>
            <h2 class="text-2xl md:text-4xl font-bold tracking-tight mb-6 md:mb-8">Impostazioni Avanzate</h2>
            <div class="space-y-6">
                
                <!-- Storage Info Card -->
                <div class="bg-[var(--bg-card)] border border-white/5 rounded-3xl p-6 settings-no-hover">
                    <div class="flex items-center justify-between mb-4">
                        <h3 class="text-lg font-bold flex items-center gap-2">
                            <i class="ph-duotone ph-database text-[var(--accent-blue)] text-xl"></i>
                            Spazio Archiviazione
                        </h3>
                        <div class="px-3 py-1 rounded-full bg-${storageColor}-500/10 text-${storageColor}-500 text-xs font-bold">
                            ${storageInfo.percentUsed}% utilizzato
                        </div>
                    </div>
                    
                    <!-- Progress Bar -->
                    <div class="mb-4">
                        <div class="flex justify-between text-xs text-[var(--text-muted)] mb-2">
                            <span>${storageInfo.used} MB utilizzati</span>
                            <span>${storageInfo.available} MB disponibili</span>
                        </div>
                        <div class="h-3 bg-black/20 rounded-full overflow-hidden">
                            <div class="h-full bg-gradient-to-r from-${storageColor}-500 to-${storageColor}-400 rounded-full transition-all duration-500" style="width: ${storageInfo.percentUsed}%"></div>
                        </div>
                        <div class="text-xs text-[var(--text-muted)] mt-2 text-center">
                            Totale disponibile: <span class="font-bold text-white preserve-white">${storageInfo.total} MB</span>
                        </div>
                    </div>
                    
                    <!-- Breakdown -->
                    <div class="grid grid-cols-2 md:grid-cols-5 gap-3 pt-4 border-t border-white/5">
                        <div class="text-center">
                            <div class="text-xs text-[var(--text-muted)] mb-1">Trade</div>
                            <div class="text-sm font-bold">${storageInfo.breakdown.trades} MB</div>
                        </div>
                        <div class="text-center">
                            <div class="text-xs text-[var(--text-muted)] mb-1">Conti</div>
                            <div class="text-sm font-bold">${storageInfo.breakdown.accounts} MB</div>
                        </div>
                        <div class="text-center">
                            <div class="text-xs text-[var(--text-muted)] mb-1">Review</div>
                            <div class="text-sm font-bold">${storageInfo.breakdown.reviews} MB</div>
                        </div>
                        <div class="text-center">
                            <div class="text-xs text-[var(--text-muted)] mb-1">Task</div>
                            <div class="text-sm font-bold">${storageInfo.breakdown.todos} MB</div>
                        </div>
                        <div class="text-center">
                            <div class="text-xs text-[var(--text-muted)] mb-1">Goals</div>
                            <div class="text-sm font-bold">${storageInfo.breakdown.weeklyGoals} MB</div>
                        </div>
                    </div>
                </div>

                <div class="bg-[var(--bg-card)] border border-white/5 rounded-3xl p-6 settings-no-hover"><h3 class="text-lg font-bold mb-4 flex items-center gap-2"><i class="ph-duotone ph-currency-circle-dollar text-[var(--accent-blue)]"></i> Asset Preferiti</h3><div class="flex flex-wrap gap-2 mb-4">${renderTags('assets', s.assets)}</div><div class="flex gap-2"><input type="text" id="new-asset" class="bg-[var(--input-bg)] rounded-xl px-4 py-2 text-sm font-bold flex-1 outline-none focus:ring-1 focus:ring-[var(--accent-blue)] transition-all" placeholder="Es. EURUSD"><button onclick="DataStore.updateSetting('assets', 'add', document.getElementById('new-asset').value.toUpperCase()); router.navigate('settings')" class="bg-[var(--accent-blue)] text-white preserve-white px-4 py-2 rounded-xl font-bold"><i class="ph-bold ph-plus"></i></button></div></div>
                
                <div class="bg-[var(--bg-card)] border border-white/5 rounded-3xl p-6 settings-no-hover"><h3 class="text-lg font-bold mb-4 flex items-center gap-2"><i class="ph-duotone ph-strategy text-[var(--accent-blue)]"></i> Strategie</h3><div class="flex flex-wrap gap-2 mb-4">${renderTags('strategies', s.strategies)}</div><div class="flex gap-2"><input type="text" id="new-strat" class="bg-[var(--input-bg)] rounded-xl px-4 py-2 text-sm font-bold flex-1 outline-none focus:ring-1 focus:ring-[var(--accent-blue)] transition-all" placeholder="Es. SMC"><button onclick="DataStore.updateSetting('strategies', 'add', document.getElementById('new-strat').value); router.navigate('settings')" class="bg-[var(--accent-blue)] text-white preserve-white px-4 py-2 rounded-xl font-bold"><i class="ph-bold ph-plus"></i></button></div></div>
                
                <div class="bg-[var(--bg-card)] border border-white/5 rounded-3xl p-6 settings-no-hover"><h3 class="text-lg font-bold mb-4 flex items-center gap-2"><i class="ph-duotone ph-clock text-[var(--accent-blue)]"></i> Sessioni</h3><div class="flex flex-wrap gap-2 mb-4">${renderTags('sessions', s.sessions)}</div><div class="flex gap-2"><input type="text" id="new-sess" class="bg-[var(--input-bg)] rounded-xl px-4 py-2 text-sm font-bold flex-1 outline-none focus:ring-1 focus:ring-[var(--accent-blue)] transition-all" placeholder="Es. New York"><button onclick="DataStore.updateSetting('sessions', 'add', document.getElementById('new-sess').value); router.navigate('settings')" class="bg-[var(--accent-blue)] text-white preserve-white px-4 py-2 rounded-xl font-bold"><i class="ph-bold ph-plus"></i></button></div></div>
                
                <div class="bg-[var(--bg-card)] border border-white/5 rounded-3xl p-6 settings-no-hover opacity-70 relative overflow-hidden">
                    <!-- Badge "In Arrivo" -->
                    <div class="absolute top-4 right-4 z-20">
                        <div class="px-3 py-1 rounded-full bg-gradient-to-r from-yellow-500 to-orange-500 text-white preserve-white text-[10px] font-bold shadow-lg uppercase tracking-wider">
                            In Arrivo
                        </div>
                    </div>
                    
                    <div class="flex justify-between items-start mb-4">
                        <h3 class="text-lg font-bold flex items-center gap-2 text-gray-400">
                            <i class="ph-duotone ph-plugs-connected text-gray-400"></i> Connessioni Broker
                        </h3>
                    </div>
                    
                    <div class="space-y-3">
                        <div class="flex items-center gap-3 p-3 bg-[var(--input-bg)] rounded-xl opacity-60" style="border: 1px solid transparent !important; transition: none !important;">
                            <div class="w-10 h-10 rounded-lg bg-gray-500/10 flex items-center justify-center">
                                <i class="ph-fill ph-trend-up text-gray-500"></i>
                            </div>
                            <div class="flex-1">
                                <div class="flex justify-between items-center">
                                    <p class="text-sm font-bold text-gray-400">MetaTrader 5</p>
                                    <span class="text-[10px] font-bold text-yellow-500 bg-yellow-500/10 px-2 py-0.5 rounded">SOON</span>
                                </div>
                                <p class="text-xs text-[var(--text-muted)]">Disponibile a breve</p>
                            </div>
                        </div>
                    </div>
                    <p class="text-xs text-[var(--text-muted)] text-center mt-4 italic">Le connessioni ai broker saranno disponibili nel prossimo aggiornamento</p>
                </div>
                
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div class="bg-[var(--bg-card)] border border-white/5 rounded-3xl p-6 settings-no-hover">
                        <h3 class="text-lg font-bold mb-4">Gestione Dati</h3>
                        <div class="space-y-3">
                            <button onclick="ui.exportDashboardPDF()" class="w-full py-3 rounded-xl bg-gradient-to-r from-red-500/20 to-orange-500/20 border border-red-500/30 text-red-400 hover:bg-red-500 hover:text-white transition-all text-xs font-bold flex items-center justify-center gap-2">
                                <i class="ph-bold ph-file-pdf text-base"></i> Esporta Report PDF
                            </button>
                            <button onclick="ui.exportData()" class="w-full py-3 rounded-xl bg-[var(--input-bg)] hover:bg-[var(--accent-blue)] hover:text-white preserve-white transition-all text-xs font-bold flex items-center justify-center gap-2">
                                <i class="ph-bold ph-download-simple"></i> Esporta Backup JSON
                            </button>
                            <div class="relative">
                                <button class="w-full py-3 rounded-xl bg-[var(--input-bg)] hover:bg-[var(--accent-blue)] hover:text-white preserve-white transition-all text-xs font-bold flex items-center justify-center gap-2">
                                    <i class="ph-bold ph-upload-simple"></i> Importa Backup / Trades
                                </button>
                                <input type="file" onchange="ui.importData(this)" class="absolute inset-0 opacity-0 cursor-pointer">
                            </div>
                            <button onclick="ui.resetAllData()" class="w-full py-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white preserve-white transition-all text-xs font-bold flex items-center justify-center gap-2">
                                <i class="ph-bold ph-trash"></i> Reset Totale
                            </button>
                        </div>
                    </div>
                    <div class="bg-[var(--bg-card)] border border-white/5 rounded-3xl p-6 settings-no-hover">
                        <h3 class="text-lg font-bold mb-4">App</h3>
                        <div class="flex justify-between items-center mb-4">
                            <span class="text-sm font-medium opacity-80">Tema</span>
                            <button onclick="ui.toggleTheme()" class="w-10 h-10 rounded-full bg-[var(--input-bg)] flex items-center justify-center hover:bg-white/20 transition-all">
                                <i class="ph-fill ph-sun-dim"></i>
                            </button>
                        </div>
                        <div class="flex justify-between items-center">
                            <span class="text-sm font-medium opacity-80">Versione</span>
                            <span class="text-xs font-mono font-bold text-[var(--text-muted)]">v1.0.2</span>
                        </div>
                    </div>
                </div>
            </div>
        </div>`;
    },

    // --- SYSTEM HUB (NEW PAGE) ---
    system() {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

        ui.container.innerHTML = `
                <div class="fade-in max-w-4xl mx-auto pb-24 px-4">
                    <h2 class="text-2xl md:text-4xl font-bold tracking-tight mb-6 md:mb-8">System</h2>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6 md:overflow-visible" style="padding: 12px 0;">

                        <div onclick="router.navigate('profile')" class="card-apple p-5 md:p-6 flex items-center justify-between cursor-pointer hover:border-cyan-500/50 group transition-all">
                            <div class="flex items-center gap-4">
                                <div class="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white preserve-white shadow-lg group-hover:scale-110 transition-transform">
                                    <i class="ph-fill ph-user-circle text-xl md:text-2xl"></i>
                                </div>
                                <div>
                                    <h3 class="text-base md:text-lg font-bold">Profilo Trader</h3>
                                    <p class="text-[10px] md:text-xs text-[var(--text-muted)]">Visualizza e modifica il tuo profilo.</p>
                                </div>
                            </div>
                            <i class="ph-bold ph-caret-right text-lg text-[var(--text-muted)] group-hover:text-cyan-400 group-hover:translate-x-1 transition-all"></i>
                        </div>

                        <div onclick="router.navigate('accounts')" class="card-apple p-5 md:p-6 flex items-center justify-between cursor-pointer hover:border-[var(--accent-blue)]/50 group transition-all">
                            <div class="flex items-center gap-4">
                                <div class="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-blue-500/10 flex items-center justify-center text-blue-500 group-hover:bg-blue-500 group-hover:text-white preserve-white transition-colors">
                                    <i class="ph-fill ph-bank text-xl md:text-2xl"></i>
                                </div>
                                <div>
                                    <h3 class="text-base md:text-lg font-bold">Gestione Conti</h3>
                                    <p class="text-[10px] md:text-xs text-[var(--text-muted)]">Crea e monitora gli account.</p>
                                </div>
                            </div>
                            <i class="ph-bold ph-caret-right text-lg text-[var(--text-muted)] group-hover:text-blue-400 group-hover:translate-x-1 transition-all"></i>
                        </div>

                        <div onclick="router.navigate('settings')" class="card-apple p-5 md:p-6 flex items-center justify-between cursor-pointer hover:border-purple-500/50 group transition-all">
                            <div class="flex items-center gap-4">
                                <div class="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-purple-500/10 flex items-center justify-center text-purple-500 group-hover:bg-purple-500 group-hover:text-white preserve-white transition-colors">
                                    <i class="ph-fill ph-gear text-xl md:text-2xl"></i>
                                </div>
                                <div>
                                    <h3 class="text-base md:text-lg font-bold">Impostazioni Avanzate</h3>
                                    <p class="text-[10px] md:text-xs text-[var(--text-muted)]">Gestione asset, strategie e dati.</p>
                                </div>
                            </div>
                            <i class="ph-bold ph-caret-right text-lg text-[var(--text-muted)] group-hover:text-purple-400 group-hover:translate-x-1 transition-all"></i>
                        </div>

                        <div onclick="PremiumUI.openMonteCarloModal()" class="card-apple p-5 md:p-6 flex items-center justify-between cursor-pointer hover:border-indigo-500/50 group transition-all">
                            <div class="flex items-center gap-4">
                                <div class="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-indigo-500/10 flex items-center justify-center text-indigo-500 group-hover:bg-indigo-500 group-hover:text-white preserve-white transition-colors">
                                    <i class="ph-fill ph-chart-scatter text-xl md:text-2xl"></i>
                                </div>
                                <div>
                                    <h3 class="text-base md:text-lg font-bold">Analisi Monte Carlo</h3>
                                    <p class="text-[10px] md:text-xs text-[var(--text-muted)]">Simulazione del rischio su 1.000 scenari.</p>
                                </div>
                            </div>
                            <i class="ph-bold ph-caret-right text-lg text-[var(--text-muted)] group-hover:text-indigo-400 group-hover:translate-x-1 transition-all"></i>
                        </div>

                        <div onclick="ui.toggleTheme()" class="card-apple p-5 md:p-6 flex items-center justify-between cursor-pointer hover:border-yellow-500/50 group transition-all">
                            <div class="flex items-center gap-4">
                                <div class="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-yellow-500/10 flex items-center justify-center text-yellow-500 group-hover:bg-yellow-500 group-hover:text-white preserve-white transition-colors">
                                    <i class="ph-fill ${isDark ? 'ph-sun-dim' : 'ph-moon'} text-xl md:text-2xl"></i>
                                </div>
                                <div>
                                    <h3 class="text-base md:text-lg font-bold">Modalità ${isDark ? 'Giorno' : 'Notte'}</h3>
                                    <p class="text-[10px] md:text-xs text-[var(--text-muted)]">Passa al tema ${isDark ? 'chiaro' : 'scuro'}.</p>
                                </div>
                            </div>
                            <span class="text-[10px] md:text-xs font-bold uppercase text-[var(--accent-blue)] bg-blue-500/10 px-2 py-1 rounded-lg">Switch</span>
                        </div>

                        <div onclick="ui.openCloudSyncModal()" class="card-apple p-5 md:p-6 flex items-center justify-between cursor-pointer hover:border-cyan-500/50 group transition-all relative overflow-hidden">
                            <div class="flex items-center gap-4">
                                <div class="w-10 h-10 md:w-12 md:h-12 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white preserve-white shadow-lg group-hover:scale-110 transition-transform relative">
                                    <i class="ph-fill ph-cloud-arrow-up text-xl md:text-2xl"></i>
                                    ${(typeof CloudSync !== 'undefined' && CloudSync.status === 'connected') ? '<div class="absolute -bottom-0.5 -right-0.5 w-3.5 h-3.5 bg-green-500 rounded-full border-2 border-[var(--bg-card)]"></div>' : ''}
                                </div>
                                <div>
                                    <h3 class="text-base md:text-lg font-bold">Cloud Sync</h3>
                                    <p class="text-[10px] md:text-xs text-[var(--text-muted)]">${(typeof CloudSync !== 'undefined' && CloudSync.status === 'connected') ? '<span class="text-green-500 font-bold">Connesso</span> · Codice: ' + CloudSync.getCode() : 'Sincronizza su più dispositivi.'}</p>
                                </div>
                            </div>
                            <i class="ph-bold ph-caret-right text-lg text-[var(--text-muted)] group-hover:text-cyan-400 group-hover:translate-x-1 transition-all"></i>
                        </div>
                    </div>
                </div>`;

        // Aggiorna lo stato del Cloud Sync nell'header se connesso
        if (typeof CloudSync !== 'undefined') {
            this._updateCloudSyncStatusUI();
        }
    },

    // --- CLOUD SYNC UI ---
    openCloudSyncModal() {
        const syncInfo = (typeof CloudSync !== 'undefined') ? CloudSync.getSyncInfo() : { connected: false, code: null, status: 'disconnected', lastSync: null };
        const isConnected = syncInfo.connected;
        const code = syncInfo.code || '';
        const lastSync = syncInfo.lastSync ? new Date(syncInfo.lastSync).toLocaleString('it-IT') : 'Mai';

        const modalHtml = `
            <div class="p-6 md:p-8 space-y-6 max-w-lg mx-auto">
                <div class="flex items-center justify-between">
                    <div>
                        <p class="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Sincronizzazione</p>
                        <h3 class="text-xl font-bold text-white preserve-white">Cloud Sync</h3>
                    </div>
                    <button onclick="ui.closeModal('modal-sync')" class="group w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all text-[var(--text-muted)] hover:text-white preserve-white">
                        <i class="ph-bold ph-x text-lg"></i>
                    </button>
                </div>

                <!-- Descrizione -->
                <div class="bg-cyan-500/10 border border-cyan-500/20 rounded-2xl p-4">
                    <div class="flex items-start gap-3">
                        <i class="ph-fill ph-cloud-arrow-up text-2xl text-cyan-500 mt-0.5"></i>
                        <div>
                            <h4 class="text-sm font-bold text-cyan-400 mb-1">Sync Automatico tra Dispositivi</h4>
                            <p class="text-xs text-[var(--text-muted)] leading-relaxed">Collega PC e iPad con un codice univoco. I tuoi dati si sincronizzano automaticamente ogni volta che salvi qualcosa.</p>
                        </div>
                    </div>
                </div>

                ${isConnected ? `
                <!-- STATO: CONNESSO -->
                <div class="space-y-4">
                    <div class="bg-green-500/10 border border-green-500/20 rounded-2xl p-5 text-center">
                        <div class="w-14 h-14 rounded-full bg-green-500/20 flex items-center justify-center mx-auto mb-3">
                            <i class="ph-fill ph-check-circle text-3xl text-green-500"></i>
                        </div>
                        <p class="text-sm font-bold text-green-400 mb-1">Connesso e Sincronizzato</p>
                        <p class="text-xs text-[var(--text-muted)]">Ultimo sync: ${lastSync}</p>
                    </div>

                    <div class="bg-[var(--input-bg)] rounded-2xl p-5 text-center">
                        <p class="text-xs text-[var(--text-muted)] mb-2">Il tuo codice dispositivo</p>
                        <div class="flex items-center justify-center gap-2">
                            <span class="text-3xl font-black tracking-[0.3em] text-white preserve-white font-mono">${code}</span>
                            <button onclick="navigator.clipboard.writeText('${code}'); ui.showToast('📋 Codice copiato!')" class="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                                <i class="ph-bold ph-copy text-sm text-[var(--text-muted)]"></i>
                            </button>
                        </div>
                        <p class="text-[10px] text-[var(--text-muted)] mt-2">Condividi questo codice con l'altro dispositivo per collegarlo</p>
                    </div>

                    <div class="grid grid-cols-2 gap-3">
                        <button onclick="ui.forceCloudSync()" class="py-3 rounded-xl bg-cyan-500/10 text-cyan-500 hover:bg-cyan-500 hover:text-white preserve-white transition-all text-xs font-bold flex items-center justify-center gap-2">
                            <i class="ph-bold ph-arrows-clockwise"></i> Forza Sync
                        </button>
                        <button onclick="ui.disconnectCloudSync()" class="py-3 rounded-xl bg-red-500/10 text-red-500 hover:bg-red-500 hover:text-white preserve-white transition-all text-xs font-bold flex items-center justify-center gap-2">
                            <i class="ph-bold ph-plug"></i> Disconnetti
                        </button>
                    </div>
                </div>
                ` : `
                <!-- STATO: NON CONNESSO -->
                <div class="space-y-4">
                    <div class="grid grid-cols-1 gap-4">
                        <!-- Genera nuovo codice -->
                        <button onclick="ui.generateCloudSyncCode()" class="group relative bg-gradient-to-br from-cyan-500/10 to-blue-500/5 border-2 border-cyan-500/20 rounded-2xl p-6 hover:border-cyan-500/40 transition-all text-left">
                            <div class="flex items-center gap-4">
                                <div class="w-12 h-12 rounded-xl bg-cyan-500/20 flex items-center justify-center text-cyan-500 group-hover:scale-110 transition-transform">
                                    <i class="ph-bold ph-plus-circle text-2xl"></i>
                                </div>
                                <div>
                                    <h4 class="text-sm font-bold mb-0.5">Primo Dispositivo</h4>
                                    <p class="text-[10px] text-[var(--text-muted)]">Genera un nuovo codice e inizia a sincronizzare</p>
                                </div>
                            </div>
                        </button>

                        <!-- Inserisci codice esistente -->
                        <div class="bg-gradient-to-br from-purple-500/10 to-purple-500/5 border-2 border-purple-500/20 rounded-2xl p-6">
                            <div class="flex items-center gap-4 mb-4">
                                <div class="w-12 h-12 rounded-xl bg-purple-500/20 flex items-center justify-center text-purple-500">
                                    <i class="ph-bold ph-link text-2xl"></i>
                                </div>
                                <div>
                                    <h4 class="text-sm font-bold mb-0.5">Collega Dispositivo</h4>
                                    <p class="text-[10px] text-[var(--text-muted)]">Inserisci il codice dall'altro dispositivo</p>
                                </div>
                            </div>
                            <div class="flex gap-2">
                                <input id="cloud-sync-code-input" type="text" maxlength="6" placeholder="ES: A7X2K9"
                                    class="flex-1 px-4 py-3 rounded-xl bg-[var(--input-bg)] text-center text-lg font-mono font-bold tracking-[0.2em] uppercase border border-white/10 focus:border-purple-500/50 focus:outline-none transition-colors"
                                    oninput="this.value = this.value.toUpperCase().replace(/[^A-Z0-9]/g, '')">
                                <button onclick="ui.connectCloudSyncCode()" class="px-5 py-3 rounded-xl bg-gradient-to-r from-purple-500 to-blue-500 text-white preserve-white font-bold text-xs hover:opacity-90 transition-opacity">
                                    Connetti
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
                `}
            </div>`;

        const modal = document.getElementById('modal-sync');
        if (modal) {
            modal.innerHTML = modalHtml;
            ui.openModal('modal-sync');
        }
    },

    async generateCloudSyncCode() {
        if (typeof CloudSync === 'undefined') {
            ui.showToast('❌ Cloud Sync non disponibile');
            return;
        }
        try {
            const code = CloudSync.generateCode();
            ui.showToast('⏳ Connessione in corso...');
            await CloudSync.connect(code);
            // Push iniziale dei dati locali
            await CloudSync.push();
            ui.showToast('✅ Cloud Sync attivato! Codice: ' + code);
            this.openCloudSyncModal(); // Refresh modal
            // Aggiorna la pagina system se visibile
            if (router.currentPage === 'system') router.navigate('system');
        } catch (e) {
            ui.showToast('❌ Errore: ' + e.message);
        }
    },

    async connectCloudSyncCode() {
        if (typeof CloudSync === 'undefined') {
            ui.showToast('❌ Cloud Sync non disponibile');
            return;
        }
        const input = document.getElementById('cloud-sync-code-input');
        const code = input ? input.value.trim().toUpperCase() : '';

        if (code.length !== 6) {
            ui.showToast('⚠️ Il codice deve essere di 6 caratteri');
            return;
        }
        try {
            ui.showToast('⏳ Connessione in corso...');
            await CloudSync.connect(code);
            ui.showToast('✅ Connesso! Sync in corso...');
            this.openCloudSyncModal(); // Refresh modal
            if (router.currentPage === 'system') router.navigate('system');
        } catch (e) {
            ui.showToast('❌ Errore connessione: ' + e.message);
        }
    },

    async forceCloudSync() {
        if (typeof CloudSync === 'undefined') return;
        try {
            ui.showToast('🔄 Sincronizzazione forzata...');
            await CloudSync.push();
            await CloudSync.pull();
            ui.showToast('✅ Sincronizzazione completata!');
            this.openCloudSyncModal(); // Refresh modal con nuovo timestamp
        } catch (e) {
            ui.showToast('❌ Errore sync: ' + e.message);
        }
    },

    disconnectCloudSync() {
        if (typeof CloudSync === 'undefined') return;
        if (confirm('Vuoi disconnettere il Cloud Sync? I dati locali rimarranno intatti.')) {
            CloudSync.removeCode();
            ui.showToast('✅ Cloud Sync disconnesso');
            this.openCloudSyncModal(); // Refresh modal
            if (router.currentPage === 'system') router.navigate('system');
        }
    },

    _updateCloudSyncStatusUI() {
        // Listener per aggiornamenti di stato del Cloud Sync
        if (typeof CloudSync !== 'undefined' && !CloudSync._uiListenerAttached) {
            CloudSync._uiListenerAttached = true;

            // Nessun indicatore visivo sullo stato 'syncing': la sincronizzazione
            // di background deve restare invisibile.
            window.addEventListener('cloudsync:updated', (e) => {
                if (e.detail?.manual) {
                    ui.showToast('☁️ Dati sincronizzati dal cloud');
                }
                ui.refreshViewSilently();
            });
        }
    },

    // --- PROFILE ---
    profile() {
        const profile = DataStore.data.profile;
        const trades = DataStore.data.trades.filter(t => t.status === 'executed');

        // Calcola statistiche
        const totalTrades = trades.length;
        const winningTrades = trades.filter(t => parseFloat(t.pnl || 0) > 0).length;
        const losingTrades = trades.filter(t => parseFloat(t.pnl || 0) < 0).length;
        const winRate = totalTrades > 0 ? ((winningTrades / totalTrades) * 100).toFixed(1) : 0;
        const totalPnl = trades.reduce((sum, t) => sum + parseFloat(t.pnl || 0), 0);

        // Calcola streak corrente
        let currentStreak = 0;
        let longestWinStreak = 0;
        let tempStreak = 0;

        const sortedTrades = [...trades].sort((a, b) => new Date(b.date) - new Date(a.date));
        for (let i = 0; i < sortedTrades.length; i++) {
            const pnl = parseFloat(sortedTrades[i].pnl || 0);
            if (pnl > 0) {
                tempStreak++;
                if (i === 0) currentStreak = tempStreak;
                longestWinStreak = Math.max(longestWinStreak, tempStreak);
            } else {
                if (i === 0) currentStreak = 0;
                tempStreak = 0;
            }
        }

        // Giorni di trading
        const firstTradeDate = trades.length > 0 ? new Date(Math.min(...trades.map(t => new Date(t.date)))) : new Date();
        const daysSince = Math.floor((new Date() - firstTradeDate) / (1000 * 60 * 60 * 24));

        // Sistema di achievement
        const achievements = [
            { id: 'trader_50', name: '50 Trade', icon: 'ph-chart-line-up', color: 'blue', unlocked: totalTrades >= 50, description: 'Raggiungi 50 trade totali. Stai costruendo esperienza solida!' },
            { id: 'trader_100', name: '100 Trade', icon: 'ph-fire', color: 'orange', unlocked: totalTrades >= 100, description: 'Completa 100 trade. Solo i più dedicati raggiungono questo traguardo!' },
            { id: 'trader_250', name: '250 Trade', icon: 'ph-crown', color: 'yellow', unlocked: totalTrades >= 250, description: 'Raggiungi 250 trade. Sei un trader esperto con esperienza consolidata!' },
            { id: 'win_streak_10', name: '10 Consecutivi', icon: 'ph-lightning', color: 'purple', unlocked: longestWinStreak >= 10, description: 'Raggiungi 10 trade vincenti consecutivi. Consistenza da professionista!' },
            { id: 'win_streak_15', name: '15 Consecutivi', icon: 'ph-trophy', color: 'yellow', unlocked: longestWinStreak >= 15, description: 'Ottieni 15 trade vincenti di fila. Un traguardo straordinario!' },
            { id: 'elite_winrate', name: 'Win Rate Elite', icon: 'ph-medal', color: 'yellow', unlocked: totalTrades >= 50 && winRate >= 70, description: 'Mantieni un Win Rate superiore al 70% con almeno 50 trade. Eccellenza pura!' },
            { id: 'big_profit', name: 'Profitto 1K', icon: 'ph-coins', color: 'green', unlocked: totalPnl >= 1000, description: 'Raggiungi €1000 di profitto totale. Un traguardo significativo!' },
            { id: 'consistent_60', name: '60 Giorni', icon: 'ph-calendar-check', color: 'cyan', unlocked: daysSince >= 60, description: 'Fai trading per almeno 60 giorni. La costanza è fondamentale!' },
            { id: 'consistent_180', name: '6 Mesi', icon: 'ph-calendar-star', color: 'indigo', unlocked: daysSince >= 180, description: 'Raggiungi 6 mesi di attività di trading. Dedizione a lungo termine!' },
            { id: 'master_trader', name: 'Master Trader', icon: 'ph-graduation-cap', color: 'purple', unlocked: totalTrades >= 200 && winRate >= 65 && totalPnl >= 2000, description: 'Completa 200+ trade con Win Rate >65% e P&L >€2000. Sei un vero maestro del trading!' }
        ];

        const unlockedCount = achievements.filter(a => a.unlocked).length;

        const colorMap = {
            'blue': 'from-blue-500 to-blue-600',
            'green': 'from-green-500 to-green-600',
            'orange': 'from-orange-500 to-orange-600',
            'yellow': 'from-yellow-500 to-yellow-600',
            'purple': 'from-purple-500 to-purple-600',
            'cyan': 'from-cyan-500 to-cyan-600',
            'indigo': 'from-indigo-500 to-indigo-600'
        };

        const safeProfilePhoto = this.sanitizeImageUrl(profile.photoUrl || '');
        const safeProfileName = this.escapeHtml(this.sanitizeText(profile.name || 'Trader', 40) || 'Trader');
        const safeProfileBio = this.escapeHtml(this.sanitizeText(profile.bio || 'Nessuna bio', 280) || 'Nessuna bio');
        const safeAvatar = this.escapeHtml(profile.avatar || '👤');

        ui.container.innerHTML = `
        <div class="fade-in max-w-5xl mx-auto pb-10">
            <!-- Header -->
            <div class="mb-6 md:mb-8">
                <div class="flex items-center justify-between mb-4">
                    <h2 class="text-2xl md:text-4xl font-bold tracking-tight">Profilo</h2>
                    <button onclick="ui.openEditProfileModal()" class="bg-[var(--accent-blue)] text-white preserve-white w-10 h-10 md:w-auto md:h-auto md:px-4 md:py-2 rounded-xl font-bold hover:opacity-90 transition-opacity flex items-center justify-center gap-2">
                        <i class="ph-bold ph-pencil-simple text-lg"></i>
                        <span class="hidden md:inline">Modifica</span>
                    </button>
                </div>
            </div>

            <!-- Profile Card -->
            <div class="card-apple p-6 md:p-10 mb-6 md:mb-8 relative overflow-hidden rounded-3xl md:rounded-[2.5rem]">
                
                <div class="relative z-10 flex flex-col md:flex-row gap-6 md:gap-8 items-center">
                    <!-- Avatar -->
                    <div class="w-24 h-24 md:w-36 md:h-36 rounded-2xl md:rounded-[2rem] ${safeProfilePhoto ? '' : 'bg-gradient-to-br from-[var(--accent-blue)] to-purple-600'} flex items-center justify-center text-5xl md:text-7xl shadow-2xl flex-shrink-0 overflow-hidden transform hover:scale-105 transition-transform duration-500">
                        ${safeProfilePhoto ? `<img src="${this.escapeHtml(safeProfilePhoto)}" class="w-full h-full object-cover">` : safeAvatar}
                    </div>
                    
                    <!-- Info -->
                    <div class="flex-1 text-center md:text-left">
                        <h3 class="text-3xl md:text-5xl font-bold mb-2 md:mb-3 bg-clip-text text-transparent bg-gradient-to-r from-white to-white/60 tracking-tight">${safeProfileName}</h3>
                        <p class="text-[var(--text-muted)] text-base md:text-lg mb-4 md:mb-6 leading-relaxed max-w-2xl">${safeProfileBio}</p>
                        <div class="flex flex-wrap gap-4 justify-center md:justify-start text-sm">
                            <div class="flex items-center gap-2 px-4 py-2 bg-white/5 rounded-xl border border-white/5 hover:bg-white/10 transition-colors">
                                <i class="ph-bold ph-calendar text-[var(--accent-blue)] text-lg"></i>
                                <span class="font-bold text-white preserve-white">Membro dal ${new Date(profile.tradingSince || Date.now()).toLocaleDateString('it-IT')}</span>
                            </div>
                            <div class="flex items-center gap-2 px-4 py-2 bg-white/5 rounded-xl border border-white/5 hover:bg-white/10 transition-colors">
                                <i class="ph-bold ph-chart-line text-green-500 text-lg"></i>
                                <span class="font-bold text-white preserve-white">${totalTrades} Trade Totali</span>
                            </div>
                            <div class="flex items-center gap-2 px-4 py-2 bg-white/5 rounded-xl border border-white/5 hover:bg-white/10 transition-colors">
                                <i class="ph-bold ph-trophy text-yellow-500 text-lg"></i>
                                <span class="font-bold text-white preserve-white">${unlockedCount}/${achievements.length} Achievement</span>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Stats Grid -->
            <div class="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8 md:overflow-visible" style="padding: 12px 0;">
                <div class="card-apple p-5 hover:scale-[1.02] transition-transform">
                    <div class="flex items-center gap-3 mb-2">
                        <div class="w-8 h-8 rounded-lg bg-green-500/10 flex items-center justify-center">
                            <i class="ph-fill ph-chart-line-up text-green-500 text-base"></i>
                        </div>
                        <span class="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Win Rate</span>
                    </div>
                    <div class="pl-1">
                        <h4 class="text-2xl font-bold text-green-500">${winRate}%</h4>
                        <p class="text-[10px] text-[var(--text-muted)] mt-1 font-medium">${winningTrades}W / ${losingTrades}L</p>
                    </div>
                </div>

                <div class="card-apple p-5 hover:scale-[1.02] transition-transform">
                    <div class="flex items-center gap-3 mb-2">
                        <div class="w-8 h-8 rounded-lg ${totalPnl >= 0 ? 'bg-green-500/10' : 'bg-red-500/10'} flex items-center justify-center">
                            <i class="ph-fill ph-coins ${totalPnl >= 0 ? 'text-green-500' : 'text-red-500'} text-base"></i>
                        </div>
                        <span class="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">P&L Totale</span>
                    </div>
                    <div class="pl-1">
                        <h4 class="text-2xl font-bold ${totalPnl >= 0 ? 'text-green-500' : 'text-red-500'}">${ui.formatCurrency(totalPnl)}</h4>
                        <p class="text-[10px] text-[var(--text-muted)] mt-1 font-medium">Da ${totalTrades} trade</p>
                    </div>
                </div>

                <div class="card-apple p-5 hover:scale-[1.02] transition-transform">
                    <div class="flex items-center gap-3 mb-2">
                        <div class="w-8 h-8 rounded-lg bg-yellow-500/10 flex items-center justify-center">
                            <i class="ph-fill ph-fire text-yellow-500 text-base"></i>
                        </div>
                        <span class="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider">Streak</span>
                    </div>
                    <div class="pl-1">
                        <h4 class="text-2xl font-bold text-yellow-500">${longestWinStreak}</h4>
                        <p class="text-[10px] text-[var(--text-muted)] mt-1 font-medium">Max consecutivi</p>
                    </div>
                </div>
            </div>

            <!-- Achievements -->
            <div class="bg-[var(--bg-card)] border border-white/5 rounded-2xl p-6">
                <div class="flex items-center justify-between mb-6">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-yellow-500/10 flex items-center justify-center">
                            <i class="ph-fill ph-trophy text-yellow-500 text-xl"></i>
                        </div>
                        <div>
                            <h4 class="text-lg font-bold">Achievement</h4>
                            <p class="text-xs text-[var(--text-muted)]">${unlockedCount} su ${achievements.length} sbloccati</p>
                        </div>
                    </div>
                </div>

                <div class="grid grid-cols-2 md:grid-cols-5 gap-3">
                    ${achievements.map(a => {
            const isUnlocked = a.unlocked;
            return `
                            <div 
                                onclick="ui.showAchievementInfo('${a.name.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', '${a.description.replace(/'/g, "\\'").replace(/"/g, '&quot;')}', ${isUnlocked})"
                                class="group relative ${isUnlocked ? 'bg-gradient-to-br ' + colorMap[a.color] : 'bg-white/5'} rounded-xl p-4 border ${isUnlocked ? 'border-white/20' : 'border-white/10'} transition-all hover:scale-105 ${isUnlocked ? '' : 'opacity-40 grayscale'} cursor-pointer">
                                <div class="flex flex-col items-center gap-2 text-center">
                                    <i class="ph-fill ${a.icon} text-3xl ${isUnlocked ? 'text-white preserve-white' : 'text-[var(--text-muted)]'}"></i>
                                    <span class="text-[10px] font-bold uppercase tracking-wide ${isUnlocked ? 'text-white preserve-white' : 'text-[var(--text-muted)]'}">${a.name}</span>
                                    ${isUnlocked ? '<i class="ph-fill ph-check-circle text-sm text-white opacity-80 preserve-white absolute top-2 right-2"></i>' : '<i class="ph-bold ph-lock text-sm text-[var(--text-muted)] absolute top-2 right-2"></i>'}
                                </div>
                            </div>
                        `;
        }).join('')}
                </div>
            </div>
        </div>`;
    },

    paywall() {
        ui.container.innerHTML = `
        <div class="fade-in min-h-screen flex flex-col items-center justify-center p-6 -mt-16">
            <div class="max-w-2xl w-full">
                <!-- Lock Icon -->
                <div class="text-center mb-8">
                    <div class="inline-block p-6 rounded-3xl bg-gradient-to-br from-blue-500/10 to-purple-500/10 border border-white/10 mb-6">
                        <i class="ph-bold ph-lock text-7xl text-blue-500"></i>
                    </div>
                    <h1 class="text-4xl md:text-5xl font-bold mb-4 bg-clip-text text-transparent bg-gradient-to-r from-blue-500 to-purple-500">
                        Sblocca EazyTrader
                    </h1>
                    <p class="text-[var(--text-muted)] text-lg mb-8">
                        Inserisci la chiave di attivazione per accedere a tutte le funzionalità premium.
                    </p>
                </div>

                <!-- Key Input -->
                <div class="card-apple p-8 mb-6">
                    <label class="block text-sm font-bold text-[var(--text-muted)] mb-3 uppercase tracking-wider">Chiave di Attivazione</label>
                    <input 
                        type="password" 
                        id="paywall-key-input" 
                        placeholder="••••" 
                        maxlength="4"
                        class="w-full bg-white/5 border border-white/10 rounded-xl px-6 py-4 text-2xl text-center tracking-[1rem] font-bold focus:outline-none focus:border-blue-500 transition-colors mb-4"
                        autocomplete="off"
                    />
                    <div id="paywall-error" class="text-red-500 text-sm text-center mb-4 hidden">
                        <i class="ph-bold ph-warning-circle"></i> Chiave non valida
                    </div>
                    <button 
                        onclick="ui.verifyPaywallKey()" 
                        class="w-full bg-gradient-to-r from-blue-500 to-purple-500 text-white preserve-white py-4 rounded-xl font-bold text-lg hover:opacity-90 transition-opacity flex items-center justify-center gap-2">
                        <i class="ph-bold ph-lock-open text-xl"></i>
                        Sblocca
                    </button>
                </div>

                <!-- Premium Features -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-8">
                    <div class="card-apple p-5 flex items-start gap-4">
                        <div class="w-10 h-10 rounded-xl bg-blue-500/10 flex items-center justify-center flex-shrink-0">
                            <i class="ph-fill ph-chart-line text-blue-500"></i>
                        </div>
                        <div>
                            <h4 class="font-bold mb-1">Trading Journal Illimitato</h4>
                            <p class="text-xs text-[var(--text-muted)]">Traccia tutti i tuoi trade senza limiti</p>
                        </div>
                    </div>
                    <div class="card-apple p-5 flex items-start gap-4">
                        <div class="w-10 h-10 rounded-xl bg-purple-500/10 flex items-center justify-center flex-shrink-0">
                            <i class="ph-fill ph-brain text-purple-500"></i>
                        </div>
                        <div>
                            <h4 class="font-bold mb-1">Review Dettagliate</h4>
                            <p class="text-xs text-[var(--text-muted)]">Analisi approfondite delle tue performance</p>
                        </div>
                    </div>
                    <div class="card-apple p-5 flex items-start gap-4">
                        <div class="w-10 h-10 rounded-xl bg-green-500/10 flex items-center justify-center flex-shrink-0">
                            <i class="ph-fill ph-cloud text-green-500"></i>
                        </div>
                        <div>
                            <h4 class="font-bold mb-1">Sync Multi-Dispositivo</h4>
                            <p class="text-xs text-[var(--text-muted)]">Accedi ai tuoi dati ovunque</p>
                        </div>
                    </div>
                    <div class="card-apple p-5 flex items-start gap-4">
                        <div class="w-10 h-10 rounded-xl bg-yellow-500/10 flex items-center justify-center flex-shrink-0">
                            <i class="ph-fill ph-trophy text-yellow-500"></i>
                        </div>
                        <div>
                            <h4 class="font-bold mb-1">Achievement & Statistiche</h4>
                            <p class="text-xs text-[var(--text-muted)]">Monitora i tuoi progressi nel tempo</p>
                        </div>
                    </div>
                </div>

                <p class="text-center text-xs text-[var(--text-muted)]">
                    Hai bisogno di aiuto? <a href="#" class="text-blue-500 hover:underline">Contatta il supporto</a>
                </p>
            </div>
        </div>
        `;

        // Focus sull'input
        setTimeout(() => {
            const input = document.getElementById('paywall-key-input');
            if (input) {
                input.focus();
                input.addEventListener('keypress', (e) => {
                    if (e.key === 'Enter') {
                        ui.verifyPaywallKey();
                    }
                });
            }
        }, 100);
    },

    verifyPaywallKey() {
        const input = document.getElementById('paywall-key-input');
        const error = document.getElementById('paywall-error');
        
        if (!input) return;
        
        const key = input.value.trim();
        
        if (key === '1234') {
            // Chiave corretta - salva e sblocca
            localStorage.setItem('eazy_access_key', '1234');
            
            // Mostra successo
            input.style.borderColor = 'rgb(34, 197, 94)';
            error.classList.add('hidden');
            
            // Toast di successo
            ui.showToast('✅ Accesso sbloccato!');
            
            // Ricarica l'app dopo un breve delay
            setTimeout(() => {
                location.reload();
            }, 800);
        } else {
            // Chiave errata
            input.style.borderColor = 'rgb(239, 68, 68)';
            error.classList.remove('hidden');
            input.value = '';
            input.focus();
            
            // Shake effect
            input.animate([
                { transform: 'translateX(0)' },
                { transform: 'translateX(-10px)' },
                { transform: 'translateX(10px)' },
                { transform: 'translateX(0)' }
            ], { duration: 300 });
        }
    },

    toastTimeout: null,
    showToast(msg) {
        // Rimuove toast precedente se presente
        const existingToast = document.querySelector('.audio-error-toast');
        if (existingToast) existingToast.remove();

        // Crea notifica moderna e pulita
        const toast = document.createElement('div');
        toast.className = 'audio-error-toast';
        toast.style.cssText = `
            position: fixed;
            top: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: rgba(40, 40, 40, 0.5);
            color: white;
            padding: 14px 20px;
            border-radius: 12px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.3);
            font-size: 14px;
            font-weight: 500;
            z-index: 99999;
            animation: slideDown 0.3s ease-out;
            max-width: 320px;
            backdrop-filter: blur(10px);
            display: flex;
            align-items: center;
            gap: 12px;
        `;

        // Aggiungi logo SVG
        const logo = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        logo.setAttribute('width', '20');
        logo.setAttribute('height', '20');
        logo.setAttribute('viewBox', '0 0 24 24');
        logo.setAttribute('fill', 'none');
        logo.setAttribute('stroke', 'currentColor');
        logo.setAttribute('stroke-width', '2');
        logo.innerHTML = '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>';

        const textSpan = document.createElement('span');
        textSpan.textContent = msg.replace(/[❌🎙️✅]/g, '').trim();

        toast.appendChild(logo);
        toast.appendChild(textSpan);

        // Aggiungi animazione
        const style = document.createElement('style');
        style.textContent = `
            @keyframes slideDown {
                from { transform: translateX(-50%) translateY(-100px); opacity: 0; }
                to { transform: translateX(-50%) translateY(0); opacity: 1; }
            }
            @keyframes slideUp {
                from { transform: translateX(-50%) translateY(0); opacity: 1; }
                to { transform: translateX(-50%) translateY(-100px); opacity: 0; }
            }
        `;
        if (!document.querySelector('#toast-animations')) {
            style.id = 'toast-animations';
            document.head.appendChild(style);
        }

        document.body.appendChild(toast);

        // Rimuove dopo 4 secondi
        setTimeout(() => {
            toast.style.animation = 'slideUp 0.3s ease-in';
            setTimeout(() => toast.remove(), 300);
        }, 4000);
    },

    // Toast premium per trade auto-salvati da Capital.com
    showAutoTradeToast(emoji, asset, direction, pnlStr, extraInfo = '') {
        // Accoda toast se ci sono già altri in coda (evita sovrapposizioni)
        if (!ui._autoTradeToastQueue) ui._autoTradeToastQueue = [];
        ui._autoTradeToastQueue.push({ emoji, asset, direction, pnlStr, extraInfo });
        if (ui._autoTradeToastQueue.length > 1) return; // Già in elaborazione

        const showNext = () => {
            if (!ui._autoTradeToastQueue || ui._autoTradeToastQueue.length === 0) return;
            const item = ui._autoTradeToastQueue[0];
            const isWin = item.pnlStr && item.pnlStr.startsWith('+');
            const dirLabel = item.direction === 'long' ? '▲ LONG' : '▼ SHORT';
            const accentColor = isWin ? '#10b981' : '#ef4444';
            const bgColor = isWin ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)';

            // Stile animazione (aggiunto una sola volta)
            if (!document.querySelector('#auto-trade-toast-style')) {
                const style = document.createElement('style');
                style.id = 'auto-trade-toast-style';
                style.textContent = `
                    @keyframes atSlideIn {
                        from { transform: translateX(120%); opacity: 0; }
                        to { transform: translateX(0); opacity: 1; }
                    }
                    @keyframes atSlideOut {
                        from { transform: translateX(0); opacity: 1; }
                        to { transform: translateX(120%); opacity: 0; }
                    }
                `;
                document.head.appendChild(style);
            }

            const toast = document.createElement('div');
            toast.style.cssText = `
                position: fixed;
                bottom: 24px;
                right: 24px;
                background: rgba(18,18,28,0.92);
                border: 1px solid ${accentColor}40;
                border-left: 3px solid ${accentColor};
                color: white;
                padding: 14px 18px;
                border-radius: 14px;
                box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.05);
                font-size: 13px;
                z-index: 99999;
                animation: atSlideIn 0.4s cubic-bezier(0.34,1.56,0.64,1);
                min-width: 240px;
                max-width: 300px;
                backdrop-filter: blur(16px);
            `;

            toast.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">
                    <div style="background:${bgColor};border-radius:8px;padding:4px 8px;font-size:11px;font-weight:700;color:${accentColor};letter-spacing:0.5px;">
                        🤖 AUTO-SALVATO
                    </div>
                    <div style="font-size:10px;color:rgba(255,255,255,0.4);margin-left:auto;">Capital.com</div>
                </div>
                <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;">
                    <div>
                        <div style="font-weight:700;font-size:15px;letter-spacing:0.3px;">${item.asset}</div>
                        <div style="font-size:11px;color:rgba(255,255,255,0.5);margin-top:2px;">${dirLabel}${item.extraInfo ? ' · ' + item.extraInfo : ''}</div>
                    </div>
                    <div style="font-size:18px;font-weight:800;color:${accentColor};letter-spacing:0.5px;">${item.pnlStr}</div>
                </div>
            `;

            document.body.appendChild(toast);

            setTimeout(() => {
                toast.style.animation = 'atSlideOut 0.35s ease-in forwards';
                setTimeout(() => {
                    toast.remove();
                    ui._autoTradeToastQueue.shift();
                    // Delay tra toast multipli
                    if (ui._autoTradeToastQueue.length > 0) {
                        setTimeout(showNext, 300);
                    }
                }, 350);
            }, 5000);
        };

        showNext();
    },

    async syncBrokerTrades(silent = false) {
        const hasCapitalCom = DataStore.data.accounts.some(a => a.type === 'live' && a.capitalComConnected);
        
        // Feature temporaneamente disabilitata
        if (!hasCapitalCom && !BROKER_FEATURE_ENABLED) {
            if (!silent) {
                ui.showToast('⚠️ Funzionalità disponibile a breve!');
            }
            return { success: [], errors: [] };
        }
        
        try {
            if (!silent) {
                ui.showToast('🔄 Sincronizzazione in corso...');
            }
            
            const results = await DataStore.syncTradesFromBrokers();

            // Conta i trade salvati automaticamente
            const successCount = results.success.reduce((acc, s) => acc + s.count, 0);

            if (!silent) {
                // Modalità manuale: feedback completo
                if (successCount > 0) {
                    const brokersSynced = results.success.map(s => s.broker).join(', ');
                    ui.showToast(`✅ ${successCount} trade auto-salvati da ${brokersSynced}`);
                } else if (results.errors.length > 0) {
                    ui.showToast(`⚠️ Errore sincronizzazione: ${results.errors[0].error}`);
                } else {
                    ui.showToast('✓ Nessun nuovo trade da sincronizzare');
                }
            } else if (successCount > 0) {
                // Modalità background: mostra notifiche dettagliate per ogni trade auto-salvato
                results.success.forEach(syncResult => {
                    if (syncResult.trades && syncResult.trades.length > 0) {
                        syncResult.trades.forEach(trade => {
                            const pnlSign = trade.pnl >= 0 ? '+' : '';
                            const pnlStr = `${pnlSign}${ui.formatCurrency ? ui.formatCurrency(trade.pnl) : trade.pnl.toFixed(2)}`;
                            const rrStr = trade.rr ? ` · ${trade.rr}` : '';
                            const sessionStr = trade.session ? ` · ${trade.session}` : '';
                            const emoji = trade.pnl >= 0 ? '✅' : '❌';
                            ui.showAutoTradeToast(emoji, trade.asset, trade.direction, pnlStr, rrStr + sessionStr);
                        });
                    } else {
                        // Fallback generico se i trade dettagliati non sono disponibili
                        ui.showToast(`🤖 ${syncResult.count} trade auto-salvati da ${syncResult.broker}`);
                    }
                });
            }

            // Aggiorna la vista solo se è cambiato davvero qualcosa (o se il sync
            // è stato chiesto dall'utente): il polling di background non deve
            // ridisegnare la pagina ogni 30 secondi.
            if (successCount > 0 || !silent) {
                ui.refreshViewSilently();
            }

            return results;
        } catch (e) {
            console.error('Sync error:', e);
            if (!silent) {
                ui.showToast('❌ Errore durante la sincronizzazione');
            }
            return { success: [], errors: [{ broker: 'General', error: e.message }] };
        }
    },

    async syncBrokerTradesToday() {
        const hasCapitalCom = DataStore.data.accounts.some(a => a.type === 'live' && a.capitalComConnected);
        
        if (!hasCapitalCom && !BROKER_FEATURE_ENABLED) {
            ui.showToast('⚠️ Funzionalità disponibile a breve!');
            return { success: [], errors: [] };
        }
        
        try {
            ui.showToast('🔄 Sincronizzazione dei trade di oggi in corso...');
            
            const results = await DataStore.syncTodayTradesFromBrokers();

            const successCount = results.success.reduce((acc, s) => acc + s.count, 0);

            if (successCount > 0) {
                const brokersSynced = results.success.map(s => s.broker).join(', ');
                ui.showToast(`✅ ${successCount} trade trovati e importati da ${brokersSynced}`);
            } else if (results.errors.length > 0) {
                ui.showToast(`⚠️ Errore sincronizzazione: ${results.errors[0].error}`);
            } else {
                ui.showToast('✓ Nessun nuovo trade trovato per oggi');
            }

            if (router.currentPage === 'journal') router.journal();
            if (router.currentPage === 'drafts') router.drafts();
            if (router.currentPage === 'dashboard') router.dashboard();
            if (router.currentPage === 'accounts') router.accounts();

            return results;
        } catch (e) {
            console.error('Sync error:', e);
            ui.showToast('❌ Errore durante la sincronizzazione');
            return { success: [], errors: [] };
        }
    },

    // === CAPITAL.COM REAL-TIME BALANCE & MONITORING ===

    async testCapitalComConnection() {
        const apiKey = document.getElementById('a-capitalcom-api')?.value || '';
        const password = document.getElementById('a-capitalcom-secret')?.value || '';
        const email = document.getElementById('a-capitalcom-email')?.value || '';
        const env = document.getElementById('a-capitalcom-env')?.value || 'live';

        if (!apiKey || !password) {
            ui.showToast('⚠️ Inserisci API Key e Password prima di testare');
            return;
        }

        ui.showToast('🔄 Test connessione in corso...');

        // Prima verifica che il proxy sia attivo
        const proxyBase = (typeof PROXY_BASE_URL !== 'undefined') ? PROXY_BASE_URL : 'http://localhost:3030';
        try {
            const healthResp = await fetch(`${proxyBase}/health`, { signal: AbortSignal.timeout(3000) });
            if (!healthResp.ok) throw new Error('proxy_err');
        } catch (e) {
            ui.showToast('⚠️ Server proxy non disponibile in locale. Funzionerà automaticamente su Netlify!');
            return;
        }

        // Testa l'autenticazione Capital.com
        try {
            const baseUrl = env === 'demo'
                ? 'https://demo-api-capital.backend-capital.com'
                : 'https://api-capital.backend-capital.com';

            const resp = await fetch(`${proxyBase}/capitalproxy`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Target-URL': `${baseUrl}/api/v1/session`,
                    'X-CAP-API-KEY': apiKey
                },
                body: JSON.stringify({ identifier: email || apiKey, password: password })
            });

            if (resp.ok) {
                const cst = resp.headers.get('CST');
                const token = resp.headers.get('X-SECURITY-TOKEN');
                if (cst && token) {
                    ui.showToast('✅ Connessione Capital.com riuscita! Sessione attiva.');
                } else {
                    ui.showToast('⚠️ Risposta ricevuta ma token mancanti. Verifica le credenziali.');
                }
            } else {
                const errData = await resp.json().catch(() => ({}));
                ui.showToast(`❌ Autenticazione fallita: ${errData.errorCode || resp.status}`);
            }
        } catch (e) {
            ui.showToast(`❌ Errore: ${e.message}`);
        }
    },

    async updateCapitalComBalances() {
        const capitalAccounts = DataStore.data.accounts.filter(a => a.type === 'live' && a.capitalComConnected && a.capitalComApiKey);
        if (capitalAccounts.length === 0) return;

        // Verifica proxy disponibile (silenziosamente)
        try {
            const proxyBase = (typeof PROXY_BASE_URL !== 'undefined') ? PROXY_BASE_URL : '';
            const healthResp = await fetch(`${proxyBase}/health`, { signal: AbortSignal.timeout(2000) });
            if (!healthResp.ok) return;
        } catch {
            return; // Proxy non disponibile, skip silenzioso
        }

        let balanceUpdated = false;

        for (const account of capitalAccounts) {
            try {
                const balanceData = await DataStore.fetchCapitalComBalance(account);
                if (balanceData) {
                    const oldBalance = account.balance;
                    // Aggiorna il saldo con l'equity (saldo + P&L posizioni aperte)
                    account.balance = balanceData.equity || balanceData.balance;
                    account.capitalComFunds = balanceData.funds;
                    account.capitalComEquity = balanceData.equity;
                    account.capitalComCurrency = balanceData.currency;
                    account.capitalComLastBalanceUpdate = new Date().toISOString();

                    if (Math.abs(oldBalance - account.balance) > 0.01) {
                        balanceUpdated = true;
                        console.log(`💰 Capital.com - Saldo aggiornato per ${account.name}: ${balanceData.currency} ${account.balance.toFixed(2)}`);
                    }
                }
            } catch (e) {
                console.warn(`⚠️ Impossibile aggiornare saldo per ${account.name}:`, e.message);
            }
        }

        if (balanceUpdated) {
            await DataStore.save();
            // Aggiorna le card saldo nella pagina accounts se aperta
            if (router.currentPage === 'accounts') router.navigate('accounts');
            if (router.currentPage === 'dashboard') {
                // Aggiorna solo i valori visualizzati senza ricaricare tutto
                const equityEl = document.querySelector('[data-capital-balance]');
                if (equityEl) {
                    const total = DataStore.data.accounts.reduce((sum, a) => sum + (a.balance || 0), 0);
                    equityEl.textContent = ui.formatCurrency(total);
                }
            }
        }
    },

    startCapitalComBalancePolling() {
        const capitalAccounts = DataStore.data.accounts.filter(a => a.type === 'live' && a.capitalComConnected && a.capitalComApiKey);
        if (capitalAccounts.length === 0) return;

        console.log(`🔄 Capital.com - Avvio polling saldo ogni 30 secondi per ${capitalAccounts.length} account`);

        // Primo aggiornamento immediato (dopo 3s per non bloccare il rendering)
        setTimeout(() => ui.updateCapitalComBalances(), 3000);

        // Polling ogni 30 secondi per il saldo
        if (!ui._capitalBalancePollingInterval) {
            ui._capitalBalancePollingInterval = setInterval(() => ui.updateCapitalComBalances(), 30000);
        }
    },

    // Calendar logic
    changeCalendarMonth(delta) { ui.currentCalendarMonth.setMonth(ui.currentCalendarMonth.getMonth() + delta); ui.renderCalendar(); },
    renderCalendar() {
        const now = ui.currentCalendarMonth; const year = now.getFullYear(); const month = now.getMonth(); const monthNames = ["Gennaio", "Febbraio", "Marzo", "Aprile", "Maggio", "Giugno", "Luglio", "Agosto", "Settembre", "Ottobre", "Novembre", "Dicembre"];
        const monthYearEl = document.getElementById('cal-month-year'); if (!monthYearEl) return; monthYearEl.innerText = `${monthNames[month]} ${year}`;
        const firstDay = new Date(year, month, 1); const lastDay = new Date(year, month + 1, 0); const daysInMonth = lastDay.getDate(); let startDayIndex = firstDay.getDay() - 1; if (startDayIndex === -1) startDayIndex = 6;
        const grid = document.getElementById('calendar-grid'); if (!grid) return;

        // Ottimizzazione: crea un fragment per ridurre i reflow
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < startDayIndex; i++) { fragment.appendChild(document.createElement('div')); }

        const today = new Date(); const todayStr = today.toDateString();
        const allTrades = DataStore.data.trades;

        // Ottimizzazione: precalcola i trade raggruppati per data
        const tradesByDate = {};
        allTrades.forEach(t => {
            const dateKey = t.date.split('T')[0];
            if (!tradesByDate[dateKey]) tradesByDate[dateKey] = [];
            tradesByDate[dateKey].push(t);
        });

        for (let i = 1; i <= daysInMonth; i++) {
            const dayDate = new Date(year, month, i);
            // Fix timezone: crea dateStr senza conversione UTC
            const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(i).padStart(2, '0')}`;
            const dayEl = document.createElement('div');
            dayEl.className = 'calendar-day text-xs font-bold text-[var(--text-muted)] hover:text-white preserve-white';
            dayEl.textContent = i;
            if (today.getFullYear() === year && today.getMonth() === month && today.getDate() === i) dayEl.classList.add('today');

            const dayTrades = tradesByDate[dateStr];
            if (dayTrades && dayTrades.length > 0) {
                const netPnl = dayTrades.reduce((acc, t) => acc + parseFloat(t.pnl || 0), 0);
                const dot = document.createElement('div');
                dot.className = 'cal-dot ' + (netPnl >= 0 ? 'bg-green-500' : 'bg-red-500');
                dayEl.appendChild(dot);
            }
            dayEl.onclick = () => ui.openDayDetails(dateStr);
            fragment.appendChild(dayEl);
        }
        grid.innerHTML = '';
        grid.appendChild(fragment);
    },
    openDayDetails(dateStr) {
        const trades = DataStore.data.trades.filter(t => t.date.startsWith(dateStr));
        const modal = document.getElementById('modal-day');

        modal.innerHTML = ui.renderDayModalContent(dateStr, trades);
        ui.openModal('modal-day');
    },

    renderDayModalContent(dateStr, trades) {
        const totalDailyPnl = trades.reduce((acc, t) => acc + parseFloat(t.pnl || 0), 0);
        const winTrades = trades.filter(t => t.type !== 'payout' && parseFloat(t.pnl || 0) > 0).length;
        const lossTrades = trades.filter(t => t.type !== 'payout' && parseFloat(t.pnl || 0) < 0).length;
        const winRate = trades.length > 0 ? ((winTrades / (winTrades + lossTrades)) * 100).toFixed(0) : 0;

        const date = new Date(dateStr);
        const dayName = date.toLocaleDateString('it-IT', { weekday: 'long' });
        const formattedDate = date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });

        let summaryHTML = '';
        if (trades.length > 0) {
            summaryHTML = `
                <div class="grid grid-cols-3 gap-3 mb-6">
                    <div class="bg-gradient-to-br from-blue-500/10 to-blue-500/5 border border-blue-500/20 p-4 rounded-2xl text-center">
                        <div class="w-10 h-10 rounded-xl bg-blue-500/20 flex items-center justify-center mx-auto mb-2">
                            <i class="ph-bold ph-chart-line text-xl text-blue-400"></i>
                        </div>
                        <p class="text-2xl font-bold ${totalDailyPnl >= 0 ? 'text-green-400' : 'text-red-400'}">${ui.formatCurrency(totalDailyPnl)}</p>
                        <p class="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mt-1">P&L Giornaliero</p>
                    </div>
                    <div class="bg-gradient-to-br from-purple-500/10 to-purple-500/5 border border-purple-500/20 p-4 rounded-2xl text-center">
                        <div class="w-10 h-10 rounded-xl bg-purple-500/20 flex items-center justify-center mx-auto mb-2">
                            <i class="ph-bold ph-trend-up text-xl text-purple-400"></i>
                        </div>
                        <p class="text-2xl font-bold text-white preserve-white">${trades.length}</p>
                        <p class="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mt-1">Trades Totali</p>
                    </div>
                    <div class="bg-gradient-to-br from-green-500/10 to-green-500/5 border border-green-500/20 p-4 rounded-2xl text-center">
                        <div class="w-10 h-10 rounded-xl bg-green-500/20 flex items-center justify-center mx-auto mb-2">
                            <i class="ph-bold ph-percent text-xl text-green-400"></i>
                        </div>
                        <p class="text-2xl font-bold text-white preserve-white">${winRate}%</p>
                        <p class="text-[10px] font-bold text-[var(--text-muted)] uppercase tracking-wider mt-1">Win Rate</p>
                    </div>
                </div>
            `;
        }

        const tradeList = trades.length === 0
            ? `<div class="flex flex-col items-center justify-center py-16">
                    <div class="w-20 h-20 rounded-full bg-white/5 flex items-center justify-center mb-4">
                        <i class="ph-duotone ph-ghost text-5xl text-[var(--text-muted)]"></i>
                    </div>
                    <p class="text-sm text-[var(--text-muted)] font-medium">Nessuna attività registrata</p>
                    <p class="text-xs text-[var(--text-muted)] opacity-60 mt-1">Non ci sono trade in questa giornata</p>
                </div>`
            : `<div class="space-y-2">${trades.map(t => {
                const isPayout = t.type === 'payout';
                const pnlValue = parseFloat(t.pnl || 0);
                const pnlDisplay = isPayout ? `-${ui.formatCurrency(Math.abs(t.pnl))}` : ui.formatCurrency(t.pnl);
                const pnlColor = isPayout || pnlValue < 0 ? 'red' : 'green';
                const assetDisplay = isPayout ? 'PAYOUT' : t.asset;
                const strategyDisplay = isPayout ? 'Prelievo fondi' : t.strategy || 'Nessuna strategia';
                const directionIcon = t.direction === 'LONG' ? 'ph-arrow-up' : t.direction === 'SHORT' ? 'ph-arrow-down' : 'ph-minus';
                const directionColor = t.direction === 'LONG' ? 'text-green-400' : t.direction === 'SHORT' ? 'text-red-400' : 'text-gray-400';

                return `<div class="bg-white/5 hover:bg-white/8 border border-white/10 p-4 rounded-xl flex items-center gap-4 transition-all group cursor-pointer">
                            <div class="w-12 h-12 rounded-xl bg-gradient-to-br from-${pnlColor}-500/20 to-${pnlColor}-500/5 border border-${pnlColor}-500/30 flex items-center justify-center flex-shrink-0">
                                <i class="ph-bold ${directionIcon} text-xl ${directionColor}"></i>
                            </div>
                            <div class="flex-1 min-w-0">
                                <div class="flex items-center gap-2 mb-1">
                                    <span class="font-bold text-sm text-white preserve-white">${assetDisplay}</span>
                                    ${!isPayout ? `<span class="text-[10px] px-2 py-0.5 rounded-md bg-${pnlColor}-500/10 text-${pnlColor}-400 font-bold uppercase">${t.direction}</span>` : ''}
                                </div>
                                <p class="text-xs text-[var(--text-muted)] truncate">${strategyDisplay}</p>
                            </div>
                            <div class="text-right flex-shrink-0">
                                <div class="font-mono font-bold text-lg ${pnlColor === 'red' ? 'text-red-400' : 'text-green-400'}">${pnlDisplay}</div>
                                ${t.rrr ? `<div class="text-[10px] text-[var(--text-muted)] font-medium">RRR: ${t.rrr}</div>` : ''}
                            </div>
                        </div>`;
            }).join('')}</div>`;

        return `
            <div class="relative bg-gradient-to-br from-[var(--bg-card)] to-[var(--bg-card)]/80 rounded-2xl overflow-hidden shadow-2xl transform transition-all scale-100 flex flex-col border border-white/10" style="width: 750px; max-height: 90vh;">
                
                <!-- Header con Gradient -->
                <div class="relative px-8 py-6 border-b border-white/5">
                    <div class="absolute inset-0 bg-gradient-to-r from-blue-500/10 via-purple-500/10 to-blue-500/10 opacity-50"></div>
                    <div class="relative flex items-center justify-between">
                        <div>
                            <h3 class="text-2xl font-bold text-white preserve-white capitalize">${dayName}</h3>
                            <p class="text-sm text-[var(--text-muted)] font-medium mt-1">${formattedDate}</p>
                        </div>
                        <button onclick="ui.closeModals()" class="group w-11 h-11 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all text-[var(--text-muted)] hover:text-white preserve-white">
                            <i class="ph-bold ph-x text-xl group-hover:rotate-90 transition-transform"></i>
                        </button>
                    </div>
                </div>

                <!-- Content -->
                <div class="flex-1 overflow-y-auto custom-scrollbar px-8 py-6">
                    ${summaryHTML}
                    
                    ${trades.length > 0 ? `
                        <div class="mb-3">
                            <h4 class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2">
                                <i class="ph-bold ph-list-bullets"></i>
                                Lista Trade
                            </h4>
                        </div>
                    ` : ''}
                    
                    ${tradeList}
                </div>

            </div>
        `;
    },

    // --- CHART ---
    renderChart(trades) {
        const ctx = document.getElementById('equityChart'); if (!ctx) return;
        if (window.myEquityChart) { window.myEquityChart.destroy(); window.myEquityChart = null; }
        const sorted = [...trades].sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
        let runningBalance = 0; let dataPoints = [];
        if (sorted.length > 0) {
            const firstDate = new Date(sorted[0].date).getTime();
            dataPoints.push({ x: firstDate - 86400000, y: 0 });
            sorted.forEach(t => { runningBalance += parseFloat(t.pnl || 0); dataPoints.push({ x: new Date(t.date).getTime(), y: runningBalance }); });
        } else {
            const now = Date.now(); dataPoints.push({ x: now - 86400000, y: 0 }); dataPoints.push({ x: now, y: 0 });
        }

        // Calcola min e max per il gradiente dinamico
        const pnlValues = dataPoints.map(p => p.y);
        const minPnl = Math.min(...pnlValues, 0);
        const maxPnl = Math.max(...pnlValues, 0);
        const currentPnl = runningBalance;
        const isPositive = currentPnl >= 0;
        const color = isPositive ? '#22c55e' : '#ef4444';

        // Linea obiettivo challenge
        let challengeTarget = null;
        let maxDrawdown = null;

        if (ui.dashboardFilter && ui.dashboardFilter !== 'all') {
            const selectedAccount = DataStore.data.accounts.find(a => a.id == ui.dashboardFilter);
            if (selectedAccount && (selectedAccount.type === 'challenge' || selectedAccount.type === 'funded') && selectedAccount.target && selectedAccount.size) {
                challengeTarget = selectedAccount.target - selectedAccount.size;
                if (selectedAccount.maxDrawdown) {
                    maxDrawdown = -Math.abs(selectedAccount.maxDrawdown);
                }
            }
        }

        const datasets = [{
            label: 'Cumulative P&L',
            data: dataPoints,
            borderColor: (context) => {
                if (!context.chart.chartArea) return color;
                const chart = context.chart;
                const { ctx, chartArea } = chart;
                const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
                const range = maxPnl - minPnl;
                if (range === 0) return color;

                // Calcola la posizione dello zero nel gradiente (0 = bottom, 1 = top)
                const zeroPosition = Math.abs(minPnl) / range;

                // Rosso per valori negativi (sotto zero)
                gradient.addColorStop(0, '#ef4444');
                // Transizione graduale intorno allo zero
                if (zeroPosition > 0 && zeroPosition < 1) {
                    gradient.addColorStop(Math.max(0, zeroPosition - 0.01), '#ef4444');
                    gradient.addColorStop(Math.min(1, zeroPosition + 0.01), '#22c55e');
                }
                // Verde per valori positivi (sopra zero)
                gradient.addColorStop(1, '#22c55e');

                return gradient;
            },
            backgroundColor: (context) => {
                if (!context.chart.chartArea) return 'rgba(34, 197, 94, 0.1)';
                const chart = context.chart;
                const { ctx, chartArea } = chart;
                const gradient = ctx.createLinearGradient(0, chartArea.bottom, 0, chartArea.top);
                const range = maxPnl - minPnl;
                if (range === 0) return isPositive ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)';

                // Calcola la posizione dello zero nel gradiente
                const zeroPosition = Math.abs(minPnl) / range;

                // Area rossa per valori negativi
                gradient.addColorStop(0, 'rgba(239, 68, 68, 0.2)');
                if (zeroPosition > 0 && zeroPosition < 1) {
                    gradient.addColorStop(Math.max(0, zeroPosition - 0.02), 'rgba(239, 68, 68, 0.15)');
                    gradient.addColorStop(zeroPosition, 'rgba(200, 200, 200, 0.05)');
                    gradient.addColorStop(Math.min(1, zeroPosition + 0.02), 'rgba(34, 197, 94, 0.15)');
                }
                // Area verde per valori positivi
                gradient.addColorStop(1, 'rgba(34, 197, 94, 0.2)');

                return gradient;
            },
            borderWidth: 3,
            tension: 0.4,
            fill: true,
            pointRadius: 0,
            pointHoverRadius: 6,
            pointHoverBackgroundColor: color,
            pointHoverBorderColor: '#fff',
            pointHoverBorderWidth: 2
        }];

        // Calcola il range dei valori del P&L (usa le variabili già definite sopra)
        const pnlRange = maxPnl - minPnl;

        if (maxDrawdown !== null && dataPoints.length > 0) {
            // Mostra il max drawdown solo se è vicino al range attuale del P&L
            const isDrawdownRelevant = maxDrawdown >= minPnl - pnlRange * 1.5;

            if (isDrawdownRelevant) {
                const firstX = dataPoints[0].x;
                const lastX = dataPoints[dataPoints.length - 1].x;
                datasets.push({
                    label: 'Max Drawdown',
                    data: [{ x: firstX, y: maxDrawdown }, { x: lastX, y: maxDrawdown }],
                    borderColor: '#ef4444',
                    borderWidth: 2.5,
                    borderDash: [8, 4],
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    backgroundColor: 'rgba(239, 68, 68, 0.1)'
                });
            }
        }

        // Aggiungi linea tratteggiata blu per il TP quando il PnL è vicino
        if (challengeTarget !== null && dataPoints.length > 0) {
            // Mostra il target solo se il PnL è vicino (entro il 150% del range)
            const isTargetRelevant = challengeTarget <= maxPnl + pnlRange * 0.5 && challengeTarget >= minPnl - pnlRange * 0.5;

            if (isTargetRelevant) {
                const firstX = dataPoints[0].x;
                const lastX = dataPoints[dataPoints.length - 1].x;
                datasets.push({
                    label: 'Target TP',
                    data: [{ x: firstX, y: challengeTarget }, { x: lastX, y: challengeTarget }],
                    borderColor: '#3b82f6',
                    borderWidth: 2.5,
                    borderDash: [8, 4],
                    fill: false,
                    pointRadius: 0,
                    pointHoverRadius: 0,
                    backgroundColor: 'rgba(59, 130, 246, 0.1)'
                });
            }
        }

        // Plugin per disegnare le label delle linee
        const lineLabelsPlugin = {
            id: 'lineLabels',
            afterDatasetsDraw(chart) {
                const ctx = chart.ctx;
                chart.data.datasets.forEach((dataset, i) => {
                    if (dataset.label === 'Max Drawdown' || dataset.label === 'Target TP') {
                        const meta = chart.getDatasetMeta(i);
                        if (meta.data.length > 0) {
                            const lastPoint = meta.data[meta.data.length - 1];
                            const x = lastPoint.x;
                            const y = lastPoint.y;

                            ctx.save();
                            ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, "SF Pro Display"';
                            ctx.fillStyle = dataset.borderColor;
                            ctx.textAlign = 'left';
                            ctx.textBaseline = 'middle';

                            const label = dataset.label === 'Max Drawdown' ? 'MAX DD' : 'TARGET';
                            ctx.fillText(label, x + 10, y);
                            ctx.restore();
                        }
                    }
                });
            }
        };

        window.myEquityChart = new Chart(ctx, {
            type: 'line',
            data: { datasets: datasets },
            options: { responsive: true, maintainAspectRatio: false, animation: { duration: 400 }, plugins: { legend: { display: false }, tooltip: { enabled: true, mode: 'index', intersect: false, backgroundColor: 'rgba(0, 0, 0, 0.9)', titleColor: '#ffffff', bodyColor: '#ffffff', borderColor: 'rgba(255, 255, 255, 0.1)', borderWidth: 1, padding: 12, displayColors: false, titleFont: { family: '-apple-system, BlinkMacSystemFont, "SF Pro Display"', size: 11, weight: '600' }, bodyFont: { family: '-apple-system, BlinkMacSystemFont, "SF Pro Display"', size: 13, weight: '700' }, callbacks: { title: function (context) { const date = new Date(context[0].parsed.x); return date.toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }); }, label: function (context) { return ui.formatCurrency(context.parsed.y); } } } }, interaction: { mode: 'nearest', axis: 'x', intersect: false }, scales: { x: { type: 'linear', display: false }, y: { display: true, position: 'right', grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false }, ticks: { color: '#86868B', font: { family: '-apple-system', size: 10 }, callback: function (value) { return value.toFixed(0); } } } } },
            plugins: [lineLabelsPlugin]
        });
    },

    // --- REVIEW ---
    review() {
        const allReviews = DataStore.data.reviews.sort((a, b) => new Date(b.date) - new Date(a.date));
        const weekly = allReviews.filter(r => r.type === 'weekly');
        const daily = allReviews.filter(r => r.type === 'daily');
        const now = new Date(); const startOfWeek = new Date(now); const day = startOfWeek.getDay() || 7; if (day !== 1) startOfWeek.setHours(-24 * (day - 1)); startOfWeek.setHours(0, 0, 0, 0);

        const weeklyTrades = DataStore.data.trades.filter(t => new Date(t.date) >= startOfWeek && t.status === 'executed');
        const missedTradesCount = DataStore.data.trades.filter(t => new Date(t.date) >= startOfWeek && t.status === 'missed').length;
        const weeklyPnl = weeklyTrades.reduce((acc, t) => acc + (parseFloat(t.pnl) || 0), 0);
        const executedTradesForStats = weeklyTrades.filter(t => t.type !== 'payout');
        const winCount = executedTradesForStats.filter(t => (parseFloat(t.pnl) || 0) > 0).length;
        const totalCount = executedTradesForStats.length;
        const winRate = totalCount ? ((winCount / totalCount) * 100).toFixed(1) : 0;
        const bestTrade = executedTradesForStats.length > 0 ? [...executedTradesForStats].sort((a, b) => (parseFloat(b.pnl) || 0) - (parseFloat(a.pnl) || 0))[0] : null;

        const activeTab = ui.reviewState.reviewTab || 'daily';

        // Genera calendario
        const currentMonth = ui.reviewState.currentMonth !== undefined ? ui.reviewState.currentMonth : now.getMonth();
        const currentYear = ui.reviewState.currentYear !== undefined ? ui.reviewState.currentYear : now.getFullYear();
        const firstDay = new Date(currentYear, currentMonth, 1);
        const lastDay = new Date(currentYear, currentMonth + 1, 0);
        const startDay = firstDay.getDay() === 0 ? 6 : firstDay.getDay() - 1;
        const daysInMonth = lastDay.getDate();

        // Mappa revisioni per data
        const reviewsByDate = {};
        (activeTab === 'daily' ? daily : weekly).forEach(r => {
            const dateKey = ui.formatDateKey(r.date);
            reviewsByDate[dateKey] = r;
        });

        ui.container.innerHTML = `
        <div class="fade-in flex flex-col">
            <!-- Header -->
            <div class="flex items-center justify-between mb-6">
                <h2 class="text-2xl md:text-4xl font-bold tracking-tight text-white preserve-white">Revisioni</h2>
                <div class="flex gap-3 items-center justify-end">
                    <button onclick="ui.editReview()" class="h-10 bg-[var(--accent-blue)] text-white preserve-white px-4 rounded-xl font-bold hover:opacity-90 transition-opacity flex items-center gap-2 flex-shrink-0">
                        <i class="ph-bold ph-plus"></i>
                        <span class="hidden md:inline">Nuova</span>
                    </button>
                </div>
            </div>

            <!-- Stats Row -->
            <div class="flex md:grid md:grid-cols-4 gap-3 overflow-x-auto snap-x snap-mandatory hide-scrollbar md:overflow-visible mb-6 md:mb-8 -mx-4 px-4 md:px-3" style="padding-top: 12px; padding-bottom: 12px;">
                <div class="stat-box min-w-[140px] md:min-w-0 flex-1 snap-start p-3 md:p-4">
                    <p class="text-[10px] font-bold uppercase text-[var(--text-muted)]">Totali</p>
                    <p class="text-xl md:text-2xl font-bold mt-1 text-white preserve-white truncate">${allReviews.length}</p>
                </div>
                <div class="stat-box min-w-[140px] md:min-w-0 flex-1 snap-start p-3 md:p-4">
                    <p class="text-[10px] font-bold uppercase text-[var(--text-muted)]">Giornaliere</p>
                    <p class="text-xl md:text-2xl font-bold mt-1 text-blue-500 truncate">${daily.length}</p>
                </div>
                <div class="stat-box min-w-[140px] md:min-w-0 flex-1 snap-start p-3 md:p-4">
                    <p class="text-[10px] font-bold uppercase text-[var(--text-muted)]">Settimanali</p>
                    <p class="text-xl md:text-2xl font-bold mt-1 text-purple-500 truncate">${weekly.length}</p>
                </div>
                <div class="stat-box min-w-[140px] md:min-w-0 flex-1 snap-start p-3 md:p-4">
                    <p class="text-[10px] font-bold uppercase text-[var(--text-muted)]">P&L Week</p>
                    <p class="text-xl md:text-2xl font-bold mt-1 ${weeklyPnl >= 0 ? 'text-green-500' : 'text-red-500'} truncate">${ui.formatCurrency(weeklyPnl)}</p>
                </div>
            </div>

            <!-- Tabs -->
            <div class="flex justify-center mb-4">
                <div class="inline-flex bg-white/5 rounded-xl p-1 border border-white/10">
                    <button onclick="ui.switchReviewTab('daily')" class="px-5 py-2 rounded-lg font-semibold text-xs transition-all ${activeTab === 'daily' ? 'bg-[var(--accent-blue)] text-white preserve-white' : 'text-[var(--text-muted)] hover:text-white preserve-white'}">
                        Giornaliere
                    </button>
                    <button onclick="ui.switchReviewTab('weekly')" class="px-5 py-2 rounded-lg font-semibold text-xs transition-all ${activeTab === 'weekly' ? 'bg-[var(--accent-blue)] text-white preserve-white' : 'text-[var(--text-muted)] hover:text-white preserve-white'}">
                        Settimanali
                    </button>
                </div>
            </div>

            <!-- Month Navigator -->
            <div class="flex items-center justify-between mb-4 px-4">
                <button onclick="ui.changeReviewMonth(-1)" class="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                    <i class="ph-bold ph-caret-left text-[var(--text-muted)]"></i>
                </button>
                <h3 class="text-lg font-bold text-white preserve-white">
                    ${new Date(currentYear, currentMonth).toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}
                </h3>
                <button onclick="ui.changeReviewMonth(1)" class="w-8 h-8 rounded-lg bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                    <i class="ph-bold ph-caret-right text-[var(--text-muted)]"></i>
                </button>
            </div>

            <!-- Calendar Grid -->
            <div class="flex-1 pb-32 md:pb-40">
                <div class="bg-white/5 rounded-xl border border-white/10 p-2">
                    <!-- Day Headers -->
                    <div class="grid grid-cols-7 gap-0.5 mb-1">
                        ${['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(d =>
            `<div class="text-center text-[8px] font-bold uppercase tracking-wider text-[var(--text-muted)] py-0.5">${d}</div>`
        ).join('')}
                    </div>
                    
                    <!-- Calendar Days -->
                    <div class="grid grid-cols-7 gap-0.5">
                        ${Array.from({ length: startDay }).map(() => '<div class="aspect-square"></div>').join('')}
                        ${Array.from({ length: daysInMonth }).map((_, i) => {
            const day = i + 1;
            const date = new Date(currentYear, currentMonth, day);
            const dateKey = ui.formatDateKey(date);
            const review = reviewsByDate[dateKey];
            const isToday = date.toDateString() === now.toDateString();

            if (review) {
                return ui.renderCompactReviewCard(review, null, activeTab, day);
            } else {
                return `<div onclick="ui.editReview(null, '${dateKey}', '${activeTab}')" class="aspect-square rounded-md border border-white/5 ${isToday ? 'border-[var(--accent-blue)]' : ''} hover:border-white/20 hover:bg-white/5 cursor-pointer transition-all flex items-center justify-center">
                                    <span class="text-sm font-semibold text-[var(--text-muted)] ${isToday ? 'text-[var(--accent-blue)]' : ''}">${day}</span>
                                </div>`;
            }
        }).join('')}
                    </div>
                </div>
            </div>
        </div>`;

        if (!ui.reviewState) ui.reviewState = { reviewTab: 'daily', currentMonth: now.getMonth(), currentYear: now.getFullYear() };
    },
    switchReviewTab(tab) { if (!ui.reviewState) ui.reviewState = {}; ui.reviewState.reviewTab = tab; router.review(); },
    changeReviewMonth(delta) {
        const now = new Date();
        if (!ui.reviewState) ui.reviewState = { currentMonth: now.getMonth(), currentYear: now.getFullYear(), reviewTab: 'daily' };
        let newMonth = (ui.reviewState.currentMonth !== undefined ? ui.reviewState.currentMonth : now.getMonth()) + delta;
        let newYear = ui.reviewState.currentYear !== undefined ? ui.reviewState.currentYear : now.getFullYear();
        if (newMonth > 11) { newMonth = 0; newYear++; }
        if (newMonth < 0) { newMonth = 11; newYear--; }
        ui.reviewState.currentMonth = newMonth;
        ui.reviewState.currentYear = newYear;
        router.review();
    },
    toggleReviewLimit(type) { if (type === 'weekly') ui.reviewState.showAllWeekly = !ui.reviewState.showAllWeekly; if (type === 'daily') ui.reviewState.showAllDaily = !ui.reviewState.showAllDaily; router.review(); },

    renderCompactReviewCard(r, number, type, calendarDay) {
        const isWeekly = r.type === 'weekly';
        const moodColor = r.mood === 'pessimista' ? 'red' : r.mood === 'ottimista' ? 'green' : 'gray';
        const isCompleted = r.status === 'completed';
        const displayDay = calendarDay !== undefined ? calendarDay : new Date(r.date).getDate();

        return `
        <div onclick="ui.viewReview(${r.id})" class="group relative bg-[var(--bg-card)] hover:bg-white/5 border border-white/10 hover:border-[var(--accent-blue)] rounded-md cursor-pointer transition-all aspect-square flex flex-col items-center justify-center">
            
            <!-- Icon -->
            <i class="ph-bold ${isWeekly ? 'ph-calendar-blank' : 'ph-notebook'} text-[9px] text-[var(--text-muted)] group-hover:text-[var(--accent-blue)] transition-colors mt-0.5"></i>
            
            <!-- Date -->
            <p class="text-lg font-bold text-white preserve-white leading-none">
                ${displayDay}
            </p>
            
            <!-- Status Indicator -->
            <div class="absolute bottom-0.5 w-10 h-1 rounded-full ${isCompleted ? 'bg-green-500' : 'bg-orange-500'}"></div>
        </div>`;
    },

    renderModernReviewCard(r, number, type) {
        const isWeekly = r.type === 'weekly';
        const statusColor = r.status === 'completed' ? 'bg-green-500/10 border-green-500/20' : 'bg-yellow-500/10 border-yellow-500/20';
        const statusLabel = r.status === 'completed' ? '✓ Completato' : '○ Bozza';
        const statusLabelColor = r.status === 'completed' ? 'text-green-400' : 'text-yellow-400';

        return `
        <div onclick="ui.viewReview(${r.id})" class="group bg-[var(--bg-card)] hover:bg-[var(--input-bg)] border border-white/5 hover:border-[var(--accent-blue)]/30 p-5 rounded-2xl cursor-pointer transition-all duration-300 relative overflow-hidden hover:shadow-lg hover:shadow-blue-500/10">
            <!-- Background accent -->
            <div class="absolute top-0 right-0 w-24 h-24 opacity-5 pointer-events-none ${isWeekly ? 'bg-gradient-to-bl from-blue-500' : 'bg-gradient-to-bl from-purple-500'} rounded-full blur-2xl"></div>
            
            <div class="relative z-10 flex flex-col h-full">
                <!-- Header -->
                <div class="flex items-start justify-between mb-4 pb-4 border-b border-white/5">
                    <div class="flex items-center gap-2">
                        ${number ? `<div class="bg-[var(--accent-blue)] text-white preserve-white text-[10px] font-extrabold w-6 h-6 rounded-full flex items-center justify-center">#${number}</div>` : ''}
                        <span class="text-[10px] font-bold uppercase tracking-widest px-2 py-1 rounded ${isWeekly ? 'bg-blue-500/15 text-blue-400' : 'bg-purple-500/15 text-purple-400'}">${isWeekly ? '📅 Settimanale' : '📝 Giornaliero'}</span>
                    </div>
                    <span class="text-[10px] font-bold ${statusLabelColor}">${statusLabel}</span>
                </div>
                
                <!-- Date -->
                <div class="text-[10px] text-[var(--text-muted)] font-bold uppercase tracking-wider mb-3">
                    ${new Date(r.date).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                </div>
                
                <!-- Content -->
                <p class="text-sm text-white preserve-white leading-relaxed line-clamp-3 opacity-90 group-hover:opacity-100 mb-3 flex-grow">
                    ${r.generalNote || '<span class="italic opacity-30">Nessuna nota...</span>'}
                </p>
                
                <!-- Bad trades section for weekly -->
                ${(isWeekly && r.bad) ? `
                    <div class="mt-3 pt-3 border-t border-red-500/10 bg-red-500/5 rounded-lg p-3 -mx-5 px-5">
                        <span class="text-[9px] font-bold uppercase text-red-400 flex items-center gap-1 mb-1">
                            <i class="ph-bold ph-warning"></i> Errori Principali
                        </span>
                        <p class="text-xs text-red-300 line-clamp-2 font-medium">${r.bad}</p>
                    </div>
                ` : ''}
                
                <!-- Mood or Status -->
                <div class="mt-3 pt-3 border-t border-white/5 flex items-center justify-between">
                    ${r.status === 'completed' ? `
                        <div class="flex items-center gap-2">

                            <span class="text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)]">${r.mood === 'pessimista' ? 'Pessimista' : r.mood === 'ottimista' ? 'Ottimista' : 'Neutro'}</span>
                        </div>
                    ` : `
                        <span class="text-[10px] font-bold uppercase tracking-wider text-yellow-400">○ In Bozza</span>
                    `}
                    <i class="ph-bold ph-caret-right text-[var(--text-muted)] group-hover:text-[var(--accent-blue)] transition-colors"></i>
                </div>
            </div>
        </div>`;
    },

    renderMinimalReviewCard(r, number) { return `<div onclick="ui.viewReview(${r.id})" class="group bg-[var(--bg-card)] hover:bg-[var(--input-bg)] border border-transparent hover:border-white/5 p-5 rounded-2xl cursor-pointer transition-all relative overflow-hidden"><div class="flex justify-between items-start gap-4 relative z-10"><div class="flex-1"><div class="flex items-center mb-2">${number ? `<div class="bg-[var(--text-main)] text-[var(--bg-body)] text-[10px] font-extrabold w-6 h-6 rounded-full flex items-center justify-center shadow-md mr-3 shrink-0">#${number}</div>` : ''}<span class="text-[10px] font-bold uppercase tracking-wide text-blue-500 mr-2">${r.type === 'weekly' ? 'Weekly' : 'Daily'}</span><span class="text-[10px] font-bold text-[var(--text-muted)]">• ${new Date(r.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' })}</span>${r.status !== 'completed' ? '<span class="ml-2 px-1.5 py-0.5 rounded bg-yellow-500/20 text-yellow-500 text-[9px] font-bold uppercase">Bozza</span>' : ''}</div><p class="text-sm text-white preserve-white leading-relaxed line-clamp-2 opacity-90 group-hover:opacity-100 mb-2">${r.generalNote || '<span class="italic opacity-30">Nessun testo...</span>'}</p>${(r.type === 'weekly' && r.bad) ? `<div class="mt-2 pt-2 border-t border-white/5"><span class="text-[9px] font-bold uppercase text-red-500 bg-red-500/10 px-1.5 py-0.5 rounded">Errori Principali</span><p class="text-xs text-red-400 mt-1 line-clamp-2 font-medium">${r.bad}</p></div>` : ''}</div><div class="text-[var(--text-muted)] opacity-0 group-hover:opacity-100 transition-opacity self-center"><i class="ph-bold ph-caret-right"></i></div></div></div>`; },

    // --- TODO ---
    todo() {
        const todos = DataStore.data.todos || [];
        const days = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
        const goals = DataStore.data.weeklyGoals || [];

        const sortTodos = (list) => {
            const importanceWeight = { 'high': 2, 'normal': 1 };
            return list.sort((a, b) => {
                if (a.completed !== b.completed) return a.completed ? 1 : -1;
                const impA = importanceWeight[a.importance] || 1;
                const impB = importanceWeight[b.importance] || 1;
                if (impA !== impB) return impB - impA;
                return a.type.localeCompare(b.type);
            });
        };

        ui.container.innerHTML = `
        <div class="space-y-4 fade-in flex flex-col">
            <div class="flex justify-between items-center md:items-end px-4 pt-2 pb-2 border-b border-white/5 shrink-0">
                <div>
                    <h2 class="text-2xl md:text-3xl font-bold tracking-tight text-white preserve-white mb-1">Weekly Focus</h2>
                    <p class="text-[10px] md:text-xs text-[var(--text-muted)] font-bold uppercase tracking-wide">Pianifica il tuo successo</p>
                </div>
                <div class="flex items-center gap-2">
                    <button onclick="DataStore.resetWeek()" class="bg-white/5 text-[var(--text-muted)] px-4 py-2 rounded-xl font-bold hover:bg-red-500/10 hover:text-red-500 transition-all flex items-center gap-2">
                        <i class="ph-bold ph-arrow-counter-clockwise"></i>
                        <span class="hidden md:inline">Reset</span>
                    </button>
                    <div class="flex gap-2"><button onclick="ui.openTodoModal('task', true)" class="bg-[var(--accent-blue)] text-white preserve-white px-4 py-2 rounded-xl font-bold hover:opacity-90 transition-opacity flex items-center gap-2 flex-shrink-0"><i class="ph-bold ph-plus"></i><span class="hidden md:inline">Nuovo</span></button></div>
                </div>
            </div>

            <div class="flex-1 flex flex-col overflow-hidden px-2 relative md:pb-0">
                ${goals.length > 0 ? `
                <div class="flex gap-3 mb-6 shrink-0 overflow-x-auto snap-x snap-mandatory hide-scrollbar pb-2">
                    ${goals.map(g => `
                    <div class="relative px-3 py-2 rounded-xl border transition-all overflow-hidden group min-w-[280px] snap-center ${g.failed ? 'bg-red-500/10 border-red-500/20' : (g.completed ? 'bg-green-500/10 border-green-500/20' : 'bg-[var(--bg-card)] border-white/5 hover:border-[var(--accent-blue)]/30')}">
                        <div class="flex items-start justify-between relative z-10">
                            <div class="flex-1" onclick="ui.openEditWeeklyGoalModal(${g.id})" class="cursor-pointer">
                                <div class="flex items-center gap-2 mb-1 h-[14px]">
                                    <span class="text-[9px] font-bold uppercase tracking-wider ${g.failed ? 'text-red-500' : (g.completed ? 'text-green-500' : 'text-yellow-500')}">Goal</span>
                                    ${g.completed ? '<i class="ph-fill ph-check-circle text-green-500 text-xs"></i>' : (g.failed ? '<i class="ph-fill ph-x-circle text-red-500 text-xs"></i>' : '<i class="ph-fill ph-target text-yellow-500 text-xs"></i>')}
                                </div>
                                <h3 class="font-bold text-sm leading-snug ${g.completed || g.failed ? 'line-through opacity-50' : 'text-white preserve-white'}">${g.title}</h3>
                                <div class="mt-1.5 h-[16px]">
                                    ${!g.completed && !g.failed && g.reward ? `<p class="text-[10px] text-[var(--text-muted)] flex items-center gap-1"><i class="ph-bold ph-gift"></i> ${g.reward}</p>` : ''}
                                    ${g.failed && g.punishment ? `<p class="text-[10px] text-red-400 flex items-center gap-1"><i class="ph-bold ph-warning"></i> ${g.punishment}</p>` : ''}
                                </div>
                            </div>
                            <div class="flex gap-1">
                                <button onclick="event.stopPropagation(); DataStore.toggleWeeklyGoal(${g.id}); router.todo()" class="w-6 h-6 rounded-full ${g.completed ? 'bg-green-500/20 text-green-500' : 'bg-white/5 hover:bg-green-500/20 hover:text-green-500'} flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all" title="${g.completed ? 'Ripristina' : 'Segna come completato'}">
                                    <i class="ph-bold ${g.completed ? 'ph-arrow-counter-clockwise' : 'ph-check'} text-xs"></i>
                                </button>
                                <button onclick="event.stopPropagation(); DataStore.toggleWeeklyGoalFailed(${g.id}); router.todo()" class="w-6 h-6 rounded-full ${g.failed ? 'bg-red-500/20 text-red-500' : 'bg-white/5 hover:bg-red-500/20 hover:text-red-500'} flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all" title="${g.failed ? 'Ripristina' : 'Segna come fallito'}">
                                    <i class="ph-bold ${g.failed ? 'ph-arrow-counter-clockwise' : 'ph-x'} text-xs"></i>
                                </button>
                            </div>
                        </div>
                    </div>`).join('')}
                </div>` : `
                <div class="mb-6 p-4 rounded-xl border border-dashed border-white/10 bg-[var(--bg-card)]/30 flex flex-row items-center justify-center gap-4 text-center cursor-pointer hover:bg-[var(--bg-card)] hover:border-white/20 transition-all group shrink-0" onclick="ui.openTodoModal('goal', false)">
                    <div class="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center text-[var(--text-muted)] group-hover:text-[var(--accent-blue)] transition-colors">
                        <i class="ph-duotone ph-target text-lg"></i>
                    </div>
                    <div class="text-left">
                        <p class="text-xs font-bold text-white preserve-white">Nessun Obiettivo Settimanale</p>
                        <p class="text-[10px] text-[var(--text-muted)]">Imposta i tuoi focus principali.</p>
                    </div>
                    <i class="ph-bold ph-plus text-[var(--accent-blue)] opacity-0 group-hover:opacity-100 transition-opacity ml-2"></i>
                </div>
                `}

                <!-- Navigation Arrows + Days Container -->
                <div class="flex-1 flex items-stretch relative">
                    <!-- Left Arrow -->
                    <button onclick="ui.scrollToDays(-1)" class="flex absolute left-0 top-0 bottom-0 my-auto z-20 w-8 h-8 md:w-10 md:h-10 rounded-full bg-[var(--bg-card)] border border-white/10 items-center justify-center text-[var(--text-muted)] shadow-xl cursor-pointer hover:bg-white/5 hover:border-[var(--accent-blue)]/30 transition-all" title="Giorno precedente">
                        <i class="ph-bold ph-caret-left text-base md:text-lg"></i>
                    </button>

                    <!-- Days Container -->
                    <div class="flex-1 flex gap-4 overflow-x-auto pb-24 md:pb-4 px-10 md:px-12 custom-scrollbar snap-x items-stretch scroll-smooth" id="todo-days-container">
                        ${days.map((day, index) => {
            const rawDayTodos = todos.filter(t => t.day === day);
            const dayTodos = sortTodos([...rawDayTodos]);
            const isToday = new Date().toLocaleDateString('it-IT', { weekday: 'long' }).toLowerCase() === day.toLowerCase();

            return `
                            <div 
                                ${isToday ? 'id="today-card"' : ''} 
                            data-day="${day}"
                            data-day-index="${index}"
                            ondragover="ui.handleTodoDragOver(event)" 
                            ondrop="ui.handleTodoDrop(event, '${day}')"
                            ondragleave="ui.handleTodoDragLeave(event)"
                            class="min-w-[280px] md:min-w-[320px] max-w-[320px] snap-center flex flex-col h-full min-h-[500px] rounded-2xl ${isToday ? 'bg-gradient-to-b from-[var(--bg-card)] to-transparent border border-[var(--accent-blue)]/20' : 'bg-[var(--bg-card)]/40 border border-white/5'} overflow-hidden todo-day-container shrink-0">
                            <div class="flex justify-between items-center px-4 py-3 border-b border-white/5 ${isToday ? 'bg-[var(--accent-blue)]/5' : ''} shrink-0">
                                <div class="flex items-center gap-2">
                                    <h3 class="text-sm font-bold uppercase tracking-wide ${isToday ? 'text-white preserve-white' : 'text-[var(--text-muted)]'}">${day}</h3>
                                    ${isToday ? '<span class="w-1.5 h-1.5 rounded-full bg-[var(--accent-blue)] animate-pulse"></span>' : ''}
                                </div>
                                <span class="text-[10px] font-bold bg-white/5 text-[var(--text-muted)] px-2 py-0.5 rounded text-xs">${dayTodos.length}</span>
                            </div>

                            <div class="flex-1 overflow-y-auto p-2 space-y-2 custom-scrollbar">
                                ${dayTodos.length > 0 ? dayTodos.map(t => {
                let typeIcon = 'ph-bold ph-circle';
                let typeColor = 'text-[var(--text-muted)]';
                let typeBg = 'bg-white/5';

                if (t.type === 'Trading') { typeIcon = 'ph-duotone ph-chart-line-up'; typeColor = 'text-blue-400'; typeBg = 'bg-blue-400/10'; }
                if (t.type === 'Salute') { typeIcon = 'ph-duotone ph-heart'; typeColor = 'text-pink-400'; typeBg = 'bg-pink-400/10'; }
                if (t.type === 'Studio') { typeIcon = 'ph-duotone ph-book-open'; typeColor = 'text-purple-400'; typeBg = 'bg-purple-400/10'; }

                const isHigh = t.importance === 'high';
                const displayType = t.type;

                return `
                                        <div 
                                            draggable="true" 
                                            ondragstart="ui.handleTodoDragStart(event, ${t.id})" 
                                            ondragend="ui.handleTodoDragEnd(event)"
                                            onclick="DataStore.toggleTodo(${t.id}); router.todo()" 
                                            class="group relative bg-[var(--bg-card)] hover:bg-[#2a2a2d] border ${isHigh && !t.completed ? 'border-red-500/30' : 'border-white/5'} hover:border-white/20 rounded-xl p-3 transition-all cursor-move shadow-sm hover:translate-x-1">
                                            <div class="flex gap-3 items-start">
                                                <div class="mt-0.5 w-4 h-4 rounded border ${t.completed ? 'bg-[var(--accent-blue)] border-[var(--accent-blue)]' : 'border-white/20 group-hover:border-[var(--accent-blue)]'} flex items-center justify-center transition-colors flex-shrink-0">
                                                    ${t.completed ? '<i class="ph-bold ph-check text-white preserve-white text-[8px]"></i>' : ''}
                                                </div>

                                                <div class="flex-1 min-w-0">
                                                    <p class="text-xs font-semibold ${t.completed ? 'line-through text-[var(--text-muted)]' : 'text-white preserve-white'} leading-snug mb-1.5 break-words">${t.title}</p>

                                                    <div class="flex flex-wrap gap-1.5 items-center">
                                                        <div class="text-[9px] font-bold px-1.5 py-0.5 rounded ${typeBg} ${typeColor} flex items-center gap-1 uppercase tracking-wide">
                                                            <i class="${typeIcon} text-[9px]"></i> ${displayType}
                                                        </div>
                                                        ${t.timeEst ? `<div class="text-[9px] font-bold text-[var(--text-muted)] flex items-center gap-1"><i class="ph-bold ph-clock"></i> ${t.timeEst}</div>` : ''}
                                                        ${isHigh ? `<i class="ph-fill ph-fire text-red-500 text-[10px]" title="Alta Priorità"></i>` : ''}
                                                    </div>
                                                </div>
                                            </div>
                                            <div class="absolute top-2 right-2 flex gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-all pointer-events-auto">
                                                <button draggable="false" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation(); ui.openEditTodoModal(${t.id})" class="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-blue-500/10 hover:text-blue-500 transition-all">
                                                    <i class="ph-bold ph-pencil-simple text-xs"></i>
                                                </button>
                                                <button draggable="false" onpointerdown="event.stopPropagation()" onclick="event.stopPropagation(); DataStore.deleteTodo(${t.id}); router.todo()" class="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-red-500/10 hover:text-red-500 transition-all">
                                                    <i class="ph-bold ph-trash text-xs"></i>
                                                </button>
                                            </div>
                                        </div>`;
            }).join('') : `
                                            <div class="h-full min-h-[100px] flex flex-col items-center justify-center gap-2 opacity-30">
                                                <i class="ph-duotone ph-check-square-offset text-3xl"></i>
                                                <p class="text-[10px] font-bold uppercase tracking-wide">Empty</p>
                                            </div>
                                        `}
                                </div>
                            </div>`;
        }).join('')}
                    </div>

                    <!-- Right Arrow -->
                    <button onclick="ui.scrollToDays(1)" class="flex absolute right-0 top-0 bottom-0 my-auto z-20 w-8 h-8 md:w-10 md:h-10 rounded-full bg-[var(--bg-card)] border border-white/10 items-center justify-center text-[var(--text-muted)] shadow-xl cursor-pointer hover:bg-white/5 hover:border-[var(--accent-blue)]/30 transition-all" title="Giorno successivo">
                        <i class="ph-bold ph-caret-right text-base md:text-lg"></i>
                    </button>
                </div>
            </div>
        </div>`;

        requestAnimationFrame(() => {
            const todayEl = document.getElementById('today-card');
            if (todayEl) {
                const dayIndex = parseInt(todayEl.getAttribute('data-day-index')) || 0;
                ui.currentDayIndex = dayIndex;
                todayEl.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
            }
        });
    },

    // Scroll days left or right
    scrollToDays(direction) {
        const container = document.getElementById('todo-days-container');
        if (!container) return;

        const dayCards = Array.from(container.querySelectorAll('.todo-day-container'));
        if (dayCards.length === 0) return;

        // Calcola l'indice corrente basato sulla posizione visiva reale
        // Questo previene desincronizzazioni se l'utente ha scrollato manualmente
        const containerRect = container.getBoundingClientRect();
        const containerCenter = containerRect.left + (containerRect.width / 2);

        let closestIndex = 0;
        let minDiff = Infinity;

        dayCards.forEach((card, index) => {
            const cardRect = card.getBoundingClientRect();
            const cardCenter = cardRect.left + (cardRect.width / 2);
            const diff = Math.abs(cardCenter - containerCenter);

            if (diff < minDiff) {
                minDiff = diff;
                closestIndex = index;
            }
        });

        // Se non abbiamo un indice salvato o è diverso da quello visivo, aggiorniamolo
        ui.currentDayIndex = closestIndex;

        // Calcola il nuovo indice
        let newIndex = ui.currentDayIndex + direction;

        // Limita l'indice ai bordi
        if (newIndex < 0) newIndex = 0;
        if (newIndex >= dayCards.length) newIndex = dayCards.length - 1;

        // Aggiorna l'indice corrente
        ui.currentDayIndex = newIndex;

        // Scrolla alla card target
        const targetCard = dayCards[newIndex];
        if (targetCard) {
            targetCard.scrollIntoView({
                behavior: 'smooth',
                inline: 'center',
                block: 'nearest'
            });
        }
    },

    // --- HELPERS & MODALS ---

    // FIX: openModal, closeModals e renderInitialModals sono stati modificati per lavorare solo con i contenitori base e l'overlay
    openModal(id) {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) {
            overlay.classList.remove('hidden', 'animate-fade-out');
            overlay.classList.add('flex', 'animate-fade-in');
        }
        const m = document.getElementById(id);
        if (m) {
            m.classList.remove('hidden');
            m.classList.remove('scale-95');
            if (id === 'modal-trade') ui.setupDragDrop();
        }

        // Blocca interazioni con tutto il background
        this.setBackgroundInteractivity(true);

        // Nascondi navbar quando si apre il modal per creare/modificare trade o revisioni
        if (id === 'modal-review' || id === 'modal-trade') {
            const navbar = document.querySelector('nav');
            if (navbar) {
                // Rimuovi eventuali stili inline precedenti per pulizia
                navbar.style.cssText = '';
                // Aggiungi la classe CSS dedicata
                navbar.classList.add('nav-hidden-mode');
            }
        }
    },

    closeModals() {
        const overlay = document.getElementById('modal-overlay');
        if (overlay) {
            // Ferma tutti i player audio attivi nei modali
            const audioPlayers = overlay.querySelectorAll('audio');
            audioPlayers.forEach(audio => {
                if (!audio.paused) {
                    audio.pause();
                    audio.currentTime = 0;
                }
            });

            // Ferma anche la registrazione se attiva
            if (ui.audioRecorder && ui.audioRecorder.state !== 'inactive') {
                ui.stopAudioRecording();
            }

            // Mostra navbar rimuovendo la classe
            const navbar = document.querySelector('nav');
            if (navbar) {
                navbar.style.cssText = ''; // Pulisci eventuali stili inline
                navbar.classList.remove('nav-hidden-mode');
            }

            overlay.classList.add('animate-fade-out');

            setTimeout(() => {
                // Se l'animazione di uscita è stata rimossa (da openModal), annulla la chiusura
                if (!overlay.classList.contains('animate-fade-out')) return;

                overlay.classList.add('hidden');
                overlay.classList.remove('flex', 'animate-fade-out');
                document.querySelectorAll('.modal-clean').forEach(m => m.classList.add('hidden'));

                // Ripristina interazioni del background solo quando il modal è davvero chiuso
                this.setBackgroundInteractivity(false);
            }, 300);
        }
    },

    // 🗜️ COMPRESSIONE AUTOMATICA IMMAGINI
    async compressImage(file, maxWidth = 1920, quality = 0.85) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = (e) => {
                const img = new Image();

                img.onload = () => {
                    // Calcola nuove dimensioni mantenendo aspect ratio
                    let width = img.width;
                    let height = img.height;

                    if (width > maxWidth) {
                        height = (height * maxWidth) / width;
                        width = maxWidth;
                    }

                    // Crea canvas per ridimensionamento
                    const canvas = document.createElement('canvas');
                    canvas.width = width;
                    canvas.height = height;

                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0, width, height);

                    // Converti in base64 con compressione
                    // JPEG per foto, PNG se ha trasparenza
                    const hasAlpha = file.type === 'image/png';
                    const mimeType = hasAlpha ? 'image/png' : 'image/jpeg';
                    const compressed = canvas.toDataURL(mimeType, quality);

                    // Log info compressione
                    const originalSize = (file.size / 1024).toFixed(2);
                    const compressedSize = (compressed.length * 0.75 / 1024).toFixed(2);
                    console.log(`🗜️ Immagine compressa: ${originalSize}KB → ${compressedSize}KB (${((1 - compressedSize / originalSize) * 100).toFixed(0)}% riduzione)`);

                    resolve(compressed);
                };

                img.onerror = () => reject(new Error('Errore caricamento immagine'));
                img.src = e.target.result;
            };

            reader.onerror = () => reject(new Error('Errore lettura file'));
            reader.readAsDataURL(file);
        });
    },

    async handleFileSelect(e, target = 'trade') {
        const files = e.target?.files || e.dataTransfer?.files;
        if (!files || files.length === 0) return;
        
        for (const file of Array.from(files)) {
            if (file.type.startsWith('image/')) {
                try {
                    const compressed = await ui.compressImage(file);
                    ui.tempImages.push(compressed);
                    
                    if (target === 'setup') {
                        ui.renderTempImagesSetup();
                    } else if (target === 'review') {
                        ui.renderTempImagesReview();
                    } else {
                        ui.renderTempImages();
                    }
                } catch (error) {
                    console.error('Errore compressione:', error);
                    ui.showToast("⚠️ Errore nel caricare l'immagine");
                }
            }
        }
    },

    // Alias per compatibility
    closeModal() { this.closeModals(); },

    setupDragDrop() {
        const dz = document.getElementById('drop-zone'); const fi = document.getElementById('file-input'); if (!dz || !fi) return;

        // Click to open file picker
        dz.onclick = (e) => { if (e.target.id !== 'clear-imgs-btn') fi.click() };

        // Handle multiple file selection
        fi.onchange = async (e) => {
            if (e.target.files && e.target.files.length > 0) {
                for (const file of Array.from(e.target.files)) {
                    try {
                        const compressed = await ui.compressImage(file);
                        ui.tempImages.push(compressed);
                        ui.renderTempImages();
                    } catch (error) {
                        console.error('Errore compressione:', error);
                        ui.showToast('⚠️ Errore nel caricare l\'immagine');
                    }
                }
            }
        };

        // Drag & drop support
        dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('border-blue-500', 'bg-blue-500/10'); };
        dz.ondragleave = (e) => { e.preventDefault(); dz.classList.remove('border-blue-500', 'bg-blue-500/10'); };
        dz.ondrop = async (e) => {
            e.preventDefault();
            dz.classList.remove('border-blue-500', 'bg-blue-500/10');
            if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
                for (const file of Array.from(e.dataTransfer.files)) {
                    if (file.type.startsWith('image/')) {
                        try {
                            const compressed = await ui.compressImage(file);
                            ui.tempImages.push(compressed);
                            ui.renderTempImages();
                        } catch (error) {
                            console.error('Errore compressione:', error);
                            ui.showToast('⚠️ Errore nel caricare l\'immagine');
                        }
                    }
                }
            }
        };

        const clearBtn = document.getElementById('clear-imgs-btn'); if (clearBtn) clearBtn.onclick = (e) => { e.stopPropagation(); ui.tempImages = []; ui.renderTempImages(); };
    },
    renderTempImages() {
        const c = document.getElementById('gallery-preview'); const dz = document.getElementById('drop-zone-content'); const btn = document.getElementById('clear-imgs-btn'); if (!c || !dz || !btn) return;
        c.innerHTML = ''; if (ui.tempImages.length) { c.classList.remove('hidden'); dz.classList.add('opacity-0'); btn.classList.remove('hidden'); ui.tempImages.forEach(s => { const d = document.createElement('div'); d.className = "w-16 h-16 bg-cover bg-center rounded-lg border border-white/20"; d.style.backgroundImage = `url(${s})`; d.onclick = (e) => { e.stopPropagation(); ui.viewFullImage(s); }; c.appendChild(d); }); } else { c.classList.add('hidden'); dz.classList.remove('opacity-0'); btn.classList.add('hidden'); }
    },

    renderTempImagesReview() {
        const c = document.getElementById('gallery-preview-review'); const dz = document.getElementById('drop-zone-content-review'); const btn = document.getElementById('clear-imgs-btn-review'); if (!c || !dz || !btn) return;
        c.innerHTML = ''; if (ui.tempImages.length) { c.classList.remove('hidden'); dz.classList.add('hidden'); btn.classList.remove('hidden'); ui.tempImages.forEach(s => { const d = document.createElement('div'); d.className = "w-16 h-16 bg-cover bg-center rounded-lg border border-white/20"; d.style.backgroundImage = `url(${s})`; d.onclick = (e) => { e.stopPropagation(); ui.viewFullImage(s); }; c.appendChild(d); }); } else { c.classList.add('hidden'); dz.classList.remove('hidden'); btn.classList.add('hidden'); }
    },

    setupReviewImageHandlers() {
        try {
            const dropZone = document.getElementById('drop-zone-review');
            const fileInput = document.getElementById('img-upload-review');

            if (!dropZone || !fileInput) {
                console.warn('Review image elements not found in DOM');
                return;
            }

            // Setup click handler - più semplice e diretto
            dropZone.onclick = (e) => {
                // Evita di aprire il file picker se si clicca sul bottone clear
                if (e.target.closest('#clear-imgs-btn-review')) {
                    return;
                }
                fileInput.click();
            };

            // Drag & drop handlers
            dropZone.ondragover = (e) => {
                e.preventDefault();
                dropZone.classList.add('border-[var(--accent-blue)]');
            };

            dropZone.ondragleave = () => {
                dropZone.classList.remove('border-[var(--accent-blue)]');
            };

            dropZone.ondrop = async (e) => {
                e.preventDefault();
                dropZone.classList.remove('border-[var(--accent-blue)]');
                const files = e.dataTransfer.files;

                for (let f of files) {
                    if (!f.type.startsWith('image/')) continue;
                    try {
                        const compressed = await ui.compressImage(f);
                        ui.tempImages.push(compressed);
                        ui.renderTempImagesReview();
                    } catch (error) {
                        console.error('Errore compressione:', error);
                        ui.showToast('⚠️ Errore nel caricare l\'immagine');
                    }
                }
            };

            // File input handler
            fileInput.onchange = async (e) => {
                const files = e.target.files;
                for (let f of files) {
                    if (!f.type.startsWith('image/')) continue;
                    try {
                        const compressed = await ui.compressImage(f);
                        ui.tempImages.push(compressed);
                        ui.renderTempImagesReview();
                    } catch (error) {
                        console.error('Errore compressione:', error);
                        ui.showToast('⚠️ Errore nel caricare l\'immagine');
                    }
                }
                // Reset input per permettere di caricare lo stesso file
                e.target.value = '';
            };

            // Clear button handler
            const clearBtn = document.getElementById('clear-imgs-btn-review');
            if (clearBtn) {
                clearBtn.onclick = (e) => {
                    e.stopPropagation();
                    ui.tempImages = [];
                    ui.renderTempImagesReview();
                };
            }

            // Render iniziale
            ui.renderTempImagesReview();
        } catch (error) {
            console.error('Error setting up review image handlers:', error);
            // Non bloccare l'esecuzione se c'è un errore
        }
    },

    // NEW HELPER: Renders the *entire* trade modal content string
    renderTradeModalContent(data, isEdit) {
        const t = data || { id: '', asset: DataStore.data.settings.assets[0] || 'EURUSD', date: new Date().toISOString().slice(0, 16), direction: 'LONG', status: 'executed', pnl: 0, rr: '', session: 'London', strategy: 'SMC', timeframe: 'M15', notes: '', mistakes: '', improvements: '', images: [], accountId: DataStore.data.accounts.length ? DataStore.data.accounts[0].id : '' };
        let safeDate = t.date;
        if (safeDate && safeDate.length > 16) safeDate = safeDate.slice(0, 16);

        ui.tempImages = t.images ? [...t.images] : [];

        const modal = document.getElementById('modal-trade');
        if (!modal) return;

        // Sovrascrive il contenuto del modale con la struttura completa - REDESIGNED
        modal.innerHTML = `
                <div class="bg-[var(--bg-card)] w-full max-w-3xl rounded-3xl border border-white/10 shadow-2xl transform transition-all scale-100 max-h-[92vh] overflow-hidden flex flex-col">

                        <!-- Header -->
                        <div class="flex items-center justify-between px-5 py-5 md:px-8 md:py-6 border-b border-white/5 flex-shrink-0">
                            <div class="flex items-center gap-4">
                                <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500/20 to-blue-500/5 border border-blue-500/30 flex items-center justify-center">
                                    <i class="ph-bold ph-chart-line text-xl text-blue-400"></i>
                                </div>
                                <div>
                                    <p class="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Registrazione Trade</p>
                                    <h3 class="text-xl font-bold text-white preserve-white">${isEdit ? 'Modifica Trade' : 'Nuovo Trade'}</h3>
                                </div>
                            </div>
                            <button onclick="ui.closeModals()" class="group w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all text-[var(--text-muted)] hover:text-white preserve-white">
                                <i class="ph-bold ph-x text-lg group-hover:rotate-90 transition-transform"></i>
                            </button>
                        </div>

                        <!-- Scrollable Content -->
                        <div class="flex-1 overflow-y-auto custom-scrollbar px-5 py-5 md:px-8 md:py-6">
                            <form id="trade-form" class="space-y-6">
                                <input type="hidden" id="t-id" value="${t.id}">

                                <!-- Asset & Direction -->
                                <div class="bg-gradient-to-br from-blue-500/5 to-transparent border border-blue-500/20 rounded-2xl p-5">
                                    <div class="flex items-center gap-4">
                                        <div class="flex-1">
                                            <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2">Asset</label>
                                            <div class="relative">
                                                <select id="t-asset" class="w-full bg-white/5 border border-white/10 rounded-xl text-lg font-bold text-white preserve-white py-3 px-4 pr-10 outline-none appearance-none cursor-pointer hover:bg-white/10 hover:border-blue-500/30 focus:border-blue-500/50 transition-all">
                                                    ${DataStore.data.settings.assets.map(a => `<option value="${a}" ${t.asset === a ? 'selected' : ''} class="bg-[var(--bg-card)]">${a}</option>`).join('')}
                                                </select>
                                                <i class="ph-bold ph-caret-down absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-muted)]"></i>
                                            </div>
                                        </div>
                                        <div>
                                            <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2">Direzione</label>
                                            <div class="flex gap-2">
                                                <label class="cursor-pointer">
                                                    <input type="radio" name="direction_radio" value="LONG" class="peer sr-only" ${t.direction === 'LONG' ? 'checked' : ''}>
                                                    <div class="px-5 py-3 rounded-xl border-2 text-sm font-bold transition-all peer-checked:bg-green-500/15 peer-checked:border-green-500/50 peer-checked:text-green-400 border-white/10 text-[var(--text-muted)] hover:border-white/20 hover:bg-white/5 flex items-center gap-2">
                                                        <i class="ph-bold ph-arrow-up"></i>
                                                        LONG
                                                    </div>
                                                </label>
                                                <label class="cursor-pointer">
                                                    <input type="radio" name="direction_radio" value="SHORT" class="peer sr-only" ${t.direction === 'SHORT' ? 'checked' : ''}>
                                                    <div class="px-5 py-3 rounded-xl border-2 text-sm font-bold transition-all peer-checked:bg-red-500/15 peer-checked:border-red-500/50 peer-checked:text-red-400 border-white/10 text-[var(--text-muted)] hover:border-white/20 hover:bg-white/5 flex items-center gap-2">
                                                        <i class="ph-bold ph-arrow-down"></i>
                                                        SHORT
                                                    </div>
                                                </label>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- P&L & Additional Info -->
                                <div class="grid grid-cols-1 md:grid-cols-3 gap-3 md:gap-4">
                                    <div class="md:col-span-2 bg-white/5 border border-white/10 rounded-2xl px-4 py-3 hover:bg-white/[0.07] transition-all">
                                        <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1.5">Profit / Loss</label>
                                        <div class="flex items-baseline gap-2">
                                            <span class="text-2xl font-bold text-[var(--text-muted)]">$</span>
                                            <input type="number" id="t-pnl" value="${t.pnl}" step="0.01" class="w-full bg-transparent border-none outline-none text-3xl font-bold text-white preserve-white placeholder-white/20 ${t.status === 'missed' ? 'opacity-50 cursor-not-allowed' : ''}" placeholder="0.00" ${t.status === 'missed' ? 'disabled' : ''}>
                                        </div>
                                    </div>
                                    <div class="space-y-4">
                                        <div class="bg-white/5 border border-white/10 rounded-2xl px-3 py-2 hover:bg-white/[0.07] transition-all">
                                            <label class="block text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1">R:R</label>
                                            <input type="number" id="t-rr" value="${t.rr}" step="0.1" class="w-full bg-transparent border-none outline-none text-lg font-bold text-white preserve-white placeholder-white/20" placeholder="0">
                                        </div>
                                        <div class="bg-white/5 border border-white/10 rounded-2xl px-3 py-2 flex items-center justify-between cursor-pointer hover:bg-white/10 transition-all" onclick="const el = document.getElementById('t-missed-check'); el.checked = !el.checked; ui.togglePnlInput(!el.checked);">
                                            <span class="text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)]">Missed</span>
                                            <div class="relative inline-flex items-center pointer-events-none">
                                                <input type="checkbox" id="t-missed-check" class="sr-only peer" ${t.status === 'missed' ? 'checked' : ''}>
                                                <div class="w-9 h-5 bg-white/10 rounded-full peer peer-checked:after:translate-x-full after:content-[''] after:absolute after:top-[3px] after:left-[3px] after:bg-white after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-gray-500"></div>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- Trade Details Grid -->
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
                                    <div class="bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                                        <label class="block text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1.5">Data & Ora</label>
                                        <input type="datetime-local" id="t-date" value="${safeDate}" class="bg-transparent border-none outline-none text-sm font-bold text-white preserve-white w-full">
                                    </div>
                                    <div class="bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                                        <label class="block text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3">Seleziona Account</label>
                                        <div class="space-y-2 max-h-40 overflow-y-auto custom-scrollbar">
                                            ${DataStore.data.accounts.map(a => `
                                                <label class="flex items-center justify-between p-3 rounded-xl bg-white/5 cursor-pointer group border border-transparent has-[:checked]:bg-blue-500/10 has-[:checked]:border-blue-500/50">
                                                    <div class="flex items-center gap-3 flex-1 min-w-0">
                                                        <input type="checkbox" name="t-accounts" value="${a.id}" ${t.accountId == a.id ? 'checked' : ''} class="sr-only pointer-events-none focus:outline-none focus-visible:outline-none" tabindex="-1">
                                                        <div class="flex-1 min-w-0">
                                                            <p class="text-sm font-bold text-white preserve-white truncate">${a.name}</p>
                                                            <p class="text-[10px] text-[var(--text-muted)]">${a.type || 'Account'} • ${ui.formatCurrency(a.balance || 0)}</p>
                                                        </div>
                                                    </div>
                                                    <i class="ph-bold ph-check-circle text-blue-400 text-lg opacity-0 group-has-[:checked]:opacity-100"></i>
                                                </label>
                                            `).join('')}
                                            ${DataStore.data.accounts.length === 0 ? '<p class="text-xs text-[var(--text-muted)] italic text-center py-4">Nessun conto disponibile. Creane uno nelle impostazioni.</p>' : ''}
                                        </div>
                                        ${DataStore.data.accounts.length > 1 ? `
                                        <button type="button" onclick="ui.toggleAllAccounts()" class="mt-3 w-full text-xs text-blue-400 hover:text-blue-300 font-bold py-2 px-3 rounded-lg bg-blue-500/10 hover:bg-blue-500/20 transition-all flex items-center justify-center gap-2">
                                            <i class="ph-bold ph-check-square"></i>
                                            Seleziona / Deseleziona tutti
                                        </button>
                                        ` : ''}
                                    </div>
                                    <div class="bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                                        <label class="block text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1.5">Strategia</label>
                                        <div class="relative">
                                            <select id="t-strategy" class="bg-transparent border-none outline-none text-sm font-bold text-white preserve-white w-full appearance-none pr-6">
                                                ${DataStore.data.settings.strategies.map(s => `<option value="${s}" ${t.strategy === s ? 'selected' : ''} class="bg-[var(--bg-card)]">${s}</option>`).join('')}
                                            </select>
                                            <i class="ph-bold ph-caret-down absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none text-[var(--text-muted)] text-xs"></i>
                                        </div>
                                    </div>
                                    <div class="bg-white/5 border border-white/10 rounded-xl px-4 py-3">
                                        <label class="block text-[9px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1.5">Sessione & Timeframe</label>
                                        <div class="flex gap-2 items-center">
                                            <div class="relative flex-1">
                                                <select id="t-session" class="bg-transparent border-none outline-none text-sm font-bold text-white preserve-white w-full appearance-none pr-4">
                                                    ${DataStore.data.settings.sessions.map(s => `<option value="${s}" ${t.session === s ? 'selected' : ''} class="bg-[var(--bg-card)]">${s}</option>`).join('')}
                                                </select>
                                            </div>
                                            <span class="text-white opacity-20 preserve-white font-bold">|</span>
                                            <div class="relative flex-1">
                                                <select id="t-timeframe" class="bg-transparent border-none outline-none text-sm font-bold text-white preserve-white w-full appearance-none text-right pr-4">
                                                    ${['M1', 'M5', 'M15', 'H1', 'H4', 'D1'].map(tf => `<option value="${tf}" ${t.timeframe === tf ? 'selected' : ''} class="bg-[var(--bg-card)]">${tf}</option>`).join('')}
                                                </select>
                                            </div>
                                        </div>
                                    </div>
                                </div>

                                <!-- Notes Section -->
                                <div class="bg-white/5 border border-white/10 rounded-2xl p-5">
                                    <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3 flex items-center gap-2">
                                        <i class="ph-bold ph-notebook text-sm"></i>
                                        Note Operative
                                    </label>
                                    <textarea id="t-notes" class="w-full bg-transparent border-none outline-none text-sm text-white preserve-white placeholder-white/20 resize-none leading-relaxed min-h-[100px]" placeholder="Descrivi il setup, motivazioni dell'entrata, condizioni di mercato...">${(t.notes || '').replace(/`/g, "'")}</textarea>
                                </div>

                                <!-- Mistakes & Improvements -->
                                <div class="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                                    <div class="bg-gradient-to-br from-red-500/10 to-red-500/5 border border-red-500/20 rounded-2xl p-5">
                                        <label class="block text-[10px] font-bold uppercase tracking-widest text-red-400 mb-3 flex items-center gap-2">
                                            <div class="w-2 h-2 rounded-full bg-red-500"></div>
                                            Errori
                                        </label>
                                        <textarea id="t-mistakes" class="w-full bg-black/20 border border-red-500/10 rounded-xl p-3 outline-none text-sm text-white preserve-white placeholder-white/20 resize-none min-h-[90px] focus:bg-black/30 focus:border-red-500/30 transition-all" placeholder="Cosa non ha funzionato?">${(t.mistakes || '').replace(/`/g, "'")}</textarea>
                                    </div>
                                    <div class="bg-gradient-to-br from-green-500/10 to-green-500/5 border border-green-500/20 rounded-2xl p-5">
                                        <label class="block text-[10px] font-bold uppercase tracking-widest text-green-400 mb-3 flex items-center gap-2">
                                            <div class="w-2 h-2 rounded-full bg-green-500"></div>
                                            Perfezionamenti
                                        </label>
                                        <textarea id="t-improvements" class="w-full bg-black/20 border border-green-500/10 rounded-xl p-3 outline-none text-sm text-white preserve-white placeholder-white/20 resize-none min-h-[90px] focus:bg-black/30 focus:border-green-500/30 transition-all" placeholder="Cosa migliorare la prossima volta?">${(t.improvements || '').replace(/`/g, "'")}</textarea>
                                    </div>
                                </div>

                                <!-- Audio Note -->
                                <div>
                                    <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3 flex items-center gap-2">
                                        <i class="ph-bold ph-microphone text-sm"></i>
                                        Nota Vocale
                                    </label>
                                    <div class="bg-gradient-to-br from-blue-500/5 to-purple-500/5 border border-blue-500/20 rounded-2xl p-4 space-y-3">
                                        <button type="button" id="trade-audio-btn" data-target="trade-audio-data" class="audio-record-btn w-full py-3 rounded-xl border-2 border-dashed border-blue-500/30 hover:border-blue-500/50 bg-blue-500/5 hover:bg-blue-500/10 transition-all flex items-center justify-center gap-2 text-blue-400">
                                            <i class="ph-bold ph-microphone text-xl"></i>
                                            <span class="text-xs font-bold">Registra</span>
                                        </button>
                                        <div id="trade-audio-player"></div>
                                        <input type="hidden" id="trade-audio-data" value="${t.audioNote || ''}">
                                    </div>
                                </div>

                                <!-- Screenshots Upload -->
                                <div>
                                    <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3 flex items-center gap-2">
                                        <i class="ph-bold ph-image text-sm"></i>
                                        Screenshot
                                    </label>
                                    <div id="drop-zone" class="relative border-2 border-dashed border-white/10 rounded-2xl p-6 cursor-pointer hover:border-blue-500/50 hover:bg-blue-500/5 transition-all min-h-[120px] flex items-center justify-center">
                                        <input type="file" id="file-input" class="hidden" accept="image/*" multiple>
                                        <div id="drop-zone-content" class="${ui.tempImages.length ? 'hidden' : 'flex'} flex-col items-center gap-3">
                                            <div class="w-12 h-12 rounded-xl bg-blue-500/10 flex items-center justify-center">
                                                <i class="ph-bold ph-upload-simple text-2xl text-blue-400"></i>
                                            </div>
                                            <div class="text-center">
                                                <p class="text-sm font-bold text-white preserve-white mb-1">Carica Screenshot</p>
                                                <p class="text-xs text-[var(--text-muted)]">Clicca o trascina le immagini qui</p>
                                            </div>
                                        </div>
                                        <div id="gallery-preview" class="flex gap-3 overflow-x-auto ${ui.tempImages.length ? '' : 'hidden'} w-full"></div>
                                        <button id="clear-imgs-btn" type="button" class="absolute top-3 right-3 bg-red-500/20 text-red-400 hover:bg-red-500 hover:text-white preserve-white rounded-lg px-3 py-2 transition-all flex items-center gap-2 ${ui.tempImages.length ? '' : 'hidden'}">
                                            <i class="ph-bold ph-trash text-sm"></i>
                                            <span class="text-xs font-bold">Rimuovi</span>
                                        </button>
                                    </div>
                                </div>

                            </form>
                        </div>

                        <!-- Footer Actions -->
                        <div class="flex items-center justify-between px-8 py-5 border-t border-white/5 flex-shrink-0">
                            ${isEdit ? `<button type="button" onclick="ui.deleteTradeWrapper(event, ${t.id}); ui.closeModals()" class="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white preserve-white transition-all font-bold text-sm">
                                <i class="ph-bold ph-trash"></i>
                                Elimina
                            </button>` : '<div></div>'}
                            <div class="flex gap-3">
                                <button type="button" onclick="ui.saveTrade(true)" class="px-6 py-2.5 rounded-xl border border-white/10 text-sm font-bold text-[var(--text-muted)] hover:bg-white/5 hover:text-white preserve-white hover:border-white/20 transition-all">
                                    Salva Bozza
                                </button>
                                <button type="button" onclick="ui.saveTrade(false)" class="bg-[var(--accent-blue)] text-white preserve-white px-8 py-2.5 rounded-xl text-sm font-bold hover:opacity-90 hover:shadow-lg hover:shadow-blue-500/30 transition-all flex items-center gap-2">
                                    <i class="ph-bold ph-check"></i>
                                    Salva Trade
                                </button>
                            </div>
                        </div>

                    </div>`;

        ui.openModal('modal-trade');
        ui.setupDragDrop();
        ui.renderTempImages();
        ui.setupAudioRecordButtons();

        // Renderizza audio player se esiste audio
        if (t && t.audioNote) {
            setTimeout(() => ui.renderAudioPlayer('trade-audio-player', t.audioNote), 100);
        }
    },

    openNewTradeModal() { ui.tempImages = []; ui.renderTradeModalContent(null, false); },
    openEditTradeModal(id) { const t = DataStore.data.trades.find(x => x.id == id); if (t) ui.renderTradeModalContent(t, true); },

    toggleAllAccounts() {
        const checkboxes = document.querySelectorAll('input[name="t-accounts"]');
        const allChecked = Array.from(checkboxes).every(cb => cb.checked);
        checkboxes.forEach(cb => cb.checked = !allChecked);
    },

    togglePnlInput(show) {
        const pnlInput = document.getElementById('t-pnl');
        if (!pnlInput) return;

        if (show) {
            pnlInput.disabled = false;
            pnlInput.classList.remove('opacity-50', 'cursor-not-allowed');
        } else {
            pnlInput.value = 0;
            pnlInput.disabled = true;
            pnlInput.classList.add('opacity-50', 'cursor-not-allowed');
        }
    },
    saveTrade(isDraft) { ui.processSaveTrade(isDraft); },
    processSaveTrade(isDraft) {
        const idEl = document.getElementById('t-id');
        const isMissedEl = document.getElementById('t-missed-check');
        const audioData = document.getElementById('trade-audio-data')?.value || '';

        const id = idEl ? idEl.value : null;
        const isMissed = isMissedEl ? isMissedEl.checked : false;
        let status = 'executed';
        if (isDraft) status = 'draft';
        else if (isMissed) status = 'missed';

        const directionEl = document.querySelector('input[name="direction_radio"]:checked');
        if (!directionEl) {
            ui.showToast('⚠️ Seleziona una direzione (LONG o SHORT)');
            return;
        }

        // Get selected accounts from checkboxes
        const selectedAccountCheckboxes = document.querySelectorAll('input[name="t-accounts"]:checked');
        const selectedAccountIds = Array.from(selectedAccountCheckboxes).map(cb => cb.value);

        if (selectedAccountIds.length === 0) {
            ui.showToast('⚠️ Seleziona almeno un conto');
            return;
        }

        const asset = document.getElementById('t-asset')?.value?.trim() || '';
        const date = document.getElementById('t-date')?.value || new Date().toISOString();
        const pnlValue = document.getElementById('t-pnl')?.value || 0;
        const rr = document.getElementById('t-rr')?.value?.trim() || '';
        const session = document.getElementById('t-session')?.value || '';
        const strategy = document.getElementById('t-strategy')?.value || '';
        const notes = document.getElementById('t-notes')?.value?.trim() || '';
        const mistakes = document.getElementById('t-mistakes')?.value?.trim() || '';
        const improvements = document.getElementById('t-improvements')?.value?.trim() || '';
        const timeframe = document.getElementById('t-timeframe')?.value || '';

        if (!asset) {
            ui.showToast('⚠️ Inserisci un asset');
            return;
        }
        if (!date) {
            ui.showToast('⚠️ Inserisci una data valida');
            return;
        }

        // Validazione numerica PnL
        const pnl = parseFloat(pnlValue);
        if (isNaN(pnl)) {
            ui.showToast('⚠️ Inserisci un valore numerico valido per P&L');
            return;
        }

        // If editing an existing trade, just update it normally
        if (id && id !== '') {
            const trade = {
                id: parseInt(id, 10),
                type: 'trade',
                asset: asset,
                date: date,
                direction: directionEl.value,
                pnl: pnl,
                status: status,
                rr: rr,
                session: session,
                strategy: strategy,
                notes: notes,
                mistakes: mistakes,
                improvements: improvements,
                screenshot: '',
                images: ui.tempImages || [],
                timeframe: timeframe,
                accountId: selectedAccountIds[0], // Use first selected account for edit
                audioNote: audioData
            };
            DataStore.addTrade(trade);
        } else {
            // Creating new trade(s) - one for each selected account
            const masterTradeId = Date.now();

            selectedAccountIds.forEach((accountId, index) => {
                const trade = {
                    id: index === 0 ? masterTradeId : masterTradeId + index,
                    type: 'trade',
                    asset: asset,
                    date: date,
                    direction: directionEl.value,
                    pnl: pnl,
                    status: status,
                    rr: rr,
                    session: session,
                    strategy: strategy,
                    notes: notes,
                    mistakes: mistakes,
                    improvements: improvements,
                    screenshot: '',
                    images: ui.tempImages || [],
                    timeframe: timeframe,
                    accountId: accountId,
                    audioNote: audioData,
                    linkedTradeId: masterTradeId // Link all copies to master trade
                };
                DataStore.addTrade(trade);
            });
        }

        ui.closeModals();

        if (router.currentPage === 'dashboard') ui.dashboard();
        else if (router.currentPage === 'journal') ui.journal();
        else if (router.currentPage === 'drafts') ui.drafts();
        else if (router.currentPage === 'review') ui.review();
        else if (router.currentPage === 'system') ui.accounts();
        else if (router.currentPage === 'accounts') ui.accounts();
    },
    deleteDraftFromModal() {
        const id = document.getElementById('t-id')?.value;
        if (!id || isNaN(parseInt(id, 10))) {
            ui.showToast('⚠️ Errore: ID bozza non valido');
            return;
        }
        if (confirm('Eliminare questa bozza?')) {
            try {
                DataStore.deleteTrade(parseInt(id, 10));
                ui.closeModals();
                if (router.currentPage === 'drafts') router.drafts();
                ui.showToast('✅ Bozza eliminata con successo');
            } catch (error) {
                console.error('Errore durante l\'eliminazione della bozza:', error);
                ui.showToast('❌ Errore durante l\'eliminazione');
            }
        }
    },
    deleteTradeWrapper(e, id) {
        if (e) e.stopPropagation();
        if (!id || isNaN(parseInt(id))) {
            console.error('ID trade non valido:', id);
            ui.showToast('⚠️ Errore: ID trade non valido');
            return;
        }
        if (confirm('Eliminare questo trade? Questa azione non può essere annullata.')) {
            try {
                DataStore.deleteTrade(parseInt(id));
                if (router.currentPage === 'journal') router.journal();
                else if (router.currentPage === 'dashboard') router.dashboard();
                ui.showToast('✅ Trade eliminato con successo');
            } catch (error) {
                console.error('Errore durante l\'eliminazione del trade:', error);
                ui.showToast('❌ Errore durante l\'eliminazione');
            }
        }
    },

    // NEW HELPER: Renders the *entire* detail modal content string
    renderDetailModalContent(t) {
        const account = DataStore.data.accounts.find(a => a.id == t.accountId)?.name || 'N/D';
        const isPayout = t.type === 'payout';
        const pnlValue = parseFloat(t.pnl || 0);
        const pnlDisplay = isPayout ? `-${ui.formatCurrency(Math.abs(t.pnl))}` : ui.formatCurrency(t.pnl);
        const pnlColor = isPayout || pnlValue < 0 ? 'red' : 'green';
        const pnlColorText = isPayout || pnlValue < 0 ? 'text-red-400' : 'text-green-400';

        const date = new Date(t.date);
        const dayName = date.toLocaleDateString('it-IT', { weekday: 'long' });
        const formattedDate = date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
        const formattedTime = date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });

        const directionIcon = t.direction === 'LONG' ? 'ph-arrow-up' : t.direction === 'SHORT' ? 'ph-arrow-down' : 'ph-bank';
        const directionColor = t.direction === 'LONG' ? 'green' : t.direction === 'SHORT' ? 'red' : 'blue';
        const directionText = t.direction === 'LONG' ? 'text-green-400' : t.direction === 'SHORT' ? 'text-red-400' : 'text-blue-400';

        const imgCont = (t.images && t.images.length > 0)
            ? `<div class="mt-6">
                    <h4 class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2 mb-3">
                        <i class="ph-bold ph-image"></i>
                        Screenshot (${t.images.length})
                    </h4>
                    <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                        ${t.images.map(src => `
                            <div class="group relative aspect-video bg-black/20 rounded-xl overflow-hidden border border-white/10 hover:border-[var(--accent-blue)]/50 transition-all cursor-pointer" onclick="ui.viewFullImage('${src}')">
                                <img src="${src}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300">
                                <div class="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-colors flex items-center justify-center">
                                    <i class="ph-bold ph-magnifying-glass-plus text-white preserve-white text-2xl opacity-0 group-hover:opacity-100 transition-opacity"></i>
                                </div>
                            </div>
                        `).join('')}
                    </div>
                </div>`
            : '';

        return `
            <div id="trade-detail-card" class="relative bg-gradient-to-br from-[var(--bg-card)] to-[var(--bg-card)]/80 rounded-3xl overflow-hidden shadow-2xl transform transition-all scale-100 flex flex-col border border-white/10" style="width: 800px; max-height: 90vh;">
                
                <!-- Header con Gradient e Badge -->
                <div class="relative px-8 py-6 border-b border-white/5">
                    <div class="absolute inset-0 bg-gradient-to-r from-${directionColor}-500/10 via-${pnlColor}-500/5 to-${directionColor}-500/10 opacity-50"></div>
                    <div class="relative flex items-center justify-between">
                        <div class="flex items-center gap-4">
                            <div class="w-16 h-16 rounded-2xl bg-gradient-to-br from-${directionColor}-500/20 to-${directionColor}-500/5 border border-${directionColor}-500/30 flex items-center justify-center flex-shrink-0">
                                <i class="ph-bold ${directionIcon} text-3xl ${directionText}"></i>
                            </div>
                            <div>
                                <div class="flex items-center gap-3 mb-1">
                                    <h3 class="text-3xl font-bold text-white preserve-white">${isPayout ? 'PAYOUT' : t.asset}</h3>
                                    ${!isPayout ? `<span class="text-xs px-3 py-1 rounded-lg bg-${directionColor}-500/10 text-${directionColor}-400 font-bold uppercase border border-${directionColor}-500/30">${t.direction}</span>` : ''}
                                    ${t.status === 'missed' ? '<span class="text-xs px-3 py-1 rounded-lg bg-gray-500/20 text-gray-400 font-bold uppercase border border-gray-500/30">MISSED</span>' : ''}
                                    ${t.status === 'draft' ? '<span class="text-xs px-3 py-1 rounded-lg bg-yellow-500/20 text-yellow-400 font-bold uppercase border border-yellow-500/30">BOZZA</span>' : ''}
                                </div>
                                <p class="text-sm text-[var(--text-muted)] font-medium capitalize">${dayName}, ${formattedDate} • ${formattedTime}</p>
                            </div>
                        </div>
                        <div id="trade-detail-actions" class="flex gap-2">
                            <input type="hidden" id="d-id" value="${t.id}">
                            ${!isPayout ? `<button onclick="ui.copyTradeToOtherAccounts(${t.id})" class="w-11 h-11 rounded-xl bg-purple-500/10 hover:bg-purple-500/20 hover:text-purple-400 text-purple-400/70 flex items-center justify-center transition-all border border-purple-500/20 hover:border-purple-500/40" title="Copia su altri account">
                                <i class="ph-bold ph-copy text-lg"></i>
                            </button>` : ''}
                            ${!isPayout ? `<button onclick="ui.shareTrade(${t.id})" class="w-11 h-11 rounded-xl bg-white/5 hover:bg-green-500/20 hover:text-green-400 text-[var(--text-muted)] flex items-center justify-center transition-all border border-white/5 hover:border-green-500/30" title="Condividi Trade" id="btn-share-trade">
                                <i class="ph-bold ph-share-network text-lg"></i>
                            </button>` : ''}
                            ${!isPayout ? `<button onclick="ui.editTradeFromDetail()" class="w-11 h-11 rounded-xl bg-white/5 hover:bg-blue-500/20 hover:text-blue-400 text-[var(--text-muted)] flex items-center justify-center transition-all border border-white/5 hover:border-blue-500/30">
                                <i class="ph-bold ph-pencil-simple text-lg"></i>
                            </button>` : ''}
                            <button onclick="ui.closeModals()" class="group w-11 h-11 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all text-[var(--text-muted)] hover:text-white preserve-white border border-white/5">
                                <i class="ph-bold ph-x text-xl group-hover:rotate-90 transition-transform"></i>
                            </button>
                        </div>
                    </div>
                </div>

                <!-- Content Scrollable -->
                <div id="trade-detail-content" class="flex-1 overflow-y-auto custom-scrollbar px-8 py-6">
                    
                    <!-- P&L Card -->
                    <div class="mb-6 bg-gradient-to-br from-${pnlColor}-500/10 to-${pnlColor}-500/5 border border-${pnlColor}-500/20 rounded-2xl p-6">
                        <div class="flex items-center justify-between">
                            <div>
                                <p class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">Profit & Loss</p>
                                <p class="text-4xl font-bold font-mono ${pnlColorText}">${pnlDisplay}</p>
                            </div>
                            ${t.rr ? `<div class="text-right">
                                <p class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1">Risk:Reward</p>
                                <p class="text-3xl font-bold text-white preserve-white">${t.rr}R</p>
                            </div>` : ''}
                        </div>
                    </div>

                    ${!isPayout ? `
                    <!-- Trade Details Grid -->
                    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
                        <div class="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                            <div class="w-10 h-10 rounded-lg bg-purple-500/20 flex items-center justify-center mx-auto mb-2">
                                <i class="ph-bold ph-strategy text-xl text-purple-400"></i>
                            </div>
                            <p class="text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Strategia</p>
                            <p class="text-sm font-bold text-white preserve-white truncate">${t.strategy || '-'}</p>
                        </div>
                        <div class="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                            <div class="w-10 h-10 rounded-lg bg-orange-500/20 flex items-center justify-center mx-auto mb-2">
                                <i class="ph-bold ph-clock text-xl text-orange-400"></i>
                            </div>
                            <p class="text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Sessione</p>
                            <p class="text-sm font-bold text-white preserve-white truncate">${t.session || '-'}</p>
                        </div>
                        <div class="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                            <div class="w-10 h-10 rounded-lg bg-blue-500/20 flex items-center justify-center mx-auto mb-2">
                                <i class="ph-bold ph-chart-line text-xl text-blue-400"></i>
                            </div>
                            <p class="text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Timeframe</p>
                            <p class="text-sm font-bold text-white preserve-white">${t.timeframe || '-'}</p>
                        </div>
                        <div class="bg-white/5 border border-white/10 rounded-xl p-4 text-center">
                            <div class="w-10 h-10 rounded-lg bg-green-500/20 flex items-center justify-center mx-auto mb-2">
                                <i class="ph-bold ph-wallet text-xl text-green-400"></i>
                            </div>
                            <p class="text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Conto</p>
                            <p class="text-sm font-bold text-white preserve-white truncate">${account}</p>
                        </div>
                    </div>

                    <!-- Notes Section -->
                    ${t.notes ? `
                    <div class="mb-6">
                        <h4 class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2 mb-3">
                            <i class="ph-bold ph-notebook"></i>
                            Note Operative
                        </h4>
                        <div class="bg-white/5 border border-white/10 rounded-xl p-4">
                            <p class="text-sm text-white preserve-white leading-relaxed whitespace-pre-wrap">${t.notes}</p>
                        </div>
                    </div>
                    ` : ''}

                    <!-- Errors & Improvements -->
                    ${t.mistakes || t.improvements ? `
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
                        ${t.mistakes ? `
                        <div class="bg-gradient-to-br from-red-500/10 to-red-500/5 border border-red-500/20 rounded-xl p-4">
                            <div class="flex items-center gap-2 mb-3">
                                <div class="w-8 h-8 rounded-lg bg-red-500/20 flex items-center justify-center">
                                    <i class="ph-bold ph-warning-circle text-lg text-red-400"></i>
                                </div>
                                <h4 class="text-xs font-bold uppercase tracking-wider text-red-400">Errori Commessi</h4>
                            </div>
                            <p class="text-sm text-white preserve-white leading-relaxed whitespace-pre-wrap">${t.mistakes}</p>
                        </div>
                        ` : ''}
                        ${t.improvements ? `
                        <div class="bg-gradient-to-br from-green-500/10 to-green-500/5 border border-green-500/20 rounded-xl p-4">
                            <div class="flex items-center gap-2 mb-3">
                                <div class="w-8 h-8 rounded-lg bg-green-500/20 flex items-center justify-center">
                                    <i class="ph-bold ph-chart-line-up text-lg text-green-400"></i>
                                </div>
                                <h4 class="text-xs font-bold uppercase tracking-wider text-green-400">Miglioramenti</h4>
                            </div>
                            <p class="text-sm text-white preserve-white leading-relaxed whitespace-pre-wrap">${t.improvements}</p>
                        </div>
                        ` : ''}
                    </div>
                    ` : ''}

                    <!-- Audio Note Section -->
                    <div class="mb-6">
                        <h4 class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-2 mb-3">
                            <i class="ph-bold ph-microphone"></i>
                            Nota Vocale
                        </h4>
                        ${t.audioNote ? `
                            <div class="flex items-center gap-3 p-4 bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/30 rounded-xl">
                                <button onclick="document.getElementById('trade-detail-audio-player').play()" class="w-12 h-12 rounded-full bg-blue-500/20 hover:bg-blue-500/30 flex items-center justify-center transition-all">
                                    <i class="ph-fill ph-play text-blue-400 text-xl"></i>
                                </button>
                                <audio id="trade-detail-audio-player" src="${t.audioNote}" controls class="flex-1 h-10"></audio>
                            </div>
                        ` : `
                            <div class="text-center py-6 text-[var(--text-muted)] text-sm">
                                <i class="ph-duotone ph-microphone-slash text-3xl mb-2 opacity-50"></i>
                                <p>Nessuna nota vocale registrata</p>
                            </div>
                        `}
                    </div>
                    ` : `
                    <!-- Payout Details -->
                    <div class="bg-gradient-to-br from-red-500/10 to-red-500/5 border border-red-500/20 rounded-2xl p-6">
                        <div class="flex items-center gap-3 mb-3">
                            <div class="w-12 h-12 rounded-xl bg-red-500/20 flex items-center justify-center">
                                <i class="ph-bold ph-bank text-2xl text-red-400"></i>
                            </div>
                            <div>
                                <h4 class="text-sm font-bold uppercase tracking-wider text-red-400">Dettagli Prelievo</h4>
                                <p class="text-xs text-[var(--text-muted)] mt-0.5">Registrazione Payout</p>
                            </div>
                        </div>
                        <p class="text-sm text-white preserve-white leading-relaxed">Prelievo di <span class="font-bold text-red-400">${ui.formatCurrency(Math.abs(pnlValue))}</span> dal conto <span class="font-bold">${account}</span>.</p>
                    </div>
                    `}

                    ${imgCont}
                </div>

            </div>
        `;
    },

    showTradeDetail(id) {
        const t = DataStore.data.trades.find(x => x.id == id);
        if (!t) return;

        const modal = document.getElementById('modal-detail');
        if (!modal) return;

        modal.innerHTML = ui.renderDetailModalContent(t);
        ui.openModal('modal-detail');
    },

    // --- AUDIO RECORDING SYSTEM ---
    audioRecorder: null,
    audioChunks: [],
    audioContext: null,

    setupAudioRecordButtons() {
        console.log('🎙️ [v1.0.3] setupAudioRecordButtons called');
        const buttons = document.querySelectorAll('.audio-record-btn');
        console.log('🎙️ Found buttons:', buttons.length, buttons);

        if (buttons.length === 0) {
            console.warn('⚠️ No audio buttons found! Make sure modal is rendered.');
            return;
        }

        buttons.forEach((btn, idx) => {
            console.log(`🎙️ Setting up button ${idx}:`, {
                id: btn.id,
                dataTarget: btn.getAttribute('data-target'),
                classes: btn.className,
                parentElement: btn.parentElement?.tagName
            });

            // Rimuovi vecchi listener per evitare duplicati
            btn.onclick = null;

            // Aggiungi nuovo listener che gestisce sia start che stop
            btn.addEventListener('click', function (e) {
                console.log('🎙️ [CLICK EVENT] Button clicked!', this.id);
                e.preventDefault();
                e.stopPropagation();

                // Controlla se è in modalità recording
                const isRecording = this.getAttribute('data-recording') === 'true';
                console.log('🎙️ Current recording state:', isRecording);

                if (isRecording) {
                    console.log('🎙️ Stopping recording...');
                    ui.stopAudioRecording();
                } else {
                    const targetId = this.getAttribute('data-target');
                    console.log('🎙️ Target ID from data-target:', targetId);
                    if (targetId) {
                        console.log('🎙️ Calling startAudioRecording...');
                        ui.startAudioRecording(targetId);
                    } else {
                        console.error('❌ No target ID found!');
                    }
                }
            });
            console.log(`✅ Button ${idx} setup complete`);
        });

        console.log('✅ All audio buttons setup complete');
    },

    async startAudioRecording(targetId) {
        console.log('🎙️ [v1.0.2] startAudioRecording CALLED with targetId:', targetId);
        console.log('🎙️ Current location protocol:', window.location.protocol);
        console.log('🎙️ Navigator.mediaDevices available:', !!navigator.mediaDevices);

        // CHECK PROTOCOLLO FILE://
        if (window.location.protocol === 'file:') {
            console.error('❌ Audio recording blocked by file:// protocol');
            ui.showToast('Registrazione audio non disponibile');
            return;
        }

        console.log('✅ Protocol check passed');

        try {
            // Verifica supporto MediaRecorder
            if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
                console.error('❌ MediaDevices not supported');
                ui.showToast('Browser non supporta la registrazione audio');
                return;
            }

            ui.showToast('🎙️ Richiesta accesso microfono...');

            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            console.log('✅ Microphone access granted');

            // Verifica supporto MediaRecorder
            if (!window.MediaRecorder) {
                console.error('❌ MediaRecorder not supported');
                ui.showToast('MediaRecorder non supportato');
                stream.getTracks().forEach(track => track.stop());
                return;
            }

            // Rileva il formato audio supportato dal browser
            let mimeType = 'audio/webm';
            if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
                mimeType = 'audio/webm;codecs=opus';
            } else if (MediaRecorder.isTypeSupported('audio/webm')) {
                mimeType = 'audio/webm';
            } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
                mimeType = 'audio/mp4';
            } else if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) {
                mimeType = 'audio/ogg;codecs=opus';
            } else if (MediaRecorder.isTypeSupported('audio/wav')) {
                mimeType = 'audio/wav';
            } else {
                console.error('❌ No supported audio format found');
                ui.showToast('Browser non supporta formati audio compatibili');
                stream.getTracks().forEach(track => track.stop());
                return;
            }

            console.log('🎙️ Using MIME type:', mimeType);

            ui.audioRecorder = new MediaRecorder(stream, { mimeType });
            ui.audioChunks = [];
            ui.audioRecorder.mimeType = mimeType; // Salva per dopo

            ui.audioRecorder.ondataavailable = (e) => {
                if (e.data.size > 0) ui.audioChunks.push(e.data);
            };

            ui.audioRecorder.onstop = () => {
                const audioBlob = new Blob(ui.audioChunks, { type: mimeType });
                const reader = new FileReader();
                reader.onloadend = () => {
                    const base64 = reader.result;
                    // Salva nel campo nascosto
                    const hiddenInput = document.getElementById(targetId);
                    if (hiddenInput) hiddenInput.value = base64;
                    ui.showToast('✅ Nota vocale salvata');
                    // Mostra player
                    ui.renderAudioPlayer(targetId.replace('-data', '-player'), base64);
                    // Ripristina UI pulsante
                    ui.updateRecordingUI(targetId.replace('-data', '-btn'), false);
                };
                reader.readAsDataURL(audioBlob);
                stream.getTracks().forEach(track => track.stop());
            };

            ui.audioRecorder.start();
            ui.updateRecordingUI(targetId.replace('-data', '-btn'), true);
            ui.showToast('🎙️ Registrazione in corso...');
        } catch (err) {
            console.error('Errore registrazione:', err);

            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                const msg = 'Permesso microfono negato o non concesso.';
                ui.showToast('❌ ' + msg);
                alert("⚠️ Errore Permessi Microfono:\n\nIl browser non ha accesso al microfono.\n\n1. Controlla che nella barra degli indirizzi non ci sia l'icona del microfono sbarrata.\n2. Se sei su macOS, vai in Impostazioni di Sistema -> Privacy e Sicurezza -> Microfono e abilita il browser.");
            } else if (err.name === 'NotFoundError') {
                ui.showToast('❌ Microfono non trovato');
            } else {
                ui.showToast('❌ Errore: ' + err.message);
            }
        }
    },

    stopAudioRecording() {
        if (ui.audioRecorder && ui.audioRecorder.state !== 'inactive') {
            ui.audioRecorder.stop();
        }
    },

    updateRecordingUI(btnId, isRecording) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        if (isRecording) {
            btn.innerHTML = '<i class="ph-fill ph-stop-circle text-xl text-red-500 animate-pulse"></i><span class="text-xs font-bold">Stop</span>';
            btn.classList.add('bg-red-500/20', 'border-red-500/50');
            btn.setAttribute('data-recording', 'true');
        } else {
            btn.innerHTML = '<i class="ph-bold ph-microphone text-xl"></i><span class="text-xs font-bold">Registra</span>';
            btn.classList.remove('bg-red-500/20', 'border-red-500/50');
            btn.setAttribute('data-recording', 'false');
        }
    },

    renderAudioPlayer(containerId, audioData) {
        const container = document.getElementById(containerId);
        if (!container || !audioData) return;

        const playerId = `audio-player-${containerId}`;
        const playBtnId = `play-btn-${containerId}`;

        container.innerHTML = `
            <div class="flex items-center gap-3 p-3 bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/30 rounded-xl">
                <button type="button" id="${playBtnId}" class="w-10 h-10 rounded-full bg-blue-500/20 hover:bg-blue-500/30 flex items-center justify-center transition-all">
                    <i class="ph-fill ph-play text-blue-400"></i>
                </button>
                <div class="flex-1">
                    <audio id="${playerId}" src="${audioData}" class="w-full h-8"></audio>
                </div>
                <button type="button" onclick="document.getElementById('${containerId.replace('-player', '-data')}').value=''; document.getElementById('${containerId}').innerHTML=''; ui.showToast('🗑️ Audio eliminato');" class="w-8 h-8 rounded-full hover:bg-red-500/20 flex items-center justify-center text-red-400 transition-all">
                    <i class="ph-bold ph-trash text-sm"></i>
                </button>
            </div>
        `;

        // Setup play/pause toggle
        setTimeout(() => {
            const audioEl = document.getElementById(playerId);
            const playBtn = document.getElementById(playBtnId);

            if (!audioEl || !playBtn) return;

            playBtn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();

                if (audioEl.paused) {
                    audioEl.play();
                    playBtn.innerHTML = '<i class="ph-fill ph-pause text-blue-400"></i>';
                } else {
                    audioEl.pause();
                    playBtn.innerHTML = '<i class="ph-fill ph-play text-blue-400"></i>';
                }
            };

            // Reset icon when audio ends
            audioEl.onended = () => {
                playBtn.innerHTML = '<i class="ph-fill ph-play text-blue-400"></i>';
            };
        }, 50);
    },

    viewFullImage(src) {
        let modal = document.getElementById('dynamic-image-modal');
        if (!modal) {
            modal = document.createElement('div'); modal.id = 'dynamic-image-modal'; modal.className = 'fixed inset-0 z-[1305] flex items-center justify-center bg-black/90 backdrop-blur-md opacity-0 transition-opacity duration-200 hidden';
            modal.onclick = (e) => {
                if (e.target === modal || e.target.closest('.close-btn')) {
                    modal.classList.add('opacity-0');
                    requestAnimationFrame(() => modal.classList.add('hidden'));

                    const overlay = document.getElementById('modal-overlay');
                    const overlayStillOpen = overlay && !overlay.classList.contains('hidden');
                    if (overlayStillOpen) {
                        ui.setBackgroundInteractivity(true, ['modal-overlay']);
                    } else {
                        ui.setBackgroundInteractivity(false);
                    }
                }
            };
            modal.innerHTML = `<div class="relative max-w-[95vw] max-h-[95vh] flex flex-col items-center"><img id="dynamic-full-image" src="" class="max-w-full max-h-[85vh] rounded-2xl shadow-2xl object-contain"><button class="close-btn mt-4 bg-white/10 hover:bg-white/20 text-white preserve-white rounded-full p-3 transition-colors"><i class="ph-bold ph-x text-2xl"></i></button></div>`;
            document.body.appendChild(modal);
        }
        const img = modal.querySelector('#dynamic-full-image'); img.src = src; modal.classList.remove('hidden'); void modal.offsetWidth; modal.classList.remove('opacity-0');
        ui.setBackgroundInteractivity(true, ['dynamic-image-modal']);
    },
    editTradeFromDetail() {
        const id = document.getElementById('d-id').value;
        document.querySelectorAll('.modal-clean').forEach(m => m.classList.add('hidden'));
        ui.openEditTradeModal(id);
    },

    async shareTrade(tradeId) {
        const trade = DataStore.data.trades.find(t => t.id == tradeId);
        if (!trade) {
            ui.showToast('⚠️ Trade non trovato');
            return;
        }

        // Recuperiamo info
        const isPayout = trade.type === 'payout';
        const pnlValue = parseFloat(trade.pnl || 0);
        const isWin = pnlValue >= 0;
        
        const bgColorClass = isPayout ? 'from-red-600 to-red-900' : (isWin ? 'from-green-600 to-green-900' : 'from-red-600 to-red-900');
        const iconClass = isPayout ? 'ph-bank' : (trade.direction === 'LONG' ? 'ph-arrow-up' : 'ph-arrow-down');
        
        let shareModal = document.getElementById('modal-share');
        if (!shareModal) {
            shareModal = document.createElement('div');
            shareModal.id = 'modal-share';
            shareModal.className = 'fixed inset-0 z-[110] hidden flex items-center justify-center overflow-y-auto p-4 bg-black/80 backdrop-blur-sm transition-all duration-300 opacity-0 pointer-events-none';
            document.body.appendChild(shareModal);
        }

        const date = new Date(trade.date);
        const formattedDate = date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
        
        // Detect Light Mode
        const isLightMode = document.documentElement.getAttribute('data-theme') === 'light';

        // Colors & Textures Configuration
        const colors = isLightMode ? {
            bg: 'bg-white',
            textMain: 'text-zinc-900',
            textMuted: 'text-zinc-500',
            border: 'border-white/40',
            glow: '',
            patternOpacity: 'opacity-40',
            gradient: isWin ? 'bg-emerald-50' : 'bg-rose-50',
            pnlText: isWin ? 'text-emerald-600' : 'text-rose-600',
            statsBg: 'bg-white/60',
            statsBorder: 'border-white/50',
            headerBg: 'bg-white/60',
            headerBorder: 'border-white/50',
            buttonBg: 'bg-white/80',
            logoBg: 'bg-gradient-to-br from-blue-500 to-indigo-600',
            logoIcon: 'text-white'
        } : {
            bg: 'bg-[#09090b]',
            textMain: 'text-white',
            textMuted: 'text-white/40',
            border: 'border-white/10',
            glow: 'bg-[radial-gradient(circle_at_50%_0%,_rgba(59,130,246,0.15),transparent_70%)]',
            patternOpacity: 'opacity-50',
            gradient: '',
            pnlText: isWin ? 'text-emerald-400' : 'text-rose-400',
            statsBg: 'bg-white/5',
            statsBorder: 'border-white/10',
            headerBg: 'bg-white/5',
            headerBorder: 'border-white/5',
            buttonBg: 'bg-white/5',
            logoBg: 'bg-gradient-to-br from-blue-600 to-indigo-600',
            logoIcon: 'text-white'
        };

        const cardHtml = `
            <div id="share-card-content" class="relative w-[380px] h-[480px] overflow-hidden ${colors.bg} flex flex-col p-8 ${colors.textMain} scale-100 origin-center font-sans select-none">
                
                ${!isLightMode ? `
                <!-- Background ambient glow (Dark Only) -->
                <div class="absolute inset-0 ${colors.glow} z-0"></div>
                <div class="absolute bottom-[-20%] right-[-20%] w-[80%] h-[80%] blur-[100px] rounded-full pointer-events-none ${isPayout ? 'bg-zinc-500/10' : (isWin ? 'bg-emerald-500/10' : 'bg-rose-500/10')} z-0"></div>
                ` : `
                <!-- Background Gradient (Light Only) -->
                <div class="absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,_rgba(59,130,246,0.15),transparent_50%)] z-0"></div>
                <div class="absolute inset-0 bg-[radial-gradient(circle_at_100%_100%,_${isPayout ? 'rgba(113,113,122,0.15)' : (isWin ? 'rgba(16,185,129,0.15)' : 'rgba(244,63,94,0.15)')},transparent_50%)] z-0"></div>
                <!-- Stronger mesh gradient base -->
                <div class="absolute inset-0 bg-gradient-to-br from-slate-50 via-white to-slate-50 opacity-80 z-[-1]"></div>
                `}
                
                <!-- Decorative Grid/Pattern -->
                <div class="absolute inset-0 bg-[linear-gradient(${isLightMode ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.02)'}_1px,transparent_1px),linear-gradient(90deg,${isLightMode ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.02)'}_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_100%)] z-0 ${colors.patternOpacity}"></div>

                <div class="relative z-10 flex flex-col h-full justify-between">
                    <!-- Header -->
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-3">
                             <div class="w-10 h-10 rounded-2xl ${colors.logoBg} flex items-center justify-center shadow-lg shadow-blue-500/20 shrink-0 border ${colors.border}">
                                <i class="ph-bold ph-chart-polar ${colors.logoIcon} text-lg"></i>
                            </div>
                            <div class="flex flex-col leading-none">
                                <span class="font-bold text-lg tracking-tight ${colors.textMain}">EazyTrader</span>
                                <span class="text-[10px] font-medium ${colors.textMuted} uppercase tracking-widest mt-0.5">${trade.asset || 'Trade'}</span>
                            </div>
                        </div>
                        <div class="px-3 py-1.5 rounded-full ${colors.headerBg} border ${colors.headerBorder} text-[10px] font-bold ${isLightMode ? 'text-zinc-500' : 'text-white/50'} uppercase tracking-widest backdrop-blur-md">
                            ${formattedDate}
                        </div>
                    </div>

                    <!-- Main Content -->
                    <div class="flex flex-col items-center justify-center text-center -mt-4">
                        <div class="flex items-center justify-center gap-2 mb-4">
                            <div class="text-[11px] font-bold uppercase tracking-[0.2em] ${colors.textMuted} border ${colors.border} px-3 py-1.5 rounded-full ${colors.headerBg} backdrop-blur-sm shadow-sm flex items-center gap-2">
                                <i class="ph-bold ${iconClass}"></i>
                                <span>${isPayout ? 'Prelievo' : (trade.direction || 'Trade')}</span>
                            </div>
                        </div>
                        
                        <div class="relative">
                            <div class="text-[64px] leading-none font-black tracking-tighter ${isPayout ? colors.textMain : colors.pnlText} drop-shadow-2xl">
                                ${isPayout ? '-' : (isWin ? '+' : '')}${ui.formatCurrency(Math.abs(pnlValue))}
                            </div>
                             <!-- Glow behind text -->
                            <div class="absolute inset-0 blur-3xl ${isPayout ? (isLightMode ? 'bg-zinc-200/50' : 'bg-white/10') : (isWin ? 'bg-emerald-500/20' : 'bg-rose-500/20')} -z-10 scale-150 opacity-40"></div>
                        </div>
                        
                        ${!isPayout ? `
                        <div class="mt-8 flex gap-2">
                            <span class="px-2 py-1 rounded ${colors.buttonBg} border ${colors.border} text-[10px] ${colors.textMuted} font-mono">RR: ${trade.rr ? trade.rr : '-'}</span>
                             ${trade.setup ? `<span class="px-2 py-1 rounded ${colors.buttonBg} border ${colors.border} text-[10px] ${colors.textMuted} font-mono uppercase truncate max-w-[120px]">${trade.setup}</span>` : ''}
                        </div>
                        ` : ''}
                    </div>

                    <!-- Footer Info (Optional for Trade) -->
                     <div class="${colors.statsBg} backdrop-blur-xl border ${colors.statsBorder} rounded-3xl p-1 flex items-stretch shadow-xl ${isLightMode ? 'shadow-zinc-200/50' : 'shadow-black/20'}">
                        <div class="flex-1 flex flex-col items-center justify-center py-4 px-2 border-r ${colors.border} ${isLightMode ? 'bg-white/50' : 'bg-gradient-to-br from-white/5 to-transparent'} rounded-l-[20px]">
                            <span class="text-[10px] ${colors.textMuted} uppercase tracking-widest font-bold mb-1">Session</span>
                            <span class="text-xl ${colors.textMain} font-bold tracking-tight truncate w-full text-center uppercase">${trade.session || '-'}</span>
                        </div>
                        <div class="flex-1 flex flex-col items-center justify-center py-4 px-2 ${isLightMode ? 'bg-white/50' : 'bg-gradient-to-bl from-white/5 to-transparent'} rounded-r-[20px]">
                             <span class="text-[10px] ${colors.textMuted} uppercase tracking-widest font-bold mb-1">Timeframe</span>
                            <div class="flex items-center gap-2">
                                <span class="text-xl ${colors.textMain} font-bold tracking-tight uppercase">${trade.timeframe || '-'}</span>
                                <div class="w-2 h-2 rounded-full ${isPayout ? (isLightMode ? 'bg-zinc-400' : 'bg-white') : (isWin ? 'bg-emerald-500' : 'bg-rose-500')} animate-pulse"></div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const cardViewport = ui._shareCardViewport();

        shareModal.innerHTML = `
            <div class="flex flex-col items-center gap-4 max-w-[95vw]">
                <!-- Container della card, viene scalato per lo schermo ma renderizzato nativamente a dimensione fissa -->
                <div class="relative p-2 bg-[var(--bg-card)] rounded-[32px] border border-[var(--glass-border)] shadow-2xl flex flex-col gap-4 items-center">
                    <div class="rounded-[24px] overflow-hidden shadow-2xl" style="width: ${cardViewport.width}px; height: ${cardViewport.height}px;">
                        <div id="share-card-container" style="width: 380px; height: 480px; transform: scale(${cardViewport.scale}); transform-origin: top left; background: ${isLightMode ? '#ffffff' : '#09090b'};">
                            ${cardHtml}
                        </div>
                    </div>

                    <div class="flex gap-4 w-full px-4 pb-2">
                        <button onclick="ui.downloadShareCard(this)" class="flex-1 py-4 bg-[var(--input-bg)] hover:bg-[var(--accent-blue)]/20 text-[var(--accent-blue)] border border-[var(--glass-border)] hover:border-[var(--accent-blue)]/50 rounded-2xl font-bold flex flex-col items-center gap-2 transition-all">
                            <i class="ph-bold ph-download-simple text-2xl"></i>
                            <span>Salva</span>
                        </button>
                        <button onclick="ui.nativeShareCard(this)" class="flex-1 py-4 bg-[var(--accent-blue)] text-white preserve-white shadow-[0_0_20px_rgba(0,122,255,0.3)] border border-white/10 rounded-2xl font-bold flex flex-col items-center gap-2 transition-all hover:-translate-y-1">
                            <i class="ph-bold ph-share-network text-2xl"></i>
                            <span>Condividi</span>
                        </button>
                    </div>
                </div>
                <button onclick="ui.closeShareModal()" class="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white preserve-white flex items-center justify-center transition-colors">
                    <i class="ph-bold ph-x"></i>
                </button>
            </div>

        `;

        // Blocca interazioni del background mentre il popup share è aperto
        ui.setBackgroundInteractivity(true, ['modal-share']);

        shareModal.classList.remove('hidden');
        // Trigger reflow
        void shareModal.offsetWidth;
        shareModal.classList.add('opacity-100', 'pointer-events-auto');

        // Chiudi cliccando sull'overlay
        shareModal.onclick = (e) => {
            if (e.target === shareModal) {
                ui.closeShareModal();
            }
        };

        // QR code rimosso
    },

    // La card è disegnata a 380x480 px fissi: su schermi stretti va rimpicciolita.
    // Il fattore si calcola qui in JS, perché il CSS da solo non sa leggere la
    // larghezza della finestra dentro una scale().
    _shareCardViewport() {
        const scale = Math.min(1, (window.innerWidth - 48) / 380);
        return {
            scale,
            width: Math.round(380 * scale),
            height: Math.round(480 * scale)
        };
    },

    // Opzioni di esportazione: 3x (1140x1440) per alta risoluzione.
    _shareCardExportOptions() {
        const scale = 3;
        return {
            quality: 1.0,
            width: 380 * scale,
            height: 480 * scale,
            style: {
                transform: `scale(${scale})`,
                transformOrigin: 'top left',
                width: '380px',
                height: '480px'
            }
        };
    },

    _saveShareCardBlob(blob) {
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.download = `EazyTrader_Trade_${new Date().getTime()}.png`;
        link.href = url;
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    },

    async downloadShareCard(button) {
        if (typeof domtoimage === 'undefined') {
            ui.showToast('⚠️ Errore: dom-to-image non caricato');
            return;
        }

        const card = document.getElementById('share-card-content');
        if (!card) return;

        const btn = button || document.activeElement;
        const originalContent = btn ? btn.innerHTML : '';
        if (btn) btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin text-2xl"></i><span>Elaborazione...</span>';

        // Piccolo delay per assicurarsi che tutto sia renderizzato
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            // Usa dom-to-image per una fedeltà assoluta (supporta meglio CSS moderni)
            const dataUrl = await domtoimage.toPng(card, ui._shareCardExportOptions());

            const link = document.createElement('a');
            link.download = `EazyTrader_Trade_${new Date().getTime()}.png`;
            link.href = dataUrl;
            link.click();

            ui.showToast('✅ Immagine salvata!');
        } catch (e) {
            console.error(e);
            ui.showToast('❌ Errore durante la creazione dell\'immagine');
        } finally {
            if (btn) btn.innerHTML = originalContent;
        }
    },

    async nativeShareCard(button) {
        if (typeof domtoimage === 'undefined') {
            ui.showToast('⚠️ Errore: dom-to-image non caricato');
            return;
        }

        const card = document.getElementById('share-card-content');
        if (!card) return;

        const btn = button || document.activeElement;
        const originalContent = btn ? btn.innerHTML : '';
        if (btn) btn.innerHTML = '<i class="ph-bold ph-spinner animate-spin text-2xl"></i><span>Elaborazione...</span>';

        // Piccolo delay per assicurarsi che tutto sia renderizzato
        await new Promise(resolve => setTimeout(resolve, 100));

        try {
            const blob = await domtoimage.toBlob(card, ui._shareCardExportOptions());

            if (!blob) {
                ui.showToast('❌ Errore nella generazione dell\'immagine');
                return;
            }

            const file = new File([blob], `EazyTrader_Trade.png`, { type: 'image/png' });

            if (navigator.canShare && navigator.canShare({ files: [file] })) {
                try {
                    await navigator.share({
                        files: [file],
                        title: 'Il mio trade su EazyTrader!',
                        text: 'Guarda questo trade su EazyTrader 🚀'
                    });
                    ui.showToast('✅ Condiviso con successo!');
                } catch (err) {
                    console.error('Errore share nativo:', err);
                    // Se l'utente annulla, non mostrare errore
                    if (err.name !== 'AbortError') {
                        // Riusiamo l'immagine già generata invece di rigenerarla:
                        // così il pulsante non resta bloccato su "Elaborazione...".
                        ui._saveShareCardBlob(blob);
                    }
                }
            } else {
                // Fallback se web share non è supportato
                ui._saveShareCardBlob(blob);
                ui.showToast('ℹ️ Condivisione nativa non supportata, immagine scaricata.');
            }
        } catch (e) {
            console.error(e);
            ui.showToast('❌ Errore durante la creazione dell\'immagine');
        } finally {
            // Ripristina sempre il pulsante, qualunque strada abbia preso il flusso.
            if (btn) btn.innerHTML = originalContent;
        }
    },

    closeShareModal() {
        const shareModal = document.getElementById('modal-share');
        if (shareModal) {
            shareModal.classList.remove('opacity-100', 'pointer-events-auto');
            setTimeout(() => {
                shareModal.classList.add('hidden');
            }, 300);
        }

        const overlay = document.getElementById('modal-overlay');
        const overlayStillOpen = overlay && !overlay.classList.contains('hidden');
        if (overlayStillOpen) {
            ui.setBackgroundInteractivity(true, ['modal-overlay']);
        } else {
            ui.setBackgroundInteractivity(false);
        }
    },

    async shareDashboard(pnl, winRate, totalEquity) {
        const isWin = pnl >= 0;
        // Detect Light Mode
        const isLightMode = document.documentElement.getAttribute('data-theme') === 'light';

        let shareModal = document.getElementById('modal-share');
        if (!shareModal) {
            shareModal = document.createElement('div');
            shareModal.id = 'modal-share';
            shareModal.className = 'fixed inset-0 z-[110] hidden flex items-center justify-center overflow-y-auto p-4 bg-black/80 backdrop-blur-sm transition-all duration-300 opacity-0 pointer-events-none';
            document.body.appendChild(shareModal);
        }

        const date = new Date();
        const formattedDate = date.toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' });
        
        const accountText = ui.dashboardFilter === 'all' ? 'Tutti gli account' : (DataStore.data.accounts.find(a => a.id == ui.dashboardFilter)?.name || 'Account');

        // Colors & Textures Configuration
        const colors = isLightMode ? {
            bg: 'bg-white',
            textMain: 'text-zinc-900',
            textMuted: 'text-zinc-500',
            border: 'border-white/40',
            glow: '',
            patternOpacity: 'opacity-40',
            gradient: isWin ? 'bg-emerald-50' : 'bg-rose-50',
            pnlText: isWin ? 'text-emerald-600' : 'text-rose-600',
            statsBg: 'bg-white/60',
            statsBorder: 'border-white/50',
            headerBg: 'bg-white/60',
            headerBorder: 'border-white/50',
            buttonBg: 'bg-white/80',
            logoBg: 'bg-gradient-to-br from-blue-500 to-indigo-600',
            logoIcon: 'text-white'
        } : {
            bg: 'bg-[#09090b]',
            textMain: 'text-white',
            textMuted: 'text-white/40',
            border: 'border-white/10',
            glow: 'bg-[radial-gradient(circle_at_50%_0%,_rgba(59,130,246,0.15),transparent_70%)]',
            patternOpacity: 'opacity-50',
            gradient: '',
            pnlText: isWin ? 'text-emerald-400' : 'text-rose-400',
            statsBg: 'bg-white/5',
            statsBorder: 'border-white/10',
            headerBg: 'bg-white/5',
            headerBorder: 'border-white/5',
            buttonBg: 'bg-white/5',
            logoBg: 'bg-gradient-to-br from-blue-600 to-indigo-600',
            logoIcon: 'text-white'
        };

        // Creiamo la card HTML
        const cardHtml = `
            <div id="share-card-content" class="relative w-[380px] h-[480px] overflow-hidden ${colors.bg} flex flex-col p-8 ${colors.textMain} scale-100 origin-center font-sans select-none">
                
                ${!isLightMode ? `
                <!-- Background ambient glow (Dark Only) -->
                <div class="absolute inset-0 ${colors.glow} z-0"></div>
                <div class="absolute bottom-[-20%] right-[-20%] w-[80%] h-[80%] blur-[100px] rounded-full pointer-events-none ${isWin ? 'bg-emerald-500/10' : 'bg-rose-500/10'} z-0"></div>
                ` : `
                <!-- Background Gradient (Light Only) -->
                <div class="absolute inset-0 bg-[radial-gradient(circle_at_0%_0%,_rgba(59,130,246,0.15),transparent_50%)] z-0"></div>
                <div class="absolute inset-0 bg-[radial-gradient(circle_at_100%_100%,_${isWin ? 'rgba(16,185,129,0.15)' : 'rgba(244,63,94,0.15)'},transparent_50%)] z-0"></div>
                <!-- Stronger mesh gradient base -->
                <div class="absolute inset-0 bg-gradient-to-br from-slate-50 via-white to-slate-50 opacity-80 z-[-1]"></div>
                `}
                
                <!-- Decorative Grid/Pattern -->
                <div class="absolute inset-0 bg-[linear-gradient(${isLightMode ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.02)'}_1px,transparent_1px),linear-gradient(90deg,${isLightMode ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.02)'}_1px,transparent_1px)] bg-[size:40px_40px] [mask-image:radial-gradient(ellipse_at_center,black_40%,transparent_100%)] z-0 ${colors.patternOpacity}"></div>

                <div class="relative z-10 flex flex-col h-full justify-between">
                    <!-- Header -->
                    <div class="flex items-center justify-between">
                        <div class="flex items-center gap-3">
                             <div class="w-10 h-10 rounded-2xl ${colors.logoBg} flex items-center justify-center shadow-lg shadow-blue-500/20 shrink-0 border ${colors.border}">
                                <i class="ph-bold ph-chart-polar ${colors.logoIcon} text-lg"></i>
                            </div>
                            <div class="flex flex-col leading-none">
                                <span class="font-bold text-lg tracking-tight ${colors.textMain}">EazyTrader</span>
                                <span class="text-[10px] font-medium ${colors.textMuted} uppercase tracking-widest mt-0.5">Journal</span>
                            </div>
                        </div>
                        <div class="px-3 py-1.5 rounded-full ${colors.headerBg} border ${colors.headerBorder} text-[10px] font-bold ${isLightMode ? 'text-zinc-500' : 'text-white/50'} uppercase tracking-widest backdrop-blur-md">
                            ${formattedDate}
                        </div>
                    </div>

                    <!-- Main Content -->
                    <div class="flex flex-col items-center justify-center text-center -mt-4">
                        <div class="text-[11px] font-bold uppercase tracking-[0.2em] ${colors.textMuted} mb-4 border ${colors.border} px-3 py-1.5 rounded-full ${colors.headerBg} backdrop-blur-sm shadow-sm">Net P&L</div>
                        
                        <div class="relative">
                            <div class="text-[52px] leading-none font-black tracking-tighter ${colors.pnlText} drop-shadow-2xl">
                                ${isWin ? '+' : ''}${ui.formatCurrency(pnl)}
                            </div>
                             <!-- Glow behind text -->
                            <div class="absolute inset-0 blur-3xl ${isWin ? 'bg-emerald-500/20' : 'bg-rose-500/20'} -z-10 scale-150 opacity-40"></div>
                        </div>
                        
                        <div class="mt-8 text-center ${colors.textMuted} text-[10px] font-medium tracking-widest uppercase truncate max-w-[200px]">
                           ${accountText}
                        </div>
                    </div>

                    <!-- Footer Stats -->
                    <div class="${colors.statsBg} backdrop-blur-xl border ${colors.statsBorder} rounded-3xl p-1 flex items-stretch shadow-xl ${isLightMode ? 'shadow-zinc-200/50' : 'shadow-black/20'}">
                        <div class="flex-1 flex flex-col items-center justify-center py-4 px-2 border-r ${colors.border} ${isLightMode ? 'bg-white/50' : 'bg-gradient-to-br from-white/5 to-transparent'} rounded-l-[20px]">
                            <span class="text-[10px] ${colors.textMuted} uppercase tracking-widest font-bold mb-1">Win Rate</span>
                            <span class="text-2xl ${colors.textMain} font-bold tracking-tight">${winRate.toFixed(1)}<span class="text-sm align-top ${colors.textMuted} ml-0.5">%</span></span>
                        </div>
                        <div class="flex-1 flex flex-col items-center justify-center py-4 px-2 ${isLightMode ? 'bg-white/50' : 'bg-gradient-to-bl from-white/5 to-transparent'} rounded-r-[20px]">
                             <span class="text-[10px] ${colors.textMuted} uppercase tracking-widest font-bold mb-1">Balance</span>
                            <span class="text-2xl ${colors.textMain} font-bold tracking-tight truncate w-full text-center">${ui.formatCurrency(totalEquity)}</span>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const cardViewport = ui._shareCardViewport();

        shareModal.innerHTML = `
            <div class="flex flex-col items-center gap-4 max-w-[95vw]">
                <div class="relative p-2 bg-[var(--bg-card)] rounded-[32px] border border-[var(--glass-border)] shadow-2xl flex flex-col gap-4 items-center">
                    <div class="rounded-[24px] overflow-hidden shadow-2xl" style="width: ${cardViewport.width}px; height: ${cardViewport.height}px;">
                        <div id="share-card-container" style="width: 380px; height: 480px; transform: scale(${cardViewport.scale}); transform-origin: top left; background: ${isLightMode ? '#ffffff' : '#09090b'};">
                            ${cardHtml}
                        </div>
                    </div>

                    <div class="flex gap-4 w-full px-4 pb-2">
                        <button onclick="ui.downloadShareCard(this)" class="flex-1 py-4 bg-[var(--input-bg)] hover:bg-[var(--accent-blue)]/20 text-[var(--accent-blue)] border border-[var(--glass-border)] hover:border-[var(--accent-blue)]/50 rounded-2xl font-bold flex flex-col items-center gap-2 transition-all">
                            <i class="ph-bold ph-download-simple text-2xl"></i>
                            <span>Salva</span>
                        </button>
                        <button onclick="ui.nativeShareCard(this)" class="flex-1 py-4 bg-[var(--accent-blue)] text-white preserve-white shadow-[0_0_20px_rgba(0,122,255,0.3)] border border-white/10 rounded-2xl font-bold flex flex-col items-center gap-2 transition-all hover:-translate-y-1">
                            <i class="ph-bold ph-share-network text-2xl"></i>
                            <span>Condividi</span>
                        </button>
                    </div>
                </div>
                <button onclick="ui.closeShareModal()" class="w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white preserve-white flex items-center justify-center transition-colors">
                    <i class="ph-bold ph-x"></i>
                </button>
            </div>

        `;

        // Blocca interazioni del background mentre il popup share è aperto
        ui.setBackgroundInteractivity(true, ['modal-share']);

        shareModal.classList.remove('hidden');
        // Trigger reflow
        void shareModal.offsetWidth;
        shareModal.classList.add('opacity-100', 'pointer-events-auto');

        // Chiudi cliccando sull'overlay
        shareModal.onclick = (e) => {
            if (e.target === shareModal) {
                ui.closeShareModal();
            }
        };

        // QR code rimosso
    },

    copyTradeToOtherAccounts(tradeId) {
        const trade = DataStore.data.trades.find(t => t.id == tradeId);
        if (!trade) {
            ui.showToast('⚠️ Trade non trovato');
            return;
        }

        // Filter out the current account
        const otherAccounts = DataStore.data.accounts.filter(a => a.id != trade.accountId);

        if (otherAccounts.length === 0) {
            ui.showToast('ℹ️ Nessun altro account disponibile');
            return;
        }

        // Create account selector modal
        const modalContent = `
            <div class="bg-[var(--bg-card)] rounded-3xl border border-white/10 shadow-2xl w-full max-w-md p-6">
                <div class="mb-4">
                    <h3 class="text-xl font-bold text-white preserve-white mb-2">Copia su Altri Account</h3>
                    <p class="text-sm text-[var(--text-muted)]">Seleziona gli account su cui copiare questo trade</p>
                </div>
                
                <div class="space-y-2 mb-6 max-h-64 overflow-y-auto custom-scrollbar">
                    ${otherAccounts.map(a => `
                        <label class="flex items-center gap-3 p-3 rounded-xl hover:bg-white/5 cursor-pointer transition-all group border border-white/5 hover:border-blue-500/30">
                            <input type="checkbox" name="copy-to-account" value="${a.id}" class="w-5 h-5 rounded bg-white/10 border-white/20 text-blue-500 focus:ring-2 focus:ring-blue-500/50 cursor-pointer">
                            <div class="flex-1">
                                <p class="text-sm font-bold text-white preserve-white group-hover:text-blue-400 transition-colors">${a.name}</p>
                                <p class="text-xs text-[var(--text-muted)]">${a.type || 'N/D'} • ${ui.formatCurrency(a.balance || 0)}</p>
                            </div>
                        </label>
                    `).join('')}
                </div>

                <div class="flex items-center gap-3">
                    <button onclick="ui.closeModals()" class="flex-1 px-4 py-2.5 rounded-xl border border-white/10 text-sm font-bold text-[var(--text-muted)] hover:bg-white/5 hover:text-white preserve-white transition-all">
                        Annulla
                    </button>
                    <button onclick="ui.confirmCopyTrade(${tradeId})" class="flex-1 bg-purple-500 text-white preserve-white px-4 py-2.5 rounded-xl text-sm font-bold hover:bg-purple-600 transition-all flex items-center justify-center gap-2">
                        <i class="ph-bold ph-copy"></i>
                        Copia Trade
                    </button>
                </div>
            </div>
        `;

        const modal = document.getElementById('modal-generic');
        if (modal) {
            modal.innerHTML = modalContent;
            ui.openModal('modal-generic');
        }
    },

    confirmCopyTrade(tradeId) {
        const selectedAccountCheckboxes = document.querySelectorAll('input[name="copy-to-account"]:checked');
        const selectedAccountIds = Array.from(selectedAccountCheckboxes).map(cb => cb.value);

        if (selectedAccountIds.length === 0) {
            ui.showToast('⚠️ Seleziona almeno un account');
            return;
        }

        const originalTrade = DataStore.data.trades.find(t => t.id == tradeId);
        if (!originalTrade) {
            ui.showToast('⚠️ Trade non trovato');
            return;
        }

        // Create copies for each selected account
        const masterTradeId = Date.now();
        selectedAccountIds.forEach((accountId, index) => {
            const newTrade = {
                ...originalTrade,
                id: masterTradeId + index,
                accountId: accountId,
                linkedTradeId: originalTrade.linkedTradeId || originalTrade.id,
                lastModified: Date.now()
            };
            DataStore.addTrade(newTrade);
        });

        ui.closeModals();
        ui.showToast(`✅ Trade copiato su ${selectedAccountIds.length} account`);

        // Refresh current page
        if (router.currentPage === 'dashboard') ui.dashboard();
        else if (router.currentPage === 'journal') ui.journal();
        else if (router.currentPage === 'accounts') ui.accounts();
    },

    // --- REVIEW ACTIONS ---
    saveReview(isDraft) { const idVal = document.getElementById('r-id').value; const dateVal = document.getElementById('r-date').value; const audioData = document.getElementById('review-audio-data')?.value || ''; const r = { id: idVal ? parseInt(idVal) : Date.now(), date: dateVal ? new Date(dateVal).toISOString() : new Date().toISOString(), type: document.getElementById('r-type').value, status: isDraft ? 'in_progress' : 'completed', rating: 0, icon: '📝', generalNote: document.getElementById('r-general-note').value, errors: document.getElementById('r-errors').value, improvements: document.getElementById('r-improvements').value, images: ui.tempImages, audioNote: audioData }; DataStore.addReview(r); ui.tempImages = []; ui.closeModals(); if (router.currentPage === 'review') router.review(); },
    deleteReviewFromModalView(id) { if (id && confirm('Eliminare questa pagina di diario?')) { DataStore.deleteReview(id); ui.closeModals(); if (router.currentPage === 'review') router.review(); } },
    deleteReviewFromModal() { const id = document.getElementById('r-id').value; ui.deleteReviewFromModalView(id); },

    // Renders the *entire* review modal content string (minimal + subtle blue accents)
    renderReviewModalContent(r, isEdit, presetDate) {
        const data = r || { id: '', type: 'daily', generalNote: '', good: '', bad: '', lesson: '' };
        const isDaily = data.type === 'daily';
        const title = isEdit ? 'Modifica Revisione' : 'Nuova Revisione';
        const defaultDate = presetDate || (data.date ? new Date(data.date).toISOString().split('T')[0] : new Date().toISOString().split('T')[0]);

        return `
            <div class="bg-[var(--bg-card)] w-full max-w-7xl rounded-3xl border border-white/10 shadow-2xl transform transition-all scale-100 max-h-[92vh] overflow-hidden flex flex-col">

                <!-- Header -->
                <div class="flex items-center justify-between px-8 py-6 border-b border-white/5 flex-shrink-0">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-2xl bg-gradient-to-br ${isDaily ? 'from-blue-500/20 to-blue-500/5 border border-blue-500/30' : 'from-purple-500/20 to-purple-500/5 border border-purple-500/30'} flex items-center justify-center">
                            <i class="ph-bold ${isDaily ? 'ph-notebook' : 'ph-brain'} text-xl ${isDaily ? 'text-blue-400' : 'text-purple-400'}"></i>
                        </div>
                        <div>
                            <p class="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">${isDaily ? 'Revisione Giornaliera' : 'Revisione Settimanale'}</p>
                            <h3 class="text-xl font-bold text-white preserve-white">${title}</h3>
                        </div>
                    </div>
                    <button onclick="ui.closeModals()" class="group w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all text-[var(--text-muted)] hover:text-white preserve-white">
                        <i class="ph-bold ph-x text-lg group-hover:rotate-90 transition-transform"></i>
                    </button>
                </div>

                <!-- Scrollable Content -->
                <div class="flex-1 overflow-y-auto custom-scrollbar px-8 py-6">
                    <form class="space-y-6">
                        <input type="hidden" id="r-id" value="${data.id}">
                        <input type="hidden" id="r-type" value="${data.type}">

                        <!-- Date & Type Selector -->
                        <div class="bg-gradient-to-br ${isDaily ? 'from-blue-500/5' : 'from-purple-500/5'} to-transparent border ${isDaily ? 'border-blue-500/20' : 'border-purple-500/20'} rounded-2xl p-5">
                            <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                <div>
                                    <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2">Data Revisione</label>
                                    <input type="date" id="r-date" value="${defaultDate}" class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-sm font-bold text-white preserve-white focus:border-${isDaily ? 'blue' : 'purple'}-500/50 transition-all outline-none">
                                </div>
                                <div>
                                    <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2">Tipo</label>
                                    <div class="grid grid-cols-2 gap-2">
                                        <button type="button" id="btn-daily" onclick="ui.setReviewType('daily')" class="py-3 rounded-xl border-2 transition-all flex items-center justify-center gap-2 text-sm font-bold ${data.type === 'daily' ? 'bg-blue-500/15 border-blue-500/50 text-blue-400' : 'bg-white/5 border-white/10 text-[var(--text-muted)] hover:border-white/20 hover:bg-white/10'}">
                                            <i class="ph-bold ph-notebook"></i>
                                            <span>Day</span>
                                        </button>
                                        <button type="button" id="btn-weekly" onclick="ui.setReviewType('weekly')" class="py-3 rounded-xl border-2 transition-all flex items-center justify-center gap-2 text-sm font-bold ${data.type === 'weekly' ? 'bg-purple-500/15 border-purple-500/50 text-purple-400' : 'bg-white/5 border-white/10 text-[var(--text-muted)] hover:border-white/20 hover:bg-white/10'}">
                                            <i class="ph-bold ph-brain"></i>
                                            <span>Week</span>
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>

                        <!-- Main Reflection -->
                        <div class="bg-white/5 border border-white/10 rounded-2xl p-5">
                            <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3 flex items-center gap-2">
                                <i class="ph-bold ph-notebook text-sm"></i>
                                Riflessione Principale
                            </label>
                            <textarea id="r-general-note" class="w-full bg-transparent border-none outline-none text-sm text-white preserve-white placeholder-white/20 resize-none leading-relaxed min-h-[120px]" placeholder="Descrivi le tue riflessioni, analisi della performance, insight chiave...">${data.generalNote || ''}</textarea>
                        </div>

                        <!-- Errori & Miglioramenti -->
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                            <div class="bg-gradient-to-br from-red-500/10 to-red-500/5 border border-red-500/20 rounded-2xl p-5">
                                <label class="block text-[10px] font-bold uppercase tracking-widest text-red-400 mb-3 flex items-center gap-2">
                                    <div class="w-2 h-2 rounded-full bg-red-500"></div>
                                    Errori Commessi
                                </label>
                                <textarea id="r-errors" class="w-full bg-black/20 border border-red-500/10 rounded-xl p-3 outline-none text-sm text-white preserve-white placeholder-white/20 resize-none min-h-[100px] focus:bg-black/30 focus:border-red-500/30 transition-all" placeholder="Cosa non ha funzionato? Quali errori ripetuti?">${data.errors || ''}</textarea>
                            </div>
                            <div class="bg-gradient-to-br from-green-500/10 to-green-500/5 border border-green-500/20 rounded-2xl p-5">
                                <label class="block text-[10px] font-bold uppercase tracking-widest text-green-400 mb-3 flex items-center gap-2">
                                    <div class="w-2 h-2 rounded-full bg-green-500"></div>
                                    Aree di Miglioramento
                                </label>
                                <textarea id="r-improvements" class="w-full bg-black/20 border border-green-500/10 rounded-xl p-3 outline-none text-sm text-white preserve-white placeholder-white/20 resize-none min-h-[100px] focus:bg-black/30 focus:border-green-500/30 transition-all" placeholder="Su cosa lavorare? Quali obiettivi per la prossima sessione?">${data.improvements || ''}</textarea>
                            </div>
                        </div>

                        <!-- Audio Note -->
                        <div class="bg-gradient-to-br from-blue-500/5 to-purple-500/5 border border-blue-500/20 rounded-2xl p-5">
                            <label class="block text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3 flex items-center gap-2">
                                <i class="ph-bold ph-microphone text-sm"></i>
                                Nota Vocale
                            </label>
                            <div class="space-y-3">
                                <button type="button" id="review-audio-btn" data-target="review-audio-data" class="audio-record-btn w-full py-3 rounded-xl border-2 border-dashed border-blue-500/30 hover:border-blue-500/50 bg-blue-500/5 hover:bg-blue-500/10 transition-all flex items-center justify-center gap-2 text-blue-400">
                                    <i class="ph-bold ph-microphone text-xl"></i>
                                    <span class="text-xs font-bold">Registra</span>
                                </button>
                                <div id="review-audio-player"></div>
                                <input type="hidden" id="review-audio-data" value="${data.audioNote || ''}">
                            </div>
                        </div>

                    </form>
                </div>

                <!-- Footer Actions -->
                <div class="flex items-center justify-between px-8 py-5 border-t border-white/5 flex-shrink-0">
                    ${isEdit && data.id ? `<button type="button" onclick="ui.deleteReviewFromModal()" class="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white preserve-white transition-all font-bold text-sm">
                        <i class="ph-bold ph-trash"></i>
                        Elimina
                    </button>` : '<div></div>'}
                    <div class="flex gap-3">
                        <button type="button" onclick="ui.saveReview(true)" class="px-6 py-2.5 rounded-xl border border-white/10 text-sm font-bold text-[var(--text-muted)] hover:bg-white/5 hover:text-white preserve-white hover:border-white/20 transition-all">
                            Salva Bozza
                        </button>
                        <button type="button" onclick="ui.saveReview(false)" class="bg-[var(--accent-blue)] text-white preserve-white px-8 py-2.5 rounded-xl text-sm font-bold hover:opacity-90 hover:shadow-lg hover:shadow-blue-500/30 transition-all flex items-center gap-2">
                            <i class="ph-bold ph-check"></i>
                            Salva Revisione
                        </button>
                    </div>
                </div>

            </div>`;
    },

    viewReview(id) {
        const r = DataStore.data.reviews.find(x => x.id == id);
        if (!r) return;
        const modal = document.getElementById('modal-review');
        if (!modal) return;

        const isDaily = r.type === 'daily';
        const moodEmoji = r.mood === 'pessimista' ? '😞' : r.mood === 'ottimista' ? '😊' : '😐';
        const moodLabel = r.mood === 'pessimista' ? 'Negativo' : r.mood === 'ottimista' ? 'Positivo' : 'Neutro';
        const moodColor = r.mood === 'pessimista' ? 'red' : r.mood === 'ottimista' ? 'green' : 'yellow';

        modal.innerHTML = `
            <div class="bg-[var(--bg-card)] w-full max-w-7xl rounded-3xl border border-white/10 shadow-2xl transform transition-all scale-100 max-h-[92vh] overflow-hidden flex flex-col">
                
                <!-- Header -->
                <div class="flex items-center justify-between px-8 py-6 border-b border-white/5 flex-shrink-0">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-2xl bg-gradient-to-br ${isDaily ? 'from-blue-500/20 to-blue-500/5 border border-blue-500/30' : 'from-purple-500/20 to-purple-500/5 border border-purple-500/30'} flex items-center justify-center">
                            <i class="ph-bold ${isDaily ? 'ph-notebook' : 'ph-brain'} text-xl ${isDaily ? 'text-blue-400' : 'text-purple-400'}"></i>
                        </div>
                        <div>
                            <p class="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">${isDaily ? 'Revisione Giornaliera' : 'Revisione Settimanale'}</p>
                            <h3 class="text-xl font-bold text-white preserve-white">${new Date(r.date).toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric' })}</h3>
                        </div>
                    </div>
                    <button onclick="ui.closeModals()" class="group w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all text-[var(--text-muted)] hover:text-white preserve-white">
                        <i class="ph-bold ph-x text-lg group-hover:rotate-90 transition-transform"></i>
                    </button>
                </div>

                <!-- Content -->
                <div class="flex-1 overflow-y-auto custom-scrollbar px-8 py-6">
                    <div class="space-y-5">

                        <!-- Main Reflection -->
                        ${r.generalNote ? `
                        <div class="bg-white/5 border border-white/10 rounded-2xl p-5">
                            <h4 class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3 flex items-center gap-2">
                                <i class="ph-bold ph-notebook text-sm"></i>
                                Riflessione Principale
                            </h4>
                            <p class="text-sm text-white preserve-white leading-relaxed">${r.generalNote}</p>
                        </div>
                        ` : ''}

                        <!-- Errors & Improvements Grid -->
                        <div class="grid grid-cols-2 gap-4">
                            ${r.errors ? `
                            <div class="bg-gradient-to-br from-red-500/10 to-red-500/5 border border-red-500/20 rounded-2xl p-5">
                                <h4 class="text-[10px] font-bold uppercase tracking-widest text-red-400 mb-3 flex items-center gap-2">
                                    <div class="w-2 h-2 rounded-full bg-red-500"></div>
                                    Errori Commessi
                                </h4>
                                <p class="text-sm text-white preserve-white leading-relaxed">${r.errors}</p>
                            </div>
                            ` : '<div></div>'}
                            
                            ${r.improvements ? `
                            <div class="bg-gradient-to-br from-green-500/10 to-green-500/5 border border-green-500/20 rounded-2xl p-5">
                                <h4 class="text-[10px] font-bold uppercase tracking-widest text-green-400 mb-3 flex items-center gap-2">
                                    <div class="w-2 h-2 rounded-full bg-green-500"></div>
                                    Aree di Miglioramento
                                </h4>
                                <p class="text-sm text-white preserve-white leading-relaxed">${r.improvements}</p>
                            </div>
                            ` : '<div></div>'}
                        </div>

                        <!-- Audio Note -->
                        ${r.audioNote ? `
                        <div class="bg-gradient-to-r from-blue-500/10 to-purple-500/10 border border-blue-500/30 rounded-2xl p-5">
                            <h4 class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3 flex items-center gap-2">
                                <i class="ph-bold ph-microphone text-sm"></i>
                                Nota Vocale
                            </h4>
                            <div id="review-view-audio-container"></div>
                        </div>
                        ` : ''}

                        <!-- Photos / Screenshots -->
                        ${r.images && r.images.length > 0 ? `
                        <div class="bg-white/5 border border-white/10 rounded-2xl p-5">
                            <h4 class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3 flex items-center gap-2">
                                <i class="ph-bold ph-image text-sm"></i>
                                Foto / Screenshots
                            </h4>
                            <div class="grid grid-cols-4 gap-3">
                                ${r.images.map(img => `
                                    <div class="aspect-square bg-cover bg-center rounded-xl border border-white/20 cursor-pointer hover:scale-105 transition-transform" 
                                         style="background-image: url(${img})" 
                                         onclick="ui.viewFullImage('${img}')">
                                    </div>
                                `).join('')}
                            </div>
                        </div>
                        ` : ''}

                    </div>
                </div>

                <!-- Footer -->
                <div class="flex items-center justify-between px-8 py-5 border-t border-white/5 flex-shrink-0">
                    <button onclick="if(confirm('Eliminare questa revisione?')) { DataStore.deleteReview(${r.id}); ui.closeModals(); router.review(); }" class="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-red-500/10 text-red-400 hover:bg-red-500 hover:text-white preserve-white transition-all font-bold text-sm">
                        <i class="ph-bold ph-trash"></i>
                        Elimina
                    </button>
                    <button onclick="ui.editReview(${r.id});" class="bg-[var(--accent-blue)] text-white preserve-white px-8 py-2.5 rounded-xl text-sm font-bold hover:opacity-90 hover:shadow-lg hover:shadow-blue-500/30 transition-all flex items-center gap-2">
                        <i class="ph-bold ph-pencil-simple"></i>
                        Modifica
                    </button>
                </div>
            </div>
        `;

        ui.openModal('modal-review');

        // Renderizza audio player se esiste
        if (r && r.audioNote) {
            setTimeout(() => ui.renderAudioPlayer('review-view-audio-container', r.audioNote), 100);
        }
    },

    editReview(id, presetDate, presetType) {
        let r = null;
        if (id) r = DataStore.data.reviews.find(x => x.id == id);
        const modal = document.getElementById('modal-review');
        if (!modal) return;

        // IMPORTANTE: Inizializza tempImages PRIMA di renderizzare il modal
        ui.tempImages = r && r.images ? [...r.images] : [];

        // Se è una nuova review e c'è un presetType, usalo
        if (!r && presetType) {
            r = { type: presetType };
        }

        modal.innerHTML = ui.renderReviewModalContent(r, true, presetDate);
        ui.openModal('modal-review');

        // Setup handlers delle immagini
        ui.setupReviewImageHandlers();
        ui.setupAudioRecordButtons();

        // Renderizza audio player se esiste
        if (r && r.audioNote) {
            setTimeout(() => ui.renderAudioPlayer('review-audio-player', r.audioNote), 100);
        }
    },

    setReviewType(type) {
        document.getElementById('r-type').value = type;
        const btnD = document.getElementById('btn-daily');
        const btnW = document.getElementById('btn-weekly');
        if (type === 'daily') {
            btnD.className = "py-3 rounded-xl border-2 transition-all flex items-center justify-center gap-2 text-sm font-bold bg-blue-500/15 border-blue-500/50 text-blue-400";
            btnW.className = "py-3 rounded-xl border-2 transition-all flex items-center justify-center gap-2 text-sm font-bold bg-white/5 border-white/10 text-[var(--text-muted)] hover:border-white/20 hover:bg-white/10";
        } else {
            btnW.className = "py-3 rounded-xl border-2 transition-all flex items-center justify-center gap-2 text-sm font-bold bg-purple-500/15 border-purple-500/50 text-purple-400";
            btnD.className = "py-3 rounded-xl border-2 transition-all flex items-center justify-center gap-2 text-sm font-bold bg-white/5 border-white/10 text-[var(--text-muted)] hover:border-white/20 hover:bg-white/10";
        }
    },

    updateMoodUI(btn) {
        const moodBtns = document.querySelectorAll('.mood-btn');
        moodBtns.forEach(b => {
            b.classList.remove('border-red-500/50', 'border-yellow-500/50', 'border-green-500/50', 'bg-red-500/10', 'bg-yellow-500/10', 'bg-green-500/10', 'scale-110');
        });
        btn.classList.add('scale-110');
        if (btn.textContent.includes('😞')) {
            btn.classList.add('border-red-500/50', 'bg-red-500/10');
        } else if (btn.textContent.includes('😊')) {
            btn.classList.add('border-green-500/50', 'bg-green-500/10');
        } else if (btn.textContent.includes('😐')) {
            btn.classList.add('border-yellow-500/50', 'bg-yellow-500/10');
        }
    },

    // --- OTHER UI UTILS ---
    toggleTodoModalMode() { const mode = document.querySelector('input[name="todo_mode"]:checked').value; if (mode === 'task') { document.getElementById('form-task').classList.remove('hidden'); document.getElementById('form-goal').classList.add('hidden'); } else { document.getElementById('form-task').classList.add('hidden'); document.getElementById('form-goal').classList.remove('hidden'); } },

    // Renders the *entire* todo modal content string
    renderTodoModalContent(mode = 'task', allowSwitch = true) {
        ui.todoTempState = { type: 'Trading', importance: 'normal' };
        const todayLower = new Date().toLocaleDateString('it-IT', { weekday: 'long' }).toLowerCase();

        return `
                <div id="todo-content" class="relative bg-gradient-to-br from-[var(--bg-card)] to-[var(--bg-card)]/80 w-full max-w-lg rounded-2xl p-8 border border-white/10 shadow-2xl transform transition-all scale-100">
                    <div class="flex justify-between items-center mb-6">
                        <h3 class="text-2xl font-bold text-[var(--text-main)] tracking-tight" id="todo-modal-title">${mode === 'task' ? 'Nuovo Task' : 'Nuovo Obiettivo'}</h3>
                        <button onclick="ui.closeModals()" class="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all"><i class="ph-bold ph-x"></i></button>
                    </div>
                    ${allowSwitch ? `
                    <div class="bg-black/20 p-1 rounded-2xl flex relative mb-8">
                        <button id="tab-task" onclick="ui.switchTodoMode('task')" class="todo-mode-tab flex-1 py-3 rounded-xl text-xs font-bold transition-all ${mode === 'task' ? 'active' : ''}">
                            Task Giornaliero
                        </button>
                        <button id="tab-goal" onclick="ui.switchTodoMode('goal')" class="todo-mode-tab flex-1 py-3 rounded-xl text-xs font-bold transition-all ${mode === 'goal' ? 'active' : ''}">
                            Obiettivo Weekly
                        </button>
                    </div>` : ''}
                    <input type="hidden" id="todo-mode-input" value="${mode}">
                    <div id="form-container">
                        <form id="form-task" onsubmit="event.preventDefault(); ui.addTodo('task');" class="todo-form-panel ${mode === 'task' ? '' : 'hidden'} space-y-6">
                            <div class="bg-white/5 rounded-2xl px-4 py-3 border border-transparent focus-within:border-[var(--accent-blue)] transition-all">
                                <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Cosa devi fare?</label>
                                <input type="text" id="todo-title" class="w-full bg-transparent border-none outline-none text-base font-bold" placeholder="Es. Backtesting EURUSD 2024...">
                            </div>
                            <div class="grid grid-cols-2 gap-4">
                                <div class="bg-white/5 rounded-2xl px-4 py-3">
                                    <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Giorno</label>
                                    <select id="todo-day" class="w-full bg-transparent border-none outline-none text-sm font-bold appearance-none cursor-pointer">
                                        ${['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'].map(d => `<option value="${d}" class="bg-[#1c1c1e]" ${d.toLowerCase() === todayLower ? 'selected' : ''}>${d}</option>`).join('')}
                                    </select>
                                </div>
                                <div class="bg-white/5 rounded-2xl px-4 py-3">
                                    <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Tempo Stimato</label>
                                    <input type="text" id="todo-time" class="w-full bg-transparent border-none outline-none text-sm font-bold" placeholder="Es. 30m">
                                </div>
                            </div>
                            <div>
                                <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-2">Categoria</label>
                                <div class="grid grid-cols-4 gap-3">
                                    <button type="button" onclick="ui.setTaskType('Trading', this)" class="type-btn active flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-white/5 hover:bg-white/10 transition-all">
                                        <i class="ph-bold ph-chart-line-up text-xl text-[var(--accent-blue)]"></i>
                                        <span class="text-[10px] font-bold">Trading</span>
                                    </button>
                                    <button type="button" onclick="ui.setTaskType('Salute', this)" class="type-btn flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-white/5 hover:bg-white/10 transition-all">
                                        <i class="ph-bold ph-heart text-xl"></i>
                                        <span class="text-[10px] font-bold">Salute</span>
                                    </button>
                                    <button type="button" onclick="ui.setTaskType('Studio', this)" class="type-btn flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-white/5 hover:bg-white/10 transition-all">
                                        <i class="ph-bold ph-student text-xl"></i>
                                        <span class="text-[10px] font-bold">Studio</span>
                                    </button>
                                    <button type="button" onclick="ui.setTaskType('Altro', this)" class="type-btn flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-white/5 hover:bg-white/10 transition-all">
                                        <i class="ph-bold ph-dots-three text-xl"></i>
                                        <span class="text-[10px] font-bold">Altro</span>
                                    </button>
                                </div>
                            </div>
                            <div>
                                <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-2">Priorità</label>
                                <div class="grid grid-cols-2 gap-3">
                                    <button type="button" onclick="ui.setTaskImp('normal', this)" class="imp-btn active flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-blue-500/10 text-blue-500 ring-1 ring-blue-500/50 transition-all">
                                        <i class="ph-bold ph-check-circle"></i>
                                        <span class="text-xs font-bold">Normale</span>
                                    </button>
                                    <button type="button" onclick="ui.setTaskImp('high', this)" class="imp-btn flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-white/5 text-[var(--text-muted)] hover:text-red-500 hover:bg-red-500/10 transition-all">
                                        <i class="ph-bold ph-fire"></i>
                                        <span class="text-xs font-bold">Alta Priorità</span>
                                    </button>
                                </div>
                            </div>
                            <button type="button" onclick="ui.addTodo('task')" class="w-full mt-8 bg-[var(--accent-blue)] text-white preserve-white py-4 rounded-2xl font-bold text-sm shadow-lg shadow-blue-500/30 hover:scale-[1.02] active:scale-[0.98] transition-all">Salva Task</button>
                        </form>
                        
                        <form id="form-goal" onsubmit="event.preventDefault(); ui.addTodo('goal');" class="todo-form-panel ${mode === 'goal' ? '' : 'hidden'} space-y-5">
                            
                            <!-- Main Goal -->
                            <div>
                                <label class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2 block">Obiettivo</label>
                                <input type="text" id="goal-title" class="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-base font-semibold placeholder-white/20 outline-none focus:border-blue-500/50 transition-all" placeholder="Es. +5% di profitto questa settimana">
                            </div>

                            <!-- Reward & Punishment -->
                            <div class="grid grid-cols-2 gap-3">
                                <div>
                                    <label class="text-xs font-bold uppercase tracking-wider text-green-400 mb-2 block flex items-center gap-1.5">
                                        <i class="ph-bold ph-check-circle text-sm"></i>
                                        Premio
                                    </label>
                                    <input type="text" id="goal-reward" class="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 outline-none focus:border-green-500/50 transition-all" placeholder="Es. Cena fuori">
                                </div>
                                
                                <div>
                                    <label class="text-xs font-bold uppercase tracking-wider text-red-400 mb-2 block flex items-center gap-1.5">
                                        <i class="ph-bold ph-x-circle text-sm"></i>
                                        Penitenza
                                    </label>
                                    <input type="text" id="goal-punishment" class="w-full bg-white/5 border border-white/10 rounded-xl px-3 py-2.5 text-sm placeholder-white/20 outline-none focus:border-red-500/50 transition-all" placeholder="Es. 100 flessioni">
                                </div>
                            </div>

                            <!-- Submit Button -->
                            <button type="button" onclick="ui.addTodo('goal')" class="w-full bg-[var(--accent-blue)] hover:bg-blue-600 text-white preserve-white py-3 rounded-xl font-semibold text-sm transition-all mt-6">
                                Salva Obiettivo
                            </button>
                        </form>
                    </div>
                </div>
                `;
    },

    openTodoModal(mode = 'task', allowSwitch = true) {
        const modal = document.getElementById('modal-todo');
        if (!modal) return;

        modal.innerHTML = ui.renderTodoModalContent(mode, allowSwitch);
        ui.openModal('modal-todo');
    },

    setTaskType(type, btn) {
        if (!btn) return;
        ui.todoTempState.type = type;
        document.querySelectorAll('#form-task .type-btn').forEach(b => {
            b.classList.remove('active');
        });

        btn.classList.add('active');
    },

    setTaskImp(imp, btn) {
        ui.todoTempState.importance = imp;
        document.querySelectorAll('#form-task .imp-btn').forEach(b => {
            b.className = "imp-btn flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-white/5 text-[var(--text-muted)] transition-all";
        });

        if (imp === 'high') {
            btn.className = "imp-btn active flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-red-500/10 text-red-500 ring-1 ring-red-500/50 transition-all";
        } else {
            btn.className = "imp-btn active flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-blue-500/10 text-blue-500 ring-1 ring-blue-500/50 transition-all";
        }
    },

    switchTodoMode(mode) {
        if (ui.todoSwitchTimers.hideShow) clearTimeout(ui.todoSwitchTimers.hideShow);
        if (ui.todoSwitchTimers.cleanup) clearTimeout(ui.todoSwitchTimers.cleanup);

        const modeInput = document.getElementById('todo-mode-input');
        if (!modeInput) return;
        const currentMode = modeInput.value;
        if (currentMode === mode) return;

        modeInput.value = mode;
        const taskForm = document.getElementById('form-task');
        const goalForm = document.getElementById('form-goal');
        const btnTask = document.getElementById('tab-task');
        const btnGoal = document.getElementById('tab-goal');
        const title = document.getElementById('todo-modal-title');

        if (btnTask && btnGoal && taskForm && goalForm && title) {
            const outgoingForm = currentMode === 'task' ? taskForm : goalForm;
            const incomingForm = mode === 'task' ? taskForm : goalForm;

            if (mode === 'task') {
                title.innerText = 'Nuovo Task';
                btnTask.classList.add('active');
                btnGoal.classList.remove('active');
            } else {
                title.innerText = 'Nuovo Obiettivo';
                btnGoal.classList.add('active');
                btnTask.classList.remove('active');
            }

            // Title micro-animation while switching mode
            title.classList.remove('todo-title-switch');
            requestAnimationFrame(() => title.classList.add('todo-title-switch'));

            // Out -> In staged transition for smoother perceived switch
            outgoingForm.classList.remove('todo-form-enter');
            outgoingForm.classList.add('todo-form-exit');

            ui.todoSwitchTimers.hideShow = setTimeout(() => {
                outgoingForm.classList.remove('todo-form-exit');
                outgoingForm.classList.add('hidden');

                incomingForm.classList.remove('hidden');
                incomingForm.classList.remove('todo-form-exit');
                incomingForm.classList.add('todo-form-enter');

                ui.todoSwitchTimers.cleanup = setTimeout(() => {
                    incomingForm.classList.remove('todo-form-enter');
                    title.classList.remove('todo-title-switch');
                }, 260);
            }, 170);
        }
    },

    addTodo(mode) {
        if (mode === 'task') {
            const t = {
                title: document.getElementById('todo-title').value,
                day: document.getElementById('todo-day').value,
                timeEst: document.getElementById('todo-time').value,
                importance: ui.todoTempState.importance,
                type: ui.todoTempState.type
            };
            if (!t.title) { return; }
            DataStore.addTodo(t);
        } else if (mode === 'goal') {
            const t = {
                title: document.getElementById('goal-title').value,
                reward: document.getElementById('goal-reward').value,
                punishment: document.getElementById('goal-punishment').value
            };
            if (!t.title) { return; }
            DataStore.addWeeklyGoal(t);
        }

        ui.closeModals();

        if (router.currentPage === 'todo') router.todo();
        else if (router.currentPage === 'review') router.review();
        else if (router.currentPage === 'dashboard') router.dashboard();
    },

    // --- EDIT TODO ---
    openEditTodoModal(id) {
        const todo = DataStore.data.todos.find(t => t.id === id);
        if (!todo) return;
        const normalizedType = todo.type === 'Palestra' ? 'Altro' : todo.type;

        const modal = document.getElementById('modal-edit-todo');
        if (!modal) return;

        modal.innerHTML = `
            <div class="relative bg-gradient-to-br from-[var(--bg-card)] to-[var(--bg-card)]/80 w-full max-w-lg rounded-2xl p-8 border border-white/10 shadow-2xl transform transition-all scale-100">
                <div class="flex justify-between items-center mb-6">
                    <h3 class="text-2xl font-bold text-white preserve-white tracking-tight">Modifica Task</h3>
                    <button onclick="ui.closeModals()" class="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                        <i class="ph-bold ph-x"></i>
                    </button>
                </div>

                <form id="form-edit-task" onsubmit="event.preventDefault(); ui.saveEditedTodo(${id});" class="space-y-6">
                    <div class="bg-white/5 rounded-2xl px-4 py-3 border border-transparent focus-within:border-[var(--accent-blue)] transition-all">
                        <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Cosa devi fare?</label>
                        <input type="text" id="edit-todo-title" value="${todo.title.replace(/"/g, '&quot;')}" class="w-full bg-transparent border-none outline-none text-base font-bold text-white preserve-white placeholder-white/20" placeholder="Es. Backtesting EURUSD 2024...">
                    </div>

                    <div class="grid grid-cols-2 gap-4">
                        <div class="bg-white/5 rounded-2xl px-4 py-3">
                            <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Giorno</label>
                            <select id="edit-todo-day" class="w-full bg-transparent border-none outline-none text-sm font-bold text-white preserve-white appearance-none cursor-pointer">
                                ${['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'].map(d =>
            `<option value="${d}" class="bg-[#1c1c1e]" ${d === todo.day ? 'selected' : ''}>${d}</option>`
        ).join('')}
                            </select>
                        </div>
                        <div class="bg-white/5 rounded-2xl px-4 py-3">
                            <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-1">Tempo Stimato</label>
                            <input type="text" id="edit-todo-time" value="${todo.timeEst || ''}" class="w-full bg-transparent border-none outline-none text-sm font-bold text-white preserve-white placeholder-white/20" placeholder="Es. 30m">
                        </div>
                    </div>

                    <div>
                        <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-2">Categoria</label>
                        <div class="grid grid-cols-4 gap-3">
                            ${['Trading', 'Salute', 'Studio', 'Altro'].map((type, idx) => {
            const icons = ['ph-chart-line-up', 'ph-heart', 'ph-student', 'ph-dots-three'];
            const isActive = normalizedType === type;
            return `
                                    <button type="button" onclick="ui.setEditTaskType('${type}', this)" 
                                        class="edit-type-btn ${isActive ? 'active bg-[var(--bg-card)] ring-1 ring-[var(--accent-blue)] text-white preserve-white' : 'bg-white/5 text-[var(--text-muted)]'} flex flex-col items-center justify-center gap-2 p-3 rounded-2xl border border-transparent hover:bg-white/10 transition-all">
                                        <i class="ph-bold ${icons[idx]} text-xl ${isActive ? 'text-[var(--accent-blue)]' : ''}"></i>
                                        <span class="text-[10px] font-bold">${type}</span>
                                    </button>
                                `;
        }).join('')}
                        </div>
                    </div>

                    <div>
                        <label class="block text-[10px] font-bold uppercase text-[var(--text-muted)] mb-2">Priorità</label>
                        <div class="grid grid-cols-2 gap-3">
                            <button type="button" onclick="ui.setEditTaskImp('normal', this)" 
                                class="edit-imp-btn ${todo.importance === 'normal' ? 'active bg-blue-500/10 text-blue-500 ring-1 ring-blue-500/50' : 'bg-white/5 text-[var(--text-muted)]'} flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent transition-all">
                                <i class="ph-bold ph-check-circle"></i>
                                <span class="text-xs font-bold">Normale</span>
                            </button>
                            <button type="button" onclick="ui.setEditTaskImp('high', this)" 
                                class="edit-imp-btn ${todo.importance === 'high' ? 'active bg-red-500/10 text-red-500 ring-1 ring-red-500/50' : 'bg-white/5 text-[var(--text-muted)]'} flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent transition-all">
                                <i class="ph-bold ph-fire"></i>
                                <span class="text-xs font-bold">Alta Priorità</span>
                            </button>
                        </div>
                    </div>

                    <button type="submit" class="w-full bg-[var(--accent-blue)] hover:bg-blue-600 text-white preserve-white py-3 rounded-xl font-semibold text-sm transition-all">
                        Salva Modifiche
                    </button>
                </form>
            </div>
        `;

        // Salva i valori iniziali nello state
        ui.editTodoTempState = {
            type: normalizedType,
            importance: todo.importance
        };

        ui.openModal('modal-edit-todo');
    },

    setEditTaskType(type, btn) {
        ui.editTodoTempState.type = type;
        document.querySelectorAll('#form-edit-task .edit-type-btn').forEach(b => {
            b.classList.remove('active', 'bg-[var(--bg-card)]', 'ring-1', 'ring-[var(--accent-blue)]', 'text-white preserve-white');
            b.classList.add('bg-white/5', 'text-[var(--text-muted)]');
            const icon = b.querySelector('i');
            if (icon) icon.classList.remove('text-[var(--accent-blue)]');
        });

        btn.classList.remove('bg-white/5', 'text-[var(--text-muted)]');
        btn.classList.add('active', 'bg-[var(--bg-card)]', 'ring-1', 'ring-[var(--accent-blue)]', 'text-white preserve-white');
        const icon = btn.querySelector('i');
        if (icon) icon.classList.add('text-[var(--accent-blue)]');
    },

    setEditTaskImp(imp, btn) {
        ui.editTodoTempState.importance = imp;
        document.querySelectorAll('#form-edit-task .edit-imp-btn').forEach(b => {
            b.className = "edit-imp-btn flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-white/5 text-[var(--text-muted)] transition-all";
        });

        if (imp === 'high') {
            btn.className = "edit-imp-btn active flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-red-500/10 text-red-500 ring-1 ring-red-500/50 transition-all";
        } else {
            btn.className = "edit-imp-btn active flex items-center justify-center gap-2 p-3 rounded-2xl border border-transparent bg-blue-500/10 text-blue-500 ring-1 ring-blue-500/50 transition-all";
        }
    },

    saveEditedTodo(id) {
        const updates = {
            title: document.getElementById('edit-todo-title').value,
            day: document.getElementById('edit-todo-day').value,
            timeEst: document.getElementById('edit-todo-time').value,
            type: ui.editTodoTempState.type,
            importance: ui.editTodoTempState.importance
        };

        if (!updates.title) return;

        DataStore.updateTodo(id, updates);
        ui.closeModals();

        if (router.currentPage === 'todo') router.todo();
        else if (router.currentPage === 'review') router.review();
        else if (router.currentPage === 'dashboard') router.dashboard();
    },

    // --- EDIT WEEKLY GOAL ---
    openEditWeeklyGoalModal(id) {
        const goal = DataStore.data.weeklyGoals.find(g => g.id === id);
        if (!goal) return;

        const modal = document.getElementById('modal-edit-weekly-goal');
        if (!modal) return;

        modal.innerHTML = `
            <div class="relative bg-[var(--bg-card)] w-full max-w-3xl rounded-3xl p-6 border border-white/10 shadow-2xl transform transition-all scale-100 backdrop-blur-xl">
                <!-- Header -->
                <div class="flex items-center justify-between mb-6 pb-4 border-b border-white/5">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-yellow-500/20 to-orange-500/20 flex items-center justify-center">
                            <i class="ph-bold ph-target text-yellow-400 text-xl"></i>
                        </div>
                        <div>
                            <h3 class="text-xl font-bold text-white preserve-white tracking-tight">Modifica Obiettivo</h3>
                            <p class="text-xs text-[var(--text-muted)]">Aggiorna il tuo obiettivo settimanale</p>
                        </div>
                    </div>
                    <button onclick="ui.closeModals()" class="w-9 h-9 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                        <i class="ph-bold ph-x text-lg"></i>
                    </button>
                </div>

                <form id="form-edit-goal" onsubmit="event.preventDefault(); ui.saveEditedWeeklyGoal(${id});" class="space-y-5">
                    <!-- Title Input -->
                    <div class="rounded-2xl px-5 py-4 border border-white/10 focus-within:border-[var(--accent-blue)] transition-all">
                        <label class="block text-[10px] font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2">Obiettivo Settimanale</label>
                        <input type="text" id="edit-goal-title" value="${goal.title.replace(/"/g, '&quot;')}" class="w-full bg-transparent border-none outline-none text-base font-semibold text-white preserve-white placeholder-white/20" placeholder="Es. Chiudere la settimana in profitto, Max 2 loss giornalieri...">
                    </div>

                    <!-- Reward and Punishment Grid -->
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div class="rounded-2xl px-5 py-4 border border-green-500/20 focus-within:border-green-500/50 transition-all">
                            <label class="block text-[10px] font-bold uppercase tracking-wider text-green-400 mb-2 flex items-center gap-1.5">
                                <i class="ph-bold ph-gift text-sm"></i> Ricompensa
                            </label>
                            <input type="text" id="edit-goal-reward" value="${goal.reward || ''}" class="w-full bg-transparent border-none outline-none text-sm text-white preserve-white placeholder-green-500/30 font-medium" placeholder="Es. Cena al ristorante">
                        </div>

                        <div class="rounded-2xl px-5 py-4 border border-red-500/20 focus-within:border-red-500/50 transition-all">
                            <label class="block text-[10px] font-bold uppercase tracking-wider text-red-400 mb-2 flex items-center gap-1.5">
                                <i class="ph-bold ph-warning text-sm"></i> Punizione
                            </label>
                            <input type="text" id="edit-goal-punishment" value="${goal.punishment || ''}" class="w-full bg-transparent border-none outline-none text-sm text-white preserve-white placeholder-red-500/30 font-medium" placeholder="Es. Niente Netflix per 3 giorni">
                        </div>
                    </div>

                    <!-- Action Buttons -->
                    <div class="flex gap-3 pt-2">
                        <button type="button" onclick="DataStore.deleteWeeklyGoal(${id}); ui.closeModals(); router.todo();" class="px-6 py-3 rounded-xl bg-red-500/10 hover:bg-red-500/20 text-red-400 font-bold text-sm transition-all flex items-center justify-center gap-2 border border-red-500/20 hover:border-red-500/30">
                            <i class="ph-bold ph-trash"></i> Elimina
                        </button>
                        <button type="submit" class="flex-1 py-3 rounded-xl bg-gradient-to-r from-[var(--accent-blue)] to-blue-600 hover:from-blue-600 hover:to-blue-700 text-white preserve-white font-bold text-sm transition-all shadow-lg shadow-blue-500/20">
                            Salva Modifiche
                        </button>
                    </div>
                </form>
            </div>
        `;

        ui.openModal('modal-edit-weekly-goal');
    },

    saveEditedWeeklyGoal(id) {
        const title = document.getElementById('edit-goal-title').value;
        const reward = document.getElementById('edit-goal-reward').value;
        const punishment = document.getElementById('edit-goal-punishment').value;

        if (!title) return;

        DataStore.updateWeeklyGoal(id, { title, reward, punishment });
        ui.closeModals();

        if (router.currentPage === 'todo') router.todo();
        else if (router.currentPage === 'review') router.review();
        else if (router.currentPage === 'dashboard') router.dashboard();
    },

    // --- ANNUAL GOALS ---
    goalTempActions: [],

    // --- DRAG & DROP ---
    draggedTodoId: null,
    editTodoTempState: {},

    handleTodoDragStart(event, todoId) {
        ui.draggedTodoId = todoId;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', todoId);
        event.target.style.opacity = '0.5';

        // Aggiungi classe visuale a tutte le drop zones
        document.querySelectorAll('.todo-day-container').forEach(container => {
            container.style.borderColor = 'var(--accent-blue)';
            container.style.borderWidth = '2px';
            container.style.borderStyle = 'dashed';
        });
    },

    handleTodoDragEnd(event) {
        event.target.style.opacity = '1';

        // Rimuovi evidenziazione drop zones
        document.querySelectorAll('.todo-day-container').forEach(container => {
            container.style.borderColor = '';
            container.style.borderWidth = '';
            container.style.borderStyle = '';
        });
    },

    handleTodoDragOver(event) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';

        const container = event.currentTarget;
        if (container.classList.contains('todo-day-container')) {
            container.style.backgroundColor = 'rgba(59, 130, 246, 0.1)';
        }
    },

    handleTodoDragLeave(event) {
        const container = event.currentTarget;
        if (container.classList.contains('todo-day-container')) {
            container.style.backgroundColor = '';
        }
    },

    handleTodoDrop(event, targetDay) {
        event.preventDefault();
        event.stopPropagation();

        const container = event.currentTarget;
        container.style.backgroundColor = '';
        container.style.borderColor = '';
        container.style.borderWidth = '';
        container.style.borderStyle = '';

        if (ui.draggedTodoId) {
            const todo = DataStore.data.todos.find(t => t.id === ui.draggedTodoId);

            // Solo se il giorno è diverso
            if (todo && todo.day !== targetDay) {
                DataStore.moveTodoToDay(ui.draggedTodoId, targetDay);
                router.todo(); // Ricarica la pagina
            }

            ui.draggedTodoId = null;
        }
    },

    // --- EDIT PROFILE ---
    openEditProfileModal() {
        const profile = DataStore.data.profile;
        const modalContainer = document.getElementById('modal-edit-profile'); // FIX: Target specific modal container
        if (!modalContainer) return;

        const safePhotoUrl = this.sanitizeImageUrl(profile.photoUrl || '');
        const safeName = this.escapeHtml(this.sanitizeText(profile.name || 'Trader', 40) || 'Trader');
        const safeBio = this.escapeHtml(this.sanitizeText(profile.bio || '', 280));
        const safePreviewUrl = this.escapeHtml(safePhotoUrl);

        const modalContent = `
            <div class="relative bg-gradient-to-br from-[var(--bg-card)] to-[var(--bg-card)]/95 rounded-3xl w-full max-w-4xl border border-white/10 shadow-2xl flex flex-col max-h-[90vh]">
                
                <!-- Header -->
                <div class="flex items-center justify-between px-8 py-6 border-b border-white/5 flex-shrink-0">
                    <div class="flex items-center gap-4">
                        <div class="w-12 h-12 rounded-xl bg-[var(--input-bg)] border border-white/5 flex items-center justify-center">
                            <i class="ph-bold ph-user-gear text-xl text-[var(--accent-blue)]"></i>
                        </div>
                        <div>
                            <p class="text-xs font-bold uppercase tracking-widest text-[var(--text-muted)]">Personalizzazione</p>
                            <h3 class="text-xl font-bold text-white preserve-white">Il Tuo Profilo</h3>
                        </div>
                    </div>
                    <button onclick="ui.closeModals()" class="group w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all text-[var(--text-muted)] hover:text-white preserve-white">
                        <i class="ph-bold ph-x text-lg group-hover:rotate-90 transition-transform"></i>
                    </button>
                </div>

                <!-- Content with Grid Layout -->
                <div class="flex-1 overflow-y-auto custom-scrollbar p-8">
                    <form id="form-edit-profile" onsubmit="event.preventDefault(); ui.saveProfile();" class="grid grid-cols-1 md:grid-cols-3 gap-10">
                        
                        <!-- LEFT COL: Avatar Area (Larger) -->
                        <div class="col-span-1 flex flex-col items-center">
                            <div class="relative group cursor-pointer mb-4" onclick="document.getElementById('profile-photo-upload').click()">
                                <div id="profile-preview" class="w-56 h-56 rounded-full ${safePhotoUrl ? '' : 'bg-gradient-to-br from-[var(--accent-blue)] to-blue-600'} flex items-center justify-center text-7xl shadow-2xl border-4 border-white/10 overflow-hidden transition-transform group-hover:scale-105 group-hover:border-[var(--accent-blue)]/50">
                                    ${safePhotoUrl ? `<img src="${safePreviewUrl}" class="w-full h-full object-cover">` : '👤'}
                                </div>
                                <div class="absolute inset-0 rounded-full bg-black/50 opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity backdrop-blur-[2px]">
                                    <div class="flex flex-col items-center gap-2">
                                        <i class="ph-bold ph-camera text-3xl text-white preserve-white"></i>
                                        <span class="text-xs font-bold text-white preserve-white uppercase tracking-wider">Cambia</span>
                                    </div>
                                </div>
                            </div>
                            
                            <div class="text-center">
                                <button type="button" onclick="document.getElementById('profile-photo-upload').click()" class="text-[var(--accent-blue)] hover:text-[#4facfe] text-sm font-bold transition-colors">
                                    Clicca per caricare
                                </button>
                                <p class="text-[10px] text-[var(--text-muted)] mt-1">JPG, PNG, GIF • Max 2MB</p>
                            </div>

                            <input type="file" id="profile-photo-upload" accept="image/*" class="hidden" onchange="ui.handleProfilePhotoUpload(event)">
                            <input type="hidden" id="profile-photo-url" value="${safePreviewUrl}">
                        </div>

                        <!-- RIGHT COL: Info (Spans 2 cols) -->
                        <div class="col-span-1 md:col-span-2 space-y-6 flex flex-col justify-center">
                            
                            <!-- Nome -->
                            <div class="group bg-[var(--input-bg)] hover:bg-white/10 focus-within:bg-[var(--input-focus)] border border-white/5 focus-within:border-[var(--accent-blue)]/50 rounded-2xl p-5 transition-all duration-300">
                                <label class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2 group-focus-within:text-[var(--accent-blue)] transition-colors">
                                    <i class="ph-bold ph-identification-card"></i> Nome Visualizzato
                                </label>
                                <input type="text" id="profile-name" value="${safeName}" class="w-full bg-transparent border-none outline-none text-2xl font-bold text-white preserve-white placeholder-white/20 transition-all" placeholder="Es. Mario Rossi">
                            </div>

                            <!-- Bio -->
                            <div class="group bg-[var(--input-bg)] hover:bg-white/10 focus-within:bg-[var(--input-focus)] border border-white/5 focus-within:border-[var(--accent-blue)]/50 rounded-2xl p-5 transition-all duration-300 h-full max-h-[220px] flex flex-col">
                                <label class="flex items-center gap-2 text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-3 group-focus-within:text-[var(--accent-blue)] transition-colors">
                                    <i class="ph-bold ph-quotes"></i> Bio e Obiettivi
                                </label>
                                <textarea id="profile-bio" class="w-full flex-1 bg-transparent border-none outline-none text-base text-white preserve-white placeholder-white/20 resize-none leading-relaxed" placeholder="Scrivi una breve descrizione di te stesso, la tua strategia o i tuoi obiettivi di trading...">${safeBio}</textarea>
                            </div>

                        </div>

                    </form>
                </div>

                <!-- Footer -->
                <div class="px-8 py-6 border-t border-white/5 flex-shrink-0 flex justify-end gap-4 bg-black/20 rounded-b-3xl">
                    <button type="button" onclick="ui.closeModals()" class="px-6 py-3 rounded-xl font-bold text-sm text-[var(--text-muted)] hover:text-white preserve-white hover:bg-white/5 transition-all">
                        Annulla
                    </button>
                    <button type="submit" form="form-edit-profile" class="px-10 py-3 bg-[var(--accent-blue)] hover:bg-[#0071e3] text-white preserve-white rounded-xl font-bold text-sm transition-all shadow-lg shadow-blue-500/20 hover:shadow-blue-500/40 transform hover:-translate-y-0.5 flex items-center gap-2">
                        <i class="ph-bold ph-check-circle text-lg"></i>
                        Salva Profilo
                    </button>
                </div>
            </div>
        `;

        modalContainer.innerHTML = modalContent; // FIX: Update container content, not overlay
        ui.openModal('modal-edit-profile');
    },

    async handleProfilePhotoUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        // Verifica tipo file
        if (!file.type.startsWith('image/')) {
            alert('Seleziona un file immagine valido (JPG, PNG, GIF)');
            return;
        }

        try {
            // Mostra loading o feedback visivo
            const preview = document.getElementById('profile-preview');
            const originalContent = preview.innerHTML;
            preview.innerHTML = '<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>';

            // 🗜️ COMPRESSIONE AUTOMATICA
            // Avatar profile non serve enorme: 400px è più che sufficiente per l'UI
            const compressedBase64 = await ui.compressImage(file, 400, 0.8);

            document.getElementById('profile-photo-url').value = compressedBase64;

            // Aggiorna preview
            preview.innerHTML = `<img src="${compressedBase64}" class="w-full h-full object-cover">`;
            // Manteinemiamo lo stile del nuovo design (cerchio grande)
            preview.className = 'w-56 h-56 rounded-full flex items-center justify-center text-7xl shadow-2xl border-4 border-white/10 overflow-hidden transition-transform group-hover:scale-105 group-hover:border-[var(--accent-blue)]/50';

            console.log('✅ Foto profilo compressa e caricata. Length:', compressedBase64.length);
        } catch (error) {
            console.error('Errore compressione:', error);
            alert('Errore nel caricamento della foto. Riprova con un altro file.');
            // Ripristina stato precedente in caso di errore
            const preview = document.getElementById('profile-preview');
            preview.innerHTML = '👤'; // fallback semplice
        }
    },

    async saveProfile() {
        const updates = {
            photoUrl: this.sanitizeImageUrl(document.getElementById('profile-photo-url').value),
            name: this.sanitizeText(document.getElementById('profile-name').value, 40) || 'Trader',
            bio: this.sanitizeText(document.getElementById('profile-bio').value, 280)
        };

        await DataStore.updateProfile(updates);
        this.renderHeaderProfile();
        this.renderWelcomeName();
        ui.closeModals();
        router.profile();
    },

    // --- ACHIEVEMENT INFO POPUP ---
    showAchievementInfo(name, description, isUnlocked) {
        const popup = document.createElement('div');
        popup.id = 'achievement-popup';
        popup.className = 'fixed inset-0 z-[200] flex items-center justify-center p-4 animate-fade-in';

        popup.innerHTML = `
            <div class="absolute inset-0 bg-black/60 backdrop-blur-sm" onclick="ui.closeAchievementPopup()"></div>
            <div class="relative bg-gradient-to-br from-[var(--bg-card)] to-[var(--bg-card)]/80 rounded-2xl p-6 max-w-md w-full border border-white/10 shadow-2xl transform transition-all scale-100 animate-scale-in">
                <div class="flex items-start gap-4 mb-4">
                    <div class="w-12 h-12 rounded-xl ${isUnlocked ? 'bg-gradient-to-br from-green-500 to-green-600' : 'bg-white/10'} flex items-center justify-center flex-shrink-0">
                        <i class="${isUnlocked ? 'ph-fill ph-trophy' : 'ph-bold ph-lock'} text-2xl ${isUnlocked ? 'text-white preserve-white' : 'text-[var(--text-muted)]'}"></i>
                    </div>
                    <div class="flex-1">
                        <h4 class="text-lg font-bold text-white preserve-white mb-1">${name}</h4>
                        <span class="inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${isUnlocked ? 'bg-green-500/20 text-green-400' : 'bg-white/5 text-[var(--text-muted)]'}">
                            ${isUnlocked ? '✓ Sbloccato' : '🔒 Bloccato'}
                        </span>
                    </div>
                    <button onclick="ui.closeAchievementPopup()" class="w-8 h-8 rounded-full bg-white/5 hover:bg-white/10 flex items-center justify-center transition-all">
                        <i class="ph-bold ph-x text-[var(--text-muted)]"></i>
                    </button>
                </div>
                
                <div class="bg-white/5 rounded-xl p-4 border border-white/10">
                    <p class="text-sm text-[var(--text-muted)] leading-relaxed">${description}</p>
                </div>
                
                ${!isUnlocked ? `
                    <div class="mt-4 flex items-center gap-2 text-xs text-yellow-500">
                        <i class="ph-fill ph-lightning"></i>
                        <span class="font-bold">Continua a lavorare per sbloccarlo!</span>
                    </div>
                ` : ''}
            </div>
        `;

        document.body.appendChild(popup);
    },

    closeAchievementPopup() {
        const popup = document.getElementById('achievement-popup');
        if (popup) {
            popup.classList.add('animate-fade-out');
            setTimeout(() => popup.remove(), 200);
        }
    },

    // Renders the *entire* account modal content string
    renderAccountModalContent(data) {
        const a = data || { name: '', size: 0, balance: 0, type: 'challenge', target: 0 };
        const isEdit = !!data;

        const typeColor = a.type === 'live' ? 'green' : a.type === 'funded' ? 'blue' : 'orange';

        return `
            <div class="relative bg-gradient-to-br from-[var(--bg-card)] to-[var(--bg-card)]/80 rounded-2xl overflow-hidden shadow-2xl transform transition-all scale-100 flex flex-col border border-white/10" style="width: 650px; max-height: 90vh;">
                
                <!-- Header -->
                <div class="relative px-8 py-6 border-b border-white/10">
                    <div class="relative flex items-center justify-between">
                        <div class="flex items-center gap-4">
                            <div class="w-14 h-14 rounded-2xl bg-[var(--accent-blue)] flex items-center justify-center">
                                <i class="ph-fill ph-wallet text-white preserve-white text-3xl"></i>
                            </div>
                            <div>
                                <h3 class="text-2xl font-bold text-white preserve-white tracking-tight">${isEdit ? 'Modifica Conto' : 'Crea Nuovo Conto'}</h3>
                                <p class="text-sm text-[var(--text-muted)] flex items-center gap-2 mt-1">
                                    <i class="ph-fill ph-gear text-xs"></i>
                                    Configura il tuo account di trading
                                </p>
                            </div>
                        </div>
                        <button onclick="ui.closeModals()" class="group w-11 h-11 rounded-xl bg-white/5 hover:bg-red-500/20 border border-white/10 hover:border-red-500/50 flex items-center justify-center transition-all duration-300 hover:rotate-90 hover:scale-110">
                            <i class="ph-bold ph-x text-xl text-[var(--text-muted)] group-hover:text-red-400 transition-colors"></i>
                        </button>
                    </div>
                </div>

                <!-- Content -->
                <div class="flex-1 overflow-y-auto custom-scrollbar px-5 py-5 md:px-8 md:py-6">
                    <form onsubmit="event.preventDefault(); ui.saveAccount(${isEdit ? a.id : ''})" class="space-y-6">
                        
                        <!-- Account Type -->
                        <div class="p-5 rounded-2xl bg-white/5 border border-white/10">
                            <label class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-4 flex items-center gap-2">
                                <i class="ph-bold ph-identification-card text-sm"></i>
                                Tipo di Account
                            </label>
                            <div class="grid grid-cols-1 md:grid-cols-3 gap-3" onchange="ui.toggleAccountFields()">
                                <label class="cursor-pointer group">
                                    <input type="radio" name="acc_type" value="live" class="peer sr-only" ${a.type === 'live' ? 'checked' : ''}>
                                    <div class="relative py-5 px-3 rounded-xl border-2 border-white/10 bg-white/5 peer-checked:border-[var(--accent-blue)] peer-checked:bg-[var(--accent-blue)]/10 hover:border-white/20 transition-all flex flex-col items-center gap-3">
                                        <i class="ph-fill ph-broadcast text-2xl text-[var(--text-muted)] peer-checked:text-[var(--accent-blue)]"></i>
                                        <span class="text-sm font-bold text-white preserve-white">Live</span>
                                        <i class="ph-fill ph-check-circle absolute top-2 right-2 text-[var(--accent-blue)] opacity-0 peer-checked:opacity-100 transition-opacity"></i>
                                    </div>
                                </label>
                                <label class="cursor-pointer group">
                                    <input type="radio" name="acc_type" value="funded" class="peer sr-only" ${a.type === 'funded' ? 'checked' : ''}>
                                    <div class="relative py-5 px-3 rounded-xl border-2 border-white/10 bg-white/5 peer-checked:border-[var(--accent-blue)] peer-checked:bg-[var(--accent-blue)]/10 hover:border-white/20 transition-all flex flex-col items-center gap-3">
                                        <i class="ph-fill ph-medal text-2xl text-[var(--text-muted)] peer-checked:text-[var(--accent-blue)]"></i>
                                        <span class="text-sm font-bold text-white preserve-white">Funded</span>
                                        <i class="ph-fill ph-check-circle absolute top-2 right-2 text-[var(--accent-blue)] opacity-0 peer-checked:opacity-100 transition-opacity"></i>
                                    </div>
                                </label>
                                <label class="cursor-pointer group">
                                    <input type="radio" name="acc_type" value="challenge" class="peer sr-only" ${a.type === 'challenge' ? 'checked' : ''}>
                                    <div class="relative py-5 px-3 rounded-xl border-2 border-white/10 bg-white/5 peer-checked:border-[var(--accent-blue)] peer-checked:bg-[var(--accent-blue)]/10 hover:border-white/20 transition-all flex flex-col items-center gap-3">
                                        <i class="ph-fill ph-trophy text-2xl text-[var(--text-muted)] peer-checked:text-[var(--accent-blue)]"></i>
                                        <span class="text-sm font-bold text-white preserve-white">Challenge</span>
                                        <i class="ph-fill ph-check-circle absolute top-2 right-2 text-[var(--accent-blue)] opacity-0 peer-checked:opacity-100 transition-opacity"></i>
                                    </div>
                                </label>
                            </div>
                        </div>
                        
                        <!-- Account Name -->
                        <div>
                            <label class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-3 flex items-center gap-2">
                                <i class="ph-bold ph-tag text-sm"></i>
                                Nome Account
                            </label>
                            <input type="text" id="a-name" value="${a.name}" placeholder="Es. FTMO 100k" required class="w-full px-5 py-4 bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:border-[var(--accent-blue)] focus:bg-white/10 focus:outline-none transition-all font-semibold">
                        </div>
                        
                        <!-- Balance Fields -->
                        <div class="grid grid-cols-1 md:grid-cols-2 gap-3 md:gap-4">
                            <div>
                                <label class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2 block flex items-center gap-2">
                                    <i class="ph-bold ph-coins text-sm"></i>
                                    Capitale Iniziale
                                </label>
                                <div class="relative">
                                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)] font-bold">$</span>
                                    <input type="number" id="a-size" value="${a.size}" placeholder="10000" step="100" required class="w-full pl-8 pr-4 py-3 bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:border-blue-500/50 focus:bg-white/10 focus:outline-none transition-all font-semibold">
                                </div>
                            </div>
                            <div>
                                <label class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-2 block flex items-center gap-2">
                                    <i class="ph-bold ph-trend-up text-sm"></i>
                                    Bilancio Attuale
                                </label>
                                <div class="relative">
                                    <span class="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)] font-bold">$</span>
                                    <input type="number" id="a-balance" value="${a.balance}" placeholder="10000.00" step="0.01" required class="w-full pl-8 pr-4 py-3 bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:border-blue-500/50 focus:bg-white/10 focus:outline-none transition-all font-semibold">
                                </div>
                            </div>
                        </div>
                        
                        <!-- Target & Max Drawdown (for Challenge & Funded) -->
                        <div id="target-fields" class="${a.type === 'challenge' || a.type === 'funded' ? '' : 'hidden'}">
                            <div class="bg-cyan-500/5 border border-cyan-500/20 rounded-xl p-4 space-y-4">
                                <div>
                                    <div class="flex items-center gap-2 mb-3">
                                        <i class="ph-bold ph-target text-lg text-cyan-400"></i>
                                        <label class="text-xs font-bold uppercase tracking-wider text-cyan-400">Profit Target (%)</label>
                                    </div>
                                    <div class="relative">
                                        <span class="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)] font-bold">%</span>
                                        <input type="number" id="a-target-pct" value="${a.targetPercent || ''}" placeholder="10" step="0.1" min="0" max="100" class="w-full pl-4 pr-10 py-3 bg-white/10 border border-cyan-500/20 rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:border-cyan-500/50 focus:bg-white/15 focus:outline-none transition-all font-semibold">
                                    </div>
                                    <p class="text-xs text-[var(--text-muted)] mt-2">Percentuale di profitto da raggiungere sul capitale iniziale</p>
                                </div>
                                <div>
                                    <div class="flex items-center gap-2 mb-3">
                                        <i class="ph-bold ph-trend-down text-lg text-cyan-400"></i>
                                        <label class="text-xs font-bold uppercase tracking-wider text-cyan-400">Max Drawdown (%)</label>
                                    </div>
                                    <div class="relative">
                                        <span class="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--text-muted)] font-bold">%</span>
                                        <input type="number" id="a-maxdd-pct" value="${a.maxDrawdownPercent || ''}" placeholder="5" step="0.1" min="0" max="100" class="w-full pl-4 pr-10 py-3 bg-white/10 border border-cyan-500/20 rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:border-cyan-500/50 focus:bg-white/15 focus:outline-none transition-all font-semibold">
                                    </div>
                                    <p class="text-xs text-[var(--text-muted)] mt-2">Percentuale massima di drawdown consentito sul capitale iniziale (opzionale)</p>
                                </div>
                            </div>
                        </div>
                        
                        <!-- Phase (only for Challenge) -->
                        <div id="phase-field" class="${a.type === 'challenge' ? '' : 'hidden'}">
                            <div class="bg-purple-500/5 border border-purple-500/20 rounded-xl p-4">
                                <div class="flex items-center gap-2 mb-3">
                                    <i class="ph-bold ph-steps text-lg text-purple-400"></i>
                                    <label class="text-xs font-bold uppercase tracking-wider text-purple-400">Fase Challenge</label>
                                </div>
                                <select id="a-phase" class="w-full px-4 py-3 bg-white/10 border border-purple-500/20 rounded-xl text-[var(--text-main)] focus:border-purple-500/50 focus:bg-white/15 focus:outline-none transition-all font-semibold">
                                    <option value="1" ${a.phase === 1 ? 'selected' : ''}>Fase 1</option>
                                    <option value="2" ${a.phase === 2 ? 'selected' : ''}>Fase 2</option>
                                    <option value="3" ${a.phase === 3 ? 'selected' : ''}>Fase 3</option>
                                </select>
                                <p class="text-xs text-[var(--text-muted)] mt-2">Seleziona in quale fase della challenge ti trovi</p>
                            </div>
                        </div>

                        <!-- Capital.com Integration (only for Live) -->
                        <div id="capitalcom-fields" class="${a.type === 'live' ? '' : 'hidden'}">
                            <div class="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4 space-y-4">
                                <div class="flex items-center justify-between mb-2">
                                    <div class="flex items-center gap-2">
                                        <i class="ph-bold ph-plugs-connected text-lg text-emerald-400"></i>
                                        <label class="text-xs font-bold uppercase tracking-wider text-emerald-400">Integrazione Capital.com</label>
                                    </div>
                                    <label class="relative inline-flex items-center cursor-pointer">
                                        <input type="checkbox" id="a-capitalcom-connected" class="sr-only peer" ${a.capitalComConnected ? 'checked' : ''} onchange="ui.toggleCapitalComSetup()">
                                        <div class="w-11 h-6 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-emerald-500"></div>
                                    </label>
                                </div>
                                
                                <div id="capitalcom-setup" class="${a.capitalComConnected ? '' : 'hidden'} space-y-3 pt-3 border-t border-emerald-500/20">
                                    <p class="text-xs text-[var(--text-muted)] mb-3">Inserisci le credenziali API Capital.com. Richiede il proxy locale attivo (<code class="text-emerald-400 bg-emerald-900/30 px-1 rounded">node proxy-server.js</code>).</p>
                                    <div>
                                        <label class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1 block">Email Account Capital.com</label>
                                        <input type="email" id="a-capitalcom-email" value="${a.capitalComEmail || ''}" placeholder="es. trader@email.com" class="w-full px-4 py-2 bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:border-emerald-500/50 focus:bg-white/15 focus:outline-none transition-all font-semibold">
                                    </div>
                                    <div>
                                        <label class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1 block">API Key (da Impostazioni → Integrazioni API)</label>
                                        <input type="text" id="a-capitalcom-api" value="${a.capitalComApiKey || ''}" placeholder="Inserisci API Key" class="w-full px-4 py-2 bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:border-emerald-500/50 focus:bg-white/15 focus:outline-none transition-all font-semibold">
                                    </div>
                                    <div>
                                        <label class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1 block">Password Account Capital.com</label>
                                        <input type="password" id="a-capitalcom-secret" value="${a.capitalComSecret || ''}" placeholder="Inserisci Password" class="w-full px-4 py-2 bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl text-[var(--text-main)] placeholder-[var(--text-muted)] focus:border-emerald-500/50 focus:bg-white/15 focus:outline-none transition-all font-semibold">
                                    </div>
                                    <div>
                                        <label class="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)] mb-1 block">Ambiente</label>
                                        <select id="a-capitalcom-env" class="w-full px-4 py-2 bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl text-[var(--text-main)] focus:border-emerald-500/50 focus:bg-white/15 focus:outline-none transition-all font-semibold">
                                            <option value="live" ${(a.capitalComEnvironment || 'live') === 'live' ? 'selected' : ''}>Live (Conto Reale)</option>
                                            <option value="demo" ${a.capitalComEnvironment === 'demo' ? 'selected' : ''}>Demo</option>
                                        </select>
                                    </div>
                                    <button type="button" onclick="ui.testCapitalComConnection()" class="w-full py-2.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/40 text-emerald-400 font-bold text-xs uppercase tracking-wider transition-all flex items-center justify-center gap-2">
                                        <i class="ph-bold ph-wifi-high"></i> Testa Connessione
                                    </button>
                                </div>
                            </div>
                        </div>

                    </form>
                </div>

                <!-- Footer -->
                <div class="flex items-center justify-end px-8 py-6 border-t border-white/10 bg-black/10 gap-3">
                    <button onclick="ui.closeModals()" class="px-6 py-3 rounded-xl text-sm font-bold text-[var(--text-muted)] hover:text-white preserve-white hover:bg-white/10 transition-all border border-white/10">
                        Annulla
                    </button>
                    <button onclick="event.preventDefault(); ui.saveAccount(${isEdit ? a.id : ''})" class="px-8 py-3 rounded-xl text-sm font-bold text-white preserve-white bg-[var(--accent-blue)] hover:bg-blue-600 transition-all flex items-center gap-2">
                        <i class="ph-bold ph-check-circle text-lg"></i>
                        <span>${isEdit ? 'Salva Modifiche' : 'Crea Conto'}</span>
                    </button>
                </div>
            </div>
        `;
    },

    openNewAccountModal() {
        const modal = document.getElementById('modal-account');
        if (!modal) return;
        modal.innerHTML = ui.renderAccountModalContent(null);
        ui.openModal('modal-account');
    },

    openEditAccountModal(accountId) {
        const account = DataStore.data.accounts.find(a => a.id === accountId);
        if (!account) {
            ui.showToast('⚠️ Account non trovato');
            return;
        }
        const modal = document.getElementById('modal-account');
        if (!modal) return;
        modal.innerHTML = ui.renderAccountModalContent(account);
        ui.openModal('modal-account');
    },

    toggleAccountFields() {
        const type = document.querySelector('input[name="acc_type"]:checked').value;
        const targetFields = document.getElementById('target-fields');
        const phaseField = document.getElementById('phase-field');
        const capitalComFields = document.getElementById('capitalcom-fields');

        if (type === 'challenge' || type === 'funded') {
            targetFields.classList.remove('hidden');
        } else {
            targetFields.classList.add('hidden');
        }

        if (type === 'challenge') {
            phaseField.classList.remove('hidden');
        } else {
            phaseField.classList.add('hidden');
        }

        if (type === 'live') {
            if (capitalComFields) capitalComFields.classList.remove('hidden');
        } else {
            if (capitalComFields) capitalComFields.classList.add('hidden');
        }
    },

    toggleCapitalComSetup() {
        const isConnected = document.getElementById('a-capitalcom-connected').checked;
        const setupDiv = document.getElementById('capitalcom-setup');
        if (setupDiv) {
            if (isConnected) {
                setupDiv.classList.remove('hidden');
            } else {
                setupDiv.classList.add('hidden');
            }
        }
    },

    saveAccount(id) {
        const type = document.querySelector('input[name="acc_type"]:checked').value;
        let targetPercent = 0;
        let maxDrawdownPercent = 0;
        let phase = 1;

        const size = parseFloat(document.getElementById('a-size').value) || 0;

        if (type === 'challenge' || type === 'funded') {
            targetPercent = parseFloat(document.getElementById('a-target-pct').value) || 0;
            maxDrawdownPercent = parseFloat(document.getElementById('a-maxdd-pct').value) || 0;
        }

        if (type === 'challenge') {
            phase = parseInt(document.getElementById('a-phase').value) || 1;
            if (!targetPercent) {
                return;
            }
        }

        // Calcola i valori assoluti dalle percentuali
        const target = size + (size * targetPercent / 100);
        const maxDrawdown = size * maxDrawdownPercent / 100;

        let capitalComConnected = false;
        let capitalComApiKey = '';
        let capitalComSecret = '';
        let capitalComEmail = '';
        let capitalComEnvironment = 'live';

        if (type === 'live') {
            const ccCb = document.getElementById('a-capitalcom-connected');
            if (ccCb) {
                capitalComConnected = ccCb.checked;
                capitalComApiKey = document.getElementById('a-capitalcom-api')?.value || '';
                capitalComSecret = document.getElementById('a-capitalcom-secret')?.value || '';
                capitalComEmail = document.getElementById('a-capitalcom-email')?.value || '';
                capitalComEnvironment = document.getElementById('a-capitalcom-env')?.value || 'live';
            }
        }

        const a = {
            id: id || Date.now(),
            name: document.getElementById('a-name').value,
            size: size,
            balance: parseFloat(document.getElementById('a-balance').value) || 0,
            type: type,
            target: target,
            targetPercent: targetPercent,
            maxDrawdown: maxDrawdown,
            maxDrawdownPercent: maxDrawdownPercent,
            phase: phase,
            capitalComConnected: capitalComConnected,
            capitalComApiKey: capitalComApiKey,
            capitalComSecret: capitalComSecret,
            capitalComEmail: capitalComEmail,
            capitalComEnvironment: capitalComEnvironment
        };

        if (!a.name || !a.size) { return; }

        if (id) {
            const idx = DataStore.data.accounts.findIndex(acc => acc.id === id);
            if (idx !== -1) DataStore.data.accounts[idx] = a;
        } else {
            DataStore.data.accounts.push(a);
        }

        DataStore.save();
        ui.closeModals();
        if (router.currentPage === 'accounts') router.navigate('accounts');
        else if (router.currentPage === 'system') router.navigate('system');

        // Se Capital.com è stato appena collegato, avvia il polling del saldo
        if (a.capitalComConnected && a.capitalComApiKey) {
            ui.startCapitalComBalancePolling();
            // Avvia anche la sincronizzazione dei trade in background
            setTimeout(() => ui.syncBrokerTrades(true), 3000);
        }
    },

    deleteAccount(e, id) { e.stopPropagation(); if (confirm('Eliminare conto?')) { DataStore.deleteAccount(id); if (router.currentPage === 'accounts') router.navigate('accounts'); else if (router.currentPage === 'system') router.navigate('system'); } },

    // NEW HELPER: Select Account in Payout Modal
    selectAccountInPayoutModal(id, btn) {
        document.getElementById('p-acc-id').value = id;
        document.querySelectorAll('.payout-acc-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
    },

    // Renders the *entire* Payout modal content string
    renderPayoutModalContent(defaultAccountId) {
        const accs = DataStore.data.accounts.filter(a => a.type === 'live' || a.type === 'funded');
        const buttonsHtml = accs.map((a, index) => {
            const isActive = a.id == defaultAccountId;
            return `
                        <button type="button" 
                            onclick="ui.selectAccountInPayoutModal(${a.id}, this)"
                            class="payout-acc-btn px-4 py-2.5 rounded-xl font-bold text-sm ${isActive ? 'bg-green-500/20 border-2 border-green-500 text-green-400' : 'bg-[var(--input-bg)] border-2 border-white/10 text-[var(--text-muted)] hover:border-white/20'} transition-all" 
                            data-id="${a.id}">
                            <div class="flex items-center gap-2">
                                <i class="ph-fill ph-wallet"></i>
                                <span>${a.name}</span>
                                <span class="text-xs opacity-70">(${ui.formatCurrency(a.balance)})</span>
                            </div>
                        </button>
                    `;
        }).join('');

        return `
                    <div class="relative bg-gradient-to-br from-[var(--bg-card)] to-[var(--bg-card)]/80 w-full max-w-lg rounded-2xl overflow-hidden border border-white/10 shadow-2xl transform transition-all scale-100">
                        <!-- Header -->
                        <div class="relative px-8 py-6 border-b border-white/10">
                            <div class="relative flex justify-between items-center">
                                <div class="flex items-center gap-4">
                                    <div class="w-14 h-14 rounded-2xl bg-green-500 flex items-center justify-center">
                                        <i class="ph-fill ph-bank text-white preserve-white text-3xl"></i>
                                    </div>
                                    <div>
                                        <h3 class="text-2xl font-bold text-white preserve-white tracking-tight">Richiesta Payout</h3>
                                        <p class="text-sm text-[var(--text-muted)] mt-1">
                                            Preleva i tuoi profitti
                                        </p>
                                    </div>
                                </div>
                                <button onclick="ui.closeModals()" class="w-11 h-11 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 flex items-center justify-center transition-all">
                                    <i class="ph-bold ph-x text-xl text-[var(--text-muted)]"></i>
                                </button>
                            </div>
                        </div>

                        <!-- Body -->
                        <div class="px-8 py-6 space-y-6">
                            <input type="hidden" id="p-acc-id" value="${defaultAccountId}">

                            <!-- Selezione Account -->
                            <div class="p-5 rounded-2xl bg-white/5 border border-white/10">
                                <label class="flex items-center gap-2 text-xs font-bold text-[var(--text-muted)] uppercase mb-4">
                                    <i class="ph-bold ph-wallet text-sm"></i>
                                    Seleziona Conto
                                </label>
                                <div id="p-acc-buttons" class="flex flex-col gap-2">
                                    ${buttonsHtml}
                                </div>
                            </div>

                            <!-- Importo -->
                            <div>
                                <label class="flex items-center gap-2 text-xs font-bold text-[var(--text-muted)] uppercase mb-3">
                                    <i class="ph-bold ph-currency-dollar text-sm"></i>
                                    Importo Payout
                                </label>
                                <div class="relative flex items-center">
                                    <span class="absolute left-5 text-2xl font-bold text-green-400 z-10 pointer-events-none">$</span>
                                    <input type="number" id="p-amount" step="0.01"
                                        class="w-full pl-12 pr-6 py-4 bg-white/5 border border-white/10 focus:border-green-500 rounded-xl text-white preserve-white placeholder-white/20 focus:bg-white/10 focus:outline-none transition-all font-bold text-2xl"
                                        placeholder="0.00">
                                </div>
                            </div>

                            <!-- Info Box -->
                            <div class="p-4 bg-white/5 rounded-xl border border-white/10 flex gap-3">
                                <i class="ph-fill ph-info text-[var(--text-muted)] text-lg"></i>
                                <p class="text-xs text-[var(--text-muted)] leading-relaxed">Il payout verrà sottratto automaticamente dal saldo del conto e registrato nello storico dei trade.</p>
                            </div>

                            <!-- Pulsante Conferma -->
                            <button onclick="ui.processPayout()"
                                class="w-full bg-green-500 hover:bg-green-600 text-white preserve-white font-bold py-4 rounded-xl transition-all flex items-center justify-center gap-2">
                                <i class="ph-bold ph-check-circle text-xl"></i>
                                <span>Conferma Payout</span>
                            </button>
                        </div>
                    </div>
                `;
    },

    // UPDATED: openPayoutModal
    openPayoutModal(defaultAccId) {
        const accs = DataStore.data.accounts.filter(a => a.type === 'live' || a.type === 'funded');
        if (accs.length === 0) {
            ui.showToast('Nessun account Live o Funded disponibile');
            return;
        }

        const initialAccId = defaultAccId || accs[0].id;
        const modal = document.getElementById('modal-payout');
        if (!modal) return;

        modal.innerHTML = ui.renderPayoutModalContent(initialAccId);

        // Assicura che l'input amount sia vuoto
        document.getElementById('p-amount').value = '';

        ui.openModal('modal-payout');
    },

    // UPDATED: processPayout
    processPayout() {
        const id = document.getElementById('p-acc-id').value;
        const amt = document.getElementById('p-amount').value;

        if (!id) {
            ui.showToast('Seleziona un conto');
            return;
        }

        if (!amt || isNaN(parseFloat(amt)) || parseFloat(amt) <= 0) {
            ui.showToast('Inserisci un importo valido');
            return;
        }

        if (id && amt) {
            DataStore.payout(parseInt(id), parseFloat(amt));
            ui.closeModals();
            // Ricarica la dashboard per aggiornare la chart
            router.navigate('dashboard');
            ui.showToast('Payout registrato!');
        }
    },

    exportData() {
        // Assicura che il profilo sia sempre incluso nell'export
        const dataToExport = {
            ...DataStore.data,
            profile: DataStore.data.profile || {
                name: 'Trader',
                bio: 'Disciplina. Pazienza. Costanza.',
                avatar: '👤',
                tradingSince: new Date().toISOString().split('T')[0],
                achievements: []
            }
        };
        console.log('Esportazione dati con profilo:', dataToExport.profile);
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(dataToExport));
        const downloadAnchorNode = document.createElement('a');
        downloadAnchorNode.setAttribute("href", dataStr);
        downloadAnchorNode.setAttribute("download", "eazytrader_backup_" + new Date().toISOString().slice(0, 10) + ".json");
        document.body.appendChild(downloadAnchorNode);
        downloadAnchorNode.click();
        downloadAnchorNode.remove();
    },

    async resetAllData() {
        if (!confirm('Cancellare TUTTI i dati? Questa azione e` irreversibile.')) return;

        try {
            await db.delete();
        } catch (error) {
            console.warn('Reset DB: impossibile eliminare IndexedDB, continuo con cleanup locale.', error);
        }

        [
            'eazytrader_v11',
            'eazytrader_last_page',
            'eazytrader_onboarding_complete',
            'eazytrader_theme_manual',
            'news_cache',
            'news_cache_time'
        ].forEach((key) => localStorage.removeItem(key));

        location.reload();
    },

    // LOGICA DI IMPORT MODIFICATA PER SUPPORTO ARRAY DI TRADE
    importData(input) {
        const file = input.files[0];
        if (!file) return;
        const reader = new FileReader();

        reader.onload = async (e) => {
            try {
                const json = JSON.parse(e.target.result);
                const firstAccountId = DataStore.data.accounts.length ? DataStore.data.accounts[0].id : '';

                // 1. Importazione Backup COMPLETO
                if (typeof json === 'object' && json !== null && Array.isArray(json.trades)) {
                    if (confirm('Importare il backup COMPLETO? I dati attuali verranno sovrascritti.')) {
                        // Normalizza reviews aggiungendo campo images se mancante
                        if (Array.isArray(json.reviews)) {
                            json.reviews = json.reviews.map(r => ({
                                ...r,
                                images: r.images || []
                            }));
                        }

                        // Normalizza trades aggiungendo campo images se mancante
                        if (Array.isArray(json.trades)) {
                            json.trades = json.trades.map(t => ({
                                ...t,
                                images: t.images || []
                            }));
                        }

                        // Normalizza profilo per garantire struttura completa
                        const defaultProfile = {
                            name: 'Trader',
                            bio: 'Disciplina. Pazienza. Costanza.',
                            avatar: '👤',
                            tradingSince: new Date().toISOString().split('T')[0],
                            achievements: []
                        };

                        // Se il profilo non esiste nei dati importati, usa quello attuale o il default
                        if (!json.profile) {
                            json.profile = DataStore.data.profile || defaultProfile;
                        } else {
                            // Merge per garantire tutti i campi
                            json.profile = { ...defaultProfile, ...json.profile };
                        }

                        json.profile.name = this.sanitizeText(json.profile.name || 'Trader', 40) || 'Trader';
                        json.profile.bio = this.sanitizeText(json.profile.bio || '', 280);
                        json.profile.photoUrl = this.sanitizeImageUrl(json.profile.photoUrl || '');

                        console.log('Import backup completo - Profilo:', json.profile);

                        DataStore.data = { ...DataStore.data, ...json };
                        await DataStore.save();
                        ui.showToast('Backup completo importato con successo!');
                        location.reload();
                    }
                }
                // 2. Importazione Array di Trade (MT4/MT5 Export style)
                else if (Array.isArray(json) && json.length > 0) {
                    if (!firstAccountId) {
                        ui.showToast('⚠️ Crea almeno un conto prima di importare');
                        return;
                    }

                    if (confirm(`Importare ${json.length} nuovi trade? I trade verranno AGGIUNTI allo storico attuale.`)) {
                        let newTradesCount = 0;

                        // Mappa e normalizza i trade importati
                        const newTrades = json.map(t => {
                            // Validazione minimale
                            if (!t.asset || !t.date || typeof t.pnl === 'undefined') return null;

                            const parsedDate = new Date(t.date);
                            if (Number.isNaN(parsedDate.getTime())) return null;

                            newTradesCount++;
                            return {
                                id: Date.now() + newTradesCount, // ID Unico
                                type: 'trade',
                                asset: (t.asset || 'N/A').toUpperCase(),
                                date: parsedDate.toISOString(), // Normalizza data
                                direction: (t.direction || (t.pnl >= 0 ? 'LONG' : 'SHORT')).toUpperCase(),
                                pnl: parseFloat(t.pnl) || 0,
                                status: 'executed',
                                rr: t.rr || '',
                                session: t.session || 'N/A',
                                strategy: t.strategy || 'N/A',
                                notes: t.notes || 'Importato da Export Esterno.',
                                mistakes: t.mistakes || '',
                                improvements: t.improvements || '',
                                images: t.images || [],
                                timeframe: t.timeframe || 'H4',
                                accountId: firstAccountId // Assegna al primo conto disponibile
                            };
                        }).filter(t => t !== null);

                        if (newTrades.length > 0) {
                            // Aggiungi i trade in testa all'array
                            DataStore.data.trades.unshift(...newTrades);
                            await DataStore.save();
                            ui.showToast(`${newTrades.length} trade importati con successo!`);

                            if (router.currentPage === 'journal') router.journal();
                            else if (router.currentPage === 'dashboard') router.dashboard();
                            else if (['system', 'settings', 'accounts'].includes(router.currentPage)) router.navigate('system');

                        } else {
                            ui.showToast('⚠️ Nessun trade valido nel file');
                        }
                    }
                }
                // 3. File non valido
                else {
                    ui.showToast('⚠️ File non valido. Usa un backup EazyTrader');
                }

            } catch (err) {
                ui.showToast('❌ Errore durante l\'analisi del file JSON');
            }
        };

        reader.readAsText(file);
    },

    formatCurrency(n) { return isNaN(n) ? '$0.00' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(n); },
    formatDate(s) { return new Date(s).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }); },
    formatDateKey(date) { const d = new Date(date); const year = d.getFullYear(); const month = String(d.getMonth() + 1).padStart(2, '0'); const day = String(d.getDate()).padStart(2, '0'); return `${year}-${month}-${day}`; },

    setupScrollProgress() {
        const progress = document.getElementById('scroll-progress');
        const scrollHost = document.getElementById('main-content');
        if (!progress) return;
        if (!scrollHost) return;

        scrollHost.addEventListener('scroll', () => {
            const scrollTop = scrollHost.scrollTop;
            const height = scrollHost.scrollHeight - scrollHost.clientHeight;
            const scrolled = height > 0 ? (scrollTop / height) * 100 : 0;
            progress.style.width = scrolled + '%';
        });
    },

    celebrateSuccess() {
        const confetti = document.createElement('div');
        confetti.className = 'fixed inset-0 pointer-events-none z-[100] flex items-center justify-center';
        confetti.innerHTML = `
            <div class="text-8xl animate-bounce">🎉</div>
        `;
        document.body.appendChild(confetti);
        setTimeout(() => confetti.remove(), 2000);
    },

    // ==========================================
    // PLAYBOOK
    // ==========================================
    // Regole e immagini valorizzate di un setup, contate in modo difensivo:
    // i dati vecchi possono avere campi mancanti o righe vuote.
    countSetupRules(setup) {
        return (setup.rules || []).filter(r => String(r).trim() !== '').length;
    },

    countSetupImages(setup) {
        return (setup.images || []).length;
    },

    // Colore del win rate: unica eccezione al monocromatico, perché qui il
    // colore porta informazione.
    setupWinRateColor(winRate) {
        const n = parseFloat(winRate);
        if (isNaN(n)) return null;
        if (n >= 60) return 'var(--accent-green)';
        if (n >= 45) return 'var(--accent-orange)';
        return 'var(--accent-red)';
    },

    playbook() {
        if (!ui.container) return;
        const setups = DataStore.data.playbook || [];

        const totalRules = setups.reduce((acc, s) => acc + ui.countSetupRules(s), 0);
        const totalImages = setups.reduce((acc, s) => acc + ui.countSetupImages(s), 0);
        const rated = setups.filter(s => !isNaN(parseFloat(s.winRate)));
        const avgWr = rated.length
            ? (rated.reduce((acc, s) => acc + parseFloat(s.winRate), 0) / rated.length).toFixed(0)
            : null;

        const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
        const subtitle = setups.length
            ? `${plural(setups.length, 'setup', 'setup')} · ${plural(totalRules, 'regola', 'regole')} · ${plural(totalImages, 'esempio', 'esempi')}`
            : 'Le tue strategie operative, documentate in un unico posto.';

        ui.container.innerHTML = `
        <div class="pb-page fade-in">

            <header class="pb-header">
                <div class="min-w-0">
                    <h1 class="pb-title">Playbook</h1>
                    <p class="pb-subtitle">${subtitle}</p>
                </div>
                <button onclick="ui.openSetupModal()" class="pb-btn pb-btn-primary preserve-white">
                    <i class="ph-bold ph-plus"></i>
                    <span>Nuovo setup</span>
                </button>
            </header>

            ${setups.length ? `
            <section class="pb-stats">
                <div class="pb-stat">
                    <span class="pb-stat-value">${setups.length}</span>
                    <span class="pb-stat-label">Setup</span>
                </div>
                <div class="pb-stat">
                    <span class="pb-stat-value">${totalRules}</span>
                    <span class="pb-stat-label">Regole</span>
                </div>
                <div class="pb-stat">
                    <span class="pb-stat-value">${totalImages}</span>
                    <span class="pb-stat-label">Esempi</span>
                </div>
                <div class="pb-stat">
                    <span class="pb-stat-value" ${avgWr !== null ? `style="color:${ui.setupWinRateColor(avgWr)}"` : ''}>${avgWr !== null ? avgWr + '%' : '—'}</span>
                    <span class="pb-stat-label">Win rate medio</span>
                </div>
            </section>
            ` : ''}

            ${setups.length === 0 ? `
            <section class="pb-empty">
                <div class="pb-empty-icon"><i class="ph-bold ph-book-open-text"></i></div>
                <h3>Nessun setup definito</h3>
                <p>Documenta le tue strategie: regole di ingresso, screenshot di riferimento e win rate, cosi' da avere sempre un criterio chiaro prima di entrare a mercato.</p>
                <button onclick="ui.openSetupModal()" class="pb-btn pb-btn-primary preserve-white">
                    <i class="ph-bold ph-plus"></i>
                    <span>Crea il primo setup</span>
                </button>
            </section>
            ` : `
            <section class="pb-grid">
                ${setups.map(s => {
                    const rulesCount = ui.countSetupRules(s);
                    const imagesCount = ui.countSetupImages(s);
                    const cover = imagesCount ? s.images[0] : null;
                    const wrColor = ui.setupWinRateColor(s.winRate);
                    return `
                <article class="pb-card" onclick="ui.openSetupViewModal(${s.id})">
                    <div class="pb-card-media${cover ? '' : ' pb-card-media--empty'}"${cover ? ` style="background-image:url(${cover})"` : ''}>
                        ${cover ? '' : '<i class="ph-bold ph-chart-line-up"></i>'}
                        ${imagesCount > 1 ? `<span class="pb-chip pb-chip--count"><i class="ph-bold ph-images"></i>${imagesCount}</span>` : ''}
                        ${wrColor ? `<span class="pb-chip pb-chip--wr"><span style="width:6px;height:6px;border-radius:999px;background:${wrColor}"></span>${s.winRate}%</span>` : ''}
                    </div>

                    <div class="pb-card-body">
                        <h3 class="pb-card-title">${s.name}</h3>
                        <p class="pb-card-desc">${s.description || 'Nessuna descrizione.'}</p>
                    </div>

                    <div class="pb-card-foot">
                        <div class="pb-meta">
                            <span><i class="ph-bold ph-list-checks"></i>${rulesCount}</span>
                            <span><i class="ph-bold ph-image"></i>${imagesCount}</span>
                        </div>
                        <button onclick="event.stopPropagation(); ui.openSetupModal(${s.id})" class="pb-icon-btn" title="Modifica setup" aria-label="Modifica setup">
                            <i class="ph-bold ph-pencil-simple"></i>
                        </button>
                    </div>
                </article>
                `}).join('')}
            </section>
            `}
        </div>
        `;
    },

    openSetupViewModal(id) {
        const setup = DataStore.data.playbook.find(x => x.id == id);
        if (!setup) return;

        const modal = document.getElementById('modal-setup-view');
        if (!modal) return;

        const rules = (setup.rules || []).filter(r => String(r).trim() !== '');
        const images = setup.images || [];
        const wrColor = ui.setupWinRateColor(setup.winRate);

        const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
        const metaLine = [
            wrColor ? `<span style="color:${wrColor};font-weight:600">${setup.winRate}% win rate</span>` : null,
            plural(rules.length, 'regola', 'regole'),
            plural(images.length, 'esempio', 'esempi')
        ].filter(Boolean).join(' · ');

        modal.innerHTML = `
            <div class="pb-modal pb-modal--wide">
                <header class="pb-modal-head">
                    <div class="min-w-0">
                        <h3 class="pb-modal-heading">${setup.name}</h3>
                        <p class="pb-modal-sub">${metaLine}</p>
                    </div>
                    <button onclick="ui.closeModals()" class="pb-icon-btn" title="Chiudi" aria-label="Chiudi">
                        <i class="ph-bold ph-x"></i>
                    </button>
                </header>

                <div class="pb-modal-body custom-scrollbar">
                    ${images.length ? `
                    <img src="${images[0]}" class="pb-hero" alt="Esempio del setup" onclick="ui.viewFullImage('${images[0]}')">
                    ` : ''}

                    ${setup.description ? `
                    <section>
                        <span class="pb-section-label">Contesto</span>
                        <p class="pb-prose">${setup.description}</p>
                    </section>
                    ` : ''}

                    ${rules.length ? `
                    <section>
                        <span class="pb-section-label">Checklist di ingresso</span>
                        <div class="pb-rules">
                            ${rules.map((r, i) => `
                            <div class="pb-rule">
                                <span class="pb-rule-num">${String(i + 1).padStart(2, '0')}</span>
                                <span>${r}</span>
                            </div>
                            `).join('')}
                        </div>
                    </section>
                    ` : ''}

                    ${images.length > 1 ? `
                    <section>
                        <span class="pb-section-label">Esempi (${images.length})</span>
                        <div class="pb-gallery">
                            ${images.map(img => `
                            <div class="pb-thumb" style="background-image:url(${img})" onclick="ui.viewFullImage('${img}')"></div>
                            `).join('')}
                        </div>
                    </section>
                    ` : ''}

                    ${!setup.description && !rules.length && !images.length ? `
                    <p class="pb-prose" style="color:var(--text-muted)">Questo setup non ha ancora contenuti. Aprilo in modifica per aggiungere contesto, regole ed esempi.</p>
                    ` : ''}
                </div>

                <footer class="pb-modal-foot">
                    <button onclick="ui.deleteSetup(${setup.id})" class="pb-btn pb-btn-danger">
                        <i class="ph-bold ph-trash"></i>
                        <span>Elimina</span>
                    </button>
                    <button onclick="ui.closeModals(); setTimeout(() => ui.openSetupModal(${setup.id}), 200)" class="pb-btn pb-btn-primary preserve-white">
                        <i class="ph-bold ph-pencil-simple"></i>
                        <span>Modifica</span>
                    </button>
                </footer>
            </div>
        `;

        ui.openModal('modal-setup-view');
    },

    openSetupModal(id = null) {
        let setup = { name: '', description: '', rules: ['', '', ''], winRate: '', images: [] };
        if (id) {
            const found = DataStore.data.playbook.find(x => x.id == id);
            if (found) setup = { ...found };
            if (!setup.rules || setup.rules.length === 0) setup.rules = ['', '', ''];
        }
        
        ui.tempImages = setup.images ? [...setup.images] : [];
        
        const modal = document.getElementById('modal-setup');
        if (!modal) return;

        modal.innerHTML = `
            <div class="pb-modal">
                <header class="pb-modal-head">
                    <div class="min-w-0">
                        <h3 class="pb-modal-heading">${id ? 'Modifica setup' : 'Nuovo setup'}</h3>
                        <p class="pb-modal-sub">Definisci le condizioni che devono essere vere prima di entrare.</p>
                    </div>
                    <button onclick="ui.closeModals()" class="pb-icon-btn" title="Chiudi" aria-label="Chiudi">
                        <i class="ph-bold ph-x"></i>
                    </button>
                </header>

                <div class="pb-modal-body custom-scrollbar">
                    <input type="hidden" id="s-id" value="${setup.id || ''}">

                    <div class="pb-form-row">
                        <div>
                            <label class="pb-field-label" for="s-name">Nome</label>
                            <input type="text" id="s-name" class="pb-input" value="${setup.name}" placeholder="Es. Rottura e ritracciamento">
                        </div>
                        <div>
                            <label class="pb-field-label" for="s-wr">Win rate (%)</label>
                            <input type="number" id="s-wr" class="pb-input" value="${setup.winRate}" placeholder="65" min="0" max="100" style="text-align:center">
                        </div>
                    </div>

                    <div>
                        <label class="pb-field-label" for="s-desc">Contesto</label>
                        <textarea id="s-desc" class="pb-textarea" placeholder="In quali condizioni di mercato questo setup funziona, e in quali va evitato.">${setup.description}</textarea>
                    </div>

                    <div>
                        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:11px">
                            <label class="pb-field-label" style="margin:0">Regole di ingresso</label>
                            <button type="button" onclick="ui.addRuleInput()" class="pb-btn pb-btn-ghost" style="height:32px;padding:0 12px;font-size:13px">
                                <i class="ph-bold ph-plus"></i>
                                <span>Aggiungi</span>
                            </button>
                        </div>
                        <div id="rules-container" style="display:flex;flex-direction:column;gap:8px">
                            ${setup.rules.map(r => ui.ruleInputMarkup(r)).join('')}
                        </div>
                        <p class="pb-field-hint">Le righe lasciate vuote non vengono salvate.</p>
                    </div>

                    <div>
                        <label class="pb-field-label">Esempi</label>
                        <div id="drop-zone-setup" class="pb-drop">
                            <input type="file" id="file-input-setup" accept="image/*" multiple style="display:none">
                            <div id="drop-zone-content-setup">
                                <p class="pb-drop-title">Trascina qui gli screenshot</p>
                                <p class="pb-drop-hint">oppure tocca per sceglierli</p>
                            </div>
                            <div id="gallery-preview-setup" class="pb-preview" style="display:none"></div>
                        </div>
                        <button id="clear-imgs-btn-setup" type="button" class="pb-btn pb-btn-danger" style="margin-top:10px;display:none" onclick="event.stopPropagation(); ui.tempImages=[]; ui.renderTempImagesSetup();">
                            <i class="ph-bold ph-trash"></i>
                            <span>Rimuovi tutti gli esempi</span>
                        </button>
                    </div>
                </div>

                <footer class="pb-modal-foot">
                    ${id ? `
                    <button onclick="ui.deleteSetup(${id})" class="pb-btn pb-btn-danger">
                        <i class="ph-bold ph-trash"></i>
                        <span>Elimina</span>
                    </button>
                    ` : '<span></span>'}
                    <div style="display:flex;gap:10px">
                        <button onclick="ui.closeModals()" class="pb-btn pb-btn-ghost">Annulla</button>
                        <button onclick="ui.saveSetup()" class="pb-btn pb-btn-primary preserve-white">Salva setup</button>
                    </div>
                </footer>
            </div>
        `;

        ui.openModal('modal-setup');
        ui.renderTempImagesSetup();

        // Setup Image Upload Handlers
        const dropZone = document.getElementById('drop-zone-setup');
        const fileInput = document.getElementById('file-input-setup');
        if (dropZone && fileInput) {
            dropZone.onclick = (e) => {
                if (e.target.closest('#clear-imgs-btn-setup') || e.target.closest('.pb-preview-remove')) return;
                fileInput.click();
            };
            dropZone.ondragover = (e) => { e.preventDefault(); dropZone.classList.add('is-dragging'); };
            dropZone.ondragleave = () => dropZone.classList.remove('is-dragging');
            dropZone.ondrop = (e) => { e.preventDefault(); dropZone.classList.remove('is-dragging'); ui.handleFileSelect(e, 'setup'); };
            fileInput.onchange = (e) => ui.handleFileSelect(e, 'setup');
        }
    },

    ruleInputMarkup(value = '') {
        return `
            <div class="pb-rule-edit">
                <input type="text" class="rule-input pb-input" value="${value}" placeholder="Condizione da verificare prima di entrare">
                <button type="button" class="pb-rule-remove" title="Rimuovi regola" aria-label="Rimuovi regola" onclick="this.parentElement.remove()">
                    <i class="ph-bold ph-x"></i>
                </button>
            </div>
        `;
    },

    addRuleInput() {
        const container = document.getElementById('rules-container');
        if (!container) return;

        container.insertAdjacentHTML('beforeend', ui.ruleInputMarkup());
        const added = container.lastElementChild?.querySelector('.rule-input');
        if (added) added.focus();
    },

    renderTempImagesSetup() {
        const gallery = document.getElementById('gallery-preview-setup');
        const placeholder = document.getElementById('drop-zone-content-setup');
        const clearBtn = document.getElementById('clear-imgs-btn-setup');
        if (!gallery || !placeholder || !clearBtn) return;

        gallery.innerHTML = '';

        // Display gestito inline: le classi utility di Tailwind e le classi
        // componente qui sotto hanno la stessa specificita', quindi l'ordine di
        // caricamento deciderebbe chi vince.
        if (!ui.tempImages.length) {
            gallery.style.display = 'none';
            placeholder.style.display = '';
            clearBtn.style.display = 'none';
            return;
        }

        gallery.style.display = 'flex';
        placeholder.style.display = 'none';
        clearBtn.style.display = 'inline-flex';

        ui.tempImages.forEach((src, index) => {
            const item = document.createElement('div');
            item.className = 'pb-preview-item';
            item.style.backgroundImage = `url(${src})`;
            item.onclick = (e) => { e.stopPropagation(); ui.viewFullImage(src); };

            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'pb-preview-remove preserve-white';
            remove.title = 'Rimuovi esempio';
            remove.setAttribute('aria-label', 'Rimuovi esempio');
            remove.innerHTML = '<i class="ph-bold ph-x"></i>';
            remove.onclick = (e) => {
                e.stopPropagation();
                ui.tempImages.splice(index, 1);
                ui.renderTempImagesSetup();
            };

            item.appendChild(remove);
            gallery.appendChild(item);
        });
    },

    saveSetup() {
        const name = document.getElementById('s-name').value.trim();
        if (!name) {
            ui.showToast('⚠️ Inserisci un nome per il setup');
            return;
        }
        
        const idVal = document.getElementById('s-id').value;
        const desc = document.getElementById('s-desc').value.trim();
        const wr = document.getElementById('s-wr').value.trim();
        
        // Raccogli le regole
        const ruleInputs = document.querySelectorAll('.rule-input');
        const rules = Array.from(ruleInputs).map(i => i.value.trim()).filter(v => v !== '');

        const setup = {
            id: idVal ? parseInt(idVal) : Date.now(),
            name,
            description: desc,
            winRate: wr,
            rules,
            images: ui.tempImages
        };

        DataStore.addSetup(setup);
        ui.tempImages = [];
        ui.closeModals();
        ui.showToast('✅ Setup salvato nel Playbook!');
        if (router.currentPage === 'playbook') router.playbook();
    },

    deleteSetup(id) {
        if (confirm('Sei sicuro di voler eliminare questo Setup?')) {
            DataStore.deleteSetup(id);
            ui.closeModals();
            ui.showToast('🗑️ Setup eliminato');
            if (router.currentPage === 'playbook') router.playbook();
        }
    }
};

window.ui = ui;
window.DataStore = DataStore;
window.router = router;

// MOBILE OPTIMIZATIONS
