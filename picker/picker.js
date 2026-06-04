// KMS Drive Picker Bridge Page
// Hospedado en kaleideschool.github.io/public/picker/
// Recibe credentials del parent (KMS frontend iframe) via postMessage,
// invoca GIS + Picker en este top-level frame (origin authorized),
// devuelve el file pickeado al parent. NO embed credentials en código:
// todas vienen del parent en el mensaje 'init'.

(function () {
  'use strict';

  // El parent KMS corre dentro de un iframe sandbox cuyo origin es
  // https://n-<hash>-<id>-script.googleusercontent.com. Aceptamos cualquier
  // subdominio googleusercontent.com (sandbox iframe) y script.google.com (root).
  // Esto se valida en CADA mensaje recibido — no es una whitelist abierta.
  var ALLOWED_PARENT_ORIGIN_PATTERNS = [
    /^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/,
    /^https:\/\/script\.google\.com$/
  ];

  var state = {
    apiKey:       null,
    clientId:     null,
    parentOrigin: null,
    tokenClient:  null,
    pickerReady:  false,
    gapiLoaded:   false,
    gisLoaded:    false
  };

  function isAllowedOrigin(origin) {
    return ALLOWED_PARENT_ORIGIN_PATTERNS.some(function (re) { return re.test(origin); });
  }

  function setStatus(msg, isError) {
    var el = document.getElementById('status');
    if (!el) return;
    el.textContent = msg;
    el.className = isError ? 'err' : '';
  }

  function sendToParent(message) {
    if (!state.parentOrigin || !window.opener) return;
    try {
      window.opener.postMessage(message, state.parentOrigin);
    } catch (e) {
      // Parent closed or unreachable; nothing to do.
    }
  }

  // Lazy: tras cargar gapi.picker + GIS, enviamos 'picker-ready' al parent.
  function checkBothLoaded() {
    if (state.gapiLoaded && state.gisLoaded && !state.pickerReady) {
      state.pickerReady = true;
      // Si el parent ya nos mandó algo, su origin está fijado; si no, lo
      // sabremos cuando llegue el primer mensaje válido.
      sendToParent({ type: 'picker-ready' });
      setStatus('Esperando configuracion...');
    }
  }

  function loadGapiPicker() {
    if (typeof gapi === 'undefined') {
      return setTimeout(loadGapiPicker, 100);
    }
    gapi.load('picker', function () {
      state.gapiLoaded = true;
      checkBothLoaded();
    });
  }

  function checkGis() {
    if (typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
      state.gisLoaded = true;
      checkBothLoaded();
    } else {
      setTimeout(checkGis, 100);
    }
  }

  loadGapiPicker();
  checkGis();

  // Recepción del mensaje 'init' (credentials) del parent.
  window.addEventListener('message', function (event) {
    if (!isAllowedOrigin(event.origin)) {
      // No log de event.data — puede contener credentials.
      return;
    }
    state.parentOrigin = event.origin;
    var msg = event.data;
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'init' && msg.api_key && msg.client_id) {
      state.apiKey   = msg.api_key;
      state.clientId = msg.client_id;
      setStatus('Solicitando autorizacion de Drive...');
      requestToken();
    }
  });

  function requestToken() {
    try {
      state.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: state.clientId,
        scope:     'https://www.googleapis.com/auth/drive.file',
        callback:  function (tokenResponse) {
          if (tokenResponse && tokenResponse.access_token) {
            setStatus('Abriendo selector...');
            openPicker(tokenResponse.access_token);
          } else {
            sendToParent({ type: 'picker-cancel', reason: 'no_token' });
            window.close();
          }
        },
        error_callback: function (err) {
          sendToParent({
            type:   'picker-cancel',
            reason: 'token_error',
            error:  (err && err.type) || String(err)
          });
          window.close();
        }
      });
      state.tokenClient.requestAccessToken({ prompt: '' });
    } catch (e) {
      sendToParent({ type: 'picker-cancel', reason: 'init_error' });
      setStatus('Error al inicializar token client', true);
    }
  }

  function openPicker(accessToken) {
    try {
      var docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
        .setMimeTypes('application/pdf')
        .setOwnedByMe(false)
        .setIncludeFolders(false)
        .setSelectFolderEnabled(false);

      var picker = new google.picker.PickerBuilder()
        .setOAuthToken(accessToken)
        .setDeveloperKey(state.apiKey)
        .addView(docsView)
        .setCallback(function (data) {
          if (data.action === google.picker.Action.PICKED) {
            var doc = data.docs && data.docs[0];
            if (!doc) return;
            sendToParent({
              type: 'picker-result',
              file: {
                id:        doc.id,
                name:      doc.name,
                mimeType:  doc.mimeType,
                sizeBytes: doc.sizeBytes ? Number(doc.sizeBytes) : 0
              }
            });
            window.close();
          } else if (data.action === google.picker.Action.CANCEL) {
            sendToParent({ type: 'picker-cancel', reason: 'user_canceled' });
            window.close();
          }
        })
        .build();
      picker.setVisible(true);
    } catch (e) {
      sendToParent({ type: 'picker-cancel', reason: 'picker_error' });
      setStatus('Error al construir Picker', true);
    }
  }
})();
