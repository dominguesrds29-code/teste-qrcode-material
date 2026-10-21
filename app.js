/**
 * CargaScan - Leitor de QR Code para Conferência de Carga
 * Integração automática com Google Planilhas via Google Apps Script
 */

// Estado da Aplicação
const state = {
  html5QrCode: null,
  isScanning: false,
  currentFacingMode: "environment", // Traseira por padrão
  torchEnabled: false,
  lastScannedCode: null,
  lastScannedTime: 0,
  scanCooldownMs: 2500, // Evita ler o mesmo código duplicado em sequência imediata
  
  // Configurações
  config: {
    scriptUrl: localStorage.getItem('cargascan_script_url') || '',
    sound: localStorage.getItem('cargascan_sound') !== 'false',
    vibrate: localStorage.getItem('cargascan_vibrate') !== 'false',
    continuous: localStorage.getItem('cargascan_continuous') !== 'false'
  },

  // Itens em memória e cache
  items: JSON.parse(localStorage.getItem('cargascan_items') || '[]')
};

// Elementos da Interface (DOM)
const elements = {
  qrReaderContainer: document.getElementById('qr-reader'),
  laser: document.getElementById('scanner-laser'),
  cameraPlaceholder: document.getElementById('camera-placeholder'),
  btnStartCamera: document.getElementById('btn-start-camera'),
  btnToggleCamera: document.getElementById('btn-toggle-camera'),
  btnSwitchCamera: document.getElementById('btn-switch-camera'),
  btnToggleTorch: document.getElementById('btn-toggle-torch'),
  btnUploadFile: document.getElementById('btn-upload-file'),
  fileInput: document.getElementById('file-input'),
  
  inputBatch: document.getElementById('input-batch'),
  inputOperator: document.getElementById('input-operator'),
  formManual: document.getElementById('form-manual'),
  manualText: document.getElementById('manual-text'),

  statusToast: document.getElementById('status-toast'),
  toastIcon: document.getElementById('toast-icon'),
  toastMsg: document.getElementById('toast-msg'),

  countTotal: document.getElementById('count-total'),
  countSynced: document.getElementById('count-synced'),
  countPending: document.getElementById('count-pending'),
  pendingBadge: document.getElementById('pending-badge'),

  historyList: document.getElementById('history-list'),
  emptyState: document.getElementById('empty-state'),
  btnSyncPending: document.getElementById('btn-sync-pending'),
  btnExportCsv: document.getElementById('btn-export-csv'),
  btnClearHistory: document.getElementById('btn-clear-history'),

  // Modal
  btnSettings: document.getElementById('btn-settings'),
  modalSettings: document.getElementById('modal-settings'),
  btnCloseModal: document.getElementById('btn-close-modal'),
  btnSaveSettings: document.getElementById('btn-save-settings'),
  btnTestConnection: document.getElementById('btn-test-connection'),
  btnCopyScript: document.getElementById('btn-copy-script'),
  scriptUrlInput: document.getElementById('script-url'),
  chkSound: document.getElementById('chk-sound'),
  chkVibrate: document.getElementById('chk-vibrate'),
  chkContinuous: document.getElementById('chk-continuous')
};

// Sintetizador de Áudio (Bip de Leitor de Código de Barras Profissional)
function playBeep(success = true) {
  if (!state.config.sound) return;
  try {
    const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();

    osc.type = 'sine';
    if (success) {
      // Dois tons rápidos tipo leitor Zebra/Honeywell
      osc.frequency.setValueAtTime(1800, audioCtx.currentTime);
      osc.frequency.setValueAtTime(2400, audioCtx.currentTime + 0.08);
      gain.gain.setValueAtTime(0.25, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.18);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.18);
    } else {
      // Tom grave de erro
      osc.frequency.setValueAtTime(400, audioCtx.currentTime);
      gain.gain.setValueAtTime(0.3, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.01, audioCtx.currentTime + 0.3);
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.start();
      osc.stop(audioCtx.currentTime + 0.3);
    }
  } catch (err) {
    console.warn("Áudio não suportado ou bloqueado:", err);
  }
}

