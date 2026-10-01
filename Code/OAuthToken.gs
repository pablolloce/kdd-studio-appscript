/**
 * KDD Studio — OAuthToken: la MITAD PÚBLICA del proyecto (#279 · #292)
 *
 * UN proyecto de Apps Script, DOS implementaciones. `executeAs` se elige por
 * implementación, así que este mismo código sirve las dos mitades:
 *
 *   PÚBLICA        "Ejecutar como: usuario que accede". Es la que conoce el
 *                  plugin. Login + TODO lo que toca Drive.
 *   PRIVILEGIADA   "Ejecutar como: Yo (el propietario)". Solo la llama
 *                  relayConfigData_ (Script Property CONFIG_DATA_URL) con el
 *                  marcador cfgRelay, y solo sirve a cfgDispatch_ (ConfigData.gs).
 *
 * Están en el MISMO proyecto porque el token que acuña Apps Script vale solo
 * para el proyecto de Google Cloud del script que lo pide: con dos proyectos,
 * el relay funcionaba con el propietario y con nadie más (HTTP 403 en la
 * puerta, sin llegar a ejecutar nada — #292).
 *
 * NADIE abre aquí el Excel de Roles/árbol: eso lo hace ConfigData.gs, y solo
 * si afirma antes que corre como el propietario. Lo que se hace aquí, con el
 * token del USUARIO, es todo lo que toca Drive: login, creación de la carpeta
 * de la caja, ACL, registro y ficheros. Esa es la razón de que la
 * implementación pública sea USER_ACCESSING — en Drive tiene que constar
 * QUIÉN hizo cada cosa, no el propietario del script (bug #90: un deployment
 * executeAs:ME repartió el token del propietario a todos los usuarios y todas
 * las acciones aparecían a su nombre).
 *
 * Dos guards opuestos deciden con qué identidad se está corriendo, porque el
 * código no puede saber por qué implementación ha entrado:
 *   assertSinSuplantacion_()  efectivo === activo !== ''  → protege el TOKEN
 *   cfgAssertPrivileged_()    efectivo === OWNER_EMAIL     → protege el EXCEL
 *
 * Script Property nueva: CONFIG_DATA_URL (URL /exec de la implementación
 *   PRIVILEGIADA). Vacía → login y árbol caen con error explícito, NUNCA con
 *   un fallback que lea el Sheet: un fallback silencioso reabriría el agujero
 *   para siempre. El rollback es re-publicar la versión anterior de la
 *   implementación PÚBLICA.
 * Script Property nueva: OWNER_EMAIL — la escribe Run → cfgSetupOwner().
 *
 * GENERADO por scripts/build-gas-sources.js a partir de gas/_FUENTE-OAuthToken.gs.
 * NO LO EDITES A MANO: toca los anchors del generador y regenera en el mismo commit.
 *
 * Script Properties nuevas: ninguna obligatoria (reusa DRIVE_ROOT_ID). Opcional: SOURCES_TOKEN
 *   (si se quiere proteger resolveSource con token compartido; recomendado).
 *   Opcional: FLAT_ROOT_ID (carpeta raíz del layout PLANO: cada caja vive en
 *   <FLAT_ROOT_ID>/S###_<nombre>/; si está poblada, resolveSource crea la carpeta
 *   plana de la caja y le aplica la ACL que le dicta ConfigData — vacía = no-op).
 *   Opcional: MIN_PLUGIN_VERSION (#240 — versión mínima del plugin para hacer LOGIN; el
 *   plugin manda la suya en ?action=auth&pv=X.Y.Z, menor o ausente → página "versión
 *   obsoleta"; vacía = gate desactivado) + UPDATE_MESSAGE (HTML extra de esa página).
 * El layout del Sheet de Roles (matriz de roles por caja) y del tab del árbol
 *   está documentado en gas/ConfigData.gs, que es el único que los abre. Aquí
 *   solo llegan sus RESULTADOS: rol del usuario, árbol ya recortado, y a quién
 *   hay que poner de editor/lector en la carpeta de una caja.
 * Gestión de accesos (doPost): listBoxUsers / grantAccess / revokeAccess. La fila
 *   del Sheet y TODOS los gates de autorización viven en ConfigData; aquí solo se
 *   aplica la ACL de Drive resultante, con el token del que concede, para que en
 *   Drive conste quién dio o quitó el acceso.
 *
 * Solo gestiona el flujo de login del plugin NFQ Worker.
 * Todas las operaciones de fichero (upload, download, crear carpetas, leer
 * pointer files) las hace el plugin directamente contra la Drive REST API
 * usando el oauthToken que devuelve este script.
 */

// ── Config from Script Properties ────────────────────────────────────────────

// ── Config from Script Properties ────────────────────────────────────────────
//
// SIN SHEET_ID a propósito: el Excel de Roles/árbol lo abre ConfigData, nunca
// este proyecto. Si necesitas algo del Sheet, va por relayConfigData_.
function getConfig_() {
  const props = PropertiesService.getScriptProperties();
  return {
    allowedDomains: (props.getProperty('ALLOWED_DOMAINS') || 'nfq.es,bbva.com')
      .split(',')
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(function (s) { return !!s; }),
    driveRootId: props.getProperty('DRIVE_ROOT_ID') || '',
  };
}

// ── Role lookup (lo resuelve ConfigData) ─────────────────────────────────────

function lookupRole_(email) {
  var fallback = {
    found: false, role: 'kb-consumer', allowedUuaas: [], allowedSources: [], readableSources: [],
    championSources: [], stewardSources: [], userSources: [], externalUserSources: [],
    allowedSourceIds: [], readableSourceIds: [], championSourceIds: [], stewardSourceIds: [],
    userSourceIds: [], externalUserSourceIds: [], sourcesSinSid: [],
    userType: '', isAdmin: false,
  };
  var res = relayConfigData_('role', {});
  if (!res || res.ok !== true || !res.roleInfo) {
    return Object.assign({}, fallback, { warning: (res && res.error) || 'ConfigData no respondió al lookup de rol' });
  }
  return res.roleInfo;
}



// ── HTTP entry point ─────────────────────────────────────────────────────────

function doGet(e) {
  // PERMISOS INCOMPLETOS, antes que nada. Google pide los permisos con una
  // casilla por scope y recuerda la elección: quien no marcó todas llegaba al
  // login, el relay a ConfigData fallaba sin `script.external_request` o sin
  // Drive, y veía "Acceso no autorizado" para siempre — con su fila bien en el
  // Excel. Va ANTES de la barrera 1 porque sin `userinfo.email` esa barrera
  // lanza y el usuario vería un error de Google sin explicación. No filtra
  // nada: en la privilegiada corre como el propietario, que lo tiene todo
  // concedido, y sigue a la barrera como siempre.
  var paramsPermisos = (e && e.parameter) ? e.parameter : {};
  if ((paramsPermisos.action || 'auth') === 'auth') {
    var faltan = permisosFaltantes_();
    if (faltan) { return permisosPage_(faltan); }
  }

  // BARRERA 1. Va ANTES de mirar la acción: en la implementación PRIVILEGIADA un
  // GET corre como el PROPIETARIO, así que sin esto un `?action=auth` abierto a
  // mano por cualquiera del dominio se llevaría el token del dueño (bug #90).
  // En la pública no cambia nada: efectivo y activo son la misma persona, y
  // handleAuth_ ya cortaba dos líneas después cuando Session venía vacía.
  assertSinSuplantacion_();

  const params = (e && e.parameter) ? e.parameter : {};
  const action = params.action || 'auth';

  // Source registry (modelo Source) — el plugin lee el árbol de cajas + S-IDs.
  if (action === 'sources') {
    return handleSources_(params);
  }

  // Árbol COMPLETO de cajas (todas, con y sin S-ID) para el explorador/selector.
  if (action === 'tree') {
    return handleTree_(params);
  }

  if (action !== 'auth') {
    // El eco del parámetro va ESCAPADO y recortado: `action` llega crudo del
    // querystring y esta página la sirve el mismo origen que el login, así que
    // sin escapar es un XSS reflejado con el que mandar a la víctima a un
    // `google.script.run` del proyecto. El resto del fichero ya escapa todo lo
    // que pinta (email, title, role, pluginVersion, target) — esta línea se
    // había quedado fuera del patrón.
    return HtmlService.createHtmlOutput(
      '<h1>KDD Studio</h1>' +
      '<p style="font-family:sans-serif">Accion no soportada: <code>' + escapeHtml_(String(action).slice(0, 40)) + '</code></p>'
    );
  }

  // Gate de versión mínima del plugin (#240): si MIN_PLUGIN_VERSION está
  // poblada y el plugin llama con una versión menor (o tan vieja que ni
  // manda `pv`), el login se bloquea con la página de "versión obsoleta".
  var versionGate = checkPluginVersionGate_(params);
  if (versionGate) { return versionGate; }

  return handleAuth_(params);
}

function doPost(e) {
  try {
    const body = (e && e.postData && e.postData.contents) ? e.postData.contents : '';
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (err) {
      return jsonResponse_({ ok: false, error: 'Invalid JSON body' });
    }

    // LA MITAD PRIVILEGIADA, y va la primera (#292). El marcador lo pone
    // `relayConfigData_`; el plugin nunca lo manda. Quien lo forje contra la
    // implementación pública se topa con `cfgAssertPrivileged_()` en la primera
    // línea de cfgDispatch_ — y con un Excel que no está compartido con nadie.
    if (payload && payload.cfgRelay === true) {
      return cfgJson_(cfgDispatch_(payload));
    }

    // BARRERA 1 para TODO lo demás: lo que sigue toca Drive con el token del
    // usuario y da por supuesto que el usuario es quien llama. En la
    // implementación privilegiada eso es falso, así que aquí se corta.
    assertSinSuplantacion_();

    const action = payload.action || '';
    if (action === 'resolveSource') {
      return resolveSource_(payload);
    }
    // `metaBatch` (varias lecturas en un viaje) entra por la misma puerta: el
    // gate de cada ítem vive en ConfigData, igual que el de las sueltas.
    if (action === 'metaList' || action === 'metaRead' || action === 'metaBatch' || action === 'metaWrite' || action === 'metaDelete') {
      return jsonResponse_(relayConfigData_(action, payload));
    }
    // Rastro de adopción (#313): el lote entra por la MISMA puerta que todo lo
    // demás —la del proyecto que acuñó el token del plugin— y se releya a la
    // mitad privilegiada, que es la única que puede escribir en el buzón. NO
    // está en RELAY_IDEMPOTENTES_: un 404 del buzón de Apps Script llega con el
    // lote YA escrito, y reintentar duplicaría filas (#311).
    if (action === 'trailBatch') {
      return jsonResponse_(relayConfigData_('trailBatch', payload));
    }
    if (action === 'listBoxUsers') {
      return accessListBoxUsers_(payload);
    }
    if (action === 'grantAccess') {
      return accessGrantAccess_(payload);
    }
    if (action === 'revokeAccess') {
      return accessRevokeAccess_(payload);
    }
    return jsonResponse_({ ok: false, error: 'Unknown POST action: ' + action });
  } catch (err) {
    return jsonResponse_({
      ok: false,
      error: 'doPost error: ' + (err && err.message ? err.message : String(err)),
    });
  }
}

// ── Recipients handler (token-protected JSON endpoint) ───────────────────────


function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}


// ── Gate de versión mínima del plugin (#240) ─────────────────────────────────
//
// Script Property `MIN_PLUGIN_VERSION` (p.ej. "1.0.5"): versión mínima del
// plugin KDD Studio con la que se permite hacer LOGIN. El plugin envía la suya
// en `?action=auth&pv=<version>`; si es menor que el mínimo — o no la envía
// (versión antigua que no conoce el parámetro) — el login se bloquea con una
// página que obliga a actualizar. Property vacía/ausente → gate DESACTIVADO
// (rollout seguro, mismo patrón que FLAT_ROOT_ID).
//
// Para forzar una actualización obligatoria basta con EDITAR la property
// (sin redesplegar): p.ej. al publicar la 1.0.6, poner MIN_PLUGIN_VERSION=1.0.6
// y los usuarios con 1.0.5 verán el muro en su siguiente login.
//
// Script Property opcional `UPDATE_MESSAGE`: HTML extra para la página (p.ej.
// enlace de descarga de la última versión). Solo la edita el admin.
//
// Solo bloquea el LOGIN: `?action=sources/tree` y el doPost no se tocan — los
// usuarios con sesión viva no se rompen a mitad de trabajo; se encuentran el
// muro cuando les caduque el token y vayan a re-loguear.

function comparePluginVersions_(a, b) {
  // -1 / 0 / 1 comparando "1.0.5" vs "1.0.10" numéricamente por segmentos
  // (un compare de strings diría 1.0.10 < 1.0.5 — por eso se parsea).
  var pa = String(a || '').split('.');
  var pb = String(b || '').split('.');
  var len = Math.max(pa.length, pb.length);
  for (var i = 0; i < len; i++) {
    var na = parseInt(pa[i], 10); if (isNaN(na)) { na = 0; }
    var nb = parseInt(pb[i], 10); if (isNaN(nb)) { nb = 0; }
    if (na < nb) { return -1; }
    if (na > nb) { return 1; }
  }
  return 0;
}

function checkPluginVersionGate_(params) {
  var min = '';
  try {
    min = (PropertiesService.getScriptProperties().getProperty('MIN_PLUGIN_VERSION') || '').trim();
  } catch (err) {
    return null; // defensivo: un fallo del propio gate NUNCA deja a nadie fuera
  }
  if (!min) { return null; } // property vacía → gate desactivado

  var pv = String((params && params.pv) || '').trim();
  if (pv && comparePluginVersions_(pv, min) >= 0) { return null; } // al día

  return obsoleteVersionPage_(pv, min);
}

function obsoleteVersionPage_(pluginVersion, minVersion) {
  var extra = '';
  try {
    extra = PropertiesService.getScriptProperties().getProperty('UPDATE_MESSAGE') || '';
  } catch (err) { /* opcional */ }

  var versionLine = pluginVersion
    ? 'Tu versión del plugin es la <strong>' + escapeHtml_(pluginVersion) + '</strong> y la mínima obligatoria es la <strong>' + escapeHtml_(minVersion) + '</strong>.'
    : 'Tu versión del plugin es anterior a la <strong>' + escapeHtml_(minVersion) + '</strong>, que es la mínima obligatoria.';

  var html =
    '<!DOCTYPE html>' +
    '<html lang="es"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<title>KDD Studio — Versión obsoleta</title>' +
    '<style>' + corporateStyles_() +
    ' .status-icon { color: var(--nfq-pink); }' +
    ' .detail { font-size: 0.9rem; color: rgba(255,255,255,0.55); line-height: 1.7; }' +
    ' .detail strong { color: var(--nfq-white); }' +
    '</style>' +
    '</head><body>' +
    '<div class="card">' +
      nfqLogoSvg_() +
      '<div class="divider"></div>' +
      '<div class="status-icon">⬆</div>' +
      '<h1>Versión del plugin obsoleta</h1>' +
      '<p class="detail">No se puede iniciar sesión con esta versión de KDD Studio. ' + versionLine + '</p>' +
      '<p class="detail">Es <strong>obligatorio actualizar</strong> a la última versión del plugin para seguir trabajando.</p>' +
      (extra ? '<p class="detail">' + extra + '</p>' : '') +
      '<p class="hint" style="margin-top:2.5rem;">Instala la última versión y vuelve a iniciar sesión.</p>' +
      '<p class="hint">KDD Studio · Knowledge-Driven Development</p>' +
    '</div>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html).setTitle('KDD Studio — Versión obsoleta');
}

