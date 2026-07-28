/**
 * Modulo per la sincronizzazione cloud tramite Firebase Realtime Database.
 * Utilizza un sistema senza account, basato su un codice dispositivo di 6 caratteri.
 * Assicura la sincronizzazione tra dispositivi unendo i dati con logica di merge.
 */

const CloudSync = {
  // Configurazione Firebase
  firebaseConfig: {
    apiKey: "AIzaSyDNuciMptY6RN6D_I5qKWsuOVqFX6hKwos",
    authDomain: "eazytrader.firebaseapp.com",
    databaseURL: "https://eazytrader-default-rtdb.europe-west1.firebasedatabase.app",
    projectId: "eazytrader",
    storageBucket: "eazytrader.firebasestorage.app",
    messagingSenderId: "783963281149",
    appId: "1:783963281149:web:c503b2967b28ac07d59094"
  },

  // Stato interno
  db: null,
  status: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'syncing' | 'error'
  lastSyncTime: null,
  onStatusChange: null,
  error: null,
  
  _isSyncing: false,
  _ignoreNextUpdate: false,
  _pushTimer: null,
  _listenerRef: null,

  /**
   * Inizializza il modulo CloudSync
   * @returns {Promise<boolean>}
   */
  async init() {
    try {
      // Inizializza Firebase usando la compat API
      if (!firebase.apps.length) {
        firebase.initializeApp(this.firebaseConfig);
      }
      this.db = firebase.database();
      
      // Assicura che esista un device ID locale
      if (!localStorage.getItem('eazytrader_device_id')) {
        localStorage.setItem('eazytrader_device_id', this._generateId());
      }

      const savedCode = this.getCode();
      if (savedCode) {
        await this.connect(savedCode);
        return true;
      }
      
      this._setStatus('disconnected');
      return false;
    } catch (error) {
      console.error("Errore inizializzazione CloudSync:", error);
      this.error = error.message;
      this._setStatus('error');
      return false;
    }
  },

  /**
   * Genera un codice casuale di 6 caratteri, escludendo caratteri ambigui
   * @returns {string}
   */
  generateCode() {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // Esclusi O, 0, I, 1, L
    let result = '';
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  },

  /**
   * Recupera il codice salvato
   * @returns {string|null}
   */
  getCode() {
    return localStorage.getItem('eazytrader_sync_code');
  },

  /**
   * Salva il codice dispositivo
   * @param {string} code 
   */
  saveCode(code) {
    localStorage.setItem('eazytrader_sync_code', code);
  },

  /**
   * Rimuove il codice dispositivo e si disconnette
   */
  removeCode() {
    this.disconnect();
    localStorage.removeItem('eazytrader_sync_code');
  },

  /**
   * Connette a un codice di sincronizzazione
   * @param {string} code 
   */
  async connect(code) {
    if (!this.db) {
      this.error = "Database non inizializzato";
      this._setStatus('error');
      return;
    }

    this._setStatus('connecting');
    try {
      this.saveCode(code);
      // Esegui un pull iniziale dei dati
      await this.pull();
      this.startListener();
      this._setStatus('connected');
    } catch (error) {
      console.error("Errore connessione CloudSync:", error);
      this.error = error.message;
      this._setStatus('error');
    }
  },

  /**
   * Disconnette dal listener corrente
   */
  disconnect() {
    this.stopListener();
    this._setStatus('disconnected');
    this.lastSyncTime = null;
    this.error = null;
  },

  /**
   * Avvia l'ascolto per le modifiche remote
   */
  startListener() {
    const code = this.getCode();
    if (!code || !this.db) return;

    this.stopListener(); // Ferma eventuali listener precedenti
    
    this._listenerRef = this.db.ref(`/sync/${code}`);
    this._listenerRef.on('value', async (snapshot) => {
      const data = snapshot.val();
      
      if (!data) return;

      const deviceId = localStorage.getItem('eazytrader_device_id');
      
      // Se l'aggiornamento proviene dallo stesso dispositivo, ignoralo a meno che
      // non sia stato specificato di ignorare questo aggiornamento
      if (data.deviceId === deviceId) {
        if (this._ignoreNextUpdate) {
          this._ignoreNextUpdate = false;
        }
        return;
      }

      // Evita re-entrancy o chiamate multiple sovrapposte
      if (this._isSyncing) return;

      this._setStatus('syncing');
      try {
        await this._handleRemoteChange(data);
        this.lastSyncTime = Date.now();
        this._setStatus('connected');
      } catch (error) {
        console.error("Errore gestione update remoto:", error);
        this.error = error.message;
        this._setStatus('error');
      }
    }, (error) => {
      console.error("Errore ascolto Firebase:", error);
      this.error = error.message;
      this._setStatus('error');
    });
  },

  /**
   * Ferma l'ascolto per le modifiche remote
   */
  stopListener() {
    if (this._listenerRef) {
      this._listenerRef.off();
      this._listenerRef = null;
    }
  },

  /**
   * Invia i dati locali a Firebase con debounce
   */
  debouncedPush() {
    if (this._pushTimer) {
      clearTimeout(this._pushTimer);
    }
    
    // Mostra feedback visivo di sync in corso, ma posticipa il caricamento effettivo
    if (this.status === 'connected') {
      this._setStatus('syncing');
    }
    
    this._pushTimer = setTimeout(() => {
      this.push().catch(e => console.error("Errore in debouncedPush:", e));
    }, 2000);
  },

  /**
   * Invia i dati locali attuali a Firebase
   */
  async push() {
    const code = this.getCode();
    if (!code || !this.db || !DataStore || !DataStore.data) return;

    this._setStatus('syncing');
    
    try {
      const deviceId = localStorage.getItem('eazytrader_device_id');
      
      // Raccogliamo i dati e li comprimiamo
      const dataString = JSON.stringify(DataStore.data);
      const compressedData = window.LZString 
        ? LZString.compressToBase64(dataString) 
        : btoa(unescape(encodeURIComponent(dataString))); // fallback se LZString non è disponibile
        
      // Otteniamo la lista degli ID eliminati (se esiste nel localStorage)
      let deletedIds = {};
      try {
        const deletedStr = localStorage.getItem('eazytrader_deleted_ids');
        if (deletedStr) deletedIds = JSON.parse(deletedStr);
      } catch (e) { /* fallback silenzioso */ }

      // Prepariamo l'oggetto per Firebase
      const payload = {
        data: compressedData,
        lastUpdated: firebase.database.ServerValue.TIMESTAMP,
        deviceId: deviceId,
        deleted: deletedIds
      };

      this._ignoreNextUpdate = true; // Ignora il prossimo evento dal listener
      
      await this.db.ref(`/sync/${code}`).set(payload);
      
      this.lastSyncTime = Date.now();
      this._setStatus('connected');
    } catch (error) {
      console.error("Errore push dati:", error);
      this.error = error.message;
      this._setStatus('error');
      throw error;
    }
  },

  /**
   * Scarica i dati da Firebase ed esegue il merge
   */
  async pull() {
    const code = this.getCode();
    if (!code || !this.db) return;

    this._setStatus('syncing');
    
    try {
      const snapshot = await this.db.ref(`/sync/${code}`).once('value');
      const remoteDataWrapper = snapshot.val();
      
      if (remoteDataWrapper) {
        await this._handleRemoteChange(remoteDataWrapper);
      }
      
      this.lastSyncTime = Date.now();
      this._setStatus('connected');
    } catch (error) {
      console.error("Errore pull dati:", error);
      this.error = error.message;
      this._setStatus('error');
      throw error;
    }
  },

  /**
   * Gestisce l'arrivo di nuovi dati remoti
   * @param {Object} remoteDataWrapper L'oggetto remoto (contenente data compressa e metadati)
   */
  async _handleRemoteChange(remoteDataWrapper) {
    if (this._isSyncing) return;
    this._isSyncing = true;
    
    try {
      if (!remoteDataWrapper.data) {
        this._isSyncing = false;
        return;
      }

      // Decompressione dati
      let remoteDataStr;
      try {
        if (window.LZString) {
          remoteDataStr = LZString.decompressFromBase64(remoteDataWrapper.data);
        } else {
          remoteDataStr = decodeURIComponent(escape(atob(remoteDataWrapper.data)));
        }
      } catch (e) {
        console.error("Errore decompressione dati:", e);
        this._isSyncing = false;
        return;
      }

      const remoteData = JSON.parse(remoteDataStr);
      const remoteDeleted = remoteDataWrapper.deleted || {};
      
      // Update locale degli ID eliminati unendoli con i remoti
      this._mergeDeletedIds(remoteDeleted);

      // Eseguiamo il merge tra dati locali e remoti
      const mergedData = this._mergeData(remoteData, DataStore.data, remoteDeleted);
      
      // Aggiorniamo il DataStore
      DataStore.data = mergedData;
      await DataStore.saveToIndexedDB(); // Usa direttamente questo per non triggerare push() in loop

      // Emettiamo un evento per la UI senza forzare la navigazione router con transizione
      window.dispatchEvent(new CustomEvent('cloudsync:updated', { detail: { dataChanged: true } }));
      
    } catch (error) {
      console.error("Errore elaborazione dati remoti:", error);
    } finally {
      this._isSyncing = false;
    }
  },

  /**
   * Unisce dati locali e remoti
   * @param {Object} remoteData 
   * @param {Object} localData 
   * @param {Object} deletedIds
   * @returns {Object} Dati fusi
   */
  _mergeData(remoteData, localData, deletedIds) {
    if (!localData) return Object.assign({}, remoteData);
    if (!remoteData) return Object.assign({}, localData);

    const result = {};
    const arrayKeys = ['trades', 'accounts', 'reviews', 'todos', 'weeklyGoals', 'playbook'];
    
    // Per ogni chiave gestiamo in base al tipo
    const allKeys = new Set([...Object.keys(remoteData), ...Object.keys(localData)]);
    
    for (const key of allKeys) {
      if (arrayKeys.includes(key)) {
        // Logica merge per array
        result[key] = this._mergeArrays(remoteData[key] || [], localData[key] || [], deletedIds[key] || []);
      } else if (typeof remoteData[key] === 'object' && remoteData[key] !== null) {
        // Logica merge deep object (settings, profile)
        result[key] = this._deepMergeObjects(remoteData[key], localData[key] || {});
      } else {
        // Valori primitivi, vince il remoto se esiste
        result[key] = remoteData[key] !== undefined ? remoteData[key] : localData[key];
      }
    }
    
    return result;
  },

  /**
   * Unisce array in base a id e lastModified
   * @param {Array} remoteArr 
   * @param {Array} localArr 
   * @param {Array} deletedArray
   */
  _mergeArrays(remoteArr, localArr, deletedArray) {
    const itemMap = new Map();

    // Inserisce elementi locali
    localArr.forEach(item => {
      if (item && item.id && !deletedArray.includes(item.id)) {
        itemMap.set(item.id, item);
      }
    });

    // Inserisce o sovrascrive con elementi remoti se più recenti
    remoteArr.forEach(item => {
      if (item && item.id && !deletedArray.includes(item.id)) {
        const localItem = itemMap.get(item.id);
        
        if (!localItem) {
          // Elemento nuovo remoto
          itemMap.set(item.id, item);
        } else {
          // Elemento esistente: confronta i timestamp
          const remoteTime = item.lastModified || item.date || 0;
          const localTime = localItem.lastModified || localItem.date || 0;
          
          if (remoteTime > localTime) {
            itemMap.set(item.id, item);
          }
        }
      }
    });

    return Array.from(itemMap.values());
  },

  /**
   * Esegue una deep merge di due oggetti (non per array)
   * @param {Object} remoteObj 
   * @param {Object} localObj 
   */
  _deepMergeObjects(remoteObj, localObj) {
    const result = Object.assign({}, localObj);
    
    for (const key in remoteObj) {
      if (remoteObj.hasOwnProperty(key)) {
        if (typeof remoteObj[key] === 'object' && remoteObj[key] !== null && !Array.isArray(remoteObj[key])) {
          result[key] = this._deepMergeObjects(remoteObj[key], localObj[key] || {});
        } else {
          result[key] = remoteObj[key];
        }
      }
    }
    
    return result;
  },

  /**
   * Tiene traccia di un ID eliminato e triggera la sincronizzazione
   * Questa funzione va chiamata dal DataStore quando un elemento viene cancellato
   * @param {string} type Tipo di array ('trades', 'accounts', ecc.)
   * @param {string} id ID cancellato
   */
  trackDeletedItem(type, id) {
    try {
      let deletedIds = {};
      const deletedStr = localStorage.getItem('eazytrader_deleted_ids');
      if (deletedStr) deletedIds = JSON.parse(deletedStr);
      
      if (!deletedIds[type]) deletedIds[type] = [];
      if (!deletedIds[type].includes(id)) {
        deletedIds[type].push(id);
        localStorage.setItem('eazytrader_deleted_ids', JSON.stringify(deletedIds));
      }
      
      // Innesca il push per notificare l'eliminazione
      this.debouncedPush();
    } catch (e) {
      console.error("Errore tracking item eliminato:", e);
    }
  },

  /**
   * Fonde gli ID cancellati remoti con quelli locali
   * @param {Object} remoteDeleted 
   */
  _mergeDeletedIds(remoteDeleted) {
    try {
      let localDeleted = {};
      const deletedStr = localStorage.getItem('eazytrader_deleted_ids');
      if (deletedStr) localDeleted = JSON.parse(deletedStr);
      
      let changed = false;
      
      for (const key in remoteDeleted) {
        if (!localDeleted[key]) {
          localDeleted[key] = remoteDeleted[key];
          changed = true;
        } else {
          const originalLength = localDeleted[key].length;
          const merged = [...new Set([...localDeleted[key], ...remoteDeleted[key]])];
          if (merged.length > originalLength) {
            localDeleted[key] = merged;
            changed = true;
          }
        }
      }
      
      if (changed) {
        localStorage.setItem('eazytrader_deleted_ids', JSON.stringify(localDeleted));
      }
    } catch (e) {
      console.error("Errore merge deleted IDs:", e);
    }
  },

  /**
   * Aggiorna lo stato e chiama l'eventuale callback
   * @param {string} newStatus 
   */
  _setStatus(newStatus) {
    if (this.status !== newStatus) {
      this.status = newStatus;
      if (typeof this.onStatusChange === 'function') {
        this.onStatusChange(newStatus);
      }
      // Emette anche un evento generale
      window.dispatchEvent(new CustomEvent('cloudsync:status', { detail: { status: newStatus } }));
    }
  },

  /**
   * Genera un ID univoco
   * @returns {string}
   */
  _generateId() {
    return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
  },

  /**
   * Restituisce le informazioni di stato per la UI
   * @returns {Object}
   */
  getSyncInfo() {
    return {
      connected: !!this.getCode() && this.status === 'connected',
      code: this.getCode(),
      lastSync: this.lastSyncTime,
      status: this.status,
      deviceId: localStorage.getItem('eazytrader_device_id')
    };
  }
};