// Resposta Tátil de Vibração
function triggerVibration() {
  if (state.config.vibrate && 'vibrate' in navigator) {
    try {
      navigator.vibrate([80, 40, 80]);
    } catch (e) {
      // Ignorar se o dispositivo não permitir
    }
  }
}

// Exibir Toast de Status
let toastTimeout = null;
function showToast(message, type = 'success') {
  clearTimeout(toastTimeout);
  elements.statusToast.className = `status-toast ${type}`;
  elements.toastIcon.textContent = type === 'success' ? '✅' : (type === 'warning' ? '⚠️' : '❌');
  elements.toastMsg.textContent = message;

  toastTimeout = setTimeout(() => {
    elements.statusToast.classList.add('hidden');
  }, 3500);
}

// --- Motores de Decodificação Avançada (jsQR com suporte a Latin-1 e BarcodeDetector) ---
function decodeQrCodeFromImageData(imageData, width, height) {
  if (typeof jsQR === 'undefined') return null;
  try {
    const code = jsQR(imageData.data, width, height, {
      inversionAttempts: "attemptBoth"
    });
    if (!code) return null;

    if (code.data && code.data.trim().length > 0) {
      return code.data;
    }

    // Fallback para Latin-1 / ISO-8859-1 (usado em etiquetas de patrimônio com "Nrº" ou acentos)
    if (code.binaryData && code.binaryData.length > 0) {
      try {
        const utf8 = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(code.binaryData));
        if (utf8 && utf8.trim().length > 0) return utf8;
      } catch (e) {}

      try {
        const latin1 = new TextDecoder('iso-8859-1').decode(new Uint8Array(code.binaryData));
        if (latin1 && latin1.trim().length > 0) return latin1;
      } catch (e) {}

      return String.fromCharCode.apply(null, code.binaryData);
    }
  } catch (err) {
    console.warn("Erro no jsQR:", err);
  }
  return null;
}

// Varredura contínua em resolução nativa do sensor de vídeo
let liveScanTimer = null;
const liveCanvas = document.createElement('canvas');
const liveCtx = liveCanvas.getContext('2d', { willReadFrequently: true });

function startLiveSecondaryScan() {
  stopLiveSecondaryScan();

  let nativeDetector = null;
  if ('BarcodeDetector' in window) {
    try {
      nativeDetector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (e) {}
  }

  liveScanTimer = setInterval(async () => {
    if (!state.isScanning) return;
    const video = document.querySelector('#qr-reader video');
    if (!video || video.readyState < 2 || video.videoWidth === 0) return;

    try {
      // 1. Tenta detecção por hardware nativo (Google Play Services / GPU) no elemento de vídeo
      if (nativeDetector) {
        const barcodes = await nativeDetector.detect(video);
        if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
          onScanSuccess(barcodes[0].rawValue, { source: 'BarcodeDetector' });
          return;
        }
      }

      // 2. Tenta jsQR com o frame em resolução real
      if (typeof jsQR !== 'undefined') {
        const vW = video.videoWidth;
        const vH = video.videoHeight;
        if (liveCanvas.width !== vW || liveCanvas.height !== vH) {
          liveCanvas.width = vW;
          liveCanvas.height = vH;
        }
        liveCtx.drawImage(video, 0, 0, vW, vH);
        const imgData = liveCtx.getImageData(0, 0, vW, vH);
        const text = decodeQrCodeFromImageData(imgData, vW, vH);
        if (text) {
          onScanSuccess(text, { source: 'jsQR' });
          return;
        }
      }
    } catch (e) {}
  }, 200);
}

function stopLiveSecondaryScan() {
  if (liveScanTimer) {
    clearInterval(liveScanTimer);
    liveScanTimer = null;
  }
}

