/**
 * KDD Studio — ConfigData: la MITAD PRIVILEGIADA del proyecto (#292)
 *
 * ESTE FICHERO NO SE GENERA. Se mantiene a mano (como sync-drive-permissions.gs).
 *
 * ── Un proyecto, DOS implementaciones ───────────────────────────────────────
 * Esto NO es un proyecto de Apps Script aparte: se pega como un fichero más del
 * proyecto de OAuthToken, y por eso NO tiene `doGet`/`doPost` propios.
 *
 * El token que acuña Apps Script vale para el proyecto de Google Cloud DEL
 * SCRIPT QUE LO PIDE, y cada proyecto de Apps Script lleva el suyo autogenerado.
 * Con dos proyectos, el token de OAuthToken no abría la puerta de ConfigData:
 * todo el mundo menos el propietario recibía `HTTP 403` antes de ejecutar nada
 * (#292). La salida oficial —un proyecto GCP común— no es viable en BBVA. La
 * que sí: UN proyecto con DOS implementaciones, porque `executeAs` se elige por
 * implementación.
 *
 *   Implementación PÚBLICA        executeAs: usuario que accede.
 *                                 La llama el plugin. Login + todo lo de Drive.
 *   Implementación PRIVILEGIADA   executeAs: el propietario.
 *                                 La llama SOLO `relayConfigData_`. Abre el Excel.
 *
 * El mismo código sirve las dos mitades, así que estas funciones pueden correr
 * como el usuario o como el propietario según la puerta por la que se entre.
 * Eso lo deciden dos guards opuestos y fail-closed, y no la buena fe:
 *
 *   cfgAssertPrivileged_()     lanza salvo que getEffectiveUser() === OWNER_EMAIL.
 *                              "Corro como el propietario" hay que AFIRMARLO, y
 *                              para eso hace falta saber quién es → la property.
 *                              Protege el Excel.
 *   assertSinSuplantacion_()   (vive en OAuthToken.gs) lanza salvo que
 *                              getEffectiveUser() === getActiveUser() !== ''.
 *                              SIN property, a propósito: no hay config que se
 *                              pueda quedar vacía y apagar el guard.
 *                              Protege el token del propietario (bug #90).
 *
 * ── Por qué existe ──────────────────────────────────────────────────────────
 * El Excel de Roles/árbol ("KDD Studio Configuration") contiene el censo entero
 * de la plantilla, la matriz de roles y el árbol de cajas de todos los clientes.
 * Con el web app desplegado `executeAs: USER_ACCESSING`, cada usuario abría ese
 * Excel CON SU PROPIA identidad → había que compartírselo (lector para todos,
 * editor para los champions). Consecuencias:
 *   - cualquier usuario registrado leía el censo completo y el árbol entero,
 *     puenteando el recorte por usuario con solo abrir la URL;
 *   - un KDD Champion, siendo EDITOR, podía puentear TODOS los gates de
 *     `accessGrantAccess_` editando el Excel a mano (auto-marcarse admin en la
 *     col D, auto-concederse cajas en la col E, reescribir S-IDs ajenos).
 *
 * ConfigData corre como el PROPIETARIO, así que es el único que abre el Excel:
 * los usuarios dejan de necesitar cualquier permiso sobre él. Su API está
 * recortada POR LLAMANTE (cada acción devuelve solo lo que ese llamante tiene
 * derecho a ver), así que llamar directamente a esta URL no da nada que
 * OAuthToken no diera ya.
 *
 * ── INVARIANTE (no negociable) ──────────────────────────────────────────────
 *   Estas funciones NUNCA tocan ACLs (compartir, dejar de compartir, cambiar
 *   dueño) y NUNCA devuelven un OAuth token.
 *   Su ÚNICA escritura a Drive vive en `cfgMetaWriteFile_`,
 *   `cfgMetaCreateFolder_`, `cfgMetaDeleteFile_` — el proxy de
 *   `KDD_Studio_metadata` (#279·#5) —, `cfgTrailWriteInbox_`, que solo deja
 *   ficheros en el buzón del rastro (#283·4), `cfgTrailTrashFile_`, que solo
 *   retira de ese buzón los lotes ya consolidados (#313), y `cfgAclQueueWrite_`,
 *   que solo deja ficheros en el buzón de la cola de ACL (#318). Ninguna otra
 *   función puede escribir. La lista vive en `scripts/gas-invariants.js` y la
 *   comprueban el build y `gasConfigData.test.ts` en cada push.
 *
 *   Encolar un reparto NO es tocar una ACL: `cfgAclQueueWrite_` escribe un JSON
 *   que DESCRIBE el reparto pendiente, y quien lo aplica sigue sin ser este
 *   fichero. Lo que #318 cambia es que lo aplica el PROPIETARIO desde un
 *   trigger en vez de la mitad pública con el token del que concede.
 *
 * Porque toda acción de Drive del USUARIO tiene que seguir constando a su
 * nombre: carpetas de caja, ACL y subidas las hace la implementación PÚBLICA
 * con el token del usuario. Si esto se rompiera, todo el Drive volvería a
 * aparecer modificado por el propietario — exactamente el bug #90, que ya nos
 * pasó una vez. La excepción de `KDD_Studio_metadata` se decidió a conciencia y
 * su porqué está en la cabecera del bloque del proxy, más abajo.
 *
 * La invariante se verifica MECÁNICAMENTE, no por buena fe: tanto
 * `scripts/build-gas-sources.js` (aborta el build) como
 * `src/services/__tests__/gasConfigData.test.ts` (falla en jest) rechazan este
 * fichero si aparece un verbo de ACL, una obtención de token, o una escritura
 * de Drive FUERA de esos cinco helpers. Desde #292 comprueban además que las
 * funciones que abren un spreadsheet (`cfgOpenRolesSheet_`, `cfgTreeSheet_`,
 * `cfgAudit_`, `cfgConsolidarRastro`) empiecen por `cfgAssertPrivileged_();` y
 * que ningún símbolo de aquí colisione con uno de `OAuthToken.gs` o
 * `sync-drive-permissions.gs` — que es lo que sustituye a la garantía que daba
 * ser proyectos distintos.
 *
 * ── Despliegue ──────────────────────────────────────────────────────────────
 *   Manifiesto: `gas/appsscript.OAuthToken.json` — es el ÚNICO del proyecto.
 *   `executeAs`/`access` NO salen del manifiesto: se eligen POR IMPLEMENTACIÓN
 *   en la UI del editor. Este fichero solo se sirve desde la privilegiada.
 *
 *     Privilegiada  → "Ejecutar como: Yo" · acceso: cualquier usuario (NFQ) /
 *                     dominio (BBVA). Su `/exec` es `CONFIG_DATA_URL`.
 *     Pública       → "Ejecutar como: usuario que accede". Su `/exec` es la que
 *                     conoce el plugin.
 *
 *   El acceso amplio de la privilegiada NO es un agujero: la autorización se
 *   aplica DENTRO, acción por acción, y `cfgAssertPrivileged_()` mata cualquier
 *   `cfgRelay` forjado que llegue por la pública. Es necesario porque un usuario
 *   de otro dominio (BBVA llamando a un script propiedad de nfq.es) no pasa el
 *   filtro `DOMAIN`; el filtro real de dominio lo aplica `cfgCaller_` con
 *   ALLOWED_DOMAINS.
 *
 *   El proyecto NO se comparte con NADIE salvo lo mínimo para el login.
 *
 *   Script Properties que usa este fichero (unión con las de OAuthToken, que
 *   ahora viven en el MISMO proyecto):
 *     OWNER_EMAIL — email del propietario. La escribe `Run → cfgSetupOwner()`,
 *       nunca a mano: `Run` siempre corre como el propietario, así que no hay
 *       typo posible. VACÍA = todo lo que toca el Excel deniega (fail-closed).
 *     SHEET_ID, SHEET_NAME (default 'Roles'), TREE_SHEET_NAME (default
 *       'Arbol-BBVA'), ALLOWED_DOMAINS (default 'nfq.es,bbva.com'),
 *       SOURCES_TOKEN (opcional).
 *     AUDIT_SHEET_ID   — spreadsheet de auditoría (ver cfgAudit_). Vacía = no-op.
 *     AUDIT_SHEET_NAME — tab (default 'Auditoria').
 *     TRAIL_INBOX_FOLDER_ID — buzón del rastro de adopción (#283 · #313), una
 *       carpeta SIN COMPARTIR con nadie. Con ella puesta, el rastro de accesos
 *       deja de escribir en `AUDIT_SHEET_ID` y pasa a consolidarse con el
 *       resto de eventos. Vacía = comportamiento de siempre (appendRow) para
 *       los accesos, y `trailBatch` responde `disabled` sin perder lotes.
 *     TRAIL_SHEET_ID — hoja destino del rastro consolidado (#313). Vacía =
 *       `cfgConsolidarRastro` es un no-op y los lotes esperan en el buzón.
 *
 * ── Quién llama ─────────────────────────────────────────────────────────────
 * Solo `relayConfigData_`, vía `UrlFetchApp` contra `CONFIG_DATA_URL` (el
 * `/exec` de la implementación privilegiada), marcando el payload con
 * `cfgRelay: true`. El plugin NUNCA conoce esa URL ni manda ese marcador: sigue
 * hablando únicamente con la implementación pública, cuyo contrato no cambia.
 * Por eso este cambio no toca el plugin ni exige un .vsix nuevo.
 *
 * El salto HTTP se mantiene SIEMPRE, incluso para el propietario, que podría
 * llamar a `cfgDispatch_()` en proceso: que el camino del propietario sea
 * idéntico al de todos los demás es justamente lo que habría hecho visible #292
 * el primer día en vez de a las tres semanas.
 */

// ── Guard de la mitad privilegiada (#292) ────────────────────────────────────
//
// "Corro como el propietario" hay que AFIRMARLO, no suponerlo: el mismo código
// se sirve desde las dos implementaciones y solo en una de ellas es cierto. Y
// para afirmarlo hace falta saber quién es el propietario, de ahí la property.
//
// FAIL-CLOSED y RUIDOSO: sin `OWNER_EMAIL`, o con una identidad que no case,
// LANZA. Nunca devuelve un valor que el llamante pueda confundir con "no hay
// datos" — un fallback silencioso aquí sería servir el censo entero de la
// plantilla desde la implementación pública.
//
// A propósito NO se usa `getActiveUser()`: en la privilegiada el activo es el
// usuario que llama, y compararlo aquí denegaría el relay legítimo. Quien mira
// el par efectivo/activo es `assertSinSuplantacion_()` (OAuthToken.gs), que
// protege lo contrario: el token.
function cfgAssertPrivileged_() {
  var owner = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '').toLowerCase().trim();
  var efectivo = '';
  try { efectivo = String(Session.getEffectiveUser().getEmail() || '').toLowerCase().trim(); } catch (e) { efectivo = ''; }
  if (!owner) {
    throw new Error('OWNER_EMAIL no configurada — ejecuta Run → cfgSetupOwner() en el proyecto. Sin ella, nada puede abrir el Excel de Roles.');
  }
  if (!efectivo || efectivo !== owner) {
    Logger.log('cfgAssertPrivileged_: BLOQUEADO — efectivo="' + (efectivo || '(vacio)') + '" ≠ OWNER_EMAIL');
    throw new Error('Esta acción solo puede ejecutarla la implementación privilegiada del proyecto.');
  }
}

// Escribe `OWNER_EMAIL` desde el editor (Run). `Run` SIEMPRE corre como el
// propietario, así que el valor sale de Google y no de un campo escrito a mano:
// no hay typo posible, que es justo el fallo que dejaría el login caído.
//
// NO PUEDE llevar guion bajo: las funciones privadas no salen en el desplegable
// de `Run`. Y sin guion bajo Apps Script la expone por `google.script.run` desde
// cualquier página HtmlService del proyecto — incluida la de "Listo" del login,
// que carga cualquier usuario en su navegador. Por la implementación PÚBLICA el
// efectivo es ese usuario, así que sin guards bastaría su consola para escribir
// aquí SU email y dejar a `cfgAssertPrivileged_` denegando a todo el mundo:
// login, árbol, resolveSource, grant/revoke y el proxy de metadata caídos hasta
// el siguiente `Run` del propietario. DoS de un clic.
//
// Dos guards, los dos fail-closed y silenciosos (esto no lo mira nadie salvo
// quien despliega, y solo entonces):
//   1. efectivo === activo — mata el vector por la PRIVILEGIADA, donde el
//      efectivo es el propietario y el activo el que llama. Mismo par que mira
//      `assertSinSuplantacion_`, por el mismo motivo.
//   2. la property tiene que estar VACÍA o ya coincidir — mata el vector por la
//      pública, donde el atacante es a la vez efectivo y activo. Es el guard que
//      de verdad cierra B1: en un despliegue sano `OWNER_EMAIL` ya está puesta,
//      así que no hay nada que reescribir.
//
// Cambio real de propietario: se BORRA `OWNER_EMAIL` en Script Properties y se
// vuelve a ejecutar `Run → cfgSetupOwner()`. Que exija ese paso manual es
// deliberado — un cambio de dueño del proyecto no puede ser una llamada suelta.
function cfgSetupOwner() {
  var efectivo = String(Session.getEffectiveUser().getEmail() || '').toLowerCase().trim();
  var activo = '';
  try { activo = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim(); } catch (e) { activo = ''; }
  if (!efectivo) {
    Logger.log('cfgSetupOwner: Google no ha devuelto el email del usuario efectivo — no se escribe nada.');
    return;
  }
  if (efectivo !== activo) {
    Logger.log('cfgSetupOwner: BLOQUEADO — efectivo="' + efectivo + '" ≠ activo="' + (activo || '(vacio)') +
      '". Esto solo se ejecuta con Run desde el editor, nunca por google.script.run.');
    return;
  }
  var actual = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '').toLowerCase().trim();
  if (actual && actual !== efectivo) {
    Logger.log('cfgSetupOwner: BLOQUEADO — OWNER_EMAIL ya vale "' + actual + '" y no se pisa desde aquí. ' +
      'Si de verdad cambia el propietario, bórrala en Script Properties y vuelve a ejecutar Run → cfgSetupOwner().');
    return;
  }
  PropertiesService.getScriptProperties().setProperty('OWNER_EMAIL', efectivo);
  Logger.log('OWNER_EMAIL = ' + efectivo);
}

// ── Config ───────────────────────────────────────────────────────────────────

function cfgConfig_() {
  var props = PropertiesService.getScriptProperties();
  return {
    sheetId: props.getProperty('SHEET_ID') || '',
    sheetName: props.getProperty('SHEET_NAME') || 'Roles',
    treeSheetName: props.getProperty('TREE_SHEET_NAME') || 'Arbol-BBVA',
    allowedDomains: (props.getProperty('ALLOWED_DOMAINS') || 'nfq.es,bbva.com')
      .split(',')
      .map(function (s) { return s.trim().toLowerCase(); })
      .filter(function (s) { return !!s; }),
  };
}

// Lo llama el `doPost` de OAuthToken en la rama `cfgRelay` — es su único
// llamante desde #292 y no es código muerto: gemelo deliberado de
// `jsonResponse_`, para que en el punto de entrada se lea de un vistazo qué
// mitad produjo la respuesta.
function cfgJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ── Identidad del llamante ───────────────────────────────────────────────────
//
// NUNCA se cree un campo `email` del payload: OAuthToken es un intermediario y
// el payload lo compone él, pero la cadena entera es forjable por quien alcance
// esta URL. La identidad sale SIEMPRE de Google:
//
//   1. `Session.getActiveUser()` — gratis y sin red. Bajo `executeAs: ME` solo
//      devuelve email si el llamante está en el MISMO Workspace que el
//      propietario. Un usuario BBVA llamando a un script de nfq.es → ''.
//   2. Fallback: validar el oauthToken reenviado contra el endpoint `userinfo`
//      de Google. Es el mismo mecanismo que ya usaba `accessVerifyCaller_` para
//      grant/revoke en producción, así que está probado cross-domain.
//
// Después, filtro de dominio con ALLOWED_DOMAINS: es el gate que hace que
// `access: ANYONE` en el deployment no signifique "acceso para cualquiera".
function cfgCaller_(payload) {
  var email = '';
  var via = '';
  try { email = String(Session.getActiveUser().getEmail() || '').toLowerCase().trim(); } catch (e) { email = ''; }
  if (email) { via = 'session'; }

  if (!email) {
    var oauthToken = String((payload && payload.oauthToken) || '');
    if (!oauthToken) {
      return { ok: false, error: 'No se pudo identificar al llamante (sin sesión ni token) — vuelve a iniciar sesión en el plugin.' };
    }
    try {
      var resp = UrlFetchApp.fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: 'Bearer ' + oauthToken },
        muteHttpExceptions: true,
      });
      if (resp.getResponseCode() !== 200) {
        Logger.log('cfgCaller_: userinfo HTTP ' + resp.getResponseCode());
        // El texto incluye "401" y "token expirado" A PROPÓSITO: `isOAuthExpired`
        // (src/services/driveAuthGuard.ts) clasifica por agujas en el mensaje, y
        // sin ellas este error no dispara el badge rojo ni el re-login.
        return { ok: false, error: 'HTTP 401 — token expirado o inválido: vuelve a iniciar sesión en el plugin.' };
      }
      var info = JSON.parse(resp.getContentText());
      email = String(info.email || '').toLowerCase().trim();
      via = 'token';
    } catch (err) {
      Logger.log('cfgCaller_ error: ' + (err && err.message ? err.message : String(err)));
      return { ok: false, error: 'No se pudo verificar la identidad del llamante — reintenta.' };
    }
  }
  if (!email) { return { ok: false, error: 'No se pudo verificar el email del llamante.' }; }

  var cfg = cfgConfig_();
  var domain = (email.split('@')[1] || '').toLowerCase();
  if (cfg.allowedDomains.length > 0 && cfg.allowedDomains.indexOf(domain) < 0) {
    return { ok: false, error: 'Unauthorized domain' };
  }
  return { ok: true, email: email, via: via };
}

// ── Helpers de nombre de caja y de rol (espejo del plugin y del GAS actual) ──

function cfgNormBox_(s) {
  var str = String(s || '');
  try { str = str.normalize('NFD'); } catch (e) { /* runtime sin normalize */ }
  return str.replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

// ── Identidad de caja: manda el S-ID, el nombre es transición (#365) ─────────
//
// Las celdas E-H llevaron siempre NOMBRES de caja, y el árbol de BBVA tiene 58
// nombres duplicados: conceder "Reporting" abría LAS DOS cajas Reporting. El
// cutover las pasa a S-ID, pero el Sheet lo edita gente a mano, así que durante
// la transición conviven los dos formatos.
//
// **Regla única, y de ella sale todo lo demás: cada token se compara EN SU
// DIALECTO** — el que parece un S-ID contra el S-ID objetivo, el resto contra el
// nombre. Por eso las preguntas del tipo *"¿esta celda concede la caja X?"* NO
// necesitan el árbol: el llamante ya trae el par (S-ID, nombre). El árbol solo
// hace falta para ENUMERAR sin caja objetivo (`cfgSplitSids_`) y para
// materializar un S-ID al conceder.
//
// **Un nombre legacy que no resuelve a un único S-ID conserva el significado de
// hoy** ("cualquier caja que se llame así"). Descartarlo sería un flip duro
// encubierto: el día del despliegue, todo champion cuya col E siga sin migrar
// perdería su caja. Lo que cierra #293 no es descartar, es que TODA escritura
// emita S-ID —grant/revoke migran la fila que tocan— y que el migrador pase por
// el resto.

/** ¿El token tiene forma de S-ID? (`S49`, `S049`, `s1234`). */
function cfgEsSid_(token) {
  return /^\s*S\d+\s*$/i.test(String(token == null ? '' : token));
}

/** S-ID normalizado (`S49` → `S049`, mitiga #363), o '' si el token no lo es. */
function cfgNormSid_(token) {
  var m = /^\s*S(\d+)\s*$/i.exec(String(token == null ? '' : token));
  return m ? cfgFormatSid_(parseInt(m[1], 10)) : '';
}

// Separador coma / punto-y-coma / salto de línea — NO espacios (los nombres de
// caja llevan espacios).
function cfgTokensDeCelda_(raw) {
  var out = [];
  var parts = String(raw == null ? '' : raw).split(/[,;\n]+/);
  for (var i = 0; i < parts.length; i++) {
    var t = parts[i].trim();
    if (t) { out.push(t); }
  }
  return out;
}

/** Unión sin repetir, conservando el orden. */
function cfgUnirListas_(a, b) {
  var out = (a || []).slice();
  for (var i = 0; i < (b || []).length; i++) {
    if (out.indexOf(b[i]) < 0) { out.push(b[i]); }
  }
  return out;
}

/** ¿La celda concede la caja objetivo? Cada token, en su dialecto. */
function cfgCeldaTieneCaja_(raw, sid, boxKey) {
  var tokens = cfgTokensDeCelda_(raw);
  for (var i = 0; i < tokens.length; i++) {
    if (cfgEsSid_(tokens[i])) {
      if (sid && cfgNormSid_(tokens[i]) === sid) { return true; }
    } else if (boxKey && cfgNormBox_(tokens[i]) === boxKey) { return true; }
  }
  return false;
}

/**
 * Quita de la celda la caja objetivo: su S-ID **y** su nombre.
 *
 * Las dos formas, siempre. Dejar el nombre al conceder un rol nuevo dejaría el
 * rol VIEJO puesto por la vía legacy —un grant que degrada no degradaría nada—,
 * y eso sí es una escalada. El precio: migrar una entrada ambigua estrecha el
 * acceso a la caja sobre la que se opera, que es el fix aplicado fila a fila, y
 * la decisión humana la tomó quien eligió esa caja en el panel.
 */
function cfgListRemoveCaja_(raw, sid, boxKey) {
  var tokens = cfgTokensDeCelda_(raw);
  var kept = [];
  for (var i = 0; i < tokens.length; i++) {
    if (cfgEsSid_(tokens[i])) {
      if (sid && cfgNormSid_(tokens[i]) === sid) { continue; }
    } else if (boxKey && cfgNormBox_(tokens[i]) === boxKey) { continue; }
    kept.push(tokens[i]);
  }
  return kept.join(', ');
}

/** Añade el S-ID si no estaba ya. NUNCA escribe nombres: una celda nueva es
 *  siempre S-ID, o el cutover no termina nunca. */
function cfgListAddSid_(raw, sid) {
  var cur = String(raw == null ? '' : raw).trim();
  if (!sid) { return cur; }
  var tokens = cfgTokensDeCelda_(cur);
  for (var i = 0; i < tokens.length; i++) {
    if (cfgEsSid_(tokens[i]) && cfgNormSid_(tokens[i]) === sid) { return cur; }
  }
  return cur ? cur + ', ' + sid : sid;
}

/**
 * Parser DUAL-READ de una celda E-H, para cuando NO hay caja objetivo con la que
 * comparar (`cfgLookupRole_`, que tiene que enumerar).
 *
 * `arbol` es el lector PEREZOSO (`cfgArbolLector_`), no el árbol: solo se invoca
 * si hace falta resolver un NOMBRE, y `null` significa "no pude mirar" — nunca
 * "no tienes".
 *
 * ⛔ **EL S-ID NO SE TRADUCE A NOMBRE** (#365 fase C, decisión 7). Traducirlo
 * obligaba a leer la pestaña del árbol DENTRO de `cfgLookupRole_`, o sea en
 * **cada login**, para fabricar un dato que el cliente ya tiene en disco
 * (`kb-tree-cache.json` trae `{name, sid}` por caja). Coste medido contra
 * producción: `role` 0→1 lecturas del árbol, `tree` 1→2, `treeRaw` 1→2,
 * `rolesMatrix` 0→1. Post-migración esta función ya no lo lee NUNCA.
 *
 * Devuelve `{ sids, nombres, sinMigrar, irresolubles, arbolIlegible }`:
 *   · `sids`         — S-IDs (normalizados) que la celda concede.
 *   · `nombres`      — SOLO los tokens que llegaron como nombre. Un S-ID **no
 *                      aporta nombre**: el plugin lo resuelve contra el árbol
 *                      que ya se descarga.
 *   · `sinMigrar`    — nombres legacy que SÍ resolvieron (combustible del migrador).
 *   · `irresolubles` — nombres legacy que no (ambiguos, desconocidos o sin S-ID):
 *                      conservan la semántica por nombre.
 *   · `arbolIlegible`— hizo falta el árbol para resolver un nombre y no se pudo
 *                      leer. Se marca aquí y no se deduce fuera.
 *
 * Los S-ID que no existen en el árbol ya no se detectan aquí — eso exigía
 * justamente la lectura que este cambio retira. Lo hace `cfgAuditarSidsHuerfanos`
 * (`Run`, bajo demanda) y el informe del migrador.
 */
function cfgSplitSids_(raw, arbol) {
  var res = { sids: [], nombres: [], sinMigrar: [], irresolubles: [], arbolIlegible: false };
  var tokens = cfgTokensDeCelda_(raw);
  var vistos = {};
  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (cfgEsSid_(token)) {
      var sid = cfgNormSid_(token);
      if (vistos[sid] === true) { continue; }
      vistos[sid] = true;
      res.sids.push(sid);
      continue;
    }
    var clave = cfgNormBox_(token);
    if (!clave || vistos['n:' + clave] === true) { continue; }
    vistos['n:' + clave] = true;
    res.nombres.push(token);
    var indice = arbol ? arbol() : null;
    if (!indice) { res.arbolIlegible = true; }
    var resuelto = indice ? cfgSidUnicoDeNombre_(indice.indice, clave) : '';
    if (resuelto) {
      if (vistos[resuelto] !== true) { vistos[resuelto] = true; res.sids.push(resuelto); }
      res.sinMigrar.push(token);
    } else {
      res.irresolubles.push(token);
    }
  }
  return res;
}

/** ¿La celda concede ALGO? Cuenta TOKENS, no nombres: desde la fase C una celda
 *  migrada no aporta ninguno y `nombres.length` la daba por vacía — o sea, un
 *  champion de una caja migrada se quedaba con rol `kb-contributor`. */
function cfgCeldaConcedeAlgo_(res) {
  return res.sids.length > 0 || res.irresolubles.length > 0;
}

function cfgNormRole_(s) {
  var folded = String(s || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '');
  if (folded === 'admin') { return 'admin'; }
  if (folded === 'kddchampion') { return 'kdd-champion'; }
  if (folded === 'kbsteward') { return 'kb-steward'; }
  if (folded === 'kbcontributor') { return 'kb-contributor'; }
  if (folded === 'kbconsumer') { return 'kb-consumer'; }
  return folded ? folded : 'kb-contributor';
}

function cfgRoleRank_(role) {
  var r = cfgNormRole_(role);
  if (r === 'admin') { return 4; }
  if (r === 'kdd-champion') { return 3; }
  if (r === 'kb-steward') { return 2; }
  if (r === 'kb-contributor') { return 1; }
  if (r === 'kb-consumer') { return 0; }
  return -1;
}

function cfgSanitizeType_(raw) {
  return String(raw == null ? '' : raw).replace(/[^\w .\-\/]/g, '').trim().slice(0, 24);
}

function cfgLevelForRole_(role) {
  return (role === 'kb-contributor' || role === 'kb-consumer') ? 'read' : 'write';
}

function cfgIsAdminCell_(v) {
  return /^(x|si|sí|yes|true|1)$/i.test(String(v || '').trim());
}

// ── Sheet de Roles ───────────────────────────────────────────────────────────

function cfgOpenRolesSheet_() {
  cfgAssertPrivileged_();
  var cfg = cfgConfig_();
  if (!cfg.sheetId) { return null; }
  var ss = SpreadsheetApp.openById(cfg.sheetId);
  return ss.getSheetByName(cfg.sheetName) || null;
}

