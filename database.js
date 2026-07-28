// DEXIE DATABASE CONFIGURATION
// ==========================================
const db = new Dexie('EazyTraderDB');
// Versione aggiornata per includere la tabella 'playbook'
db.version(5).stores({
    trades: '++id, date, accountId, status, type',
    accounts: '++id, name, type',
    reviews: '++id, date, type, status',
    todos: '++id, day, completed',
    weeklyGoals: '++id, completed',
    settings: 'key',
    profile: 'key',
    playbook: '++id, name'
});

const DataStore = {
    data: {
        trades: [],
        accounts: [],
        reviews: [],
        todos: [],
        weeklyGoals: [],
        playbook: [],
        settings: {
            assets: ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD', 'NAS100', 'US30'],
            strategies: ['SMC', 'Breakout', 'Pullback'],
            sessions: ['London', 'New York', 'Asian'],
            lastAutoWeeklyGen: null,
            brokerConnections: {
                mt5: { enabled: false, apiKey: '', accountId: '', server: '', lastSync: null }
            }
        },
        profile: {
            name: 'Trader',
            bio: 'Disciplina. Pazienza. Costanza.',
            avatar: '👤',
            tradingSince: new Date().toISOString().split('T')[0],
            achievements: [],
            isPremium: false
        }
    },

    async init() {
        try {
            console.log('🔄 Avvio procedura di caricamento e ripristino dati...');

            // 1. Tenta il caricamento da entrambe le fonti
            const localDataInfo = localStorage.getItem('eazytrader_v11');
            let idbDataLoaded = false;
            let idbDataEmpty = true;

            try {
                await this.loadFromIndexedDB();
                // Verifichiamo se IDB ha restituito dati significativi
                if (this.data.trades.length > 0 || this.data.accounts.length > 0 || this.data.reviews.length > 0) {
                    idbDataLoaded = true;
                    idbDataEmpty = false;
                    console.log('✅ Dati caricati correttamente da IndexedDB.');
                } else {
                    console.log('⚠️ IndexedDB sembra vuoto.');
                }
            } catch (e) {
                console.warn('⚠️ Errore lettura IndexedDB:', e);
            }

            // 2. Logica di Ripristino / Migrazione / Backup
            if (idbDataLoaded) {
                // IDB è sano. Aggiorniamo il LocalStorage come backup di sicurezza
                console.log('💾 Sincronizzazione backup su LocalStorage...');
                try {
                    localStorage.setItem('eazytrader_v11', JSON.stringify(this.data));
                } catch (e) { console.warn('Impossibile salvare backup LS (quota?)', e); }

            } else if (localDataInfo) {
                // CASO CRITICO: IDB vuoto o rotto, ma abbiamo il vecchio LocalStorage
                const currentData = JSON.parse(localDataInfo);
                console.log('🚑 ATTENZIONE: Ripristino dati da LocalStorage (Recovery Mode)...');

                try {
                    // Merge intelligente: se IDB aveva parziali dati (es. settings) manteniamoli, ma diamo priorità al backup per le liste
                    this.data = { ...this.data, ...currentData };

                    // Salviamo subito su IDB per "guarire" la situazione
                    await this.saveToIndexedDB();
                    console.log('✅ Ripristino completato e salvato su DB.');

                    // NON CANCELLIAMO PIÙ IL LOCALSTORAGE! Rimane come safety net.
                } catch (e) {
                    console.error('❌ Errore critico nel parsing del backup LocalStorage:', e);
                }
            } else {
                console.log('ℹ️ Nessun dato trovato in nessuna memoria (Nuovo utente o pulizia profonda).');
            }

            // Normalizzazione e validazione dati
            if (!Array.isArray(this.data.trades)) this.data.trades = [];
            if (!Array.isArray(this.data.accounts)) this.data.accounts = [];
            if (!Array.isArray(this.data.reviews)) this.data.reviews = [];
            if (!Array.isArray(this.data.todos)) this.data.todos = [];
            if (!Array.isArray(this.data.weeklyGoals)) this.data.weeklyGoals = [];
            if (!Array.isArray(this.data.playbook)) this.data.playbook = [];
            if (!this.data.settings) this.data.settings = { assets: [], strategies: [], sessions: [] };

            if (this.data.settings.assets.length === 0) this.data.settings.assets = ['EURUSD', 'GBPUSD', 'XAUUSD', 'BTCUSD', 'NAS100', 'US30'];
            if (this.data.settings.strategies.length === 0) this.data.settings.strategies = ['SMC', 'Breakout', 'Pullback'];
            if (this.data.settings.sessions.length === 0) this.data.settings.sessions = ['London', 'New York', 'Asian'];
            if (!this.data.settings.brokerConnections) {
                this.data.settings.brokerConnections = {
                    mt5: { enabled: false, apiKey: '', accountId: '', server: '', lastSync: null }
                };
            }

            // Setup account di default se necessario
            if (this.data.accounts.length === 0) {
                this.data.accounts.push({
                    id: Date.now(),
                    name: 'Demo',
                    size: 10000,
                    balance: 10000,
                    type: 'funded',
                    lastModified: Date.now()
                });
                await this.save();
            }

            this.checkWeeklyGen();
        } catch (error) {
            console.error('❌ Errore durante init:', error);
            // Fallback: crea account demo
            if (this.data.accounts.length === 0) {
                this.data.accounts.push({
                    id: Date.now(),
                    name: 'Demo',
                    size: 10000,
                    balance: 10000,
                    type: 'funded',
                    lastModified: Date.now()
                });
            }
        }
    },

    async loadFromIndexedDB() {
        try {
            const [trades, accounts, reviews, todos, weeklyGoals, playbook, settingsRow, profileRow] = await Promise.all([
                db.trades.toArray(),
                db.accounts.toArray(),
                db.reviews.toArray(),
                db.todos.toArray(),
                db.weeklyGoals.toArray(),
                db.playbook.toArray(),
                db.settings.get('main'),
                db.profile.get('main')
            ]);

            this.data.trades = trades || [];
            this.data.accounts = accounts || [];
            this.data.reviews = reviews || [];
            this.data.todos = todos || [];
            this.data.weeklyGoals = weeklyGoals || [];
            this.data.playbook = playbook || [];
            if (settingsRow && settingsRow.value) {
                this.data.settings = { ...this.data.settings, ...settingsRow.value };
            }
            if (profileRow && profileRow.value) {
                this.data.profile = { ...this.data.profile, ...profileRow.value };
            }
        } catch (error) {
            console.error('Errore caricamento da IndexedDB:', error);
        }
    },

    async saveToIndexedDB() {
        try {
            await db.transaction('rw', db.trades, db.accounts, db.reviews, db.todos, db.weeklyGoals, db.playbook, db.settings, db.profile, async () => {
                await db.trades.clear();
                await db.accounts.clear();
                await db.reviews.clear();
                await db.todos.clear();
                await db.weeklyGoals.clear();
                await db.playbook.clear();

                if (this.data.trades.length) await db.trades.bulkAdd(this.data.trades);
                if (this.data.accounts.length) await db.accounts.bulkAdd(this.data.accounts);
                if (this.data.reviews.length) await db.reviews.bulkAdd(this.data.reviews);
                if (this.data.todos.length) await db.todos.bulkAdd(this.data.todos);
                if (this.data.weeklyGoals.length) await db.weeklyGoals.bulkAdd(this.data.weeklyGoals);
                if (this.data.playbook.length) await db.playbook.bulkAdd(this.data.playbook);

                await db.settings.put({ key: 'main', value: this.data.settings });
                await db.profile.put({ key: 'main', value: this.data.profile });
            });

        } catch (error) {
            console.error('Errore salvataggio in IndexedDB:', error);
        }
    },

    async save() {
        // Aggiungi timestamp di modifica
        const now = Date.now();

        this.data.trades.forEach(t => { if (!t.lastModified) t.lastModified = now; });
        this.data.accounts.forEach(a => { if (!a.lastModified) a.lastModified = now; });
        this.data.reviews.forEach(r => { if (!r.lastModified) r.lastModified = now; });
        this.data.todos.forEach(t => { if (!t.lastModified) t.lastModified = now; });
        this.data.weeklyGoals.forEach(g => { if (!g.lastModified) g.lastModified = now; });

        // Salva in IndexedDB
        await this.saveToIndexedDB();

        // 🛡️ DUAL SAVE: Backup su LocalStorage per sicurezza (iPad fix)
        // Questo protegge contro la cancellazione accidentale di IDB
        try {
            localStorage.setItem('eazytrader_v11', JSON.stringify(this.data));
        } catch (e) { /* Fallimento silenzioso se quota insufficiente */ }

        // ☁️ CLOUD SYNC: Push debounced su Firebase (se connesso)
        if (typeof CloudSync !== 'undefined' && CloudSync.status === 'connected') {
            CloudSync.debouncedPush();
        }
    },

    checkWeeklyGen() {
        const now = new Date();
        const day = now.getDay();

        if (day >= 1 && day <= 4) return;

        const targetDate = new Date(now);
        let daysToAdd = 0;
        if (day === 5) daysToAdd = 2;
        else if (day === 6) daysToAdd = 1;
        else if (day === 0) daysToAdd = 0;

        targetDate.setDate(now.getDate() + daysToAdd);
        targetDate.setHours(12, 0, 0, 0);

        const dateKey = targetDate.toISOString().split('T')[0];

        if (this.data.settings.lastAutoWeeklyGen === dateKey) return;

        const exists = this.data.reviews.find(r => r.type === 'weekly' && r.date.startsWith(dateKey));

        if (!exists) {
            this.addReview({
                id: Date.now(),
                date: targetDate.toISOString(),
                type: 'weekly',
                status: 'todo',
                rating: 0,
                mood: 'neutral',
                icon: '📅',
                generalNote: 'Revisione Settimanale',
                routine: null
            });
        }

        this.data.settings.lastAutoWeeklyGen = dateKey;
        this.save();
    },

    addTrade(t) {
        t.lastModified = Date.now();
        if (t.id && this.data.trades.some(x => x.id == t.id)) {
            const idx = this.data.trades.findIndex(x => x.id == t.id);
            const old = this.data.trades[idx];

            if (old.status === 'executed' && old.type !== 'payout') {
                const acc = this.data.accounts.find(a => a.id == old.accountId);
                if (acc) {
                    const pnlValue = parseFloat(old.pnl);
                    if (!isNaN(pnlValue)) {
                        acc.balance -= pnlValue;
                    }
                }
            }

            if (t.status === 'executed' && t.type !== 'payout') {
                const a = this.data.accounts.find(x => x.id == t.accountId);
                if (a) {
                    const pnlValue = parseFloat(t.pnl);
                    if (!isNaN(pnlValue)) {
                        a.balance += pnlValue;
                    }
                }
            }

            this.data.trades[idx] = t;
        } else {
            t.id = t.id || Date.now();
            t.date = t.date || new Date().toISOString();
            t.status = t.status || 'executed';
            t.type = t.type || 'trade';
            this.data.trades.unshift(t);

            if (t.status === 'executed' && t.type !== 'payout') {
                const a = this.data.accounts.find(x => x.id == t.accountId);
                if (a) {
                    const pnlValue = parseFloat(t.pnl);
                    if (!isNaN(pnlValue)) {
                        a.balance += pnlValue;
                    }
                }
            }
        }
        this.save();
    },
    deleteTrade(id) {
        const t = this.data.trades.find(x => x.id == id);
        if (t && t.status === 'executed' && t.type !== 'payout') {
            const acc = this.data.accounts.find(a => a.id == t.accountId);
            if (acc) {
                const pnlValue = parseFloat(t.pnl);
                if (!isNaN(pnlValue)) {
                    acc.balance -= pnlValue;
                }
            }
        }

        if (t && t.type === 'payout') {
            const acc = this.data.accounts.find(a => a.id == t.accountId);
            if (acc) {
                // Riemetti i soldi sul conto
                const pnlValue = parseFloat(t.pnl);
                if (!isNaN(pnlValue)) {
                    acc.balance -= pnlValue;
                }
            }
        }

        this.data.trades = this.data.trades.filter(x => x.id != id);
        if (typeof CloudSync !== 'undefined') CloudSync.trackDeletedItem('trades', id);
        this.save();
    },
    addAccount(a) { a.id = Date.now(); a.lastModified = Date.now(); this.data.accounts.push(a); this.save(); },
    deleteAccount(id) {
        this.data.accounts = this.data.accounts.filter(a => a.id != id);
        this.data.trades = this.data.trades.filter(t => t.accountId != id);

        if (this.data.accounts.length === 0) {
            this.data.accounts.push({
                id: Date.now(),
                name: 'Demo',
                size: 10000,
                balance: 10000,
                type: 'funded',
                lastModified: Date.now()
            });
        }

        if (typeof CloudSync !== 'undefined') CloudSync.trackDeletedItem('accounts', id);
        this.save();
    },

    payout(accountId, amount) {
        const acc = this.data.accounts.find(a => a.id === accountId);
        if (!acc) {
            console.error('Account non trovato');
            return;
        }

        const val = parseFloat(amount);
        if (isNaN(val) || val <= 0) {
            console.error('Importo non valido');
            return;
        }

        if (acc.balance < val) {
            console.error('Saldo insufficiente per il payout');
            alert('⚠️ Saldo insufficiente per effettuare il payout');
            return;
        }

        acc.balance -= val;

        if (!acc.payouts) acc.payouts = [];
        acc.payouts.push({
            date: new Date().toISOString(),
            amount: val
        });

        const payoutTrade = {
            id: Date.now(),
            type: 'payout',
            asset: 'PAYOUT',
            date: new Date().toISOString(),
            direction: 'SHORT',
            pnl: -val,
            status: 'executed',
            rr: '0R',
            accountId: accountId
        };
        this.data.trades.unshift(payoutTrade);

        this.save();
    },


    addReview(r) {
        r.lastModified = Date.now();
        if (r.id && this.data.reviews.some(x => x.id == r.id)) { const i = this.data.reviews.findIndex(x => x.id == r.id); this.data.reviews[i] = { ...this.data.reviews[i], ...r }; }
        else { r.id = r.id || Date.now(); r.date = r.date || new Date().toISOString(); r.status = r.status || 'completed'; this.data.reviews.unshift(r); }
        this.save();
    },
    deleteReview(id) { if (typeof CloudSync !== 'undefined') CloudSync.trackDeletedItem('reviews', id); this.data.reviews = this.data.reviews.filter(x => x.id != id); this.save(); },
    addTodo(t) { t.id = Date.now(); t.completed = false; t.lastModified = Date.now(); this.data.todos.push(t); this.save(); },
    updateTodo(id, updates) { const t = this.data.todos.find(x => x.id == id); if (t) { Object.assign(t, updates); t.lastModified = Date.now(); this.save(); } },
    toggleTodo(id) { const t = this.data.todos.find(x => x.id == id); if (t) { t.completed = !t.completed; t.lastModified = Date.now(); } this.save(); },
    deleteTodo(id) { if (typeof CloudSync !== 'undefined') CloudSync.trackDeletedItem('todos', id); this.data.todos = this.data.todos.filter(x => x.id != id); this.save(); },
    moveTodoToDay(id, newDay) { const t = this.data.todos.find(x => x.id == id); if (t) { t.day = newDay; t.lastModified = Date.now(); this.save(); } },
    addWeeklyGoal(t) { this.data.weeklyGoals.push({ ...t, id: Date.now(), completed: false, lastModified: Date.now() }); this.save(); if (router.currentPage === 'review') router.review(); else if (router.currentPage === 'todo') router.todo(); },

    resetWeek() {
        if (confirm('Sei sicuro di voler resettare la settimana? Tutti i task e gli obiettivi verranno eliminati.')) {
            this.data.todos = [];
            this.data.weeklyGoals = [];
            this.save();
            if (router.currentPage === 'todo') router.todo();
            ui.showToast('Settimana resettata con successo! 🧹');
        }
    },
    toggleWeeklyGoal(id) { const g = this.data.weeklyGoals.find(x => x.id == id); if (g) { g.completed = !g.completed; if (g.completed) g.failed = false; g.lastModified = Date.now(); } this.save(); },
    toggleWeeklyGoalFailed(id) { const g = this.data.weeklyGoals.find(x => x.id == id); if (g) { g.failed = !g.failed; if (g.failed) g.completed = false; g.lastModified = Date.now(); } this.save(); },
    updateWeeklyGoal(id, updates) { const g = this.data.weeklyGoals.find(x => x.id == id); if (g) { Object.assign(g, updates); g.lastModified = Date.now(); this.save(); } },
    deleteWeeklyGoal(id) { if (typeof CloudSync !== 'undefined') CloudSync.trackDeletedItem('weeklyGoals', id); this.data.weeklyGoals = this.data.weeklyGoals.filter(x => x.id != id); this.save(); },

    // Profile management
    async updateProfile(updates) {
        this.data.profile = { ...this.data.profile, ...updates };

        // ⚡ SAVE PROFILE DIRECTLY to ensure persistence
        try {
            await db.profile.put({ key: 'main', value: this.data.profile });
            console.log('✅ Profilo salvato con successo in IndexedDB');
        } catch (e) {
            console.error('❌ Errore salvataggio profilo:', e);
            alert('Attenzione: Errore nel salvataggio. Riprova. ' + e.message);
            return;
        }

        // Call generic save (async) just in case, but profile is already safe
        this.save();
    },
    async addAchievement(achievement) {
        if (!this.data.profile.achievements) this.data.profile.achievements = [];
        this.data.profile.achievements.push({ ...achievement, earnedAt: Date.now(), id: Date.now() });
        await this.save();
    },

    // Playbook management
    addSetup(s) {
        s.lastModified = Date.now();
        if (s.id && this.data.playbook.some(x => x.id == s.id)) {
            const i = this.data.playbook.findIndex(x => x.id == s.id);
            this.data.playbook[i] = { ...this.data.playbook[i], ...s };
        } else {
            s.id = s.id || Date.now();
            s.createdAt = s.createdAt || new Date().toISOString();
            this.data.playbook.unshift(s);
        }
        this.save();
    },
    deleteSetup(id) {
        if (typeof CloudSync !== 'undefined') CloudSync.trackDeletedItem('playbook', id);
        this.data.playbook = this.data.playbook.filter(x => x.id != id);
        this.save();
    },
    updateSetting(type, action, value) {
        if (action === 'add' && value && !this.data.settings[type].includes(value)) { this.data.settings[type].push(value); } else if (action === 'remove') { this.data.settings[type] = this.data.settings[type].filter(item => item !== value); }
        this.save();
    },
    // === BROKER INTEGRATION ===
    saveBrokerConnection(broker, config) {
        this.data.settings.brokerConnections[broker] = { ...this.data.settings.brokerConnections[broker], ...config };
        this.save();
    },

    async syncTradesFromBrokers() {
        const results = { success: [], errors: [] };

        // CAPITAL.COM SYNC - Auto-save completo (executed, non draft)
        const capitalComAccounts = this.data.accounts.filter(a => a.type === 'live' && a.capitalComConnected);
        for (const account of capitalComAccounts) {
            try {
                // Usa il timestamp dell'ultima sync per fetch incrementale (solo nuovi trade)
                const lastSync = account.capitalComLastTradeSync || null;
                const trades = await this.fetchCapitalComTrades(account, lastSync);
                const result = this.importCapitalComTrades(trades, account.id);
                if (result.count > 0) {
                    results.success.push({
                        broker: 'Capital.com',
                        count: result.count,
                        accountName: account.name,
                        trades: result.trades // Trade dettagliati per notifica UI
                    });
                }
                // Aggiorna timestamp ultima sync riuscita
                account.capitalComLastTradeSync = new Date().toISOString();
            } catch (e) {
                results.errors.push({ broker: 'Capital.com', error: e.message });
            }
        }

        // MT5 SYNC TEMPORARILY DISABLED
        /*
        if (this.data.settings.brokerConnections.mt5.enabled) {
            try {
                const trades = await this.fetchMT5Trades();
                const imported = this.importBrokerTrades(trades, 'MT5');
                results.success.push({ broker: 'MetaTrader 5', count: imported });
                this.data.settings.brokerConnections.mt5.lastSync = new Date().toISOString();
            } catch (e) {
                results.errors.push({ broker: 'MT5', error: e.message });
            }
        }
        */

        this.save();
        return results;
    },

    async syncTodayTradesFromBrokers() {
        const results = { success: [], errors: [] };

        const capitalComAccounts = this.data.accounts.filter(a => a.type === 'live' && a.capitalComConnected);
        for (const account of capitalComAccounts) {
            try {
                // Pass null to fetch the last 24h
                const trades = await this.fetchCapitalComTrades(account, null);
                const result = this.importCapitalComTrades(trades, account.id);
                if (result.count > 0) {
                    results.success.push({
                        broker: 'Capital.com',
                        count: result.count,
                        accountName: account.name,
                        trades: result.trades
                    });
                }
            } catch (e) {
                results.errors.push({ broker: 'Capital.com', error: e.message });
            }
        }

        if (results.success.length > 0) this.save();
        return results;
    },

    async getStorageInfo() {
        try {
            // Calcola dimensione totale dei dati in IndexedDB
            const [trades, accounts, reviews, todos, weeklyGoals] = await Promise.all([
                db.trades.toArray(),
                db.accounts.toArray(),
                db.reviews.toArray(),
                db.todos.toArray(),
                db.weeklyGoals.toArray()
            ]);

            // Stima dimensione (JSON stringify per calcolo approssimativo)
            const dataSize = {
                trades: JSON.stringify(trades).length,
                accounts: JSON.stringify(accounts).length,
                reviews: JSON.stringify(reviews).length,
                todos: JSON.stringify(todos).length,
                weeklyGoals: JSON.stringify(weeklyGoals).length
            };

            const totalBytes = Object.values(dataSize).reduce((a, b) => a + b, 0);
            const totalMB = (totalBytes / (1024 * 1024)).toFixed(2);

            // Usa il calcolo preciso dei dati reali per 'usage'
            let quota = 1000; // Default: assumiamo 1GB
            let usage = parseFloat(totalMB); // Usa il calcolo preciso invece di estimate

            if (navigator.storage && navigator.storage.estimate) {
                const estimate = await navigator.storage.estimate();
                quota = (estimate.quota / (1024 * 1024)).toFixed(0); // In MB
                // NON sovrascrivere usage con estimate.usage perché include cache e altri dati browser
                // usage rimane quello calcolato dai nostri dati
            }

            const available = (quota - usage).toFixed(0);
            const percentUsed = ((usage / quota) * 100).toFixed(1);

            return {
                used: usage,
                total: quota,
                available: available,
                percentUsed: percentUsed,
                breakdown: {
                    trades: (dataSize.trades / (1024 * 1024)).toFixed(2),
                    accounts: (dataSize.accounts / (1024 * 1024)).toFixed(2),
                    reviews: (dataSize.reviews / (1024 * 1024)).toFixed(2),
                    todos: (dataSize.todos / (1024 * 1024)).toFixed(2),
                    weeklyGoals: (dataSize.weeklyGoals / (1024 * 1024)).toFixed(2)
                }
            };
        } catch (error) {
            console.error('Errore calcolo storage:', error);
            return { used: 0, total: 0, available: 0, percentUsed: 0, breakdown: {} };
        }
    },

    async fetchMT5Trades() {
        const config = this.data.settings.brokerConnections.mt5;

        // Usando MetaApi (https://metaapi.cloud/)
        const baseUrl = 'https://mt-client-api-v1.agiliumtrade.agiliumtrade.ai';

        try {
            if (!config.apiKey || config.apiKey.length < 10) throw new Error('DEMO_MODE');

            const accountResponse = await fetch(`${baseUrl}/users/current/accounts/${config.accountId}/history-storage/deals`, {
                headers: {
                    'auth-token': config.apiKey,
                    'Content-Type': 'application/json'
                }
            });

            if (!accountResponse.ok) throw new Error('MT5: Impossibile recuperare i trade');
            const deals = await accountResponse.json();

            // Raggruppa deal in/out per formare trade completi
            const tradeMap = {};
            deals.forEach(deal => {
                if (deal.type === 'DEAL_TYPE_BUY' || deal.type === 'DEAL_TYPE_SELL') {
                    const posId = deal.positionId;
                    if (!tradeMap[posId]) {
                        tradeMap[posId] = { entry: null, exit: null, direction: null, asset: deal.symbol };
                    }

                    if (deal.entry === 'DEAL_ENTRY_IN') {
                        tradeMap[posId].entry = deal.price;
                        tradeMap[posId].direction = deal.type === 'DEAL_TYPE_BUY' ? 'LONG' : 'SHORT';
                        tradeMap[posId].lot = deal.volume;
                        tradeMap[posId].date = deal.time;
                    } else if (deal.entry === 'DEAL_ENTRY_OUT') {
                        tradeMap[posId].exit = deal.price;
                        tradeMap[posId].pnl = deal.profit;
                        tradeMap[posId].closeDate = deal.time;
                    }
                }
            });

            return Object.keys(tradeMap)
                .filter(id => tradeMap[id].entry && tradeMap[id].exit)
                .map(id => ({
                    externalId: `MT5_${id}`,
                    ...tradeMap[id],
                    broker: 'MT5'
                }));

        } catch (e) {
            console.warn('MT5 sync failed:', e.message);
            // Fallback disattivato per evitare trade fantasma indesiderati.
            return [];
        }
    },

    importBrokerTrades(brokerTrades, brokerName) {
        let importCount = 0;

        brokerTrades.forEach(bt => {
            // Verifica se il trade esiste già (evita duplicati)
            const exists = this.data.trades.some(t => t.externalId === bt.externalId);
            if (exists) return;

            // Trova account corrispondente o usa il primo disponibile
            let accountId = this.data.accounts.length > 0 ? this.data.accounts[0].id : null;

            // Crea trade come ESEGUITO (non più bozza, così appare nella dashboard)
            const newTrade = {
                id: Date.now() + importCount,
                externalId: bt.externalId,
                type: 'trade',
                asset: bt.asset,
                direction: bt.direction,
                entry: bt.entry,
                exit: bt.exit || null,
                lot: bt.lot || 0,
                pnl: bt.exit ? bt.pnl : 0,
                date: bt.date,
                closeDate: bt.closeDate || null,
                status: 'executed', // ESEGUITO - così appare nella dashboard
                accountId: accountId,
                strategy: '',
                session: '',
                rr: '',
                note: `Importato da ${brokerName}`,
                images: [],
                broker: bt.broker
            };

            this.data.trades.unshift(newTrade);
            importCount++;
        });

        if (importCount > 0) this.save();
        return importCount;
    },

    // === CAPITAL.COM REAL API INTEGRATION ===
    // Proxy (gestito da Netlify Functions su /.netlify/functions/capitalproxy)
    get CAPITAL_PROXY() {
        return (typeof PROXY_BASE_URL !== 'undefined') ? PROXY_BASE_URL : 'http://localhost:3030';
    },
    CAPITAL_API_LIVE: 'https://api-capital.backend-capital.com',
    CAPITAL_API_DEMO: 'https://demo-api-capital.backend-capital.com',

    // Cache sessioni Capital.com per account (accountId -> { cst, securityToken, expiry, baseUrl })
    _capitalSessions: {},

    async _capitalProxyFetch(targetUrl, method = 'GET', headers = {}, body = null) {
        const proxyUrl = `${this.CAPITAL_PROXY}/capitalproxy`;
        const fetchHeaders = {
            'Content-Type': 'application/json',
            'X-Target-URL': targetUrl,
            ...headers
        };
        const opts = { method, headers: fetchHeaders };
        if (body) opts.body = typeof body === 'string' ? body : JSON.stringify(body);
        const resp = await fetch(proxyUrl, opts);
        return resp;
    },

    async _capitalGetSession(account) {
        const accountId = account.id;
        const now = Date.now();
        const cached = this._capitalSessions[accountId];

        // Riusa sessione se valida (< 9 minuti, Capital.com scade dopo 10)
        if (cached && cached.expiry > now) {
            return cached;
        }

        const apiKey = account.capitalComApiKey;
        const password = account.capitalComSecret;

        if (!apiKey || !password) {
            throw new Error('Credenziali Capital.com mancanti. Controlla le impostazioni account.');
        }

        // Determina l'ambiente (live o demo basato sul tipo di account)
        const baseUrl = account.capitalComEnvironment === 'demo'
            ? this.CAPITAL_API_DEMO
            : this.CAPITAL_API_LIVE;

        console.log(`🔐 Capital.com - Autenticazione per ${account.name} (${baseUrl})...`);

        const sessionResp = await this._capitalProxyFetch(
            `${baseUrl}/api/v1/session`,
            'POST',
            { 'X-CAP-API-KEY': apiKey },
            { identifier: account.capitalComEmail || apiKey, password: password }
        );

        if (!sessionResp.ok) {
            const errText = await sessionResp.text();
            // Se il proxy non è disponibile, lancia errore specifico
            if (sessionResp.status === 0 || sessionResp.type === 'error') {
                throw new Error('PROXY_UNAVAILABLE');
            }
            throw new Error(`Autenticazione Capital.com fallita (${sessionResp.status}): ${errText}`);
        }

        const cst = sessionResp.headers.get('CST');
        const securityToken = sessionResp.headers.get('X-SECURITY-TOKEN');

        if (!cst || !securityToken) {
            throw new Error('Token sessione Capital.com non ricevuti. Verifica API Key e Password.');
        }

        const session = {
            cst,
            securityToken,
            apiKey,
            baseUrl,
            expiry: now + 9 * 60 * 1000 // 9 minuti
        };

        this._capitalSessions[accountId] = session;
        console.log(`✅ Capital.com - Sessione creata per ${account.name}`);
        return session;
    },

    async fetchCapitalComBalance(account) {
        try {
            const session = await this._capitalGetSession(account);
            const resp = await this._capitalProxyFetch(
                `${session.baseUrl}/api/v1/accounts`,
                'GET',
                {
                    'X-CAP-API-KEY': session.apiKey,
                    'CST': session.cst,
                    'X-SECURITY-TOKEN': session.securityToken
                }
            );

            if (!resp.ok) throw new Error(`Impossibile ottenere il saldo (${resp.status})`);

            const data = await resp.json();
            // Capital.com restituisce un array di account
            const accounts = data.accounts || [];
            if (accounts.length === 0) return null;

            // Prendi il primo account (o quello con più fondi)
            const capitalAccount = accounts[0];
            return {
                balance: capitalAccount.balance?.balance || 0,
                equity: capitalAccount.balance?.equity || 0,
                funds: capitalAccount.balance?.funds || 0,
                currency: capitalAccount.currency || 'USD'
            };
        } catch (e) {
            if (e.message === 'PROXY_UNAVAILABLE') {
                console.warn('⚠️ Capital.com Proxy non disponibile.');
            } else {
                console.error('❌ fetchCapitalComBalance error:', e.message);
            }
            return null;
        }
    },

    // Calcola automaticamente il Risk/Reward ratio dato entry, exit, SL e direction
    _calculateRR(entry, exit, stopLoss, direction) {
        if (!entry || !exit || !stopLoss || !direction) return '';
        const isLong = direction === 'long' || direction === 'BUY' || direction === 'LONG';
        const riskPips = isLong ? Math.abs(entry - stopLoss) : Math.abs(stopLoss - entry);
        const rewardPips = isLong ? Math.abs(exit - entry) : Math.abs(entry - exit);
        if (riskPips <= 0) return '';
        const ratio = rewardPips / riskPips;
        const isWin = isLong ? exit > entry : exit < entry;
        return isWin ? `+${ratio.toFixed(2)}R` : `-${ratio.toFixed(2)}R`;
    },

    // Rileva la sessione di trading in base all'orario UTC del trade
    _detectTradingSession(dateStr) {
        if (!dateStr) return '';
        const d = new Date(dateStr);
        const hour = d.getUTCHours();
        if (hour >= 22 || hour < 8) return 'Asian';
        if (hour >= 8 && hour < 12) return 'London';
        if (hour >= 12 && hour < 17) return 'New York';
        if (hour >= 17 && hour < 22) return 'London Close';
        return '';
    },

    async fetchCapitalComTrades(account, fromTimestamp = null) {
        try {
            const session = await this._capitalGetSession(account);

            // Costruisce l'URL con filtro temporale opzionale per fetch incrementale
            let activityUrl = `${session.baseUrl}/api/v1/history/activity?filter=POSITION&lastPeriod=86400`;
            if (fromTimestamp) {
                // Sottraiamo 10 minuti per evitare problemi di desincronizzazione orologi (clock skew)
                const fromDate = new Date(new Date(fromTimestamp).getTime() - 10 * 60 * 1000).toISOString();
                activityUrl = `${session.baseUrl}/api/v1/history/activity?filter=POSITION&from=${encodeURIComponent(fromDate)}`;
            }

            const resp = await this._capitalProxyFetch(
                activityUrl,
                'GET',
                {
                    'X-CAP-API-KEY': session.apiKey,
                    'CST': session.cst,
                    'X-SECURITY-TOKEN': session.securityToken
                }
            );

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`Impossibile recuperare le posizioni (${resp.status}): ${errText}`);
            }

            const data = await resp.json();
            const activities = data.activities || [];

            console.log(`📊 Capital.com - ${activities.length} attività trovate per ${account.name}`);

            // Filtra solo le posizioni chiuse
            const closedPositions = activities.filter(a =>
                a.type === 'POSITION' &&
                a.details &&
                a.details.actions &&
                a.details.actions.some(act => act.actionType === 'POSITION_CLOSED')
            );

            return closedPositions.map(activity => {
                const details = activity.details || {};
                const closeAction = details.actions?.find(a => a.actionType === 'POSITION_CLOSED');
                const openAction = details.actions?.find(a => a.actionType === 'POSITION_OPENED');

                const entry = parseFloat(details.openLevel || openAction?.level || 0);
                const exit = parseFloat(closeAction?.level || details.closeLevel || 0);
                const direction = details.direction === 'BUY' ? 'long' : 'short';
                const pnl = parseFloat(details.profit || closeAction?.profit || 0);

                // SL e TP possono essere presenti nei dettagli dell'azione di apertura
                const stopLevel = parseFloat(details.stopLevel || openAction?.stopLevel || 0) || null;
                const profitLevel = parseFloat(details.limitLevel || openAction?.limitLevel || 0) || null;
                const lot = parseFloat(details.size || 0);

                // Calcola RR automaticamente se disponibile SL
                const rr = stopLevel
                    ? this._calculateRR(entry, exit, stopLevel, direction)
                    : (pnl !== 0 && lot > 0 ? (pnl > 0 ? '+' : '') + (pnl / (lot * 100)).toFixed(2) + 'R' : '');

                const openDate = details.openedDateUtc || activity.date;
                const closeDate = details.closedDateUtc || activity.date;

                return {
                    externalId: `CAPITALCOM_${activity.details?.dealId || activity.date}_${activity.epic || ''}`,
                    asset: activity.epic || 'UNKNOWN',
                    direction,
                    entry,
                    exit,
                    stopLoss: stopLevel,
                    takeProfit: profitLevel,
                    lot,
                    pnl,
                    rr,
                    date: openDate,
                    closeDate,
                    session: this._detectTradingSession(openDate),
                    broker: 'Capital.com',
                    dealId: activity.details?.dealId || null
                };
            });

        } catch (e) {
            if (e.message === 'PROXY_UNAVAILABLE') {
                throw new Error('Proxy Capital.com non disponibile.');
            }
            console.error('❌ fetchCapitalComTrades error:', e.message);
            throw e;
        }
    },

    // Importa trade Capital.com come ESEGUITI con tutti i dati automaticamente compilati
    importCapitalComTrades(brokerTrades, accountId) {
        let importCount = 0;
        const newTrades = [];

        brokerTrades.forEach(bt => {
            const exists = this.data.trades.some(t => t.externalId === bt.externalId);
            if (exists) return;

            const newTrade = {
                id: Date.now() + importCount,
                externalId: bt.externalId,
                type: 'trade',
                asset: bt.asset,
                direction: bt.direction,
                entry: bt.entry,
                exit: bt.exit || null,
                stopLoss: bt.stopLoss || null,
                takeProfit: bt.takeProfit || null,
                lot: bt.lot || 0,
                pnl: bt.pnl || 0,
                rr: bt.rr || '',
                date: bt.date,
                closeDate: bt.closeDate || null,
                status: 'executed', // ✅ AUTOMATICAMENTE ESEGUITO - nessuna bozza
                accountId: accountId,
                strategy: '', // L'utente può arricchire dopo
                session: bt.session || '',
                note: `🤖 Auto-salvato da Capital.com${bt.dealId ? ` (ID: ${bt.dealId})` : ''}.`,
                images: [],
                broker: bt.broker,
                autoImported: true,
                lastModified: Date.now()
            };

            this.data.trades.unshift(newTrade);
            newTrades.push(newTrade);
            importCount++;
        });

        if (importCount > 0) this.save();
        return { count: importCount, trades: newTrades };
    },

    // Alias per compatibilità con il vecchio codice
    importCapitalComTradesAsDrafts(brokerTrades, accountId) {
        const result = this.importCapitalComTrades(brokerTrades, accountId);
        return result.count;
    },

    // Recupera posizioni aperte in tempo reale da Capital.com
    async fetchCapitalComOpenPositions(account) {
        try {
            const session = await this._capitalGetSession(account);

            const resp = await this._capitalProxyFetch(
                `${session.baseUrl}/api/v1/positions`,
                'GET',
                {
                    'X-CAP-API-KEY': session.apiKey,
                    'CST': session.cst,
                    'X-SECURITY-TOKEN': session.securityToken
                }
            );

            if (!resp.ok) {
                const errText = await resp.text();
                throw new Error(`Impossibile recuperare le posizioni aperte (${resp.status}): ${errText}`);
            }

            const data = await resp.json();
            const positions = data.positions || [];

            return positions.map(p => {
                const pos = p.position || {};
                const market = p.market || {};
                const isLong = pos.direction === 'BUY';
                const entry = parseFloat(pos.openLevel || 0);
                const currentBid = parseFloat(market.bid || 0);
                const currentOffer = parseFloat(market.offer || 0);
                const currentPrice = isLong ? currentBid : currentOffer;
                const size = parseFloat(pos.size || pos.dealSize || 0);
                const rawPnl = parseFloat(pos.upl || pos.profit || 0);

                return {
                    dealId: pos.dealId || pos.positionId || '',
                    asset: market.epic || market.instrumentName || 'UNKNOWN',
                    instrumentName: market.instrumentName || market.epic || 'UNKNOWN',
                    direction: isLong ? 'long' : 'short',
                    entry,
                    currentPrice,
                    size,
                    pnl: rawPnl,
                    currency: pos.currency || 'USD',
                    openedAt: pos.createdDateUTC || pos.createdDate || null,
                    stopLevel: parseFloat(pos.stopLevel || 0) || null,
                    limitLevel: parseFloat(pos.limitLevel || 0) || null
                };
            });

        } catch (e) {
            if (e.message === 'PROXY_UNAVAILABLE' || e.message?.includes('PROXY_UNAVAILABLE')) {
                console.warn('⚠️ Proxy non disponibile per open positions');
                return null; // null = proxy non disponibile (distingue da [] = nessuna posizione)
            }
            console.error('❌ fetchCapitalComOpenPositions error:', e.message);
            return null;
        }
    },

    // === QR CODE DATA TRANSFER ===
    compressData() {
        try {
            // Assicura che il profilo sia sempre incluso nei dati esportati
            const dataToExport = {
                ...this.data,
                profile: this.data.profile || {
                    name: 'Trader',
                    bio: 'Disciplina. Pazienza. Costanza.',
                    avatar: '👤',
                    tradingSince: new Date().toISOString().split('T')[0],
                    achievements: []
                }
            };
            const jsonStr = JSON.stringify(dataToExport);
            const compressed = LZString.compressToBase64(jsonStr);
            return compressed;
        } catch (e) {
            throw new Error('Impossibile comprimere i dati');
        }
    },

    decompressAndImport(compressedData) {
        try {
            const decompressed = LZString.decompressFromBase64(compressedData);
            if (!decompressed) throw new Error('Dati corrotti');

            const parsedData = JSON.parse(decompressed);

            // Valida la struttura - INCLUSO IL PROFILO
            if (!parsedData.trades || !parsedData.accounts || !parsedData.settings) {
                throw new Error('Struttura dati non valida');
            }

            // ASSICURA CHE IL PROFILO SIA SEMPRE PRESENTE E COMPLETO
            const defaultProfile = {
                name: 'Trader',
                bio: 'Disciplina. Pazienza. Costanza.',
                avatar: '👤',
                tradingSince: new Date().toISOString().split('T')[0],
                achievements: []
            };

            // Merge del profilo: se esiste nei dati importati lo usa, altrimenti default
            parsedData.profile = { ...defaultProfile, ...(parsedData.profile || {}) };

            // Log per debug
            console.log('Profilo importato:', parsedData.profile);

            // Sovrascrivi i dati locali
            this.data = parsedData;
            this.save();

            return true;
        } catch (e) {
            throw new Error('Impossibile importare i dati: ' + e.message);
        }
    },

    getDataSize() {
        const jsonStr = JSON.stringify(this.data);
        const sizeKB = (new Blob([jsonStr]).size / 1024).toFixed(2);
        return sizeKB;
    },

    // Cache per news e calendario
    newsCache: null,
    newsCacheTime: 0,
    calendarCache: null,
    calendarCacheTime: 0,
    NEWS_CACHE_DURATION: 5 * 60 * 1000, // 5 minuti
    CALENDAR_CACHE_DURATION: 10 * 60 * 1000, // 10 minuti

    async fetchRealNews(forceRefresh = false) {
        // Usa cache se disponibile e non scaduta
        if (!forceRefresh && this.newsCache && (Date.now() - this.newsCacheTime < this.NEWS_CACHE_DURATION)) {
            return this.newsCache;
        }

        const RSS_TO_JSON_API = 'https://api.rss2json.com/v1/api.json?rss_url=';
        const sources = [
            { url: 'https://www.investing.com/rss/stock_market.rss', category: 'Stocks', name: 'Investing.com', domain: 'investing.com' },
            { url: 'https://finance.yahoo.com/news/rssindex', category: 'Stocks', name: 'Yahoo Finance', domain: 'finance.yahoo.com' },
            { url: 'https://www.fxstreet.com/rss/news', category: 'Forex', name: 'FXStreet', domain: 'fxstreet.com' },
            { url: 'https://www.investing.com/rss/forex_news.rss', category: 'Forex', name: 'Investing.com', domain: 'investing.com' },
            { url: 'https://cointelegraph.com/rss', category: 'Crypto', name: 'Cointelegraph', domain: 'cointelegraph.com' },
            { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', category: 'Crypto', name: 'CoinDesk', domain: 'coindesk.com' }
        ];

        const getImpact = (text) => {
            const t = text.toLowerCase();
            if (t.match(/fed|ecb|fomc|rate|hike|cut|pause|inflation|cpi|ppi|nfp|gdp|unemployment|jobless|war|crisis|crash|record|powell|lagarde|bitcoin|etf|approval|sec|binance|blackrock/)) return 'High';
            if (t.match(/earnings|revenue|profit|loss|forecast|outlook|trend|bull|bear|support|resistance|breakout|pullback|rally|dip|quarterly|analyst/)) return 'Medium';
            return 'Low';
        };

        const categoryImages = {
            'Forex': 'https://images.unsplash.com/photo-1611974765270-ca1258634369?q=80&w=2664&auto=format&fit=crop',
            'Crypto': 'https://images.unsplash.com/photo-1518546305927-5a555bb7020d?q=80&w=2669&auto=format&fit=crop',
            'Stocks': 'https://images.unsplash.com/photo-1611974765270-ca1258634369?q=80&w=2664&auto=format&fit=crop'
        };

        try {
            // Helper per fetch con timeout
            const fetchWithTimeout = (url, timeout = 2000) => {
                return Promise.race([
                    fetch(url),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeout))
                ]);
            };

            const promises = sources.map(src =>
                fetchWithTimeout('https://api.rss2json.com/v1/api.json?rss_url=' + encodeURIComponent(src.url), 2000)
                    .then(res => res.json())
                    .then(data => {
                        if (data.status === 'ok' && Array.isArray(data.items)) {
                            return data.items.map(item => {
                                // Estrai immagine da varie fonti possibili
                                let imageUrl = null;
                                
                                // 1. Prova enclosure (url o link)
                                if (item.enclosure) {
                                    imageUrl = item.enclosure.link || item.enclosure.url;
                                }
                                
                                // 2. Prova thumbnail
                                if (!imageUrl && item.thumbnail) {
                                    imageUrl = item.thumbnail;
                                }
                                
                                // 3. Prova a estrarre immagine dalla descrizione HTML
                                if (!imageUrl && item.description) {
                                    const imgMatch = item.description.match(/<img[^>]+src=["']([^"']+)["']/i);
                                    if (imgMatch && imgMatch[1]) {
                                        imageUrl = imgMatch[1];
                                    }
                                }
                                
                                // 4. Prova content (alcuni feed usano content invece di description)
                                if (!imageUrl && item.content) {
                                    const imgMatch = item.content.match(/<img[^>]+src=["']([^"']+)["']/i);
                                    if (imgMatch && imgMatch[1]) {
                                        imageUrl = imgMatch[1];
                                    }
                                }
                                
                                // 5. Fallback a immagine di categoria - SEMPRE
                                if (!imageUrl) {
                                    imageUrl = categoryImages[src.category];
                                }
                                
                                // Debug per FXStreet
                                if (src.domain === 'fxstreet.com') {
                                    console.log('FXStreet news:', {
                                        title: item.title,
                                        hasEnclosure: !!item.enclosure,
                                        hasThumbnail: !!item.thumbnail,
                                        finalImage: imageUrl
                                    });
                                }
                                
                                return {
                                    title: item.title,
                                    link: item.link,
                                    pubDate: item.pubDate,
                                    summary: (item.description || '').replace(/<[^>]+>/g, '').substring(0, 100) + '...',
                                    category: src.category,
                                    sourceName: src.name,
                                    sourceDomain: src.domain,
                                    image: imageUrl,
                                    impact: getImpact((item.title || "") + " " + (item.description || ""))
                                };
                            });
                        }
                        return [];
                    })
                    .catch(err => {
                        console.warn(`Fonte ${src.name} fallita:`, err.message);
                        return [];
                    })
            );

            const results = await Promise.all(promises);
            const allNews = results.flat().sort((a, b) => new Date(b.pubDate) - new Date(a.pubDate));
            const uniqueNews = Array.from(new Map(allNews.map(item => [item.title, item])).values());

            const finalNews = uniqueNews.slice(0, 50);

            // Salva in cache
            this.newsCache = finalNews;
            this.newsCacheTime = Date.now();

            // Salva anche in localStorage per persistenza (async)
            setTimeout(() => {
                try {
                    localStorage.setItem('news_cache', JSON.stringify(finalNews));
                    localStorage.setItem('news_cache_time', this.newsCacheTime.toString());
                } catch (e) { /* ignore */ }
            }, 0);

            return finalNews;
        } catch (e) {
            // Prova a caricare da localStorage se disponibile
            try {
                const cached = localStorage.getItem('news_cache');
                const cachedTime = localStorage.getItem('news_cache_time');
                if (cached && cachedTime && (Date.now() - parseInt(cachedTime, 10) < 60 * 60 * 1000)) {
                    return JSON.parse(cached);
                }
            } catch (e) { /* ignore */ }
            return this.newsCache || [];
        }
    },

    async fetchCalendar(forceRefresh = false) {
        // Usa cache se disponibile e non scaduta
        if (!forceRefresh && this.calendarCache && (Date.now() - this.calendarCacheTime < this.CALENDAR_CACHE_DURATION)) {
            return this.calendarCache;
        }

        try {
            // Usa AllOrigins come proxy per evitare CORS con XML di ForexFactory
            const response = await fetch('https://api.allorigins.win/raw?url=' + encodeURIComponent('https://nfs.faireconomy.media/ff_calendar_thisweek.xml'));
            const str = await response.text();

            const parser = new DOMParser();
            const xmlDoc = parser.parseFromString(str, "text/xml");
            const events = Array.from(xmlDoc.getElementsByTagName("event"));

            const calendarData = events.map(e => {
                const getVal = (tag) => e.getElementsByTagName(tag)[0]?.childNodes[0]?.nodeValue || "";
                return {
                    title: getVal("title"),
                    country: getVal("country"),
                    date: getVal("date"), // MM-DD-YYYY
                    time: getVal("time"),
                    impact: getVal("impact"),
                    forecast: getVal("forecast"),
                    previous: getVal("previous")
                };
            });

            // Salva in cache
            this.calendarCache = calendarData;
            this.calendarCacheTime = Date.now();

            return calendarData;
        } catch (e) {
            console.error("Calendar fetch error:", e);
            return this.calendarCache || [];
        }
    },

    // Pre-carica news e calendario in background
    preloadNewsAndCalendar() {
        console.log('📡 Pre-caricamento news e calendario...');

        // Prova a caricare da localStorage per risposta immediata
        try {
            const cached = localStorage.getItem('news_cache');
            const cachedTime = localStorage.getItem('news_cache_time');
            if (cached && cachedTime) {
                this.newsCache = JSON.parse(cached);
                this.newsCacheTime = parseInt(cachedTime, 10);
                console.log('⚡ News caricate da cache locale');
            }
        } catch (e) { /* ignore */ }

        // Carica in background dopo 100ms per non bloccare l'init
        setTimeout(() => {
            const startTime = Date.now();
            Promise.all([
                this.fetchRealNews(),
                this.fetchCalendar()
            ]).then(() => {
                console.log(`✅ News e calendario aggiornati in ${Date.now() - startTime}ms`);
            }).catch(err => {
                console.error('Errore caricamento news:', err);
            });
        }, 100);
    }
};

// UI CONTROLLER