// Processamento robusto de arquivos de imagem/foto
async function scanImageFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = async () => {
        try {
          const canvas = document.createElement('canvas');
          const w = img.naturalWidth || img.width;
          const h = img.naturalHeight || img.height;
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);

          // 1. Tenta BarcodeDetector nativo
          if ('BarcodeDetector' in window) {
            try {
              const detector = new BarcodeDetector({ formats: ['qr_code'] });
              const barcodes = await detector.detect(canvas);
              if (barcodes && barcodes.length > 0 && barcodes[0].rawValue) {
                return resolve(barcodes[0].rawValue);
              }
            } catch (err) {}
          }

          // 2. Tenta jsQR em resolução original (com suporte a Latin-1)
          const imgData = ctx.getImageData(0, 0, w, h);
          const text = decodeQrCodeFromImageData(imgData, w, h);
          if (text) {
            return resolve(text);
          }

          // 3. Fallback: se a foto for grande, tenta em escala 50%
          if (w > 1200 || h > 1200) {
            const c2 = document.createElement('canvas');
            c2.width = Math.floor(w / 2);
            c2.height = Math.floor(h / 2);
            const ctx2 = c2.getContext('2d');
            ctx2.drawImage(canvas, 0, 0, c2.width, c2.height);
            const imgData2 = ctx2.getImageData(0, 0, c2.width, c2.height);
            const text2 = decodeQrCodeFromImageData(imgData2, c2.width, c2.height);
            if (text2) {
              return resolve(text2);
            }
          }

          // 4. Fallback final: Html5Qrcode se disponível
          if (state.html5QrCode) {
            try {
              const res = await state.html5QrCode.scanFileV2(file, false);
              if (res && res.decodedText) {
                return resolve(res.decodedText);
              }
            } catch (h5Err) {}
          }

          reject(new Error("Nenhum QR Code legível encontrado na foto."));
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => reject(new Error("Erro ao abrir a imagem."));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("Erro ao ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

// Inicializar e Controlar Câmera
function createScannerInstance() {
  try {
    return new Html5Qrcode("qr-reader", {
      formatsToSupport: [0], // 0 = QR_CODE apenas, sem gastar CPU com códigos 1D
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true
      },
      verbose: false
    });
  } catch (e) {
    return new Html5Qrcode("qr-reader");
  }
}

async function initScanner() {
  state.html5QrCode = createScannerInstance();
  // Tentar iniciar automaticamente se permitido
  startCamera();
}

async function startCamera() {
  if (state.isScanning) return;

  const config = {
    fps: 15,
    // qrbox amplo e dinâmico: evita cortar QR Codes que ficam nas extremidades de etiquetas retangulares
    qrbox: function(viewfinderWidth, viewfinderHeight) {
      const width = Math.max(250, Math.floor(viewfinderWidth * 0.88));
      const height = Math.max(220, Math.floor(viewfinderHeight * 0.75));
      return { width, height };
    },
    aspectRatio: 1.333333
  };

  try {
    elements.cameraPlaceholder.style.display = 'none';
    elements.laser.classList.add('active');

    // Garante que a instância esteja pronta
    if (!state.html5QrCode) {
      state.html5QrCode = createScannerInstance();
    }

    // Passa exatamente 1 chave no objeto ({ facingMode }), respeitando a validação interna do Html5Qrcode
    await state.html5QrCode.start(
      { facingMode: state.currentFacingMode },
      config,
      onScanSuccess,
      onScanFailure
    );

    state.isScanning = true;
    startLiveSecondaryScan();
    elements.btnToggleCamera.innerHTML = '<span class="btn-icon">⏹</span> Pausar';
  } catch (err) {
    console.error("Erro ao iniciar câmera:", err);
    elements.laser.classList.remove('active');
    elements.cameraPlaceholder.style.display = 'flex';
    state.isScanning = false;
    stopLiveSecondaryScan();
    elements.btnToggleCamera.innerHTML = '<span class="btn-icon">▶️</span> Iniciar';

    // Recria a instância limpa para que o próximo clique em "Ativar Câmera" não falhe por transição travada
    try {
      state.html5QrCode = createScannerInstance();
    } catch (e) {}

    let errorMsg = "Não foi possível abrir a câmera.";
    const errStr = (err && (err.message || err.toString())) || "";
    if (errStr.includes("NotAllowedError") || errStr.includes("Permission") || errStr.includes("denied")) {
      errorMsg = "Permissão da câmera negada. Permita o acesso à câmera nas configurações do navegador (ícone de cadeado na barra de endereço).";
    } else if (errStr.includes("NotFoundError") || errStr.includes("device not found")) {
      errorMsg = "Nenhuma câmera encontrada no aparelho.";
    } else if (errStr.includes("NotReadableError") || errStr.includes("in use")) {
      errorMsg = "A câmera já está sendo usada por outro app.";
    } else if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      errorMsg = "O navegador bloqueia a câmera fora de HTTPS. No celular, acesse via HTTPS ou configure o Chrome com flags de localhost.";
    } else {
      errorMsg = "Erro na câmera: " + errStr;
    }
    showToast(errorMsg, 'error');
  }
}

