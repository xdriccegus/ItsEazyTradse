// PREMIUM FEATURES: Monte Carlo, Prop Firm Tracker, Economic Calendar

const PremiumManager = {
    isPro() {
        return localStorage.getItem('eazytrader_is_pro') === 'true';
    },

    async validateKey(licenseKey) {
        try {
            const response = await fetch('https://api.lemonsqueezy.com/v1/licenses/validate', {
                method: 'POST',
                headers: {
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ license_key: licenseKey })
            });
            const data = await response.json();
            
            if (data.valid === true) {
                localStorage.setItem('eazytrader_license_key', licenseKey);
                localStorage.setItem('eazytrader_is_pro', 'true');
                return { success: true };
            } else {
                localStorage.setItem('eazytrader_is_pro', 'false');
                return { success: false, error: data.error || 'Chiave non valida' };
            }
        } catch (error) {
            console.error("Errore verifica licenza:", error);
            return { success: false, error: 'Errore di rete' };
        }
    },

    updateProUI() {
        const btn = document.getElementById('header-pro-btn');
        if (!btn) return;
        if (this.isPro()) {
            btn.classList.remove('bg-blue-500/10', 'text-blue-500', 'border-blue-500/30', 'hover:bg-blue-500/20');
            btn.classList.add('bg-gradient-to-r', 'from-blue-500', 'to-indigo-500', 'text-white', 'border-white/10');
            document.getElementById('header-pro-text').innerText = 'PRO';
            btn.onclick = () => ui.showToast('Sei già utente Pro!', false);
        } else {
            btn.classList.add('bg-blue-500/10', 'text-blue-500', 'border-blue-500/30', 'hover:bg-blue-500/20');
            btn.classList.remove('bg-gradient-to-r', 'from-blue-500', 'to-indigo-500', 'text-white', 'border-white/10');
            document.getElementById('header-pro-text').innerText = 'Attiva Pro';
            btn.onclick = () => PremiumManager.showLicenseModal();
        }
    },

    async backgroundCheck() {
        const key = localStorage.getItem('eazytrader_license_key');
        if (key) {
            await this.validateKey(key);
        }
        this.updateProUI();
    },

    showLicenseModal() {
        let modal = document.getElementById('modal-license');
        if (!modal) {
            const overlay = document.getElementById('modal-overlay');
            if (overlay) {
                overlay.insertAdjacentHTML('beforeend', '<div id="modal-license" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>');
                modal = document.getElementById('modal-license');
            }
        }
        
        modal.innerHTML = `
            <div class="bg-[var(--bg-card)] w-full rounded-3xl border border-[var(--glass-border)] shadow-2xl p-6 flex flex-col gap-4">
                <div class="flex items-center justify-between">
                    <h3 class="text-xl font-bold text-[var(--text-main)]">Passa a EazyTrader Pro</h3>
                    <button onclick="ui.closeModals()" class="text-[var(--text-muted)] hover:text-white"><i class="ph-bold ph-x"></i></button>
                </div>
                <p class="text-sm text-[var(--text-muted)]">Inserisci la tua chiave di licenza Lemon Squeezy per sbloccare le funzionalità Premium come l'Analisi Monte Carlo e i tool IA.</p>
                <input type="text" id="license-input" placeholder="Es. XXXX-YYYY-ZZZZ-WWWW" class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-white outline-none focus:border-[var(--accent-blue)]">
                <p id="license-msg" class="text-xs font-bold hidden"></p>
                <button onclick="PremiumManager.activate()" id="license-btn" class="w-full bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-400 hover:to-indigo-500 text-white px-4 py-3 rounded-xl font-bold transition-all">Attiva Licenza</button>
                <div class="text-center mt-2">
                    <a href="#" onclick="window.open('https://eazytrader.lemonsqueezy.com/checkout/buy/997f1f29-13d0-4319-a245-e12902d87c8e')" class="text-xs text-[var(--text-muted)] underline hover:text-white">Non hai una licenza? Acquistala ora</a>
                </div>
            </div>
        `;
        ui.openModal('modal-license');
    },

    async activate() {
        const key = document.getElementById('license-input').value.trim();
        const msgEl = document.getElementById('license-msg');
        const btn = document.getElementById('license-btn');
        
        if (!key) return;
        
        btn.innerText = 'Verifica in corso...';
        btn.disabled = true;
        msgEl.classList.add('hidden');
        
        const result = await this.validateKey(key);
        
        btn.disabled = false;
        btn.innerText = 'Attiva Licenza';
        msgEl.classList.remove('hidden');
        
        if (result.success) {
            msgEl.className = 'text-xs font-bold text-green-400 mt-2';
            msgEl.innerText = 'Licenza attivata con successo! Benvenuto in Pro.';
            this.updateProUI();
            setTimeout(() => {
                ui.closeModals();
                ui.showToast('Funzionalità Pro Sbloccate!', false);
            }, 1500);
        } else {
            msgEl.className = 'text-xs font-bold text-red-500 mt-2';
            msgEl.innerText = result.error;
        }
    }
};

