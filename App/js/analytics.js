// ==========================================
// ANALYTICS / EDGE FINDER
// Aggrega i trade eseguiti e mostra dove sta davvero il vantaggio.
// I payout non sono operazioni: restano fuori da ogni statistica.
// ==========================================
const Analytics = {
    state: {
        account: 'all',
        period: 'all',
        dimension: 'strategy',
        sortKey: 'pnl',
        sortDir: 'desc'
    },

    dimensions: [
        { id: 'strategy', label: 'Strategia', icon: 'ph-strategy' },
        { id: 'session', label: 'Sessione', icon: 'ph-clock' },
        { id: 'asset', label: 'Asset', icon: 'ph-currency-dollar' },
        { id: 'day', label: 'Giorno', icon: 'ph-calendar-blank' },
        { id: 'timeframe', label: 'Timeframe', icon: 'ph-chart-line' }
    ],

    periods: [
        { id: '1m', label: '1M' },
        { id: '3m', label: '3M' },
        { id: '6m', label: '6M' },
        { id: '1y', label: '1Y' },
        { id: 'all', label: 'All' }
    ],

    // --- SELEZIONE DATI ---

    getTrades() {
        let trades = (DataStore.data.trades || []).filter(t => t.status === 'executed' && t.type !== 'payout');

        if (this.state.account !== 'all') {
            trades = trades.filter(t => t.accountId == this.state.account);
        }

        const cutoff = this.periodCutoff();
        if (cutoff) {
            trades = trades.filter(t => {
                const d = new Date(t.date);
                return !isNaN(d) && d >= cutoff;
            });
        }

        return trades.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    },

    periodCutoff() {
        const period = this.state.period;
        if (period === 'all') return null;
        const d = new Date();
        if (period === '1m') d.setMonth(d.getMonth() - 1);
        else if (period === '3m') d.setMonth(d.getMonth() - 3);
        else if (period === '6m') d.setMonth(d.getMonth() - 6);
        else if (period === '1y') d.setFullYear(d.getFullYear() - 1);
        else return null;
        return d;
    },

    // --- CALCOLI ---

    // R-multiplo del trade. Se il rischio in denaro e' stato registrato il valore
    // e' esatto; altrimenti si stima dal campo R:R, assumendo che le perdite
    // abbiano colpito lo stop pieno (-1R).
    tradeR(t) {
        const pnl = parseFloat(t.pnl) || 0;
        const risk = Math.abs(parseFloat(t.riskAmount) || 0);
        if (risk > 0) return { r: pnl / risk, exact: true };

        const rr = Math.abs(parseFloat(t.rr) || 0);
        if (pnl > 0 && rr > 0) return { r: rr, exact: false };
        if (pnl < 0) return { r: -1, exact: false };
        return { r: 0, exact: false };
    },

    computeStats(trades) {
        let net = 0, grossProfit = 0, grossLoss = 0;
        let wins = 0, losses = 0, breakeven = 0;
        let running = 0, peak = 0, maxDrawdown = 0;
        let best = null, worst = null;
        let rSum = 0, rCount = 0, exactR = 0;
        const equity = [];
        const drawdown = [];

        trades.forEach(t => {
            const v = parseFloat(t.pnl) || 0;
            net += v;
            running += v;
            if (running > peak) peak = running;
            const dd = running - peak;
            if (dd < maxDrawdown) maxDrawdown = dd;

            const x = new Date(t.date).getTime();
            equity.push({ x, y: running });
            drawdown.push({ x, y: dd });

            if (v > 0) { wins++; grossProfit += v; }
            else if (v < 0) { losses++; grossLoss += Math.abs(v); }
            else breakeven++;

            if (best === null || v > best) best = v;
            if (worst === null || v < worst) worst = v;

            const r = this.tradeR(t);
            rSum += r.r;
            rCount++;
            if (r.exact) exactR++;
        });

        const total = trades.length;
        const streaks = this.computeStreaks(trades);

        return {
            total,
            net,
            wins,
            losses,
            breakeven,
            grossProfit,
            grossLoss,
            winRate: total > 0 ? (wins / total) * 100 : 0,
            profitFactor: grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? Infinity : 0),
            avgWin: wins > 0 ? grossProfit / wins : 0,
            avgLoss: losses > 0 ? grossLoss / losses : 0,
            payoff: losses > 0 && wins > 0 ? (grossProfit / wins) / (grossLoss / losses) : 0,
            expectancy: total > 0 ? net / total : 0,
            maxDrawdown: Math.abs(maxDrawdown),
            best: best === null ? 0 : best,
            worst: worst === null ? 0 : worst,
            avgR: rCount > 0 ? rSum / rCount : 0,
            totalR: rSum,
            exactRCount: exactR,
            equity,
            drawdown,
            ...streaks
        };
    },

    computeStreaks(trades) {
        let currentStreak = 0, currentType = null;
        let bestWinStreak = 0, worstLossStreak = 0;
        let runWin = 0, runLoss = 0;

        trades.forEach(t => {
            const v = parseFloat(t.pnl) || 0;
            if (v > 0) {
                runWin++;
                runLoss = 0;
                if (runWin > bestWinStreak) bestWinStreak = runWin;
            } else if (v < 0) {
                runLoss++;
                runWin = 0;
                if (runLoss > worstLossStreak) worstLossStreak = runLoss;
            } else {
                runWin = 0;
                runLoss = 0;
            }
        });

        // La striscia in corso guarda la coda della serie, non tutta la storia.
        for (let i = trades.length - 1; i >= 0; i--) {
            const v = parseFloat(trades[i].pnl) || 0;
            const type = v > 0 ? 'win' : v < 0 ? 'loss' : null;
            if (type === null) break;
            if (currentType === null) currentType = type;
            if (type !== currentType) break;
            currentStreak++;
        }

        return { currentStreak, currentType, bestWinStreak, worstLossStreak };
    },

    dimensionValue(trade, dimension) {
        switch (dimension) {
            case 'strategy': return trade.strategy || 'Senza strategia';
            case 'session': return trade.session || 'Senza sessione';
            case 'asset': return trade.asset || 'N/D';
            case 'timeframe': return trade.timeframe || 'N/D';
            case 'day': {
                const d = new Date(trade.date);
                if (isNaN(d)) return 'N/D';
                const name = d.toLocaleDateString('it-IT', { weekday: 'long' });
                return name.charAt(0).toUpperCase() + name.slice(1);
            }
            default: return 'N/D';
        }
    },

    groupBy(trades, dimension) {
        const groups = {};

        trades.forEach(t => {
            const key = this.dimensionValue(t, dimension);
            if (!groups[key]) groups[key] = [];
            groups[key].push(t);
        });

        return Object.keys(groups).map(label => {
            const rows = groups[label];
            const s = this.computeStats(rows);
            return {
                label,
                count: s.total,
                wins: s.wins,
                winRate: s.winRate,
                pnl: s.net,
                profitFactor: s.profitFactor,
                expectancy: s.expectancy,
                avgR: s.avgR
            };
        });
    },

    sortRows(rows) {
        const key = this.state.sortKey;
        const dir = this.state.sortDir === 'asc' ? 1 : -1;

        return rows.sort((a, b) => {
            if (key === 'label') return a.label.localeCompare(b.label) * dir;
            const av = a[key], bv = b[key];
            if (av === bv) return 0;
            return (av > bv ? 1 : -1) * dir;
        });
    },

    // Distribuzione degli R: dice se il profilo e' "tante piccole vincite" o
    // "poche vincite grosse", cosa che win rate e P&L da soli non mostrano.
    rDistribution(trades) {
        const buckets = [
            { label: '≤ -3R', min: -Infinity, max: -3, count: 0, negative: true },
            { label: '-3/-2R', min: -3, max: -2, count: 0, negative: true },
            { label: '-2/-1R', min: -2, max: -1, count: 0, negative: true },
            { label: '-1/0R', min: -1, max: 0, count: 0, negative: true },
            { label: '0/+1R', min: 0, max: 1, count: 0, negative: false },
            { label: '+1/+2R', min: 1, max: 2, count: 0, negative: false },
            { label: '+2/+3R', min: 2, max: 3, count: 0, negative: false },
            { label: '≥ +3R', min: 3, max: Infinity, count: 0, negative: false }
        ];

        trades.forEach(t => {
            const { r } = this.tradeR(t);
            const bucket = buckets.find(b => r >= b.min && r < b.max) || buckets[buckets.length - 1];
            bucket.count++;
        });

        return buckets;
    },

    // Il campo "errori" e' testo libero: lo spezziamo sui separatori naturali
    // per contare quante volte ricorre ogni errore e quanto costa.
    mistakeCost(trades) {
        const map = {};

        trades.forEach(t => {
            const raw = typeof t.mistakes === 'string' ? t.mistakes : '';
            if (!raw.trim()) return;

            const pnl = parseFloat(t.pnl) || 0;
            const seen = new Set();

            raw.split(/[,;\n\r•|]+/).forEach(part => {
                const token = part.trim().replace(/\s+/g, ' ').slice(0, 48);
                if (token.length < 3) return;
                const key = token.toLowerCase();
                if (seen.has(key)) return;
                seen.add(key);

                if (!map[key]) map[key] = { label: token, count: 0, pnl: 0, losses: 0 };
                map[key].count++;
                map[key].pnl += pnl;
                if (pnl < 0) map[key].losses++;
            });
        });

        return Object.values(map).sort((a, b) => a.pnl - b.pnl);
    },

    // --- RENDER ---

    formatPF(value) {
        if (value === Infinity) return '∞';
        if (!value) return '—';
        return value.toFixed(2);
    },

    formatR(value) {
        const v = value || 0;
        return `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`;
    },

    render() {
        if (!ui.container) return;

        const trades = this.getTrades();
        const stats = this.computeStats(trades);
        const accounts = DataStore.data.accounts || [];

        const pill = (active, onclick, label) => `
            <button onclick="${onclick}" class="an-pill ${active ? 'active' : ''}">${label}</button>`;

        ui.container.innerHTML = `
        <div class="an fade-in">

            <header class="an-hero">
                <div class="min-w-0">
                    <h1 class="an-hero-title">Analytics</h1>
                    <p class="an-hero-sub">Dove guadagni davvero e dove stai solo pagando commissioni. Payout esclusi.</p>
                </div>
                <button onclick="PDFExport.openExportModal()" class="an-btn">
                    <i class="ph-bold ph-file-pdf"></i>
                    <span>Esporta report</span>
                </button>
            </header>

            <div class="an-filters">
                <div class="an-filter-group">
                    <span class="an-filter-label">Conto</span>
                    <div class="an-pills">
                        ${pill(this.state.account === 'all', `Analytics.setFilter('account','all')`, 'Tutti')}
                        ${accounts.map(a => pill(this.state.account == a.id, `Analytics.setFilter('account','${a.id}')`, ui.escapeHtml(a.name))).join('')}
                    </div>
                </div>
                <div class="an-filter-group">
                    <span class="an-filter-label">Periodo</span>
                    <div class="an-pills">
                        ${this.periods.map(p => pill(this.state.period === p.id, `Analytics.setFilter('period','${p.id}')`, p.label)).join('')}
                    </div>
                </div>
            </div>

            ${trades.length === 0 ? `
            <section class="an-empty">
                <div class="an-empty-mark"><i class="ph-bold ph-chart-bar"></i></div>
                <h2>Nessun trade in questo periodo</h2>
                <p>Le statistiche compaiono appena registri operazioni eseguite sul conto e sull'intervallo selezionati.</p>
            </section>
            ` : `
            ${this.kpiMarkup(stats)}
            ${this.equityMarkup(stats)}
            ${this.edgeMarkup(trades)}
            <div class="an-split">
                ${this.distributionMarkup(trades, stats)}
                ${this.mistakesMarkup(trades)}
            </div>
            `}
        </div>`;

        // Il grafico si disegna al frame dopo: Chart.js misura il contenitore e
        // subito dopo l'innerHTML il layout non e' ancora stato calcolato.
        if (trades.length > 0) requestAnimationFrame(() => this.renderChart(stats));
    },

    kpiMarkup(s) {
        const card = (label, value, cls = '', hint = '') => `
            <div class="an-kpi">
                <span class="an-kpi-label">${label}</span>
                <span class="an-kpi-value ${cls}">${value}</span>
                ${hint ? `<span class="an-kpi-hint">${hint}</span>` : ''}
            </div>`;

        const streakLabel = s.currentStreak > 0 && s.currentType
            ? `${s.currentStreak} ${s.currentType === 'win' ? 'vinti' : 'persi'} di fila`
            : 'nessuna serie attiva';

        return `
        <section class="an-kpis">
            ${card('P&L netto', ui.formatCurrency(s.net), s.net >= 0 ? 'pos' : 'neg', `${s.total} trade`)}
            ${card('Profit factor', this.formatPF(s.profitFactor), s.profitFactor >= 1 ? 'pos' : 'neg', 'profitti / perdite')}
            ${card('Expectancy', ui.formatCurrency(s.expectancy), s.expectancy >= 0 ? 'pos' : 'neg', 'per trade')}
            ${card('Max drawdown', ui.formatCurrency(s.maxDrawdown), 'neg', 'picco → minimo')}
            ${card('Win rate', `${s.winRate.toFixed(1)}%`, '', `${s.wins}W · ${s.losses}L${s.breakeven ? ` · ${s.breakeven}BE` : ''}`)}
            ${card('Payoff', s.payoff ? `${s.payoff.toFixed(2)}:1` : '—', '', 'avg win / avg loss')}
            ${card('R medio', this.formatR(s.avgR), s.avgR >= 0 ? 'pos' : 'neg', `${this.formatR(s.totalR)} totali`)}
            ${card('Serie', String(s.currentStreak || 0), s.currentType === 'loss' ? 'neg' : s.currentType === 'win' ? 'pos' : '', streakLabel)}
        </section>`;
    },

    equityMarkup(s) {
        return `
        <section class="an-panel">
            <div class="an-panel-head">
                <div>
                    <h2 class="an-panel-title">Equity e drawdown</h2>
                    <p class="an-panel-sub">La curva sopra, quanto sei stato sotto il tuo massimo qui sotto.</p>
                </div>
                <div class="an-panel-meta">
                    <span>Best <b class="pos">${ui.formatCurrency(s.best)}</b></span>
                    <span>Worst <b class="neg">${ui.formatCurrency(s.worst)}</b></span>
                    <span>Max serie <b>${s.bestWinStreak}W</b> / <b>${s.worstLossStreak}L</b></span>
                </div>
            </div>
            <div class="an-chart"><canvas id="analyticsChart"></canvas></div>
        </section>`;
    },

    edgeMarkup(trades) {
        return `
        <section class="an-panel">
            <div class="an-panel-head">
                <div>
                    <h2 class="an-panel-title">Edge finder</h2>
                    <p class="an-panel-sub">Stesso conto, stesso periodo: cambia solo come raggruppi i trade.</p>
                </div>
                <div class="an-pills">
                    ${this.dimensions.map(d => `
                        <button onclick="Analytics.setDimension('${d.id}')" class="an-pill ${this.state.dimension === d.id ? 'active' : ''}">
                            <i class="ph-bold ${d.icon}"></i>${d.label}
                        </button>`).join('')}
                </div>
            </div>
            <div id="an-table-wrap">${this.tableMarkup(trades)}</div>
        </section>`;
    },

    tableMarkup(trades) {
        const rows = this.sortRows(this.groupBy(trades, this.state.dimension));
        if (rows.length === 0) return '<p class="an-note">Nessun dato per questa dimensione.</p>';

        const maxAbs = Math.max(...rows.map(r => Math.abs(r.pnl)), 1);
        const arrow = key => this.state.sortKey === key
            ? `<i class="ph-bold ${this.state.sortDir === 'asc' ? 'ph-caret-up' : 'ph-caret-down'}"></i>`
            : '';
        const th = (key, label, align = 'right') => `
            <th class="an-th ${align}" onclick="Analytics.setSort('${key}')">
                <span>${label}${arrow(key)}</span>
            </th>`;

        return `
        <div class="an-table-scroll">
            <table class="an-table">
                <thead>
                    <tr>
                        ${th('label', 'Nome', 'left')}
                        ${th('count', 'Trade')}
                        ${th('winRate', 'Win %')}
                        ${th('profitFactor', 'PF')}
                        ${th('expectancy', 'Exp.')}
                        ${th('avgR', 'R medio')}
                        ${th('pnl', 'P&L')}
                    </tr>
                </thead>
                <tbody>
                    ${rows.map(r => `
                    <tr>
                        <td class="an-td left">
                            <span class="an-row-name">${ui.escapeHtml(r.label)}</span>
                            <span class="an-row-bar"><i style="width:${(Math.abs(r.pnl) / maxAbs) * 100}%;background:${r.pnl >= 0 ? 'var(--accent-green)' : 'var(--accent-red)'}"></i></span>
                        </td>
                        <td class="an-td">${r.count}</td>
                        <td class="an-td">${r.winRate.toFixed(0)}%</td>
                        <td class="an-td">${this.formatPF(r.profitFactor)}</td>
                        <td class="an-td ${r.expectancy >= 0 ? 'pos' : 'neg'}">${ui.formatCurrency(r.expectancy)}</td>
                        <td class="an-td ${r.avgR >= 0 ? 'pos' : 'neg'}">${this.formatR(r.avgR)}</td>
                        <td class="an-td strong ${r.pnl >= 0 ? 'pos' : 'neg'}">${ui.formatCurrency(r.pnl)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>
        </div>`;
    },

    distributionMarkup(trades, stats) {
        const buckets = this.rDistribution(trades);
        const max = Math.max(...buckets.map(b => b.count), 1);
        const estimated = trades.length - stats.exactRCount;

        return `
        <section class="an-panel">
            <div class="an-panel-head">
                <div>
                    <h2 class="an-panel-title">Distribuzione R</h2>
                    <p class="an-panel-sub">Quanti trade chiudi a ogni multiplo del rischio.</p>
                </div>
            </div>
            <div class="an-hist">
                ${buckets.map(b => `
                <div class="an-hist-col" title="${b.count} trade">
                    <span class="an-hist-count">${b.count || ''}</span>
                    <div class="an-hist-bar ${b.negative ? 'neg' : 'pos'}" style="height:${Math.max(b.count / max * 100, b.count ? 4 : 0)}%"></div>
                    <span class="an-hist-label">${b.label}</span>
                </div>`).join('')}
            </div>
            ${estimated > 0 ? `<p class="an-note"><i class="ph-bold ph-info"></i> ${estimated} trade su ${trades.length} hanno R stimato dal campo R:R (perdite contate come -1R). Compila il rischio nel trade per valori esatti.</p>` : ''}
        </section>`;
    },

    mistakesMarkup(trades) {
        const rows = this.mistakeCost(trades).slice(0, 8);

        return `
        <section class="an-panel">
            <div class="an-panel-head">
                <div>
                    <h2 class="an-panel-title">Costo degli errori</h2>
                    <p class="an-panel-sub">Ricavato dal campo "Errori" dei trade, ordinato per quanto ti e' costato.</p>
                </div>
            </div>
            ${rows.length === 0 ? `
            <p class="an-note">Nessun errore annotato in questo periodo. Il campo "Errori" del trade alimenta questa lista.</p>
            ` : `
            <ul class="an-mistakes">
                ${rows.map(m => `
                <li class="an-mistake">
                    <span class="an-mistake-label">${ui.escapeHtml(m.label)}</span>
                    <span class="an-mistake-meta">${m.count}× · ${m.losses} in perdita</span>
                    <span class="an-mistake-pnl ${m.pnl >= 0 ? 'pos' : 'neg'}">${ui.formatCurrency(m.pnl)}</span>
                </li>`).join('')}
            </ul>
            `}
        </section>`;
    },

    renderChart(stats) {
        const canvas = document.getElementById('analyticsChart');
        if (!canvas || typeof Chart === 'undefined') return;

        if (window.myAnalyticsChart) {
            window.myAnalyticsChart.destroy();
            window.myAnalyticsChart = null;
        }

        const maxDD = Math.max(stats.maxDrawdown, 1);

        // Con timestamp cosi' grandi la scala lineare arrotonda il massimo al
        // tick "tondo" successivo e schiaccia la curva a sinistra: la ancoriamo
        // agli estremi reali dei dati.
        const xs = stats.equity.map(p => p.x).filter(x => !isNaN(x));
        let xMin = xs.length ? Math.min(...xs) : Date.now() - 86400000;
        let xMax = xs.length ? Math.max(...xs) : Date.now();
        if (xMin === xMax) { xMin -= 43200000; xMax += 43200000; }

        window.myAnalyticsChart = new Chart(canvas, {
            type: 'line',
            data: {
                datasets: [
                    {
                        label: 'Equity',
                        data: stats.equity,
                        borderColor: stats.net >= 0 ? '#22c55e' : '#ef4444',
                        backgroundColor: stats.net >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
                        borderWidth: 2.5,
                        tension: 0.35,
                        fill: true,
                        pointRadius: 0,
                        pointHoverRadius: 5,
                        yAxisID: 'y',
                        order: 0
                    },
                    {
                        label: 'Drawdown',
                        data: stats.drawdown,
                        borderColor: 'rgba(239,68,68,0.55)',
                        backgroundColor: 'rgba(239,68,68,0.18)',
                        borderWidth: 1.5,
                        tension: 0.25,
                        fill: true,
                        pointRadius: 0,
                        pointHoverRadius: 4,
                        yAxisID: 'y1',
                        // order piu' alto = disegnato prima, quindi dietro l'equity
                        order: 1
                    }
                ]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: { duration: 400 },
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: 'rgba(0,0,0,0.9)',
                        titleColor: '#fff',
                        bodyColor: '#fff',
                        borderColor: 'rgba(255,255,255,0.1)',
                        borderWidth: 1,
                        padding: 12,
                        displayColors: true,
                        callbacks: {
                            title: (items) => new Date(items[0].parsed.x).toLocaleDateString('it-IT', { day: 'numeric', month: 'short', year: 'numeric' }),
                            label: (item) => `${item.dataset.label}: ${ui.formatCurrency(item.parsed.y)}`
                        }
                    }
                },
                scales: {
                    x: { type: 'linear', display: false, min: xMin, max: xMax },
                    y: {
                        position: 'right',
                        grid: { color: 'rgba(255,255,255,0.05)', drawBorder: false },
                        ticks: { color: '#86868B', font: { size: 10 }, callback: v => v.toFixed(0) }
                    },
                    // Il drawdown resta nella fascia bassa: lo zero cade a un terzo
                    // dall'alto, cosi' l'area rossa scende senza coprire l'equity.
                    y1: { display: false, min: -maxDD * 1.05, max: maxDD * 2.1 }
                }
            }
        });
    },

    // --- INTERAZIONI ---

    setFilter(key, value) {
        this.state[key] = value;
        this.render();
    },

    setDimension(dimension) {
        this.state.dimension = dimension;
        this.refreshTable();
    },

    setSort(key) {
        if (this.state.sortKey === key) {
            this.state.sortDir = this.state.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
            this.state.sortKey = key;
            this.state.sortDir = key === 'label' ? 'asc' : 'desc';
        }
        this.refreshTable();
    },

    // Ridisegna solo la tabella: cambiare ordinamento non deve far ripartire
    // l'animazione del grafico ne' riportare lo scroll in cima.
    refreshTable() {
        const wrap = document.getElementById('an-table-wrap');
        if (!wrap) {
            this.render();
            return;
        }
        wrap.innerHTML = this.tableMarkup(this.getTrades());

        const panel = wrap.closest('.an-panel');
        if (panel) {
            panel.querySelectorAll('.an-pill').forEach(btn => {
                const active = btn.getAttribute('onclick') === `Analytics.setDimension('${this.state.dimension}')`;
                btn.classList.toggle('active', active);
            });
        }
    }
};

// Il router risolve le pagine come metodi di `ui`.
ui.analytics = function () { return Analytics.render(); };