// ── Auth handler ─────────────────────────────────────────────────────────────

/**
 * ID de extensión al que redirigir el callback vscode:// del login.
 * WHITELIST CERRADA: solo los IDs conocidos del plugin; cualquier otro valor
 * cae al legacy. NUNCA usar el parámetro sin validar (open redirect).
 */
function callbackExtensionId_(params) {
  var ALLOWED = { 'bbva.kdd-studio': true, 'nfqxbbva.kdd-studio': true, 'nfq.kdd-studio': true };
  var ext = (params && params.ext) ? String(params.ext).toLowerCase() : '';
  // `=== true` y no truthiness: un lookup plano resolvería propiedades
  // heredadas del prototipo (`?ext=constructor`) y rompería el fail-closed.
  return ALLOWED[ext] === true ? ext : 'nfq.kdd-studio';
}

function handleAuth_(params) {
  // `state` = nonce CSRF que el plugin generó al iniciar el login (#250·#10).
  // Se DEVUELVE tal cual en el callback (éxito Y rechazo); el plugin lo valida
  // contra el nonce pendiente e ignora los callbacks que no lo traigan (forja/
  // replay). El GAS no lo interpreta ni lo persiste.
  var state = (params && params.state) ? String(params.state) : '';
  // `ext` = ID de la extensión que inicia el login. El callback vscode:// se
  // enruta POR ID de extensión, así que tras cada rebranding del publisher
  // (nfq → NfqxBBVA → BBVA) el plugin nuevo manda su ID y aquí
  // se redirige al correcto. WHITELIST cerrada — nunca redirigir a un valor
  // libre del request (open redirect). Plugins viejos no mandan `ext` → ID
  // legacy → siguen funcionando.
  var extId = callbackExtensionId_(params);
  const email = Session.getActiveUser().getEmail();
  if (!email) {
    return errorPage_(
      'No se ha podido identificar tu cuenta de Google.',
      'Asegúrate de tener la sesión iniciada en el navegador con una cuenta corporativa.'
    );
  }

  const cfg = getConfig_();
  const domain = (email.split('@')[1] || '').toLowerCase();
  if (cfg.allowedDomains.length > 0 && cfg.allowedDomains.indexOf(domain) < 0) {
    return errorPage_(
      'Dominio no autorizado',
      'Tu cuenta <strong>' + escapeHtml_(email) + '</strong> no pertenece a un dominio autorizado. ' +
      'Dominios permitidos: ' + cfg.allowedDomains.join(', ')
    );
  }

  // En la implementación PRIVILEGIADA esto sería el token del PROPIETARIO, y
  // este payload acaba en el navegador del que abrió la URL. `tokenDelUsuario_`
  // repite el check de suplantación por si algún día alguien alcanza
  // `handleAuth_` sin pasar por `doGet` (bug #90).
  const oauthToken = tokenDelUsuario_();
  if (!oauthToken) {
    return errorPage_(
      'Sin token OAuth',
      'No se ha podido obtener un token OAuth. Revisa los scopes del script.'
    );
  }

  const roleInfo = lookupRole_(email);

  // "No te he podido preguntar" NO es "no estás en el Excel". Con `warning`, el
  // relay o la lectura de Roles fallaron y `found:false` es el fallback, no una
  // respuesta: pintarlo como "no registrado" mandaba al admin a buscar una fila
  // que sí existe. Sin callback `rejected` a propósito — el plugin lo trataría
  // como denegación definitiva; aquí basta con reintentar el login.
  if (!roleInfo.found && roleInfo.warning) {
    Logger.log('handleAuth_: no se pudo resolver el rol de ' + email + ' — ' + roleInfo.warning);
    return errorPage_(
      'No se ha podido comprobar tu acceso',
      'El servicio de autorización no ha respondido a tiempo para <strong>' + escapeHtml_(email) + '</strong>. ' +
      'No significa que no tengas acceso: vuelve a iniciar sesión en unos segundos. ' +
      'Si persiste, avisa a un administrador con este detalle: <em>' + escapeHtml_(String(roleInfo.warning).slice(0, 200)) + '</em>'
    );
  }

  if (!roleInfo.found) {
    var rejectPayload = JSON.stringify({ rejected: true, email: email, state: state });
    var rejectB64 = Utilities.base64Encode(rejectPayload, Utilities.Charset.UTF_8);
    var rejectTarget = 'vscode://' + extId + '/auth?data=' + encodeURIComponent(rejectB64);
    return errorPage_(
      'Acceso no autorizado',
      'Tu cuenta <strong>' + escapeHtml_(email) + '</strong> no está registrada en el sistema. ' +
      'Contacta con un administrador para que te añada al listado de usuarios autorizados.',
      rejectTarget
    );
  }

  const payload = {
    token: Utilities.getUuid(),
    email: email,
    exp: Date.now() + 3600 * 1000,
    oauthToken: oauthToken,
    role: roleInfo.role,
    allowedUuaas: roleInfo.allowedUuaas,
    allowedSources: roleInfo.allowedSources || [],
    readableSources: roleInfo.readableSources || [],
    championSources: roleInfo.championSources || [],
    stewardSources: roleInfo.stewardSources || [],
    userSources: roleInfo.userSources || [],
    externalUserSources: roleInfo.externalUserSources || [],
    allowedSourceIds: roleInfo.allowedSourceIds || [],
    readableSourceIds: roleInfo.readableSourceIds || [],
    championSourceIds: roleInfo.championSourceIds || [],
    stewardSourceIds: roleInfo.stewardSourceIds || [],
    userSourceIds: roleInfo.userSourceIds || [],
    externalUserSourceIds: roleInfo.externalUserSourceIds || [],
    sourcesSinSid: roleInfo.sourcesSinSid || [],
    userType: roleInfo.userType || '',
    isAdmin: roleInfo.isAdmin === true,
    avisoArbol: roleInfo.avisoArbol || '',
    state: state,
  };

  const json = JSON.stringify(payload);
  // UTF-8 explícito: sin el charset, base64Encode usa ASCII por defecto y los
  // nombres de caja con tilde (col E/F) se corrompen — "Gestión" → "Gesti?n" —
  // y luego no matchean el registro (sid→name). Ver crossSourceAccess.
  const dataB64 = Utilities.base64Encode(json, Utilities.Charset.UTF_8);
  const target = 'vscode://' + extId + '/auth?data=' + encodeURIComponent(dataB64);

  return redirectPage_(target, email, roleInfo);
}

// ── HTML helpers ─────────────────────────────────────────────────────────────

function escapeHtml_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Corporate styles (shared) ────────────────────────────────────────────────

function corporateStyles_() {
  return '' +
    // Los tres colores de marca son EXACTAMENTE las paradas del gradiente de
    // `resources/kdd-bbva.svg`. Eran casi-aciertos (#EC683E / #217BEE / #D13B5F)
    // y el separador `.divider` cae justo debajo del logo, así que la diferencia
    // se veía en el borde de una pieza contra la otra. Si tocas el asset, mueve
    // también estos tres y los rgba() derivados de más abajo.
    ':root {' +
    '  --nfq-dark: #100D25;' +
    '  --nfq-orange: #F0653B;' +
    '  --nfq-blue: #2E77EE;' +
    '  --nfq-pink: #D22C5C;' +
    '  --nfq-grey: #595959;' +
    '  --nfq-light-grey: #F5F5F5;' +
    '  --nfq-white: #FFFFFF;' +
    '}' +
    '* { margin: 0; padding: 0; box-sizing: border-box; }' +
    'body {' +
    '  font-family: Arial, Helvetica, sans-serif;' +
    '  background: var(--nfq-dark);' +
    '  color: var(--nfq-white);' +
    '  min-height: 100vh;' +
    '  display: flex;' +
    '  align-items: center;' +
    '  justify-content: center;' +
    '}' +
    '.card {' +
    '  max-width: 480px;' +
    '  width: 100%;' +
    '  padding: 2.5rem;' +
    '  text-align: center;' +
    '}' +
    // max-width: el lockup es apaisado (viewBox 567x100 → 283,5px de ancho a
    // 50px de alto) y la card solo deja 400px útiles; sobra en escritorio, pero
    // no en un viewport estrecho. width:auto conserva la proporción al recortarse.
    '.logo-svg { height: 50px; max-width: 100%; width: auto; margin-bottom: 2rem; }' +
    '.status-icon {' +
    '  font-size: 3rem;' +
    '  margin-bottom: 1rem;' +
    '}' +
    'h1 {' +
    '  font-size: 1.5rem;' +
    '  font-weight: 700;' +
    '  margin-bottom: 0.75rem;' +
    '}' +
    '.subtitle {' +
    '  font-size: 0.95rem;' +
    '  color: rgba(255,255,255,0.5);' +
    '  line-height: 1.6;' +
    '  margin-bottom: 1.5rem;' +
    '}' +
    '.badge {' +
    '  display: inline-block;' +
    '  padding: 0.35rem 1rem;' +
    '  border-radius: 20px;' +
    '  font-size: 0.8rem;' +
    '  font-weight: 700;' +
    '  letter-spacing: 0.5px;' +
    '  text-transform: uppercase;' +
    '  margin: 0.25rem;' +
    '}' +
    // rgba() derivados de --nfq-blue (#2E77EE = 46,119,238). CSS no sabe darle
    // alfa a una var() sin color-mix, y color-mix es demasiado nuevo para las
    // máquinas del cliente: se escriben los canales a mano.
    '.badge-role {' +
    '  background: rgba(46,119,238,0.15);' +
    '  color: var(--nfq-blue);' +
    '  border: 1px solid rgba(46,119,238,0.3);' +
    '}' +
    // Derivados de --nfq-orange (#F0653B = 240,101,59).
    '.badge-uuaa {' +
    '  background: rgba(240,101,59,0.12);' +
    '  color: var(--nfq-orange);' +
    '  border: 1px solid rgba(240,101,59,0.25);' +
    '}' +
    '.info-row {' +
    '  display: flex;' +
    '  flex-wrap: wrap;' +
    '  justify-content: center;' +
    '  gap: 0.5rem;' +
    '  margin: 1rem 0 1.5rem;' +
    '}' +
    '.email-text {' +
    '  font-size: 1rem;' +
    '  font-weight: 600;' +
    '  color: var(--nfq-white);' +
    '  margin-bottom: 0.5rem;' +
    '}' +
    '.redirect-text {' +
    '  font-size: 0.9rem;' +
    '  color: rgba(255,255,255,0.4);' +
    '  margin-top: 1.5rem;' +
    '}' +
    '.link {' +
    '  color: var(--nfq-orange);' +
    '  text-decoration: none;' +
    '  font-weight: 600;' +
    '}' +
    '.link:hover { text-decoration: underline; }' +
    '.spinner {' +
    '  display: inline-block;' +
    '  width: 18px; height: 18px;' +
    '  border: 2px solid rgba(255,255,255,0.15);' +
    '  border-top-color: var(--nfq-orange);' +
    '  border-radius: 50%;' +
    '  animation: spin 0.8s linear infinite;' +
    '  vertical-align: middle;' +
    '  margin-right: 0.5rem;' +
    '}' +
    '@keyframes spin { to { transform: rotate(360deg); } }' +
    // Derivados de --nfq-pink (#D22C5C = 210,44,92).
    '.warning {' +
    '  font-size: 0.75rem;' +
    '  color: var(--nfq-pink);' +
    '  margin-top: 1rem;' +
    '  padding: 0.5rem 1rem;' +
    '  background: rgba(210,44,92,0.1);' +
    '  border-radius: 6px;' +
    '  border: 1px solid rgba(210,44,92,0.2);' +
    '}' +
    '.divider {' +
    '  height: 3px;' +
    '  background: linear-gradient(90deg, var(--nfq-orange), var(--nfq-pink), var(--nfq-blue));' +
    '  border-radius: 2px;' +
    '  margin: 1.5rem 0;' +
    '}' +
    '.hint {' +
    '  font-size: 0.75rem;' +
    '  color: rgba(255,255,255,0.25);' +
    '  margin-top: 2rem;' +
    '}';
}

function nfqLogoSvg_() {
  // Lockup KDD Studio: la FICHA de la marca + el wordmark exterior. Es lo que ve
  // el cliente al volver del login, así que tiene que ser la marca del producto.
  //
  // FUENTE DE VERDAD: `resources/kdd-bbva.svg`. El webview ya no dibuja nada a
  // mano — carga ese fichero (`__KDD_BRAND_ICON_URI__` → `.logo-tile`, #329).
  // Aquí NO se puede: Apps Script no lee ficheros del bundle del plugin, así que
  // esta es la única réplica que queda y hay que moverla A MANO cuando el asset
  // cambie. `src/webview/__tests__/brandAsset.test.ts` afirma que sigue aquí para
  // que el barrido que prohíbe réplicas en el webview no acabe borrando esta.
  //
  // GEOMETRÍA — el asset vive en un lienzo de 256 y la ficha de aquí en uno de
  // 100, así que todo va multiplicado por 100/256 = 0,390625:
  //   rx 60 → 23,4 · estrella centrada en (128,100) → (50, 39.06), 84 de ancho →
  //   32,8 (el path base mide 10,4, de ahí scale(3.154)) · texto y 196 → 76.56,
  //   font-size 56 → 21,88, textLength 120 → 46,88.
  // El `textLength` NO es opcional: `Archivo` no está instalada en las máquinas
  // del equipo y la fuente resuelta acaba siendo Arial, que con las mismas 3
  // letras da otro ancho. Con él, la composición es la misma resuelva lo que
  // resuelva.
  //
  // El "KDD" de dentro y el "KDD Studio" de al lado dicen lo mismo a propósito:
  // es el icono de la extensión tal cual, sin variante recortada. A `height:50px`
  // el interior sale a ~11px y se lee (en el header del plugin, a 25px, no — por
  // eso allí la ficha va sola y el nombre lo pone el HTML de al lado).
  //
  // La card del GAS es SIEMPRE fondo oscuro (`--nfq-dark`), así que estrella,
  // wordmark interior y exterior van en blanco fijo; el webview los resuelve por
  // tema. El gradiente va y1=1 → y2=0 (abajo-izquierda → arriba-derecha), NO
  // 0→1: invertido sale espejado respecto al icono real.
  return '' +
    '<svg class="logo-svg" viewBox="0 0 567 100" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="KDD Studio">' +
    '  <defs>' +
    '    <linearGradient id="lbTile" x1="0" y1="1" x2="1" y2="0">' +
    '      <stop offset="0" stop-color="#F0653B"/><stop offset=".15" stop-color="#F0653B"/><stop offset=".5" stop-color="#D22C5C"/><stop offset=".85" stop-color="#2E77EE"/><stop offset="1" stop-color="#2E77EE"/>' +
    '    </linearGradient>' +
    '  </defs>' +
    '  <rect x="0" y="0" width="100" height="100" rx="23.4" fill="url(#lbTile)"/>' +
    '  <g transform="translate(50,39.06) scale(3.154) translate(-6,-6)"><path d="M6 .8 7.24 4.76 11.2 6 7.24 7.24 6 11.2 4.76 7.24 .8 6 4.76 4.76Z" fill="#fff"/></g>' +
    '  <text x="50" y="76.56" text-anchor="middle" font-family="Archivo, Arial, Helvetica, sans-serif" font-weight="800" font-size="21.88" textLength="46.88" lengthAdjust="spacingAndGlyphs" fill="#fff">KDD</text>' +
    '  <text x="129" y="76.5" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="74" textLength="438" lengthAdjust="spacingAndGlyphs" fill="#fff">KDD Studio</text>' +
    '</svg>';
}

