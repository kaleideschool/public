// KMS Drive Picker Bridge Page — OAuth2 Implicit Flow + Redirect (no GIS)
// Hospedada en https://kaleideschool.github.io/public/picker/
//
// Resuelve popup_failed_to_open de GIS desde popup window context (sub-popup blocked).
// Flow: bridge recibe init del parent → guarda state en sessionStorage → window.location.assign
// a Google OAuth → Google redirige bridge con #access_token en hash → bridge abre Picker.
// El contrato postMessage parent ↔ bridge es invariante respecto al CLI anterior.

(function () {
  'use strict';

  // ── Config ────────────────────────────────────────────────────────────────
  var ALLOWED_PARENT_ORIGINS = [
    /^https:\/\/[a-z0-9-]+\.googleusercontent\.com$/,
    /^https:\/\/script\.google\.com$/
  ];
  var BRIDGE_URL = 'https://kaleideschool.github.io/public/picker/';
  var OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
  var OAUTH_SCOPE = 'https://www.googleapis.com/auth/drive.file';

  var SS_KEY_PARENT_ORIGIN = 'kms_picker_parent_origin';
  var SS_KEY_API_KEY       = 'kms_picker_api_key';
  var SS_KEY_CLIENT_ID     = 'kms_picker_client_id';
  var SS_KEY_STATE_NONCE   = 'kms_picker_state';

  // ── State ─────────────────────────────────────────────────────────────────
  var state = {
    apiKey: null,
    clientId: null,
    parentOrigin: null,
    accessToken: null,
    gapiLoaded: false,
    pickerReady: false
  };

  // ── Helpers ───────────────────────────────────────────────────────────────
  function isAllowedOrigin(origin) {
    return ALLOWED_PARENT_ORIGINS.some(function (p) { return p.test(origin); });
  }

  function setStatus(msg, isError) {
    var el = document.getElementById('status');
    if (el) {
      el.textContent = msg;
      el.style.color = isError ? '#c00' : '#666';
    }
  }

  function sendToParent(message) {
    if (state.parentOrigin && window.opener) {
      try { window.opener.postMessage(message, state.parentOrigin); } catch (e) {}
    }
  }

  function saveSessionState() {
    try {
      if (state.parentOrigin) sessionStorage.setItem(SS_KEY_PARENT_ORIGIN, state.parentOrigin);
      if (state.apiKey)       sessionStorage.setItem(SS_KEY_API_KEY, state.apiKey);
      if (state.clientId)     sessionStorage.setItem(SS_KEY_CLIENT_ID, state.clientId);
    } catch (e) {}
  }

  function restoreSessionState() {
    try {
      state.parentOrigin = state.parentOrigin || sessionStorage.getItem(SS_KEY_PARENT_ORIGIN);
      state.apiKey       = state.apiKey       || sessionStorage.getItem(SS_KEY_API_KEY);
      state.clientId     = state.clientId     || sessionStorage.getItem(SS_KEY_CLIENT_ID);
    } catch (e) {}
  }

  function clearSessionState() {
    try {
      sessionStorage.removeItem(SS_KEY_PARENT_ORIGIN);
      sessionStorage.removeItem(SS_KEY_API_KEY);
      sessionStorage.removeItem(SS_KEY_CLIENT_ID);
      sessionStorage.removeItem(SS_KEY_STATE_NONCE);
    } catch (e) {}
  }

  // ── gapi.picker loader ────────────────────────────────────────────────────
  function loadGapi() {
    if (typeof gapi === 'undefined') {
      setTimeout(loadGapi, 100);
      return;
    }
    gapi.load('picker', function () {
      state.gapiLoaded = true;
      tryOpenPicker();          // si ya tenemos token (caso retorno del redirect)
      checkBothReadyForInit();  // si aún no tenemos token (caso carga inicial)
    });
  }
  loadGapi();

  // ── Token parsing (return from OAuth redirect) ────────────────────────────
  function parseTokenFromHash() {
    if (!window.location.hash || window.location.hash.length < 2) return null;
    var params = new URLSearchParams(window.location.hash.substring(1));
    var error = params.get('error');
    if (error) {
      var errDesc = params.get('error_description') || '';
      console.error('[picker] OAuth redirect error:', error, errDesc);
      setStatus(
        'Error OAuth: ' + error + (errDesc ? ' - ' + errDesc : '') +
        ' (cierra esta ventana manualmente).',
        true
      );
      // Restaurar parentOrigin del sessionStorage para informar al parent.
      restoreSessionState();
      sendToParent({
        type: 'picker-cancel',
        reason: 'oauth_error',
        error: error,
        details: errDesc || null
      });
      clearSessionState();
      return null;
    }
    return params.get('access_token');
  }

  function handleTokenReturn() {
    restoreSessionState();
    var token = parseTokenFromHash();
    if (!token) return false;
    state.accessToken = token;
    // Limpiar hash para no dejar token visible en URL bar (cosmético — el token ya
    // vive en memoria + scope drive.file está acotado a archivos del propio user).
    try { history.replaceState(null, '', window.location.pathname); } catch (e) {}
    setStatus('Autorización recibida — abriendo selector…');
    tryOpenPicker();
    return true;
  }

  // ── Picker ────────────────────────────────────────────────────────────────
  function tryOpenPicker() {
    if (!state.gapiLoaded || !state.accessToken || !state.apiKey || state.pickerReady) return;
    state.pickerReady = true;

    var docsView = new google.picker.DocsView(google.picker.ViewId.DOCS)
      .setMimeTypes('application/pdf')
      .setOwnedByMe(false);

    var picker = new google.picker.PickerBuilder()
      .setOAuthToken(state.accessToken)
      .setDeveloperKey(state.apiKey)
      .addView(docsView)
      .setCallback(function (data) {
        if (data.action === google.picker.Action.PICKED) {
          var doc = data.docs[0];
          clearSessionState();
          sendToParent({
            type: 'picker-result',
            file: {
              id:        doc.id,
              name:      doc.name,
              mimeType:  doc.mimeType,
              sizeBytes: doc.sizeBytes || null
            }
          });
          window.close();
        } else if (data.action === google.picker.Action.CANCEL) {
          clearSessionState();
          sendToParent({ type: 'picker-cancel', reason: 'user_canceled' });
          window.close();
        }
      })
      .build();

    picker.setVisible(true);
  }

  // ── postMessage handler (carga inicial, antes del redirect) ───────────────
  window.addEventListener('message', function (event) {
    if (!isAllowedOrigin(event.origin)) return;
    state.parentOrigin = event.origin;
    var msg = event.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'parent-hello') {
      checkBothReadyForInit();
    } else if (msg.type === 'init' && msg.api_key && msg.client_id) {
      state.apiKey = msg.api_key;
      state.clientId = msg.client_id;
      saveSessionState();
      setStatus('Solicitando autorización de Drive…');

      var stateNonce = Math.random().toString(36).substring(2) +
                       Math.random().toString(36).substring(2);
      try { sessionStorage.setItem(SS_KEY_STATE_NONCE, stateNonce); } catch (e) {}

      var oauthUrl = OAUTH_AUTH_URL +
        '?client_id='             + encodeURIComponent(state.clientId) +
        '&redirect_uri='          + encodeURIComponent(BRIDGE_URL) +
        '&response_type=token' +
        '&scope='                 + encodeURIComponent(OAUTH_SCOPE) +
        '&state='                 + encodeURIComponent(stateNonce) +
        '&include_granted_scopes=true';

      window.location.assign(oauthUrl);
    }
  });

  function checkBothReadyForInit() {
    // Anunciamos picker-ready cuando gapi está cargado, parent ya nos saludó, y NO
    // estamos en flow de retorno del redirect (i.e. aún no tenemos accessToken).
    if (state.gapiLoaded && state.parentOrigin && !state.pickerReady && !state.accessToken) {
      sendToParent({ type: 'picker-ready' });
      setStatus('Esperando configuración del parent…');
    }
  }

  // ── Bootstrap: detectar si volvemos del redirect o si es carga inicial ────
  if (window.location.hash && window.location.hash.indexOf('access_token=') > -1) {
    setStatus('Procesando autorización…');
    handleTokenReturn();
  } else if (window.location.hash && window.location.hash.indexOf('error=') > -1) {
    setStatus('Procesando error OAuth…');
    handleTokenReturn();  // mismo handler — parseTokenFromHash detecta error= en hash.
  } else {
    setStatus('Esperando configuración del parent…');
    // checkBothReadyForInit se dispara cuando llegue parent-hello + gapi loaded.
  }
})();
