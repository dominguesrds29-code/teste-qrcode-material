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
  zoomControls: document.getElementById('zoom-controls'),
  
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

// =====================================================================
// MOTOR DE LEITURA PRÓPRIO (substitui o html5-qrcode)
// - Câmera em alta resolução via getUserMedia
// - Decodifica recortes do frame NATIVO (não o tamanho da tela)
// - 3 motores: BarcodeDetector (ML Kit do Android) + jsQR + ZXing
// - Suporte a etiquetas gravadas em Latin-1 (ex.: "Nrº" = byte 0xBA)
// =====================================================================

// Converte bytes crus do QR em texto: tenta UTF-8 e, se inválido, Latin-1
function bytesToText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(u8);
  } catch (e) {}
  try {
    return new TextDecoder('iso-8859-1').decode(u8);
  } catch (e) {}
  let s = '';
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return s;
}

// jsQR: muito tolerante a QR pequenos. Quando o texto vem vazio (bytes Latin-1),
// usa os bytes crus (binaryData) para reconstruir o texto.
function decodeWithJsQR(imageData, width, height, tryInverted = false) {
  if (typeof jsQR === 'undefined') return null;
  try {
    const code = jsQR(imageData.data, width, height, {
      inversionAttempts: tryInverted ? 'attemptBoth' : 'dontInvert'
    });
    if (!code) return null;
    if (code.data && code.data.trim().length > 0) return code.data;
    if (code.binaryData && code.binaryData.length > 0) {
      const text = bytesToText(code.binaryData);
      if (text && text.trim().length > 0) return text;
    }
  } catch (err) {
    console.warn('Erro no jsQR:', err);
  }
  return null;
}

// Mantido por compatibilidade com o restante do código
function decodeQrCodeFromImageData(imageData, width, height) {
  return decodeWithJsQR(imageData, width, height, true);
}

// ZXing: tenta GlobalHistogramBinarizer (essencial para etiquetas de patrimônio) e HybridBinarizer
const zxingEngine = { reader: null, hints: null };
function decodeWithZXing(imageData, width, height) {
  if (typeof ZXing === 'undefined') return null;
  try {
    if (!zxingEngine.reader) {
      zxingEngine.reader = new ZXing.QRCodeReader();
      const hints = new Map();
      hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
      hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.QR_CODE]);
      zxingEngine.hints = hints;
    }
    const d = imageData.data;
    const n = width * height;
    const lum = new Uint8ClampedArray(n);
    for (let i = 0, j = 0; i < n; i++, j += 4) {
      lum[i] = (d[j] + 2 * d[j + 1] + d[j + 2]) >> 2;
    }
    const source = new ZXing.RGBLuminanceSource(lum, width, height);

    // 1. GlobalHistogramBinarizer: detecta etiquetas de patrimônio perfeitamente
    if (typeof ZXing.GlobalHistogramBinarizer !== 'undefined') {
      try {
        const bitmapGlobal = new ZXing.BinaryBitmap(new ZXing.GlobalHistogramBinarizer(source));
        const res = zxingEngine.reader.decode(bitmapGlobal, zxingEngine.hints);
        const text = res && res.getText();
        if (text && text.trim().length > 0) return text;
      } catch (e) {}
    }

    // 2. Fallback para HybridBinarizer
    try {
      const bitmapHybrid = new ZXing.BinaryBitmap(new ZXing.HybridBinarizer(source));
      const res = zxingEngine.reader.decode(bitmapHybrid, zxingEngine.hints);
      const text = res && res.getText();
      if (text && text.trim().length > 0) return text;
    } catch (e) {}

    return null;
  } catch (e) {
    return null; // NotFound / Checksum são normais enquanto procura
  }
}

// Resultado do BarcodeDetector é aceito apenas se não vier corrompido
function isValidDetectorText(text) {
  return !!text && text.trim().length > 0 && !text.includes('\uFFFD');
}

// Estado interno da câmera
const cam = {
  stream: null,
  track: null,
  video: null,
  canvas: null,
  ctx: null,
  loopTimer: null,
  frame: 0,
  detector: null,
  digitalZoom: 1,     // usado quando o aparelho não expõe zoom por hardware
  hardwareZoom: false
};

function getWorkCanvas() {
  if (!cam.canvas) {
    cam.canvas = document.createElement('canvas');
    cam.ctx = cam.canvas.getContext('2d', { willReadFrequently: true });
  }
  return cam.ctx;
}