// ── Redirect page (success) ──────────────────────────────────────────────────

function redirectPage_(target, email, roleInfo) {
  const targetJsSafe = target.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

  var uuaaBadges = '';
  if (roleInfo.allowedUuaas && roleInfo.allowedUuaas.length > 0) {
    roleInfo.allowedUuaas.forEach(function(u) {
      uuaaBadges += '<span class="badge badge-uuaa">' + escapeHtml_(u) + '</span>';
    });
  }

  var warning = roleInfo.warning
    ? '<div class="warning">⚠ ' + escapeHtml_(roleInfo.warning) + '</div>'
    : '';

  var html =
    '<!DOCTYPE html>' +
    '<html lang="es"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    // Los DOS títulos hacen falta: en una web app de HtmlService el HTML se sirve
    // dentro de un iframe sandbox, así que este <title> NO llega a la pestaña —
    // el de la pestaña lo fija `setTitle()` de abajo. Cambiar solo uno deja la
    // marca vieja en el sitio más visible o en el que ven los buscadores.
    '<title>KDD Studio — Autorización</title>' +
    '<style>' + corporateStyles_() + '</style>' +
    '</head><body>' +
    '<div class="card">' +
      nfqLogoSvg_() +
      '<div class="divider"></div>' +
      '<div class="status-icon">✓</div>' +
      '<h1>Sesión iniciada</h1>' +
      '<p class="email-text">' + escapeHtml_(email) + '</p>' +
      '<div class="info-row">' +
        '<span class="badge badge-role">' + escapeHtml_(roleInfo.role) + '</span>' +
        uuaaBadges +
      '</div>' +
      '<p class="redirect-text"><span class="spinner"></span>Redirigiendo a VS Code…</p>' +
      '<p class="redirect-text" style="margin-top:0.75rem;">Si no se abre automáticamente, ' +
        '<a class="link" id="manual" href="' + escapeHtml_(target) + '">pulsa aquí</a>.</p>' +
      warning +
      '<p class="hint">Knowledge-Driven Development Studio</p>' +
    '</div>' +
    '<script>' +
    'setTimeout(function(){' +
      'window.location.href="' + targetJsSafe + '";' +
      'setTimeout(function(){' +
        'try{window.close();}catch(e){}' +
        'document.querySelector(".status-icon").textContent="✓";' +
        'document.querySelector("h1").textContent="Listo — puedes cerrar esta pestaña";' +
        'document.querySelector(".redirect-text").style.display="none";' +
        'var sp=document.querySelectorAll(".redirect-text");for(var i=0;i<sp.length;i++)sp[i].style.display="none";' +
      '},1500);' +
    '},800);' +
    '<\/script>' +
    '</body></html>';

  return HtmlService.createHtmlOutput(html)
    .setTitle('KDD Studio — Autorización')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

// ── Error page ───────────────────────────────────────────────────────────────

// Texto de cada scope del manifest tal como lo enseña la pantalla de Google,
// para que el usuario sepa QUÉ casilla le falta. Solo es la etiqueta: si se
// añade un scope al manifest y no aquí, la comprobación lo sigue exigiendo
// (la decide `getAuthorizationStatus`) y la página cae al texto genérico.
var PERMISOS_LOGIN_ = {
  'https://www.googleapis.com/auth/drive': 'Ver, editar, crear y eliminar todos tus archivos de Google Drive',
  'https://www.googleapis.com/auth/spreadsheets': 'Ver, editar, crear y eliminar tus hojas de cálculo de Google',
  'https://www.googleapis.com/auth/userinfo.email': 'Ver la dirección de correo electrónico de tu cuenta de Google',
  'https://www.googleapis.com/auth/script.external_request': 'Conectarse a un servicio externo',
  'https://www.googleapis.com/auth/script.scriptapp': 'Permitir que esta aplicación se ejecute cuando no estés presente',
};

/**
 * `null` si el usuario tiene concedidos todos los scopes del manifest (o si no
 * se puede saber); si no, `{ url, faltan }` — la URL de autorización de Google
 * y las etiquetas de lo que falta (vacía si Google no dice qué hay concedido).
 *
 * Ante la duda devuelve `null`: esto solo mejora el mensaje, y bloquear un
 * login sano porque la API de autorización lance sería peor que el problema.
 */
function permisosFaltantes_() {
  try {
    var info = ScriptApp.getAuthorizationInfo(ScriptApp.AuthMode.FULL);
    if (info.getAuthorizationStatus() !== ScriptApp.AuthorizationStatus.REQUIRED) { return null; }
    var faltan = [];
    try {
      var concedidos = {};
      (info.getAuthorizedScopes() || []).forEach(function (s) { concedidos[s] = true; });
      Object.keys(PERMISOS_LOGIN_).forEach(function (s) {
        if (!concedidos[s]) { faltan.push(PERMISOS_LOGIN_[s]); }
      });
    } catch (eScopes) { faltan = []; }
    var url = '';
    try { url = info.getAuthorizationUrl() || ''; } catch (eUrl) { url = ''; }
    var quien = '';
    try { quien = Session.getActiveUser().getEmail() || ''; } catch (eSes) { quien = ''; }
    Logger.log('permisosFaltantes_: ' + (quien || '(email no concedido)') + ' — faltan ' +
      (faltan.length ? faltan.join(' · ') : '(Google no dice cuáles)'));
    return { url: url, faltan: faltan };
  } catch (err) {
    Logger.log('permisosFaltantes_: no se pudo comprobar — ' + (err && err.message ? err.message : String(err)));
    return null;
  }
}

function permisosPage_(info) {
  var lista = info.faltan.length
    ? '<ul class="detail" style="text-align:left;display:inline-block;margin:0.5rem 0;">' +
        info.faltan.map(function (f) { return '<li>' + escapeHtml_(f) + '</li>'; }).join('') + '</ul>'
    : '';
  // target=_blank: esta página va dentro del iframe de HtmlService y la
  // pantalla de Google no se deja cargar en un iframe.
  var boton = info.url
    ? '<p style="margin-top:1.5rem;"><a class="link" target="_blank" rel="noopener" href="' + escapeHtml_(info.url) + '">' +
        '<strong>Conceder los permisos que faltan</strong></a></p>'
    : '<p class="detail">Entra en <strong>myaccount.google.com/connections</strong>, quita el acceso de KDD Studio ' +
        'y vuelve a iniciar sesión desde el plugin.</p>';
  var html =
    '<!DOCTYPE html>' +
    '<html lang="es"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<title>KDD Studio — Faltan permisos</title>' +
    '<style>' + corporateStyles_() +
    ' .status-icon { color: var(--nfq-pink); }' +
    ' .detail { font-size: 0.9rem; color: rgba(255,255,255,0.55); line-height: 1.7; }' +
    ' .detail strong { color: var(--nfq-white); }' +
    '</style>' +
    '</head><body>' +
    '<div class="card">' +
      nfqLogoSvg_() +
      '<div class="divider"></div>' +
      '<div class="status-icon">⚠</div>' +
      '<h1>Faltan permisos de Google</h1>' +
      '<p class="detail">Cuando autorizaste KDD Studio no se concedieron todos los permisos' +
        (lista ? '. Faltan:' : ', y sin ellos no se puede comprobar tu acceso.') + '</p>' +
      lista +
      boton +
      '<p class="detail">En la pantalla de Google marca <strong>Seleccionar todo</strong> y después ' +
        'vuelve a iniciar sesión desde el plugin.</p>' +
      '<p class="hint">Knowledge-Driven Development Studio</p>' +
    '</div>' +
    '</body></html>';
  return HtmlService.createHtmlOutput(html).setTitle('KDD Studio — Faltan permisos');
}

function errorPage_(title, detail, callbackUrl) {
  var callbackScript = '';
  if (callbackUrl) {
    var safeUrl = callbackUrl.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    callbackScript =
      '<script>' +
      'setTimeout(function(){window.location.href="' + safeUrl + '";},1200);' +
      '<\/script>';
  }

  var html =
    '<!DOCTYPE html>' +
    '<html lang="es"><head><meta charset="utf-8"/>' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>' +
    '<title>KDD Studio — Error</title>' + // el de la pestaña es el setTitle_ del final
    '<style>' + corporateStyles_() +
    ' .status-icon { color: var(--nfq-pink); }' +
    ' .detail { font-size: 0.9rem; color: rgba(255,255,255,0.55); line-height: 1.7; }' +
    ' .detail strong { color: var(--nfq-white); }' +
    '</style>' +
    '</head><body>' +
    '<div class="card">' +
      nfqLogoSvg_() +
      '<div class="divider"></div>' +
      '<div class="status-icon">✗</div>' +
      '<h1>' + escapeHtml_(title) + '</h1>' +
      '<p class="detail">' + detail + '</p>' +
      '<p class="hint" style="margin-top:2.5rem;">Cierra esta pestaña y vuelve a intentarlo desde el plugin.</p>' +
      '<p class="hint">Knowledge-Driven Development Studio</p>' +
    '</div>' +
    callbackScript +
    '</body></html>';

  return HtmlService.createHtmlOutput(html).setTitle('KDD Studio — Error');
}

// ── Admin test helper ────────────────────────────────────────────────────────

function testConfig() {
  const cfg = getConfig_();
  Logger.log('Config: ' + JSON.stringify(cfg, null, 2));

  const email = Session.getActiveUser().getEmail();
  Logger.log('Active user email: ' + email);

  const roleInfo = lookupRole_(email);
  Logger.log('Role info: ' + JSON.stringify(roleInfo, null, 2));

  const oauthToken = tokenDelUsuario_();
  Logger.log('OAuth token acquired: ' + (oauthToken ? '(len=' + oauthToken.length + ')' : 'NO'));
}


// ════════════════════════════════════════════════════════════════════════════
//  SOURCE REGISTRY (modelo Source — S-ID) — asignación LAZY del S-ID
// ════════════════════════════════════════════════════════════════════════════
//
// El árbol de cajas vive en un tab del Excel de Roles, que solo abre ConfigData
// (ver gas/ConfigData.gs). Cuando un usuario abre una caja por primera vez,
// ConfigData la localiza, le asigna max(S-ID)+1 de forma atómica y escribe la
// fila; devuelve el S-ID y las filas del árbol.
//
// Lo que pasa AQUÍ es todo lo que toca Drive, con el token del usuario: se
// regenera sources-registry.json (cache que el plugin LEE con ?action=sources)
// y se materializa la carpeta plana de la caja con su ACL.

var TREE_SHEET_DEFAULT = 'Arbol-BBVA';









function resolveSource_(payload) {
  var res = relayConfigData_('resolveSid', {
    token: (payload && payload.token) || '',
    name: (payload && payload.name) || '',
    areaPath: (payload && payload.areaPath) || '',
  });
  if (!res || res.ok !== true) {
    return jsonResponse_({ ok: false, error: (res && res.error) || 'resolveSource: ConfigData no respondió' });
  }
  // El S-ID ya está asignado y el registro de cajas ya lo reescribió ConfigData
  // (es un cache derivado del árbol, y lo escribe quien corre como PROPIETARIO:
  // hacerlo aquí exigía que el usuario tuviera escritura en KDD_Studio_metadata,
  // y esa carpeta deja de estar compartida — se habría congelado, #279·#5).
  //
  // Lo que queda aquí es lo que toca DRIVE, con el token del USUARIO, para que
  // la carpeta de la caja conste creada por quien la abrió.
  // Cronometrado, y no es un adorno: esto corre DESPUES del relay, en esta mitad
  // y con el token del usuario, y no es poco trabajo — recorre la raiz plana
  // buscando la carpeta de la caja (667 hijos en BBVA) y le aplica la ACL.
  //
  // Sin medirlo, su coste aterriza entero en el hueco que el plugin calcula como
  // "lo que el cliente ve de mas que el relay" y rotula como RED + PROXY
  // CORPORATIVO. O sea que el desglose que se acaba de añadir mandaria a
  // investigar el proxy de BBVA por trabajo que hacemos aqui — el mismo fallo
  // por omision que este cambio vino a corregir, por la puerta de al lado.
  //
  // Va colgado de _perf y no de _cfg porque _cfg es de ConfigData; esto es
  // tiempo de ESTA mitad. handleTree_ no lo necesita: alli no queda nada
  // despues del relay.
  //
  // (Sin comillas invertidas en los comentarios de este bloque: el cuerpo entero
  // viaja dentro de una plantilla del generador delimitada por ellas.)
  var tLocal = Date.now();
  ensureFlatBoxFolder_(res.sid, res.name || (payload && payload.name) || '');
  var localMs = Date.now() - tLocal;
  var out = { ok: true, sid: res.sid, existing: res.existing === true };
  // El desglose del relay (_perf) y el de las etapas de ConfigData (_cfg) llegan
  // DENTRO de la respuesta del relay, y aqui se construye una respuesta NUEVA:
  // sin copiarlos, abrir una caja llega al log del plugin sin una sola cifra.
  // Medido en NFQ el 2026-08-27: 23,3 s, la espera mas larga de toda la sesion,
  // y sin forma de saber si eran ConfigData, el buzon o el proxy corporativo —
  // que son tres arreglos distintos. Mismo eco que grant y revoke.
  // Es metadato, no contrato: quien no lo conozca lo ignora.
  if (res._perf) { out._perf = res._perf; out._perf.localMs = localMs; }
  if (res._cfg) { out._cfg = res._cfg; }
  return jsonResponse_(out);
}

// ── Gate de LECTURA del árbol (#250·#9 · #292 · #365) ───────────────────────
//
// NO vive aquí. `tree` llega YA RECORTADO de ConfigData y `sources` sale de
// `metaRead`, que filtra el registro con el mismo criterio. El recorte es por
// IDENTIDAD (S-ID) desde #365, y el nombre solo decide en las celdas que aún
// no se han migrado. No lo repliques en esta mitad: sería un segundo criterio
// que divergiría en silencio del que de verdad autoriza.



function handleSources_(params) {
  var res = relayConfigData_('metaRead', { folder: '', name: 'sources-registry.json' });
  if (!res || res.ok !== true) {
    return jsonResponse_({ ok: false, error: (res && res.error) || 'No se pudo leer el registro de cajas' });
  }
  if (res.found !== true) { return jsonResponse_({ ok: true, version: 2, sources: [] }); }
  try {
    var reg = JSON.parse(res.content);
    return jsonResponse_({ ok: true, version: reg.version || 2, sources: reg.sources || [] });
  } catch (err) {
    return jsonResponse_({ ok: false, error: 'Registro de cajas ilegible: ' + (err && err.message ? err.message : String(err)) });
  }
}

function handleTree_(params) {
  // ConfigData ya devuelve el árbol RECORTADO a las cajas legibles del
  // llamante: el recorte no depende ni del plugin ni de este deployment.
  var res = relayConfigData_('tree', {});
  if (!res || res.ok !== true) {
    return jsonResponse_({ ok: false, error: (res && res.error) || 'No se pudo leer el árbol' });
  }
  var out = { ok: true, version: res.version || 2, boxes: res.boxes || [] };
  // Mismo eco de metadatos que en resolveSource_ — ver el comentario de alli.
  // Aqui la cifra que faltaba eran los 7,1 s del arbol en el arranque, tambien
  // sin desglose y tambien en el camino que recorre todo el mundo al entrar.
  if (res._perf) { out._perf = res._perf; }
  if (res._cfg) { out._cfg = res._cfg; }
  return jsonResponse_(out);
}

// Regeneración manual del registro (Run desde el editor). La hace ConfigData,
// que es quien escribe esa carpeta desde #279·#5. Admin-only allí.
function rebuildRegistryFromTree_() {
  var res = relayConfigData_('rebuildRegistry', {});
  if (!res || res.ok !== true) {
    Logger.log('rebuildRegistryFromTree_: ' + ((res && res.error) || 'ConfigData no respondió'));
    return;
  }
  Logger.log('Registry regenerado: ' + res.withSid + ' cajas con S-ID de ' + res.total + ' totales.');
}

// ── Carpeta plana de la caja (layout post-cutover) ───────────────────────────
//
// Post-cutover, cada caja vive en <FLAT_ROOT_ID>/S###_<nombre>/ (FLAT_ROOT_ID =
// Script Property con la carpeta padre plana). Un usuario normal NO puede crear
// carpetas en esa raíz, así que el GAS (que corre como el admin propietario)
// CREA la carpeta al resolver el S-ID y la COMPARTE según el Sheet de Roles.
// ACL ADD-ONLY: solo añade editores/lectores — nunca quita permisos ni toca al
// owner. TODO el bloque es defensivo: cualquier fallo se loguea y NO rompe el
// resolveSource (la asignación de S-ID es lo crítico).

// ════════════════════════════════════════════════════════════════════════════
//  #359 — Drive v2 o v3, pero NUNCA "no supe leerlo" = "no hay nada"
// ════════════════════════════════════════════════════════════════════════════
//
// El 2026-08-07 el manifiesto del EDITOR pasó el servicio avanzado de Drive a
// v3 —donde la lista se llama files/permissions y no items, y el nombre de un
// fichero es name y no title— mientras el repositorio seguía declarando v2. El
// patrón que había en los tres lectores,
//
//     var items = (resp && resp.items) || [];
//
// convirtió "no sé leer esto" en "no hay nada" SIN LANZAR: diecisiete días sin
// un solo error en el log, CERO caminos capaces de retirar un acceso, 92 ítems
// atascados y 64 personas sin el acceso que el Excel les concede. Es la tercera
// vez que este proyecto paga la misma lección (#312 "no pude mirar" no es "no
// existe", #320 rápido vs tardío, #322 respuesta perdida no es negativa), ahora
// en la capa de deserialización.
//
// ACEPTA LAS DOS VERSIONES A PROPÓSITO: el manifiesto vuelve a decir v2 y no
// sabemos cuándo Google la retirará del todo. Lo inaceptable no es una versión u
// otra — es el silencio.
//
// OJO AL NOMBRE: el gemelo de estas dos funciones para sync-drive-permissions.gs
// se llama flatDriveLista_ , con OTRO nombre, porque los tres .gs comparten
// espacio global y el chequeo de colisiones de scripts/gas-invariants.js prohíbe
// declarar el mismo símbolo dos veces. No unifiques los nombres. Si tocas una,
// toca la otra: dos deserializadores que divergen en silencio son peor que uno.
function driveLista_(resp, campoV3) {
  if (resp && Object.prototype.toString.call(resp[campoV3]) === '[object Array]') { return resp[campoV3]; }
  if (resp && Object.prototype.toString.call(resp.items) === '[object Array]') { return resp.items; }
  throw new Error('Respuesta de Drive no reconocida: sin \'' + campoV3 + '\' (v3) ni \'items\' (v2). ' +
    'Claves recibidas: ' + (resp ? Object.keys(resp).join(',') : '(null)') +
    '. Leerlo como lista vacia es el bug #359.');
}

// El nombre de un elemento de Drive: name en v3, title en v2. LANZA si no hay
// ninguno — una carpeta SIEMPRE tiene nombre, así que "" solo puede significar
// que no supimos leer la respuesta, y ahí es donde empieza el bug de arriba.
function driveNombre_(item) {
  var n = item && (item.name || item.title);
  if (!n) {
    throw new Error('Elemento de Drive sin \'name\' (v3) ni \'title\' (v2) — #359. Claves: ' +
      (item ? Object.keys(item).join(',') : '(null)'));
  }
  return String(n);
}

// Normaliza un nombre de caja para el match ACL: NFD + sin diacríticos +
// minúsculas + trim. Espejo del normalizeSourceName del plugin (col E/F del
// Sheet ↔ nombre del árbol, tolerante a acentos/forma Unicode).
function normBoxName_(s) {
  var str = String(s || '');
  try { str = str.normalize('NFD'); } catch (e) { /* runtime sin normalize */ }
  return str.replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}


// shareNoEmail_: comparte una carpeta SIN mandar el correo de notificación de
// Drive. DriveApp.addEditor/addViewer SIEMPRE notifican; el servicio avanzado
// Drive (v2) permite sendNotificationEmails:false. role = 'writer' | 'reader'.
// Requiere el servicio avanzado "Drive" habilitado en appsscript.json.
function shareNoEmail_(folder, email, role) {
  Drive.Permissions.insert(
    { role: role, type: 'user', value: email },
    folder.getId(),
    { sendNotificationEmails: false }
  );
}

// Subcarpetas donde un KB Contributor SÍ escribe (#279·#3). Fuera de estas,
// solo lee — en particular `specs/` (knowledge + governance) y
// `docs-tecnicos/`, que es lo que hasta ahora podía destrozar porque el límite
// al eje Work lo ponía únicamente el plugin.
//
// La lista sale de rastrear TODOS los caminos de escritura de la caja
// (`uploadSpecToSource` → `specs/work/…` · `uploadCatalogFileToSource` →
// `_catalog` · `uploadMetadataFileToSource` → `_metadata` ·
// `uploadUserChatFileToSource` → `_user-chats`). Si añades un flujo que
// escriba en la caja, mira si un contributor lo dispara: si sí y no está aquí,
// su push falla con un 403 que NO se parece en nada a un problema de permisos.
//
// `sync-drive-permissions.gs` usa esta misma constante — viven en el mismo
// proyecto de Apps Script, así que hay una sola lista y no dos que divergen.
var KDD_WORK_EDITOR_SUBFOLDERS_ = ['specs/work', '_catalog', '_metadata', '_user-chats'];

// Asegura una subcarpeta (crea los tramos que falten) y la comparte. Hace falta
// CREARLAS: no se puede compartir lo que no existe, y el contributor —lector de
// la caja— no podría crearlas él en su primer push.
// Devuelve cuantos repartos FALLARON: el sello del autorreparador (ver
// ensureFlatBoxFolder_) solo se estampa con cero.
function shareWorkSubfolders_(boxFolder, emails) {
  var fallos = 0;
  if (!emails || emails.length === 0) { return fallos; }
  for (var s = 0; s < KDD_WORK_EDITOR_SUBFOLDERS_.length; s++) {
    var segs = KDD_WORK_EDITOR_SUBFOLDERS_[s].split('/');
    var cur = boxFolder;
    try {
      for (var p = 0; p < segs.length; p++) {
        var it = cur.getFoldersByName(segs[p]);
        cur = it.hasNext() ? it.next() : cur.createFolder(segs[p]);
      }
    } catch (eMk) {
      fallos++;
      Logger.log('shareWorkSubfolders_: no se pudo asegurar "' + KDD_WORK_EDITOR_SUBFOLDERS_[s] + '" en "' + boxFolder.getName() + '" — ' + (eMk && eMk.message ? eMk.message : String(eMk)));
      continue;
    }
    for (var e = 0; e < emails.length; e++) {
      try { shareNoEmail_(cur, emails[e], 'writer'); }
      catch (eSh) {
        fallos++;
        Logger.log('shareWorkSubfolders_: editor(' + emails[e] + ') en "' + KDD_WORK_EDITOR_SUBFOLDERS_[s] + '" falló — ' + (eSh && eSh.message ? eSh.message : String(eSh)));
      }
    }
  }
  return fallos;
}

// La ACL que la caja DEBERIA tener, segun el Sheet. Quién debe ser editor/lector
// sale del Sheet, y el Sheet solo lo abre ConfigData; aplicarlo sigue siendo
// cosa de aqui, con el token del usuario (applyFlatBoxAcl_). Un usuario sin
// potestad sobre la caja recibe {ok:false} — sin permiso para compartir la
// carpeta, sus intentos fallaban uno a uno igualmente. `infra` viaja tal cual
// desde el gate (#417): es lo que separa "no tienes potestad" de "no he podido
// mirar", y el sello del autorreparador decide con ello.
// Con el S-ID, o en una caja HOMÓNIMA el censo se resuelve por nombre y deja
// fuera a los ya migrados (#365) — o sea: se aplicaría la ACL de la caja sin
// ellos, que es retirarles el acceso que acaban de recibir.
function flatBoxAclEsperada_(boxName, sid) {
  var res = relayConfigData_('boxAcl', { boxName: boxName, sid: sid || '' });
  if (!res || res.ok !== true) {
    Logger.log('flatBoxAclEsperada_: sin ACL para "' + boxName + '" — skip (' + ((res && res.error) || 'sin respuesta') + ')');
    // `retriable` cuenta como INFRA aunque no venga `infra`: ese campo lo nace
    // ConfigData (#417) y no llega cuando el que falla es el salto del relay —
    // el 404 del buzón en frío, un 5xx, una cadena de redirects agotada. Sin
    // esto, dos hipos seguidos del buzón sellaban 6 h una caja cuya ACL no se
    // había mirado, que es justo lo que el sello se niega a hacer.
    var transitorio = !!(res && (res.infra === true || res.retriable === true));
    return { ok: false, infra: transitorio, error: (res && res.error) || 'sin respuesta' };
  }
  return { ok: true, editors: res.editors || [], workEditors: res.workEditors || [], viewers: res.viewers || [] };
}

// Aplica `acl` (la de flatBoxAclEsperada_) sobre la carpeta. Devuelve true solo
// si NINGUN reparto fallo: es lo que autoriza el sello de 6 h.
function applyFlatBoxAcl_(folder, boxName, acl) {
  if (!acl || acl.ok !== true) { return false; }
  var fallos = 0;
  var editors = acl.editors || [];
  var workEditors = acl.workEditors || [];
  var viewers = acl.viewers || [];
  var ownerEmail = '';
  try { ownerEmail = String(folder.getOwner().getEmail() || '').toLowerCase().trim(); }
  catch (e) { /* sin owner legible — seguimos, los add fallarán inofensivos */ }
  for (var j = 0; j < editors.length; j++) {
    if (editors[j] === ownerEmail) { continue; }
    try { shareNoEmail_(folder, editors[j], 'writer'); }
    catch (e1) {
      fallos++;
      Logger.log('applyFlatBoxAcl_: addEditor(' + editors[j] + ') falló — ' + (e1 && e1.message ? e1.message : String(e1)));
    }
  }
  // El contributor es LECTOR de la caja y editor solo de las subcarpetas del
  // eje Work. Los lectores van juntos: para Drive, ambos son 'reader' aquí.
  var readers = viewers.concat(workEditors);
  for (var k = 0; k < readers.length; k++) {
    if (readers[k] === ownerEmail) { continue; }
    try { shareNoEmail_(folder, readers[k], 'reader'); }
    catch (e2) {
      fallos++;
      Logger.log('applyFlatBoxAcl_: addViewer(' + readers[k] + ') falló — ' + (e2 && e2.message ? e2.message : String(e2)));
    }
  }
  fallos += shareWorkSubfolders_(folder, workEditors);
  return fallos === 0;
}

// ── Sello del autorreparador de abrir caja (2026-08-27, "menos viajes" · B) ──
//
// ensureFlatBoxFolder_ corria ENTERO en cada apertura de caja, hubiera cambiado
// algo o no: una segunda ejecucion privilegiada para pedir el censo (boxAcl), el
// listado de la raiz plana (667 hijos en BBVA), permisos persona a persona y
// cuatro subcarpetas. Medido en NFQ: 10,6 s de los 23 de abrir caja. El reparto
// de permisos ya tiene dueno —la cola de ACL que drena el propietario cada
// 10 min y el sync completo—, asi que esto es una RED, y una red no necesita
// correr cada vez.
//
// Sello por USUARIO y CAJA en el almacen por usuario del proyecto: bajo
// executeAs USER_ACCESSING, getUserProperties() es el del que abre, asi que ni
// se comparte entre usuarios ni lo ve nadie mas. Se estampa SOLO tras un pase
// que termino sin ningun fallo (o cuando este usuario no tiene potestad y por
// tanto nada que reparar): un pase a medias no cuenta como reparado.
//
// Trade-off asumido: una divergencia real de permisos tarda hasta 6 h en
// repararse POR ESTE camino; cola y sync la reparan por el suyo igual que
// antes. Y con el sello vigente no se mira Drive: si alguien BORRA la carpeta
// de la caja, este camino no la recrea hasta que caduque — la materializa el
// drenaje al siguiente alta/baja, o el sync completo.
var FLAT_HEAL_TTL_MS_ = 6 * 60 * 60 * 1000;
var FLAT_HEAL_KEY_PREFIJO_ = 'flatheal:';

function flatHealSelloVigente_(sid) {
  try {
    var crudo = PropertiesService.getUserProperties().getProperty(FLAT_HEAL_KEY_PREFIJO_ + sid);
    if (!crudo) { return false; }
    var t = Number(crudo);
    if (!isFinite(t) || t <= 0) { return false; }
    var delta = Date.now() - t;
    // Un sello del FUTURO es un reloj torcido: no vale. Mismo margen de 60 s que
    // cfgFastPathFresco_ para el desfase entre ejecuciones.
    return delta > -60000 && delta < FLAT_HEAL_TTL_MS_;
  } catch (e) { return false; }
}

function flatHealSellar_(sid) {
  try { PropertiesService.getUserProperties().setProperty(FLAT_HEAL_KEY_PREFIJO_ + sid, String(Date.now())); }
  catch (e) { Logger.log('flatHealSellar_: no se pudo sellar ' + sid + ' — ' + (e && e.message ? e.message : String(e))); }
}

// Asegura la carpeta plana de la caja (<FLAT_ROOT_ID>/<sid>_<nombre>/) y aplica
// la ACL. FLAT_ROOT_ID vacía → no-op logueado (rollout gradual: el resolve sigue
// funcionando en el layout árbol). Idempotente: si ya existe una hija cuyo
// nombre empieza por "<sid>_" (o es exactamente "<sid>_<nombre>"), la reusa y
// solo re-aplica la ACL (add-only). NUNCA lanza.
//
// ORDEN: primero el sello, luego la ACL esperada (relay), y SOLO despues el
// listado de la raiz. Antes se listaba primero y se pedia la ACL despues, asi
// que un usuario SIN potestad (steward, contributor, consumer — la mayoria)
// pagaba el recorrido de la raiz en cada apertura para que el relay le
// contestara "no" al final. Con el relay delante, ese usuario paga un relay
// por caja cada 6 h y ni un listado.
function ensureFlatBoxFolder_(sid, name) {
  try {
    var props = PropertiesService.getScriptProperties();
    var flatRootId = props.getProperty('FLAT_ROOT_ID') || '';
    if (!flatRootId) {
      Logger.log('ensureFlatBoxFolder_: FLAT_ROOT_ID no configurada — skip (rollout gradual, layout árbol)');
      return;
    }
    var boxName = String(name || '').trim();
    var sidLimpio = String(sid || '').trim();
    if (!sidLimpio) {
      // Sin S-ID no hay identidad, y crear por nombre es lo que llena la raíz
      // plana de duplicados (58 cajas homónimas en el árbol de BBVA). Se niega
      // en vez de adivinar, igual que el materializador del drenaje.
      Logger.log('ensureFlatBoxFolder_: sin S-ID no se materializa la caja "' + boxName + '" — sin identidad no se crea por nombre.');
      return;
    }
    if (flatHealSelloVigente_(sidLimpio)) {
      Logger.log('ensureFlatBoxFolder_: sello vigente para ' + sidLimpio + ' — pase completo saltado (caduca a las 6 h).');
      return;
    }
    var acl = flatBoxAclEsperada_(boxName, sidLimpio);
    if (!acl.ok) {
      // Sin potestad no hay nada que ESTE usuario pueda reparar: se sella para
      // no volver a preguntar en 6 h. Un fallo de infraestructura (Excel o arbol
      // ilegibles, relay caido) NO se sella: eso si puede cambiar en un minuto.
      if (acl.infra !== true) { flatHealSellar_(sidLimpio); }
      return;
    }
    var prefix = sidLimpio + '_';
    var wanted = prefix + boxName;
    // Localizamos la carpeta de la caja con Drive.Files.list "'<id>' in parents"
    // (filtra por el PADRE del hijo — NO exige acceso a FLAT_ROOT), igual que
    // findFlatBoxFolders_. Antes esto hacia DriveApp.getFolderById(FLAT_ROOT)
    // .getFolders(), que bajo executeAs USER_ACCESSING FALLABA para cualquiera
    // sin acceso a la carpeta raiz (todos los usuarios normales) → el self-heal
    // de la ACL nunca corria y solo funcionaba si se daba acceso a la raiz
    // (rompiendo el aislamiento). Con la query, un editor de SU caja re-aplica su
    // ACL sin tocar la raiz; solo CREAR una caja nueva exige escritura en
    // FLAT_ROOT (solo el admin propietario) → se intenta unicamente si no existe.
    // La localización es por S-ID y SOLO por S-ID (el prefijo "S###_"), el mismo
    // criterio que usa el drenaje. Que estas dos discreparan —una por prefijo, la
    // otra exigiendo además el nombre— es lo que fabricaba el LIMBO de #359: la
    // caja S049 se llamaba "S049_TEST" y el árbol decía "Control-M", así que esta
    // la encontraba y decidía que ya existía mientras el drenaje no la reconocía
    // y sus ACLs no se aplicaban nunca. Nunca se creaba y nunca se encontraba.
    //
    // NO se para en la primera coincidencia: si hubiera DOS carpetas con este
    // S-ID, esto repartiría sobre la que Drive devolviese antes y el drenaje
    // sobre la MÁS ANTIGUA — dos caminos poniendo permisos en carpetas distintas
    // de la misma caja. Se recogen todas y se elige con el mismo criterio.
    var candidatas = [];
    var listadoLegible = true;
    try {
      var q = "'" + flatRootId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
      var pageToken = null;
      do {
        var resp = Drive.Files.list({ q: q, maxResults: 1000, pageToken: pageToken });
        var items = driveLista_(resp, 'files');
        for (var i = 0; i < items.length; i++) {
          if (driveNombre_(items[i]).indexOf(prefix) !== 0) { continue; }
          try { candidatas.push(DriveApp.getFolderById(items[i].id)); }
          catch (eOpen) { Logger.log('ensureFlatBoxFolder_: no se pudo abrir ' + items[i].id + ' — ' + (eOpen && eOpen.message ? eOpen.message : String(eOpen))); }
        }
        pageToken = resp && resp.nextPageToken;
      } while (pageToken);
    } catch (eList) {
      // "NO PUDE MIRAR" NO ES "NO EXISTE". Aquí confundirlos CREA UNA CARPETA
      // DUPLICADA, que es el peor desenlace posible de esta función: los permisos
      // repartidos entre dos carpetas, el plugin apuntando a una y el sync
      // gestionando la otra. Y no es hipotético — bajo Drive v3 este bucle no
      // veía NADA (la lista venía en 'files', no en 'items') y el createFolder de
      // abajo se ejecutaba a ciegas (#359). Ahora driveLista_ lanza, este catch lo
      // recoge y la bandera impide crear.
      listadoLegible = false;
      Logger.log('ensureFlatBoxFolder_: no se pudo listar bajo FLAT_ROOT — ' + (eList && eList.message ? eList.message : String(eList)));
    }
    var folder = null;
    if (candidatas.length === 1) {
      folder = candidatas[0];
    } else if (candidatas.length > 1) {
      candidatas.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
      folder = candidatas[0];
      var nombres = [];
      for (var n = 0; n < candidatas.length; n++) { nombres.push(candidatas[n].getName()); }
      Logger.log('🔴 DOS carpetas con S-ID ' + sidLimpio + ': ' + nombres.join(' · ') +
        '. Se usa la MAS ANTIGUA y no se toca la otra — fusionarlas o borrarlas tiene que decidirlo una persona.');
    }
    if (!folder && !listadoLegible) {
      // Sin haber podido mirar no se crea nada y no se toca la ACL: el usuario
      // reintentará al abrir la caja y el drenaje la reconcilia igual. Una espera
      // se arregla sola; una carpeta duplicada la arregla una persona a mano.
      Logger.log('ensureFlatBoxFolder_: NO se crea "' + wanted + '" porque el listado no se pudo leer — crear a ciegas duplicaria la caja (#359).');
      return;
    }
    if (!folder) {
      // No la tenemos compartida / no existe: solo un usuario con escritura en
      // FLAT_ROOT (admin propietario) puede crearla; para el resto esto lanza y
      // el catch de fuera lo traga (best-effort — la caja la materializa el admin).
      folder = DriveApp.getFolderById(flatRootId).createFolder(wanted);
      Logger.log('ensureFlatBoxFolder_: creada carpeta plana "' + wanted + '"');
    }
    // AQUÍ NO SE RENOMBRA, y no es un olvido: §4 de #359. Esta función corre con
    // el token del USUARIO que abre la caja (executeAs USER_ACCESSING) y un
    // lector no tiene escritura sobre la carpeta, así que el renombrado fallaría
    // en silencio —todo esto va envuelto en un try/catch que solo loguea— y, si
    // algún día medio funcionase, el nombre flaparía según quién abriese la caja.
    // El nombre lo alinea con el árbol SOLO el camino que corre como el
    // PROPIETARIO: el drenaje de la cola de ACL.
    var completo = applyFlatBoxAcl_(folder, boxName, acl);
    // Sello solo tras un pase ENTERO y limpio. Con DOS carpetas del mismo S-ID
    // no se sella: el aviso en rojo de arriba tiene que seguir saliendo en cada
    // apertura hasta que una persona lo resuelva — un sello lo callaria 6 h.
    if (completo === true && candidatas.length <= 1) { flatHealSellar_(sidLimpio); }
  } catch (err) {
    Logger.log('ensureFlatBoxFolder_ error (' + sid + ' / ' + name + '): ' + (err && err.message ? err.message : String(err)));
  }
}


// ════════════════════════════════════════════════════════════════════════════
//  GESTIÓN DE ACCESOS (#239 B3) — alta/baja de usuarios en cajas desde el plugin
// ════════════════════════════════════════════════════════════════════════════
//
// El Sheet de Roles es la ÚNICA fuente de verdad, y quien lo abre y aplica los
// gates es ConfigData (identidad del llamante verificada contra Google,
// potestad admin / KDD Champion de la caja, jerarquía de roles, anti
// peer-takeover, re-verificación dentro del lock y rastro de auditoría
// persistente — incluidos los intentos DENEGADOS).
//
// De estas tres acciones, aquí solo queda la mitad de Drive: aplicar o retirar
// la ACL de la carpeta de la caja y de los ficheros de login, con el token del
// que concede. Es lo que hace que en Drive conste QUIÉN lo hizo.
//
// Que el Sheet quede escrito y la ACL no es un estado que YA existía (la rama
// `warning`, que reconcilia syncDrivePermissions). Con el reparto pasa de raro
// a normal: el warning es parte del contrato, no un aviso excepcional.













// Localiza las carpetas planas S###_<nombre> de FLAT_ROOT cuyo sufijo de nombre
// matchee el boxName normalizado — SIN que el que ejecuta (USER_ACCESSING)
// necesite acceso a la propia carpeta FLAT_ROOT. La query "'<id>' in parents"
// filtra por el PADRE del hijo (metadato del hijo), no exige abrir el padre:
// así devuelve solo las cajas que el caller YA tiene compartidas (un champion →
// solo SU caja; un admin → todas las suyas). Con esto NADIE necesita lectura de
// la carpeta de conocimiento. Los nombres de caja pueden duplicarse entre áreas
// (mismo criterio por-nombre que col E/F). FLAT_ROOT_ID vacía → [] (rollout
// gradual). NUNCA lanza — si la búsqueda falla, [] y el caller lo avisa en el
// warning (el Sheet ya se escribió).
//
// #4 (2026-07-19) — DESAMBIGUACIÓN POR S-ID. Los nombres de caja SE REPITEN
// entre áreas (58 duplicados en el árbol BBVA: la identidad real de una caja es
// name+areaPath, y en Drive es la carpeta 'S###_<nombre>'). Buscar SOLO por
// nombre devolvía TODAS las homónimas y el grant/revoke aplicaba la ACL en
// todas ellas → un acceso a "Reporting" del equipo A daba editor en el
// "Reporting" del equipo B (cross-área/cross-tenant). Con 'sid' se matchea la
// carpeta EXACTA (el prefijo ya la identifica sin ambigüedad). 'sid' ausente
// (caja sin materializar, o plugin anterior a este cambio) → fallback al
// matching por nombre de siempre (back-compat, cero regresión).
//
// #318 — EL S-ID NO BASTA POR SÍ SOLO: tiene que casar TAMBIÉN el nombre.
// El sid llega del payload del cliente y NADIE lo valida contra el boxName
// que acaba de pasar el gate de potestad (cfgAuthorityForEmail_ gatea por
// NOMBRE). Con el match solo por prefijo, un KDD Champion legítimo de "Mi Caja"
// podía mandar {boxName:"Mi Caja", sid:"S099"}: el gate pasa, la fila se
// escribe en SU caja, y la ACL se aplica sobre la carpeta de OTRO equipo.
//
// Hasta #318 lo contenía un accidente: la ACL la aplicaba la mitad PÚBLICA con
// el token del que concede, que sobre una caja ajena no puede — devolvía [] y
// el ataque era inerte. Al pasar el reparto al PROPIETARIO, que las ve todas,
// esa contención desaparece. Exigir las dos cosas la sustituye por una de
// verdad, y **no debilita #4**: dos homónimas tienen el MISMO nombre y distinto
// S-ID, así que el S-ID las sigue separando igual de bien.
//
// #359 — EL CRITERIO VA ATADO AL GATE QUE HAYAS PASADO, y por eso hay un tercer
// argumento en vez de una regla global.
//
// Exigir el nombre convierte el NOMBRE DE UNA CARPETA DE DRIVE en un control de
// acceso, y eso tiene dos precios: cualquiera con escritura en la carpeta puede
// renombrarla, y una caja renombrada en el árbol deja de casar y sus ACLs no se
// aplican nunca (el LIMBO de S049). El gate correcto es el ÁRBOL, que es el dato
// maestro: el par (sid, nombre) tiene que casar con una de sus filas.
//
//   · Sin el tercer argumento (el DEFECTO) → S-ID **y** nombre, exactamente como
//     antes. Lo usan grant/revoke de este fichero, que corren en la mitad PÚBLICA
//     con el token del que concede y NO pueden leer el árbol: para ellos el
//     nombre sigue siendo el único segundo control que tienen.
//   · Con parValidadoContraArbol === true → **solo S-ID**. Lo pasa únicamente el
//     drenaje de la cola, y solo DESPUÉS de haber validado el par contra el
//     árbol. Localizar por S-ID sin esa validación no cierra el agujero de #318:
//     lo ABRE, porque el sid llega del payload y el gate de potestad mira el
//     nombre. Las dos mitades van juntas o no van.
function findFlatBoxFolders_(boxKey, sid, parValidadoContraArbol) {
  var props = PropertiesService.getScriptProperties();
  var flatRootId = props.getProperty('FLAT_ROOT_ID') || '';
  if (!flatRootId) { return []; }
  var wantSid = String(sid || '').trim().toUpperCase();
  // Sin S-ID no hay nada que validar contra el árbol, así que el flag no puede
  // relajar nada: se cae al matching por nombre de siempre (back-compat).
  var soloPorSid = parValidadoContraArbol === true && wantSid !== '';
  var out = [];
  try {
    var q = "'" + flatRootId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    var pageToken = null;
    do {
      var resp = Drive.Files.list({ q: q, maxResults: 1000, pageToken: pageToken });
      // Por driveLista_ / driveNombre_ y no por resp.items: bajo Drive v3 esto
      // devolvía [] con éxito, y un [] aquí se lee como "esta caja no tiene
      // carpeta" — o sea, ningún permiso que retirar. Diecisiete días (#359).
      var items = driveLista_(resp, 'files');
      for (var i = 0; i < items.length; i++) {
        var m = /^(S\d+)_(.*)$/.exec(driveNombre_(items[i]));
        var hit = m && (wantSid
          // S-ID exacto Y nombre — el S-ID desambigua entre homónimas, el
          // nombre impide que un S-ID forjado apunte a una caja ajena (#318).
          // Con el par ya validado contra el árbol, el nombre sobra: el S-ID es
          // la identidad y el nombre solo una etiqueta que el árbol manda.
          ? (String(m[1]).toUpperCase() === wantSid && (soloPorSid || normBoxName_(m[2]) === boxKey))
          : normBoxName_(m[2]) === boxKey);          // sin S-ID → nombre (legacy)
        if (hit) {
          try { out.push(DriveApp.getFolderById(items[i].id)); }
          catch (eF) { Logger.log('findFlatBoxFolders_: no se pudo abrir la carpeta ' + items[i].id + ' — ' + (eF && eF.message ? eF.message : String(eF))); }
        }
      }
      pageToken = resp && resp.nextPageToken;
    } while (pageToken);
  } catch (e) {
    // La búsqueda falló (servicio Drive, etc.). NO revientes el grant entero —
    // devuelve [] y deja que el caller lo avise (el Sheet ya se escribió).
    Logger.log('findFlatBoxFolders_: búsqueda bajo FLAT_ROOT (' + flatRootId + ') falló para el que concede — ' + (e && e.message ? e.message : String(e)));
    return [];
  }
  return out;
}

// Divide una lista de IDs de fichero (Script Property) separada por coma / ; /
// espacio / salto de línea. '' → [].
function accessSplitIds_(raw) {
  var parts = String(raw || '').split(/[\s,;]+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p) { out.push(p); }
  }
  return out;
}

