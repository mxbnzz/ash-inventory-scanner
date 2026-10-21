(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var sessionId = params.get('session') || '';
  var openerWindow = window.opener;
  var resultPort = null;
  var scanner = null;
  var running = false;
  var used = false;
  var pending = null;
  var scanCount = 0;
  var cameraSelect = document.getElementById('cameraSelect');
  var contextStatus = document.getElementById('contextStatus');
  var status = document.getElementById('scanStatus');
  var result = document.getElementById('result');
  var countNode = document.getElementById('scanCount');
  var startButton = document.getElementById('startButton');
  var stopButton = document.getElementById('stopButton');
  var retryButton = document.getElementById('retryButton');

  function setStatus(message, error) {
    status.textContent = message;
    status.className = error ? 'error' : '';
  }

  function errorMessage(error) {
    var name = error && error.name || '';
    if (name === 'NotAllowedError') return 'Izin kamera ditolak atau diblokir. Aktifkan izin kamera untuk halaman scanner ini.';
    if (name === 'NotFoundError') return 'Kamera tidak ditemukan. Pilih kamera lain jika tersedia.';
    if (name === 'NotReadableError') return 'Kamera sedang digunakan aplikasi lain.';
    if (name === 'OverconstrainedError') return 'Kamera belakang tidak tersedia. Pilih kamera lain.';
    if (name === 'AbortError') return 'Pembukaan kamera dibatalkan. Coba lagi.';
    return 'Scanner gagal dimulai. Periksa HTTPS, izin kamera, dan kamera yang tersedia.';
  }

  function supportedFormats() {
    var names = ['QR_CODE', 'CODE_128', 'CODE_39', 'EAN_13', 'EAN_8', 'UPC_A', 'UPC_E'];
    return names.filter(function (name) {
      return window.Html5QrcodeSupportedFormats && window.Html5QrcodeSupportedFormats[name];
    }).map(function (name) {
      return window.Html5QrcodeSupportedFormats[name];
    });
  }

  function populateCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve();
    return navigator.mediaDevices.enumerateDevices().then(function (devices) {
      cameraSelect.innerHTML = '<option value="">Otomatis (kamera belakang)</option>';
      devices.filter(function (device) { return device.kind === 'videoinput'; }).forEach(function (device, index) {
        var option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || ('Kamera ' + (index + 1));
        cameraSelect.appendChild(option);
      });
      cameraSelect.disabled = false;
    }).catch(function () {});
  }

  function stopScanner(sendCancel) {
    var active = scanner;
    scanner = null;
    running = false;
    pending = null;
    stopButton.disabled = true;
    startButton.disabled = false;
    cameraSelect.disabled = false;
    retryButton.disabled = true;
    if (active) {
      active.stop().catch(function (error) {
        console.warn('[ASH external scanner] stop failed', error && error.name || 'UnknownError');
      }).then(function () {
        try { active.clear(); } catch (error) { console.warn('[ASH external scanner] clear failed'); }
      });
    }
    if (sendCancel && !used && resultPort) {
      resultPort.postMessage({type: 'ASH_SCANNER_CANCEL', version: 1, sessionId: sessionId});
    }
  }

  function pauseDecoder() {
    if (scanner && typeof scanner.pause === 'function') {
      try { scanner.pause(true); } catch (error) { console.warn('[ASH external scanner] pause failed'); }
    }
  }

  function resumeDecoder() {
    if (scanner && typeof scanner.resume === 'function') {
      try { scanner.resume(); } catch (error) { console.warn('[ASH external scanner] resume failed'); }
    }
  }

  function sendResult(value) {
    if (used || pending || !sessionId || !resultPort || value.length > 512) return;
    var messageId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
    pending = {messageId: messageId, value: value};
    pauseDecoder();
    result.textContent = 'Kode terbaca: ' + value;
    setStatus('Kode terbaca — mengirim ke ERP...', false);
    retryButton.disabled = false;
    resultPort.postMessage({type: 'ASH_SCANNER_RESULT', version: 1, sessionId: sessionId, messageId: messageId, value: value});
  }

  function retryPending() {
    if (!pending || !resultPort) return;
    retryButton.disabled = true;
    setStatus('Mengirim ulang kode ke ERP...', false);
    resultPort.postMessage({type: 'ASH_SCANNER_RESULT', version: 1, sessionId: sessionId, messageId: pending.messageId, value: pending.value, retry: true});
  }

  function startScanner() {
    if (running || used) return;
    if (!window.isSecureContext || !navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
      setStatus('Scanner memerlukan HTTPS dan dukungan kamera browser.', true);
      return;
    }
    if (!sessionId || !openerWindow || !resultPort || !window.Html5Qrcode) {
      setStatus('Sesi scanner belum terhubung. Buka scanner dari tombol ERP.', true);
      return;
    }
    running = true;
    startButton.disabled = true;
    stopButton.disabled = false;
    cameraSelect.disabled = true;
    setStatus('Meminta izin kamera belakang...', false);
    scanner = new Html5Qrcode('reader');
    var formats = supportedFormats();
    var config = {fps: 10, qrbox: {width: 250, height: 180}};
    if (formats.length) config.formatsToSupport = formats;
    var cameraConfig = cameraSelect.value || {facingMode: 'environment'};
    scanner.start(cameraConfig, config, function (decoded) {
      sendResult(decoded.trim());
    }, function () {}).then(function () {
      setStatus('Kamera aktif — arahkan ke QR/barcode.', false);
      populateCameras();
      cameraSelect.disabled = false;
    }).catch(function (error) {
      console.error('[ASH external scanner] start failed', {name: error && error.name || 'UnknownError'});
      stopScanner(false);
      populateCameras();
      setStatus(errorMessage(error) + ' Pilih kamera manual lalu tekan Mulai Scan.', true);
    });
  }

  function handleAck(data) {
    if (!pending || data.messageId !== pending.messageId) return;
    if (data.accepted === true) {
      scanCount += 1;
      countNode.textContent = String(scanCount);
      result.textContent = 'Diterima ERP: ' + pending.value;
      pending = null;
      retryButton.disabled = true;
      setStatus('Diterima ERP — arahkan ke kode berikutnya.', false);
      setTimeout(resumeDecoder, 700);
      return;
    }
    setStatus((data.message || 'ERP menolak kode ini.') + ' Anda dapat mencoba lagi.', true);
    retryButton.disabled = false;
  }

  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (event.source !== openerWindow || data.type !== 'ASH_SCANNER_INIT' ||
        data.version !== 1 || data.sessionId !== sessionId ||
        !event.ports || !event.ports[0]) return;
    resultPort = event.ports[0];
    resultPort.onmessage = function (messageEvent) {
      var message = messageEvent.data || {};
      if (message.type === 'ASH_SCANNER_ACK' && message.version === 1 &&
          message.sessionId === sessionId) handleAck(message);
    };
    resultPort.start();
    contextStatus.textContent = 'Terhubung ke ERP. Kamera hanya diminta setelah Mulai Scan.';
  });

  if (openerWindow) openerWindow.postMessage({type: 'ASH_SCANNER_READY', version: 1}, '*');
  startButton.addEventListener('click', startScanner);
  retryButton.addEventListener('click', retryPending);
  cameraSelect.addEventListener('change', function () {
    if (!running) return;
    stopScanner(false);
    setStatus('Kamera berubah. Tekan Mulai Scan untuk membuka kamera pilihan.', false);
  });
  stopButton.addEventListener('click', function () {
    stopScanner(true);
    setStatus('Scanner ditutup.', false);
  });
  window.addEventListener('beforeunload', function () { stopScanner(true); });
  contextStatus.textContent = openerWindow && sessionId ?
    'Menunggu koneksi ERP. Kamera hanya diminta setelah Mulai Scan.' :
    'Sesi tidak valid. Buka scanner dari ERP.';
}());