// Sheet de Roles v3 — MATRIZ DE ROLES POR CAJA. Datos desde la fila 3 (índice 2):
//   col B (1) = Email · col C (2) = Tipo · col D (3) = Admin (X)
//   col E (4) = KDD Champions · col F (5) = KB Stewards
//   col G (6) = KB Contributors · col H (7) = KB Consumers
// Devuelve el MISMO objeto que devolvía `lookupRole_` en el proyecto único:
// el contrato hacia el plugin no cambia.
//
// Desde #365 las celdas llevan S-ID (y NOMBRES mientras quede Sheet sin migrar).
// Los seis `*SourceIds` son por lo que gatean el plugin y este fichero; los seis
// arrays de NOMBRES llevan **solo los tokens que llegaron como nombre** — un
// S-ID ya no se traduce (fase C, decisión 7): lo resuelve el plugin contra el
// árbol que ya tiene en disco.
//
// `opts.arbol` reutiliza el lector de la operación en curso — sin compartirlo,
// una sola acción instancia varios y lee la misma tabla dos y tres veces. Con el
// Sheet migrado del todo, el árbol NO se llega a leer aquí.
function cfgLookupRole_(email, opts) {
  var fallback = {
    found: false, role: 'kb-consumer', allowedUuaas: [], allowedSources: [], readableSources: [],
    championSources: [], stewardSources: [], userSources: [], externalUserSources: [],
    allowedSourceIds: [], readableSourceIds: [], championSourceIds: [], stewardSourceIds: [],
    userSourceIds: [], externalUserSourceIds: [], sourcesSinSid: [],
    userType: '', isAdmin: false,
  };
  var cfg = cfgConfig_();
  if (!cfg.sheetId) {
    return Object.assign({}, fallback, { warning: 'SHEET_ID not configured' });
  }
  try {
    // `opts.roles` reutiliza el lector de la operación en curso, igual que
    // `opts.arbol`. Sin él, un grant leía la hoja tres veces y un censo dos.
    // Quién puede pasarlo y desde dónde: ver `cfgRolesLector_` — el memo de
    // grant/revoke NACE DENTRO DEL LOCK y bajarle el del pre-chequeo reabre un
    // TOCTOU de control de accesos.
    var hoja = (opts && opts.roles) ? opts.roles() : cfgLeerHojaRoles_();
    if (!hoja) {
      return Object.assign({}, fallback, { warning: 'Sheet "' + cfg.sheetName + '" not found in spreadsheet' });
    }
    var values = hoja.values;
    var needle = String(email || '').toLowerCase().trim();
    // UN lector para toda la OPERACIÓN, no para esta invocación: el llamante
    // pasa el suyo si ya lo tiene (grant/revoke lo crean una vez y lo bajan por
    // los dos chequeos de potestad y la resolución de la caja).
    var arbol = (opts && opts.arbol) || cfgArbolLector_();
    for (var i = 2; i < values.length; i++) {
      var rowEmail = String(values[i][1] || '').toLowerCase().trim();
      if (!rowEmail || rowEmail !== needle) { continue; }
      var userType = String(values[i][2] || '').trim();
      var isAdmin = cfgIsAdminCell_(values[i][3]);
      var champion = cfgSplitSids_(values[i][4], arbol);
      var steward = cfgSplitSids_(values[i][5], arbol);
      var user = cfgSplitSids_(values[i][6], arbol);
      var externo = cfgSplitSids_(values[i][7], arbol);
      // El rol se deriva de si la celda CONCEDE algo, no de cuántos nombres
      // trae: desde la fase C una celda migrada no aporta ninguno.
      var role = isAdmin ? 'admin'
        : cfgCeldaConcedeAlgo_(champion) ? 'kdd-champion'
        : cfgCeldaConcedeAlgo_(steward) ? 'kb-steward'
        : cfgCeldaConcedeAlgo_(user) ? 'kb-contributor'
        : cfgCeldaConcedeAlgo_(externo) ? 'kb-consumer'
        : 'kb-contributor';
      var sinSid = cfgUnirListas_(cfgUnirListas_(champion.irresolubles, steward.irresolubles),
        cfgUnirListas_(user.irresolubles, externo.irresolubles));
      var salida = {
        found: true, role: role, allowedUuaas: [],
        allowedSources: cfgUnirListas_(champion.nombres, steward.nombres),
        readableSources: cfgUnirListas_(user.nombres, externo.nombres),
        championSources: champion.nombres, stewardSources: steward.nombres,
        userSources: user.nombres, externalUserSources: externo.nombres,
        allowedSourceIds: cfgUnirListas_(champion.sids, steward.sids),
        readableSourceIds: cfgUnirListas_(user.sids, externo.sids),
        championSourceIds: champion.sids, stewardSourceIds: steward.sids,
        userSourceIds: user.sids, externalUserSourceIds: externo.sids,
        sourcesSinSid: sinSid,
        userType: userType, isAdmin: isAdmin,
      };
      // Va en un campo APARTE — `warning` lo convierte `cfgActionReadableKeys_`
      // en `ok:false`, así que reutilizarlo tumbaría el proxy de metadata entero
      // por un fallo del árbol que las lecturas saben degradar.
      if (champion.arbolIlegible || steward.arbolIlegible || user.arbolIlegible || externo.arbolIlegible) {
        salida.avisoArbol = 'No se pudo leer el árbol: los nombres sin migrar de las celdas van sin resolver.';
      }
      return salida;
    }
  } catch (err) {
    return Object.assign({}, fallback, {
      warning: 'Sheet read error: ' + (err && err.message ? err.message : String(err)),
    });
  }
  return fallback;
}

// TODAS las filas (índices 0-based) cuyo col B es el email. El Sheet se edita a
// mano y un email puede acabar duplicado; list/grant/revoke deben verlas TODAS.
function cfgRowsForEmail_(values, email) {
  var rows = [];
  for (var i = 2; i < values.length; i++) {
    if (String(values[i][1] || '').toLowerCase().trim() === email) { rows.push(i); }
  }
  return rows;
}

// Potestad sobre una caja: admin (col D) → cualquiera; KDD Champion DE ESA CAJA
// (su col E la contiene) → esa caja. Resto → no. Se re-invoca DENTRO del lock
// para cerrar el TOCTOU: entre el pre-check y el lock un admin pudo degradar al
// llamante (la identidad no cambia con el mismo token, su ROL sí).
//
// **Con S-ID objetivo decide el S-ID y SOLO el S-ID** (#365). El bucle por
// nombre NO puede correr detrás como alternativa, y esa es la lección más cara
// de esta fase: la potestad se comprueba contra `boxName` y la escritura usa
// `sid`, y los dos los elige el llamante. Con las dos ramas encadenadas, un
// champion de "Reporting" mandaba `{boxName:'Reporting', sid:'S099'}` y escribía
// en la caja de otro equipo — el agujero de #318 movido al Sheet, que es la
// única capa de autorización que queda. Antes de #365 no era alcanzable por
// accidente: la celda se escribía con el NOMBRE, así que lo gateado y lo escrito
// eran el mismo dato.
//
// **Sin S-ID objetivo se resuelve por NOMBRE** (plugin viejo), traduciendo los
// S-ID de la celda contra el árbol: negar ahí dejaría fuera a champions ya
// migrados por no mandar un dato que su versión no conoce. Pero **un token con
// forma de S-ID nunca se compara como nombre**, o `boxName:'S041'` casaría
// contra la celda migrada `S041` y reabriría lo mismo por la otra puerta.
//
// `arbol` es el lector compartido de la operación: sin él, un grant llegaba a
// leer el árbol TRES veces, dos de ellas dentro del único ScriptLock.
//
// `roles` es el mismo trato para la hoja de Roles, y con una frontera que NO es
// negociable: en grant/revoke solo lo reciben las llamadas de DENTRO del lock.
// Pasarle aquí el lector del pre-chequeo haría que esta función re-verificara la
// potestad contra la foto de hace 30 s — o sea, que dejara de re-verificar nada.
// Ver `cfgRolesLector_`.
function cfgAuthorityForEmail_(email, boxName, sid, arbol, roles) {
  var sidObjetivo = cfgNormSid_(sid);
  var roleInfo = cfgLookupRole_(email, { arbol: arbol, roles: roles });
  if (roleInfo.isAdmin === true) { return { ok: true, email: email, role: 'admin' }; }
  var denegar = function () {
    // "No pude LEER" NO es "no tienes potestad" (#333 · #417), y el orden de
    // estos tres casos es el de la tabla que falló, de la más básica a la más
    // derivada.
    //
    // El `warning` de `cfgLookupRole_` va PRIMERO porque cubre el fallo más
    // grave: la matriz de roles no se pudo leer, así que el rol que tenemos en
    // la mano es un fallback con `isAdmin:false` — no un rol. Descartarlo era
    // #417: a un admin de verdad se le respondía "no estás autorizado" y se le
    // mandaba a revisar la columna D de un Sheet correcto. `infra:true` es lo
    // que además impide que eso se escriba en el rastro como una DENEGACIÓN:
    // ese rastro existe para vigilar intentos de escalada, y un hipo del Excel
    // no debe fabricar esa señal sobre gente que no hizo nada.
    //
    // Y el Sheet SIN CONFIGURAR se separa del fallo de lectura a propósito: uno
    // es permanente y el otro transitorio, así que "reintenta en un momento"
    // sería mentira en el primero y tendría a alguien reintentando para siempre.
    if (roleInfo.warning) {
      // PERMANENTE vs TRANSITORIO, y el criterio es "¿lo arregla esperar?".
      // `SHEET_ID` vacía y una pestaña que no existe son las dos configuración:
      // esperar no las arregla nunca, así que decir "reintenta" tiene a alguien
      // reintentando para siempre. Solo el fallo de LECTURA (timeout, cuota) se
      // pasa solo. Agrupar la pestaña con el transitorio era incoherente con el
      // motivo por el que se separó la property vacía.
      var aviso = String(roleInfo.warning);
      var permanente = aviso.indexOf('SHEET_ID not configured') === 0
        || aviso.indexOf('not found in spreadsheet') >= 0;
      return {
        ok: false,
        infra: true,
        error: permanente
          ? 'El Sheet de Roles no está bien configurado — avisa a un admin.'
          : 'No se pudo consultar la matriz de roles — reintenta en un momento.',
      };
    }
    // "No pude leer el árbol" NO es "no eres el champion" (#333): con el árbol
    // caído, una celda ya migrada llega sin traducir y no casa nada. Decirlo mal
    // manda a revisar la columna E de un Sheet correcto.
    if (roleInfo.avisoArbol) {
      return { ok: false, infra: true, error: 'No se pudo leer el árbol de cajas — reintenta en un momento.' };
    }
    return { ok: false, error: 'No autorizado: solo un admin o el KDD Champion de "' + boxName + '" pueden gestionar sus accesos.' };
  };
  var propios = roleInfo.championSourceIds || [];
  if (sidObjetivo) {
    // **El par (sid, boxName) se valida ANTES de mirar la potestad** (#368).
    // Los dos campos los elige el llamante y son INDEPENDIENTES, así que
    // autorizar por el `sid` propio y construir el dato con el `boxName`
    // ajeno deja leer la caja de cualquiera: un champion de S010 mandaba
    // `{boxName:'Beta', sid:'S010'}`, pasaba por aquí con SU S-ID y
    // `cfgCajaParaLeer_` —que ante un par que no casa DEGRADA a nombre—
    // construía el censo de Beta. `boxName` solo salía en el texto del error.
    //
    // Es la MISMA validación que `cfgCajaObjetivo_` ya hacía antes de escribir
    // el Sheet, aquí adelantada al gate: sin ella, gate y dato dejaban de
    // compartir clave, que es exactamente lo que en HEAD no podía pasar
    // (la firma era `(email, boxName)` y el censo salía de ESE `boxName`).
    //
    // NO es "el bucle por nombre corriendo detrás": es una PRECONDICIÓN. Con
    // el par validado sigue decidiendo el S-ID y solo el S-ID.
    var objetivo = cfgCajaObjetivo_(boxName, sid, arbol, false);
    // Se reenvía `infra`: esta precondición sale ANTES de `denegar()`, así que
    // el fix de #417 no la alcanzaba — y es la rama que recorre el plugin SIEMPRE
    // (manda `sid` desde #373). Sin esto, #417 quedaba arreglado solo para el
    // camino que ya casi nadie toma.
    if (!objetivo.ok) {
      return {
        ok: false,
        infra: objetivo.infra === true,
        error: cfgErrorParDivergente_(objetivo, roleInfo, sidObjetivo),
      };
    }
    for (var i = 0; i < propios.length; i++) {
      if (propios[i] === sidObjetivo) { return { ok: true, email: email, role: 'kdd-champion' }; }
    }
    return denegar();
  }
  var boxKey = cfgNormBox_(boxName);
  if (!boxKey) { return denegar(); }
  // (a) Celdas SIN migrar: el nombre tal cual, como siempre. El guard de S-ID es
  //     defensa en profundidad: desde la fase C `championSources` ya solo lleva
  //     nombres, pero hasta ese cambio llevaba también los S-ID crudos, y sin él
  //     un `boxName:'S041'` casaba contra la celda migrada `S041`. Si alguien
  //     vuelve a meter tokens de S-ID en esa lista, el agujero se reabre solo.
  var own = roleInfo.championSources || [];
  for (var j = 0; j < own.length; j++) {
    if (cfgEsSid_(own[j])) { continue; }
    if (cfgNormBox_(own[j]) === boxKey) { return { ok: true, email: email, role: 'kdd-champion' }; }
  }
  // (b) Celdas YA migradas: se traduce el NOMBRE PEDIDO a los S-ID que el árbol
  //     le da y se comparan con los del llamante. Sin esto, un champion con la
  //     celda en `S049` quedaría sin potestad en cuanto dejemos de fabricar
  //     nombres — que es justo lo que un plugin viejo provocaría.
  //     Con dos homónimas basta con ser champion de UNA para pasar, igual de
  //     permisivo que hoy: quien impide escribir en la que no toca es
  //     `cfgCajaObjetivo_`, que ante un nombre ambiguo y sin S-ID DENIEGA.
  var idx = arbol ? arbol() : null;
  if (idx) {
    var propiosSid = roleInfo.championSourceIds || [];
    var candidatos = idx.indice.sidsPorNombre[boxKey] || [];
    for (var k = 0; k < candidatos.length; k++) {
      if (propiosSid.indexOf(candidatos[k]) >= 0) { return { ok: true, email: email, role: 'kdd-champion' }; }
    }
  }
  return denegar();
}

/**
 * Lo mismo, pero por IDENTIDAD: `{ sids, nombres }`. null = admin.
 *
 * `nombres` lleva SOLO los nombres legacy que no resolvieron. Los que sí
 * resolvieron ya están en `sids`, y filtrar además por su nombre volvería a
 * enseñar la caja homónima — que es exactamente el leak de lectura de #293.
 * Una caja del árbol es visible si su S-ID está en `sids`, o si su nombre está
 * en `nombres` (ahí seguimos sin poder distinguirlas, y se mantiene lo de hoy).
 */
function cfgReadableSids_(roleInfo) {
  if (!roleInfo || roleInfo.isAdmin === true) { return null; }
  var sids = {};
  var lists = [roleInfo.allowedSourceIds || [], roleInfo.readableSourceIds || []];
  for (var l = 0; l < lists.length; l++) {
    for (var i = 0; i < lists[l].length; i++) {
      if (lists[l][i]) { sids[lists[l][i]] = true; }
    }
  }
  var nombres = {};
  var crudos = roleInfo.sourcesSinSid || [];
  for (var n = 0; n < crudos.length; n++) {
    var k = cfgNormBox_(crudos[n]);
    if (k) { nombres[k] = true; }
  }
  return { sids: sids, nombres: nombres };
}

// ── Árbol de cajas (tab del mismo spreadsheet) ───────────────────────────────

function cfgTreeSheet_() {
  cfgAssertPrivileged_();
  var cfg = cfgConfig_();
  if (!cfg.sheetId) { throw new Error('SHEET_ID not configured'); }
  var ss = SpreadsheetApp.openById(cfg.sheetId);
  var sh = ss.getSheetByName(cfg.treeSheetName);
  if (!sh) { throw new Error('Tab "' + cfg.treeSheetName + '" no encontrado en el spreadsheet'); }
  return sh;
}

function cfgNormHeader_(s) {
  return String(s || '').toLowerCase().trim()
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u');
}

// Localiza las columnas por CABECERA (no por posición): "Servicio" (nombre =
// identidad) y "S-ID"; el resto es jerarquía de área (se une con " > ").
function cfgReadTree_(sh) {
  var values = cfgLeerHoja_(sh, 'arbol');
  if (values.length === 0) { return { rows: [], sidCol: 0 }; }
  var headers = values[0].map(cfgNormHeader_);
  var servicioIdx = headers.indexOf('servicio');
  var sidIdx = -1;
  for (var h = 0; h < headers.length; h++) {
    if (headers[h] === 's-id' || headers[h] === 'sid' || headers[h] === 's id' || headers[h] === 's_id') { sidIdx = h; break; }
  }
  if (servicioIdx < 0) { throw new Error('El árbol no tiene columna "Servicio" en la cabecera'); }
  if (sidIdx < 0) { throw new Error('El árbol no tiene columna "S-ID" en la cabecera'); }
  var areaIdx = [];
  for (var a = 0; a < headers.length; a++) {
    if (a !== servicioIdx && a !== sidIdx) { areaIdx.push(a); }
  }
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var servicio = String(values[i][servicioIdx] || '').trim();
    if (!servicio) { continue; }
    var sid = String(values[i][sidIdx] || '').trim().toUpperCase();
    var areaParts = [];
    for (var k = 0; k < areaIdx.length; k++) {
      var cell = String(values[i][areaIdx[k]] || '').trim();
      if (cell) { areaParts.push(cell); }
    }
    rows.push({ rowIndex: i + 1, areaPath: areaParts.join(' > '), levels: areaParts, servicio: servicio, sid: sid });
  }
  return { rows: rows, sidCol: sidIdx + 1 };
}

function cfgMaxSid_(rows) {
  var max = 0;
  for (var i = 0; i < rows.length; i++) {
    var m = /^S(\d+)$/.exec(rows[i].sid || '');
    if (m) { var n = parseInt(m[1], 10); if (n > max) { max = n; } }
  }
  return max;
}

/**
 * El SIGUIENTE S-ID a emitir, que NUNCA puede ser uno ya usado (#359).
 *
 * `cfgMaxSid_(rows) + 1` solo mira las filas VIVAS del árbol, así que borrar la
 * fila con el S-ID más alto hace que el siguiente se REEMITA. Y un S-ID reciclado
 * no es un número repetido: es una identidad repetida. La carpeta del equipo
 * viejo (`S049_LoQueFuera`) se queda en Drive —la pasada del 24-ago encontró 3
 * huérfanas reales— y a partir de ahí TODO lo que localiza por S-ID apunta a
 * ella: el plugin le aplica la ACL de la caja nueva al abrirla, el drenaje
 * reparte permisos ahí, y desde #359 §4 además la RENOMBRA al nombre nuevo,
 * borrando la última pista de que ahí vivía otra cosa. El equipo nuevo acaba
 * leyendo y escribiendo sobre las specs del viejo.
 *
 * La marca de agua solo SUBE y vive en una property, así que sobrevive a que se
 * borre una fila. Se inicializa sola con el máximo del árbol: en un despliegue
 * existente el primer cálculo da lo mismo que antes, sin migración.
 *
 * NO se toca a mano. Bajarla es lo único que puede volver a reciclar un S-ID.
 */
function cfgSiguienteSid_(rows) {
  var props = PropertiesService.getScriptProperties();
  var marca = 0;
  try { marca = parseInt(props.getProperty('SID_HIGH_WATER') || '0', 10); }
  catch (eLeer) { marca = 0; }
  if (!isFinite(marca) || marca < 0) { marca = 0; }
  var siguiente = Math.max(cfgMaxSid_(rows), marca) + 1;
  // Se estampa ANTES de devolverlo: si la escritura de la celda falla después,
  // ese número queda quemado y la caja siguiente coge el próximo. Perder un
  // número es gratis; reutilizarlo es lo que cuesta una carpeta compartida con
  // el equipo equivocado.
  try { props.setProperty('SID_HIGH_WATER', String(siguiente)); }
  catch (eEscribir) {
    // Sin marca de agua queda el comportamiento de antes, que es el que hay hoy
    // en producción — pero se dice, porque es el guard que evita el reciclado.
    Logger.log('⚠️ No se pudo estampar SID_HIGH_WATER (' + (eEscribir && eEscribir.message ? eEscribir.message : String(eEscribir)) +
      '): si se borra una fila del árbol, este S-ID podría reemitirse.');
  }
  return siguiente;
}

function cfgFormatSid_(n) {
  var s = String(n);
  while (s.length < 3) { s = '0' + s; }
  return 'S' + s;
}

// ── El árbol como traductor S-ID ↔ nombre (#365) ─────────────────────────────

/**
 * Índice del árbol en las dos direcciones.
 *
 * `filasPorNombre` cuenta FILAS, no S-IDs, y esa distinción es la que decide si
 * un nombre legacy se puede resolver: dos filas homónimas de las que solo una
 * tiene S-ID siguen siendo dos cajas, y quedarse con la que lo tiene es adivinar
 * — justo lo que #365 vino a quitar.
 */
function cfgIndiceArbol_(rows) {
  var nombrePorSid = {};
  var sidsPorNombre = {};
  var filasPorNombre = {};
  for (var i = 0; i < rows.length; i++) {
    var sid = cfgNormSid_(rows[i].sid);
    var clave = cfgNormBox_(rows[i].servicio);
    if (sid && nombrePorSid[sid] === undefined) { nombrePorSid[sid] = rows[i].servicio; }
    if (!clave) { continue; }
    filasPorNombre[clave] = (filasPorNombre[clave] || 0) + 1;
    if (!sidsPorNombre[clave]) { sidsPorNombre[clave] = []; }
    if (sid && sidsPorNombre[clave].indexOf(sid) < 0) { sidsPorNombre[clave].push(sid); }
  }
  return { nombrePorSid: nombrePorSid, sidsPorNombre: sidsPorNombre, filasPorNombre: filasPorNombre };
}

/** El S-ID de un nombre, solo si es INEQUÍVOCO: una fila y un S-ID. '' si no. */
function cfgSidUnicoDeNombre_(indice, clave) {
  if (!indice || !clave) { return ''; }
  if (indice.filasPorNombre[clave] !== 1) { return ''; }
  var sids = indice.sidsPorNombre[clave] || [];
  return sids.length === 1 ? sids[0] : '';
}

/**
 * Lector PEREZOSO del árbol, memoizado POR INVOCACIÓN (nunca global: el árbol
 * cambia y una foto global serviría permisos de hace horas).
 *
 * Perezoso porque `cfgLookupRole_` se re-invoca DENTRO del lock de grant/revoke
 * para cerrar el TOCTOU de la potestad, y leer el árbol ahí alarga el lock: con
 * las celdas ya migradas no hay nada que traducir y no se lee nunca.
 *
 * **Se traga su propia excepción y devuelve `null`.** "No pude leer el árbol" NO
 * es "no tienes acceso": propagarlo dejaría `allowedSources` vacío para toda la
 * plantilla ante un fallo transitorio del Excel. Las LECTURAS se degradan al
 * comportamiento por nombre de siempre; las ESCRITURAS (grant/revoke) sí paran,
 * porque escribir sin saber el S-ID es fabricar el problema que esto arregla.
 */
function cfgArbolLector_() {
  var memo;
  return function () {
    if (memo !== undefined) { return memo; }
    try {
      var sh = cfgTreeSheet_();
      var tree = cfgReadTree_(sh);
      // Un árbol VACÍO es ilegible, no "no hay cajas" — mismo criterio que
      // `syncArbolPorSid_` (#359 §4). Tratarlo como legible convierte un fallo de
      // configuración en "tus S-ID no existen", que es la denegación silenciosa
      // que esta rama entera existe para no dar.
      if (tree.rows.length === 0) { throw new Error('el árbol no tiene ni una fila usable'); }
      memo = { sh: sh, rows: tree.rows, sidCol: tree.sidCol, indice: cfgIndiceArbol_(tree.rows) };
    } catch (err) {
      Logger.log('⚠️ cfgArbolLector_: árbol ilegible (' + (err && err.message ? err.message : String(err)) +
        ') — los nombres sin migrar conservan su significado de siempre.');
      memo = null;
    }
    return memo;
  };
}

/**
 * Abre la hoja de Roles y la lee entera: `{ sheet, values }`, o `null` si no hay
 * `SHEET_ID` o la pestaña no existe.
 *
 * Devuelve `sheet` además de `values` a propósito: quien lee la hoja acaba
 * escribiéndola (grant/revoke), y volver a abrirla para eso era una apertura de
 * spreadsheet de regalo.
 */
function cfgLeerHojaRoles_() {
  var sheet = cfgOpenRolesSheet_();
  return sheet ? { sheet: sheet, values: cfgLeerHoja_(sheet, 'roles') } : null;
}

/**
 * Lector PEREZOSO de la hoja de Roles, memoizado POR OPERACIÓN — nunca global,
 * por lo mismo que el del árbol: una foto global serviría permisos de hace
 * horas.
 *
 * Un grant leía la hoja TRES veces (`roles ×3` en el log del 2026-08-27) y un
 * censo DOS, y las tres del grant tenían su motivo: pre-chequeo de potestad
 * fuera del lock, re-verificación dentro, y materialización de la fila a
 * escribir. Las dos de DENTRO son la misma foto separada por microsegundos bajo
 * el mismo mutex; compartirlas es gratis.
 *
 * ⚠ DÓNDE SE CREA EL MEMO ES UNA DECISIÓN DE SEGURIDAD, NO DE RENDIMIENTO.
 *
 * En grant/revoke **nace AL ENTRAR EN EL LOCK**, jamás antes. La re-verificación
 * de dentro existe para mirar el estado de AHORA: entre el pre-chequeo y
 * conseguir el mutex pueden pasar 30 s, y en esos 30 s un admin puede haber
 * degradado al llamante. Bajarle la foto del pre-chequeo reabre exactamente ese
 * TOCTOU, y lo hace EN SILENCIO — el código sigue funcionando y solo falla el
 * día que a alguien lo degradan durante la espera. Es la misma frontera que ya
 * respeta `cfgArbolLector_` unas líneas más abajo, por el mismo motivo.
 *
 * **NO se traga su excepción**, al revés que el del árbol. "No pude leer el
 * árbol" se degrada al comportamiento por nombre de siempre; "no pude leer
 * Roles" no se puede degradar a nada — `cfgLookupRole_` la captura arriba y
 * devuelve su fallback con `warning`, que es lo de siempre. Tragarla aquí
 * convertiría un fallo transitorio del Excel en un rol vacío silencioso.
 */
function cfgRolesLector_() {
  var memo;
  var fallo;
  return function () {
    // El fallo también se memoiza: sin esto, dos consumidores tras un error
    // transitorio harían dos lecturas caras y el conteo de etapas diría
    // `roles ×2` para una hoja que no se llegó a leer ni una vez.
    if (fallo) { throw fallo; }
    if (memo !== undefined) { return memo; }
    try { memo = cfgLeerHojaRoles_(); }
    catch (err) { fallo = err; throw err; }
    return memo;
  };
}

/**
 * Estampa un S-ID nuevo en la fila del árbol. NO toma el lock: lo tienen ya sus
 * dos llamantes (`cfgActionResolveSid_` y el grant), y ahí está la trampa —
 * el grant escribe en DOS tablas (árbol y Sheet de Roles) y las dos escrituras
 * tienen que caber en el MISMO lock, o entre ellas cabe otra ejecución.
 */
function cfgAsignarSidEnArbol_(arbol, fila) {
  var sid = cfgFormatSid_(cfgSiguienteSid_(arbol.rows));
  cfgEscribirCelda_(arbol.sh, fila.rowIndex, arbol.sidCol, sid);
  // VOLCAR AQUÍ MISMO, pegado a la escritura (#390 · #416). `setValue` deja el
  // dato en el buffer de Apps Script, y soltar el lock sin volcarlo abre esta
  // ventana: dos ejecuciones sobre la MISMA caja — A entra, acuña S050 y sale
  // sin volcar; B entra, relee el árbol, NO ve el S050 y —como `SID_HIGH_WATER`
  // ya subió— tampoco repite el número: acuña S051. Dos S-ID para una caja, dos
  // carpetas en Drive, y la que pierda la carrera queda huérfana con specs
  // dentro. Sin la marca de agua los dos cálculos daban el mismo número y el
  // choque era inocuo; con ella hay que volcar.
  //
  // Vive DENTRO de esta función y no en sus llamantes, y eso es #416: cuando el
  // volcado estaba en el camino feliz del grant, un alta que materializaba la
  // caja y luego DENEGABA (fila de admin, o el guard anti peer-takeover) se
  // llevaba el S-ID acuñado, el registro reescrito y la fila de auditoría… y
  // soltaba el mutex sin volcar nada. Una operación que responde `ok:false`
  // dejaba tres efectos permanentes y la ventana abierta. Aquí no hay camino
  // que se lo salte: estampar un S-ID INCLUYE publicarlo.
  //
  // El `ScriptLock` no protege de esto: la ventana es el buffer, no la sección
  // crítica.
  cfgFlushSheet_();
  fila.sid = sid;
  return sid;
}

/**
 * La caja sobre la que opera un grant/revoke, resuelta a par (S-ID, nombre)
 * **contra el ÁRBOL, que es la tabla maestra**.
 *
 * El `sid` del payload NO se cree: se busca su fila y su nombre tiene que casar
 * el `boxName`. Es la misma regla que el drenaje aplica desde #359 §4, aquí
 * también sobre el Sheet — porque el Sheet es lo que gatea, y el drenaje solo
 * protege lo que llega a Drive. Creerlo era el agujero: la potestad se comprueba
 * contra `boxName` y la escritura usa `sid`, los dos elegidos por el llamante.
 *
 * Sin `sid` se resuelve el nombre, y ahí solo hay dos respuestas buenas: una
 * fila → se usa (materializándola si no tiene S-ID y `materializar`), o se
 * DENIEGA. Elegir entre dos homónimas *es* el bug; y en un revoke, seguir por
 * nombre sobre una celda ya migrada sería un no-op respondiendo "retirado", que
 * es peor que un error.
 *
 * Devuelve DOS formas del S-ID y no es manía: `sid` va NORMALIZADO (`S49` →
 * `S049`) porque es con lo que se comparan y escriben las celdas, y `sidDrive`
 * sale SIEMPRE de la fila del árbol, porque con él se localiza la carpeta y la
 * carpeta se llama como diga el árbol. Normalizar el que viaja a Drive
 * convertiría un `S49` escrito a mano en una carpeta duplicada — es #363, y esta
 * tarea no lo empeora; tomarlo del payload lo empeoraría igual.
 */