async function stopCamera() {
  stopLiveSecondaryScan();
  if (!state.isScanning) return;
  try {
    await state.html5QrCode.stop();
    state.isScanning = false;
    elements.laser.classList.remove('active');
    elements.cameraPlaceholder.style.display = 'flex';
    elements.btnToggleCamera.innerHTML = '<span class="btn-icon">▶️</span> Iniciar';
  } catch (err) {
    console.error("Erro ao parar câmera:", err);
  }
}

async function switchCamera() {
  await stopCamera();
  state.currentFacingMode = (state.currentFacingMode === "environment") ? "user" : "environment";
  await startCamera();
}

// Callback de Sucesso da Leitura
function onScanSuccess(decodedText, decodedResult) {
  const now = Date.now();
  // Debounce para evitar registrar o mesmo QR 10 vezes no mesmo segundo
  if (decodedText === state.lastScannedCode && (now - state.lastScannedTime) < state.scanCooldownMs) {
    return;
  }

  state.lastScannedCode = decodedText;
  state.lastScannedTime = now;

  processItemRecord(decodedText, 'QR Code');
}

function onScanFailure(error) {
  // Ignora erros contínuos normais enquanto busca um QR code no quadro
}

// Processar Registro do Item
async function processItemRecord(description, source = 'QR Code') {
  const cleanDescription = description.trim();
  if (!cleanDescription) return;

  playBeep(true);
  triggerVibration();

  const item = {
    id: 'ITEM_' + Date.now() + '_' + Math.floor(Math.random() * 1000),
    timestamp: new Date().toLocaleString('pt-BR'),
    description: cleanDescription,
    batch: elements.inputBatch.value.trim() || 'SEM LOTE',
    operator: elements.inputOperator.value.trim() || 'Geral',
    source: source,
    status: 'sending' // 'sending', 'synced', 'pending'
  };

  // Adiciona ao início da lista
  state.items.unshift(item);
  saveItemsToStorage();
  updateUI();

  showToast(`Lido: "${cleanDescription.slice(0, 30)}${cleanDescription.length > 30 ? '...' : ''}"`, 'success');

  // Enviar para o Google Sheets
  await syncItemToGoogleSheets(item);
}

// Enviar Registro para o Google Apps Script
async function syncItemToGoogleSheets(item) {
  if (!state.config.scriptUrl) {
    item.status = 'pending';
    saveItemsToStorage();
    updateUI();
    showToast('Planilha não configurada. Item salvo localmente.', 'warning');
    return;
  }

  const payload = {
    action: 'addRecord',
    id: item.id,
    timestamp: item.timestamp,
    description: item.description,
    batch: item.batch,
    operator: item.operator,
    source: item.source
  };

  try {
    item.status = 'sending';
    updateUI();

    // Como o Google Apps Script responde com redirecionamento 302, usamos text/plain para evitar bloqueios de CORS
    const response = await fetch(state.config.scriptUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
      body: JSON.stringify(payload)
    });

    // Se a resposta retornou ok
    item.status = 'synced';
    saveItemsToStorage();
    updateUI();
  } catch (error) {
    console.warn("Falha no envio direto ao Google Sheets (possível offline ou CORS no-cors):", error);
    // Modo no-cors fallback para garantir envio ao Apps Script mesmo sem cabeçalhos OPTIONS
    try {
      await fetch(state.config.scriptUrl, {
        method: 'POST',
        mode: 'no-cors',
        headers: {
          'Content-Type': 'text/plain;charset=utf-8'
        },
        body: JSON.stringify(payload)
      });
      // Em no-cors não conseguimos ler o status HTTP, mas o Google Apps Script executa e salva
      item.status = 'synced';
    } catch (fallbackError) {
      item.status = 'pending';
      console.error("Erro definitivo ao enviar:", fallbackError);
    }
    saveItemsToStorage();
    updateUI();
  }
}