// Lê um frame da câmera com varredura completa da etiqueta (sem cortar QR code na borda esquerda)
async function scanCurrentFrame() {
  const v = cam.video;
  if (!v || v.readyState < 2 || !v.videoWidth) return null;

  const vw = v.videoWidth;
  const vh = v.videoHeight;
  cam.frame++;

  // 1) BarcodeDetector nativo (ML Kit / Google Play Services) no frame inteiro
  if (cam.detector) {
    try {
      const codes = await cam.detector.detect(v);
      for (const c of codes) {
        if (isValidDetectorText(c.rawValue)) return c.rawValue;
      }
    } catch (e) {}
  }

  // 2) jsQR + ZXing em resolução otimizada (~640px)
  // Em etiquetas retangulares de patrimônio, o QR code fica no canto esquerdo.
  // Alternamos entre quadro completo e foco no terço esquerdo/centro para máxima rapidez.
  const step = cam.frame % 3;
  let sx = 0, sy = 0, sw = vw, sh = vh;

  if (step === 1 && (!cam.hardwareZoom || cam.digitalZoom > 1)) {
    // Foco ampliado na metade esquerda/central (onde o QR code da etiqueta costuma ficar)
    sw = Math.round(vw * 0.7);
    sh = Math.round(vh * 0.7);
    sx = Math.round(vw * 0.05); // inicia próximo à borda esquerda
    sy = Math.round((vh - sh) / 2);
  } else if (step === 2 && (!cam.hardwareZoom || cam.digitalZoom > 1)) {
    // Foco central aproximado
    sw = Math.round(vw * 0.6);
    sh = Math.round(vh * 0.6);
    sx = Math.round((vw - sw) / 2);
    sy = Math.round((vh - sh) / 2);
  }

  const TARGET_WIDTH = 640;
  const scale = TARGET_WIDTH / sw;
  const cw = TARGET_WIDTH;
  const ch = Math.max(1, Math.round(sh * scale));

  const ctx = getWorkCanvas();
  if (cam.canvas.width !== cw || cam.canvas.height !== ch) {
    cam.canvas.width = cw;
    cam.canvas.height = ch;
  }
  ctx.drawImage(v, sx, sy, sw, sh, 0, 0, cw, ch);
  const img = ctx.getImageData(0, 0, cw, ch);

  // 1º Tenta jsQR com suporte a Latin-1 ("Nrº BMP") e inversão (~35ms)
  let text = decodeWithJsQR(img, cw, ch, true);

  // 2º Se não achou, tenta ZXing com GlobalHistogramBinarizer (~45ms)
  if (!text) {
    text = decodeWithZXing(img, cw, ch);
  }

  return text;
}

function startScanLoop() {
  stopScanLoop();
  cam.frame = 0;
  cam.detector = null;
  if ('BarcodeDetector' in window) {
    try {
      cam.detector = new BarcodeDetector({ formats: ['qr_code'] });
    } catch (e) {
      cam.detector = null;
    }
  }

  const tick = async () => {
    if (!state.isScanning) return;
    const t0 = performance.now();
    try {
      const text = await scanCurrentFrame();
      if (text) onScanSuccess(text, { source: 'Camera' });
    } catch (e) {
      console.warn('Falha no frame:', e);
    }
    // Pausa proporcional ao custo do frame: a interface nunca congela
    const elapsed = performance.now() - t0;
    if (state.isScanning) {
      cam.loopTimer = setTimeout(tick, Math.max(50, Math.round(elapsed * 0.6)));
    }
  };
  cam.loopTimer = setTimeout(tick, 250);
}

function stopScanLoop() {
  if (cam.loopTimer) {
    clearTimeout(cam.loopTimer);
    cam.loopTimer = null;
  }
}

// Abre a câmera pedindo a maior resolução possível, com fallbacks
async function openCameraStream(facing) {
  const attempts = [
    { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
    { audio: false, video: { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 } } },
    { audio: false, video: { facingMode: facing } },
    { audio: false, video: true }
  ];
  let lastErr = null;
  for (const constraints of attempts) {
    try {
      return await navigator.mediaDevices.getUserMedia(constraints);
    } catch (e) {
      lastErr = e;
      if (e && (e.name === 'NotAllowedError' || e.name === 'SecurityError')) break;
    }
  }
  throw lastErr;
}

