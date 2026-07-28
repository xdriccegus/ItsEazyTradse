// PDF Export Premium — EazyTrader
// BULLETPROOF STRING APPROACH
const PDFExport = {
    selectedPeriod: '1m',

    openExportModal() {
        let modal = document.getElementById('modal-pdf-export');
        if (!modal) {
            const overlay = document.getElementById('modal-overlay');
            if (!overlay) { ui.showToast('Errore di sistema', true); return; }
            overlay.insertAdjacentHTML('beforeend', '<div id="modal-pdf-export" class="modal-clean hidden scale-95 transition-all duration-300 flex flex-col max-h-[90dvh] w-full md:w-auto"></div>');
            modal = document.getElementById('modal-pdf-export');
        }

        const periods = [
            { id: '1w', label: 'Ultima Settimana' },
            { id: '1m', label: 'Ultimo Mese' },
            { id: '3m', label: 'Ultimi 3 Mesi' },
            { id: 'ytd', label: 'Da Inizio Anno' },
            { id: 'all', label: 'Tutto lo Storico' },
        ];

        modal.innerHTML = `
            <div class="bg-[var(--bg-card)] w-full max-w-sm rounded-3xl border border-[var(--glass-border)] overflow-hidden shadow-2xl">
                <div class="bg-gradient-to-br from-blue-600/20 to-purple-600/10 px-7 py-6 border-b border-[var(--glass-border)] flex items-center justify-between">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center shadow-lg shadow-blue-500/30 shrink-0">
                            <i class="ph-bold ph-file-pdf text-white text-lg"></i>
                        </div>
                        <div>
                            <h3 class="text-lg font-bold text-white preserve-white leading-tight">Esporta Report</h3>
                            <p class="text-[11px] text-[var(--text-muted)]">Report PDF privato multi-pagina</p>
                        </div>
                    </div>
                    <button onclick="ui.closeModals()" class="w-9 h-9 flex items-center justify-center rounded-full bg-white/5 hover:bg-white/10 text-[var(--text-muted)] hover:text-white transition-all ml-3 shrink-0">
                        <i class="ph-bold ph-x"></i>
                    </button>
                </div>
                <div class="px-7 py-6 space-y-5">
                    <div>
                        <p class="text-[11px] font-bold text-[var(--text-muted)] uppercase tracking-widest mb-3">Seleziona Periodo</p>
                        <div class="space-y-2">
                            ${periods.map(p => `
                                <button onclick="PDFExport.setPeriod('${p.id}')" data-period="${p.id}"
                                    class="pdf-period-btn w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-sm font-semibold
                                        ${p.id === PDFExport.selectedPeriod
                                            ? 'bg-blue-600/20 border-blue-500/50 text-blue-300'
                                            : 'bg-white/[0.02] border-[var(--glass-border)] text-[var(--text-muted)] hover:text-white hover:bg-white/5'}">
                                    <span>${p.label}</span>
                                    <i class="${p.id === PDFExport.selectedPeriod ? 'ph-bold ph-check-circle text-blue-400' : 'ph-bold ph-circle text-white/20'} text-base"></i>
                                </button>
                            `).join('')}
                        </div>
                    </div>
                </div>
                <div class="px-7 pb-6">
                    <button onclick="PDFExport.generateMultiPagePDF()"
                        class="w-full bg-gradient-to-r from-blue-600 to-blue-500 hover:from-blue-500 hover:to-blue-400 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-blue-600/20 flex items-center justify-center gap-2 text-sm">
                        <i class="ph-bold ph-download-simple"></i> Genera PDF
                    </button>
                </div>
            </div>`;
        PDFExport.selectedPeriod = PDFExport.selectedPeriod || '1m';
        ui.openModal('modal-pdf-export');
    },

    setPeriod(p) {
        PDFExport.selectedPeriod = p;
        document.querySelectorAll('.pdf-period-btn').forEach(b => {
            const a = b.dataset.period === p;
            b.className = `pdf-period-btn w-full flex items-center justify-between px-4 py-3 rounded-xl border transition-all text-sm font-semibold ${a?'bg-blue-600/20 border-blue-500/50 text-blue-300':'bg-white/[0.02] border-[var(--glass-border)] text-[var(--text-muted)] hover:text-white hover:bg-white/5'}`;
            b.querySelector('i').className = `${a?'ph-bold ph-check-circle text-blue-400':'ph-bold ph-circle text-white/20'} text-base`;
        });
    },

    getFilteredTradesForExport() {
        const now = new Date(); let s = new Date(0);
        if (PDFExport.selectedPeriod==='1w'){s=new Date(now);s.setDate(s.getDate()-7);}
        else if(PDFExport.selectedPeriod==='1m'){s=new Date(now);s.setMonth(s.getMonth()-1);}
        else if(PDFExport.selectedPeriod==='3m'){s=new Date(now);s.setMonth(s.getMonth()-3);}
        else if(PDFExport.selectedPeriod==='ytd'){s=new Date(now.getFullYear(),0,1);}
        const all=DataStore.data.trades.filter(t=>t.status==='executed'&&t.type!=='payout');
        const af=(ui.dashboardFilter==='all'||!ui.dashboardFilter)?all:all.filter(t=>t.accountId==ui.dashboardFilter);
        return af.filter(t=>new Date(t.date)>=s);
    },

    async generateMultiPagePDF() {
        if (typeof html2pdf === 'undefined') { ui.showToast('Libreria non caricata.',true); return; }
        ui.closeModals();

        // Overlay to block user interaction (does NOT hide the element rendering, because we use a string!)
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;background:rgba(8,8,14,0.98);z-index:999999;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;color:#fff;font-family:-apple-system,sans-serif;';
        overlay.innerHTML = '<div style="width:48px;height:48px;border:3px solid rgba(59,130,246,0.3);border-top-color:#3b82f6;border-radius:50%;animation:pdfspin 0.8s linear infinite;"></div><style>@keyframes pdfspin{to{transform:rotate(360deg)}}</style><p style="font-size:18px;font-weight:700;margin:0;">Generazione Report Avanzato...</p>';
        document.body.appendChild(overlay);

        try {
            const trades = PDFExport.getFilteredTradesForExport();
            let pnl=0,wC=0,lC=0,gP=0,gL=0,peak=0,rPnl=0,mDD=0;
            const aM={},sM={},dM={};
            trades.forEach(t=>{
                const v=parseFloat(t.pnl)||0; pnl+=v; rPnl+=v;
                if(rPnl>peak)peak=rPnl; const dd=peak-rPnl; if(dd>mDD)mDD=dd;
                if(v>0){wC++;gP+=v;}else if(v<0){lC++;gL+=Math.abs(v);}
                const as=t.asset||'N/A';
                if(!aM[as])aM[as]={n:0,w:0,l:0,c:0}; aM[as].n+=v;aM[as].c++;if(v>0)aM[as].w++;else if(v<0)aM[as].l++;
                const st=t.strategy||'Nessuna';
                if(!sM[st])sM[st]={n:0,w:0,l:0,c:0}; sM[st].n+=v;sM[st].c++;if(v>0)sM[st].w++;else if(v<0)sM[st].l++;
                const dk=new Date(t.date).toLocaleDateString('it-IT',{weekday:'long'});
                if(!dM[dk])dM[dk]={n:0,c:0}; dM[dk].n+=v;dM[dk].c++;
            });
            const tot=trades.length;
            const wr=tot>0?((wC/tot)*100).toFixed(1):'0.0';
            const pf=gL>0?(gP/gL).toFixed(2):(gP>0?'∞':'-');
            const aW=wC>0?(gP/wC):0, aL=lC>0?(gL/lC):0;
            const exp=tot>0?(pnl/tot):0;
            const rr=aL>0?(aW/aL).toFixed(2):'-';
            const acN=(ui.dashboardFilter==='all'||!ui.dashboardFilter)?'Tutti i Conti':(DataStore.data.accounts.find(a=>a.id==ui.dashboardFilter)?.name||'Account');
            const pM={'1w':'Ultimi 7 Giorni','1m':'Ultimi 30 Giorni','3m':'Ultimi 3 Mesi','ytd':'Da Inizio Anno','all':'Tutto lo Storico'};
            const pT=pM[PDFExport.selectedPeriod]||'Periodo';
            const fc=v=>ui.formatCurrency(v);
            const fd=d=>new Date(d).toLocaleDateString('it-IT',{day:'2-digit',month:'2-digit',year:'2-digit'});

            let chartImg='';
            const eq=document.getElementById('equityChart');
            if(eq&&eq.width>0){const c=document.createElement('canvas');c.width=eq.width;c.height=eq.height;const x=c.getContext('2d');x.fillStyle='#111118';x.fillRect(0,0,c.width,c.height);x.drawImage(eq,0,0);chartImg=c.toDataURL('image/png',1.0);}

            const best=[...trades].sort((a,b)=>parseFloat(b.pnl)-parseFloat(a.pnl)).filter(t=>parseFloat(t.pnl)>0).slice(0,5);
            const worst=[...trades].sort((a,b)=>parseFloat(a.pnl)-parseFloat(b.pnl)).filter(t=>parseFloat(t.pnl)<0).slice(0,5);
            const recent=[...trades].sort((a,b)=>new Date(b.date)-new Date(a.date)).slice(0,25);
            const assetR=Object.entries(aM).sort((a,b)=>b[1].n-a[1].n);
            const stratR=Object.entries(sM).sort((a,b)=>b[1].n-a[1].n);
            const dayR=Object.entries(dM).sort((a,b)=>b[1].n-a[1].n);

            const vc=v=>v>=0?'#22c55e':'#ef4444';

            const headSection = () => `
                <div style="text-align:center;padding:20px 0;border-bottom:1px solid #2a2a3a;margin-bottom:30px;">
                    <div style="font-size:26px;font-weight:800;color:#f0f0f5;">EazyTrader Analytics</div>
                    <div style="font-size:14px;color:#7a7a90;margin-top:6px;">${pT} &mdash; ${acN}</div>
                    <div style="font-size:11px;color:#7a7a90;margin-top:4px;">${new Date().toLocaleDateString('it-IT',{day:'2-digit',month:'long',year:'numeric'})}</div>
                </div>
            `;

            const kpi = (lbl, val, col='#f0f0f5') => `
                <td style="padding:16px;background:#1a1a24;border:1px solid #2a2a3a;border-radius:10px;width:33.3%;">
                    <div style="font-size:11px;color:#7a7a90;text-transform:uppercase;margin-bottom:8px;font-weight:600;">${lbl}</div>
                    <div style="font-size:24px;font-weight:800;color:${col};">${val}</div>
                </td>
            `;

            const tHead = `<thead><tr style="background:#1a1a24;">
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:left;border-bottom:1px solid #2a2a3a;">DATA</th>
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:left;border-bottom:1px solid #2a2a3a;">ASSET</th>
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:left;border-bottom:1px solid #2a2a3a;">DIR</th>
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:left;border-bottom:1px solid #2a2a3a;">STRATEGIA</th>
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:right;border-bottom:1px solid #2a2a3a;">RR</th>
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:right;border-bottom:1px solid #2a2a3a;">P&L</th>
            </tr></thead>`;

            const tRow = (t) => {
                const v=parseFloat(t.pnl)||0;
                return `<tr>
                    <td style="padding:12px;font-size:12px;color:#7a7a90;border-bottom:1px solid #2a2a3a;">${fd(t.date)}</td>
                    <td style="padding:12px;font-size:12px;font-weight:700;color:#f0f0f5;border-bottom:1px solid #2a2a3a;">${t.asset}</td>
                    <td style="padding:12px;border-bottom:1px solid #2a2a3a;"><span style="color:${t.direction==='LONG'?'#22c55e':'#ef4444'};font-size:11px;font-weight:700;">${t.direction}</span></td>
                    <td style="padding:12px;font-size:12px;color:#7a7a90;border-bottom:1px solid #2a2a3a;">${t.strategy||'—'}</td>
                    <td style="padding:12px;font-size:12px;color:#7a7a90;text-align:right;border-bottom:1px solid #2a2a3a;">${t.rr?t.rr+'R':'—'}</td>
                    <td style="padding:12px;font-size:12px;font-weight:700;text-align:right;color:${vc(v)};border-bottom:1px solid #2a2a3a;">${v>=0?'+':''}${fc(v)}</td>
                </tr>`;
            };

            const tWrap = (title, rws) => `
                <div style="font-size:16px;font-weight:800;color:#f0f0f5;margin:30px 0 10px;">${title}</div>
                <div style="background:#1a1a24;border:1px solid #2a2a3a;border-radius:10px;overflow:hidden;">
                    <table style="width:100%;border-collapse:collapse;">${tHead}<tbody>${rws}</tbody></table>
                </div>
            `;

            const statHead = `<thead><tr style="background:#1a1a24;">
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:left;border-bottom:1px solid #2a2a3a;">NOME</th>
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:center;border-bottom:1px solid #2a2a3a;">TRADE</th>
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:center;border-bottom:1px solid #2a2a3a;">WIN %</th>
                <th style="padding:12px;font-size:11px;color:#7a7a90;text-align:right;border-bottom:1px solid #2a2a3a;">P&L</th>
            </tr></thead>`;

            const statRow = (n,d) => `<tr>
                <td style="padding:12px;font-size:12px;font-weight:700;color:#f0f0f5;border-bottom:1px solid #2a2a3a;text-transform:capitalize;">${n}</td>
                <td style="padding:12px;font-size:12px;color:#7a7a90;text-align:center;border-bottom:1px solid #2a2a3a;">${d.c}</td>
                <td style="padding:12px;font-size:12px;color:#f0f0f5;text-align:center;border-bottom:1px solid #2a2a3a;">${d.c>0?((d.w/d.c)*100).toFixed(0):0}%</td>
                <td style="padding:12px;font-size:12px;font-weight:700;text-align:right;color:${vc(d.n)};border-bottom:1px solid #2a2a3a;">${d.n>=0?'+':''}${fc(d.n)}</td>
            </tr>`;
            
            const statWrap = (title, rws) => `
                <div style="font-size:16px;font-weight:800;color:#f0f0f5;margin:30px 0 10px;">${title}</div>
                <div style="background:#1a1a24;border:1px solid #2a2a3a;border-radius:10px;overflow:hidden;">
                    <table style="width:100%;border-collapse:collapse;">${statHead}<tbody>${rws}</tbody></table>
                </div>
            `;

            const pageBreak = `<div class="html2pdf__page-break"></div>`;

            // WE BUILD 4 DISCRETE PAGES TO AVOID ANY AUTO-PAGEBREAK CLIPPING
            const htmlString = `
                <div style="width: 700px; padding: 0; font-family: -apple-system, sans-serif; background: #111118; color: #f0f0f5;">
                    
                    <!-- PAGE 1 -->
                    ${headSection()}
                    <div style="font-size:16px;font-weight:800;color:#f0f0f5;margin:0 0 10px;">Performance Overview</div>
                    <table style="width:100%;border-collapse:separate;border-spacing:10px 0;margin-bottom:10px;"><tr>
                        ${kpi('P&L Netto', (pnl>=0?'+':'')+fc(pnl), vc(pnl))}
                        ${kpi('Win Rate', wr+'%')}
                        ${kpi('Profit Factor', pf)}
                    </tr></table>
                    <table style="width:100%;border-collapse:separate;border-spacing:10px 0;margin-bottom:10px;"><tr>
                        ${kpi('Avg Win', fc(aW), '#22c55e')}
                        ${kpi('Avg Loss', fc(aL), '#ef4444')}
                        ${kpi('Max Drawdown', fc(mDD), '#ef4444')}
                    </tr></table>
                    <table style="width:100%;border-collapse:separate;border-spacing:10px 0;margin-bottom:30px;"><tr>
                        ${kpi('Expectancy', (exp>=0?'+':'')+fc(exp), vc(exp))}
                        ${kpi('Risk/Reward', rr+':1', '#f59e0b')}
                        ${kpi('Totale Trade', tot)}
                    </tr></table>
                    
                    ${chartImg ? `
                        <div style="font-size:16px;font-weight:800;color:#f0f0f5;margin:0 0 10px;">Equity Curve</div>
                        <div style="background:#1a1a24;border:1px solid #2a2a3a;border-radius:10px;padding:16px;overflow:hidden;">
                            <img src="${chartImg}" style="width:100%;height:auto;display:block;" />
                        </div>
                    ` : ''}
                    
                    ${pageBreak}

                    <!-- PAGE 2 -->
                    ${headSection()}
                    ${assetR.length > 0 ? statWrap('Performance per Asset', assetR.map(([n,d])=>statRow(n,d)).join('')) : ''}
                    ${stratR.length > 0 ? statWrap('Performance per Strategia', stratR.map(([n,d])=>statRow(n,d)).join('')) : ''}
                    ${dayR.length > 0 ? statWrap('Performance per Giorno', dayR.map(([n,d])=>statRow(n,d)).join('')) : ''}
                    
                    ${pageBreak}

                    <!-- PAGE 3 -->
                    ${headSection()}
                    ${best.length > 0 ? tWrap('Top '+best.length+' Trade Vincenti', best.map(tRow).join('')) : ''}
                    ${worst.length > 0 ? tWrap('Peggiori '+worst.length+' Drawdown', worst.map(tRow).join('')) : ''}
                    
                    ${pageBreak}

                    <!-- PAGE 4 -->
                    ${headSection()}
                    ${recent.length > 0 ? tWrap('Trade Log — Ultimi '+recent.length, recent.map(tRow).join('')) : '<div style="margin-top:20px;color:#7a7a90;">Nessun trade presente.</div>'}
                    
                </div>
            `;

            const filename = `Report_Privato_${new Date().toISOString().split('T')[0]}.pdf`;

            const opt = {
                margin: 10,
                filename: filename,
                image: { type: 'jpeg', quality: 0.98 },
                html2canvas: {
                    scale: 2,
                    useCORS: true,
                    backgroundColor: '#111118',
                    windowWidth: 1000 // Ensures the headless iframe is wider than 700px to prevent horizontal clipping
                },
                jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
            };

            await html2pdf().set(opt).from(htmlString).save();

            ui.showToast('✅ Report PDF generato con successo!');

        } catch (err) {
            console.error('[PDFExport] Errore:', err);
            ui.showToast('Errore: ' + err.message, true);
        } finally {
            document.body.removeChild(overlay);
        }
    }
};
window.PDFExport = PDFExport;