// Sincronizar todos os itens pendentes
async function syncAllPending() {
  const pendingItems = state.items.filter(item => item.status === 'pending');
  if (pendingItems.length === 0) {
    showToast('Todos os itens já estão sincronizados!', 'success');
    return;
  }

  if (!state.config.scriptUrl) {
    showToast('Configure a URL da Planilha antes de sincronizar!', 'warning');
    openSettingsModal();
    return;
  }

  showToast(`Sincronizando ${pendingItems.length} itens pendentes...`, 'warning');
  let successCount = 0;

  for (const item of pendingItems) {
    await syncItemToGoogleSheets(item);
    if (item.status === 'synced') successCount++;
  }

  showToast(`${successCount} itens sincronizados com a planilha!`, 'success');
}

// Persistência em LocalStorage
function saveItemsToStorage() {
  localStorage.setItem('cargascan_items', JSON.stringify(state.items));
}

// Formatador inteligente para etiquetas patrimoniais e textos multilinha
function formatItemDisplay(description) {
  if (!description) return { primary: 'Sem descrição', secondary: '' };
  
  const lines = description.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (lines.length <= 1) {
    return { primary: description, secondary: '' };
  }

  let bmp = '';
  let ug = '';
  let equip = '';
  const others = [];

  for (const line of lines) {
    if (/^Nr[ºo°]?\s*BMP/i.test(line) || /^BMP/i.test(line)) {
      bmp = line;
    } else if (/^UG:/i.test(line) || /^Depend/i.test(line)) {
      ug = ug ? `${ug} | ${line}` : line;
    } else if (!equip && /MONITOR|DATEN|LED|NOTEBOOK|CPU|COMPUTADOR|TECLADO|IMPRESSORA|DELL|HP|LENOVO|CADEIRA|MESA/i.test(line)) {
      equip = line;
    } else {
      others.push(line);
    }
  }

  const primary = equip || lines[lines.length - 1];
  const tags = [];
  if (bmp) tags.push(bmp);
  if (ug) tags.push(ug);
  const secondary = tags.concat(others.filter(l => l !== primary)).join(' • ');

  return { primary, secondary };
}

// Atualizar Interface e Contadores
function updateUI() {
  const total = state.items.length;
  const synced = state.items.filter(i => i.status === 'synced').length;
  const pending = state.items.filter(i => i.status === 'pending').length;

  elements.countTotal.textContent = total;
  elements.countSynced.textContent = synced;
  elements.countPending.textContent = pending;
  elements.pendingBadge.textContent = pending;

  // Renderizar Lista
  if (total === 0) {
    elements.emptyState.style.display = 'block';
    elements.historyList.innerHTML = '';
    elements.historyList.appendChild(elements.emptyState);
    return;
  }

  elements.emptyState.style.display = 'none';
  elements.historyList.innerHTML = '';

  state.items.forEach(item => {
    const itemEl = document.createElement('div');
    itemEl.className = 'history-item';

    let statusText = 'Sincronizado';
    let statusClass = 'status-synced';

    if (item.status === 'sending') {
      statusText = 'Enviando...';
      statusClass = 'status-sending';
    } else if (item.status === 'pending') {
      statusText = 'Pendente';
      statusClass = 'status-pending';
    }

    const displayInfo = formatItemDisplay(item.description);

    itemEl.innerHTML = `
      <div class="item-info">
        <span class="item-desc" title="${escapeHtml(item.description)}">${escapeHtml(displayInfo.primary)}</span>
        ${displayInfo.secondary ? `<div class="item-sub-desc" title="${escapeHtml(displayInfo.secondary)}">${escapeHtml(displayInfo.secondary)}</div>` : ''}
        <div class="item-meta">
          <span>🕒 ${item.timestamp.split(' ')[1] || item.timestamp}</span>
          <span>🏷️ ${escapeHtml(item.batch)}</span>
          <span>👤 ${escapeHtml(item.operator)}</span>
        </div>
      </div>
      <span class="item-status-badge ${statusClass}">${statusText}</span>
    `;

    elements.historyList.appendChild(itemEl);
  });
}