// Comparte UN fichero (por ID) con un usuario en el rol dado ('reader' |
// 'writer'), SIN correo de notificación. Salta al propietario (no se pisa).
// NUNCA lanza — devuelve true si quedó compartido, false si falló (típico: el
// que concede corre como USER_ACCESSING y no tiene permiso de compartir ese
// fichero → 403).
function accessShareFileWith_(fileId, email, role) {
  try {
    var file = DriveApp.getFileById(fileId);
    var ownerEmail = '';
    try { var o = file.getOwner(); ownerEmail = o ? String(o.getEmail() || '').toLowerCase() : ''; }
    catch (e0) { /* sin owner legible */ }
    if (ownerEmail && ownerEmail === email) { return true; }
    Drive.Permissions.insert(
      { role: role, type: 'user', value: email },
      fileId,
      { sendNotificationEmails: false }
    );
    return true;
  } catch (err) {
    Logger.log('accessShareFileWith_: ' + fileId + ' → ' + email + ' (' + role + ') falló — ' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

var OAUTH_PROTECTED_FILE_IDS_ = [];

function oauthIsProtectedFile_(fileId) {
  var id = String(fileId || '').trim();
  for (var i = 0; i < OAUTH_PROTECTED_FILE_IDS_.length; i++) {
    if (OAUTH_PROTECTED_FILE_IDS_[i] === id) { return true; }
  }
  return false;
}

// Comparte los ficheros de LOGIN con un usuario para que pueda EJECUTAR el web
// app bajo executeAs:USER_ACCESSING. Mínimos privilegios:
//   LOGIN_SHARE_READER_IDS          → lector para todos.
//   LOGIN_SHARE_CHAMPION_EDITOR_IDS → editor si es KDD Champion, lector si no.
// Los ficheros protegidos (el Excel de Roles) se saltan pase lo que pase.
// Best-effort (accessShareFileWith_ nunca lanza).
function accessShareLoginFiles_(email, isChampion) {
  var props = PropertiesService.getScriptProperties();
  var readerIds = accessSplitIds_(props.getProperty('LOGIN_SHARE_READER_IDS') || '');
  var champIds = accessSplitIds_(props.getProperty('LOGIN_SHARE_CHAMPION_EDITOR_IDS') || '');
  var total = 0, shared = 0, errors = 0, skipped = 0, i;
  for (i = 0; i < readerIds.length; i++) {
    if (oauthIsProtectedFile_(readerIds[i])) { skipped++; continue; }
    total++;
    if (accessShareFileWith_(readerIds[i], email, 'reader')) { shared++; } else { errors++; }
  }
  for (i = 0; i < champIds.length; i++) {
    if (oauthIsProtectedFile_(champIds[i])) { skipped++; continue; }
    total++;
    if (accessShareFileWith_(champIds[i], email, isChampion ? 'writer' : 'reader')) { shared++; } else { errors++; }
  }
  if (skipped > 0) {
    Logger.log('accessShareLoginFiles_: ' + skipped + ' fichero(s) protegidos NO se comparten con ' + email +
      ' — saca el Excel de Roles de LOGIN_SHARE_*_IDS, ya nadie necesita acceso a él.');
  }
  return { total: total, shared: shared, errors: errors, skipped: skipped };
}

// Retira el acceso de un usuario a los ficheros de login (los DOS conjuntos:
// reader + champion-editor). Se usa cuando el usuario queda con CERO cajas tras
// un revoke → sin ninguna caja no debe poder loguearse. Best-effort (nunca
// lanza). Lo que el que revoca no pueda tocar (p.ej. un champion sobre
// Config.md, del que es solo lector) lo termina syncDrivePermissions.
function accessRemoveLoginFilesAccess_(email) {
  var props = PropertiesService.getScriptProperties();
  var ids = accessSplitIds_(props.getProperty('LOGIN_SHARE_READER_IDS') || '')
    .concat(accessSplitIds_(props.getProperty('LOGIN_SHARE_CHAMPION_EDITOR_IDS') || ''));
  var total = 0, removed = 0, errors = 0, i;
  for (i = 0; i < ids.length; i++) {
    total++;
    if (accessRemoveFileAccess_(ids[i], email)) { removed++; } else { errors++; }
  }
  return { total: total, removed: removed, errors: errors };
}

// Quita a un usuario (editor y/o lector) de UN fichero por ID. Salta al
// propietario. NUNCA lanza. Devuelve false si NO se pudo (no se pudo abrir el
// fichero, o ambas retiradas fallaron — sin permiso o no era miembro → el sync
// lo reconcilia).
function accessRemoveFileAccess_(fileId, email) {
  var file;
  try { file = DriveApp.getFileById(fileId); }
  catch (err) {
    Logger.log('accessRemoveFileAccess_: no se pudo abrir ' + fileId + ' para quitar ' + email + ' — ' + (err && err.message ? err.message : String(err)));
    return false;
  }
  try { var o = file.getOwner(); if (o && String(o.getEmail() || '').toLowerCase() === email) { return true; } }
  catch (e0) { /* sin owner legible */ }
  var did = false, failed = false;
  try { file.removeViewer(email); did = true; } catch (e1) { failed = true; }
  try { file.removeEditor(email); did = true; } catch (e2) { failed = true; }
  if (!did && failed) {
    Logger.log('accessRemoveFileAccess_: no se pudo retirar ' + email + ' de ' + fileId + ' (sin permiso o no era miembro — el sync lo reconcilia)');
    return false;
  }
  return true;
}

function accessListBoxUsers_(payload) {
  var rapida = accessListBoxUsersCached_(payload);
  if (rapida) { return jsonResponse_(rapida); }
  return jsonResponse_(relayConfigData_('listBoxUsers', {
    oauthToken: (payload && payload.oauthToken) || '',
    boxName: (payload && payload.boxName) || '',
    // El S-ID también, o en una caja HOMÓNIMA el censo se resuelve por nombre y
    // deja fuera a todo el que ya esté migrado (#365): el operador no ve —y por
    // tanto no puede retirar— a quien sí tiene acceso.
    sid: (payload && payload.sid) || '',
  }));
}

/**
 * El censo desde la caché, o `null` para que el llamante relaye (#325).
 *
 * **Devuelve `null` ante CUALQUIER duda, y `null` nunca significa "no tienes
 * permiso": significa "no lo sé".** Esa asimetría es la regla que sostiene todo
 * lo demás. Si esta función pudiera denegar, un desalojo de `CacheService` —que
 * puede ocurrir antes del TTL, es una caché y no un almacén— dejaría fuera a
 * alguien con derecho, y una publicación mal construida dejaría fuera a media
 * plantilla sin que nada lo delatara. Cayendo al relay, el peor caso de un fallo
 * aquí es la latencia que ya teníamos.
 */
function accessListBoxUsersCached_(payload) {
  var props = null;
  try { props = PropertiesService.getScriptProperties(); } catch (eProps) { return null; }
  if (!props) { return null; }

  // 1. Interruptor. AUSENTE = APAGADO, siguiendo el precedente de
  //    `ACL_QUEUE_FOLDER_ID` (#318): quitar la property apaga el camino rápido
  //    al instante y SIN republicar, que es la única forma de rollback que sirve
  //    cuando lo que falla está en un deployment congelado.
  try { if (String(props.getProperty('FAST_PATH_ENABLED') || '') !== 'true') { return null; } }
  catch (eFlag) { return null; }

  var boxName = String((payload && payload.boxName) || '').trim();
  if (!boxName) { return null; }

  // 2. Identidad VERIFICADA POR GOOGLE, nunca un email del payload — la cadena
  //    entera es forjable por quien alcance esta URL. Las dos mitades son el
  //    MISMO proyecto de Apps Script, así que aquí se puede llamar a la misma
  //    `cfgCaller_` que usa la privilegiada: resuelve por
  //    `Session.getActiveUser()` (gratis) y solo cae a `userinfo` (~300 ms) si
  //    no hay sesión. Ese coste se paga también cuando la caché falla, y aun así
  //    sale a cuenta: se cambia un tercio de segundo por los ~10 s del buzón.
  var caller = null;
  try { caller = cfgCaller_(payload); } catch (eCaller) { return null; }
  if (!caller || caller.ok !== true || !caller.email) { return null; }

  // 3. El censo. `cfgFastPathCenso_` deriva el salt del índice de ESTE email y
  //    sin salt no construye clave: pedir la caja de otro no produce una
  //    denegación, produce una clave que no existe.
  var users = null;
  //
  //    La clave va por S-ID cuando el plugin lo manda (#365 fase E) y por nombre
  //    si no. El `sid` del payload es FORJABLE y aquí da igual: el salt sale del
  //    índice de ESTE email, así que pedir la clave de una caja ajena produce un
  //    miss, no un acceso. Sin esta rama, una celda ya migrada no tendría clave
  //    por nombre publicada y el camino rápido se apagaría solo, en silencio.
  try { users = cfgFastPathCenso_(cfgCacheGen_(), caller.email, cfgClaveCenso_(String((payload && payload.sid) || ''), boxName)); }
  catch (eCenso) { return null; }
  if (users === null) { return null; }

  // `callerEmail` es el mismo contrato de siempre (#255·A7): el plugin deriva
  // `isSelf` con él. `cached` solo viaja para que el log del plugin distinga un
  // camino del otro — nunca se cachea nada derivado del llamante bajo una clave
  // compartida, y por eso `users` es idéntico para todos los gestores.
  return { ok: true, users: users, callerEmail: caller.email, cached: true };
}

// El censo POSTERIOR a la escritura viaja en la respuesta de grant y revoke
// ("menos viajes" · A, 2026-08-27): ConfigData lo construye de la foto que tiene
// en la mano dentro del lock, y con el el panel pinta la lista nueva sin un
// segundo viaje (~10 s por cada alta o baja). Va con el MISMO gate que
// listBoxUsers —la potestad del que concede—, asi que no es dato nuevo para
// nadie. Un ConfigData sin el campo (version anterior) simplemente no lo ecoa
// y el plugin re-lista como siempre.
function accessEcoCenso_(out, res) {
  if (res && Array.isArray(res.users)) {
    out.users = res.users;
    out.callerEmail = String(res.callerEmail || '');
  }
}

function accessGrantAccess_(payload) {
  var relayPayload = {
    oauthToken: (payload && payload.oauthToken) || '',
    boxName: (payload && payload.boxName) || '',
    email: (payload && payload.email) || '',
    role: (payload && payload.role) || '',
    sid: (payload && payload.sid) || '',
    // Clave de idempotencia (#326). El payload se arma campo a campo, así que
    // sin esta línea se quedaría por el camino y el corte de la auditoría no
    // llegaría nunca a ConfigData — que es justo lo que hace repetible la
    // escritura.
    requestId: (payload && payload.requestId) || '',
  };
  if (payload && payload.level) { relayPayload.level = payload.level; }
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'userType')) { relayPayload.userType = payload.userType; }
  var res = relayConfigData_('grant', relayPayload);
  if (!res || res.ok !== true) {
    return jsonResponse_({ ok: false, error: (res && res.error) || 'grantAccess: ConfigData no respondió' });
  }

  // #318 — ConfigData encoló el reparto: lo aplicará el propietario desde
  // `syncAplicarAclPendientes`. Aquí NO se toca Drive, que es de donde salían
  // ~46 de los ~52 s del alta. Sin `queued` (buzón sin configurar, o su
  // escritura falló) se sigue por el camino de siempre — degradación de
  // latencia, nunca de corrección.
  if (res.queued === true) {
    var outQ = { ok: true, queued: true };
    accessEcoCenso_(outQ, res);
    // El desglose de tiempos del relay (_perf) y de las etapas de ConfigData
    // (_cfg) llegan dentro de la respuesta del relay, y aqui se construye una
    // respuesta NUEVA: sin copiarlos, grant y revoke son las UNICAS acciones
    // que llegan al log SIN medir — y son justo las dos que toman el ScriptLock
    // y leen el arbol dos veces. Es metadato, no contrato: quien no lo conozca
    // lo ignora.
    if (res._perf) { outQ._perf = res._perf; }
    if (res._cfg) { outQ._cfg = res._cfg; }
    // El aviso de auditoría NO se pierde por encolar. Desde #318 la ACL la
    // aplica el propietario, así que el rastro es la ÚNICA constancia de quién
    // concedió: silenciar que no se pudo escribir es perder lo último que
    // queda. Sin esto, el early-return salía antes del bloque que lo convierte
    // en warning, más abajo.
    if (res.audited === false) {
      outQ.warning = 'el rastro de auditoría NO se pudo escribir (revisa AUDIT_SHEET_ID en ConfigData)';
    }
    return jsonResponse_(outQ);
  }

  // Ficheros que este alta NO debe compartir pase lo que pase (el Excel de
  // Roles). Lo dice ConfigData, que es el único que sabe su ID.
  OAUTH_PROTECTED_FILE_IDS_ = res.protectedFileIds || [];

  var email = cfgNormEmail_(payload && payload.email);
  var boxKey = res.boxKey || normBoxName_((payload && payload.boxName) || '');
  // El S-ID que devuelve ConfigData manda sobre el del payload: puede haber
  // MATERIALIZADO la caja en el árbol (#365), y entonces el payload no lo traía.
  var boxSid = String(res.sid || (payload && payload.sid) || '').trim();
  var folders = findFlatBoxFolders_(boxKey, boxSid);
  var updated = 0;
  var aclErrors = 0;
  for (var j = 0; j < folders.length; j++) {
    try {
      if (res.wantsEditor === true) {
        try { folders[j].removeViewer(email); } catch (e0) { /* no era viewer */ }
        shareNoEmail_(folders[j], email, 'writer');
      } else {
        // kb-contributor y kb-consumer son LECTORES de la caja. La diferencia
        // está en las subcarpetas del eje Work, más abajo (#279·#3). El
        // removeEditor importa: al DEGRADAR a alguien que era editor de la caja
        // entera, sin él se quedaría con la escritura vieja y el cambio de rol
        // sería decorativo.
        try { folders[j].removeEditor(email); } catch (e1) { /* no era editor */ }
        shareNoEmail_(folders[j], email, 'reader');
        if (res.wantsWorkEditor === true) { shareWorkSubfolders_(folders[j], [email]); }
      }
      updated++;
    } catch (eAcl) {
      aclErrors++;
      Logger.log('accessGrantAccess_: ACL de "' + folders[j].getName() + '" falló — ' + (eAcl && eAcl.message ? eAcl.message : String(eAcl)));
    }
  }
  var loginShare = accessShareLoginFiles_(email, res.userIsChampion === true);

  var warning = '';
  if (folders.length === 0) {
    warning = 'no se aplicó la ACL de Drive de la caja (FLAT_ROOT_ID vacía, carpeta aún no creada, o el que concede no tiene esa caja compartida) — el rol se guardó en el Sheet; que un admin propietario ejecute syncDrivePermissions';
  } else if (aclErrors > 0) {
    warning = aclErrors + ' carpeta(s) no se pudieron compartir — revisa la ACL en Drive';
  }
  if (loginShare.errors > 0) {
    var lw = loginShare.errors + ' fichero(s) de login no se pudieron compartir con ' + email +
      ' — el que concede debe poder compartirlos (admin propietario) o ejecuta syncDrivePermissions';
    warning = warning ? warning + ' · ' + lw : lw;
  }
  if (res.audited === false) {
    var aw = 'el rastro de auditoría NO se pudo escribir (revisa AUDIT_SHEET_ID en ConfigData)';
    warning = warning ? warning + ' · ' + aw : aw;
  }
  var out = { ok: true, foldersUpdated: updated, loginFilesShared: loginShare.shared };
  accessEcoCenso_(out, res);
  // Mismo eco de metadatos que en la rama encolada: ver el comentario de arriba.
  if (res._perf) { out._perf = res._perf; }
  if (res._cfg) { out._cfg = res._cfg; }
  if (warning) { out.warning = warning; }
  return jsonResponse_(out);
}

function accessRevokeAccess_(payload) {
  var res = relayConfigData_('revoke', {
    oauthToken: (payload && payload.oauthToken) || '',
    boxName: (payload && payload.boxName) || '',
    email: (payload && payload.email) || '',
    sid: (payload && payload.sid) || '',
    // Clave de idempotencia (#326) — ver accessGrantAccess_.
    requestId: (payload && payload.requestId) || '',
  });
  if (!res || res.ok !== true) {
    return jsonResponse_({ ok: false, error: (res && res.error) || 'revokeAccess: ConfigData no respondió' });
  }

  // #318 — igual que el alta. La fila del Sheet, que es lo que consulta el
  // plugin, ya está retirada; lo que se aplaza es la ACL de Drive.
  if (res.queued === true) {
    var outQ = { ok: true, queued: true };
    accessEcoCenso_(outQ, res);
    // El desglose de tiempos del relay (_perf) y de las etapas de ConfigData
    // (_cfg) llegan dentro de la respuesta del relay, y aqui se construye una
    // respuesta NUEVA: sin copiarlos, grant y revoke son las UNICAS acciones
    // que llegan al log SIN medir — y son justo las dos que toman el ScriptLock
    // y leen el arbol dos veces. Es metadato, no contrato: quien no lo conozca
    // lo ignora.
    if (res._perf) { outQ._perf = res._perf; }
    if (res._cfg) { outQ._cfg = res._cfg; }
    // Ver accessGrantAccess_: el rastro es la única autoría que queda.
    if (res.audited === false) {
      outQ.warning = 'el rastro de auditoría NO se pudo escribir (revisa AUDIT_SHEET_ID en ConfigData)';
    }
    return jsonResponse_(outQ);
  }

  var email = cfgNormEmail_(payload && payload.email);
  var boxKey = res.boxKey || normBoxName_((payload && payload.boxName) || '');
  // Igual que en el alta: el S-ID resuelto por ConfigData manda (#365).
  var boxSid = String(res.sid || (payload && payload.sid) || '').trim();
  var folders = findFlatBoxFolders_(boxKey, boxSid);
  var updated = 0;
  var aclErrors = 0;
  for (var j = 0; j < folders.length; j++) {
    var removedAny = false;
    try { folders[j].removeEditor(email); removedAny = true; } catch (e1) { /* no era editor */ }
    try { folders[j].removeViewer(email); removedAny = true; } catch (e2) { /* no era viewer */ }
    if (removedAny) { updated++; }
    else {
      aclErrors++;
      Logger.log('accessRevokeAccess_: no se pudo retirar la ACL de "' + folders[j].getName() + '" para ' + email);
    }
  }
  // Sin ninguna caja no debe poder loguearse: se le retira el acceso a los
  // ficheros de login. Ya NO incluye el Excel de Roles — nadie lo tiene.
  var loginRemoval = null;
  if (res.nowHasNoBox === true) {
    loginRemoval = accessRemoveLoginFilesAccess_(email);
    Logger.log('accessRevokeAccess_: ' + email + ' queda con 0 cajas → retirados ' + loginRemoval.removed + '/' + loginRemoval.total + ' fichero(s) de login (errores=' + loginRemoval.errors + ')');
  }

  var warning = '';
  if (folders.length === 0) {
    warning = 'no se retiró la ACL de Drive de la caja (FLAT_ROOT_ID vacía, carpeta aún no creada, o el que retira no tiene esa caja compartida) — el cambio se guardó en el Sheet; que un admin propietario ejecute syncDrivePermissions';
  } else if (aclErrors > 0) {
    warning = 'en ' + aclErrors + ' carpeta(s) no se pudo retirar el permiso de Drive (puede ser heredado del árbol pre-cutover — revísalo en Drive)';
  }
  if (loginRemoval && loginRemoval.errors > 0) {
    var lw = 'no se pudo retirar el acceso a ' + loginRemoval.errors + ' fichero(s) de login de ' + email + ' (que un admin propietario ejecute syncDrivePermissions)';
    warning = warning ? warning + ' · ' + lw : lw;
  }
  if (res.audited === false) {
    var aw = 'el rastro de auditoría NO se pudo escribir (revisa AUDIT_SHEET_ID en ConfigData)';
    warning = warning ? warning + ' · ' + aw : aw;
  }
  var out = { ok: true, foldersUpdated: updated };
  accessEcoCenso_(out, res);
  // Mismo eco de metadatos que en la rama encolada: ver el comentario de arriba.
  if (res._perf) { out._perf = res._perf; }
  if (res._cfg) { out._cfg = res._cfg; }
  if (loginRemoval) { out.loginFilesRemoved = loginRemoval.removed; }
  if (warning) { out.warning = warning; }
  return jsonResponse_(out);
}


// ════════════════════════════════════════════════════════════════════════════
//  GUARDS DE IDENTIDAD DE EJECUCIÓN (#292)
// ════════════════════════════════════════════════════════════════════════════
//
// Un proyecto, DOS implementaciones: el mismo código corre como el usuario
// (pública) o como el propietario (privilegiada) según la puerta por la que se
// entre. El código no puede saber por cuál viene — tiene que PREGUNTARLO, y
// fail-closed.
//
// Dos predicados OPUESTOS, cada uno protegiendo una cosa distinta:
//
//   assertSinSuplantacion_()   efectivo === activo !== ''   → protege el TOKEN
//   cfgAssertPrivileged_()     efectivo === OWNER_EMAIL     → protege el EXCEL
//   (el segundo vive en ConfigData.gs, en este mismo proyecto)
//
// `assertSinSuplantacion_` NO depende de OWNER_EMAIL A PROPÓSITO. Una primera
// versión sí lo hacía, y eso dejaba el guard APAGADO justo en la ventana de un
// despliegue a medias: el momento exacto en el que más falta hace. Formulado
// así, lo que exige es prueba POSITIVA de que quien llama y quien ejecuta son la
// misma persona identificada — cierto por construcción en la implementación
// pública, imposible en la privilegiada salvo que llame el propietario.
function assertSinSuplantacion_() {
  var efectivo = '';
  var activo = '';
  try { efectivo = String(Session.getEffectiveUser().getEmail() || '').toLowerCase().trim(); } catch (eEf) { efectivo = ''; }
  try { activo = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim(); } catch (eAc) { activo = ''; }
  if (efectivo && activo && efectivo === activo) { return; }

  // Un rechazo aquí no lo produce ningún flujo legítimo, así que tiene que ser
  // un EVENTO y no un silencio: alguien del dominio abriendo a mano el /exec de
  // la implementación privilegiada es exactamente lo que hay que poder ver
  // después. Se registra el email del llamante, nunca el token.
  Logger.log('assertSinSuplantacion_: BLOQUEADO — efectivo="' + (efectivo || '(vacio)') +
    '" activo="' + (activo || '(vacio)') + '"');
  // La fila del rastro solo se puede escribir desde la privilegiada
  // (`cfgAudit_` afirma por su cuenta). Desde la pública esto lanza y se ignora:
  // allí el Logger ya deja constancia y no hay token de propietario en juego.
  try {
    cfgAudit_({
      actor: activo || '(desconocido)', via: 'session', action: 'entradaBloqueada',
      result: 'denegado', target: efectivo,
      reason: 'ejecucion suplantada: el usuario efectivo no coincide con el llamante',
    });
  } catch (eAud) { /* implementación pública: no hay Excel al alcance */ }
  throw new Error('No se ha podido verificar tu identidad para esta operación. Si has abierto esta URL a mano, usa la del plugin.');
}

// El ÚNICO sitio de todo el proyecto donde se acuña un token OAuth.
//
// La fusión de #292 le regala a la implementación privilegiada un camino que
// antes no existía: `?action=auth` corriendo como el PROPIETARIO devolvería SU
// token en el payload del callback — el bug #90 otra vez, por otra puerta.
// Concentrar la acuñación aquí hace que la defensa no dependa de que nadie se
// olvide: un endpoint nuevo que pida un token y olvide el guard de entrada se
// topa igual con el check. Lo verifica un invariante estático (build + jest):
// el verbo aparece EXACTAMENTE una vez en todo el proyecto, y es esta.
//
// `testConfig` y el relay desde `sync-drive-permissions.gs` siguen funcionando:
// son `Run` del propietario, donde efectivo === activo.
function tokenDelUsuario_() {
  assertSinSuplantacion_();
  return ScriptApp.getOAuthToken();
}


// ════════════════════════════════════════════════════════════════════════════
//  RELAY → ConfigData
// ════════════════════════════════════════════════════════════════════════════
//
// Reenvía la llamada a la implementación PRIVILEGIADA del mismo proyecto CON EL
// TOKEN DEL USUARIO, para que ConfigData pueda identificarlo
// (Session.getActiveUser si comparten Workspace; si no, validando este mismo
// token contra userinfo de Google). El token viaja en la cabecera Authorization
// Y en el cuerpo: la cabecera autentica la invocación del web app, el cuerpo
// cubre el caso cross-domain en el que Session.getActiveUser() vuelve vacío.
//
// Desde #292 el token abre la puerta de la privilegiada porque las dos
// implementaciones comparten proyecto de Google Cloud. Con dos proyectos, esto
// solo funcionaba para el propietario.
//
// EL SALTO HTTP SE MANTIENE SIEMPRE, incluso cuando quien corre es el
// propietario y podría llamar a `cfgDispatch_()` en proceso. Que el camino del
// propietario sea IDÉNTICO al de todos los demás es justamente lo que habría
// hecho visible #292 el primer día en vez de a las tres semanas.
//
// NUNCA hay fallback a leer el Sheet: si la privilegiada no responde, la
// operación falla con error. Un fallback dejaría el Excel compartido para
// siempre.
//
// ── Por qué hay reintento, y por qué NO para todas las acciones ─────────────
//
// Una llamada al web app de ConfigData no devuelve el resultado directamente:
// responde 302 hacia un BUZÓN (script.googleusercontent.com/macros/echo) donde
// Apps Script deja la salida CUANDO la ejecución termina. Si ConfigData arranca
// en frío (runtime V8 + abrir el Excel del árbol), el GET al buzón llega antes
// de que haya nada y Google devuelve su página genérica con HTTP 404.
//
// Síntoma medido en NFQ (2026-08-04): la PRIMERA ejecución de
// syncDrivePermissions del día fallaba siempre en treeRaw a los ~15 s, y la
// segunda, 30 s después, iba bien — porque el primer intento había dejado la
// instancia caliente.
//
// CLAVE: en ese fallo ConfigData **sí ejecutó la acción**; lo único que se
// perdió fue la respuesta. Por eso el reintento se limita a acciones
// idempotentes. Reintentar un grant lo aplicaría dos veces (con dos filas en
// el rastro de auditoría), y un metaWrite chocaría contra su propio CAS y
// reportaría un conflicto que no existe. trailBatch TAMPOCO entra (#313):
// con el lote ya escrito en el buzón, reintentarlo dejaría un segundo fichero
// → filas duplicadas, que es exactamente el síntoma de #311. El plugin recibe
// el retriable:true y conserva su lote sin gastar intento (#312).
//
// ── Por qué UN solo reintento y corto (BBVA 2026-08-05) ─────────────────────
//
// Cada `Utilities.sleep` de aquí dentro retiene DOS ranuras del cupo de
// ejecuciones simultáneas mientras dura: la pública dormida y la privilegiada
// que se va a relanzar — y TODA la plantilla comparte el cupo del propietario.
// Con [3000, 8000] el peor caso interno eran ~101 s por llamada; el gasClient
// del plugin abortaba a los 30 s, reintentaba, y cada reintento sumaba otra
// cadena viva: congestión que se realimenta hasta dejar el GAS inutilizable.
// El compañero de este cambio vive en src/clients/gasClient.ts: el plugin
// reintenta él los ok:false retriable:true de las acciones idempotentes,
// esperando en SU lado, donde no cuesta cupo. El reintento único de aquí queda
// para cubrir el 404 frío en ejecuciones SIN gasClient delante: los Run del
// editor (syncDrivePermissions) y los triggers.
var RELAY_IDEMPOTENTES_ = {
  treeRaw: true, rolesMatrix: true, role: true, tree: true,
  // metaBatch solo agrupa LECTURAS (read | list): repetirlo no escribe nada.
  metaList: true, metaRead: true, metaBatch: true, resolveSid: true,
  boxAcl: true, listBoxUsers: true,
};

// `recipients` SE FUE de esta tabla (#367). La acción se retiró en #292 —iba
// por token compartido en vez de por identidad, y devolvía el censo entero de
// la plantilla— y su handler ya no se emite, así que la entrada no podía
// dispararse nunca. Inofensiva, pero esto es una tabla de POLÍTICA DE
// SEGURIDAD: una entrada muerta ahí se lee como vigente y sugiere que el
// endpoint sigue existiendo.
//
// ⚠ NO nombres aquí el handler retirado: hay una invariante que comprueba por
// TEXTO que su símbolo no aparece en el `.gs` generado, y un comentario que lo
// mencione la pone en rojo — comentarios incluidos, igual que `ABRE_EXCEL`.

// GRANT Y REVOKE NO ENTRAN AQUÍ, aunque desde #326 sean repetibles.
//
// Lo son —la fila del Sheet se reescribe igual, la ACL va a una cola que colapsa
// por (email, caja), y la fila de auditoría la corta `requestId`— pero quien las
// reintenta es el PLUGIN, que espera en su lado y no retiene cupo. Ponerlas
// también aquí multiplicaba: 3 intentos de cliente × 2 del relay = 6 ejecuciones
// privilegiadas por un solo grant, que es exactamente la amplificación contra el
// cupo del propietario que tumbó BBVA el 2026-08-05.
//
// El reintento de esta tabla existe para los llamantes SIN gasClient delante
// (los `Run` del editor y los triggers), y grant/revoke siempre lo tienen.

// Códigos que significan "vuelve a intentarlo", no "esto está mal montado".
// El 404 es el buzón todavía vacío; 401/403 NO entran (son configuración).
function relayEsTransitorio_(httpCode) {
  return httpCode === 404 || httpCode === 429 || httpCode >= 500;
}

// Techo de lo que puede tardar un rechazo de PUERTA en este salto (#324).
//
// Mismo discriminador que `GAS_PUERTA_MAX_MS` en el cliente y por el mismo
// motivo: Google decide si te deja ejecutar ANTES de arrancar nada, y eso son
// milisegundos. Pasado este techo, una respuesta rara ya no la puso la puerta —
// la puso el buzón, con ConfigData ya ejecutado.
var RELAY_PUERTA_MAX_MS_ = 10000;

var RELAY_ESPERAS_MS_ = [2500];

function relayConfigData_(action, extra) {
  var res = relayConfigDataOnce_(action, extra);
  if (!res || res.ok === true || res.retriable !== true || !RELAY_IDEMPOTENTES_[action]) {
    return res;
  }
  for (var i = 0; i < RELAY_ESPERAS_MS_.length; i++) {
    Logger.log('relayConfigData_(' + action + '): ' + (res.error || 'fallo transitorio') +
      ' — reintento ' + (i + 1) + '/' + RELAY_ESPERAS_MS_.length + ' en ' +
      Math.round(RELAY_ESPERAS_MS_[i] / 1000) + 's');
    Utilities.sleep(RELAY_ESPERAS_MS_[i]);
    res = relayConfigDataOnce_(action, extra);
    if (!res || res.ok === true || res.retriable !== true) { return res; }
  }
  return res;
}

function relayConfigDataOnce_(action, extra) {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty('CONFIG_DATA_URL') || '';
  if (!url) {
    return { ok: false, error: 'CONFIG_DATA_URL no configurada — este deployment no está enlazado con ConfigData.' };
  }
  var token = '';
  try { token = tokenDelUsuario_(); } catch (eTok) { token = ''; }

  // TRAZA DE DIAGNÓSTICO (2026-08-04). Este relay es el punto único de fallo del
  // login: si no responde, TODO el mundo ve "tu cuenta no está registrada" y
  // nadie puede distinguir "no estás en el Excel" de "no te he podido preguntar".
  // Cuando falla hay que poder contestar tres cosas desde el registro, sin
  // adivinar: (1) ¿salió token?, (2) ¿a quién ve Google como llamante?, y
  // (3) ¿en qué salto exacto se cae, y a dónde iba?
  // El token NUNCA se registra, solo su longitud: es una credencial viva.
  var traza = ['url…' + String(url).slice(-18), 'token=' + (token ? token.length + 'ch' : 'NINGUNO')];
  try {
    traza.push('caller=' + (Session.getActiveUser().getEmail() || '(vacio)'));
  } catch (eSes) {
    traza.push('caller=(no accesible)');
  }

  var payload = { action: action };
  if (extra) {
    for (var k in extra) {
      if (Object.prototype.hasOwnProperty.call(extra, k)) { payload[k] = extra[k]; }
    }
  }
  if (!payload.oauthToken && token) { payload.oauthToken = token; }
  // EL MARCADOR QUE ENRUTA (#292). Se pone AQUÍ y DESPUÉS de copiar `extra`,
  // para que ningún campo heredado pueda apagarlo. El plugin nunca lo manda: si
  // llega uno forjado a la implementación pública, `cfgAssertPrivileged_()` lo
  // mata en la primera línea de cfgDispatch_.
  //
  // Enruta un MARCADOR y no la identidad a propósito: en la pública, el login
  // del PROPIETARIO también da getEffectiveUser() === OWNER, así que enrutar por
  // identidad le mandaría su propio login al dispatcher del Excel.
  payload.cfgRelay = true;
  // followRedirects: FALSE a propósito, porque un web app de Apps Script emite
  // DOS clases de redirección y cada una necesita un método distinto:
  //
  //  · hacia otro **/exec** (normalización de dominio, /macros/s/… →
  //    /a/macros/<dominio>/s/…): hay que REPETIR el POST. Si se sigue como GET,
  //    en ConfigData corre doGet y responde "solo acepta POST".
  //  · hacia **script.googleusercontent.com/macros/echo**: ahí Apps Script ya
  //    dejó el RESULTADO de la ejecución y solo se recoge con GET. POSTear ahí
  //    devuelve HTTP 405.
  //
  // Con followRedirects en true, UrlFetchApp aplica siempre GET, así que falla
  // el primer caso; POSTeando siempre falla el segundo. De ahí que el síntoma
  // pareciera aleatorio: dependía de qué redirección tocara.
  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
    followRedirects: false,
  };
  if (token) { options.headers = { Authorization: 'Bearer ' + token }; }
  var getOptions = { method: 'get', muteHttpExceptions: true, followRedirects: false };
  if (token) { getOptions.headers = { Authorization: 'Bearer ' + token }; }
  // RELOJ (#324). Sin esto no se puede separar el trabajo real de ConfigData
  // (6-9 s medidos) de lo que cuesta RECOGER su respuesta del buzón, que es
  // donde se iban 25-40 s sin que nadie pudiera demostrarlo: la duración que
  // enseña el panel de Ejecuciones es tiempo de script, y la entrega por el
  // buzón ocurre fuera de ella.
  var t0 = Date.now();
  try {
    var resp = UrlFetchApp.fetch(url, options);
    var httpCode = resp.getResponseCode();
    var msPost = Date.now() - t0;
    traza.push('POST=' + httpCode + ' (' + msPost + 'ms)');
    var hops = 0;
    while ((httpCode === 301 || httpCode === 302 || httpCode === 303 || httpCode === 307) && hops < 5) {
      var hdrs = resp.getAllHeaders() || {};
      var loc = hdrs.Location || hdrs.location;
      if (!loc) { traza.push('sin Location'); break; }
      // ── RE-POSTEAR SOLO EN EL PRIMER SALTO (BBVA 2026-08-06) ───────────────
      //
      // El único redirect que legítimamente se re-POSTea es la NORMALIZACIÓN DE
      // DOMINIO (`/macros/s/…` → `/a/macros/<dominio>/s/…`), y esa llega
      // siempre en la PRIMERA redirección de la petición original. A partir de
      // ahí ya estamos en el buzón (`googleusercontent/macros/echo`), y un 302
      // de vuelta hacia `/exec` NO significa "vuelve a ejecutarlo": significa
      // que el resultado todavía no está listo.
      //
      // Re-POSTear ahí lanza OTRA ejecución privilegiada — con su Excel, su
      // lock y su cupo — que nadie va a leer, y devuelve otro 302 que reinicia
      // el ciclo. Medido en producción: hasta TRES POSTs por llamada, cadenas
      // de seis saltos y ejecuciones de 130-170 s. La presión sobre el cupo del
      // propietario que parecía un límite de Google era, en su mayor parte,
      // autoinfligida aquí.
      var esExec = hops === 0 && String(loc).indexOf('/exec') >= 0;
      var tSalto = Date.now();
      resp = UrlFetchApp.fetch(loc, esExec ? options : getOptions);
      httpCode = resp.getResponseCode();
      // Host del salto, no la URL entera: lleva user_content_key y ocupa media
      // línea. Lo que importa es SI saltó a googleusercontent y con qué código.
      // El tiempo POR SALTO es lo que dice si el buzón contesta rápido y hay
      // muchos saltos, o si hay uno solo que se eterniza — dos problemas
      // distintos que sin el desglose se leen igual.
      traza.push((esExec ? 'POST' : 'GET') + ' ' + String(loc).split('/')[2] + '=' + httpCode +
        ' (' + (Date.now() - tSalto) + 'ms)');
      hops++;
    }
    // Cadena agotada sin resolver (seguimos en 3xx): el buzón no llegó a estar
    // listo. Es TRANSITORIO — reintentar la acción entera sí puede funcionar —,
    // pero `relayEsTransitorio_` solo conoce 404/429/5xx, así que sin esto un
    // 302 colgado se clasificaba como configuración rota y no se reintentaba.
    var redirectAgotado = httpCode === 301 || httpCode === 302 || httpCode === 303 || httpCode === 307;
    var text = resp.getContentText();
    // El <title> de la página de error de Google dice en una línea lo que el
    // cuerpo entero esconde ("Se requiere autorización" ≠ "No tienes acceso"),
    // y en 300 caracteres de HTML no cabe: va en los metadatos de cabecera.
    var titulo = '';
    var mT = String(text).match(/<title[^>]*>([^<]{0,120})<\/title>/i);
    if (mT) { titulo = ' title="' + mT[1] + '"'; }
    if (httpCode !== 200) {
      // La traza (url, longitud del token, llamante, cadena de saltos HTTP) es
      // lo que distingue un fallo de red de un guard denegando: si aparece
      // `token=…ch` y `caller=…`, la identidad se resolvió y lo que falla es el
      // salto. Sin ella, los dos fallos se leen igual en el log.
      Logger.log('relayConfigDataOnce_(' + action + '): HTTP ' + httpCode + titulo +
        ' [' + traza.join(' · ') + '] — ' + String(text).slice(0, 300));
      var esBuzon = httpCode === 404 || redirectAgotado;
      return {
        ok: false,
        retriable: relayEsTransitorio_(httpCode) || redirectAgotado,
        error: 'ConfigData respondió HTTP ' + httpCode +
          (esBuzon ? ' — el resultado aún no estaba listo (arranque en frío).' : ' — revisa el deployment y CONFIG_DATA_URL.'),
      };
    }
    try {
      var parsed = JSON.parse(text);
      // ÉXITO: también se registra (#324). Antes solo se dejaba traza al fallar,
      // así que una llamada LENTA pero correcta no dejaba ni una línea — y son
      // justo las que hay que estudiar. El desglose distingue el trabajo de
      // ConfigData de la recogida del buzón, que es donde vive la latencia.
      var msOk = Date.now() - t0;
      Logger.log('relayConfigDataOnce_(' + action + '): OK en ' + msOk + 'ms' +
        ' [' + traza.join(' · ') + ']');
      // El desglose viaja TAMBIÉN al plugin (#324). El log de Apps Script solo
      // lo ve quien abre el editor; el operador mira su nfq-debug.log, y sin
      // esto tendría que cruzar dos registros a mano para saber si la espera
      // fue trabajo de ConfigData o entrega del buzón.
      //
      // Campo con guion bajo y añadido DESPUÉS del parseo: es metadato de
      // transporte, no parte del contrato de datos. Un consumidor que no lo
      // conozca lo ignora.
      if (parsed && typeof parsed === 'object') {
        parsed._perf = { relayMs: msOk, postMs: msPost, hops: hops, traza: traza.join(' · ') };
      }
      return parsed;
    } catch (eParse) {
      // Respuesta no-JSON: DOS cosas distintas que se leían como una sola.
      //
      //  · RÁPIDA  → la pantalla de login de Google interceptando la llamada:
      //    deployment con el acceso mal configurado, o URL de una versión que ya
      //    no existe. Es determinista y reintentar no arregla nada.
      //  · TARDÍA  → el BUZÓN (#324). ConfigData YA ejecutó y lo que se perdió
      //    fue la entrega del resultado; la página que llega no habla del
      //    deployment. Es transitorio y reintentar SÍ funciona.
      //
      // Es la misma lección de #320 aplicada al salto propio del relay: la
      // página miente sobre la causa y solo el reloj los separa. Sin esto, un
      // buzón perdido se reportaba como "revisa el acceso del deployment
      // (debe ser ANYONE con cuenta de Google)" y mandaba a revisar una
      // configuración correcta — medido en BBVA el 2026-08-06 sobre la caja
      // MARKET-MSC, con ConfigData respondiendo en 6-9 s.
      var msTotal = Date.now() - t0;
      var esBuzonTardio = msTotal > RELAY_PUERTA_MAX_MS_;
      Logger.log('relayConfigDataOnce_(' + action + '): respuesta no-JSON en ' + msTotal + 'ms' + titulo +
        ' [' + traza.join(' · ') + '] — ' + String(text).slice(0, 300));
      if (esBuzonTardio) {
        return {
          ok: false,
          retriable: true,
          error: 'ConfigData ejecutó pero su respuesta se perdió por el camino — reintenta.',
        };
      }
      return { ok: false, error: 'ConfigData devolvió una respuesta no JSON — revisa el acceso del deployment (debe ser ANYONE con cuenta de Google).' };
    }
  } catch (err) {
    Logger.log('relayConfigDataOnce_(' + action + ') error: ' + (err && err.message ? err.message : String(err)) +
      ' [' + traza.join(' · ') + ']');
    return { ok: false, retriable: true, error: 'No se pudo contactar con ConfigData — reintenta.' };
  }
}
