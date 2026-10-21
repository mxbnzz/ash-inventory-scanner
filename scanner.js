(function () {
  'use strict';

  var params = new URLSearchParams(location.search);
  var sessionId = params.get('session') || '';
  var openerWindow = window.opener;
  var resultPort = null;
  var scanner = null;
  var running = false;
  var used = false;
  var pendingSubmit = null;
  var cart = [];
  var scanCount = 0;
  var cameraSelect = document.getElementById('cameraSelect');
  var contextStatus = document.getElementById('contextStatus');
  var status = document.getElementById('scanStatus');
  var result = document.getElementById('result');
  var countNode = document.getElementById('scanCount');
  var cartNode = document.getElementById('scanCart');
  var startButton = document.getElementById('startButton');
  var stopButton = document.getElementById('stopButton');
  var submitCartButton = document.getElementById('submitCartButton');
  var returnButton = document.getElementById('returnButton');

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

  function renderCart() {
    if (!cart.length) {
      cartNode.innerHTML = '<p>Belum ada kode.</p>';
      submitCartButton.disabled = true;
      return;
    }
    cartNode.innerHTML = cart.map(function (item, index) {
      return '<div class="cart-line"><code>' + escapeHtml(item.value) + '</code>' +
        '<input type="number" min="1" step="1" value="' + item.quantity + '" data-cart-quantity="' + index + '" aria-label="Jumlah">' +
        '<button type="button" data-cart-remove="' + index + '" aria-label="Hapus kode">×</button></div>';
    }).join('');
    submitCartButton.disabled = !!pendingSubmit;
    cartNode.querySelectorAll('[data-cart-quantity]').forEach(function (input) {
      input.addEventListener('change', function () {
        var value = Number(input.value);
        cart[Number(input.getAttribute('data-cart-quantity'))].quantity = isFinite(value) && value >= 1 ? Math.floor(value) : 1;
        renderCart();
      });
    });
    cartNode.querySelectorAll('[data-cart-remove]').forEach(function (button) {
      button.addEventListener('click', function () {
        cart.splice(Number(button.getAttribute('data-cart-remove')), 1);
        renderCart();
      });
    });
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, function (ch) {
      return {'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[ch];
    });
  }

  function addToCart(value) {
    if (!value || value.length > 512) return;
    var existing = cart.filter(function (item) { return item.value === value; })[0];
    if (existing) existing.quantity += 1;
    else cart.push({value: value, quantity: 1});
    scanCount += 1;
    countNode.textContent = String(scanCount);
    result.textContent = 'Kode terbaca: ' + value;
    renderCart();
  }

  function pauseDecoder() {
    if (scanner && typeof scanner.pause === 'function') {
      try { scanner.pause(true); } catch (error) {}
    }
  }

  function resumeDecoder() {
    if (scanner && typeof scanner.resume === 'function' && !pendingSubmit) {
      try { scanner.resume(); } catch (error) {}
    }
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
        try { active.clear(); } catch (error) {}
      });
    }
    if (sendCancel && !used && resultPort) {
      resultPort.postMessage({type: 'ASH_SCANNER_CANCEL', version: 1, sessionId: sessionId});
    }
  }

  function submitCart() {
    if (!cart.length || pendingSubmit || !resultPort) return;
    var messageId = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + '-' + Math.random();
    pendingSubmit = {messageId: messageId};
    pauseDecoder();
    submitCartButton.disabled = true;
    setStatus('Mengirim Scan Cart ke ERP...', false);
    resultPort.postMessage({
      type: 'ASH_SCANNER_CART_SUBMIT',
      version: 1,
      sessionId: sessionId,
      messageId: messageId,
      items: cart.map(function (item) { return {value: item.value, quantity: item.quantity}; })
    });
  }

  function handleCartAck(data) {
    if (!pendingSubmit || data.messageId !== pendingSubmit.messageId) return;
    if (data.accepted === true) {
      used = true;
      setStatus('Semua barang berhasil dikirim. Menutup scanner...', false);
      result.textContent = 'ERP menerima ' + cart.length + ' kode.';
      stopScanner(false);
      setTimeout(function () {
        try { window.close(); } catch (error) {}
        contextStatus.textContent = 'Semua barang berhasil dikirim. Silakan kembali ke tab ERP.';
        returnButton.focus();
      }, 700);
      return;
    }
    pendingSubmit = null;
    submitCartButton.disabled = false;
    setStatus(data.message || 'Sebagian item ditolak ERP. Perbaiki Scan Cart lalu kirim ulang.', true);
    result.textContent = (data.failures && data.failures.length ? 'Gagal: ' + data.failures.join(', ') : 'Tidak semua item diterima ERP.');
    resumeDecoder();
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
      if (pendingSubmit) return;
      pauseDecoder();
      addToCart(decoded.trim());
      setStatus('Kode terbaca. Arahkan ke kode berikutnya atau tekan Selesai dan Kirim.', false);
      setTimeout(resumeDecoder, 700);
    }, function () {}).then(function () {
      setStatus('Kamera aktif — arahkan ke QR/barcode.', false);
      cameraSelect.disabled = false;
    }).catch(function (error) {
      console.error('[ASH external scanner] start failed', {name: error && error.name || 'UnknownError'});
      stopScanner(false);
      setStatus(errorMessage(error) + ' Pilih kamera manual lalu tekan Mulai Scan.', true);
    });
  }

  window.addEventListener('message', function (event) {
    var data = event.data || {};
    if (event.source !== openerWindow || data.type !== 'ASH_SCANNER_INIT' ||
        data.version !== 1 || data.sessionId !== sessionId ||
        !event.ports || !event.ports[0]) return;
    resultPort = event.ports[0];
    resultPort.onmessage = function (messageEvent) {
      var message = messageEvent.data || {};
      if (message.type === 'ASH_SCANNER_CART_ACK' && message.version === 1 &&
          message.sessionId === sessionId) handleCartAck(message);
    };
    resultPort.start();
    contextStatus.textContent = 'Terhubung ke ERP. Kamera hanya diminta setelah Mulai Scan.';
  });

  if (openerWindow) openerWindow.postMessage({type: 'ASH_SCANNER_READY', version: 1}, '*');
  startButton.addEventListener('click', startScanner);
  submitCartButton.addEventListener('click', submitCart);
  returnButton.addEventListener('click', function () {
    if (openerWindow && !openerWindow.closed) openerWindow.focus();
  });
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
  renderCart();
  contextStatus.textContent = openerWindow && sessionId ?
    'Menunggu koneksi ERP. Kamera hanya diminta setelah Mulai Scan.' :
    'Sesi tidak valid. Buka scanner dari ERP.';
}());