// Eseguiamo il controllo in background al caricamento
setTimeout(() => PremiumManager.backgroundCheck(), 2000);

const PremiumUI = {
    openMonteCarloModal() {
        let modal = document.getElementById('modal-montecarlo');
        if (!modal) {
            const overlay = document.getElementById('modal-overlay');
            if (overlay) {
                overlay.insertAdjacentHTML('beforeend', '<div id="modal-montecarlo" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>');
                modal = document.getElementById('modal-montecarlo');
            }
        }

        const trades = DataStore.data.trades.filter(t => t.status === 'executed' && t.type !== 'payout');
        let wins = 0, total = trades.length;
        let avgWin = 0, avgLoss = 0;
        let winSum = 0, lossSum = 0;
        let winCount = 0, lossCount = 0;

        trades.forEach(t => {
            const p = parseFloat(t.pnl) || 0;
            if (p > 0) { wins++; winSum += p; winCount++; }
            else if (p < 0) { lossSum += Math.abs(p); lossCount++; }
        });

        const realWinRate = total > 0 ? ((wins / total) * 100).toFixed(1) : 50;
        avgWin = winCount > 0 ? (winSum / winCount).toFixed(2) : 100;
        avgLoss = lossCount > 0 ? (lossSum / lossCount).toFixed(2) : 50;
        const currentBalance = DataStore.data.accounts.reduce((sum, acc) => sum + (acc.balance || 0), 0) || 10000;

        modal.innerHTML = `
            <div class="bg-[var(--bg-card)] w-full max-w-5xl rounded-3xl border border-[var(--glass-border)] shadow-2xl transform transition-all scale-100 max-h-[90vh] flex flex-col">
                <div class="flex items-center justify-between px-8 py-5 border-b border-[var(--glass-border)] flex-shrink-0 bg-gradient-to-r from-blue-500/10 to-indigo-500/10">
                    <div class="flex items-center gap-4 min-w-0">
                        <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-lg shadow-blue-500/30 flex-shrink-0">
                            <i class="ph-bold ph-chart-scatter text-xl"></i>
                        </div>
                        <div class="min-w-0">
                            <h3 class="text-xl font-bold text-[var(--text-main)] truncate">Simulazione Monte Carlo</h3>
                            <p class="text-xs text-[var(--text-muted)]">Proietta le tue statistiche su 1000 scenari futuri</p>
                        </div>
                    </div>
                    <button onclick="ui.closeModals()" class="w-10 h-10 rounded-xl bg-white/5 hover:bg-white/10 flex items-center justify-center text-[var(--text-muted)] hover:text-white transition-all">
                        <i class="ph-bold ph-x text-lg"></i>
                    </button>
                </div>
                <div class="flex flex-col lg:flex-row flex-1 overflow-hidden">
                    <div class="w-full lg:w-80 border-r border-[var(--glass-border)] p-6 overflow-y-auto custom-scrollbar flex flex-col gap-5 bg-[var(--input-bg)]/30">
                        <div>
                            <label class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2 block">Capitale Iniziale ($)</label>
                            <input type="number" id="mc-capital" value="${currentBalance.toFixed(0)}" class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-white preserve-white font-bold outline-none focus:border-[var(--accent-blue)] transition-all">
                        </div>
                        <div>
                            <label class="text-[10px] font-bold uppercase tracking-widest text-green-400 mb-2 flex justify-between">
                                <span>Win Rate Reale (%)</span>
                                <span>${total} trades</span>
                            </label>
                            <input type="number" id="mc-winrate" value="${realWinRate}" step="0.1" max="100" class="w-full bg-[var(--input-bg)] border border-green-500/30 rounded-xl px-4 py-3 text-white preserve-white font-bold outline-none focus:border-green-500 transition-all">
                        </div>
                        <div class="flex gap-3">
                            <div class="flex-1">
                                <label class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2 block">Avg Win ($)</label>
                                <input type="number" id="mc-avgwin" value="${avgWin}" class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-white preserve-white font-bold outline-none focus:border-blue-500 transition-all text-sm">
                            </div>
                            <div class="flex-1">
                                <label class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2 block">Avg Loss ($)</label>
                                <input type="number" id="mc-avgloss" value="${avgLoss}" class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-white preserve-white font-bold outline-none focus:border-red-500 transition-all text-sm">
                            </div>
                        </div>
                        <div>
                            <label class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-2 block">Numero Trade da Simulare</label>
                            <input type="number" id="mc-trades" value="100" class="w-full bg-[var(--input-bg)] border border-[var(--glass-border)] rounded-xl px-4 py-3 text-white preserve-white font-bold outline-none focus:border-blue-500 transition-all text-sm">
                        </div>
                        <div class="mt-auto pt-4">
                            <button onclick="PremiumUI.runMonteCarlo()" class="w-full bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-400 hover:to-indigo-500 text-white preserve-white px-4 py-4 rounded-xl font-bold shadow-lg shadow-blue-500/20 transition-all flex items-center justify-center gap-2">
                                <i class="ph-bold ph-play"></i> Lancia Simulazione
                            </button>
                        </div>
                    </div>
                    <div class="flex-1 p-6 flex flex-col bg-[var(--bg-body)] overflow-y-auto custom-scrollbar">
                        <div class="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 shrink-0">
                            <div class="bg-[var(--bg-card)] border border-[var(--glass-border)] rounded-2xl p-4 text-center shadow-sm">
                                <p class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1">Rischio di Rovina</p>
                                <h4 id="mc-ror" class="text-2xl font-bold text-white preserve-white">--%</h4>
                            </div>
                            <div class="bg-[var(--bg-card)] border border-[var(--glass-border)] rounded-2xl p-4 text-center shadow-sm">
                                <p class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1">Profitto Medio</p>
                                <h4 id="mc-avgprofit" class="text-2xl font-bold text-green-400">$--</h4>
                            </div>
                            <div class="bg-[var(--bg-card)] border border-[var(--glass-border)] rounded-2xl p-4 text-center shadow-sm">
                                <p class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1">Max Drawdown Medio</p>
                                <h4 id="mc-avgdd" class="text-2xl font-bold text-red-400">--%</h4>
                            </div>
                            <div class="bg-[var(--bg-card)] border border-[var(--glass-border)] rounded-2xl p-4 text-center shadow-sm">
                                <p class="text-[10px] font-bold uppercase tracking-widest text-[var(--text-muted)] mb-1">Scenari Positivi</p>
                                <h4 id="mc-winscenarios" class="text-2xl font-bold text-blue-400">--%</h4>
                            </div>
                        </div>
                        <div class="flex-1 min-h-[300px] bg-[var(--bg-card)] border border-[var(--glass-border)] rounded-3xl p-4 relative flex items-center justify-center shadow-inner">
                            <canvas id="montecarloChart" class="hidden w-full h-full"></canvas>
                            <div id="mc-placeholder" class="text-center">
                                <div class="w-16 h-16 rounded-full bg-blue-500/10 text-blue-400 flex items-center justify-center mx-auto mb-4 animate-pulse">
                                    <i class="ph-bold ph-chart-line-up text-3xl"></i>
                                </div>
                                <p class="text-sm font-bold text-[var(--text-muted)]">Clicca su "Lancia Simulazione"</p>
                                <p class="text-xs text-[var(--text-muted)] mt-1 max-w-xs mx-auto">Verranno generati 1000 universi paralleli basati sulle tue probabilità reali.</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        ui.openModal('modal-montecarlo');
    },

    runMonteCarlo() {
        const capital = parseFloat(document.getElementById('mc-capital').value);
        const winRate = parseFloat(document.getElementById('mc-winrate').value) / 100;
        const avgWin = parseFloat(document.getElementById('mc-avgwin').value);
        const avgLoss = parseFloat(document.getElementById('mc-avgloss').value);
        const numTrades = parseInt(document.getElementById('mc-trades').value);

        if (!capital || capital <= 0 || isNaN(winRate) || isNaN(avgWin) || isNaN(avgLoss) || !numTrades || numTrades <= 0) {
            ui.showToast('Inserisci parametri validi', true);
            return;
        }

        const numSimulations = 1000;
        const paths = [];
        let ruinCount = 0;
        let finalBalances = [];
        let maxDrawdowns = [];
        let winScenarios = 0;

        for (let i = 0; i < numSimulations; i++) {
            let balance = capital;
            let peak = capital;
            let maxDd = 0;
            const path = [capital];
            let ruined = false;

            for (let j = 0; j < numTrades; j++) {
                if (balance <= 0) { ruined = true; path.push(0); continue; }
                const isWin = Math.random() < winRate;
                if (isWin) balance += avgWin;
                else balance -= avgLoss;

                if (balance > peak) peak = balance;
                const dd = (peak - balance) / peak;
                if (dd > maxDd) maxDd = dd;

                path.push(balance);
            }

            if (ruined || balance <= 0) ruinCount++;
            if (balance > capital) winScenarios++;
            finalBalances.push(balance);
            maxDrawdowns.push(maxDd);
            if (i < 50) paths.push(path);
        }

        const avgFinalBalance = finalBalances.reduce((a, b) => a + b, 0) / numSimulations;
        const avgProfit = avgFinalBalance - capital;
        const avgDdPerc = (maxDrawdowns.reduce((a, b) => a + b, 0) / numSimulations) * 100;
        const riskOfRuin = (ruinCount / numSimulations) * 100;
        const winPerc = (winScenarios / numSimulations) * 100;

        const rorEl = document.getElementById('mc-ror');
        rorEl.innerText = riskOfRuin.toFixed(1) + '%';
        rorEl.className = `text-2xl font-bold \${riskOfRuin > 10 ? 'text-red-500' : 'text-green-400'}`;

        const profitEl = document.getElementById('mc-avgprofit');
        profitEl.innerText = (avgProfit >= 0 ? '+' : '') + ui.formatCurrency(avgProfit);
        profitEl.className = `text-2xl font-bold \${avgProfit >= 0 ? 'text-green-400' : 'text-red-500'}`;

        document.getElementById('mc-avgdd').innerText = avgDdPerc.toFixed(1) + '%';
        document.getElementById('mc-winscenarios').innerText = winPerc.toFixed(1) + '%';

        document.getElementById('mc-placeholder').classList.add('hidden');
        const ctx = document.getElementById('montecarloChart');
        ctx.classList.remove('hidden');

        if (PremiumUI.mcChartInstance) PremiumUI.mcChartInstance.destroy();

        const datasets = paths.map((p, i) => ({
            label: `Sim \${i}`,
            data: p,
            borderColor: p[p.length-1] >= capital ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
            borderWidth: 1,
            pointRadius: 0,
            fill: false,
            tension: 0.1
        }));

        datasets.push({
            label: 'Start Capital',
            data: Array(numTrades + 1).fill(capital),
            borderColor: 'rgba(255, 255, 255, 0.4)',
            borderWidth: 2,
            borderDash: [5, 5],
            pointRadius: 0,
            fill: false,
            zIndex: 10
        });

        PremiumUI.mcChartInstance = new Chart(ctx, {
            type: 'line',
            data: { labels: Array.from({length: numTrades + 1}, (_, i) => i), datasets: datasets },
            options: {
                responsive: true, maintainAspectRatio: false,
                animation: { duration: 1500, easing: 'easeOutQuart' },
                plugins: { legend: { display: false }, tooltip: { enabled: false } },
                scales: {
                    x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.4)', maxTicksLimit: 10 } },
                    y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: 'rgba(255,255,255,0.6)' } }
                },
                interaction: { mode: 'none' }
            }
        });
    }
};

window.PremiumUI = PremiumUI;



// Economic Calendar Integration
PremiumUI.renderEconomicCalendar = function() {
    return `
        <div class="mt-8 card-apple p-1">
            <div class="p-4 border-b border-[var(--glass-border)] flex items-center justify-between">
                <div class="flex items-center gap-3">
                    <div class="w-8 h-8 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center">
                        <i class="ph-bold ph-calendar text-lg"></i>
                    </div>
                    <h3 class="font-bold text-[var(--text-main)]">Calendario Economico Macro</h3>
                </div>
                <span class="text-[10px] font-bold text-[var(--text-muted)] uppercase bg-[var(--input-bg)] px-2 py-1 rounded">Live</span>
            </div>
            <!-- Widget TradingView Economico -->
            <div class="h-[400px] w-full rounded-b-xl overflow-hidden">
                <iframe scrolling="no" allowtransparency="true" frameborder="0" src="https://s.tradingview.com/embed-widget/events/?locale=it&colorTheme=dark&isTransparent=true&importanceFilter=0,1" style="box-sizing: border-box; height: 100%; width: 100%;"></iframe>
            </div>
        </div>
    `;
};

