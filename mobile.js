const MobileOptimizer = {
    initialized: false,

    init() {
        if (this.initialized) {
            console.warn('MobileOptimizer already initialized');
            return;
        }
        this.detectDevice();
        this.setupTouchEvents();
        this.preventDoubleTapZoom();
        this.setupKeyboardHandling();
        this.setupOrientationChange();
        this.setupPWA();
        this.initialized = true;
    },

    detectDevice() {
        const isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);

        if (isMobile) {
            document.body.classList.add('is-mobile');
        }
        if (isIOS) {
            document.body.classList.add('is-ios');
        }
    },

    setupTouchEvents() {
        // Aggiungi feedback haptic anche agli elementi creati dinamicamente.
        if ('vibrate' in navigator) {
            document.addEventListener('touchstart', (e) => {
                const touchTarget = e.target.closest('button, .dock-icon');
                if (touchTarget) {
                    navigator.vibrate(10);
                }
            }, { passive: true });
        }
    },

    preventDoubleTapZoom() {
        // Previene zoom con doppio tap, senza bloccare input e campi editabili.
        let lastTouchEnd = 0;
        const handleTouchEnd = (e) => {
            const target = e.target;
            const isEditable = target && target.closest('input, textarea, select, [contenteditable="true"]');
            const now = Date.now();
            if (!isEditable && now - lastTouchEnd <= 300) {
                e.preventDefault();
            }
            lastTouchEnd = now;
        };
        document.addEventListener('touchend', handleTouchEnd, { passive: false });
    },

    setupKeyboardHandling() {
        // Gestisce la tastiera mobile per evitare che copra gli input
        if ('visualViewport' in window) {
            let prevHeight = window.visualViewport.height;

            window.visualViewport.addEventListener('resize', () => {
                const currentHeight = window.visualViewport.height;
                const diff = prevHeight - currentHeight;

                // Tastiera aperta
                if (diff > 0) {
                    const focusedElement = document.activeElement;
                    if (focusedElement && (focusedElement.tagName === 'INPUT' || focusedElement.tagName === 'TEXTAREA' || focusedElement.tagName === 'SELECT')) {
                        setTimeout(() => {
                            focusedElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }, 300);
                    }
                }

                prevHeight = currentHeight;
            });
        }

        // Auto-scroll quando un input ottiene focus (fallback)
        document.addEventListener('focusin', (e) => {
            if (e.target.matches('input, textarea, select')) {
                setTimeout(() => {
                    e.target.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }, 300);
            }
        });
    },

    // Scroll progress indicator
    setupScrollProgress() {
        const progressBar = document.getElementById('scroll-progress');
        const mainContent = document.getElementById('main-content');

        if (progressBar && mainContent) {
            mainContent.addEventListener('scroll', () => {
                const scrollTop = mainContent.scrollTop;
                const scrollHeight = mainContent.scrollHeight - mainContent.clientHeight;
                const scrollPercent = scrollHeight > 0 ? (scrollTop / scrollHeight) * 100 : 0;
                progressBar.style.width = `${Math.min(scrollPercent, 100)}%`;
            });
        }
    },

    setupOrientationChange() {
        // Gestisce il cambio di orientamento
        window.addEventListener('orientationchange', () => {
            // Piccolo delay per permettere al browser di adattarsi
            setTimeout(() => {
                // Forza un reflow per evitare problemi di layout
                document.body.style.display = 'none';
                document.body.offsetHeight; // Force reflow
                document.body.style.display = '';
            }, 100);
        });
    },

    setupPWA() {
        // PWA installation prompt (senza service worker)
        let deferredPrompt;
        window.addEventListener('beforeinstallprompt', (e) => {
            e.preventDefault();
            deferredPrompt = e;
        });

        window.addEventListener('appinstalled', () => {
            deferredPrompt = null;
            ui.showToast('App installata con successo! ✨');
        });
    },

    // Confetti effect for milestones
    celebrateSuccess() {
        const colors = ['#0A84FF', '#30D158', '#FF453A', '#FF9F0A', '#BF5AF2'];
        const confettiCount = 60;
        const container = document.createElement('div');
        container.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;overflow:hidden;';
        document.body.appendChild(container);

        for (let i = 0; i < confettiCount; i++) {
            const confetti = document.createElement('div');
            const size = Math.random() * 8 + 6;
            const left = Math.random() * 100;
            const duration = Math.random() * 2 + 2;
            const delay = Math.random() * 0.5;

            confetti.style.cssText = `
                position: absolute;
                width: ${size}px;
                height: ${size}px;
                background: ${colors[Math.floor(Math.random() * colors.length)]};
                left: ${left}%;
                top: -20px;
                opacity: 1;
                border-radius: ${Math.random() > 0.5 ? '50%' : '2px'};
                transform: rotate(${Math.random() * 360}deg);
                animation: confettiFall ${duration}s ease-out ${delay}s forwards;
                box-shadow: 0 0 10px rgba(0,0,0,0.1);
            `;
            container.appendChild(confetti);
        }

        // Stile animazione confetti
        if (!document.getElementById('confetti-style')) {
            const style = document.createElement('style');
            style.id = 'confetti-style';
            style.textContent = `
                @keyframes confettiFall {
                    0% {
                        transform: translateY(0) rotate(0deg) scale(1);
                        opacity: 1;
                    }
                    100% {
                        transform: translateY(110vh) rotate(${Math.random() * 720 - 360}deg) scale(0.5);
                        opacity: 0;
                    }
                }
            `;
            document.head.appendChild(style);
        }

        setTimeout(() => container.remove(), 5000);
    }
};