function cfgCajaObjetivo_(boxName, sidCrudo, arbol, materializar) {
  var boxKey = cfgNormBox_(boxName);
  var sid = cfgNormSid_(sidCrudo);
  var leido = arbol ? arbol() : null;
  if (!leido) {
    // `infra:true` viaja desde aquí, que es donde se SABE que la causa fue no
    // poder leer y no una decisión sobre el llamante (#417). Sin él, los tres
    // consumidores de abajo lo auditan como `denegado` y un timeout del árbol
    // fabrica una señal de escalada contra un operador legítimo.
    return { ok: false, infra: true, error: 'No se pudo leer el árbol de cajas — reintenta en un momento.' };
  }
  if (sid) {
    for (var s = 0; s < leido.rows.length; s++) {
      if (cfgNormSid_(leido.rows[s].sid) !== sid) { continue; }
      if (cfgNormBox_(leido.rows[s].servicio) !== boxKey) {
        return {
          ok: false,
          // El nombre ACTUAL viaja en un campo aparte y el TEXTO no lo lleva: es
          // el estado seguro por defecto (#425). Este return lo alcanza cualquier
          // cuenta del dominio ANTES de que se compruebe la potestad, así que
          // meterlo en el mensaje sin condición convertiría el error en un
          // oráculo: barrer S001..S999 con un `boxName` cualquiera reconstruiría
          // el árbol de cajas entero. Lo compone quien ya ha comprobado que el
          // llamante podía ver esa caja; si alguien añade un llamante nuevo y se
          // olvida, el peor caso es un mensaje pobre, nunca una fuga.
          nombreActual: leido.rows[s].servicio,
          error: 'El S-ID ' + sid + ' no es el de la caja "' + boxName + '" — vuelve a abrir la caja desde el explorador.',
        };
      }
      return {
        ok: true, sid: sid, sidDrive: String(leido.rows[s].sid || '').trim(),
        boxKey: boxKey, boxName: leido.rows[s].servicio, materializado: false,
      };
    }
    return { ok: false, error: 'El S-ID ' + sid + ' no existe en el árbol de cajas.' };
  }
  var filas = [];
  for (var i = 0; i < leido.rows.length; i++) {
    if (cfgNormBox_(leido.rows[i].servicio) === boxKey) { filas.push(leido.rows[i]); }
  }
  if (filas.length === 0) {
    return { ok: false, error: 'La caja "' + boxName + '" no está en el árbol de cajas.' };
  }
  if (filas.length > 1) {
    return {
      ok: false,
      error: 'Hay ' + filas.length + ' cajas llamadas "' + boxName + '" y no sé cuál es: vuelve a abrir la caja desde el explorador para que viaje su S-ID.',
    };
  }
  var fila = filas[0];
  var suyo = cfgNormSid_(fila.sid);
  if (suyo) {
    return {
      ok: true, sid: suyo, sidDrive: String(fila.sid || '').trim(),
      boxKey: boxKey, boxName: fila.servicio, materializado: false,
    };
  }
  // Sin S-ID y sin materializar (revoke): no puede haber celdas con el S-ID de
  // esta caja, así que el camino por nombre es completo, no una degradación.
  if (!materializar) {
    return { ok: true, sid: '', sidDrive: '', boxKey: boxKey, boxName: fila.servicio, materializado: false };
  }
  var nuevo = cfgAsignarSidEnArbol_(leido, fila);
  return {
    ok: true, sid: nuevo, sidDrive: nuevo, boxKey: boxKey,
    boxName: fila.servicio, materializado: true, filas: leido.rows,
  };
}

// ── Rastro de auditoría PERSISTENTE ──────────────────────────────────────────
//
// Antes de esto, quién concedía qué se reconstruía de dos formas, y las dos se
// pierden con este cambio:
//   - el historial de versiones del Excel (ahora todas las escrituras del Sheet
//     las hace el propietario, así que dejarían de distinguir al autor real);
//   - `Logger.log`, que CADUCA — no vale como rastro de accesos.
//
// Así que el rastro se persiste en un spreadsheet propio. Dos propiedades
// hacen que sirva de verdad:
//   1. Registra el llamante REAL (`cfgCaller_`, identidad de Google, no un
//      campo del payload) y por qué vía se identificó.
//   2. Vive donde los auditados NO pueden leerlo ni tocarlo: lo escribe
//      ConfigData como propietario y el fichero no se comparte con nadie. Es
//      justo lo que hoy falla en `User-Connections`, donde todos son editores y
//      el audit es borrable y falsificable.
//
// Se registran también los INTENTOS DENEGADOS: un champion intentando acuñar a
// otro champion es la señal más valiosa que puede dar este log.
//
// NUNCA lanza POR UN FALLO DE ESCRITURA: un fallo de auditoría no puede tumbar
// un grant legítimo. Pero se devuelve el resultado para que el llamante lo vea
// en el warning.
//
// Sí lanza si se le llama desde la implementación PÚBLICA (`cfgAssertPrivileged_`
// es su primera sentencia, fuera del try). Ese camino no existe en ningún flujo
// legítimo —`cfgDispatch_` ya afirmó antes— salvo en `assertSinSuplantacion_`,
// que lo llama envuelto en try/catch justamente para poder dejar constancia del
// rechazo desde la privilegiada sin romperse en la pública.

// Neutraliza una celda del rastro ANTES de escribirla.
//
// `appendRow` interpreta como FÓRMULA VIVA cualquier cadena que empiece por
// `=`, `+`, `-` o `@`. Varios campos que se auditan vienen del payload sin
// pasar por ningún validador — y el camino más fácil es el de DENEGACIÓN, que
// se audita a propósito: basta con una cuenta del dominio permitido, sin fila
// en el Sheet, mandando `metaWrite` con `folder: '=IMPORTXML("https://…"&…)'`.
// Esa fórmula se evalúa en el servidor sin que nadie abra la hoja y saca fuera
// el rastro entero — precisamente el fichero que este diseño declara ilegible
// para todos. El prefijo `'` obliga a Sheets a tratarlo como texto.
//
// El recorte a 500 caracteres evita además que un campo enorme reviente la
// fila; el rastro registra QUÉ se intentó, no un volcado del payload.
function cfgAuditCell_(v) {
  var s = String(v == null ? '' : v);
  if (s.length > 500) { s = s.slice(0, 500) + '…'; }
  return /^[=+\-@\t\r]/.test(s) ? "'" + s : s;
}

