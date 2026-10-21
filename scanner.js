(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var sessionId = params.get('session') || '';
  var openerWindow = window.opener;
  var resultPort = null;
  var scanner = null;
  var lastValue = '';
  var running = false;
  var used = false;
  var cameraSelect = document.getElementById('cameraSelect');
  var contextStatus = document.getElementById('contextStatus');
  var status = document.getElementById('scanStatus');
  var result = document.getElementById('result');
  var startButton = document.getElementById('startButton');
  var stopButton = document.getElementById('stopButton');

  function setStatus(message, error) {
    status.textContent = message;
    status.className = error ? 'error' : '';
  }

  function contextDiagnostics() {
    return {
      secureContext: !!window.isSecureContext,
      mediaDevices: !!navigator.mediaDevices,
      getUserMedia: !!(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function'),
      topLevel: window.top === window.self,
      session: !!sessionId,
      opener: !!openerWindow,
      channel: !!resultPort
    };
  }

  function errorMessage(error) {
    var name = error && error.name || '';
    if (name === 'NotAllowedError') return 'Izin kamera ditolak atau diblokir. Aktifkan izin kamera untuk halaman scanner ini.';
    if (name === 'NotFoundError') return 'Kamera tidak ditemukan pada perangkat ini.';
    if (name === 'NotReadableError') return 'Kamera sedang digunakan aplikasi lain.';
    if (name === 'OverconstrainedError') return 'Kamera yang dipilih tidak tersedia. Pilih kamera lain.';
    if (name === 'SecurityError') return 'Browser memblokir kamera karena kebijakan keamanan.';
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

  function stopScanner(sendCancel) {
    var active = scanner;
    scanner = null;
    running = false;
    stopButton.disabled = true;
    startButton.disabled = false;
    cameraSelect.disabled = false;
    if (active) {
      active.stop().catch(function (error) {
        console.warn('[ASH external scanner] stop failed', error && error.name || 'UnknownError');
      }).then(function () {
        try { active.clear(); } catch (error) { console.warn('[ASH external scanner] clear failed'); }
      });
    }
    if (sendCancel && !used && resultPort) resultPort.postMessage({type: 'ASH_SCANNER_CANCEL', version: 1, sessionId: sessionId});
  }

  function sendResult(value) {
    if (used || !sessionId || !resultPort || value.length > 512) return;
    used = true;
    result.textContent = 'Kode terbaca. Mengirim ke ERP...';
    stopScanner(false);
    resultPort.postMessage({type: 'ASH_SCANNER_RESULT', version: 1, sessionId: sessionId, value: value});
    setStatus('Hasil dikirim. Anda dapat menutup tab ini.', false);
  }

  function populateCameras() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    navigator.mediaDevices.enumerateDevices().then(function (devices) {
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

  function startScanner() {
    if (running || used) return;
    var diagnostics = contextDiagnostics();
    console.info('[ASH external scanner] start', diagnostics);
    if (!diagnostics.secureContext || !diagnostics.mediaDevices || !diagnostics.getUserMedia) {
      setStatus('Scanner memerlukan HTTPS dan dukungan getUserMedia.', true);
      return;
    }
    if (!diagnostics.topLevel || !diagnostics.session || !openerWindow || !resultPort) {
      setStatus('Sesi scanner tidak valid. Buka scanner dari tombol ERP.', true);
      return;
    }
    if (!window.Html5Qrcode) {
      setStatus('Library scanner belum selesai dimuat. Coba lagi.', true);
      return;
    }
    running = true;
    lastValue = '';
    startButton.disabled = true;
    stopButton.disabled = false;
    setStatus('Meminta izin kamera...', false);
    var cameraId = cameraSelect.value || '';
    var videoConstraints = cameraId ? {deviceId: {exact: cameraId}} : {facingMode: {ideal: 'environment'}};
    navigator.mediaDevices.getUserMedia({video: videoConstraints, audio: false}).then(function (stream) {
      stream.getTracks().forEach(function (track) { track.stop(); });
      populateCameras();
      scanner = new Html5Qrcode('reader');
      var config = {fps: 10, qrbox: {width: 250, height: 180}};
      var formats = supportedFormats();
      if (formats.length) config.formatsToSupport = formats;
      return scanner.start(cameraId || {facingMode: {ideal: 'environment'}}, config, function (decoded) {
        if (decoded === lastValue) return;
        lastValue = decoded;
        sendResult(decoded.trim());
      }, function () {});
    }).then(function () {
      setStatus('Arahkan kamera ke QR code atau barcode.', false);
    }).catch(function (error) {
      console.error('[ASH external scanner] start failed', {name: error && error.name || 'UnknownError'});
      stopScanner(false);
      setStatus(errorMessage(error), true);
    });
  }

  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (event.source !== openerWindow || data.type !== 'ASH_SCANNER_INIT' || data.version !== 1 || data.sessionId !== sessionId || !event.ports || !event.ports[0]) return;
    resultPort = event.ports[0];
    resultPort.start();
    contextStatus.textContent = 'Terhubung ke ERP. Kamera hanya diminta setelah tombol Mulai Scan ditekan.';
  });
  if (openerWindow) openerWindow.postMessage({type: 'ASH_SCANNER_READY', version: 1}, '*');
  startButton.addEventListener('click', startScanner);
  stopButton.addEventListener('click', function () { stopScanner(true); setStatus('Scanner ditutup.', false); });
  window.addEventListener('beforeunload', function () { stopScanner(true); });
  contextStatus.textContent = openerWindow && sessionId ? 'Menunggu koneksi ERP. Kamera hanya diminta setelah tombol Mulai Scan ditekan.' : 'Sesi tidak valid. Buka scanner dari ERP.';
}());