// ===== MOBILE TOUCH GESTURES & OPTIMIZATIONS =====
const MobileGestures = {
    initialized: false,

    init() {
        if (this.initialized) {
            console.warn('MobileGestures already initialized');
            return;
        }
        this.setupSwipeToDelete();
        this.setupPullToRefresh();
        this.setupLongPressMenu();
        this.setupModalSwipeDown();
        this.setupKeyboardOptimization();
        this.setupHapticFeedback();
        this.initialized = true;
    },

    // Swipe-to-delete per trade cards
    setupSwipeToDelete() {
        let startX = 0, currentX = 0, isDragging = false, targetElement = null;

        document.addEventListener('touchstart', (e) => {
            const tradeCard = e.target.closest('[onclick*="showTradeDetail"]');
            if (tradeCard && window.innerWidth <= 768) {
                targetElement = tradeCard;
                startX = e.touches[0].clientX;
                isDragging = true;
                tradeCard.style.transition = 'none';
            }
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!isDragging || !targetElement) return;
            currentX = e.touches[0].clientX;
            const diff = currentX - startX;

            // Solo swipe da destra a sinistra
            if (diff < 0 && diff > -120) {
                targetElement.style.transform = `translateX(${diff}px)`;
                targetElement.style.opacity = 1 + (diff / 120) * 0.3;
            }
        }, { passive: true });

        document.addEventListener('touchend', () => {
            if (!isDragging || !targetElement) return;
            const diff = currentX - startX;

            targetElement.style.transition = 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)';

            if (diff < -80) {
                // Swipe sufficiente - mostra bottoni delete/edit
                targetElement.style.transform = 'translateX(-100px)';
                setTimeout(() => {
                    if (targetElement) {
                        targetElement.style.transform = 'translateX(0)';
                        targetElement.style.opacity = '1';
                    }
                }, 2000);
            } else {
                // Reset posizione
                targetElement.style.transform = 'translateX(0)';
                targetElement.style.opacity = '1';
            }

            isDragging = false;
            targetElement = null;
            startX = 0;
            currentX = 0;
        });
    },

    // Pull-to-refresh per journal e dashboard
    setupPullToRefresh() {
        let startY = 0, pullDistance = 0, isPulling = false;
        const mainContent = document.getElementById('main-content');

        if (!mainContent) return;

        mainContent.addEventListener('touchstart', (e) => {
            if (mainContent.scrollTop === 0 && window.innerWidth <= 768) {
                startY = e.touches[0].clientY;
                isPulling = true;
            }
        }, { passive: true });

        mainContent.addEventListener('touchmove', (e) => {
            if (!isPulling) return;
            pullDistance = e.touches[0].clientY - startY;

            if (pullDistance > 0 && pullDistance < 100) {
                e.preventDefault();
                mainContent.style.transform = `translateY(${pullDistance * 0.5}px)`;
            }
        }, { passive: false });

        mainContent.addEventListener('touchend', () => {
            if (!isPulling) return;

            mainContent.style.transition = 'transform 0.3s ease';
            mainContent.style.transform = 'translateY(0)';

            if (pullDistance > 60) {
                // Trigger refresh
                this.triggerHaptic('medium');
                setTimeout(() => {
                    if (router.currentPage === 'journal') router.journal();
                    if (router.currentPage === 'dashboard') router.dashboard();
                }, 300);
            }

            setTimeout(() => {
                mainContent.style.transition = '';
            }, 300);

            isPulling = false;
            pullDistance = 0;
        });
    },

    // Long-press menu per trade cards
    setupLongPressMenu() {
        let pressTimer = null;

        document.addEventListener('touchstart', (e) => {
            const tradeCard = e.target.closest('[onclick*="showTradeDetail"]');
            if (tradeCard && window.innerWidth <= 768) {
                pressTimer = setTimeout(() => {
                    this.triggerHaptic('heavy');
                    this.showContextMenu(tradeCard, e.touches[0].clientX, e.touches[0].clientY);
                }, 500);
            }
        }, { passive: true });

        document.addEventListener('touchend', () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        });

        document.addEventListener('touchmove', () => {
            if (pressTimer) {
                clearTimeout(pressTimer);
                pressTimer = null;
            }
        });
    },

    showContextMenu(element, x, y) {
        // Rimuovi menu precedenti
        const existingMenu = document.getElementById('context-menu');
        if (existingMenu) existingMenu.remove();

        // Estrai ID trade dal onclick
        const onclickAttr = element.getAttribute('onclick');
        const tradeId = onclickAttr.match(/showTradeDetail\((\d+)\)/)?.[1];
        if (!tradeId) return;

        const menu = document.createElement('div');
        menu.id = 'context-menu';
        menu.className = 'fixed z-[200] bg-[var(--bg-card)] border border-white/10 rounded-2xl shadow-2xl overflow-hidden';
        menu.style.left = `${Math.min(x, window.innerWidth - 200)}px`;
        menu.style.top = `${Math.min(y, window.innerHeight - 200)}px`;

        menu.innerHTML = `
            <div class="flex flex-col">
                <button onclick="ui.showTradeDetail(${tradeId}); document.getElementById('context-menu').remove();" 
                        class="px-6 py-4 text-left hover:bg-white/5 flex items-center gap-3 border-b border-white/5">
                    <i class="ph-bold ph-eye text-blue-500"></i>
                    <span class="font-bold">Visualizza</span>
                </button>
                <button onclick="ui.openEditTradeModal(${tradeId}); document.getElementById('context-menu').remove();" 
                        class="px-6 py-4 text-left hover:bg-white/5 flex items-center gap-3 border-b border-white/5">
                    <i class="ph-bold ph-pencil-simple text-yellow-500"></i>
                    <span class="font-bold">Modifica</span>
                </button>
                <button onclick="if(confirm('Eliminare questo trade?')) { DataStore.deleteTrade(${tradeId}); router.journal(); } document.getElementById('context-menu').remove();" 
                        class="px-6 py-4 text-left hover:bg-white/5 flex items-center gap-3">
                    <i class="ph-bold ph-trash text-red-500"></i>
                    <span class="font-bold text-red-500">Elimina</span>
                </button>
            </div>
        `;

        document.body.appendChild(menu);

        // Chiudi menu quando tocchi fuori
        setTimeout(() => {
            const closeMenu = (e) => {
                if (!menu.contains(e.target)) {
                    menu.remove();
                    document.removeEventListener('touchstart', closeMenu);
                }
            };
            document.addEventListener('touchstart', closeMenu);
        }, 100);
    },

    // Swipe-down per chiudere modal su mobile
    setupModalSwipeDown() {
        let startY = 0, currentY = 0, isDragging = false;

        document.addEventListener('touchstart', (e) => {
            const modal = e.target.closest('#modal-overlay');
            const isModalHeader = e.target.closest('#modal-account > div:first-child, #modal-trade > div:first-child');

            if (modal && isModalHeader && window.innerWidth <= 768) {
                const modalContent = document.querySelector('#modal-account, #modal-trade');
                if (modalContent && modalContent.scrollTop === 0) {
                    startY = e.touches[0].clientY;
                    isDragging = true;
                }
            }
        }, { passive: true });

        document.addEventListener('touchmove', (e) => {
            if (!isDragging) return;
            currentY = e.touches[0].clientY;
            const diff = currentY - startY;

            const modalContent = document.querySelector('#modal-account, #modal-trade');
            if (diff > 0 && diff < 200 && modalContent) {
                modalContent.style.transform = `translateY(${diff}px)`;
                modalContent.style.transition = 'none';
                const overlay = document.getElementById('modal-overlay');
                if (overlay) {
                    overlay.style.opacity = 1 - (diff / 200) * 0.5;
                }
            }
        }, { passive: true });

        document.addEventListener('touchend', () => {
            if (!isDragging) return;
            const diff = currentY - startY;
            const modalContent = document.querySelector('#modal-account, #modal-trade');
            const overlay = document.getElementById('modal-overlay');

            if (modalContent) {
                modalContent.style.transition = 'transform 0.3s ease';

                if (diff > 100) {
                    // Chiudi modal
                    modalContent.style.transform = 'translateY(100vh)';
                    setTimeout(() => ui.closeModals(), 200);
                } else {
                    // Reset posizione
                    modalContent.style.transform = 'translateY(0)';
                    if (overlay) overlay.style.opacity = '1';
                }
            }

            isDragging = false;
            startY = 0;
            currentY = 0;
        });
    },

    // Ottimizzazione tastiera virtuale
    setupKeyboardOptimization() {
        if (window.visualViewport) {
            let lastHeight = window.visualViewport.height;

            window.visualViewport.addEventListener('resize', () => {
                const currentHeight = window.visualViewport.height;
                const diff = lastHeight - currentHeight;

                // Tastiera aperta
                if (diff > 100) {
                    document.body.style.paddingBottom = `${diff}px`;

                    // Scroll al campo in focus
                    setTimeout(() => {
                        const activeEl = document.activeElement;
                        if (activeEl && (activeEl.tagName === 'INPUT' || activeEl.tagName === 'TEXTAREA')) {
                            activeEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        }
                    }, 100);
                } else {
                    // Tastiera chiusa
                    document.body.style.paddingBottom = '0px';
                }

                lastHeight = currentHeight;
            });
        }
    },

    // Haptic feedback per azioni importanti
    triggerHaptic(type = 'light') {
        if ('vibrate' in navigator && window.innerWidth <= 768) {
            const patterns = {
                light: 10,
                medium: 20,
                heavy: [30, 10, 30]
            };
            navigator.vibrate(patterns[type] || patterns.light);
        }
    },

    setupHapticFeedback() {
        // Haptic su bottoni importanti
        document.addEventListener('click', (e) => {
            const button = e.target.closest('button');
            if (button && window.innerWidth <= 768) {
                const isDelete = button.querySelector('.ph-trash') || button.classList.contains('text-red-500');
                const isSuccess = button.classList.contains('bg-green-500') || button.textContent.includes('Salva');

                if (isDelete) {
                    this.triggerHaptic('heavy');
                } else if (isSuccess) {
                    this.triggerHaptic('medium');
                } else {
                    this.triggerHaptic('light');
                }
            }
        }, { passive: true });
    }
};