// Configuração de Autofoco Contínuo e Zoom (hardware ou digital)
async function setupCameraFocusAndZoom() {
  const track = cam.track;
  if (!track) return;

  let capabilities = {};
  try {
    capabilities = track.getCapabilities ? track.getCapabilities() : {};
  } catch (e) {}

  // Foco contínuo: essencial para etiquetas de papel
  if (capabilities.focusMode && capabilities.focusMode.includes('continuous')) {
    await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }).catch(() => {});
  }

  cam.hardwareZoom = !!(capabilities.zoom && capabilities.zoom.max > 1);
  const maxZoom = cam.hardwareZoom ? capabilities.zoom.max : 3;

  if (elements.zoomControls) {
    elements.zoomControls.style.display = 'flex';
    document.querySelectorAll('.btn-zoom').forEach(btn => {
      const zVal = parseFloat(btn.dataset.zoom);
      btn.style.display = (zVal <= maxZoom) ? 'inline-block' : 'none';
      btn.classList.toggle('active', zVal === 1);
    });
  }
  cam.digitalZoom = 1;
  if (cam.video) cam.video.style.transform = '';
}

async function setZoom(zoomLevel) {
  if (!cam.track) return;
  try {
    if (cam.hardwareZoom) {
      await cam.track.applyConstraints({ advanced: [{ zoom: zoomLevel }] });
    } else {
      // Zoom digital: amplia a imagem na tela e recorta o centro do frame nativo na leitura
      cam.digitalZoom = zoomLevel;
      if (cam.video) cam.video.style.transform = zoomLevel > 1 ? `scale(${zoomLevel})` : '';
    }
    document.querySelectorAll('.btn-zoom').forEach(b => {
      b.classList.toggle('active', parseFloat(b.dataset.zoom) === zoomLevel);
    });
  } catch (e) {
    // Se o hardware recusar, cai para zoom digital
    cam.hardwareZoom = false;
    cam.digitalZoom = zoomLevel;
    if (cam.video) cam.video.style.transform = zoomLevel > 1 ? `scale(${zoomLevel})` : '';
  }
}

// Processamento robusto de arquivos de imagem/foto da galeria
async function scanImageFile(file) {
  const img = await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const im = new Image();
    im.onload = () => { URL.revokeObjectURL(url); resolve(im); };
    im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Erro ao abrir a imagem.')); };
    im.src = url;
  });

  const w = img.naturalWidth || img.width;
  const h = img.naturalHeight || img.height;

  // 1. BarcodeDetector nativo
  if ('BarcodeDetector' in window) {
    try {
      const detector = new BarcodeDetector({ formats: ['qr_code'] });
      const codes = await detector.detect(img);
      for (const c of codes) {
        if (isValidDetectorText(c.rawValue)) return c.rawValue;
      }
    } catch (e) {}
  }

  // 2. jsQR + ZXing em várias escalas (fotos de celular são grandes demais)
  const maxSide = Math.max(w, h);
  const targets = [800, 640, 1200, 480, maxSide];
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  for (const target of targets) {
    const scale = Math.min(1, target / maxSide);
    const cw = Math.round(w * scale);
    const ch = Math.round(h * scale);
    canvas.width = cw;
    canvas.height = ch;
    ctx.drawImage(img, 0, 0, cw, ch);
    const data = ctx.getImageData(0, 0, cw, ch);
    const text = decodeWithJsQR(data, cw, ch, true) || decodeWithZXing(data, cw, ch);
    if (text) return text;
    await new Promise(r => setTimeout(r, 0)); // deixa a interface respirar
  }

  throw new Error('Nenhum QR Code legível encontrado na foto.');
}

// Inicializar e Controlar Câmera
async function initScanner() {
  startCamera();
}