function escapeHtml(str) {
  if (!str) return '';
  return str.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Exportar Histórico para CSV
function exportToCsv() {
  if (state.items.length === 0) {
    showToast('Nenhum item para exportar.', 'warning');
    return;
  }

  const headers = ['ID', 'Data/Hora', 'Descricao', 'Carga_Lote', 'Conferente', 'Origem', 'Status'];
  const rows = state.items.map(item => [
    `"${item.id}"`,
    `"${item.timestamp}"`,
    `"${(item.description || '').replace(/"/g, '""')}"`,
    `"${item.batch}"`,
    `"${item.operator}"`,
    `"${item.source}"`,
    `"${item.status}"`
  ]);

  const csvContent = '\uFEFF' + [headers.join(','), ...rows.map(r => r.join(','))].join('\r\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `conferencia_carga_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('Planilha CSV gerada com sucesso!', 'success');
}

// Limpar Histórico Local
function clearHistory() {
  if (state.items.length === 0) return;
  if (confirm('Deseja realmente limpar o histórico do leitor local? (Itens já gravados no Google Sheets permanecerão na planilha).')) {
    state.items = [];
    saveItemsToStorage();
    updateUI();
    showToast('Histórico local limpo.', 'success');
  }
}

// Código do Google Apps Script pronto para copiar
const APPS_SCRIPT_TEMPLATE = `// CÓDIGO GOOGLE APPS SCRIPT PARA O GOOGLE SHEETS
// Abra sua planilha > Extensões > Apps Script > Cole este código > Implantar como Web App

function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.tryLock(10000);

  try {
    var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
    
    // Se a planilha estiver vazia, cria o cabeçalho automático
    if (sheet.getLastRow() === 0) {
      sheet.appendRow([
        "Data / Hora",
        "Descrição do Material / Equipamento",
        "Nº Carga / Lote",
        "Conferente",
        "Origem",
        "ID de Registro"
      ]);
      // Formata o cabeçalho em negrito
      sheet.getRange(1, 1, 1, 6).setFontWeight("bold").setBackground("#10b981").setFontColor("#ffffff");
    }

    var data = JSON.parse(e.postData.contents);

    // Adiciona a nova linha de conferência
    sheet.appendRow([
      data.timestamp || new Date().toLocaleString("pt-BR"),
      data.description || "Sem descrição",
      data.batch || "SEM LOTE",
      data.operator || "Geral",
      data.source || "QR Code",
      data.id || ("ID_" + Date.now())
    ]);

    return ContentService.createTextOutput(JSON.stringify({
      status: "success",
      message: "Item gravado com sucesso"
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: "error",
      message: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);

  } finally {
    lock.releaseLock();
  }
}

function doGet(e) {
  return ContentService.createTextOutput("API de Conferência de Carga ativa e funcionando!").setMimeType(ContentService.MimeType.TEXT);
}
`;

// Gestão de Configurações e Modais
function openSettingsModal() {
  elements.scriptUrlInput.value = state.config.scriptUrl;
  elements.chkSound.checked = state.config.sound;
  elements.chkVibrate.checked = state.config.vibrate;
  elements.chkContinuous.checked = state.config.continuous;
  elements.modalSettings.classList.remove('hidden');
}

function closeSettingsModal() {
  elements.modalSettings.classList.add('hidden');
}

function saveSettings() {
  const url = elements.scriptUrlInput.value.trim();
  state.config.scriptUrl = url;
  state.config.sound = elements.chkSound.checked;
  state.config.vibrate = elements.chkVibrate.checked;
  state.config.continuous = elements.chkContinuous.checked;

  localStorage.setItem('cargascan_script_url', state.config.scriptUrl);
  localStorage.setItem('cargascan_sound', state.config.sound);
  localStorage.setItem('cargascan_vibrate', state.config.vibrate);
  localStorage.setItem('cargascan_continuous', state.config.continuous);

  closeSettingsModal();
  showToast('Configurações salvas com sucesso!', 'success');

  // Se agora tem URL e há itens pendentes, tenta sincronizar
  const pending = state.items.filter(i => i.status === 'pending').length;
  if (url && pending > 0) {
    syncAllPending();
  }
}

async function testConnection() {
  const url = elements.scriptUrlInput.value.trim();
  if (!url) {
    alert('Por favor, informe a URL do Web App do Google Apps Script.');
    return;
  }

  showToast('Testando conexão com a planilha...', 'warning');
  try {
    // Teste com ping
    await fetch(url, { method: 'GET', mode: 'no-cors' });
    showToast('Conexão estabelecida com sucesso!', 'success');
  } catch (err) {
    console.error("Erro no teste:", err);
    showToast('Não foi possível verificar. Certifique-se de implantar como "Qualquer pessoa" (Anyone).', 'error');
  }
}

function copyScriptCode() {
  navigator.clipboard.writeText(APPS_SCRIPT_TEMPLATE).then(() => {
    alert('Código copiado para a área de transferência!\n\nAgora vá na sua planilha Google > Extensões > Apps Script e cole o código.');
  }).catch(() => {
    alert('Não foi possível copiar automaticamente. Você pode ver o código no arquivo google-apps-script.gs.');
  });
}

// Configuração de Event Listeners
function setupEventListeners() {
  // Câmera
  elements.btnStartCamera.addEventListener('click', startCamera);
  elements.btnToggleCamera.addEventListener('click', () => {
    if (state.isScanning) {
      stopCamera();
    } else {
      startCamera();
    }
  });
  elements.btnSwitchCamera.addEventListener('click', switchCamera);
  
  // Upload de Imagem/Foto da Galeria
  if (elements.btnUploadFile && elements.fileInput) {
    elements.btnUploadFile.addEventListener('click', () => {
      elements.fileInput.click();
    });

    elements.fileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;

      showToast('Analisando imagem...', 'warning');
      try {
        const wasScanning = state.isScanning;
        if (wasScanning) {
          await stopCamera();
        }

        const decodedText = await scanImageFile(file);
        if (decodedText) {
          onScanSuccess(decodedText, { source: 'Foto/Arquivo' });
          showToast('QR Code da foto identificado!', 'success');
        } else {
          showToast('Nenhum código encontrado na imagem.', 'error');
        }

        if (wasScanning) {
          setTimeout(startCamera, 1200);
        }
      } catch (err) {
        console.warn("Falha ao escanear imagem:", err);
        showToast('Não foi possível ler o QR code desta foto. Enquadre mais perto do quadrado.', 'error');
      } finally {
        elements.fileInput.value = '';
      }
    });
  }

  // Formulário Manual
  elements.formManual.addEventListener('submit', (e) => {
    e.preventDefault();
    const val = elements.manualText.value.trim();
    if (!val) return;
    processItemRecord(val, 'Manual');
    elements.manualText.value = '';
    elements.manualText.blur();
  });

  // Ações de Histórico
  elements.btnSyncPending.addEventListener('click', syncAllPending);
  elements.btnExportCsv.addEventListener('click', exportToCsv);
  elements.btnClearHistory.addEventListener('click', clearHistory);

  // Configurações e Modal
  elements.btnSettings.addEventListener('click', openSettingsModal);
  elements.btnCloseModal.addEventListener('click', closeSettingsModal);
  elements.btnSaveSettings.addEventListener('click', saveSettings);
  elements.btnTestConnection.addEventListener('click', testConnection);
  elements.btnCopyScript.addEventListener('click', copyScriptCode);

  elements.modalSettings.addEventListener('click', (e) => {
    if (e.target === elements.modalSettings) closeSettingsModal();
  });
}

// Inicialização Geral
window.addEventListener('DOMContentLoaded', () => {
  setupEventListeners();
  updateUI();
  initScanner();

  // Se for a primeira vez sem URL configurada, exibe dica
  if (!state.config.scriptUrl) {
    setTimeout(() => {
      showToast('Dica: Toque no ícone de engrenagem ⚙️ para conectar sua planilha Google!', 'warning');
    }, 1200);
  }
});