// Fecha actual en ISO 8601 con offset de Madrid.
//
// NUNCA `toISOString()`: devuelve UTC con sufijo `Z` y el admin ve la hora 1-2h
// antes de la real (bug #86). En el destino nuevo tiene una segunda
// consecuencia peor: la pestaña del rastro se elige por la fecha del evento, y
// con UTC las dos primeras horas de cada día 1 se archivarían en el mes
// anterior.
function cfgNowMadridIso_() {
  return Utilities.formatDate(new Date(), 'Europe/Madrid', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

// Recorte defensivo de un campo que va al buzón del rastro.
//
// El escapado de fórmulas NO se hace aquí a propósito: lo aplica
// `cfgAuditCell_` en el consolidador, justo antes del `setValues`. Hacerlo en
// los dos sitios dejaría un apóstrofo visible dentro de la celda.
function cfgTrailField_(v) {
  var s = String(v == null ? '' : v);
  return s.length > 500 ? s.slice(0, 500) + '…' : s;
}

// Traduce una entrada de acceso al formato de evento del rastro y la deja en el
// buzón.
//
// `roleBefore`, `roleAfter` y `reason` no tienen columna propia allí —las 13
// son comunes a TODOS los eventos, y añadir tres para un solo emisor obligaría
// a tocar el consolidador—, así que se pliegan en `detail`. Es la única pérdida
// de forma del movimiento, y se lee igual de bien en la celda.
//
// El `actor` lo pone este proyecto porque lo sabe de verdad (`cfgCaller_`:
// sesión, o token validado contra `userinfo`), igual que `cfgActionTrailBatch_`
// lo pone para los lotes del plugin. En ninguno de los dos caminos lo elige el
// cliente — en cuanto eso pase, el rastro vale lo que valía `User-Connections`.
function cfgAuditToInbox_(inboxId, entry) {
  var e = entry || {};
  var matices = [];
  if (e.roleBefore || e.roleAfter) {
    matices.push('rol:' + (e.roleBefore || '-') + '->' + (e.roleAfter || '-'));
  }
  if (e.reason) { matices.push('motivo:' + e.reason); }

  var ahora = cfgNowMadridIso_();
  var registro = {
    actor: cfgTrailField_(e.actor),
    via: cfgTrailField_(e.via),
    receivedAt: ahora,
    events: [{
      at: ahora,
      action: cfgTrailField_(e.action),
      result: cfgTrailField_(e.result) || 'ok',
      box: cfgTrailField_(e.box),
      sid: cfgTrailField_(e.sid),
      target: cfgTrailField_(e.target),
      detail: cfgTrailField_(matices.join(' ')),
      model: '',
      pluginVersion: '',
      env: ''
    }]
  };
  var nombre = String(new Date().getTime()) + '-' + Utilities.getUuid() + '.json';
  return cfgTrailWriteInbox_(inboxId, nombre, JSON.stringify(registro));
}

// CUARTO punto de escritura a Drive de ConfigData (ver el invariante de la
// cabecera; el quinto es `cfgTrailTrashFile_`). Solo deja ficheros en el buzón
// del rastro; no lee, no borra y no toca ninguna otra carpeta.
function cfgTrailWriteInbox_(inboxId, nombre, contenido) {
  try {
    DriveApp.getFolderById(inboxId).createFile(nombre, contenido, MimeType.PLAIN_TEXT);
    return true;
  } catch (err) {
    Logger.log('cfgTrailWriteInbox_ falló: ' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

// Deja constancia de una acción de acceso. Dos destinos posibles (#283·4):
//
//  1. Con `TRAIL_INBOX_FOLDER_ID` configurada, la fila NO se escribe aquí: se
//     deja como un fichero suelto en el buzón, y el consolidador de
//     AdoptionTrail —ÚNICO escritor de la hoja— la vuelca con las demás. Un
//     solo escritor, un solo formato de fila y una sola rotación mensual, en
//     vez de dos hojas que había que cruzar a mano.
//
//     No se hace un salto HTTP a AdoptionTrail, aunque sería lo obvio: esta
//     función corre DENTRO del lock del grant, y meter una petición de red en
//     el camino crítico de permisos alargaría el lock para toda la plantilla.
//     Dejar un fichero es O(1) y ConfigData ya corre como el propietario.
//
//  2. Sin esa property —deployments donde AdoptionTrail todavía no existe— se
//     mantiene el `appendRow` de siempre sobre `AUDIT_SHEET_ID`. Ese fallback
//     es lo que permite desplegar los dos proyectos en olas distintas sin una
//     ventana en la que los accesos no queden registrados en ningún sitio.
//
// Si el buzón está configurado pero falla, se cae al fallback igualmente: un
// grant o un revoke no puede quedarse sin constancia porque el rastro nuevo
// esté mal configurado. La durabilidad gana a la pureza de "un solo escritor",
// y la línea del Logger delata la caída.
function cfgAudit_(entry) {
  cfgAssertPrivileged_();
  // Etapa APARTE de `escritura`, y no es una manía: esto abre un libro distinto
  // (el buzón del rastro, o `AUDIT_SHEET_ID` si el buzón no está configurado).
  // Sumarla a la escritura de Roles escondería cuál de las dos cuesta, que es
  // justo la pregunta — porque una se arregla acotando la sección crítica y la
  // otra sacando el rastro del camino caliente.
  //
  // Se mide POR DENTRO y no en los llamantes: el rastro lo escriben también los
  // RECHAZOS (`cfgDeny_`), y medir por fuera dejaría fuera precisamente el
  // camino que nadie se acuerda de instrumentar.
  var t = Date.now();
  try {
    var props = PropertiesService.getScriptProperties();
    var inboxId = props.getProperty('TRAIL_INBOX_FOLDER_ID') || '';
    if (inboxId) {
      if (cfgAuditToInbox_(inboxId, entry)) { return true; }
      Logger.log('cfgAudit_: el buzón del rastro falló — la fila va a la hoja clásica.');
    }

    var auditId = props.getProperty('AUDIT_SHEET_ID') || '';
    if (!auditId) { return false; }
    var tab = props.getProperty('AUDIT_SHEET_NAME') || 'Auditoria';
    var ss = SpreadsheetApp.openById(auditId);
    var sh = ss.getSheetByName(tab);
    if (!sh) { sh = ss.insertSheet(tab); }
    if (sh.getLastRow() === 0) {
      sh.appendRow(['Timestamp', 'Actor', 'Via', 'Accion', 'Resultado', 'Objetivo', 'Caja', 'S-ID', 'Rol antes', 'Rol despues', 'Motivo']);
    }
    sh.appendRow([
      // Madrid, no UTC: mismo criterio que el buzón, para que las filas de
      // antes y después del corte se puedan comparar sin convertir a mano.
      cfgNowMadridIso_(),
      cfgAuditCell_(entry.actor),
      cfgAuditCell_(entry.via),
      cfgAuditCell_(entry.action),
      cfgAuditCell_(entry.result),
      cfgAuditCell_(entry.target),
      cfgAuditCell_(entry.box),
      cfgAuditCell_(entry.sid),
      cfgAuditCell_(entry.roleBefore),
      cfgAuditCell_(entry.roleAfter),
      cfgAuditCell_(entry.reason),
    ]);
    return true;
  } catch (err) {
    Logger.log('cfgAudit_ falló (' + (entry && entry.action) + '): ' + (err && err.message ? err.message : String(err)));
    return false;
  } finally {
    cfgPerfSumar_('auditoria', Date.now() - t);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  Rastro de ADOPCIÓN (#283 · #313) — el buzón y su consolidador
// ═════════════════════════════════════════════════════════════════════════════
//
// POR QUÉ VIVE AQUÍ Y NO EN UN PROYECTO APARTE (reversión razonada de #283)
// ------------------------------------------------------------------------
// AdoptionTrail nació como proyecto separado para que su carga no compitiera
// por el cupo de ejecuciones simultáneas del propietario. Pero la puerta de un
// web app solo acepta tokens de SU MISMO proyecto GCP (la lección de #292), y
// el plugin solo tiene el token que acuñó el proyecto principal: cada lote
// moría en la puerta con 403/404 sin ejecutar nada (#313). El camino caliente
// tiene que entrar por aquí SÍ o SÍ; lo único que la fusión añade de más es el
// consolidador — 1 ejecución cada 10 min de una sola cuenta, secuencial, con
// presupuesto propio y exclusión por LEASE (ver cfgConsolidarRastro). Eso no
// compite con el login de nadie.
//
// CÓMO EVITA LA CONCURRENCIA (no la serializa: la elimina)
// --------------------------------------------------------
// El camino caliente NO abre la hoja ni toma el lock: cada lote se escribe como
// UN fichero de nombre único en el buzón (`TRAIL_INBOX_FOLDER_ID`, carpeta sin
// compartir con nadie). Dos usuarios simultáneos jamás tocan el mismo fichero.
// `cfgConsolidarRastro` (trigger de 10 min) vuelca el buzón a la hoja como
// ÚNICO escritor, con un `setValues` en bloque por pestaña.
//
// INVARIANTES QUE NO SE NEGOCIAN
// ------------------------------
//  1. El ACTOR lo resuelve el servidor (`cfgCaller_`), NUNCA el payload.
//  2. Este bloque no toca ACLs ni devuelve tokens (los guards del fichero ya
//     lo prohíben; `gas-invariants.js` lo verifica).
//  3. Solo escribe en Drive desde `cfgTrailWriteInbox_` y `cfgTrailTrashFile_`.
//  4. Los lotes se retiran DESPUÉS de escribir sus filas: si el script muere
//     entre medias, el lote se reprocesa y salen filas duplicadas — se prefiere
//     duplicar a perder (#283), porque una fila de más se ve y una de menos no.

/** Columnas de la hoja. `Recibido` va SEPARADA de `Timestamp` a propósito: sin
 *  ella no se distingue un evento viejo drenado tarde de uno recién ocurrido, y
 *  es lo que delata un reloj manipulado (el `Timestamp` lo pone el cliente). */
var CFG_TRAIL_HEADERS_ = [
  'Timestamp', 'Actor', 'Via', 'Accion', 'Resultado', 'Caja', 'S-ID',
  'Objetivo', 'Detalle', 'Modelo', 'Version plugin', 'Entorno', 'Recibido',
];

var CFG_TRAIL_MAX_EVENTS_ = 200;      // por lote; el plugin agrupa de 50 en 50
var CFG_TRAIL_MAX_FILES_PER_PASS_ = 300;
var CFG_TRAIL_BUDGET_MS_ = 4 * 60 * 1000;  // el corte duro de Apps Script son 6 min
/** Property de la lease del consolidador — ver cfgConsolidarRastro. */
var TRAIL_CONSOLIDATOR_LEASE_ = 'TRAIL_CONSOLIDATOR_LEASE';

// ── Idempotencia del lote (#311) ─────────────────────────────────────────────
//
// El plugin manda cada lote con un `batchId` que SOBREVIVE a los reenvíos: si
// la respuesta se pierde (timeout del cliente con el fichero ya escrito), el
// siguiente drenaje repite el MISMO tramo con el MISMO id. Aquí eso se vuelve
// deduplicable en tres capas, de la más barata a la más robusta:
//
//  1. El nombre del fichero del buzón es determinista (`trail_<id>.json`): un
//     reenvío con el original todavía en el buzón se detecta con UNA lectura
//     de Drive y responde `ok, dedup:true` sin escribir nada.
//  2. Si el original ya se consolidó (y su fichero está en la papelera), lo
//     recuerda `TRAIL_CONSUMED_BATCHES`: una property con los ids volcados
//     recientemente. La escribe SOLO el consolidador (único escritor, bajo su
//     lease); el camino caliente solo la lee.
//  3. Si aun así entran dos ficheros con el mismo id (dos POSTs simultáneos
//     ganando ambos la carrera del punto 1), el consolidador vuelca UNO y
//     retira los dos.
//
// Un lote SIN batchId (plugin anterior a este cambio) sigue el camino de
// siempre: nombre aleatorio y sin dedup. Preferimos duplicar a perder — pero
// solo cuando no hay forma de saber que es un duplicado.
var TRAIL_CONSUMIDOS_PROP_ = 'TRAIL_CONSUMED_BATCHES';
/** La memoria de consumidos se poda por edad Y POR BYTES del JSON serializado:
 *  el límite real de una Script Property son ~9 KB por valor, y un tope por
 *  NÚMERO de entradas miente — 200 UUIDs ya pasan de 9 KB, y el saneado admite
 *  ids de hasta 64 chars. Si `setProperty` lanzara por tamaño, el catch lo
 *  tragaría y el dedup moriría EN SILENCIO justo bajo carga: por eso se poda a
 *  8 KB con margen, soltando los más viejos. 24 h cubre el reenvío más tardío
 *  realista (portátil suspendido con el lote en vuelo). */
var TRAIL_CONSUMIDOS_TTL_MS_ = 24 * 60 * 60 * 1000;
var TRAIL_CONSUMIDOS_MAX_BYTES_ = 8 * 1024;

/** `batchId` saneado, o '' si no vale. Estricto a propósito: acaba en un nombre
 *  de fichero y en una property — nada de él puede ser interpretable. */
function cfgTrailBatchId_(raw) {
  var id = String(raw || '').trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : '';
}

function cfgTrailNombreLote_(batchId) {
  return 'trail_' + batchId + '.json';
}

/** ¿Sigue el lote original en el buzón? Lectura, no escritura: no entra en el
 *  invariante de los cinco puntos de escritura. */
function cfgTrailLoteEnBuzon_(inboxId, nombre) {
  try {
    return DriveApp.getFolderById(inboxId).getFilesByName(nombre).hasNext();
  } catch (err) {
    // Buzón ilegible → no se puede afirmar el duplicado. Se deja escribir: el
    // consolidador aún deduplica por id, y "preferimos duplicar a perder".
    return false;
  }
}

/** Mapa `batchId → ms de consolidación` de los lotes ya volcados. */
function cfgTrailConsumidosLeer_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(TRAIL_CONSUMIDOS_PROP_) || '';
    if (!raw) { return {}; }
    var mapa = JSON.parse(raw);
    if (mapa && typeof mapa === 'object') { return mapa; }
    // Sin la línea del Logger, una property corrupta desactiva el dedup de
    // forma indistinguible de "memoria vacía" — y los duplicados de #311
    // volverían sin ninguna pista de por dónde.
    Logger.log('cfgTrailConsumidosLeer_: ' + TRAIL_CONSUMIDOS_PROP_ + ' no es un objeto — dedup de consumidos vacío hasta la próxima pasada.');
    return {};
  } catch (err) {
    Logger.log('cfgTrailConsumidosLeer_: ' + TRAIL_CONSUMIDOS_PROP_ + ' ilegible (' + (err && err.message ? err.message : String(err)) + ') — dedup de consumidos vacío hasta la próxima pasada.');
    return {};
  }
}

/**
 * Apunta ids recién consolidados en la memoria de consumidos, podando por edad
 * y tamaño. La llama SOLO `cfgTrailConsolidar_` tras retirar los ficheros — un
 * id apuntado sin sus filas escritas sería pérdida disfrazada de dedup.
 */
function cfgTrailConsumidosApuntar_(ids) {
  if (!ids || ids.length === 0) { return; }
  try {
    var ahora = new Date().getTime();
    var mapa = cfgTrailConsumidosLeer_();
    for (var i = 0; i < ids.length; i++) { mapa[ids[i]] = ahora; }
    // Poda por edad…
    var vivos = [];
    for (var id in mapa) {
      if (!Object.prototype.hasOwnProperty.call(mapa, id)) { continue; }
      if (ahora - Number(mapa[id] || 0) <= TRAIL_CONSUMIDOS_TTL_MS_) { vivos.push([id, Number(mapa[id] || 0)]); }
    }
    // …y por BYTES del JSON resultante, quedándose con los MÁS recientes hasta
    // caber. El coste por entrada es exacto porque el saneado del id garantiza
    // que JSON.stringify no escapa nada: `"<id>":<ms>` más la coma.
    vivos.sort(function (a, b) { return b[1] - a[1]; });
    var out = {};
    var talla = 2;   // los corchetes '{}' del JSON
    for (var v = 0; v < vivos.length; v++) {
      var coste = vivos[v][0].length + 2 + 1 + String(vivos[v][1]).length + (v > 0 ? 1 : 0);
      if (talla + coste > TRAIL_CONSUMIDOS_MAX_BYTES_) { break; }
      out[vivos[v][0]] = vivos[v][1];
      talla += coste;
    }
    PropertiesService.getScriptProperties().setProperty(TRAIL_CONSUMIDOS_PROP_, JSON.stringify(out));
  } catch (err) {
    Logger.log('cfgTrailConsumidosApuntar_ falló: ' + (err && err.message ? err.message : String(err)));
  }
}

/**
 * Acepta un lote del plugin (`action: 'trailBatch'`) y lo deja en el buzón.
 * NO abre la hoja ni toma el lock: es el camino caliente y tiene que ser O(1)
 * y sin contención (el dedup de #311 añade una lectura de property y una de
 * Drive, ambas O(1) — sigue sin haber hoja ni lock). El guard de dominio ya lo
 * aplicó `cfgCaller_`.
 */
function cfgActionTrailBatch_(caller, payload) {
  var inboxId = PropertiesService.getScriptProperties().getProperty('TRAIL_INBOX_FOLDER_ID') || '';
  if (!inboxId) {
    // `ok:true` A PROPÓSITO (entorno sin buzón, p. ej. BBVA recién encendido):
    // un `ok:false` es un rechazo razonado, gastaría intento en el plugin y a
    // los cinco descartaría el lote. Con `ok:true` el plugin retira el lote sin
    // acumular cola, y el rastro es un no-op silencioso hasta que haya buzón.
    return { ok: true, accepted: 0, disabled: true };
  }

  var eventos = (payload && payload.events) || [];
  if (Object.prototype.toString.call(eventos) !== '[object Array]') {
    return { ok: false, error: 'events debe ser un array' };
  }
  if (eventos.length === 0) { return { ok: true, accepted: 0 }; }
  var descartados = 0;
  if (eventos.length > CFG_TRAIL_MAX_EVENTS_) {
    descartados = eventos.length - CFG_TRAIL_MAX_EVENTS_;
    eventos = eventos.slice(0, CFG_TRAIL_MAX_EVENTS_);
  }

  var limpios = [];
  for (var i = 0; i < eventos.length; i++) {
    var ev = eventos[i] || {};
    // Sin acción no hay nada que registrar; se descarta en vez de escribir una
    // fila muda que luego nadie sabe interpretar.
    if (!ev.action) { descartados++; continue; }
    limpios.push({
      at: cfgTrailField_(ev.at),
      action: cfgTrailField_(ev.action),
      result: cfgTrailField_(ev.result) || 'ok',
      box: cfgTrailField_(ev.box),
      sid: cfgTrailField_(ev.sid),
      target: cfgTrailField_(ev.target),
      detail: cfgTrailField_(ev.detail),
      model: cfgTrailField_(ev.model),
      pluginVersion: cfgTrailField_(ev.pluginVersion),
      env: cfgTrailField_(ev.env),
    });
  }
  if (limpios.length === 0) { return { ok: true, accepted: 0, dropped: descartados }; }

  // Idempotencia (#311): con batchId válido, un reenvío se reconoce ANTES de
  // escribir — por la memoria de consumidos si el original ya se volcó, o por
  // el nombre determinista si sigue en el buzón. En ambos casos se responde
  // `ok` (con `dedup` para el log del plugin) y la cola del cliente se vacía.
  var batchId = cfgTrailBatchId_(payload && payload.batchId);
  if (batchId) {
    // hasOwnProperty y no lookup directo: el objeto sale de JSON.parse y un id
    // forjado "constructor"/"toString" (pasa el regex) daría truthy contra el
    // prototype — dedup:true de un lote que nunca existió.
    if (Object.prototype.hasOwnProperty.call(cfgTrailConsumidosLeer_(), batchId)) {
      return { ok: true, accepted: limpios.length, dropped: descartados, dedup: true };
    }
    if (cfgTrailLoteEnBuzon_(inboxId, cfgTrailNombreLote_(batchId))) {
      return { ok: true, accepted: limpios.length, dropped: descartados, dedup: true };
    }
  }

  var registro = {
    actor: caller.email,   // ← del SERVIDOR (cfgCaller_), nunca del payload
    via: caller.via,
    receivedAt: cfgNowMadridIso_(),
    batchId: batchId,
    events: limpios,
  };

  var nombre = batchId
    ? cfgTrailNombreLote_(batchId)
    : String(new Date().getTime()) + '-' + Utilities.getUuid() + '.json';
  if (!cfgTrailWriteInbox_(inboxId, nombre, JSON.stringify(registro))) {
    // `retriable:true`: el fichero NO llegó a escribirse (createFile lanzó),
    // así que reintentar no puede duplicar filas. Sin la marca, el plugin lo
    // trataría como rechazo razonado y descartaría el lote al 5º hipo de
    // Drive — contra el invariante "preferimos duplicar a perder".
    return { ok: false, retriable: true, error: 'No se pudo escribir el lote en el buzón' };
  }
  return { ok: true, accepted: limpios.length, dropped: descartados };
}

/** Pestaña destino a partir del instante del EVENTO, en hora de Madrid.
 *
 *  Por qué del evento y no de hoy: un lote drenado el día 1 puede traer eventos
 *  del 31, y tienen que caer en el mes que les toca. Y por qué Madrid y no UTC:
 *  con `toISOString()` las dos primeras horas de cada día 1 se archivarían en
 *  el mes anterior — el bug #86 otra vez, ahora en el corte de pestaña. */
function cfgTrailMonthTab_(iso, fallbackMs) {
  var ms = Date.parse(iso);
  if (isNaN(ms)) { ms = fallbackMs; }
  return Utilities.formatDate(new Date(ms), 'Europe/Madrid', 'yyyy-MM');
}

/** QUINTO punto de escritura a Drive (ver el invariante de la cabecera): retira
 *  un lote ya consolidado. A la PAPELERA, nunca definitivo. */
function cfgTrailTrashFile_(file) {
  file.setTrashed(true);
}

/**
 * Vuelca el buzón a la hoja del rastro. Lo dispara un trigger temporal (cada
 * 10 min, `cfgInstalarTriggerRastro`) y es el ÚNICO escritor de las pestañas
 * mensuales.
 *
 * EXCLUSIÓN POR LEASE, NO RETENIENDO EL ScriptLock. `getScriptLock()` es UN
 * mutex por proyecto — el MISMO que toman grant, revoke, resolveSid y
 * metaWrite con `waitLock(30000)`. Retenerlo durante la pasada (hasta 4 min
 * con backlog) haría fallar todos esos caminos de usuario cada 10 minutos: es
 * exactamente lo que el AdoptionTrail separado evitaba y avisaba ("a
 * diferencia de lo que pasaría dentro de ConfigData"). Aquí el lock se toma un
 * INSTANTE para comprobar/estampar la lease (`TRAIL_CONSOLIDATOR_LEASE_`) y se
 * suelta antes de tocar Drive o la hoja: la pasada corre sin bloquear a nadie,
 * y dos pasadas solapadas (trigger + Run manual) se excluyen por la lease. Si
 * el script muere sin limpiar la lease, caduca sola (presupuesto + margen) y
 * como mucho se salta una pasada.
 *
 * El assert va PRIMERO y no es decorativo: abre un spreadsheet, así que está en
 * `ABRE_EXCEL` (gas-invariants) — desde la implementación pública, o con
 * `OWNER_EMAIL` sin poner, esto LANZA en vez de ejecutar.
 */
function cfgConsolidarRastro() {
  cfgAssertPrivileged_();
  var props = PropertiesService.getScriptProperties();
  var inboxId = props.getProperty('TRAIL_INBOX_FOLDER_ID') || '';
  var sheetId = props.getProperty('TRAIL_SHEET_ID') || '';
  if (!inboxId || !sheetId) {
    Logger.log('cfgConsolidarRastro: TRAIL_INBOX_FOLDER_ID o TRAIL_SHEET_ID sin configurar — no-op.');
    return { ok: false, error: 'sin configurar' };
  }

  var lock = LockService.getScriptLock();
  try { cfgTomarLock_(lock, 10000); }
  catch (e) {
    Logger.log('cfgConsolidarRastro: no se pudo comprobar la lease — se salta.');
    return { ok: false, error: 'lock' };
  }
  try {
    var ahora = new Date().getTime();
    var lease = Number(props.getProperty(TRAIL_CONSOLIDATOR_LEASE_) || '0');
    if (lease > ahora) {
      Logger.log('cfgConsolidarRastro: otra pasada en curso (lease viva) — se salta.');
      return { ok: false, error: 'lease' };
    }
    props.setProperty(TRAIL_CONSOLIDATOR_LEASE_, String(ahora + CFG_TRAIL_BUDGET_MS_ + 60000));
  } finally {
    lock.releaseLock();
  }

  try {
    return cfgTrailConsolidar_(SpreadsheetApp.openById(sheetId), inboxId);
  } finally {
    // Limpiar SIEMPRE, también si la pasada lanza: una lease huérfana solo
    // caduca sola tras presupuesto + margen, y eso es una pasada perdida.
    try { props.setProperty(TRAIL_CONSOLIDATOR_LEASE_, '0'); } catch (eLease) { /* caduca sola */ }
  }
}

/**
 * El cuerpo de la consolidación. Recibe la hoja YA abierta a propósito: la
 * apertura vive solo en `cfgConsolidarRastro`, que es quien afirma el
 * privilegio — así el verbo de apertura aparece en UNA función y el invariante
 * `ABRE_EXCEL` la cubre entera.
 *
 * Presupuesto: corta a los 4 min o a los 300 ficheros y deja el resto para la
 * pasada siguiente. Los ficheros se retiran DESPUÉS de escribir sus filas.
 */
function cfgTrailConsolidar_(ss, inboxId) {
  var inicio = new Date().getTime();
  var it = DriveApp.getFolderById(inboxId).getFiles();
  var porMes = {};        // 'yyyy-MM' → filas
  var consumidos = [];
  var lotes = 0;
  var eventos = 0;
  var corrompidos = 0;
  var agotado = false;
  var duplicados = 0;
  /** Ids volcados en pasadas anteriores (memoria persistente) y en ESTA. */
  var consumidosPrevios = cfgTrailConsumidosLeer_();
  var vistosEnPasada = {};

  while (it.hasNext()) {
    if (lotes >= CFG_TRAIL_MAX_FILES_PER_PASS_ || new Date().getTime() - inicio > CFG_TRAIL_BUDGET_MS_) {
      agotado = true;
      break;
    }
    var file = it.next();
    var registro = null;
    try { registro = JSON.parse(file.getBlob().getDataAsString()); }
    catch (err) { registro = null; }

    if (!registro || !registro.events) {
      // Un lote ilegible no puede quedarse dando vueltas para siempre: se
      // cuenta y se retira, o bloquea el buzón en cada pasada.
      corrompidos++;
      consumidos.push(file);
      lotes++;
      continue;
    }

    // Dedup por batchId (#311), tercera capa: dos ficheros con el mismo id en
    // la misma pasada (carrera de dos POSTs simultáneos), o un fichero cuyo id
    // ya se volcó en una pasada anterior (reenvío tardío que ganó la carrera
    // contra el check del camino caliente). Se vuelca UNO; el resto se retira
    // sin volcar. Sin id (lote de un plugin viejo) no hay forma de saber que
    // es duplicado y se vuelca — preferimos duplicar a perder.
    var bid = cfgTrailBatchId_(registro.batchId);
    if (bid && (vistosEnPasada[bid] === true || Object.prototype.hasOwnProperty.call(consumidosPrevios, bid))) {
      duplicados++;
      consumidos.push(file);
      lotes++;
      continue;
    }
    if (bid) { vistosEnPasada[bid] = true; }

    var recibido = String(registro.receivedAt || '');
    var recibidoMs = Date.parse(recibido);
    if (isNaN(recibidoMs)) { recibidoMs = new Date().getTime(); }

    for (var i = 0; i < registro.events.length; i++) {
      var ev = registro.events[i] || {};
      var mes = cfgTrailMonthTab_(ev.at, recibidoMs);
      if (!porMes[mes]) { porMes[mes] = []; }
      porMes[mes].push([
        cfgAuditCell_(ev.at),
        cfgAuditCell_(registro.actor),
        cfgAuditCell_(registro.via),
        cfgAuditCell_(ev.action),
        cfgAuditCell_(ev.result),
        cfgAuditCell_(ev.box),
        cfgAuditCell_(ev.sid),
        cfgAuditCell_(ev.target),
        cfgAuditCell_(ev.detail),
        cfgAuditCell_(ev.model),
        cfgAuditCell_(ev.pluginVersion),
        cfgAuditCell_(ev.env),
        cfgAuditCell_(recibido),
      ]);
      eventos++;
    }
    consumidos.push(file);
    lotes++;
  }

  if (lotes === 0) { return { ok: true, lotes: 0, eventos: 0 }; }

  for (var mes2 in porMes) {
    if (!Object.prototype.hasOwnProperty.call(porMes, mes2)) { continue; }
    cfgTrailAppendRows_(ss, mes2, porMes[mes2]);
  }
  for (var k = 0; k < consumidos.length; k++) {
    try { cfgTrailTrashFile_(consumidos[k]); }
    catch (errDel) { Logger.log('cfgConsolidarRastro: no se pudo retirar un lote — ' + errDel); }
  }

  // La memoria de consumidos se apunta al FINAL, con las filas ya escritas y
  // los ficheros retirados: si el setValues lanza, nada queda apuntado y el
  // reproceso de la siguiente pasada sigue siendo posible. Un id apuntado sin
  // filas sería pérdida disfrazada de dedup.
  var idsPasada = [];
  for (var vb in vistosEnPasada) {
    if (Object.prototype.hasOwnProperty.call(vistosEnPasada, vb)) { idsPasada.push(vb); }
  }
  cfgTrailConsumidosApuntar_(idsPasada);

  var pendientes = agotado ? 'quedan lotes para la próxima pasada' : 'buzón vacío';
  Logger.log('cfgConsolidarRastro: lotes=' + lotes + ' eventos=' + eventos +
    ' corrompidos=' + corrompidos + ' duplicados=' + duplicados + ' — ' + pendientes);
  return { ok: true, lotes: lotes, eventos: eventos, corrompidos: corrompidos, duplicados: duplicados, agotado: agotado };
}

/**
 * Añade filas a la pestaña del mes, creándola si no existe. La creación es al
 * vuelo y NO por un trigger de día 1: cualquier cosa que dependa de que un
 * trigger dispare puntualmente a las 00:00 falla el día que Apps Script se
 * retrase, y entonces el mes nuevo se escribe en la pestaña vieja.
 */
function cfgTrailAppendRows_(ss, tab, filas) {
  var sh = ss.getSheetByName(tab);
  if (!sh) {
    sh = ss.insertSheet(tab);
    sh.appendRow(CFG_TRAIL_HEADERS_);
    sh.setFrozenRows(1);
  }
  // Un solo setValues en bloque: N appendRow serían N round-trips y además es
  // donde aparecen las filas perdidas cuando dos escritores coinciden.
  sh.getRange(sh.getLastRow() + 1, 1, filas.length, CFG_TRAIL_HEADERS_.length).setValues(filas);
}

/** Crea el trigger de consolidación si no existe. Idempotente. Se ejecuta a
 *  mano desde el editor (Run), como `cfgSetupOwner`. */
function cfgInstalarTriggerRastro() {
  var existentes = ScriptApp.getProjectTriggers();
  for (var t = 0; t < existentes.length; t++) {
    if (existentes[t].getHandlerFunction() === 'cfgConsolidarRastro') {
      Logger.log('cfgInstalarTriggerRastro: ya existe — nada que hacer.');
      return;
    }
  }
  ScriptApp.newTrigger('cfgConsolidarRastro').timeBased().everyMinutes(10).create();
  Logger.log('cfgInstalarTriggerRastro: trigger creado (cada 10 min).');
}

// Rol que el email tiene HOY en la caja (para la columna "Rol antes" del audit).
function cfgCurrentRoleInBox_(values, email, boxKey, sid) {
  var rows = cfgRowsForEmail_(values, email);
  var best = '';
  for (var r = 0; r < rows.length; r++) {
    var i = rows[r];
    var rowRole = '';
    if (cfgIsAdminCell_(values[i][3])) { rowRole = 'admin'; }
    else if (cfgCeldaTieneCaja_(String(values[i][4] || ''), sid, boxKey)) { rowRole = 'kdd-champion'; }
    else if (cfgCeldaTieneCaja_(String(values[i][5] || ''), sid, boxKey)) { rowRole = 'kb-steward'; }
    else if (cfgCeldaTieneCaja_(String(values[i][6] || ''), sid, boxKey)) { rowRole = 'kb-contributor'; }
    else if (cfgCeldaTieneCaja_(String(values[i][7] || ''), sid, boxKey)) { rowRole = 'kb-consumer'; }
    // OJO con el `best === ''`: cfgRoleRank_('') NO es -1 sino 1, porque
    // cfgNormRole_ cae a 'kb-contributor' ante una cadena vacía. Comparando a
    // secas, un kb-consumer (rank 0) nunca ganaba y el rastro registraba
    // "ninguno" justo en las bajadas de rol, que son las que hay que vigilar.
    if (rowRole && (best === '' || cfgRoleRank_(rowRole) > cfgRoleRank_(best))) { best = rowRole; }
  }
  return best || 'ninguno';
}

// ── Acciones ─────────────────────────────────────────────────────────────────

// `role` — rol del PROPIO llamante. Nunca el de otro: no hay parámetro de email.
function cfgActionRole_(caller) {
  var roleInfo = cfgLookupRole_(caller.email);
  return { ok: true, email: caller.email, roleInfo: roleInfo };
}

// `recipients` (censo de emails para el workflow de release) se RETIRÓ en #292:
// no lo llamaba ningún workflow de `.github/`, iba por un token compartido en
// vez de por identidad, y era el único camino de este fichero que devolvía el
// censo entero de la plantilla sin preguntar quién llamaba. Si algún día hiciera
// falta, el código está en el histórico — pero no vuelve por token.

// Claves legibles del llamante. Si el Sheet no se pudo leer devuelve ERROR y
// nunca una lista vacía: el plugin cachea el árbol ya filtrado y una lista
// vacía le borraría la caché en un fallo transitorio del Sheet.
//
// **Ya NO es una acción del dispatcher**: su único llamante por el relay era
// `treeReadGate_` de OAuthToken, que se retiró al quedarse sin uso (desde #292
// el recorte lo hace `tree` aquí mismo). Se queda como gate INTERNO de `tree` y
// `resolveSid`; el prefijo `cfgAction` se conserva para no tocar sus llamantes.
// `arbol` es el lector PEREZOSO de la operación en curso. Sus tres llamantes
// (`tree`, `treeRaw` y `resolveSid`) leen el árbol después, así que sin
// compartirlo la misma pestaña se lee DOS veces en una sola ejecución.
function cfgActionReadableKeys_(caller, arbol) {
  var roleInfo = cfgLookupRole_(caller.email, arbol ? { arbol: arbol } : undefined);
  if (roleInfo && roleInfo.warning) {
    return { ok: false, error: 'No se pudo determinar el acceso del usuario: ' + roleInfo.warning };
  }
  // Solo por IDENTIDAD desde la fase C de #365: el recorte por NOMBRE
  // (`cfgReadableKeys_`) se retiró al quedarse sin un solo consumidor — los tres
  // llamantes miran `sids`, y una caja migrada ya no aporta nombre que comparar.
  var sids = cfgReadableSids_(roleInfo);
  return {
    ok: true, sids: sids, isAdmin: sids === null,
    // Viaja para que quien filtre sepa que los nombres SIN MIGRAR de la fila no
    // se pudieron resolver, y no cuente un fallo del árbol como una denegación.
    avisoArbol: (roleInfo && roleInfo.avisoArbol) || '',
  };
}

// `tree` — árbol YA RECORTADO a las cajas legibles del llamante. El recorte se
// hace aquí, server-side: el plugin no puede ampliarlo.
//
// Recorta por IDENTIDAD desde #365: quien tenga S049 deja de ver la fila de la
// otra "Reporting". El nombre solo decide en las cajas que el usuario aún tiene
// sin migrar — si no, resolver un nombre a su S-ID le quitaría de la vista una
// caja que hoy sí ve, que es lo que convierte un cutover en una avería.
function cfgActionTree_(caller) {
  // UN lector para la acción entera: el gate de abajo y el árbol que se sirve
  // son la MISMA tabla. Con dos lectores se hacían dos `getValues()` de la misma
  // pestaña en una sola ejecución.
  var arbol = cfgArbolLector_();
  var gate = cfgActionReadableKeys_(caller, arbol);
  if (!gate.ok) { return gate; }
  try {
    var tree = arbol();
    if (!tree) { return { ok: false, error: 'No se pudo leer el árbol de cajas — reintenta en un momento.' }; }
    var boxes = [];
    for (var i = 0; i < tree.rows.length; i++) {
      var r = tree.rows[i];
      if (gate.sids !== null && !cfgEsCajaLegible_(gate.sids, r.sid, r.servicio)) { continue; }
      boxes.push({ name: r.servicio, areaPath: r.areaPath, levels: r.levels || [], sid: r.sid || '' });
    }
    return { ok: true, version: 2, boxes: boxes };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

/**
 * Texto del par que no casa, diciendo el nombre ACTUAL de la caja SOLO a quien
 * ya podía verla (#425).
 *
 * EL PROBLEMA QUE RESUELVE: tras renombrar una caja en el árbol, el plugin sigue
 * mandando el par viejo desde su caché y el gate deniega — correctamente. Lo que
 * fallaba era el consejo: "vuelve a abrir la caja desde el explorador" es
 * imposible de cumplir, porque esa caja ya no se llama así.
 *
 * POR QUÉ LA CONDICIÓN NO ES OPCIONAL: `cfgCajaObjetivo_` se llama desde el gate
 * ANTES de comprobar la potestad, y a ese camino llega cualquier cuenta del
 * dominio aunque no tenga ni fila en la matriz de roles — por `listBoxUsers` y
 * `boxAcl`, además, SIN dejar rastro de auditoría. Devolver el nombre real sin
 * condición dejaría enumerar S001..S999 y reconstruir el árbol completo, que es
 * justo lo que la acción `tree` recorta por rol desde #293.
 *
 * El criterio es `cfgReadableSids_`, la MISMA función con la que se recorta ese
 * árbol: revelar el nombre a quien ya podía verlo por ahí es una fuga nula.
 * Y por `.sids` a mano, NO por `cfgEsCajaLegible_`: ese cae a `.nombres`, que
 * sale de los tokens sin migrar de la celda del PROPIO llamante, y el `boxName`
 * lo elige él — mandar {boxName:'<su token viejo>', sid:'<S-ID ajeno>'} casaría
 * y reabriría la fuga entera.
 *
 * El texto evita a propósito las palabras que el guarda de copy del plugin trata
 * como fontanería (las sustituiría por un genérico y el mensaje se perdería).
 * Queda un resto: si el nombre de la caja contiene una de ellas, esa caja se
 * queda sin mensaje enriquecido. Es aceptable y no hay forma de evitarlo desde
 * aquí.
 */
function cfgErrorParDivergente_(objetivo, roleInfo, sidObjetivo) {
  var base = objetivo.error;
  var nuevo = String(objetivo.nombreActual || '');
  if (!nuevo || !sidObjetivo) { return base; }
  var visibles = cfgReadableSids_(roleInfo);
  if (visibles !== null && visibles.sids[sidObjetivo] !== true) { return base; }
  return 'El S-ID ' + sidObjetivo + ' ya no es el de esa caja: ahora se llama "' + nuevo +
    '". Refresca el árbol de cajas y vuelve a intentarlo.';
}

/** ¿La caja (S-ID, nombre) entra en el recorte de `cfgReadableSids_`? */
function cfgEsCajaLegible_(legibles, sid, name) {
  if (!legibles) { return true; }                        // null = admin
  var s = cfgNormSid_(sid);
  if (s && legibles.sids[s] === true) { return true; }
  var k = cfgNormBox_(name);
  return !!(k && legibles.nombres[k] === true);
}

// `rolesMatrix` — la matriz CRUDA del Sheet de Roles. ADMIN ONLY.
//
// La consume `syncDrivePermissions` (reconciliación masiva de ACLs, que corre a
// mano como propietario y vive en el proyecto de OAuthToken porque es la que
// tiene los scopes de Drive). Devolver la matriz entera solo a un admin no
// filtra nada: un admin ya ve todas las cajas y todos los roles.
//
// Devuelve también `sheetId` para que el sync pueda NEGARSE a tocar ese fichero
// al repartir la ACL de los ficheros de login. Es la razón de este cambio: ese
// Excel no debe volver a compartirse con nadie.
function cfgActionRolesMatrix_(caller) {
  // GENERACIÓN LO PRIMERO DE TODO (#331), no solo antes del `getValues()` final.
  //
  // El sello tiene que ser cota INFERIOR de la frescura de la foto, y para eso
  // no basta con ir por delante de la ÚLTIMA lectura: tiene que ir por delante de
  // la PRIMERA. `cfgLookupRole_` de aquí abajo abre el Excel y hace un
  // `getValues()` completo, así que con el sello detrás quedaba una ventana de
  // varios round-trips (una apertura, dos properties) entre esa lectura y el
  // sello. Si Apps Script sirviera el segundo `getValues()` desde el snapshot que
  // ya materializó el primero, la foto sería PREVIA a un `revoke` colado ahí y el
  // sello POSTERIOR: la re-comprobación del publicador pasaría y al revocado le
  // seguiría respondiendo la caché hasta el corte de frescura.
  //
  // No hace falta confirmar si ese snapshot existe: leer el contador antes que
  // nada lo convierte en cota inferior GANE QUIEN GANE esa duda, y el coste es el
  // que ya dice el párrafo de abajo — un sello corto solo cuesta publicaciones
  // descartadas de más, y aquí la ventana que se añade es la del gate de rol.
  var genAlLeer = cfgCacheGen_();
  var roleInfo = cfgLookupRole_(caller.email);
  // "No he podido leer" NO es "no eres admin" (#333). `cfgLookupRole_` devuelve el
  // mismo fallback con `isAdmin:false` ante `SHEET_ID` vacía, hoja inexistente y
  // excepción de lectura — y solo el `warning` los distingue. Descartarlo mandaba
  // a quien mirase el log del trigger a revisar la columna D del propietario
  // teniendo una property vacía o el Excel en la papelera. Mismo criterio que
  // `cfgMetaGate_`, que ya lo hace bien.
  if (roleInfo && roleInfo.warning) {
    return { ok: false, error: 'No se pudo leer el Sheet de Roles: ' + roleInfo.warning };
  }
  if (roleInfo.isAdmin !== true) { return { ok: false, error: 'Solo un admin puede leer la matriz de roles.' }; }
  try {
    var sheet = cfgOpenRolesSheet_();
    if (!sheet) { return { ok: false, error: 'Sheet de Roles no configurado (SHEET_ID)' }; }
    // `privateFileIds`: los ficheros de infraestructura que solo deben tener el
    // propietario y los admins — este mismo proyecto y la hoja de auditoría.
    // Salen de aquí y no de una property que haya que mantener a mano: este es
    // el único sitio que los conoce, así que no pueden quedarse desfasados.
    var privateFileIds = [];
    try { privateFileIds.push(ScriptApp.getScriptId()); } catch (eId) { /* sin ScriptApp: se omite */ }
    var auditId = PropertiesService.getScriptProperties().getProperty('AUDIT_SHEET_ID') || '';
    if (auditId) { privateFileIds.push(auditId); }
    // `genAlLeer` se selló en la PRIMERA línea de esta función, y ese orden es
    // TODO el invariante (#325 · #331).
    //
    // El publicador guarda esta foto bajo esa generación y vuelve a mirar el
    // contador antes de escribir: si cambió, descarta. Para que esa comprobación
    // sirva, el sello tiene que ser **cota inferior** de la frescura de la foto —
    // "los datos son al menos tan nuevos como esta generación". Sellar después de
    // cualquier lectura lo convierte en cota SUPERIOR y abre la única carrera que
    // sí filtra: un `revoke` colado por medio (o cuya escritura aún no se haya
    // volcado mientras su `cfgBumpCacheGen_` ya es visible, que es lo normal — las
    // escrituras de hoja van en buffer y `PropertiesService` no) deja una foto
    // PREVIA sellada con la generación POSTERIOR. La re-comprobación del
    // publicador pasa, se publica el censo viejo bajo la generación nueva, y a
    // quien acaban de retirarle la potestad le sigue respondiendo la caché hasta
    // el corte de frescura.
    //
    // Que el sello se quede corto no cuesta nada: una publicación de más que se
    // descarta. Que se pase, cuesta un bypass del gate.
    return {
      ok: true,
      values: cfgLeerHoja_(sheet, 'roles'),
      cacheGen: genAlLeer,
      sheetId: cfgConfig_().sheetId,
      privateFileIds: privateFileIds,
    };
  } catch (err) {
    return { ok: false, error: 'rolesMatrix error: ' + (err && err.message ? err.message : String(err)) };
  }
}

// `treeRaw` — árbol COMPLETO sin recortar. ADMIN ONLY: lo usa el helper manual
// `rebuildRegistryFromTree_` para regenerar el registro.
function cfgActionTreeRaw_(caller) {
  // Un solo lector, igual que en `cfgActionTree_`: el gate de rol y el árbol que
  // se sirve salen de la misma pestaña.
  var arbol = cfgArbolLector_();
  var roleInfo = cfgLookupRole_(caller.email, { arbol: arbol });
  if (roleInfo.isAdmin !== true) { return { ok: false, error: 'Solo un admin puede leer el árbol completo.' }; }
  try {
    var tree = arbol();
    // Todo o nada (#359 §4): el drenaje lo usa como dato maestro y una lista
    // vacía con `ok:true` le haría creer que las cajas son huérfanas.
    if (!tree) { return { ok: false, error: 'No se pudo leer el árbol de cajas — reintenta en un momento.' }; }
    return { ok: true, rows: tree.rows };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
}

// Token compartido opcional de resolveSource (no es identidad — el que va
// horneado en el plugin es forjable; la identidad es siempre cfgCaller_).
function cfgCheckSourcesToken_(given) {
  var props = PropertiesService.getScriptProperties();
  var expected = props.getProperty('SOURCES_TOKEN') || '';
  if (!expected) { return true; }
  given = String(given || '');
  var mismatch = expected.length ^ given.length;
  var len = Math.max(expected.length, given.length);
  for (var i = 0; i < len; i++) {
    var a = i < expected.length ? expected.charCodeAt(i) : 0;
    var b = i < given.length ? given.charCodeAt(i) : 0;
    mismatch |= a ^ b;
  }
  return mismatch === 0;
}

// `resolveSid` — localiza la caja por nombre y asigna su S-ID de forma ATÓMICA
// si no lo tiene (LockService), y regenera `sources-registry.json` él mismo
// (`cfgRegenerateRegistry_`, como propietario, desde #279·#5).
//
// NO devuelve las filas del árbol. Las devolvía cuando el registro lo escribía
// OAuthToken con el token del usuario; ese camino ya no existe y `resolveSource_`
// descarta el campo. Devolverlas ahora sería servir el censo completo (nombre,
// areaPath y S-ID de TODAS las cajas) a quien solo puede leer una — justo el
// recorte que `cfgActionTree_` aplica a propósito.
//
// GATE NUEVO: el llamante tiene que poder LEER la caja. Antes esto solo estaba
// protegido por SOURCES_TOKEN (horneado en el plugin, forjable) → cualquiera
// podía materializar el S-ID de una caja ajena. Es el mismo criterio que
// `tree`/`sources` ya aplicaban desde #250·#9.
/**
 * La fila del árbol de una caja identificada por (nombre, areaPath).
 *
 * Extraída de `cfgActionResolveSid_` porque ahora se necesita DOS veces: una
 * fuera del lock para saber QUÉ caja se está pidiendo (y poder gatearla por
 * S-ID) y otra dentro, sobre una lectura fresca, para materializar el S-ID sin
 * carreras. Devolver el mismo error en los dos sitios importa: si divergieran,
 * el llamante vería "no tienes acceso" donde debería ver "caja ambigua".
 */
function cfgFilaDeCajaPorNombre_(rows, nameKey, areaKey, name) {
  var matches = [];
  for (var i = 0; i < rows.length; i++) {
    if (rows[i].servicio.toLowerCase() === nameKey) { matches.push(rows[i]); }
  }
  if (matches.length === 0) {
    return { ok: false, error: 'Caja no encontrada en el árbol: ' + name };
  }
  if (matches.length > 1) {
    var narrowed = [];
    for (var j = 0; j < matches.length; j++) {
      if (areaKey && matches[j].areaPath.toLowerCase() === areaKey) { narrowed.push(matches[j]); }
    }
    if (narrowed.length !== 1) {
      return { ok: false, error: 'Nombre de caja ambiguo ("' + name + '" aparece en varias cajas) — manda areaPath para desambiguar' };
    }
    matches = narrowed;
  }
  return { ok: true, box: matches[0] };
}

function cfgActionResolveSid_(caller, payload) {
  if (!cfgCheckSourcesToken_(payload && payload.token)) {
    return { ok: false, error: 'Unauthorized (SOURCES_TOKEN)' };
  }
  var name = String((payload && payload.name) || '').trim();
  if (!name) { return { ok: false, error: 'Missing source name' }; }
  var nameKey = name.toLowerCase();
  var areaKey = String((payload && payload.areaPath) || '').trim().toLowerCase();

  // Lector de FUERA del lock: sirve al gate y solo al gate. El de dentro es otro
  // a propósito — ver el comentario de ahí abajo.
  var arbolGate = cfgArbolLector_();
  var gate = cfgActionReadableKeys_(caller, arbolGate);
  if (!gate.ok) { return gate; }
  if (gate.sids !== null) {
    // Gate por IDENTIDAD, igual que `cfgActionTree_`: se resuelve QUÉ caja se
    // está pidiendo y se comprueba su S-ID. Comparar el `name` del payload
    // contra las claves legibles era lo que dejaba pasar a las dos homónimas —
    // y con las celdas ya migradas no habría casado ninguna.
    var leidoGate = arbolGate();
    if (!leidoGate) {
      return { ok: false, error: 'No se pudo leer el árbol de cajas — reintenta en un momento.' };
    }
    var cual = cfgFilaDeCajaPorNombre_(leidoGate.rows, nameKey, areaKey, name);
    if (!cual.ok) { return cual; }
    if (!cfgEsCajaLegible_(gate.sids, cual.box.sid, cual.box.servicio)) {
      // "No pude mirar el árbol" NO es "no tienes acceso" (#333): decirlo mal
      // manda a revisar el Sheet de Roles teniendo el árbol caído.
      if (gate.avisoArbol) {
        return { ok: false, error: 'No se pudo leer el árbol de cajas — reintenta en un momento.' };
      }
      return { ok: false, error: 'No tienes acceso a la caja "' + name + '".' };
    }
  }

  var lock = LockService.getScriptLock();
  try { cfgTomarLock_(lock, 30000); }
  catch (e) { return { ok: false, error: 'Could not acquire lock — retry' }; }

  try {
    // Lector NUEVO, y no el del gate: este camino ESCRIBE el S-ID en el árbol, y
    // la foto del gate se tomó antes de esperar hasta 30 s por el lock. Reusar
    // aquel memo significaría materializar sobre filas viejas y poder emitir un
    // S-ID que otra ejecución acaba de emitir. Mismo criterio que grant/revoke.
    var leido = cfgArbolLector_()();
    if (!leido) { return { ok: false, error: 'No se pudo leer el árbol de cajas — reintenta en un momento.' }; }
    var rows = leido.rows;
    var hallada = cfgFilaDeCajaPorNombre_(rows, nameKey, areaKey, name);
    if (!hallada.ok) { return hallada; }
    var box = hallada.box;
    if (box.sid) {
      // Self-heal: el registro se reescribe también cuando la caja YA tiene
      // S-ID. Sin esto, un registro reseteado no volvía a incluir las cajas
      // antiguas y sus cross-source quedaban sin resolver.
      cfgRegenerateRegistry_(rows);
      return { ok: true, sid: box.sid, existing: true, name: box.servicio };
    }
    // El volcado dentro del lock (#390) ya no se pide aquí: vive pegado a la
    // escritura, dentro de `cfgAsignarSidEnArbol_`, para que ningún camino que
    // estampe un S-ID pueda saltárselo — que es exactamente lo que le pasaba al
    // grant (#416). El porqué completo está allí.
    var sid = cfgAsignarSidEnArbol_(leido, box);
    cfgRegenerateRegistry_(rows);
    cfgAudit_({
      actor: caller.email, via: caller.via, action: 'assignSid', result: 'ok',
      box: box.servicio, sid: sid, reason: 'primera apertura de la caja',
    });
    return { ok: true, sid: sid, existing: false, name: box.servicio };
  } catch (err) {
    return { ok: false, error: 'resolveSid error: ' + (err && err.message ? err.message : String(err)) };
  } finally {
    lock.releaseLock();
  }
}

// `boxAcl` — a quién le toca ser editor/lector de la carpeta de una caja, para
// que OAuthToken aplique la ACL con el token del usuario.
//
// Gateado como `listBoxUsers` (admin o champion de la caja) porque devuelve el
// censo de la caja. Un usuario normal recibe {ok:false} y su
// `applyFlatBoxAcl_` simplemente no hace nada — que es lo que ya pasaba antes:
// sin permiso para compartir la carpeta, sus intentos fallaban uno a uno.
function cfgActionBoxAcl_(caller, payload) {
  var boxName = String((payload && payload.boxName) || '').trim();
  if (!boxName) { return { ok: false, error: 'Falta boxName' }; }
  var arbol = cfgArbolLector_();
  // Sin lock de por medio: la potestad y el censo se resuelven contra la MISMA
  // lectura, que es lo que aquí antes eran dos seguidas. No hay TOCTOU que
  // cerrar porque no hay espera entre una y otra — ver `cfgActionGrant_`, donde
  // sí la hay y por eso el memo nace más tarde.
  var roles = cfgRolesLector_();
  var auth = cfgAuthorityForEmail_(caller.email, boxName, payload && payload.sid, arbol, roles);
  if (!auth.ok) { return auth; }
  try {
    var hoja = roles();
    if (!hoja) { return { ok: false, error: 'Sheet de Roles no configurado (SHEET_ID)' }; }
    var values = hoja.values;
    var caja = cfgCajaParaLeer_(boxName, payload && payload.sid, arbol);
    var boxKey = caja.boxKey;
    var sid = caja.sid;
    // Tres cubos, no dos (#279·#3). El KB Contributor (col G) SALE de `editors`:
    // debería poder escribir solo el eje Work, y hasta ahora ese límite lo ponía
    // únicamente `canWorkWriteToSource` en el plugin — o sea que cualquier
    // cliente de Drive lo puenteaba y podía tocar knowledge y governance.
    // Ahora entra en `workEditors`: LECTOR de la carpeta de caja y EDITOR solo
    // de las subcarpetas que necesita (las aplica OAuthToken, que es quien
    // toca Drive).
    var editors = [];
    var workEditors = [];
    var viewers = [];
    var seen = {};
    for (var i = 2; i < values.length; i++) {
      var email = String(values[i][1] || '').toLowerCase().trim();
      if (!email || seen[email]) { continue; }
      seen[email] = true;
      if (cfgIsAdminCell_(values[i][3])
        || cfgCeldaTieneCaja_(String(values[i][4] || ''), sid, boxKey)
        || cfgCeldaTieneCaja_(String(values[i][5] || ''), sid, boxKey)) {
        editors.push(email);
      } else if (cfgCeldaTieneCaja_(String(values[i][6] || ''), sid, boxKey)) {
        workEditors.push(email);
      } else if (cfgCeldaTieneCaja_(String(values[i][7] || ''), sid, boxKey)) {
        viewers.push(email);
      }
    }
    return { ok: true, editors: editors, workEditors: workEditors, viewers: viewers };
  } catch (err) {
    // `infra:true` como en el resto de fallos de LECTURA (#417): aquí no se ha
    // decidido nada sobre el llamante, se ha roto el Excel. Lo mira el sello de
    // 6 h del autorreparador de abrir caja — sellar por un hipo del Sheet deja
    // la caja sin repararse por ese camino durante seis horas.
    return { ok: false, infra: true, error: 'boxAcl error: ' + (err && err.message ? err.message : String(err)) };
  }
}

// ── Censo y potestad, calculados sobre la matriz CRUDA ───────────────────────
//
// Los tres son PUROS (no abren el Excel, no miran permisos, no tocan Drive) y
// existen como helpers —en vez de inline en `cfgActionListBoxUsers_`— porque el
// publicador de la caché de lecturas (#325, `sync-drive-permissions.gs`)
// necesita EXACTAMENTE lo mismo. Reimplementarlos allí crearía dos verdades que
// empiezan iguales y divergen al primer cambio, y la divergencia sería INVISIBLE:
// la caché serviría un censo o una potestad distintos de los del relay, que es
// quien manda. Un espejo aquí no es duplicación de código: es un bypass a plazo.

// Censo de UNA caja: quién tiene qué rol en ella.
//
// AGREGA todas las filas de cada email: con duplicados, la caja puede vivir en
// la 2ª fila y el acceso quedaba invisible en la UI (y por tanto no revocable).
// Con filas en conflicto gana el rol MÁS ALTO.
function cfgBoxCensusFromValues_(values, boxKey, sid) {
  var users = [];
  var byEmail = {};
  var typeByEmail = {};
  for (var i = 2; i < values.length; i++) {
    var email = String(values[i][1] || '').toLowerCase().trim();
    if (!email) { continue; }
    var userType = String(values[i][2] || '').trim();
    if (userType && typeByEmail[email] === undefined) { typeByEmail[email] = userType; }
    var rowRole = '';
    if (cfgIsAdminCell_(values[i][3])) { rowRole = 'admin'; }
    else if (cfgCeldaTieneCaja_(String(values[i][4] || ''), sid, boxKey)) { rowRole = 'kdd-champion'; }
    else if (cfgCeldaTieneCaja_(String(values[i][5] || ''), sid, boxKey)) { rowRole = 'kb-steward'; }
    else if (cfgCeldaTieneCaja_(String(values[i][6] || ''), sid, boxKey)) { rowRole = 'kb-contributor'; }
    else if (cfgCeldaTieneCaja_(String(values[i][7] || ''), sid, boxKey)) { rowRole = 'kb-consumer'; }
    if (!rowRole) { continue; }
    var idx = byEmail[email];
    if (idx === undefined) {
      byEmail[email] = users.length;
      var u = { email: email, role: rowRole, level: cfgLevelForRole_(rowRole), userType: userType };
      if (rowRole === 'admin') { u.isAdmin = true; }
      users.push(u);
    } else {
      var prev = users[idx];
      if (cfgRoleRank_(rowRole) > cfgRoleRank_(prev.role)) {
        prev.role = rowRole;
        prev.level = cfgLevelForRole_(rowRole);
        if (rowRole === 'admin') { prev.isAdmin = true; }
      }
    }
  }
  for (var k = 0; k < users.length; k++) {
    if (!users[k].userType && typeByEmail[users[k].email]) { users[k].userType = typeByEmail[users[k].email]; }
  }
  return users;
}

/**
 * Quién puede GESTIONAR los accesos de qué caja: `{ <email>: { admin, boxes } }`.
 *
 * Espejo EXACTO de `cfgAuthorityForEmail_` + `cfgLookupRole_`, y por eso replica
 * su rareza más peligrosa: **`cfgLookupRole_` devuelve en la PRIMERA fila que
 * casa el email**, así que un email repetido en varias filas solo aporta
 * potestad desde la primera (#305, abierta). Agregar aquí todas sus filas
 * parecería una mejora y sería lo contrario: esta función decide quién recibe el
 * `salt` con el que se lee el censo cacheado (#325), o sea que conceder de más
 * es un BYPASS del control de accesos, no una corrección de #305. El día que se
 * arregle #305, se arregla en `cfgLookupRole_` y esto lo sigue.
 *
 * Solo la col E (KDD Champions) da potestad: un steward escribe en la caja pero
 * no reparte accesos. El admin (col D) los tiene TODOS y por eso viaja aparte,
 * sin enumerar cajas — quien lo consuma decide qué hace con ese caso.
 *
 * **#365 fase E: indexa por CLAVE DE CENSO (`cfgClaveCenso_`), no por nombre.**
 * Una celda migrada produce `s:S049`, una sin migrar `n:<nombre>`, y el token
 * decide cuál. Es el MISMO espacio de claves que publica el índice del censo y
 * que pide el lector; con la clave por nombre a secas, un champion con la celda
 * ya migrada no encontraba el salt de su propia caja y caía al relay siempre.
 *
 * ⚠ El párrafo que había aquí decía que indexaba por NOMBRE y que *"una caja
 * migrada no produce clave aquí, el salt no existe"* — lo contrario de lo que
 * hace el cuerpo desde esa misma fase. En una función que reparte el salt del
 * censo, ese párrafo es justo el que hace descartar el bug de #370 al leerlo.
 * Si vuelves a tocar el dialecto de las claves, **este comentario cambia con
 * el cuerpo, en el mismo commit**.
 *
 * Las claves que emite tienen que ser las MISMAS que publica
 * `syncGruposCenso_`: si divergen, el gestor pide una clave que nadie escribió
 * (miss → relay, inocuo) o —lo que importa— una que escribió otra caja.
 */
function cfgManagersFromValues_(values) {
  var out = {};
  for (var i = 2; i < values.length; i++) {
    var email = String(values[i][1] || '').toLowerCase().trim();
    if (!email || Object.prototype.hasOwnProperty.call(out, email)) { continue; }
    // Las cajas del gestor van por CLAVE DE CENSO (#365 fase E), el mismo
    // espacio que publica el índice y que pide el lector. Con la clave por
    // nombre a secas, un champion con la celda ya migrada no encontraba el salt
    // de su propia caja y caía al relay para siempre.
    var boxes = {};
    var partes = String(values[i][4] || '').split(/[,;\n]+/);
    for (var j = 0; j < partes.length; j++) {
      var token = String(partes[j] == null ? '' : partes[j]).trim();
      if (!token) { continue; }
      var clave = cfgEsSid_(token)
        ? cfgClaveCenso_(cfgNormSid_(token), '')
        : cfgClaveCenso_('', cfgNormBox_(token));
      if (clave !== 'n:') { boxes[clave] = true; }
    }
    out[email] = { admin: cfgIsAdminCell_(values[i][3]) === true, boxes: boxes };
  }
  return out;
}

/**
 * Todas las claves de caja que aparecen en el Sheet (cols E/F/G/H), sin repetir.
 *
 * Es el universo sobre el que un admin tiene potestad. Devuelve
 * `{ <claveDeCenso>: {sid, boxKey} }` (#365 fase E): el valor lleva con qué
 * par hay que construir el censo de esa clave, para que el publicador no tenga
 * que volver a adivinarlo del token.
 */
function cfgAllBoxKeysFromValues_(values) {
  var keys = {};
  for (var i = 2; i < values.length; i++) {
    for (var c = 4; c <= 7; c++) {
      var partes = String(values[i][c] || '').split(/[,;\n]+/);
      for (var j = 0; j < partes.length; j++) {
        var token = String(partes[j] == null ? '' : partes[j]).trim();
        if (!token) { continue; }
        if (cfgEsSid_(token)) {
          var sid = cfgNormSid_(token);
          if (sid) { keys[cfgClaveCenso_(sid, '')] = { sid: sid, boxKey: '' }; }
          continue;
        }
        var k = cfgNormBox_(token);
        if (k) { keys[cfgClaveCenso_('', k)] = { sid: '', boxKey: k }; }
      }
    }
  }
  return keys;
}

/**
 * Clave del censo de UNA caja (#365 fase E). El S-ID manda cuando la celda está
 * migrada; el nombre normalizado es el resto legacy.
 *
 * Los dos espacios van PREFIJADOS y no se mezclan: sin prefijo, una caja llamada
 * literalmente "S049" compartiría censo con la caja S049.
 *
 * ⚠ Esto invierte lo que decía la regla hasta #365 ("clave por NOMBRE, nunca por
 * S-ID"). Aquel argumento era que el Sheet indexaba por nombre y una clave por
 * S-ID fingiría una separación que no existía. Ahora el Sheet indexa por S-ID,
 * así que la separación es REAL y no distinguirlas es lo que haría que dos
 * homónimas compartieran censo — el leak de #293 por la puerta de la caché.
 * Mientras la celda NO esté migrada se sigue compartiendo, que es la verdad de
 * ese Sheet: ahí no hay nada que distinga a las dos.
 *
 * PURA. La usan el lector y el publicador, y tienen que coincidir EXACTAMENTE:
 * si divergen, el publicador escribe claves que el lector no pide (miss → relay,
 * inocuo) o —lo que importa— el lector pide claves que otra caja escribió.
 */
function cfgClaveCenso_(sid, boxKey) {
  var s = cfgNormSid_(sid);
  if (s) { return 's:' + s; }
  return 'n:' + cfgNormBox_(boxKey);
}

/**
 * Par (S-ID, nombre) para una LECTURA. Si el árbol no puede decidir —ilegible,
 * caja fuera del árbol, dos homónimas— se sigue por NOMBRE, que es lo de hoy.
 *
 * La asimetría con `cfgCajaObjetivo_` es deliberada: una lectura que se degrada
 * enseña de más; una ESCRITURA que se degrada escribe en la caja equivocada, o
 * dice "retirado" sin retirar nada.
 *
 * ⚠ ESTA DEGRADACIÓN SOLO ES ACEPTABLE PORQUE EL GATE VALIDA EL PAR (#368).
 * El comentario anterior la justificaba con *"y eso ya pasaba"*, y era cierto
 * **mientras el gate también fuera por nombre**: gate y dato compartían clave y
 * no podían discrepar. Cuando el gate pasó a autorizar por el `sid` del payload
 * sin comprobar que fuera el de `boxName`, esta degradación dejó de enseñar "de
 * más dentro de tu caja" y pasó a enseñar **la caja de otro**: el par cruzado
 * entraba autorizado y aquí se resolvía por el nombre pedido. Hoy el par lo
 * valida `cfgAuthorityForEmail_` antes de llegar aquí, así que un par cruzado no
 * alcanza esta función.
 *
 * **Si alguna vez relajas ese gate, esta degradación vuelve a ser una fuga** —
 * y este párrafo es justo el que hace descartar el bug al leerlo por encima.
 */
function cfgCajaParaLeer_(boxName, sidCrudo, arbol) {
  var res = cfgCajaObjetivo_(boxName, sidCrudo, arbol, false);
  if (res.ok) { return res; }
  return { ok: true, sid: '', sidDrive: '', boxKey: cfgNormBox_(boxName), boxName: boxName, materializado: false };
}

// `listBoxUsers` — censo de la caja con el rol POR CAJA de cada uno.
//
// El `sid` del payload lo manda el plugin DESDE #373 (antes no, y este
// comentario decía lo contrario hasta #388). Sigue siendo opcional —una caja sin
// materializar no tiene ninguno, y un plugin viejo tampoco lo manda—, así que el
// nombre se sigue resolviendo contra el árbol: sin eso, en cuanto un grant
// migrara una fila a S-ID el censo saldría vacío y el panel enseñaría una caja
// sin nadie. Lo que YA NO es cierto es que el nombre sea el único camino.
function cfgActionListBoxUsers_(caller, payload) {
  var boxName = String((payload && payload.boxName) || '').trim();
  if (!boxName) { return { ok: false, error: 'Falta boxName' }; }
  var arbol = cfgArbolLector_();
  // Igual que `cfgActionBoxAcl_`: potestad y censo salen de la MISMA lectura.
  // Aquí no hay lock, así que las dos lecturas de antes eran consecutivas y no
  // había ninguna ventana que cerrar entre ellas — `roles ×2 → ×1`.
  var roles = cfgRolesLector_();
  var auth = cfgAuthorityForEmail_(caller.email, boxName, payload && payload.sid, arbol, roles);
  if (!auth.ok) { return auth; }
  try {
    var hoja = roles();
    if (!hoja) { return { ok: false, error: 'Sheet de Roles no configurado (SHEET_ID)' }; }
    var caja = cfgCajaParaLeer_(boxName, payload && payload.sid, arbol);
    var users = cfgBoxCensusFromValues_(hoja.values, caja.boxKey, caja.sid);
    return { ok: true, users: users, callerEmail: auth.email };
  } catch (err) {
    Logger.log('cfgActionListBoxUsers_ error: ' + (err && err.message ? err.message : String(err)));
    return { ok: false, error: 'listBoxUsers error: ' + (err && err.message ? err.message : String(err)) };
  }
}

// Deniega y AUDITA en el mismo gesto — para que ningún camino de rechazo se
// escape del rastro (es la señal que más importa vigilar).
// `extra.result` permite auditar como `error` en vez de `denegado` (#417). No
// es un matiz de redacción: la columna de resultado es la señal que se vigila
// para detectar intentos de escalada, y un fallo de infraestructura —el Excel
// que no se deja leer— fabricaba esa señal sobre gente que no había intentado
// nada. La fila SIGUE escribiéndose: constancia sí, acusación no.
function cfgDeny_(caller, action, payload, reason, extra) {
  cfgAudit_({
    actor: caller.email, via: caller.via, action: action,
    result: (extra && extra.result) || 'denegado',
    target: String((payload && payload.email) || ''),
    box: String((payload && payload.boxName) || ''),
    sid: String((payload && payload.sid) || ''),
    roleBefore: (extra && extra.roleBefore) || '',
    roleAfter: (extra && extra.roleAfter) || '',
    reason: reason,
  });
  return { ok: false, error: reason };
}

// ════════════════════════════════════════════════════════════════════════════
//  COLA DE REPARTO DE ACL (#318 — Frente 2)
// ════════════════════════════════════════════════════════════════════════════
//
// Un alta de KB Contributor eran ~52 s de los que solo ~6 son escribir la fila
// del Sheet. El resto son 6-10 escrituras de permisos en Drive (carpeta de
// caja + subcarpetas del eje Work + ficheros de login) que hacía la mitad
// PÚBLICA, con el token del que concede, y con el operador mirando un spinner.
//
// La fila del Sheet es lo que DEFINE el rol; la ACL es reconciliación — tanto,
// que ya existía el camino que lo asume ("el rol se guardó en el Sheet; que un
// admin ejecute syncDrivePermissions"). Así que grant/revoke responden al
// escribir la fila y dejan aquí un ítem, y `syncAplicarAclPendientes` (trigger
// de 10 min, en sync-drive-permissions.gs) lo aplica COMO EL PROPIETARIO.
//
// Tres cosas que arregla además de la espera:
//  · Un KDD Champion que no tenga esa caja compartida NO podía aplicar la ACL
//    (fallo real en "BSI Reporting Tool", 2026-08-06): la aplicaba con SU
//    token. El propietario siempre puede.
//  · N operadores concediendo a la vez eran N ejecuciones públicas escribiendo
//    permisos EN PARALELO contra el cupo del propietario. Ahora es UNA
//    ejecución en serie, un ítem detrás de otro.
//  · Lo pendiente deja de ser invisible: está en el buzón y el drenador lo
//    cuenta en cada pasada.
//
// **`ACL_QUEUE_FOLDER_ID` vacía → no se encola y OAuthToken aplica la ACL como
// siempre.** Es el interruptor de rollback: se borra la property y se vuelve al
// comportamiento anterior sin republicar nada ni tocar código.

/**
 * SEXTO punto de escritura a Drive de ConfigData (ver el invariante de la
 * cabecera). Solo deja ficheros en el buzón de la cola; no lee, no borra y no
 * toca ninguna otra carpeta.
 *
 * **No aplica ni un permiso**: escribe un JSON que DESCRIBE el reparto
 * pendiente. Por eso ConfigData sigue sin contener un solo verbo de ACL y
 * `CONFIGDATA_PROHIBIDO` se mantiene intacto — lo que cambia con #318 es quién
 * aplica (el propietario, no el que concede), no que lo aplique este fichero.
 */
function cfgAclQueueWrite_(folderId, nombre, contenido) {
  try {
    DriveApp.getFolderById(folderId).createFile(nombre, contenido, MimeType.PLAIN_TEXT);
    return true;
  } catch (err) {
    Logger.log('cfgAclQueueWrite_ falló: ' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

/**
 * Encola un reparto de ACL. Devuelve `true` SOLO si el ítem quedó escrito; un
 * `false` significa "aplícalo tú ahora", que es el comportamiento de siempre.
 *
 * Nunca lanza: corre después de que la fila del Sheet ya esté escrita, y un
 * fallo del buzón no puede tumbar un grant que a efectos de rol YA ocurrió.
 * Fallar hacia el camino síncrono es la degradación correcta — se pierde la
 * ventaja de latencia, nunca la corrección.
 *
 * `at` lo pone el SERVIDOR y es lo que ordena el drenaje: con varias
 * operaciones sobre el mismo (email, caja) gana la más reciente, así que un
 * revoke posterior a un grant no puede quedar por debajo y resucitar el acceso.
 */
function cfgAclEnqueue_(item) {
  // Etapa `reparto`, y NO se puede dejar sin medir: esto escribe un fichero en
  // Drive DENTRO del `ScriptLock`, una vez por cada grant y cada revoke — la
  // misma clase de trabajo que `cfgRegenerateRegistry_`, que sí tiene etapa
  // propia. Dejar una medida y la otra no es justo la asimetría que hace que un
  // desglose se lea como completo cuando no lo es.
  //
  // Se llama `reparto` y no `cola` a propósito: el plugin ya pinta un `cola Xs`
  // suyo (lo que la llamada esperó ranura de salida en casa), y dos `cola` en la
  // misma línea del log son indistinguibles justo cuando hay congestión, que es
  // cuando se lee.
  var t = Date.now();
  try {
    var folderId = '';
    try { folderId = PropertiesService.getScriptProperties().getProperty('ACL_QUEUE_FOLDER_ID') || ''; }
    catch (e) { return false; }
    if (!folderId) { return false; }
    var registro = item || {};
    registro.at = new Date().getTime();
    registro.intentos = 0;
    var nombre = 'acl_' + registro.at + '_' + Utilities.getUuid() + '.json';
    return cfgAclQueueWrite_(folderId, nombre, JSON.stringify(registro));
  } finally {
    cfgPerfSumar_('reparto', Date.now() - t);
  }
}

// `grant` — escribe la MATRIZ del Sheet. La ACL de Drive NO se toca aquí
// (invariante): o se encola para que la aplique el propietario (#318), o se
// devuelve lo que OAuthToken necesita para aplicarla él mismo.
function cfgActionGrant_(caller, payload) {
  var boxName = String((payload && payload.boxName) || '').trim();
  var email = String((payload && payload.email) || '').toLowerCase().trim();
  var requestedRole = String((payload && payload.role) || '').trim();
  if (!requestedRole && payload && payload.level) {
    // Compat: "read" significaba SOLO lectura — mapearlo a kb-contributor daba
    // escritura Work + ACL editor a quien se pidió como lector (escalada
    // silenciosa, auditoría 2026-07-11).
    requestedRole = payload.level === 'read' ? 'kb-consumer' : 'kb-steward';
  }
  var hasUserType = !!(payload && Object.prototype.hasOwnProperty.call(payload, 'userType'));
  var userType = hasUserType ? cfgSanitizeType_(payload.userType) : '';
  if (!boxName) { return { ok: false, error: 'Falta boxName' }; }
  if (!/^\S+@\S+\.\S+$/.test(email)) { return { ok: false, error: 'Email no válido: "' + email + '"' }; }

  var auth = cfgAuthorityForEmail_(caller.email, boxName, payload && payload.sid, cfgArbolLector_());
  if (!auth.ok) { return cfgDeny_(caller, 'grant', payload, auth.error, { result: auth.infra ? 'error' : '' }); }
  if (email === caller.email) {
    return cfgDeny_(caller, 'grant', payload, 'No puedes cambiar tu propio acceso — pídeselo a otro admin/KDD Champion de la caja.');
  }
  var normalizedRole = cfgNormRole_(requestedRole);
  if (normalizedRole !== 'kdd-champion' && normalizedRole !== 'kb-steward' && normalizedRole !== 'kb-contributor' && normalizedRole !== 'kb-consumer') {
    return cfgDeny_(caller, 'grant', payload, 'Rol no válido: "' + requestedRole + '" (kdd-champion | kb-steward | kb-contributor | kb-consumer; admin se concede a mano en el Sheet).');
  }
  if (cfgRoleRank_(normalizedRole) > cfgRoleRank_(auth.role)) {
    return cfgDeny_(caller, 'grant', payload, 'Solo puedes asignar tu mismo rol o inferior (tu rol en esta caja: ' + auth.role + ').');
  }
  // Acuñar un KDD Champion es admin-only TAMBIÉN aquí: el rank "tu mismo rol o
  // inferior" deja pasar champion→champion (3 > 3 es false).
  if (auth.role !== 'admin' && normalizedRole === 'kdd-champion') {
    return cfgDeny_(caller, 'grant', payload, 'Solo un admin puede asignar el rol KDD Champion.');
  }

  var lock = LockService.getScriptLock();
  try { cfgTomarLock_(lock, 30000); }
  catch (e) { return { ok: false, error: 'Could not acquire lock — retry' }; }

  try {
    // TOCTOU: re-verificar la potestad DENTRO del lock — entre el pre-check y
    // la adquisición un admin pudo degradar/retirar al llamante.
    // Lectores NUEVOS dentro del lock, y no los del pre-check: la
    // re-verificación existe para mirar el estado de AHORA, y un memo tomado
    // antes de esperar hasta 30 s por el lock no es el estado de ahora. Uno de
    // cada para los consumidores de aquí dentro (potestad, caja objetivo,
    // materialización).
    //
    // El de ROLES entra con la misma regla que el del árbol, y con ella el grant
    // pasa de `roles ×3` a `×2`: las dos de aquí dentro son la misma foto bajo
    // el mismo mutex. La que NO se comparte nunca es la del pre-check de arriba
    // — hacerlo dejaría esta línea comprobando la potestad de hace 30 s, que es
    // literalmente el agujero que estas cuatro líneas existen para tapar.
    var arbol = cfgArbolLector_();
    var roles = cfgRolesLector_();
    auth = cfgAuthorityForEmail_(caller.email, boxName, payload && payload.sid, arbol, roles);
    if (!auth.ok) { return cfgDeny_(caller, 'grant', payload, auth.error, { result: auth.infra ? 'error' : '' }); }
    if (cfgRoleRank_(normalizedRole) > cfgRoleRank_(auth.role)) {
      return cfgDeny_(caller, 'grant', payload, 'Solo puedes asignar tu mismo rol o inferior (tu rol en esta caja: ' + auth.role + ').');
    }
    if (auth.role !== 'admin' && normalizedRole === 'kdd-champion') {
      return cfgDeny_(caller, 'grant', payload, 'Solo un admin puede asignar el rol KDD Champion.');
    }
    var hoja = roles();
    if (!hoja) { return { ok: false, error: 'Sheet de Roles no configurado (SHEET_ID)' }; }
    var sheet = hoja.sheet;
    var values = hoja.values;
    // La caja objetivo, resuelta a S-ID DENTRO del lock: si hay que
    // materializarla, la escritura del árbol y la del Sheet caen bajo el mismo
    // mutex. Con dos locks distintos, entre una y otra cabe otra ejecución
    // emitiendo el mismo número.
    var caja = cfgCajaObjetivo_(boxName, payload && payload.sid, arbol, true);
    // Sin condición de visibilidad: para llegar aquí hay que haber pasado el
    // gate, que ya comprobó que este llamante manda en esta caja.
    if (!caja.ok) {
      return cfgDeny_(caller, 'grant', payload,
        cfgErrorParDivergente_(caja, { isAdmin: true }, cfgNormSid_(payload && payload.sid)),
        { result: caja.infra ? 'error' : '' });
    }
    if (caja.materializado) {
      cfgRegenerateRegistry_(caja.filas);
      cfgAudit_({
        actor: caller.email, via: caller.via, action: 'assignSid', result: 'ok',
        box: caja.boxName, sid: caja.sid, reason: 'materializada al conceder acceso',
      });
    }
    var boxKey = caja.boxKey;
    var sid = caja.sid;
    var roleBefore = cfgCurrentRoleInBox_(values, email, boxKey, sid);
    var rows = cfgRowsForEmail_(values, email);
    var userIsChampion = false;
    var r, i2;
    if (rows.length > 0) {
      for (r = 0; r < rows.length; r++) {
        if (cfgIsAdminCell_(values[rows[r]][3])) {
          return cfgDeny_(caller, 'grant', payload, 'La fila de un admin no se toca — ya tiene acceso a todas las cajas por rol.', { roleBefore: roleBefore });
        }
      }
      // Anti peer-takeover: cambiar el rol de OTRO KDD Champion de esta caja
      // exige admin — sin esto un champion degradaba a su par y se quedaba solo
      // al mando de la caja.
      if (auth.role !== 'admin') {
        for (r = 0; r < rows.length; r++) {
          if (cfgCeldaTieneCaja_(String(values[rows[r]][4] || ''), sid, boxKey)) {
            return cfgDeny_(caller, 'grant', payload, 'Solo un admin puede cambiar el rol de otro KDD Champion de la caja.', { roleBefore: roleBefore });
          }
        }
      }
      // Quita la caja de las CUATRO columnas de rol de TODAS las filas y
      // añádela solo a la del rol pedido de la PRIMERA (un rol por caja).
      for (r = 0; r < rows.length; r++) {
        i2 = rows[r];
        var colE = cfgListRemoveCaja_(String(values[i2][4] || ''), sid, boxKey);
        var colF = cfgListRemoveCaja_(String(values[i2][5] || ''), sid, boxKey);
        var colG = cfgListRemoveCaja_(String(values[i2][6] || ''), sid, boxKey);
        var colH = cfgListRemoveCaja_(String(values[i2][7] || ''), sid, boxKey);
        if (r === 0) {
          if (normalizedRole === 'kdd-champion') { colE = cfgListAddSid_(colE, sid); }
          else if (normalizedRole === 'kb-steward') { colF = cfgListAddSid_(colF, sid); }
          else if (normalizedRole === 'kb-contributor') { colG = cfgListAddSid_(colG, sid); }
          else { colH = cfgListAddSid_(colH, sid); }
        }
        if (String(colE).trim().length > 0) { userIsChampion = true; }
        cfgEscribirCelda_(sheet, i2 + 1, 5, colE);
        cfgEscribirCelda_(sheet, i2 + 1, 6, colF);
        cfgEscribirCelda_(sheet, i2 + 1, 7, colG);
        cfgEscribirCelda_(sheet, i2 + 1, 8, colH);
        cfgReflejarFila_(values, i2, colE, colF, colG, colH);
      }
      if (hasUserType) {
        cfgEscribirCelda_(sheet, rows[0] + 1, 3, userType);
        values[rows[0]][2] = userType;
      }
    } else {
      // ALTA: fila nueva (col A vacía; col C solo si el alta trae el tipo).
      // Con el S-ID, nunca con el nombre: una fila nacida hoy no puede nacer ya
      // pendiente de migrar.
      var filaNueva = [
        '', email, hasUserType ? userType : '', '',
        normalizedRole === 'kdd-champion' ? sid : '',
        normalizedRole === 'kb-steward' ? sid : '',
        normalizedRole === 'kb-contributor' ? sid : '',
        normalizedRole === 'kb-consumer' ? sid : '',
      ];
      cfgAnadirFila_(sheet, filaNueva);
      // La misma fila, en la foto en memoria: de ahí sale el censo de la
      // respuesta (ver `cfgReflejarFila_`).
      values.push(filaNueva);
      userIsChampion = (normalizedRole === 'kdd-champion');
    }

    // El Sheet acaba de cambiar: el rol cacheado del afectado ya no vale.
    cfgInvalidateRoleCache_(email);
    // VOLCAR ANTES DE SUBIR LA GENERACIÓN, y este orden no es cosmético (#325):
    // las escrituras de arriba siguen en buffer y `cfgBumpCacheGen_` es visible
    // al instante, así que sin el volcado el bump se adelanta a los datos y el
    // publicador puede sellar una foto PREVIA con la generación POSTERIOR. Ver
    // `cfgFlushSheet_`.
    cfgFlushSheet_();
    // Y la foto que tenga el publicador de la caché de lecturas queda vieja
    // (#325): que descarte la suya en vez de resucitar este censo.
    cfgBumpCacheGen_();

    // Repetición del MISMO grant (reintento por buzón perdido, #326): el trabajo
    // se rehace —es idempotente— pero la fila de auditoría no se duplica. Se
    // reporta `audited:true` porque la operación SÍ quedó auditada: en su primer
    // pase. Decir false aquí haría creer que el rastro se perdió.
    var repetido = cfgRequestYaVisto_(payload && payload.requestId);
    var audited = repetido ? true : cfgAudit_({
      actor: caller.email, via: caller.via, action: 'grant', result: 'ok',
      target: email, box: caja.boxName, sid: caja.sidDrive,
      roleBefore: roleBefore, roleAfter: normalizedRole,
      reason: rows.length > 0 ? 'cambio de rol (' + rows.length + ' fila(s))' : 'alta nueva',
    });
    if (repetido) { Logger.log('cfgActionGrant_: repetición de ' + payload.requestId + ' — no se audita otra vez.'); }

    // Tres niveles, no dos (#279·#3): champion/steward → editor de la caja
    // entera; kb-contributor → LECTOR de la caja y editor solo de las
    // subcarpetas del eje Work; kb-consumer → lector a secas.
    var wantsEditor = normalizedRole === 'kdd-champion' || normalizedRole === 'kb-steward';
    var wantsWorkEditor = normalizedRole === 'kb-contributor';
    // El Excel de Roles: NO debe compartirse al dar de alta, ni aunque su ID
    // siga en LOGIN_SHARE_*_IDS. Solo aquí se conoce su ID.
    var protectedFileIds = [cfgConfig_().sheetId];

    // #318 — el reparto se encola y lo aplica el propietario. Si el buzón no
    // está configurado o falla, `queued` es false y OAuthToken lo aplica
    // síncronamente, exactamente como antes.
    var queued = cfgAclEnqueue_({
      op: 'grant',
      email: email,
      boxKey: boxKey,
      boxName: caja.boxName,
      // El S-ID resuelto, no el del payload: si esta caja se acaba de
      // materializar, el payload no lo traía y el ítem saldría a repartir sin
      // identidad — que es cómo se llena la raíz plana de duplicados.
      sid: caja.sidDrive,
      wantsEditor: wantsEditor,
      wantsWorkEditor: wantsWorkEditor,
      userIsChampion: userIsChampion,
      protectedFileIds: protectedFileIds,
      actor: caller.email,
    });

    return {
      ok: true,
      boxKey: boxKey,
      // Para el camino síncrono de rollback (`ACL_QUEUE_FOLDER_ID` vacía):
      // OAuthToken localiza la carpeta con esto, y sin ello una caja recién
      // materializada solo casaría por nombre.
      sid: caja.sidDrive,
      normalizedRole: normalizedRole,
      wantsEditor: wantsEditor,
      wantsWorkEditor: wantsWorkEditor,
      userIsChampion: userIsChampion,
      callerEmail: caller.email,
      audited: audited,
      queued: queued,
      protectedFileIds: protectedFileIds,
      // El censo POSTERIOR a la escritura, sin releer la hoja: sale de la foto
      // en memoria que `cfgReflejarFila_` y el `push` de arriba han dejado igual
      // que la hoja tras el volcado. Es lo que el panel pintaba pidiendo un
      // `listBoxUsers` entero un segundo después (~10 s de viaje por cada alta
      // o baja, 2026-08-27). Mismo gate que ese censo: la potestad del que
      // concede, ya verificada dentro del lock.
      users: cfgBoxCensusFromValues_(values, boxKey, sid),
    };
  } catch (err) {
    Logger.log('cfgActionGrant_ error: ' + (err && err.message ? err.message : String(err)));
    return { ok: false, error: 'grantAccess error: ' + (err && err.message ? err.message : String(err)) };
  } finally {
    // Red de TODAS las salidas, no solo de la feliz (#416). El volcado de más
    // arriba solo cubre el camino que termina bien; por aquí pasan también las
    // denegaciones posteriores a la materialización y la excepción, que puede
    // saltar con parte de las celdas de Roles ya escritas. Soltar el mutex con
    // escrituras en el buffer las hace invisibles para la siguiente ejecución,
    // que es la que las va a leer para decidir.
    //
    // Va ANTES de soltar y es idempotente: sin nada pendiente no cuesta nada.
    // No sustituye al volcado del camino feliz, que además tiene que ir DELANTE
    // de `cfgBumpCacheGen_` (#325) — este corre después del bump y solo es red.
    // Un volcado POSTERIOR al bump es inofensivo: solo puede hacer visible más
    // dato, nunca menos, así que `CACHE_GEN` sigue siendo cota inferior.
    //
    // Y soltar el mutex NO puede depender de que el volcado funcione: una
    // excepción aquí lo dejaría retenido hasta que Apps Script mate la
    // ejecución, y este mutex lo comparten grant, revoke, resolveSid y
    // metaWrite. La red no puede costar más que lo que protege.
    //
    // Efecto conocido en el log: una denegación PURA —que no escribió ni una
    // celda— sale ahora como `escritura ×1` con ~0 ms, porque esto cuenta como
    // una operación de escritura. Apps Script no deja preguntar si hay algo
    // pendiente, así que se acepta: el `×n` sobreestima en un caso barato, que
    // es preferible a que el desglose calle un volcado que sí costó.
    try { cfgFlushSheet_(); }
    catch (e) { Logger.log('cfgActionGrant_: el volcado de cierre falló — ' + (e && e.message ? e.message : String(e))); }
    lock.releaseLock();
  }
}

// `revoke` — quita la caja de col E/F/G/H (la fila NO se borra). La retirada de
// la ACL de Drive se encola para el propietario (#318), o la hace OAuthToken con
// el token del que revoca si el buzón no está configurado.
function cfgActionRevoke_(caller, payload) {
  var boxName = String((payload && payload.boxName) || '').trim();
  var email = String((payload && payload.email) || '').toLowerCase().trim();
  if (!boxName) { return { ok: false, error: 'Falta boxName' }; }
  if (!/^\S+@\S+\.\S+$/.test(email)) { return { ok: false, error: 'Email no válido: "' + email + '"' }; }

  var auth = cfgAuthorityForEmail_(caller.email, boxName, payload && payload.sid, cfgArbolLector_());
  if (!auth.ok) { return cfgDeny_(caller, 'revoke', payload, auth.error, { result: auth.infra ? 'error' : '' }); }
  if (email === caller.email) {
    return cfgDeny_(caller, 'revoke', payload, 'No puedes cambiar tu propio acceso — pídeselo a otro admin/KDD Champion de la caja.');
  }

  var lock = LockService.getScriptLock();
  try { cfgTomarLock_(lock, 30000); }
  catch (e) { return { ok: false, error: 'Could not acquire lock — retry' }; }

  try {
    // Lectores nuevos dentro del lock — ver el mismo bloque en `cfgActionGrant_`,
    // incluida la razón por la que el de Roles NO puede ser el del pre-check.
    var arbol = cfgArbolLector_();
    var roles = cfgRolesLector_();
    auth = cfgAuthorityForEmail_(caller.email, boxName, payload && payload.sid, arbol, roles);
    if (!auth.ok) { return cfgDeny_(caller, 'revoke', payload, auth.error, { result: auth.infra ? 'error' : '' }); }
    var hoja = roles();
    if (!hoja) { return { ok: false, error: 'Sheet de Roles no configurado (SHEET_ID)' }; }
    var sheet = hoja.sheet;
    var values = hoja.values;
    // Una baja NO materializa: si la caja no tiene S-ID, tampoco puede haberlo
    // en ninguna celda, y el camino por nombre la retira entera. Lo que sí para
    // la baja es no saber de qué caja hablamos — decir "retirado" sin retirar
    // nada es peor que un error.
    var caja = cfgCajaObjetivo_(boxName, payload && payload.sid, arbol, false);
    // Idem que en grant: el gate ya autorizó a este llamante sobre esta caja.
    if (!caja.ok) {
      return cfgDeny_(caller, 'revoke', payload,
        cfgErrorParDivergente_(caja, { isAdmin: true }, cfgNormSid_(payload && payload.sid)),
        { result: caja.infra ? 'error' : '' });
    }
    var boxKey = caja.boxKey;
    var sid = caja.sid;
    var roleBefore = cfgCurrentRoleInBox_(values, email, boxKey, sid);
    var rows = cfgRowsForEmail_(values, email);
    if (rows.length === 0) {
      return cfgDeny_(caller, 'revoke', payload, 'El email no está en el Sheet de Roles: ' + email);
    }
    var r, i2;
    for (r = 0; r < rows.length; r++) {
      if (cfgIsAdminCell_(values[rows[r]][3])) {
        return cfgDeny_(caller, 'revoke', payload, 'La fila de un admin no se toca — su acceso es por rol, no por columna.', { roleBefore: roleBefore });
      }
    }
    if (auth.role !== 'admin') {
      for (r = 0; r < rows.length; r++) {
        if (cfgCeldaTieneCaja_(String(values[rows[r]][4] || ''), sid, boxKey)) {
          return cfgDeny_(caller, 'revoke', payload, 'Solo un admin puede retirar el acceso de otro KDD Champion de la caja.', { roleBefore: roleBefore });
        }
      }
    }
    // ¿El usuario queda con CERO cajas? Entonces OAuthToken le retirará el
    // acceso a los ficheros de login (sin ninguna caja no debe poder loguearse).
    var nowHasNoBox = true;
    for (r = 0; r < rows.length; r++) {
      i2 = rows[r];
      var newE = cfgListRemoveCaja_(String(values[i2][4] || ''), sid, boxKey);
      var newF = cfgListRemoveCaja_(String(values[i2][5] || ''), sid, boxKey);
      var newG = cfgListRemoveCaja_(String(values[i2][6] || ''), sid, boxKey);
      var newH = cfgListRemoveCaja_(String(values[i2][7] || ''), sid, boxKey);
      cfgEscribirCelda_(sheet, i2 + 1, 5, newE);
      cfgEscribirCelda_(sheet, i2 + 1, 6, newF);
      cfgEscribirCelda_(sheet, i2 + 1, 7, newG);
      cfgEscribirCelda_(sheet, i2 + 1, 8, newH);
      cfgReflejarFila_(values, i2, newE, newF, newG, newH);
      if (String(newE).trim() || String(newF).trim() || String(newG).trim() || String(newH).trim()) { nowHasNoBox = false; }
    }

    // Revocar y que el proxy siga sirviéndole 60 s con el rol viejo sería
    // exactamente el fallo que este cambio existe para evitar.
    cfgInvalidateRoleCache_(email);
    // Volcar ANTES de subir la generación — ver `cfgFlushSheet_` y el mismo
    // bloque en `cfgActionGrant_`. En una BAJA importa aún más: es el caso en
    // que publicar una foto previa deja leyendo a quien acaba de perder el
    // acceso.
    cfgFlushSheet_();
    // Y la foto que tenga el publicador de la caché de lecturas queda vieja
    // (#325): que descarte la suya en vez de resucitar este censo.
    cfgBumpCacheGen_();

    // Repetición de la MISMA baja (#326) — ver `cfgActionGrant_`.
    var repetido = cfgRequestYaVisto_(payload && payload.requestId);
    var audited = repetido ? true : cfgAudit_({
      actor: caller.email, via: caller.via, action: 'revoke', result: 'ok',
      target: email, box: caja.boxName, sid: caja.sidDrive,
      roleBefore: roleBefore, roleAfter: 'ninguno',
      reason: nowHasNoBox ? 'queda sin ninguna caja' : rows.length + ' fila(s)',
    });
    if (repetido) { Logger.log('cfgActionRevoke_: repetición de ' + payload.requestId + ' — no se audita otra vez.'); }

    // #318 — igual que el grant. Una baja encolada tarda hasta ~10 min en
    // hacerse efectiva en Drive; la fila del Sheet, que es lo que el plugin
    // consulta, se retira YA. `syncDrivePermissions` sigue siendo la red.
    var queued = cfgAclEnqueue_({
      op: 'revoke',
      email: email,
      boxKey: boxKey,
      boxName: caja.boxName,
      sid: caja.sidDrive,
      nowHasNoBox: nowHasNoBox,
      actor: caller.email,
    });

    return {
      ok: true,
      boxKey: boxKey,
      sid: caja.sidDrive,
      nowHasNoBox: nowHasNoBox,
      callerEmail: caller.email,
      audited: audited,
      queued: queued,
      // El censo ya SIN el retirado — ver el mismo campo en `cfgActionGrant_`.
      // En una baja importa más que en un alta: el re-listado que ahorra es el
      // que, si servía la foto vieja, enseñaba acceso a quien ya no lo tiene.
      users: cfgBoxCensusFromValues_(values, boxKey, sid),
    };
  } catch (err) {
    Logger.log('cfgActionRevoke_ error: ' + (err && err.message ? err.message : String(err)));
    return { ok: false, error: 'revokeAccess error: ' + (err && err.message ? err.message : String(err)) };
  } finally {
    // Misma red que en `cfgActionGrant_`, blindaje del mutex incluido — ver el
    // porqué allí. En una BAJA la excepción a mitad del bucle es el caso que más
    // duele: deja unas columnas limpiadas y otras no, y quien lea después decide
    // con media retirada.
    try { cfgFlushSheet_(); }
    catch (e) { Logger.log('cfgActionRevoke_: el volcado de cierre falló — ' + (e && e.message ? e.message : String(e))); }
    lock.releaseLock();
  }
}

// ════════════════════════════════════════════════════════════════════════════
//  PROXY DE KDD_Studio_metadata (#279·#5)
// ════════════════════════════════════════════════════════════════════════════
//
// Esa carpeta guarda el registro global de cajas, el catálogo de skills y los
// resúmenes de grupo. Estaba compartida con TODOS los usuarios registrados
// (lectores) y con los champions (editores), así que cualquiera podía navegarla
// en Drive y ver skills, resúmenes y la lista completa de cajas de todos los
// clientes — cosas que no le tocan.
//
// Ahora la abre ConfigData con la identidad del propietario y sirve solo lo que
// el llamante puede ver. La carpeta deja de estar compartida con nadie.
//
// ── El precio, decidido a conciencia (Sergio, 2026-08-03) ───────────────────
// Las escrituras pasan a figurar en Drive a nombre del propietario. No hay
// forma de evitarlo: en Drive, escribir con tu identidad EXIGE permiso de
// escritura, y ese permiso IMPLICA poder ver la carpeta. Que conste el autor y
// que nadie tenga acceso son incompatibles. Se eligió lo segundo, y la autoría
// se conserva en el rastro de auditoría (`cfgAudit_`), que además es el único
// registro que los propios autores no pueden alterar.
//
// ── Qué acota el daño de tener scope de Drive ───────────────────────────────
// No existe un scope "solo esta carpeta", así que ConfigData pide `drive`
// entero. La contención es de código y está verificada en el build y en jest:
//   · TODA escritura pasa por `cfgMetaWriteFile_` — ninguna otra función del
//     fichero puede contener un verbo de escritura de Drive.
//   · `cfgMetaFolder_` solo resuelve subcarpetas de la ALLOWLIST, y siempre
//     colgando de FLAT_ROOT_ID. Nunca acepta una ruta del llamante.

var CFG_META_ROOT_ = 'KDD_Studio_metadata';

// Tope de tamaño del proxy. NO es una cifra elegida a gusto: el sobre de una
// skill lleva el zip DENTRO y viaja por DOS saltos HTTP (ConfigData →
// OAuthToken → plugin), cada uno contra el límite de 50 MB de respuesta de
// UrlFetchApp, más el envoltorio JSON y el coste de tener el fichero entero en
// memoria dentro del límite de ejecución de Apps Script.
//
// 25 MB deja margen para los dos saltos; por encima de ~10 MB ya va lento. El
// cap de extracción del zip son 80 MB (`ZIP_MAX_TOTAL_BYTES`) y eso NO cabe por
// aquí de ninguna manera — si algún día una skill se acerca, hay que sacar el
// zip del sobre JSON, no subir este número.
//
// Por encima del tope se FALLA con un mensaje claro. Nunca se trocea ni se
// sirve incompleto: el plugin verifica el zip contra el hash que firmó el
// admin, así que un truncamiento no daría "fichero corto", daría "posible
// manipulación en Drive" y mandaría a investigar un ataque inexistente.
var CFG_META_MAX_BYTES_ = 25 * 1024 * 1024;

// Subcarpetas permitidas y rol MÍNIMO para leer y para escribir en cada una.
// 'any' = cualquier usuario registrado en el Sheet. Una carpeta que no esté
// aquí no se sirve: fail-closed, y el llamante no puede inventarse rutas.
// OJO: las carpetas se llaman `skills/…`, NO `automations/…` — el vocabulario
// del código dice "automations" pero las constantes de los handlers
// (`AUTOMATIONS_FOLDER = 'KDD_Studio_metadata/skills'`) apuntan a `skills`. Con
// las claves equivocadas el proxy rechaza TODAS las llamadas reales y el error
// que se ve es "No autorizado", que manda a buscar un problema de permisos.
var CFG_META_FOLDERS_ = {
  '':                  { read: 'any',   write: 'admin' },     // sources-registry.json
  'skills':            { read: 'any',   write: 'admin' },     // registry.json firmado + audit
  'skills/validated':  { read: 'any',   write: 'admin' },     // sobres de skills aprobadas
  'skills/pending':    { read: 'admin', write: 'champion' },  // envíos a revisión
  // El autor (champion) tiene que poder RETIRAR su propio rechazo una vez lo ha
  // consumido: `metaDelete` usa el gate de escritura, así que con 'admin' esos
  // borrados fallaban siempre dentro de un catch vacío y los ficheros se
  // acumulaban en Drive para siempre. Misma exposición que `skills/pending`: el
  // registro FIRMADO hace inerte cualquier fichero plantado aquí (modelo #238).
  'skills/rejected':   { read: 'any',   write: 'champion' },  // motivo del rechazo, lo lee y retira el autor
  'group-resumes':     { read: 'any',   write: 'admin' },
};

// ¿El llamante alcanza el nivel pedido? 'any' exige estar en el Sheet — un
// email de fuera del Sheet no es "cualquiera", es un desconocido.
function cfgMetaRoleOk_(roleInfo, needed) {
  if (roleInfo.isAdmin === true) { return true; }        // admin todo
  if (needed === 'admin') { return false; }
  // "¿Es champion de ALGO?" — no de una caja concreta. Mira las DOS listas: con
  // el Sheet migrado, la de nombres solo lleva los legacy irresolubles, así que
  // un champion con todas sus celdas en S-ID la tiene vacía.
  if (needed === 'champion') {
    return (roleInfo.championSources || []).length > 0
      || (roleInfo.championSourceIds || []).length > 0;
  }
  return roleInfo.found === true;                        // 'any'
}

// Resuelve una subcarpeta de la allowlist bajo <FLAT_ROOT_ID>/KDD_Studio_metadata.
// `create` solo lo usa la escritura. NUNCA construye la ruta con datos del
// llamante: `key` ya viene validada contra CFG_META_FOLDERS_.
function cfgMetaFolder_(key, create) {
  var props = PropertiesService.getScriptProperties();
  var flatRootId = props.getProperty('FLAT_ROOT_ID') || '';
  if (!flatRootId) { throw new Error('FLAT_ROOT_ID no configurada en ConfigData'); }
  var folder = DriveApp.getFolderById(flatRootId);
  var parts = [CFG_META_ROOT_].concat(String(key || '') ? String(key).split('/') : []);
  for (var i = 0; i < parts.length; i++) {
    var it = folder.getFoldersByName(parts[i]);
    if (it.hasNext()) { folder = it.next(); continue; }
    if (!create) { return null; }
    folder = cfgMetaCreateFolder_(folder, parts[i]);
  }
  return folder;
}

function cfgMetaFileIn_(folder, name) {
  var it = folder.getFilesByName(String(name || ''));
  return it.hasNext() ? it.next() : null;
}

// Rol cacheado 60 s — SOLO para el proxy de metadata.
//
// Cada operación `meta*` es una ejecución completa de Apps Script que abría el
// Excel de Roles otra vez. Con el panel de admin (1 `metaList` + N `metaRead`
// secuenciales) eso son N aperturas del Sheet para una pantalla.
//
// Se cachea AQUÍ y no en `cfgLookupRole_` a propósito: los gates de
// autorización de `grant`/`revoke` tienen que releer el rol FRESCO dentro del
// lock (es la defensa anti-TOCTOU, con test propio). Un rol cacheado en ese
// camino significaría conceder con una potestad de hace un minuto.
//
// Un `warning` NUNCA se cachea: un fallo transitorio del Sheet se convertiría
// en un minuto entero de denegaciones.
var CFG_ROLE_CACHE_TTL_S_ = 60;

function cfgLookupRoleCached_(email) {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  if (!cache) { return cfgLookupRole_(email); }
  var key = 'role:' + String(email || '').toLowerCase();
  try {
    var hit = cache.get(key);
    if (hit) { return JSON.parse(hit); }
  } catch (e) { /* cache ilegible → se lee fresco */ }
  var info = cfgLookupRole_(email);
  if (info && !info.warning) {
    try { cache.put(key, JSON.stringify(info), CFG_ROLE_CACHE_TTL_S_); } catch (e) { /* best-effort */ }
  }
  return info;
}

// ── Clave de idempotencia de las escrituras (#326) ───────────────────────────
//
// `grant`/`revoke` pasan a ser REPETIBLES para poder recuperarse cuando el buzón
// de Apps Script pierde la respuesta — eran las dos únicas operaciones sin
// segunda oportunidad, así que cada respuesta perdida era un error en la cara
// del operador mientras las lecturas se recuperaban solas.
//
// Repetirlas ya era casi inocuo desde #318: la fila del Sheet se reescribe al
// mismo valor y la ACL va a una cola que COLAPSA por (email, caja). Lo ÚNICO que
// duplicaba era la fila de auditoría, y eso es lo que corta esto.
//
// TTL holgado a propósito: la cadena completa de reintentos (3 intentos de
// cliente a 75 s + el del relay) cabe de sobra en 10 minutos. Pasado ese rato,
// una repetición ya no es un reintento — es una acción nueva del operador, y esa
// SÍ tiene que dejar su fila.
var CFG_REQUEST_TTL_S_ = 600;

/**
 * ¿Se ha visto ya esta clave? La marca en el mismo acto.
 *
 * Sin `requestId` devuelve false (plugin viejo): back-compat, el peor caso es el
 * comportamiento de antes. Sin caché disponible también, y por lo mismo:
 * **fallar hacia auditar de más**, nunca hacia auditar de menos — una fila
 * duplicada es ruido, una que falta es un agujero en el rastro.
 *
 * No hace falta atomicidad: los dos llamantes corren dentro del lock de escritura.
 */
function cfgRequestYaVisto_(requestId) {
  var id = String(requestId || '').trim();
  if (!id) { return false; }
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { cache = null; }
  if (!cache) { return false; }
  var key = 'req:' + id;
  try {
    if (cache.get(key)) { return true; }
    cache.put(key, '1', CFG_REQUEST_TTL_S_);
  } catch (e2) { return false; }
  return false;
}

// ── Generación de la caché de lecturas (#325) ────────────────────────────────
//
// Contador que sube en CADA escritura del Sheet de Roles. El publicador lo
// captura junto con los datos y lo vuelve a mirar antes de escribir en
// `CacheService`: si cambió, su foto ya es vieja y descarta la publicación.
//
// Vive en ScriptProperties y NO en CacheService a propósito: si se desalojara,
// dos fotos distintas parecerían de la misma generación y volvería la carrera.
var CFG_CACHE_GEN_KEY_ = 'CACHE_GEN';

// ── Cronómetro por etapa (#365 — diagnóstico de cuellos de botella) ──────────
//
// El plugin ya recibe del relay cuánto tardó la ejecución entera y cuánto la
// entrega por el buzón (`_perf`, #324), pero eso no dice DÓNDE se fue el tiempo
// dentro de la acción. Con el cutover a S-ID, `grant`/`revoke`/`listBoxUsers`
// pasaron a leer también el ÁRBOL (667 filas en BBVA) y una de esas lecturas
// cae DENTRO del `ScriptLock`, que es el único mutex del proyecto. Sin medirlo,
// la única forma de saber si eso importa era desplegar y esperar a que alguien
// se quejara.
//
// `lock` es la etapa que más avisa: la espera por el mutex sube MUCHO antes de
// que nadie llegue a ver un `Could not acquire lock`. Es el indicador
// adelantado de la contención, no el síntoma.
//
// Acumula por etapa {ms, n}. Vive en una global de ejecución: Apps Script da un
// contexto nuevo por invocación, así que no hay estado que se arrastre entre
// llamadas ni entre usuarios. Coste: un `Date.now()` por etapa.
var CFG_PERF_ = null;

/** Arranca la medición de esta ejecución. Solo lo llama el dispatcher. */
function cfgPerfReset_() { CFG_PERF_ = {}; }

/** Suma `ms` a una etapa y cuenta una ocurrencia. Inerte si nadie ha reseteado
 *  (ejecuciones por `Run` desde el editor, triggers): medir no es su trabajo. */
function cfgPerfSumar_(etapa, ms) {
  if (!CFG_PERF_) { return; }
  var e = CFG_PERF_[etapa] || { ms: 0, n: 0 };
  e.ms += ms;
  e.n += 1;
  CFG_PERF_[etapa] = e;
}

/** Cierra la medición y devuelve el desglose para colgarlo de la respuesta. */
function cfgPerfVolcar_(totalMs) {
  var out = { totalMs: totalMs };
  for (var k in CFG_PERF_) {
    if (Object.prototype.hasOwnProperty.call(CFG_PERF_, k)) {
      out[k] = { ms: CFG_PERF_[k].ms, n: CFG_PERF_[k].n };
    }
  }
  CFG_PERF_ = null;
  return out;
}

/**
 * Lee una hoja entera midiendo cuánto cuesta. `etapa` separa el ÁRBOL (la
 * incógnita: 667 filas sin índice) de la hoja de ROLES.
 *
 * Todas las lecturas completas pasan por aquí a propósito: repartidas por el
 * fichero, la siguiente que se añada se quedaría fuera de la medición y el
 * desglose empezaría a mentir por omisión, que es peor que no medir.
 */
function cfgLeerHoja_(sheet, etapa) {
  var t = Date.now();
  try { return sheet.getDataRange().getValues(); }
  finally { cfgPerfSumar_(etapa, Date.now() - t); }
}

/**
 * Escribe UNA celda midiendo cuánto cuesta.
 *
 * TODA escritura del Excel pasa por aquí o por `cfgAnadirFila_`, por el mismo
 * motivo que todas las lecturas completas pasan por `cfgLeerHoja_`: repartidas
 * por el fichero, la siguiente que alguien añada se queda fuera del cronómetro y
 * el desglose empieza a mentir POR OMISIÓN, que es peor que no medir.
 *
 * Y eso no es hipotético: hasta aquí, LAS ESCRITURAS ERAN EL ÚNICO TRAMO SIN
 * MEDIR de grant y revoke. Medido en NFQ el 2026-08-27, un grant con `post 7,0s`
 * cuyas etapas solo justificaban 2,2 s — los otros 4,8 no se le podían achacar a
 * nada, y por eso nadie sabía si valía la pena tocarlo.
 *
 * `fila` y `col` son 1-based (los de `getRange`), no índices del array de
 * valores. El +1 se queda en el llamante a propósito: moverlo aquí lo
 * escondería, y el desfase entre los dos sistemas es de lo que más se falla.
 */
function cfgEscribirCelda_(sheet, fila, col, valor) {
  var t = Date.now();
  try { sheet.getRange(fila, col).setValue(valor); }
  finally { cfgPerfSumar_('escritura', Date.now() - t); }
}

/** Añade una fila al final midiendo cuánto cuesta. Misma etapa y mismo motivo
 *  que `cfgEscribirCelda_`: un alta escribe por aquí en vez de por celdas, y
 *  dejarla fuera haría que el alta de un usuario nuevo —el caso más lento—
 *  fuera justo el que no se mide. */
function cfgAnadirFila_(sheet, valores) {
  var t = Date.now();
  try { sheet.appendRow(valores); }
  finally { cfgPerfSumar_('escritura', Date.now() - t); }
}

/**
 * Refleja en la FOTO EN MEMORIA las cuatro columnas de rol que se acaban de
 * escribir en la hoja (fila `i` de `values`, índice 0-based de la matriz).
 *
 * El censo que viaja en la respuesta de `grant`/`revoke` sale de esa foto, no
 * de una relectura: dentro del lock, la foto más estas asignaciones son
 * exactamente lo que la hoja tendrá tras el volcado, y releer costaría otra
 * lectura completa de Roles (`×2 → ×3`) para obtener lo mismo. **Si añades una
 * columna que grant/revoke escriban, refléjala aquí o en su llamante**: el
 * censo de la respuesta mentiría por omisión, que es el fallo que más cuesta
 * ver — el panel lo pinta como verdad y nadie vuelve a preguntar al servidor
 * hasta la siguiente apertura.
 */
function cfgReflejarFila_(values, i, colE, colF, colG, colH) {
  values[i][4] = colE;
  values[i][5] = colF;
  values[i][6] = colG;
  values[i][7] = colH;
}

/**
 * Toma el `ScriptLock` midiendo la ESPERA. El `finally` es deliberado: la
 * espera que más interesa es la que acaba en excepción —el `waitLock` agotado—,
 * y con un `catch` fuera del cronómetro ese caso no se registraría.
 */
function cfgTomarLock_(lock, ms) {
  var t = Date.now();
  try { lock.waitLock(ms); }
  finally { cfgPerfSumar_('lock', Date.now() - t); }
}

function cfgCacheGen_() {
  try { return Number(PropertiesService.getScriptProperties().getProperty(CFG_CACHE_GEN_KEY_) || '0') || 0; }
  catch (e) { return 0; }
}

/**
 * Vuelca al Sheet las escrituras pendientes. Lo llama TODO escritor del Excel
 * antes de soltar el `ScriptLock`; los que además cambian permisos lo hacen
 * justo antes de `cfgBumpCacheGen_()`, y ahí la pareja es lo que cierra la
 * carrera: una sola de las dos mitades no vale.
 *
 * ⚠ `cfgActionResolveSid_` vuelca pero **NO bumpea**, y es correcto (#390):
 * acuñar un S-ID no cambia ninguna celda de rol, así que no hay censo que
 * invalidar. No "completes la pareja" ahí — `CACHE_GEN` es GLOBAL, y subirlo en
 * cada primera apertura de caja dejaría el camino rápido de `listBoxUsers`
 * inalcanzable para toda la plantilla hasta la siguiente publicación (≤10 min).
 *
 * Apps Script deja las escrituras de Spreadsheet EN BUFFER hasta que algo las
 * fuerza (aquí no había un solo `flush` en todo `gas/`), mientras que
 * `PropertiesService` es visible al instante. Sin este volcado, un `revoke` hace
 * visible su BUMP antes que sus DATOS: `CACHE_GEN` nace como cota SUPERIOR de la
 * foto, y entonces da igual en qué orden lea el publicador —ningún reordenamiento
 * del lector convierte en cota inferior algo que ya nace por delante—. La
 * secuencia mala es:
 *
 *   bump visible → el publicador sella G+1 → lee datos VIEJOS (aún sin volcar) →
 *   vuelca el revoke → re-comprobación: G+1 === G+1, PASA → publica el censo
 *   previo al revoke bajo la generación vigente.
 *
 * O sea: al revocado le sigue respondiendo la caché hasta 10 minutos. Con el
 * volcado delante, los datos aterrizan ANTES que el bump y `CACHE_GEN` vuelve a
 * ser cota inferior, que es lo que la re-comprobación del publicador necesita.
 *
 * Es una función aparte —y por eso está en `ABRE_EXCEL`— porque el invariante del
 * build prohíbe nombrar el servicio de hojas de cálculo fuera de esa lista, y lo
 * comprueba por TEXTO: hasta en un comentario suelto lo denuncia. No abre nada:
 * solo vuelca. Best-effort — si el volcado falla, lo peor que queda es la ventana
 * que ya había antes de #325.
 */
function cfgFlushSheet_() {
  cfgAssertPrivileged_();
  // Cuenta como ESCRITURA, no como etapa propia: Apps Script deja las
  // escrituras EN BUFFER, así que lo que los `setValue` de arriba parecen
  // ahorrarse aterriza aquí. Separarlas partiría en dos mitades sin sentido el
  // coste de una sola cosa, y la mitad barata invitaría a la conclusión
  // contraria ("escribir el Excel no cuesta nada").
  var t = Date.now();
  try { SpreadsheetApp.flush(); }
  catch (e) {
    Logger.log('cfgFlushSheet_: no se pudo volcar el Sheet (' + (e && e.message ? e.message : String(e)) +
      ') — la caché de lecturas podría publicar una foto previa a este cambio durante una pasada.');
  }
  finally { cfgPerfSumar_('escritura', Date.now() - t); }
}

/** Sube la generación. Best-effort y RUIDOSO al fallar: si no sube, el
 *  publicador puede escribir una foto vieja sin enterarse. */
function cfgBumpCacheGen_() {
  try {
    var props = PropertiesService.getScriptProperties();
    var actual = Number(props.getProperty(CFG_CACHE_GEN_KEY_) || '0') || 0;
    props.setProperty(CFG_CACHE_GEN_KEY_, String(actual + 1));
  } catch (e) {
    Logger.log('cfgBumpCacheGen_ falló: ' + (e && e.message ? e.message : String(e)) +
      ' — la caché de lecturas podría servir un censo previo a este cambio hasta la próxima pasada.');
  }
}

// ── Camino rápido de `listBoxUsers`: la clave no se puede construir sin la
//    autorización (#325) ─────────────────────────────────────────────────────
//
// La mitad PÚBLICA no tiene hoy ningún gate propio: la identidad (`cfgCaller_`) y
// la potestad (`cfgAuthorityForEmail_`) viven en la privilegiada, al otro lado
// del relay. Servir el censo desde una caché en la pública no es "leer en vez de
// relayar": es construir un gate donde no había ninguno, y si se hace mal es un
// bypass del control de accesos.
//
// Por eso el diseño NO es "gate primero, censo después" —eso depende de que el
// gate esté bien escrito, y de que siga estándolo dentro de un año—: es que la
// clave del censo NO SE PUEDE CONSTRUIR sin la autorización.
//
//   fpmgr:<gen>:<email>          → { b: { "<clave-de-caja>": "<salt>" }, at }
//   fpbox:<gen>:<clave>:<salt>   → { u: [ …censo… ], at }
//
// El `salt` es un UUID que solo existe dentro de la entrada del email
// autorizado. Sin él no hay clave que pedir: olvidar un gate no filtra, produce
// un MISS. Pedir la caja de otro tampoco: sale otra clave, que no existe.
//
// Tres reglas que van con esto y no son opcionales:
//
//   1. **La caché NUNCA deniega.** Cualquier ausencia —salt, entrada, frescura—
//      devuelve `null`, y quien llama cae al relay, que tiene el gate REAL.
//      Concluir "no tienes permiso" desde un miss convertiría un desalojo de
//      `CacheService` en una denegación a quien sí tiene derecho.
//   2. **`<gen>` va en las DOS claves.** Cualquier `grant`/`revoke` sube
//      `CACHE_GEN`, así que el camino rápido entero queda inalcanzable —no
//      "invalidado": inalcanzable, porque las claves que se piden ya son otras—
//      hasta la siguiente publicación. Un cambio de permisos deja a todo el
//      mundo cayendo al relay durante ≤10 min. Más lento, nunca incorrecto.
//   3. **El `salt` se regenera en cada pasada.** Una entrada `fpbox:` que
//      sobreviva a su publicación queda huérfana: ningún `fpmgr:` la nombra.
var CFG_FASTPATH_MGR_PREFIJO_ = 'fpmgr:';
var CFG_FASTPATH_BOX_PREFIJO_ = 'fpbox:';

/** TTL de ALMACENAMIENTO. Es el fusible, no el bound de frescura: ese lo da el
 *  trigger (10 min) y lo aplica `cfgFastPathFresco_` al LEER. Un TTL menor que
 *  el intervalo del trigger dejaría la caché fría media vida. */
var CFG_FASTPATH_TTL_S_ = 30 * 60;

/** Corte de frescura al LEER: dos pasadas del trigger de 10 min menos margen.
 *  Acota lo viejo que puede llegar a ser un censo servido si el publicador deja
 *  de correr, y —junto al TTL— acota también el único escenario en que la
 *  generación podría retroceder: que alguien borre `CACHE_GEN` a mano. */
var CFG_FASTPATH_FRESCURA_MS_ = 15 * 60 * 1000;

function cfgFastPathMgrKey_(gen, email) {
  return CFG_FASTPATH_MGR_PREFIJO_ + gen + ':' + String(email || '').toLowerCase().trim();
}

/**
 * La ÚNICA función del proyecto que construye la clave del censo, y no la puede
 * construir sin `salt`. Verificado en el build (`scripts/gas-invariants.js`):
 * `CFG_FASTPATH_BOX_PREFIJO_` no se referencia desde ninguna otra función, y
 * esta solo se llama desde el lector y desde el publicador.
 *
 * El `salt` es un UUID (sin `:`), así que va el ÚLTIMO a propósito: dos cajas
 * distintas no pueden producir nunca la misma clave, por raros que sean sus
 * nombres.
 */
function cfgFastPathBoxKey_(gen, boxKey, salt) {
  return CFG_FASTPATH_BOX_PREFIJO_ + gen + ':' + boxKey + ':' + salt;
}

function cfgFastPathFresco_(at) {
  var t = Number(at);
  if (!isFinite(t) || t <= 0) { return false; }
  var delta = new Date().getTime() - t;
  // Un sello del FUTURO es un reloj torcido o una entrada manipulada: no se
  // sirve. `delta >= 0` no vale — el desfase entre ejecuciones de Apps Script
  // llega a decenas de ms y tiraría publicaciones sanas.
  return delta > -60000 && delta < CFG_FASTPATH_FRESCURA_MS_;
}

/** El `salt` de una caja PARA ESTE EMAIL, o '' si no lo tiene. '' significa
 *  siempre "no lo sé", nunca "no tiene permiso". */
function cfgFastPathSalt_(gen, email, boxKey) {
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { return ''; }
  if (!cache) { return ''; }
  var crudo = null;
  try { crudo = cache.get(cfgFastPathMgrKey_(gen, email)); } catch (e) { return ''; }
  if (!crudo) { return ''; }
  var idx = null;
  try { idx = JSON.parse(crudo); } catch (e) { return ''; }
  if (!idx || !idx.b || !cfgFastPathFresco_(idx.at)) { return ''; }
  var salt = idx.b[boxKey];
  return (typeof salt === 'string' && salt) ? salt : '';
}

/** Censo cacheado de una caja para este email, o `null`. `null` = cae al relay. */
function cfgFastPathCenso_(gen, email, boxKey) {
  var salt = cfgFastPathSalt_(gen, email, boxKey);
  if (!salt) { return null; }
  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (e) { return null; }
  if (!cache) { return null; }
  var crudo = null;
  try { crudo = cache.get(cfgFastPathBoxKey_(gen, boxKey, salt)); } catch (e) { return null; }
  if (!crudo) { return null; }
  var reg = null;
  try { reg = JSON.parse(crudo); } catch (e) { return null; }
  if (!reg || !Array.isArray(reg.u) || !cfgFastPathFresco_(reg.at)) { return null; }
  return reg.u;
}

// Tras escribir el Sheet, el rol cacheado del afectado deja de ser cierto.
function cfgInvalidateRoleCache_(email) {
  try { CacheService.getScriptCache().remove('role:' + String(email || '').toLowerCase()); }
  catch (e) { /* best-effort: como mucho caduca solo en 60 s */ }
}

// Valida la petición: carpeta en la allowlist + rol suficiente. Devuelve
// { ok:false, error } o { ok:true, key, roleInfo }.
function cfgMetaGate_(caller, payload, mode) {
  var key = String((payload && payload.folder) || '');
  var rule = Object.prototype.hasOwnProperty.call(CFG_META_FOLDERS_, key) ? CFG_META_FOLDERS_[key] : null;
  if (!rule) { return { ok: false, error: 'Carpeta no permitida: "' + key + '"' }; }
  var roleInfo = cfgLookupRoleCached_(caller.email);
  if (roleInfo && roleInfo.warning) {
    return { ok: false, error: 'No se pudo determinar el acceso del usuario: ' + roleInfo.warning };
  }
  if (!cfgMetaRoleOk_(roleInfo, rule[mode])) {
    return { ok: false, error: 'No autorizado para ' + (mode === 'write' ? 'escribir en' : 'leer') + ' "' + (key || CFG_META_ROOT_) + '".' };
  }
  return { ok: true, key: key, roleInfo: roleInfo };
}

// `metaList` — nombres de fichero de una subcarpeta permitida.
function cfgActionMetaList_(caller, payload) {
  var gate = cfgMetaGate_(caller, payload, 'read');
  if (!gate.ok) { return gate; }
  try {
    var folder = cfgMetaFolder_(gate.key, false);
    if (!folder) { return { ok: true, files: [] }; }
    var out = [];
    var it = folder.getFiles();
    while (it.hasNext()) {
      var f = it.next();
      out.push({ name: f.getName(), modifiedTime: f.getLastUpdated().toISOString(), size: f.getSize() });
    }
    return { ok: true, files: out };
  } catch (err) {
    return { ok: false, error: 'metaList error: ' + (err && err.message ? err.message : String(err)) };
  }
}

// `metaRead` — contenido de un fichero de una subcarpeta permitida.
//
// `sources-registry.json` se sirve YA RECORTADO a las cajas legibles del
// llamante. Antes el fichero entero (la lista de TODAS las cajas de todos los
// clientes) se descargaba a cada máquina y el recorte lo hacía el plugin; el
// que abriera el JSON en disco lo veía completo. Ahora el recorte es
// server-side, igual que el del árbol.
function cfgActionMetaRead_(caller, payload) {
  var gate = cfgMetaGate_(caller, payload, 'read');
  if (!gate.ok) { return gate; }
  var name = String((payload && payload.name) || '').trim();
  if (!name || name.indexOf('/') >= 0) { return { ok: false, error: 'Nombre de fichero no válido' }; }
  try {
    var folder = cfgMetaFolder_(gate.key, false);
    var file = folder ? cfgMetaFileIn_(folder, name) : null;
    if (!file) { return { ok: true, found: false }; }
    var size = file.getSize();
    if (size > CFG_META_MAX_BYTES_) {
      return { ok: false, error: '"' + name + '" pesa ' + Math.round(size / (1024 * 1024)) + ' MB y el máximo por el proxy es ' +
        Math.round(CFG_META_MAX_BYTES_ / (1024 * 1024)) + ' MB — no se sirve troceado a propósito: el plugin verifica el contenido contra un hash firmado y un truncamiento parecería manipulación.' };
    }
    var content = file.getBlob().getDataAsString();
    if (gate.key === '' && name === 'sources-registry.json') {
      content = cfgFilterRegistry_(content, gate.roleInfo);
    }
    return { ok: true, found: true, content: content, modifiedTime: file.getLastUpdated().toISOString() };
  } catch (err) {
    return { ok: false, error: 'metaRead error: ' + (err && err.message ? err.message : String(err)) };
  }
}

// Tope de lecturas por lote. Veinte cubre con holgura lo que agrupa el plugin
// (dos registros al abrir caja, los sobres pendientes del panel admin) y acota
// lo que una sola ejecución puede tener en memoria a la vez.
var CFG_META_BATCH_MAX_ = 20;

// `metaBatch` — varias LECTURAS del proxy en UNA sola ejecución.
//
// Cada viaje al GAS cuesta ~10 s fijos (despacho + arranque + buzón) dé igual
// lo que pida, y abrir una caja disparaba cuatro o cinco `metaRead`/`metaList`
// seguidos que traían KBs. Esto los junta en un viaje.
//
// LO QUE NO RELAJA, y es lo que se revisa aquí: cada ítem pasa por la MISMA
// acción que pasaría suelto (`cfgActionMetaRead_`/`cfgActionMetaList_`), o sea
// por `cfgMetaGate_` con su allowlist de carpetas y su rol mínimo — y el
// registro de cajas llega igual de recortado. Un ítem denegado NO tumba el
// lote: vuelve como `{ok:false, error}` en su posición y los demás siguen. El
// rol sale de `cfgLookupRoleCached_` (60 s), así que el Excel se abre una vez
// por lote y no una por ítem.
//
// El tope de bytes es el MISMO del proxy (`CFG_META_MAX_BYTES_`), acumulado: la
// respuesta entera viaja por dos saltos HTTP con el límite de UrlFetchApp. El
// ítem que lo rebasa vuelve con `overflow:true` para que el plugin lo pida
// suelto — nunca se sirve troceado (ver el comentario del tope).
function cfgActionMetaBatch_(caller, payload) {
  var items = payload && payload.items;
  if (!Array.isArray(items) || items.length === 0) { return { ok: false, error: 'Falta items' }; }
  if (items.length > CFG_META_BATCH_MAX_) {
    return { ok: false, error: 'El lote trae ' + items.length + ' lecturas y el máximo es ' + CFG_META_BATCH_MAX_ + '.' };
  }
  var results = [];
  var bytes = 0;
  for (var i = 0; i < items.length; i++) {
    var it = items[i] && typeof items[i] === 'object' ? items[i] : {};
    var op = String(it.op || '');
    var res;
    if (op === 'read') {
      res = cfgActionMetaRead_(caller, { folder: it.folder, name: it.name });
    } else if (op === 'list') {
      res = cfgActionMetaList_(caller, { folder: it.folder });
    } else {
      res = { ok: false, error: 'Operación no válida en el lote: "' + op + '" (read | list)' };
    }
    if (res && res.ok === true && typeof res.content === 'string') {
      if (bytes + res.content.length > CFG_META_MAX_BYTES_) {
        res = {
          ok: false, overflow: true,
          error: 'El lote supera los ' + Math.round(CFG_META_MAX_BYTES_ / (1024 * 1024)) + ' MB acumulados — pide este fichero suelto.',
        };
      } else {
        bytes += res.content.length;
      }
    }
    results.push(res);
  }
  return { ok: true, results: results };
}

// Recorta el registro a las cajas legibles. Un fallo de parseo NO devuelve el
// original: se propaga el error. Servir el registro completo ante un JSON raro
// sería exactamente la fuga que este proxy viene a cerrar.
function cfgFilterRegistry_(raw, roleInfo) {
  var reg = JSON.parse(raw);
  var legibles = cfgReadableSids_(roleInfo);
  if (legibles === null) { return raw; }                 // admin: sin filtro
  var all = reg.sources || [];
  var kept = [];
  for (var i = 0; i < all.length; i++) {
    // Por S-ID: cada entrada del registro lleva el suyo, así que aquí el filtro
    // por nombre sobraba desde el primer día (dos homónimas pasaban las dos).
    if (cfgEsCajaLegible_(legibles, all[i].sid, all[i].name)) { kept.push(all[i]); }
  }
  reg.sources = kept;
  return JSON.stringify(reg);
}

// El registro de cajas (`sources-registry.json`) es un CACHE DERIVADO del
// árbol, no contenido de usuario: lo regenera ConfigData por su cuenta al
// asignar un S-ID.
//
// Antes lo escribía OAuthToken con el token del USUARIO que abría la caja, y
// eso solo funciona mientras `KDD_Studio_metadata` esté compartida con él. En
// cuanto se retire el share (#279·#5), nadie podría escribirlo — ni el
// propietario, porque OAuthToken corre con la identidad de cada usuario — y el
// registro se congelaría: las cajas nuevas no entrarían nunca y, con el filtro
// cross-source ya en fail-closed, dejarían de servirse.
//
// NUNCA lanza: el S-ID ya está asignado y esa es la operación crítica.
function cfgRegenerateRegistry_(rows) {
  // Etapa PROPIA, ni `escritura` ni `auditoria`: esto no toca el Excel, escribe
  // un fichero en Drive. Cae dentro del lock del grant cuando la caja se
  // materializa —el caso más lento del alta, y el único que nadie mide porque
  // solo ocurre la primera vez de cada caja—, así que mezclarla con la escritura
  // de Roles repetiría el error que estamos corrigiendo aquí mismo.
  var t = Date.now();
  try {
    var sources = [];
    for (var i = 0; i < rows.length; i++) {
      if (!rows[i].sid) { continue; }
      sources.push({ sid: rows[i].sid, name: rows[i].servicio, areaPath: rows[i].areaPath });
    }
    var reg = { version: 2, generatedAt: new Date().toISOString(), sources: sources };
    cfgMetaWriteFile_('', 'sources-registry.json', JSON.stringify(reg, null, 1), 'application/json');
    return sources.length;
  } catch (err) {
    Logger.log('cfgRegenerateRegistry_: no se pudo reescribir el registro — ' + (err && err.message ? err.message : String(err)));
    return -1;
  } finally {
    cfgPerfSumar_('registro', Date.now() - t);
  }
}

// `rebuildRegistry` — regeneración manual del registro. ADMIN ONLY. Lo llama
// `rebuildRegistryFromTree_` de OAuthToken (Run desde el editor).
function cfgActionRebuildRegistry_(caller) {
  var roleInfo = cfgLookupRole_(caller.email);
  if (roleInfo.isAdmin !== true) { return { ok: false, error: 'Solo un admin puede regenerar el registro.' }; }
  try {
    var tree = cfgReadTree_(cfgTreeSheet_());
    var n = cfgRegenerateRegistry_(tree.rows);
    if (n < 0) { return { ok: false, error: 'No se pudo escribir el registro (revisa FLAT_ROOT_ID).' }; }
    return { ok: true, withSid: n, total: tree.rows.length };
  } catch (err) {
    return { ok: false, error: 'rebuildRegistry error: ' + (err && err.message ? err.message : String(err)) };
  }
}

// `metaWrite` — ÚNICA función del fichero que escribe en Drive. El build y los
// tests fallan si aparece un verbo de escritura fuera de aquí.
function cfgActionMetaWrite_(caller, payload) {
  var gate = cfgMetaGate_(caller, payload, 'write');
  if (!gate.ok) {
    cfgAudit_({
      actor: caller.email, via: caller.via, action: 'metaWrite', result: 'denegado',
      target: String((payload && payload.name) || ''), box: String((payload && payload.folder) || ''),
      reason: gate.error,
    });
    return gate;
  }
  var name = String((payload && payload.name) || '').trim();
  if (!name || name.indexOf('/') >= 0) { return { ok: false, error: 'Nombre de fichero no válido' }; }
  var content = String((payload && payload.content) != null ? payload.content : '');
  if (content.length > CFG_META_MAX_BYTES_) {
    return { ok: false, error: 'El contenido supera el máximo del proxy (' + Math.round(CFG_META_MAX_BYTES_ / (1024 * 1024)) + ' MB).' };
  }
  // CAS opcional: lo usa el registro FIRMADO de skills, donde dos admins
  // aprobando a la vez producirían un lost-update silencioso. Aquí, además, es
  // ATÓMICO — la comprobación y la escritura van dentro del mismo lock. El CAS
  // que hacía el plugin era client-side y por tanto TOCTOU (#250·#16).
  var expected = String((payload && payload.expectedModifiedTime) || '');
  var lock = LockService.getScriptLock();
  try { cfgTomarLock_(lock, 30000); }
  catch (eLock) { return { ok: false, error: 'Could not acquire lock — retry' }; }

  try {
    if (expected) {
      var actual = cfgMetaCurrentModifiedTime_(gate.key, name);
      if (actual && actual !== expected) {
        return {
          ok: false, conflict: true,
          error: '"' + name + '" cambió en Drive desde que lo leíste (esperabas ' + expected + ', hay ' + actual + ') — vuelve a leer y reintenta.',
        };
      }
    }
    var res = cfgMetaWriteFile_(gate.key, name, content, (payload && payload.mimeType) || 'application/json');
    // En Drive esto figurará a nombre del propietario, así que esta fila es el
    // ÚNICO sitio donde consta quién lo escribió de verdad.
    cfgAudit_({
      actor: caller.email, via: caller.via, action: 'metaWrite', result: 'ok',
      target: name, box: gate.key || CFG_META_ROOT_,
      reason: content.length + ' bytes',
    });
    return { ok: true, modifiedTime: res.modifiedTime };
  } catch (err) {
    return { ok: false, error: 'metaWrite error: ' + (err && err.message ? err.message : String(err)) };
  } finally {
    lock.releaseLock();
  }
}

// modifiedTime actual de un fichero, o '' si no existe. Sale del MISMO sitio
// que el que devuelve `metaRead`, así que los dos lados del CAS comparan
// cadenas producidas igual — mezclarlo con el `modifiedTime` de la API REST de
// Drive haría que cada escritura pareciera un conflicto.
function cfgMetaCurrentModifiedTime_(key, name) {
  var folder = cfgMetaFolder_(key, false);
  var file = folder ? cfgMetaFileIn_(folder, name) : null;
  return file ? file.getLastUpdated().toISOString() : '';
}

// `metaDelete` — retira un fichero de una carpeta permitida. Lo necesitan la
// aprobación de skills (mueve de pending a validated y borra el original) y el
// autor consumiendo su propio rechazo. Mismo gate de ESCRITURA que metaWrite.
// Idempotente: un fichero que no está devuelve ok con removed:false.
function cfgActionMetaDelete_(caller, payload) {
  var gate = cfgMetaGate_(caller, payload, 'write');
  if (!gate.ok) {
    cfgAudit_({
      actor: caller.email, via: caller.via, action: 'metaDelete', result: 'denegado',
      target: String((payload && payload.name) || ''), box: String((payload && payload.folder) || ''),
      reason: gate.error,
    });
    return gate;
  }
  var name = String((payload && payload.name) || '').trim();
  if (!name || name.indexOf('/') >= 0) { return { ok: false, error: 'Nombre de fichero no válido' }; }
  try {
    var removed = cfgMetaDeleteFile_(gate.key, name);
    if (removed) {
      cfgAudit_({
        actor: caller.email, via: caller.via, action: 'metaDelete', result: 'ok',
        target: name, box: gate.key || CFG_META_ROOT_,
      });
    }
    return { ok: true, removed: removed };
  } catch (err) {
    return { ok: false, error: 'metaDelete error: ' + (err && err.message ? err.message : String(err)) };
  }
}

// ── ÚNICOS puntos de escritura a Drive de todo ConfigData ────────────────────
// Si añades otra escritura, va AQUÍ o el build se para. `key` viene siempre de
// la allowlist (`cfgMetaGate_`), nunca del llamante.
function cfgMetaWriteFile_(key, name, content, mimeType) {
  var folder = cfgMetaFolder_(key, true);
  var file = cfgMetaFileIn_(folder, name);
  if (file) { file.setContent(content); }
  else { file = folder.createFile(name, content, mimeType); }
  return { modifiedTime: file.getLastUpdated().toISOString() };
}

function cfgMetaCreateFolder_(parent, name) {
  return parent.createFolder(name);
}

// A la PAPELERA, nunca un borrado definitivo: así es reversible 30 días. El
// llamante ya no tiene acceso a la carpeta, así que si esto borrara de verdad
// no podría recuperar nada por su cuenta.
function cfgMetaDeleteFile_(key, name) {
  var folder = cfgMetaFolder_(key, false);
  var file = folder ? cfgMetaFileIn_(folder, name) : null;
  if (!file) { return false; }
  file.setTrashed(true);
  return true;
}

// ── Router ───────────────────────────────────────────────────────────────────

function cfgDispatch_(payload) {
  // CHOQUE ÚNICO (#292). Aquí no se enruta por identidad —eso es lo que se
  // corrigió del enunciado de la tarea: en la pública, el login del PROPIETARIO
  // también da `getEffectiveUser() === OWNER`, así que enrutar por identidad le
  // mandaría el login al dispatcher del Excel. Enruta el marcador `cfgRelay`
  // que pone `relayConfigData_`; AUTORIZA esta línea.
  //
  // Va antes de tocar nada: un `cfgRelay` forjado contra la implementación
  // pública muere aquí, sin leer el payload y sin abrir el Excel. Los tres
  // abridores repiten el assert por su cuenta, así que esto es la primera
  // barrera y no la única.
  cfgAssertPrivileged_();

  var action = String((payload && payload.action) || '');
  var caller = cfgCaller_(payload);
  if (!caller.ok) { return { ok: false, error: caller.error }; }

  // Desglose de tiempos por etapa, colgado de la respuesta (#365). El relay
  // añade `_perf` (cuánto tardó todo y cuánto el buzón); esto dice DÓNDE se fue
  // el tiempo dentro de la acción. Campo con guion bajo y añadido al final: es
  // metadato, no contrato — un plugin que no lo conozca lo ignora.
  //
  // Va DESPUÉS del gate de identidad: una llamada que no pasa `cfgCaller_` no
  // merece medición ni debe recibir información de cómo se comporta el interior.
  // El enrutado se queda AQUÍ, en cadena `else if` en vez de en una función
  // aparte con `return` por rama. Extraerlo era más limpio de leer, pero el
  // invariante `fallosLlamanteEnProceso` (#327) lo cazó al instante: cualquier
  // símbolo que llame a una `cfgAction*` en proceso tiene que estar en
  // `ACCIONES_EN_PROCESO`, porque saltarse el relay puentea `cfgCaller_`. Meter
  // el dispatcher partido en esa lista blanca habría relajado un guard de
  // control de accesos para acomodar un cronómetro — al revés de como se
  // decide. La cadena de aquí abajo no la relaja.
  cfgPerfReset_();
  var t0 = Date.now();
  var res;
  if (action === 'role') { res = cfgActionRole_(caller); }
  else if (action === 'tree') { res = cfgActionTree_(caller); }
  else if (action === 'treeRaw') { res = cfgActionTreeRaw_(caller); }
  else if (action === 'rolesMatrix') { res = cfgActionRolesMatrix_(caller); }
  else if (action === 'rebuildRegistry') { res = cfgActionRebuildRegistry_(caller); }
  else if (action === 'resolveSid') { res = cfgActionResolveSid_(caller, payload); }
  else if (action === 'boxAcl') { res = cfgActionBoxAcl_(caller, payload); }
  else if (action === 'listBoxUsers') { res = cfgActionListBoxUsers_(caller, payload); }
  else if (action === 'grant') { res = cfgActionGrant_(caller, payload); }
  else if (action === 'revoke') { res = cfgActionRevoke_(caller, payload); }
  else if (action === 'trailBatch') { res = cfgActionTrailBatch_(caller, payload); }
  else if (action === 'metaList') { res = cfgActionMetaList_(caller, payload); }
  else if (action === 'metaRead') { res = cfgActionMetaRead_(caller, payload); }
  else if (action === 'metaBatch') { res = cfgActionMetaBatch_(caller, payload); }
  else if (action === 'metaWrite') { res = cfgActionMetaWrite_(caller, payload); }
  else if (action === 'metaDelete') { res = cfgActionMetaDelete_(caller, payload); }
  else { res = { ok: false, error: 'Unknown ConfigData action: ' + action }; }
  if (res && typeof res === 'object') { res._cfg = cfgPerfVolcar_(Date.now() - t0); }
  return res;
}

// SIN `doGet`/`doPost` PROPIOS, y es intencionado (#292).
//
// Este fichero se pega como uno más del proyecto de OAuthToken, así que el punto
// de entrada HTTP es el suyo: `doPost` mira `payload.cfgRelay === true` y, solo
// entonces, llama a `cfgDispatch_`. Reintroducir aquí un `doGet`/`doPost`
// pisaría en SILENCIO al de OAuthToken (gana el que se evalúe el último, y eso
// depende del orden de los ficheros en el editor) y dejaría el login caído sin
// que nada lo delate. El chequeo de colisiones de `scripts/gas-invariants.js`
// convierte ese error en un build roto: no lo desactives para "probar algo".

// ── Diagnóstico manual (Run desde el editor, como propietario) ───────────────

/**
 * Lista los S-ID de las celdas E-H que NO existen en el árbol (#365, decisión 2).
 *
 * Es la compensación pactada por que el Sheet deje de ser legible de un vistazo:
 * con las celdas en `S049` el admin ya no detecta a ojo un S-ID muerto, y un
 * S-ID muerto es un acceso concedido a NADA — la persona cree tener la caja y no
 * la tiene, sin un solo error por medio.
 *
 * Vive AQUÍ y no en `cfgLookupRole_` a propósito: detectarlo en el login exige
 * leer la pestaña del árbol en cada login, que es exactamente el coste que
 * retira la fase C. Aquí se paga UNA lectura, cuando un humano la pide.
 *
 * Solo informa. No toca ni una celda: un S-ID huérfano puede ser una caja que
 * aún no se ha dado de alta en el árbol, y borrarlo por nuestra cuenta sería
 * decidir por el admin justo en la tabla de permisos.
 */
function cfgAuditarSidsHuerfanos() {
  cfgAssertPrivileged_();
  var sheet = cfgOpenRolesSheet_();
  if (!sheet) { Logger.log('❌ No hay hoja de roles configurada (SHEET_ID / SHEET_NAME).'); return; }
  var leido = cfgArbolLector_()();
  if (!leido) { Logger.log('❌ Árbol ilegible — sin él no se puede decidir qué S-ID sobra. No se concluye nada.'); return; }

  var vivos = leido.indice.nombrePorSid;
  var values = cfgLeerHoja_(sheet, 'roles');
  var total = 0;
  var huerfanos = 0;
  for (var i = 2; i < values.length; i++) {
    var email = String(values[i][1] || '').trim();
    if (!email) { continue; }
    var sueltos = [];
    for (var col = 4; col <= 7; col++) {
      var celda = cfgSplitSids_(values[i][col], null);
      for (var s = 0; s < celda.sids.length; s++) {
        total++;
        if (vivos[celda.sids[s]] === undefined) { sueltos.push(celda.sids[s] + ' (col ' + cfgLetraColumna_(col) + ')'); }
      }
    }
    if (sueltos.length > 0) {
      huerfanos += sueltos.length;
      Logger.log('⚠️ fila ' + (i + 1) + ' · ' + email + ' → ' + sueltos.join(', '));
    }
  }
  Logger.log(huerfanos === 0
    ? '✅ ' + total + ' S-ID concedidos, todos existen en el árbol.'
    : '🔴 ' + huerfanos + ' de ' + total + ' S-ID concedidos NO existen en el árbol (ver arriba). ' +
      'Cada uno es un acceso a ninguna parte: o falta la caja en el árbol, o la celda quedó con un S-ID viejo.');
}

/** Letra de columna del Sheet a partir del índice 0-based (col E = 4). */
function cfgLetraColumna_(idx) {
  return String.fromCharCode(65 + idx);
}

// ── Migrador del Sheet de Roles a S-ID (#365, fase D) ────────────────────────
//
// Reescribe las celdas E-H sustituyendo cada NOMBRE por el S-ID de su caja.
// Dos entradas separadas y no un parámetro, porque `Run` del editor solo
// ejecuta funciones SIN argumentos: el dry-run es el que se llama por su nombre
// obvio, y aplicar exige elegir a conciencia la otra.
//
//   Run → cfgMigrarRolesDryRun()   informe, no toca NADA
//   Run → cfgMigrarRolesAplicar()  backup + escribe lo inequívoco
//
// ⛔ NO resuelve ambigüedades. Un nombre que casa DOS cajas se queda como está y
// sale en el informe: elegir por su cuenta entre dos homónimas ES el bug #293
// que este cutover viene a cerrar, solo que cometido de una vez y por escrito.

function cfgMigrarRolesDryRun() { cfgMigrarRoles_(false); }
function cfgMigrarRolesAplicar() { cfgMigrarRoles_(true); }

/**
 * @param {boolean} aplicar  false = informe; true = backup + escritura.
 *
 * Idempotente: una celda ya migrada no produce cambio, así que reejecutarlo es
 * inocuo y el segundo informe sale limpio.
 *
 * ⚠ LA PASADA QUE ESCRIBE VA ENTERA BAJO EL `ScriptLock` (#371). Sin él, este
 * era el ÚNICO camino que reescribe el Sheet de Roles sin tomar el mutex que sí
 * toman las otras cinco funciones que escriben ahí — `cfgActionGrant_` y
 * `cfgActionRevoke_` incluidas. La secuencia que lo rompía:
 *
 *   migrador fotografía el Sheet → un champion concede desde el panel (toma el
 *   lock, re-lee, escribe, `flush`, ENCOLA el ítem de ACL, responde `ok:true` y
 *   audita) → el migrador vuelca sus celdas calculadas sobre la foto de T0 y
 *   PISA la fila recién escrita.
 *
 * Ninguna de las dos defensas aparentes aguanta: el respaldo copia `values`,
 * que es la lectura de T0, así que tampoco contiene la escritura concurrente; y
 * reejecutar el migrador solo traduce nombre→S-ID, nunca reañade un token
 * retirado. El reintento no es "vuelve a ejecutarlo", es reconstruir a mano.
 *
 * **El caso grave es el REVOKE perdido, no el grant.** Un grant perdido
 * converge solo: el usuario se queda con EDITOR real en Drive (el ítem de la
 * cola drena igual) y sin permiso en el Sheet, y la siguiente pasada del sync
 * calcula el censo DESDE el Sheet, no lo encuentra y se lo retira. Un revoke
 * perdido es lo contrario — el sync reconcilia Drive desde el Sheet, así que el
 * acceso retirado RESUCITA y nadie lo relaciona con la migración de ayer.
 *
 * Retenerlo hasta 30 s es exactamente para lo que está el mutex: es un `Run`
 * manual, de un solo uso, y el runbook lo ejecuta en producción sin ventana de
 * mantenimiento. La ALTERNATIVA descartada (re-leer celda a celda justo antes
 * de cada `setValue` y saltarla si cambió) deja la ventana abierta entre la
 * comprobación y la escritura y multiplica los round-trips; el mutex la cierra
 * de verdad. El dry-run NO toma el lock: no escribe nada.
 */
function cfgMigrarRoles_(aplicar) {
  cfgAssertPrivileged_();
  if (!aplicar) { cfgMigrarRolesPasada_(false); return; }
  var lock = LockService.getScriptLock();
  try { cfgTomarLock_(lock, 30000); }
  catch (eLock) {
    // No se degrada a "escribo igual": quien tiene el lock es un grant/revoke a
    // medias, que es justo la escritura que esta pasada pisaría.
    Logger.log('❌ No se pudo tomar el lock (hay un grant/revoke en curso) — NO se ha tocado nada. ' +
      'Vuelve a ejecutar Run → cfgMigrarRolesAplicar() en un momento.');
    return;
  }
  try {
    // La LECTURA va dentro del lock, no solo la escritura: una foto tomada
    // antes de esperar hasta 30 s por el mutex no es el estado de ahora, y
    // escribir sobre ella es el bug entero.
    cfgMigrarRolesPasada_(true);
  } finally {
    lock.releaseLock();
  }
}

/** El cuerpo de la pasada. Lo llama `cfgMigrarRoles_`, que es quien decide si
 *  va bajo el lock (aplicar) o no (dry-run). */
function cfgMigrarRolesPasada_(aplicar) {
  var sheet = cfgOpenRolesSheet_();
  if (!sheet) { Logger.log('❌ No hay hoja de roles configurada (SHEET_ID / SHEET_NAME).'); return; }
  var leido = cfgArbolLector_()();
  if (!leido) {
    // Sin árbol no se puede resolver ni un nombre. Seguir escribiría el Sheet
    // dejándolo exactamente igual y el informe diría "nada que migrar" sobre una
    // avería: el peor desenlace posible para una herramienta de una sola pasada.
    Logger.log('❌ Árbol ILEGIBLE — no se puede resolver ningún nombre. No se toca nada.');
    return;
  }

  var values = cfgLeerHoja_(sheet, 'roles');
  var cambios = [];        // { fila, col, antes, despues }
  var ambiguos = [];
  var desconocidos = [];
  var sinAcunar = [];
  var yaMigradas = 0;

  for (var i = 2; i < values.length; i++) {
    var email = String(values[i][1] || '').trim();
    if (!email) { continue; }
    for (var col = 4; col <= 7; col++) {
      var crudo = String(values[i][col] == null ? '' : values[i][col]);
      var plan = cfgPlanMigracionCelda_(crudo, leido.indice);
      var etiqueta = 'fila ' + (i + 1) + ' col ' + cfgLetraColumna_(col) + ' · ' + email;
      for (var a = 0; a < plan.ambiguos.length; a++) {
        var amb = plan.ambiguos[a];
        // Dos motivos DISTINTOS para no tocar la celda, y hay que decir cuál es
        // (#386): con varios S-ID el humano elige entre ellos; con uno solo hay
        // más filas que S-ID, así que el candidato tentador es precisamente el
        // que NO se puede usar — es el caso que antes se migraba solo.
        ambiguos.push(etiqueta + ' → "' + amb.nombre + '" ' + (amb.sids.length > 1
          ? 'casa ' + amb.sids.join(' y ') + ' — DECIDE TÚ cuál es'
          : 'sale en ' + amb.filas + ' filas del árbol y solo ' + amb.sids.length + ' tiene S-ID' +
            (amb.sids.length === 1 ? ' (' + amb.sids[0] + ')' : '') +
            ' — abre la otra caja para que se le acuñe el suyo, o desambigua la fila a mano'));
      }
      for (var d = 0; d < plan.desconocidos.length; d++) {
        desconocidos.push(etiqueta + ' → "' + plan.desconocidos[d] + '" no existe en el árbol');
      }
      for (var s = 0; s < plan.sinAcunar.length; s++) {
        sinAcunar.push(etiqueta + ' → "' + plan.sinAcunar[s] + '" está en el árbol pero aún no tiene S-ID: ' +
          'ábrela una vez desde el explorador para que se le acuñe y vuelve a pasar el migrador');
      }
      if (!plan.cambia) { yaMigradas += plan.migrados; continue; }
      cambios.push({ fila: i + 1, col: col + 1, antes: crudo, despues: plan.celda, etiqueta: etiqueta });
    }
  }

  Logger.log('── Migración del Sheet de Roles a S-ID ' + (aplicar ? '(APLICAR)' : '(DRY RUN — no se escribe nada)') + ' ──');
  for (var c = 0; c < cambios.length; c++) {
    Logger.log('  ' + cambios[c].etiqueta + ' :: "' + cambios[c].antes + '"  →  "' + cambios[c].despues + '"');
  }
  for (var m = 0; m < ambiguos.length; m++) { Logger.log('  ⚠️ AMBIGUO  ' + ambiguos[m]); }
  for (var n = 0; n < desconocidos.length; n++) { Logger.log('  ⚠️ SIN CAJA ' + desconocidos[n]); }
  for (var q = 0; q < sinAcunar.length; q++) { Logger.log('  ⚠️ SIN S-ID  ' + sinAcunar[q]); }
  Logger.log('Resumen: ' + cambios.length + ' celda(s) a migrar · ' + yaMigradas + ' token(s) ya en S-ID · ' +
    ambiguos.length + ' ambiguo(s) · ' + sinAcunar.length + ' con la caja sin abrir · ' +
    desconocidos.length + ' sin caja en el árbol.');

  if (!aplicar) {
    Logger.log('DRY RUN: no se ha tocado nada. Para aplicar: Run → cfgMigrarRolesAplicar().');
    return;
  }
  if (cambios.length === 0) {
    Logger.log('✅ Nada que aplicar. (Lo ambiguo y lo que no tiene caja NO se migra nunca solo.)');
    return;
  }

  // BACKUP ANTES DE ESCRIBIR, y si falla se aborta: esto reescribe la tabla de
  // permisos de toda la plantilla y no hay "deshacer" que valga a los diez
  // minutos. El handle del libro sale de la hoja YA gateada por
  // `cfgOpenRolesSheet_` — no se vuelve a abrir el Excel por otra puerta.
  //
  // Se copia por VALORES (`insertSheet` + `setValues`) y no con `copyTo`: el
  // invariante de escritura a Drive prohíbe el renombrado de ficheros en este
  // fichero y lo comprueba por TEXTO —comentarios incluidos—, así que no
  // distingue el método de una hoja del de un fichero de Drive. De una tabla de
  // permisos, además, lo que hay que poder restaurar son los valores.
  var respaldo;
  try {
    respaldo = 'Roles-backup-' + cfgSelloDeTiempo_();
    var copia = sheet.getParent().insertSheet(respaldo);
    copia.getRange(1, 1, values.length, values[0].length).setValues(values);
  } catch (errBackup) {
    Logger.log('❌ No se pudo crear la pestaña de backup (' +
      (errBackup && errBackup.message ? errBackup.message : String(errBackup)) + '). NO se aplica nada.');
    return;
  }
  Logger.log('🗂️  Backup creado: pestaña "' + respaldo + '".');

  for (var w = 0; w < cambios.length; w++) {
    sheet.getRange(cambios[w].fila, cambios[w].col).setValue(cambios[w].despues);
  }
  cfgFlushSheet_();
  // Las listas de permisos cacheadas se derivan de estas celdas: sin subir la
  // generación, el camino rápido de `listBoxUsers` seguiría sirviendo el censo
  // de antes de la migración hasta 10 min (#325).
  cfgBumpCacheGen_();
  Logger.log('✅ Aplicadas ' + cambios.length + ' celda(s). Backup en "' + respaldo + '".');
}

/**
 * Plan de migración de UNA celda. Puro: no toca el Sheet ni el árbol (recibe el
 * índice ya leído).
 *
 * Devuelve `{ celda, cambia, migrados, ambiguos, desconocidos }`. El token que
 * no se puede resolver **se conserva tal cual** en `celda`: dejar fuera lo que
 * no sabemos traducir sería retirarle el acceso a alguien en silencio, que es
 * exactamente el fallo que este sistema no puede permitirse.
 */
function cfgPlanMigracionCelda_(raw, indice) {
  var tokens = cfgTokensDeCelda_(raw);
  var salida = [];
  var vistos = {};
  var migrados = 0;
  var ambiguos = [];
  var desconocidos = [];
  var sinAcunar = [];
  var cambia = false;

  var añadir = function (valor, clave) {
    if (vistos[clave] === true) { cambia = true; return; }   // dedup = cambio
    vistos[clave] = true;
    salida.push(valor);
  };

  for (var i = 0; i < tokens.length; i++) {
    var token = tokens[i];
    if (cfgEsSid_(token)) {
      var norm = cfgNormSid_(token);
      migrados++;
      if (norm !== token) { cambia = true; }                 // `S49` → `S049`
      añadir(norm, norm);
      continue;
    }
    var clave = cfgNormBox_(token);
    if (!clave) { continue; }
    // `cfgSidUnicoDeNombre_` y NO `sidsPorNombre[clave].length === 1` (#386):
    // ese array solo acumula filas CON S-ID, así que dos homónimas de las que
    // solo una está materializada parecían UNA sola caja inequívoca y la celda
    // se migraba a la caja de al lado — informando "0 ambiguos", sin salir en
    // ningún bucket y con el respaldo como única vuelta atrás. La definición
    // buena cuenta FILAS (`filasPorNombre`), que es la que usan todos los demás
    // consumidores del índice.
    var unico = cfgSidUnicoDeNombre_(indice, clave);
    if (unico) {
      cambia = true;
      añadir(unico, unico);
      continue;
    }
    var candidatos = indice.sidsPorNombre[clave] || [];
    var filas = indice.filasPorNombre[clave] || 0;
    // TRES motivos para no migrar, no dos, y el informe tiene que distinguirlos
    // porque el remedio es distinto en cada uno:
    //  · varias filas → decide una persona (o abre la caja que falta);
    //  · una fila sin S-ID → la caja EXISTE, solo que nadie la ha abierto y por
    //    eso no tiene S-ID que poner. Decir "no existe en el árbol" de una caja
    //    que sí está invita a borrar el token, que en esta tabla es retirar un
    //    acceso en silencio — justo lo que esta función promete no hacer;
    //  · ni una fila → ahí sí, el nombre no está en el árbol.
    if (filas > 1) { ambiguos.push({ nombre: token, sids: candidatos, filas: filas }); }
    else if (filas === 1) { sinAcunar.push(token); }
    else { desconocidos.push(token); }
    añadir(token, 'n:' + clave);
  }

  return {
    celda: salida.join(', '),
    cambia: cambia,
    migrados: migrados,
    ambiguos: ambiguos,
    desconocidos: desconocidos,
    sinAcunar: sinAcunar,
  };
}

/** Sello legible para el nombre de la pestaña de backup. */
function cfgSelloDeTiempo_() {
  return Utilities.formatDate(new Date(), 'Europe/Madrid', 'yyyyMMdd-HHmmss');
}

function cfgTestConfig() {
  // `Run` corre siempre como el propietario, así que esto pasa. Si NO pasara,
  // el problema es OWNER_EMAIL y no el Sheet — se dice explícitamente porque
  // ese error, visto desde el plugin, se disfraza de "tu cuenta no está
  // registrada".
  var propietario = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '');
  var efectivo = '';
  try { efectivo = String(Session.getEffectiveUser().getEmail() || ''); } catch (e) { efectivo = ''; }
  Logger.log('OWNER_EMAIL: ' + (propietario || 'VACÍA — ejecuta Run → cfgSetupOwner(); hasta entonces NADA puede abrir el Excel'));
  Logger.log('Usuario efectivo de esta ejecución: ' + (efectivo || '(no accesible)'));
  var privilegiada = true;
  try { cfgAssertPrivileged_(); } catch (ePriv) { privilegiada = false; }
  Logger.log('Ejecución privilegiada: ' + (privilegiada ? 'sí' : 'NO — el Excel está fuera de alcance desde aquí'));
  if (!privilegiada) { return; }

  var cfg = cfgConfig_();
  Logger.log('SHEET_ID configurado: ' + (cfg.sheetId ? 'sí' : 'NO'));
  Logger.log('Tab de roles: ' + cfg.sheetName + ' · tab del árbol: ' + cfg.treeSheetName);
  Logger.log('Dominios permitidos: ' + cfg.allowedDomains.join(', '));
  var props = PropertiesService.getScriptProperties();
  var inbox = props.getProperty('TRAIL_INBOX_FOLDER_ID') || '';
  Logger.log('Destino del rastro de accesos: ' + (inbox
    ? 'buzón del rastro (TRAIL_INBOX_FOLDER_ID) — la fila aparece en la hoja tras la consolidación, hasta 10 min'
    : 'hoja clásica AUDIT_SHEET_ID' + (props.getProperty('AUDIT_SHEET_ID') ? '' : ' — VACÍA: los accesos NO se están guardando en ningún sitio')));
  // Rastro de adopción (#313): las dos properties que lo sostienen, de un
  // vistazo. Sin buzón, trailBatch responde disabled; sin hoja, el consolidador
  // es no-op y los lotes esperan en el buzón.
  Logger.log('Rastro de adopción: buzón ' + (inbox ? 'OK' : 'FALTA (TRAIL_INBOX_FOLDER_ID) — trailBatch responderá disabled') +
    ' · hoja ' + (props.getProperty('TRAIL_SHEET_ID') ? 'OK' : 'FALTA (TRAIL_SHEET_ID) — cfgConsolidarRastro será no-op'));
  var sheet = cfgOpenRolesSheet_();
  Logger.log('Sheet de Roles legible: ' + (sheet ? 'sí (' + sheet.getLastRow() + ' filas)' : 'NO'));
  var audited = cfgAudit_({ actor: 'cfgTestConfig', via: 'manual', action: 'test', result: 'ok', reason: 'prueba de escritura del rastro' });
  Logger.log('Escritura de auditoría: ' + (audited ? 'OK' : 'FALLÓ — buzón inaccesible Y AUDIT_SHEET_ID vacía o ilegible'));

  // ── El salto al exterior, DE VERDAD ────────────────────────────────────────
  //
  // Todo lo de arriba corre en este proceso: por `Run` el Excel se abre en local
  // y el relay no se ejerce, así que el diagnóstico daba OK con `CONFIG_DATA_URL`
  // vacía, apuntando a una implementación retirada o devolviendo la página de
  // login de Google — que es el único camino por el que se loguea la plantilla.
  var url = props.getProperty('CONFIG_DATA_URL') || '';
  var idImpl = /\/s\/([^/]+)\//.exec(url);
  Logger.log('CONFIG_DATA_URL: ' + (url
    ? 'implementación ' + (idImpl ? idImpl[1] : '(ID no reconocido en la URL)')
    : 'VACÍA — el relay no puede salir y NADIE podrá loguearse'));
  if (url) {
    var eco = relayConfigData_('role');
    Logger.log('Relay contra CONFIG_DATA_URL: ' + (eco && eco.ok
      ? 'OK — responde JSON y despacha como privilegiada'
      : 'FALLÓ — ' + ((eco && eco.error) || 'sin respuesta utilizable') +
        '. Mientras esto falle, TODO el mundo verá "tu cuenta no está registrada".'));

    // LO QUE ESTA PRUEBA NO PUEDE VER, y por qué. Si `CONFIG_DATA_URL` apunta por
    // error a la implementación PÚBLICA, esto pasa igual: las dos corren el mismo
    // código y en la pública el usuario efectivo es QUIEN LLAMA — que aquí eres
    // tú, el propietario. Para el resto de la plantilla no: allí ejecutaría como
    // ELLOS y `cfgAssertPrivileged_` denegaría. Es decir, el login te funciona a
    // ti y a nadie más, y eres el único que no puede detectarlo.
    // Único chequeo posible, y es manual: el ID de arriba tiene que ser DISTINTO
    // del que usa el plugin (`scriptUrl` en src/core/environment.ts).
    Logger.log('COMPRUEBA A MANO: ese ID de implementación tiene que ser DISTINTO del que el plugin usa como scriptUrl. ' +
      'Si son el mismo, el login te funcionará solo a ti — ejecutando como propietario las dos mitades son indistinguibles desde aquí.');
  }
}