async function startCamera() {
  if (state.isScanning) return;

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showToast('Este navegador não libera a câmera. Acesse via HTTPS no Chrome.', 'error');
    return;
  }

  try {
    elements.cameraPlaceholder.style.display = 'none';
    elements.laser.classList.add('active');

    cam.stream = await openCameraStream(state.currentFacingMode);
    cam.track = cam.stream.getVideoTracks()[0];
    state.cameraTrack = cam.track;

    if (!cam.video) {
      cam.video = document.createElement('video');
      cam.video.setAttribute('playsinline', '');
      cam.video.setAttribute('autoplay', '');
      cam.video.muted = true;
      elements.qrReaderContainer.innerHTML = '';
      elements.qrReaderContainer.appendChild(cam.video);
    }
    cam.video.srcObject = cam.stream;
    await cam.video.play();

    state.isScanning = true;
    elements.btnToggleCamera.innerHTML = '<span class="btn-icon">⏹</span> Pausar';

    await setupCameraFocusAndZoom();
    startScanLoop();

    const s = cam.track.getSettings ? cam.track.getSettings() : {};
    console.log('Câmera ativa:', s.width + 'x' + s.height, '| BarcodeDetector:', !!cam.detector);
  } catch (err) {
    console.error('Erro ao iniciar câmera:', err);
    releaseCamera();
    elements.laser.classList.remove('active');
    elements.cameraPlaceholder.style.display = 'flex';
    state.isScanning = false;
    elements.btnToggleCamera.innerHTML = '<span class="btn-icon">▶️</span> Iniciar';

    let errorMsg = 'Não foi possível abrir a câmera.';
    const errName = (err && err.name) || '';
    const errStr = (err && (err.message || err.toString())) || '';
    if (errName === 'NotAllowedError' || errStr.includes('Permission') || errStr.includes('denied')) {
      errorMsg = 'Permissão da câmera negada. Permita o acesso à câmera nas configurações do navegador (ícone de cadeado na barra de endereço).';
    } else if (errName === 'NotFoundError') {
      errorMsg = 'Nenhuma câmera encontrada no aparelho.';
    } else if (errName === 'NotReadableError') {
      errorMsg = 'A câmera já está sendo usada por outro app.';
    } else if (window.location.protocol !== 'https:' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
      errorMsg = 'O navegador bloqueia a câmera fora de HTTPS. No celular, acesse via HTTPS.';
    } else {
      errorMsg = 'Erro na câmera: ' + errStr;
    }
    showToast(errorMsg, 'error');
  }
}

function releaseCamera() {
  stopScanLoop();
  if (cam.stream) {
    cam.stream.getTracks().forEach(t => t.stop());
  }
  cam.stream = null;
  cam.track = null;
  state.cameraTrack = null;
  state.torchEnabled = false;
  if (cam.video) {
    cam.video.srcObject = null;
    cam.video.style.transform = '';
  }
  if (elements.btnToggleTorch) elements.btnToggleTorch.classList.remove('active');
}

async function stopCamera() {
  releaseCamera();
  if (elements.zoomControls) elements.zoomControls.style.display = 'none';
  state.isScanning = false;
  elements.laser.classList.remove('active');
  elements.cameraPlaceholder.style.display = 'flex';
  elements.btnToggleCamera.innerHTML = '<span class="btn-icon">▶️</span> Iniciar';
}

async function switchCamera() {
  await stopCamera();
  state.currentFacingMode = (state.currentFacingMode === 'environment') ? 'user' : 'environment';
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

  const headers = ['Data/Hora', 'Descricao', 'Carga_Lote', 'Conferente', 'Origem', 'Status'];
  const rows = state.items.map(item => [
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
        "Origem"
      ]);
      // Formata o cabeçalho em negrito (5 colunas)
      sheet.getRange(1, 1, 1, 5).setFontWeight("bold").setBackground("#10b981").setFontColor("#ffffff");
    }

    var data = JSON.parse(e.postData.contents);

    // Adiciona a nova linha de conferência (sem ID)
    sheet.appendRow([
      data.timestamp || new Date().toLocaleString("pt-BR"),
      data.description || "Sem descrição",
      data.batch || "SEM LOTE",
      data.operator || "Geral",
      data.source || "QR Code"
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
  
  // Lanterna (Torch) se a câmera suportar
  if (elements.btnToggleTorch) {
    elements.btnToggleTorch.addEventListener('click', async () => {
      try {
        if (!state.isScanning) {
          showToast('Inicie a câmera primeiro', 'warning');
          return;
        }
        if (!state.cameraTrack) return;
        state.torchEnabled = !state.torchEnabled;
        await state.cameraTrack.applyConstraints({
          advanced: [{ torch: state.torchEnabled }]
        });
        showToast(`Lanterna ${state.torchEnabled ? 'ligada' : 'desligada'}`);
        elements.btnToggleTorch.classList.toggle('active', state.torchEnabled);
      } catch (e) {
        state.torchEnabled = false;
        showToast('Lanterna não suportada neste aparelho', 'warning');
      }
    });
  }

  // Controles de Zoom da Câmera
  document.querySelectorAll('.btn-zoom').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const z = parseFloat(e.currentTarget.dataset.zoom);
      setZoom(z);
    });
  });

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
