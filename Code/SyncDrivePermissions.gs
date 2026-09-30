/**
 * maintain-permissions.gs — mantenimiento PERMANENTE (post-migración #239).
 *
 * Sustituye a `migrate-flat-boxes.gs` una vez la migración a carpeta-por-caja
 * ha terminado. Contiene SOLO lo que hace falta a partir de ahora:
 *
 *  - `syncDrivePermissions()` — botón permanente: realinea las ACLs de TODAS
 *    las carpetas planas `S###_*` + KDD_Studio_metadata con lo que dice el
 *    Sheet de Roles (añade lo que falta, retira lo que sobra). Úsalo cada vez
 *    que edites el Sheet a mano en bloque, o si sospechas que algo se ha
 *    desincronizado. Con muchas cajas puede pasar del presupuesto de 5 min:
 *    guarda el PROGRESO (Script Property) para no re-empezar y se AUTO-CONTINÚA
 *    sola (trigger temporal ~1 min) hasta COMPLETO, sin más clics. Un marcador
 *    colgado (>1h) se descarta → arranque fresco. `resetSyncProgress()` fuerza
 *    un arranque limpio a mano. La gestión de accesos DÍA A DÍA (alta/baja de un usuario
 *    en una caja) ya NO necesita este script — se hace desde la ventana
 *    "Gestión" del propio plugin (KDD Studio → Gestión → Gestión de accesos),
 *    que llama a los endpoints del GAS principal y actualiza Sheet + ACL en un
 *    solo paso.
 *  - `removeGlobalRootShare()` — NO es una operación regular: ya la ejecutaste
 *    una vez como cutover final de la migración. Se conserva aquí solo como
 *    herramienta DEFENSIVA/rara — por ejemplo si alguien vuelve a compartir
 *    por error la carpeta "Source Tree" o "KDD STUDIO" a todo el mundo (o a
 *    "cualquiera con el enlace"), re-ejecutarla lo limpia. Desde #289 limpia
 *    también los permisos de DOMINIO, de GRUPO y de "cualquiera con el enlace",
 *    que antes ni veía — o sea que hasta ahora esta línea prometía algo que la
 *    función no sabía hacer. Es idempotente: si no hay nada que retirar, loguea
 *    `retirados=0` sin tocar nada.
 *  - `listRootShares()` — diagnóstico de solo lectura: vuelca quién tiene hoy
 *    acceso directo a la raíz vieja, a "KDD STUDIO" y a KDD_Studio_metadata.
 *    Útil para comprobar de un vistazo que el cutover sigue siendo efectivo
 *    (nadie ha vuelto a aparecer con acceso directo a la raíz). Enseña SOLO
 *    principals de tipo `user`: para los de dominio, grupo y enlace usa
 *    `listNonUserShares()`.
 *  - `listNonUserShares()` — diagnóstico de solo lectura (#289): recorre la
 *    raíz plana, cada carpeta de caja, KDD_Studio_metadata, User-Connections,
 *    los ficheros de login y el Excel de Roles, y vuelca TODO permiso que no
 *    sea de tipo `user`. Es el inventario PREVIO —obligatorio antes de la
 *    primera pasada con el barrido nuevo: dice qué se va a perder— y la
 *    verificación POSTERIOR: después de la pasada tiene que salir vacío.
 *
 * DOS REDES DE SEGURIDAD, porque este script es destructivo por definición:
 *  - Si la matriz de roles NO se lee bien (cabecera desplazada, o cero filas
 *    con email válido), `flatReadRolesIndex_` LANZA en vez de devolver una
 *    lista vacía (#287). Con la lista vacía y `addOnly=false` la pasada retiraba
 *    a todo el mundo de todo —cajas, metadata y ficheros de LOGIN, con lo que
 *    nadie podía volver a arrancar el web app— y cerraba el log diciendo
 *    COMPLETO. Ahora la ejecución consta como ERROR y no se toca ninguna ACL.
 *  - `FLAT_MAX_RETIRADAS_` es un tope de retiradas POR PASADA: al superarlo,
 *    lanza y para. No evita las primeras N, pero convierte una catástrofe
 *    silenciosa en una ejecución parada y ruidosa.
 *
 * QUÉ SE QUITÓ respecto a `migrate-flat-boxes.gs` (ya no hace falta):
 *  - `migrateBoxesToFlatFolders()` — copiaba el árbol viejo → carpetas planas.
 *    Las cajas nuevas ya NO se crean así: `ensureFlatBoxFolder_` (parte del
 *    GAS principal, Código.gs) las crea sola la primera vez que alguien abre
 *    esa caja con el plugin. No hay nada más que copiar del árbol viejo.
 *  - `migrateGroupResumesToMetadata()` — copiaba los Folder_resume.md de los
 *    GRUPOS del árbol a KDD_Studio_metadata/group-resumes/. ⚠️ Si todavía NO
 *    has confirmado que esta función se ejecutó (al menos una vez, en
 *    COMPLETO) durante la migración, NO borres `SyncDrivePermissions.gs`
 *    todavía — ejecútala primero desde ahí. Si ya la corriste, no hace falta
 *    conservarla: los resúmenes de grupo nuevos los escribe el propio plugin
 *    directamente en su ubicación definitiva.
 *  - Los helpers de copia recursiva (`flatCopyFolderIncremental_`,
 *    `flatGetOrCreateRootFolder_`, `flatFindTreeBoxFolder_`,
 *    `flatDeleteContinuationTriggers_`, `flatFolderName_`, `flatMd5Hex_`) solo
 *    servían a las dos funciones de copia anteriores.
 *
 * DÓNDE VA: en el proyecto de **OAuthToken**, como fichero aparte
 * (`SyncDrivePermissions.gs`), NO en ConfigData. Aquí es donde están los scopes
 * de Drive y `shareNoEmail_`/`relayConfigData_`, que es lo que usa. ConfigData
 * no toca Drive: meter esto ahí rompería su invariante.
 *
 * Corre a MANO desde el editor (Run) o por TRIGGER, siempre como el propietario.
 * Los datos del Excel (matriz de roles y árbol) los pide a ConfigData con
 * acciones admin-only — nunca abre el Excel directamente.
 *
 * Cómo se le piden, que no es una sola respuesta (#327): los caminos de
 * `syncDrivePermissions` y los helpers manuales van por `relayConfigData_`, y ahí
 * el salto HTTP es lo que mantiene viva la señal de "`CONFIG_DATA_URL` está
 * rota". El publicador de la caché (`syncPublicarCacheLecturas_`) llama EN
 * PROCESO: corre cada 10 min desde un trigger, así que pagar el salto no compraba
 * nada y costaba una ejecución privilegiada por pasada. Lo que hace segura esa
 * excepción es que a este fichero no se llegue por HTTP, y eso lo fija un
 * invariante del build (`fallosSyncInalcanzablePorHttp`), no una convención.
 */

var FLAT_META_FOLDER_NAME_ = 'KDD_Studio_metadata';
var FLAT_BUDGET_MS_ = 5 * 60 * 1000;

// Tope de RETIRADAS de permisos por pasada (#287). Respaldo para las causas que
// no hemos previsto: los dos guards de `flatReadRolesIndex_` cazan la lectura
// rota que ya conocemos, pero cualquier otra que acabe en "no hay nadie que
// deba tener acceso" produce el mismo desastre. Al superar el tope se LANZA y
// se para; la ejecución consta como error, que es lo que hace que alguien mire.
//
// Una pasada de mantenimiento retira unas pocas. El número solo debería
// alcanzarse en una limpieza masiva DE VERDAD (la primera pasada del barrido de
// #289 sobre una instalación vieja): en ese caso, ensáyala antes con
// MIGRATE_DRY_RUN = true, comprueba en el log que lo que retiraría es lo que
// esperas, y solo entonces sube este número A PROPÓSITO.
//
// Cuenta la INTENCIÓN, no el efecto: un permiso heredado que falla con "access
// denied" también suma. El tope vigila el tamaño de la DECISIÓN, y una decisión
// de retirar 200 permisos hay que mirarla aunque Drive rechace la mitad.
var FLAT_MAX_RETIRADAS_ = 200;

// Contador de la pasada en curso. Lo resetean las entradas (`syncDrivePermissions`,
// `removeGlobalRootShare`, `revoke*`) — en Apps Script cada ejecución arranca un
// runtime limpio, pero dos entradas seguidas en la misma sí lo compartirían.
var flatRetiradasPasada_ = 0;

// Ponlo a true para simular sin escribir nada en Drive.
var MIGRATE_DRY_RUN = false;

// Cierre del Excel de Roles (#279): con `true`, CADA pasada del sync lo deja sin
// ningún permiso salvo el del propietario. Es el estado final que se busca —
// ConfigData lo abre como propietario y nadie más necesita acceso.
//
// ⚠️ Ponlo a FALSE si necesitas volver a compartirlo temporalmente. El caso
// real: mientras siga viva una implementación con CÓDIGO VIEJO, esa versión
// abre el Excel con la identidad de cada usuario, así que sin acceso su login
// falla con "tu cuenta no está registrada" — un mensaje que NO se parece a la
// causa. Si desbloqueas a alguien compartiéndoselo a mano y dejas esto en true,
// la siguiente pasada del sync se lo vuelve a quitar.
//
// Vuelve a true en cuanto todos estén en el deployment nuevo (#284).
var ROLES_SHEET_LOCKDOWN_ = true;

// Ficheros de LOGIN (Script Properties, listas de IDs separados por coma/;/
// espacio): el web app corre executeAs:USER_ACCESSING → cada usuario necesita
// LECTURA del proyecto de script (y biblioteca/config) para arrancar el
// deployment. LOGIN_SHARE_READER_IDS → lector para todos los registrados;
// LOGIN_SHARE_CHAMPION_EDITOR_IDS → editor para admins + KDD Champions, lector
// para el resto.
//
// Por defecto FULL: además de AÑADIR lo que falta, RETIRA/degrada a quien no
// debería tener acceso según el Sheet (revoca a los ex-usuarios y degrada a un
// editor que ya no es admin/champion). El propietario NUNCA se toca.
// ⚠️ Requisito: cualquier editor "a mano" de estos ficheros que deba conservar
// edición (un dev del código, un service account) tiene que estar marcado admin
// en el Sheet, o el sync lo degradará. Si necesitas conservar un editor que NO
// está en el Sheet, ponlo a false (modo ADD-ONLY: solo añade, no retira).
var LOGIN_FILES_REMOVE_EXTRA_ = true;

// Ficheros que este sync NUNCA reparte, pase lo que pase en las Script
// Properties (#279). Hoy solo uno: el Excel de Roles/árbol.
//
// Antes vivía en LOGIN_SHARE_CHAMPION_EDITOR_IDS (lector para todos, editor
// para los champions) porque el web app corría con la identidad del usuario y
// necesitaba abrirlo. Ya no: lo abre ConfigData como propietario. Si alguien
// vuelve a meter su ID en esas properties —y es lo que pasará, porque el
// nombre de la property invita a ello— este guard lo ignora y lo dice en el
// log, en vez de reabrir el agujero en silencio.
//
// Lo puebla flatReadRolesIndex_ con el sheetId que devuelve ConfigData, así que
// no hay un ID de Drive hardcodeado en el repo.
var FLAT_PROTECTED_FILE_IDS_ = [];

// Ficheros de infraestructura del GAS (el proyecto ConfigData y la hoja de
// auditoría): solo propietario + admins. Los DICE ConfigData en la respuesta de
// `rolesMatrix` — no hay lista que mantener aquí. Ver flatApplyPrivateFilesAcl_.
var FLAT_PRIVATE_FILE_IDS_ = [];

function flatIsProtectedFile_(fileId) {
  var id = String(fileId || '').trim();
  for (var i = 0; i < FLAT_PROTECTED_FILE_IDS_.length; i++) {
    if (FLAT_PROTECTED_FILE_IDS_[i] === id) { return true; }
  }
  return false;
}

// Auto-continuación + marcador de progreso de syncDrivePermissions. Al agotar el
// presupuesto de 5 min: (1) GUARDA qué cajas ya procesó en una Script Property
// (marcador) para NO re-empezar, y (2) AGENDA un trigger temporal que la re-lanza
// sola ~SYNC_CONTINUE_DELAY_MS_ después, hasta completar (entonces borra marcador
// + triggers). Un marcador más viejo que SYNC_PROGRESS_STALE_MS_ (cadena colgada)
// se descarta → arranque fresco. Forzar re-sync completo a mano: resetSyncProgress().
var SYNC_PROGRESS_PROP_ = 'SYNC_PERMS_PROGRESS';
var SYNC_PROGRESS_STALE_MS_ = 60 * 60 * 1000;
var SYNC_CONTINUE_HANDLER_ = 'syncDrivePermissions';
var SYNC_CONTINUE_DELAY_MS_ = 60 * 1000;

// ── Entradas ─────────────────────────────────────────────────────────────────

/** Sync masivo Sheet → ACLs (cajas planas + KDD_Studio_metadata + login +
 *  User-Connections). Botón permanente. Con muchas cajas pasa del presupuesto de
 *  5 min → guarda progreso y se auto-continúa por trigger (ver syncLoadProgress_/
 *  syncScheduleContinuation_). Idempotente. El param `e` solo existe cuando la
 *  invoca el trigger (se usa para el log; la decisión de reanudar la toma el
 *  marcador, no `e`). */
function syncDrivePermissions(e) {
  var startMs = new Date().getTime();
  flatResetRetiradas_();
  var flatRoot = flatGetFlatRoot_();
  var tree = flatReadTree_();
  var roles = flatReadRolesIndex_();
  var flatBySid = flatIndexRootFolders_(flatRoot);

  // sid → nombre real de caja (el nombre de la carpeta lleva el nombre
  // "aplanado"; el matching de col E/F/G se hace contra el nombre del Sheet).
  var nameBySid = {};
  for (var i = 0; i < tree.rows.length; i++) {
    if (tree.rows[i].sid) { nameBySid[tree.rows[i].sid] = tree.rows[i].servicio; }
  }

  // Marcador de progreso: reanuda donde se quedó (saltando las cajas ya hechas)
  // o arranca fresco si no hay marcador vigente. `e` truthy = continuación por trigger.
  var progress = syncLoadProgress_();
  // El tope acota el SYNC ENTERO, no cada eslabón: `syncDrivePermissions` es
  // también el handler del trigger de continuación, así que resetear a 0 aquí
  // dejaba que una cadena de N eslabones retirase 200·N sin que saltara nunca.
  flatRetiradasPasada_ = progress.retiradas;
  var doneSids = progress.doneSids;
  var stats = { cajas: 0, saltadas: 0, sinFila: 0, timedOut: false, continuacion: !!e };

  if (progress.phase === 'boxes') {
    for (var sid in flatBySid) {
      if (doneSids[sid]) { stats.saltadas++; continue; }
      if (new Date().getTime() - startMs > FLAT_BUDGET_MS_) {
        stats.timedOut = true;
        break;
      }
      var boxName = nameBySid[sid];
      if (!boxName) {
        stats.sinFila++;
        Logger.log('⚠️ Carpeta plana "' + flatBySid[sid].getName() + '" sin fila con S-ID ' + sid + ' en el árbol — ACL no tocada.');
        doneSids[sid] = true; // no re-visitar en la continuación
        continue;
      }
      flatApplyBoxAcl_(flatBySid[sid], sid, boxName, roles);
      doneSids[sid] = true;
      stats.cajas++;
    }
    if (stats.timedOut) {
      syncSaveProgress_(progress);      // phase sigue 'boxes'
      syncScheduleContinuation_();
      Logger.log('=== syncDrivePermissions PARCIAL (cajas) === procesadas-esta-pasada=' + stats.cajas +
        ' saltadas-ya-hechas=' + stats.saltadas + ' — se auto-continúa en ~' +
        Math.round(SYNC_CONTINUE_DELAY_MS_ / 1000) + 's (o re-ejecuta a mano).' + (MIGRATE_DRY_RUN ? ' [DRY RUN]' : ''));
      return stats;
    }
    progress.phase = 'tail'; // fase cajas COMPLETA
  }

  // Cola (metadata + login + User-Connections): pocas operaciones. Si ya vamos
  // pasados de presupuesto, continúa con presupuesto fresco para no morir a
  // mitad sin poder re-agendar.
  if (new Date().getTime() - startMs > FLAT_BUDGET_MS_) {
    syncSaveProgress_(progress);        // phase='tail'
    syncScheduleContinuation_();
    stats.timedOut = true;
    Logger.log('=== syncDrivePermissions PARCIAL (previo a metadata/login) === se auto-continúa en ~' +
      Math.round(SYNC_CONTINUE_DELAY_MS_ / 1000) + 's (o re-ejecuta a mano).' + (MIGRATE_DRY_RUN ? ' [DRY RUN]' : ''));
    return stats;
  }

  flatApplyMetadataAcl_(flatRoot, roles);
  flatApplyLoginFilesAcl_(roles);
  flatApplyUserConnectionsAcl_(flatRoot, roles);
  flatApplyPrivateFilesAcl_(roles);
  flatApplyRolesSheetAcl_();

  // COMPLETO → limpia marcador + triggers de continuación.
  syncClearProgress_();
  syncDeleteContinuationTriggers_();

  Logger.log(
    '=== syncDrivePermissions DONE === cajas-procesadas=' + stats.cajas +
    ' saltadas-ya-hechas=' + stats.saltadas +
    ' carpetas-sin-fila=' + stats.sinFila +
    ' (COMPLETO)' + (MIGRATE_DRY_RUN ? ' [DRY RUN]' : '')
  );
  return stats;
}

/** Fuerza un arranque limpio: borra el marcador de progreso + los triggers de
 *  continuación. Úsalo si quieres re-sincronizar TODO desde cero (p.ej. tras
 *  editar el Sheet a mitad de una cadena) sin esperar a que la anterior termine. */
function resetSyncProgress() {
  syncClearProgress_();
  syncDeleteContinuationTriggers_();
  Logger.log('resetSyncProgress: marcador + triggers de continuación borrados — el próximo syncDrivePermissions arranca de cero.');
}

// ── Progreso persistente + auto-continuación por trigger ──────────────────────

/** Carga el marcador de progreso (Script Property). Reanuda si es vigente
 *  (< SYNC_PROGRESS_STALE_MS_); si no hay / es viejo / corrupto → arranque fresco.
 *  `doneSids` = objeto { 'S044': true, ... } para lookup O(1). */
function syncLoadProgress_() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(SYNC_PROGRESS_PROP_) || '';
  if (raw) {
    try {
      var p = JSON.parse(raw);
      if (p && typeof p.startedAt === 'number' &&
          (new Date().getTime() - p.startedAt) < SYNC_PROGRESS_STALE_MS_) {
        var doneObj = {};
        var arr = String(p.done || '').split(',');
        for (var i = 0; i < arr.length; i++) { if (arr[i]) { doneObj[arr[i]] = true; } }
        return {
          startedAt: p.startedAt,
          phase: p.phase === 'tail' ? 'tail' : 'boxes',
          doneSids: doneObj,
          retiradas: typeof p.retiradas === 'number' ? p.retiradas : 0
        };
      }
      Logger.log('syncLoadProgress_: marcador viejo (>1h) — arranque fresco.');
    } catch (e) {
      Logger.log('syncLoadProgress_: marcador corrupto — arranque fresco. (' + e + ')');
    }
  }
  return { startedAt: new Date().getTime(), phase: 'boxes', doneSids: {}, retiradas: 0 };
}

/** Persiste el marcador (sids ya hechos como string compacto separado por coma). */
function syncSaveProgress_(progress) {
  if (MIGRATE_DRY_RUN) { return; }
  var done = [];
  for (var sid in progress.doneSids) { done.push(sid); }
  PropertiesService.getScriptProperties().setProperty(
    SYNC_PROGRESS_PROP_,
    // `retiradas` viaja con el marcador para que el tope acote la cadena entera
    // de continuaciones y no cada eslabón por separado.
    JSON.stringify({ startedAt: progress.startedAt, phase: progress.phase, done: done.join(','), retiradas: flatRetiradasPasada_ })
  );
}

function syncClearProgress_() {
  if (MIGRATE_DRY_RUN) { return; }
  try { PropertiesService.getScriptProperties().deleteProperty(SYNC_PROGRESS_PROP_); }
  catch (e) { Logger.log('syncClearProgress_: ' + (e && e.message ? e.message : String(e))); }
}

/** Agenda UNA re-ejecución temporal de syncDrivePermissions. Borra antes las
 *  continuaciones previas para no apilar triggers (quota de Apps Script). */
function syncScheduleContinuation_() {
  if (MIGRATE_DRY_RUN) { Logger.log('DRY: agendaría trigger de continuación de syncDrivePermissions'); return; }
  try {
    syncDeleteContinuationTriggers_();
    ScriptApp.newTrigger(SYNC_CONTINUE_HANDLER_).timeBased().after(SYNC_CONTINUE_DELAY_MS_).create();
    Logger.log('syncScheduleContinuation_: continuación agendada en ~' + Math.round(SYNC_CONTINUE_DELAY_MS_ / 1000) + 's.');
  } catch (e) {
    Logger.log('syncScheduleContinuation_: no se pudo agendar el trigger (¿quota de triggers?) — re-ejecuta a mano. (' + (e && e.message ? e.message : String(e)) + ')');
  }
}

/** Borra los triggers de continuación de syncDrivePermissions (los que crea
 *  syncScheduleContinuation_). No toca otros triggers del proyecto. */
function syncDeleteContinuationTriggers_() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === SYNC_CONTINUE_HANDLER_) {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
  } catch (e) {
    Logger.log('syncDeleteContinuationTriggers_: no se pudieron limpiar triggers — ' + (e && e.message ? e.message : String(e)));
  }
}

/** CUTOVER — NO es una operación regular. Se conserva como herramienta
 *  DEFENSIVA: retira los permisos directos del árbol viejo (Source Tree) Y de
 *  la carpeta "KDD STUDIO" (menos el owner en ambas). Úsala solo si alguien ha
 *  vuelto a compartir esas carpetas por error. */
function removeGlobalRootShare() {
  flatResetRetiradas_();
  var removed = 0;
  removed += flatStripDirectShares_(flatGetRoot_(), 'Source Tree (árbol viejo)');
  removed += flatStripDirectShares_(flatGetFlatRoot_(), 'carpeta de conocimiento');

  Logger.log('=== removeGlobalRootShare DONE === retirados=' + removed + (MIGRATE_DRY_RUN ? ' [DRY RUN]' : ''));
  Logger.log('Recuerda: tras esto ejecuta syncDrivePermissions una vez más para verificar que cada caja y KDD_Studio_metadata tienen sus ACLs.');
}

/** Retira TODOS los permisos DIRECTOS de una carpeta salvo el del propietario:
 *  editores y lectores, y desde #289 también los de dominio, de grupo y de
 *  "cualquiera con el enlace" — que son justo los que hacían falta para que
 *  `removeGlobalRootShare()` cumpliera lo que promete su comentario.
 *  Devuelve cuántos retiró. */
function flatStripDirectShares_(folder, label) {
  var ownerEmail = flatOwnerEmail_(folder);
  var removed = 0;

  var permisos = flatListPermisos_(folder);
  for (var i = 0; i < permisos.length; i++) {
    var perm = permisos[i];
    if (perm.rol === 'owner') { continue; }

    if (perm.tipo !== 'user') {
      flatContarRetirada_(label, flatDescribePermiso_(perm));
      if (flatRemovePermisoNoUsuario_(folder, perm, label) === 'retirado') { removed++; }
      continue;
    }

    if (!flatIsUserEmail_(perm.email) || perm.email === ownerEmail) { continue; }
    var esEditor = flatEsRolDeEdicion_(perm.rol);
    var papel = esEditor ? 'editor' : 'lector';
    flatContarRetirada_(label, papel + ' ' + perm.email);
    if (MIGRATE_DRY_RUN) { Logger.log('DRY: RETIRARÍA ' + papel + ' de [' + label + ']: ' + perm.email); removed++; continue; }
    try {
      if (esEditor) { folder.removeEditor(perm.email); } else { folder.removeViewer(perm.email); }
      removed++;
      Logger.log('RETIRADO ' + papel + ' de [' + label + ']: ' + perm.email);
    } catch (e) { Logger.log('ERROR retirando ' + papel + ' ' + perm.email + ' de [' + label + ']: ' + e); }
  }
  return removed;
}

/** Diagnóstico: quién tiene acceso hoy al árbol viejo, a la carpeta de
 *  conocimiento y a KDD_Studio_metadata (nivel nuevo). Solo lectura.
 *  OJO: `getEditors()`/`getViewers()` solo devuelven principals de tipo `user`,
 *  así que esta función NO enseña los permisos de dominio, de grupo ni de
 *  "cualquiera con el enlace" — para esos, `listNonUserShares()`. */
function listRootShares() {
  var treeRoot = flatGetRoot_();
  flatLogShares_('Source Tree (árbol viejo) "' + treeRoot.getName() + '"', treeRoot);
  try {
    var flatRoot = flatGetFlatRoot_();
    flatLogShares_('Carpeta de conocimiento "' + flatRoot.getName() + '"', flatRoot);
    var it = flatRoot.getFoldersByName(FLAT_META_FOLDER_NAME_);
    if (it.hasNext()) { flatLogShares_(FLAT_META_FOLDER_NAME_ + ' (nivel nuevo)', it.next()); }
  } catch (e) {
    Logger.log('FLAT_ROOT_ID sin configurar todavía — solo se listó Source Tree. (' + e + ')');
  }
}

/**
 * DIAGNÓSTICO de solo lectura (#289): vuelca TODO permiso que NO sea de tipo
 * `user` sobre la raíz plana, cada carpeta de caja, KDD_Studio_metadata,
 * User-Connections, los ficheros de login y el Excel de Roles.
 *
 * CERO ESCRITURAS. Se usa dos veces y las dos son obligatorias:
 *  1. ANTES de la primera pasada con el barrido de #289 — es la foto del antes
 *     y la lista de lo que se va a perder. Si sale un grupo que alguien usa a
 *     propósito, es aquí donde se ve, no después.
 *  2. DESPUÉS de la pasada — tiene que salir VACÍO.
 *
 * Hermano de `listRootShares()`, que hace lo mismo con los permisos de usuario.
 */
function listNonUserShares() {
  // `fueraDelSync` = los que syncDrivePermissions NO retira (exigen
  // removeGlobalRootShare); `noInspeccionados` = los items que no se han podido
  // mirar. Sin los dos, el cierre afirmaría cosas que esta función no sabe.
  var resumen = { total: 0, fueraDelSync: 0, noInspeccionados: 0 };
  var flatRoot = flatGetFlatRoot_();
  // La ACL de la propia raíz plana NO la toca el sync: solo removeGlobalRootShare.
  flatLogNonUserShares_('Carpeta de conocimiento "' + flatRoot.getName() + '"', flatRoot, resumen, false);

  var flatBySid = flatIndexRootFolders_(flatRoot);
  for (var sid in flatBySid) {
    flatLogNonUserShares_('caja ' + sid + ' "' + flatBySid[sid].getName() + '"', flatBySid[sid], resumen, true);
  }

  var itMeta = flatRoot.getFoldersByName(FLAT_META_FOLDER_NAME_);
  if (itMeta.hasNext()) { flatLogNonUserShares_(FLAT_META_FOLDER_NAME_, itMeta.next(), resumen, true); }
  var itConn = flatRoot.getFoldersByName('User-Connections');
  if (itConn.hasNext()) { flatLogNonUserShares_('User-Connections', itConn.next(), resumen, true); }

  // Ficheros sueltos: los de login (Script Properties) + el Excel de Roles y
  // los privados, que los dice ConfigData. Sin ellos el inventario se dejaría
  // fuera justo los ficheros cuya pérdida de acceso deja a la gente sin login.
  var props = PropertiesService.getScriptProperties();
  var ids = flatSplitIds_(props.getProperty('LOGIN_SHARE_READER_IDS') || '')
    .concat(flatSplitIds_(props.getProperty('LOGIN_SHARE_CHAMPION_EDITOR_IDS') || ''));
  var res = relayConfigData_('rolesMatrix', {});
  if (res && res.ok === true) {
    if (res.sheetId) { ids.push(String(res.sheetId)); }
    var privados = res.privateFileIds || [];
    for (var k = 0; k < privados.length; k++) { ids.push(String(privados[k])); }
  } else {
    resumen.noInspeccionados++;
    Logger.log('⚠️ listNonUserShares: ConfigData no respondió (' + ((res && res.error) || 'sin respuesta') +
      ') — NO se han revisado el Excel de Roles ni los ficheros privados. El inventario está incompleto.');
  }

  var vistos = {};
  for (var i = 0; i < ids.length; i++) {
    if (!ids[i] || vistos[ids[i]]) { continue; }
    vistos[ids[i]] = true;
    var file;
    try { file = DriveApp.getFileById(ids[i]); }
    catch (e) {
      resumen.noInspeccionados++;
      Logger.log('⚠️ listNonUserShares: fichero ' + ids[i] + ' no accesible — NO revisado. (' + e + ')');
      continue;
    }
    flatLogNonUserShares_('fichero "' + file.getName() + '"', file, resumen, true);
  }

  // El cierre NO puede decir "limpio" si no se ha podido mirar todo: esta línea
  // es la que se lee en el paso 4 del procedimiento para dar el agujero por
  // cerrado, y un fallo transitorio de Drive sobre UNA carpeta bastaba para que
  // un `anyone` vivo se colara como "Limpio".
  if (resumen.noInspeccionados) {
    Logger.log('=== listNonUserShares === ⚠️ INCOMPLETO: ' + resumen.noInspeccionados + ' item(s) NO se han podido revisar. ' +
      'Encontrados hasta ahora: ' + resumen.total + '. NO lo tomes como verificación: repítelo hasta que salga sin items sin revisar.');
    return resumen.total;
  }
  Logger.log('=== listNonUserShares === permisos NO-usuario encontrados: ' + resumen.total +
    (resumen.total
      ? ' — de esos, ' + (resumen.total - resumen.fueraDelSync) + ' los retira la próxima pasada de syncDrivePermissions y ' +
        resumen.fueraDelSync + ' NO (la ACL de la raíz plana solo la limpia removeGlobalRootShare). Revísalos antes.'
      : ' — nada de dominio, grupo ni enlace. Limpio.'));
  return resumen.total;
}

/**
 * Vuelca los permisos no-`user` de un item. Solo lectura.
 *
 * `loBarreElSync` distingue lo que retira `syncDrivePermissions` de lo que
 * exige `removeGlobalRootShare()`: sin esa distinción, el cierre prometía que
 * todo lo listado desaparecería en la próxima pasada, y para la raíz plana eso
 * es falso — con lo que el paso 4 del procedimiento ("tiene que salir vacío")
 * era inalcanzable y quien lo siguiera acabaría dudando del script, no de la
 * promesa.
 *
 * Un fallo al listar NO se traga como "cero": se cuenta como no inspeccionado.
 */
function flatLogNonUserShares_(label, item, resumen, loBarreElSync) {
  var permisos;
  try { permisos = flatListPermisos_(item); }
  catch (e) {
    resumen.noInspeccionados++;
    Logger.log('[' + label + '] ⚠️ no se pudieron listar los permisos — NO revisado. ' + e);
    return 0;
  }
  var n = 0;
  for (var i = 0; i < permisos.length; i++) {
    if (permisos[i].tipo === 'user' || permisos[i].rol === 'owner') { continue; }
    n++;
    Logger.log('[' + label + '] ' + flatDescribePermiso_(permisos[i]) +
      (loBarreElSync ? '' : '  ← NO lo retira syncDrivePermissions: usa removeGlobalRootShare()'));
  }
  resumen.total += n;
  if (!loBarreElSync) { resumen.fueraDelSync += n; }
  return n;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Árbol VIEJO (carpeta "Source Tree" — DRIVE_ROOT_ID de siempre). */
function flatGetRoot_() {
  var props = PropertiesService.getScriptProperties();
  var rootId = props.getProperty('DRIVE_ROOT_ID') || '';
  if (!rootId) { throw new Error('DRIVE_ROOT_ID no configurado en Script Properties.'); }
  return DriveApp.getFolderById(rootId);
}

/** Raíz del layout plano: la carpeta de CONOCIMIENTO (nivel NFQ-W/KDD STUDIO,
 *  padre de Source Tree). Script Property `FLAT_ROOT_ID`. */
function flatGetFlatRoot_() {
  var props = PropertiesService.getScriptProperties();
  var flatId = props.getProperty('FLAT_ROOT_ID') || '';
  if (!flatId) {
    throw new Error('FLAT_ROOT_ID no configurado en Script Properties. Abre la carpeta de conocimiento (la que contiene Source Tree, el GAS y el Excel de Roles) en drive.google.com y copia el ID de la URL (drive.google.com/drive/folders/<ID>).');
  }
  return DriveApp.getFolderById(flatId);
}

/** Indexa las carpetas de la raíz que son planas: { 'S044': Folder, ... }. */
function flatIndexRootFolders_(root) {
  var out = {};
  var it = root.getFolders();
  while (it.hasNext()) {
    var f = it.next();
    var m = /^(S\d{3,})_/.exec(f.getName());
    if (m) { out[m[1].toUpperCase()] = f; }
  }
  return out;
}

/** Normalización de nombres de caja — espejo de `normalizeSourceName` del plugin. */
function flatNormName_(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Lee el Sheet de Roles v3 (MATRIZ DE ROLES POR CAJA) → índice de usuarios.
 * Fila 3 en adelante (i=2), col B email, col C Tipo (informativo), col D
 * Admin (marca X), col E KDD Champions, col F KB Stewards, col G KB
 * Contributors, col H KB Consumers (#244). Nombres separados por , ; o \n.
 * Derivados para las ACLs: writeCajas = champions ∪ stewards (editores de la
 * carpeta de caja); workCajas = KB Contributors (col G — LECTORES de la caja y
 * editores solo de `KDD_WORK_EDITOR_SUBFOLDERS_`, #279·#3); readCajas = KB Consumers
 * (col H, lector puro); role = admin | kdd-champion | kb-steward |
 * kb-contributor (rol global derivado — lo consumen flatIsAdminRole_/
 * flatIsChampionRole_ para la ACL de metadata).
 *
 * Cada `*Cajas` es `{sids, nombres}` (#365 fase E): la celda se lee en sus DOS
 * dialectos y el JOIN de `flatExpectedBoxAcl_` prueba el S-ID primero.
 */
/**
 * Árbol de cajas. Antes era `readTree_(getTreeSheet_())`, que abría el tab del
 * Excel directamente; desde #279 ese fichero solo lo abre ConfigData, así que
 * viene por relay. La acción `treeRaw` es admin-only y esto corre a mano como
 * propietario, así que encaja. Forma `{ rows }`, igual que devolvía `readTree_`.
 */
function flatReadTree_() {
  var res = relayConfigData_('treeRaw', {});
  if (!res || res.ok !== true) {
    throw new Error('No se pudo leer el árbol desde ConfigData: ' + ((res && res.error) || 'sin respuesta') +
      '. Revisa CONFIG_DATA_URL y que ejecutes esto como un usuario admin.');
  }
  return { rows: res.rows || [] };
}

function flatReadRolesIndex_() {
  // El Excel de Roles ya no se abre desde este proyecto (#279): lo sirve
  // ConfigData, que corre como propietario y es el único con SHEET_ID. Esta
  // función corre a mano desde el editor, así que el token es el del
  // propietario y ConfigData lo reconoce como admin.
  var res = relayConfigData_('rolesMatrix', {});
  if (!res || res.ok !== true) {
    throw new Error('No se pudo leer la matriz de roles desde ConfigData: ' + ((res && res.error) || 'sin respuesta') +
      '. Revisa CONFIG_DATA_URL y que ejecutes esto como un usuario admin.');
  }
  var values = res.values || [];
  // #287 — RED DE SEGURIDAD, antes de devolver nada y antes de tocar los
  // globales de abajo: una matriz mal leída se traduce en `users: []`, y con
  // `addOnly=false` en todas las llamadas eso significa retirar a todo el mundo
  // de todo. Lanzar y no `return`: la ejecución tiene que constar como ERROR.
  var filaCabecera = flatAssertRolesHeader_(values);
  // El propio Excel de Roles: NUNCA se le reparte ACL (ver flatProtectedFileIds_).
  FLAT_PROTECTED_FILE_IDS_ = res.sheetId ? [String(res.sheetId)] : [];
  // Ficheros de infraestructura (el proyecto ConfigData y la hoja de auditoría):
  // los dice ConfigData, que es el único que los conoce. Así no hay ninguna
  // lista de IDs que mantener a mano ni que se pueda quedar desfasada.
  FLAT_PRIVATE_FILE_IDS_ = (res.privateFileIds || []).map(String);

  var users = [];
  // Los datos empiezan JUSTO DEBAJO de la cabecera que se ha localizado, no en
  // una fila fija: el Sheet tiene DOS filas de cabecera y no está escrito en
  // ningún sitio cuál de las dos lleva los títulos. Si la de títulos es la
  // primera, la segunda es la separadora y se cae sola por el regex de email.
  for (var i = filaCabecera + 1; i < values.length; i++) {
    var email = String(values[i][1] || '').toLowerCase().trim();
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { continue; }
    var isAdmin = /^(x|si|sí|yes|true|1)$/i.test(String(values[i][3] || '').trim());
    var champion = flatSplitCaja_(values[i][4]);
    var steward = flatSplitCaja_(values[i][5]);
    var user = flatSplitCaja_(values[i][6]);
    var read = flatSplitCaja_(values[i][7]);
    // #279·#3 — la col G (KB Contributors) SALE de `write`. Antes entraba aquí
    // y el contributor acababa de editor de la carpeta de caja ENTERA; el
    // límite al eje Work lo ponía solo el plugin, así que cualquier cliente de
    // Drive lo puenteaba. Ahora va en `workCajas`: lector de la caja y editor
    // solo de las subcarpetas de `KDD_WORK_EDITOR_SUBFOLDERS_`.
    var write = flatUneCajas_(champion, steward);
    var role = isAdmin ? 'admin'
      : flatConjuntoNoVacio_(champion) ? 'kdd-champion'
      : flatConjuntoNoVacio_(steward) ? 'kb-steward'
      : 'kb-contributor';
    // `*Cajas` en vez de los viejos `*Norm`: ya no son mapas de nombres, son
    // `{sids, nombres}`. El nombre cambia a propósito — un consumidor que no se
    // haya actualizado se cae en vez de leer un mapa que ya no existe y concluir
    // que el usuario no tiene ninguna caja.
    users.push({ email: email, role: role, writeCajas: write, workCajas: user, readCajas: read });
  }
  // #287 — segundo guard: cabecera correcta pero cero filas válidas. Un Sheet
  // sin NI UN usuario no es un estado legítimo de este sistema (el admin que
  // está ejecutando esto ya tendría que salir); es una lectura rota.
  if (users.length === 0) {
    throw new Error('Sheet de Roles: la cabecera casa el esquema v3 (fila ' + (filaCabecera + 1) + ') pero no hay ' +
      'NI UNA fila con un email válido debajo, en la columna B. Un Sheet sin usuarios no es un estado legítimo: ' +
      'seguir con la lista vacía retiraría a todo el mundo de todas las cajas, de KDD_Studio_metadata y de los ' +
      'ficheros de LOGIN, y nadie —tú incluido— podría volver a arrancar el web app. NO se ha tocado ninguna ACL.');
  }
  return { users: users };
}

// Cabecera esperada del Sheet de Roles v3: columna → fragmento que TIENE que
// aparecer en su título. Se compara en minúsculas, sin acentos y por "contiene"
// en vez de por igualdad, a propósito: lo que hay que cazar es un
// DESPLAZAMIENTO de columnas, no una errata ni un "KB Consumers" en plural.
//
// El Sheet tiene DOS filas de cabecera (`docs/setup-environment.md`: "la fila 1
// es cabecera, la fila 2 es cabecera también") y **el repo no dice cuál lleva
// los títulos**: los fixtures de `gasConfigData.test.ts` y `gasAccessLayer.test.ts`
// los ponen en la fila 1 y dejan la 2 vacía. Por eso se acepta cualquiera de las
// dos en vez de apostar por una: acertar a cara o cruz aquí significa, si sale
// mal, un guard que aborta un Sheet SANO y deja el reparto de permisos
// congelado hasta que alguien edite este fichero y lo re-pegue.
//
// Y NO afloja la detección, que es lo único que importa: una columna insertada
// o borrada desplaza LAS DOS filas a la vez, y una fila desplazada no casa se
// mire en el índice que se mire — porque no trae otra grafía del mismo título,
// trae el título del vecino.
var FLAT_ROLES_HEADER_ROWS_ = [0, 1];   // filas 1 y 2 del Sheet
var FLAT_ROLES_HEADER_ = [
  { col: 'B', idx: 1, fragmento: 'email' },
  { col: 'C', idx: 2, fragmento: 'tipo' },
  { col: 'D', idx: 3, fragmento: 'admin' },
  { col: 'E', idx: 4, fragmento: 'champion' },
  { col: 'F', idx: 5, fragmento: 'steward' },
  { col: 'G', idx: 6, fragmento: 'contributor' },
  { col: 'H', idx: 7, fragmento: 'consumer' }
];

/** Normaliza un título de cabecera para compararlo: sin acentos, en minúsculas
 *  y SIN nada que no sea letra o dígito. Lo último es lo que hace que «E-mail
 *  corporativo» siga casando «email»: quien mantiene el Sheet retoca títulos, y
 *  un guard que aborte el sync por un guion se acabará quitando entero. No
 *  afloja la detección: una columna DESPLAZADA no trae otra grafía del mismo
 *  título, trae el título de otra columna. */
function flatNormHeader_(s) {
  return flatNormName_(s).replace(/[^a-z0-9]/g, '');
}

/**
 * #287 — LANZA si NINGUNA de las dos filas de cabecera casa el esquema v3.
 * Devuelve el índice de la que sí casa, que es desde donde se leen los datos.
 *
 * Es lo que caza la columna insertada a la izquierda de la B, y la caza ANTES
 * de que el desplazamiento se traduzca en `users: []`: con las columnas movidas,
 * `values[i][1]` deja de ser el email, ninguna fila pasa el regex y el sync
 * concluye —sin un solo error— que nadie debe tener acceso a nada.
 *
 * El mensaje dice qué columna esperaba y qué encontró: sin eso, el siguiente en
 * leer el log sabe que algo falla pero no qué tocar en el Sheet.
 *
 * La validación va aquí, en el CONSUMIDOR, y no en `cfgActionRolesMatrix_`:
 * el sync es quien toma la decisión destructiva y quien puede abortar a tiempo;
 * ConfigData solo sirve celdas y tiene otros llamantes.
 */
function flatAssertRolesHeader_(values) {
  if (!values || !values.length) {
    throw new Error('Sheet de Roles ilegible: ConfigData no ha devuelto ni una fila. NO se ha tocado ninguna ACL.');
  }
  // Para el mensaje de error se elige la fila que MÁS se parece a una cabecera:
  // la que más títulos conocidos trae, aunque estén en la columna equivocada.
  // Es justo la que el operador tiene que mirar — con el criterio ingenuo (la
  // que menos fallos acumula) un empate a 7 fallos hacía que se reportara la
  // fila del banner, que no dice nada de dónde está el desplazamiento.
  var mejor = null;
  for (var r = 0; r < FLAT_ROLES_HEADER_ROWS_.length; r++) {
    var idxFila = FLAT_ROLES_HEADER_ROWS_[r];
    var fila = values[idxFila];
    if (!fila) { continue; }
    var fallos = flatFallosDeCabecera_(fila);
    if (fallos.length === 0) { return idxFila; }
    var candidata = { idx: idxFila, fallos: fallos, reconocidos: flatTitulosReconocidos_(fila) };
    if (!mejor || candidata.reconocidos > mejor.reconocidos ||
        (candidata.reconocidos === mejor.reconocidos && candidata.fallos.length < mejor.fallos.length)) {
      mejor = candidata;
    }
  }
  var detalle = mejor
    ? 'la fila ' + (mejor.idx + 1) + ' es la que más se acerca y falla en: ' + mejor.fallos.join(' · ')
    : 'no hay ninguna fila de cabecera que revisar';
  throw new Error('Sheet de Roles: NINGUNA de las dos filas de cabecera (1 y 2) casa el esquema v3 — ' + detalle +
    '. Lo más probable es que se haya insertado, movido o reordenado una columna. Con las columnas desplazadas ' +
    'este sync leería 0 usuarios y retiraría a todo el mundo de todo, ficheros de LOGIN incluidos. ' +
    'NO se ha tocado ninguna ACL: arregla el Sheet y vuelve a lanzar.');
}

/** Cuántos títulos del esquema v3 aparecen en la fila, EN CUALQUIER columna.
 *  Sirve para reconocer la fila de cabecera aunque esté desplazada. */
function flatTitulosReconocidos_(fila) {
  var n = 0;
  for (var i = 0; i < FLAT_ROLES_HEADER_.length; i++) {
    for (var c = 0; c < fila.length; c++) {
      if (flatNormHeader_(fila[c]).indexOf(FLAT_ROLES_HEADER_[i].fragmento) !== -1) { n++; break; }
    }
  }
  return n;
}

/** Fragmentos que NO aparecen donde deberían en una fila candidata a cabecera. */
function flatFallosDeCabecera_(fila) {
  var fallos = [];
  for (var i = 0; i < FLAT_ROLES_HEADER_.length; i++) {
    var esperada = FLAT_ROLES_HEADER_[i];
    var celda = fila[esperada.idx];
    if (flatNormHeader_(celda).indexOf(esperada.fragmento) === -1) {
      fallos.push('col ' + esperada.col + ' esperaba que pusiera «' + esperada.fragmento +
        '» y pone «' + String(celda === undefined || celda === null ? '' : celda) + '»');
    }
  }
  return fallos;
}

// `syncHayDialectoSid_` se RETIRÓ en la fase E de #365, y con ella los dos
// frenos que alimentaba (el add-only de `flatApplyBoxAcl_` y el "no publicar"
// del censo cacheado). Existía porque este fichero casaba por NOMBRE en los dos
// caminos que deciden accesos, así que una sola celda migrada los dejaba leyendo
// media verdad. Ahora los dos leen los DOS dialectos y un Sheet a medias ya no
// produce un censo a medias. **No lo reintroduzcas**: hoy frenaría el reparto
// justo cuando el Sheet está bien.

/**
 * ¿El token tiene forma de S-ID? Espejo de `cfgEsSid_` de ConfigData.
 *
 * Se ESPEJA en vez de llamar al de allí, y no por descuido: `flatReadRolesIndex_`
 * es la función más crítica del reparto (una lectura mal hecha retira a todo el
 * mundo de todo, #287) y no puede pasar a depender de que ConfigData esté
 * cargado. En producción lo está —un proyecto, tres ficheros, un espacio
 * global— pero el arnés que prueba ESTA red carga el sync solo, a propósito.
 *
 * El precio del espejo es la deriva, y por eso no se paga a ciegas:
 * `gasAclQueue.test.ts` carga los tres ficheros y comprueba que los dos pares
 * coinciden sobre los mismos tokens. Si alguien toca uno, ese test se cae.
 */
function flatEsSid_(token) {
  return /^\s*S\d+\s*$/i.test(String(token == null ? '' : token));
}

/** S-ID normalizado con padding a 3 (`s49` → `S049`). Espejo de `cfgNormSid_`. */
function flatNormSid_(token) {
  var m = /^\s*S(\d+)\s*$/i.exec(String(token == null ? '' : token));
  if (!m) { return ''; }
  var s = String(parseInt(m[1], 10));
  while (s.length < 3) { s = '0' + s; }
  return 'S' + s;
}

/**
 * Trocea una celda E-H en sus DOS dialectos (#365 fase E).
 *
 * Devuelve `{ sids, nombres }`. Un token con forma de S-ID entra SOLO en `sids`
 * y uno con forma de nombre SOLO en `nombres`: mezclarlos haría que una caja
 * llamada literalmente "S049" heredase el permiso de la caja S049.
 */
function flatSplitCaja_(raw) {
  var sids = {};
  var nombres = {};
  var parts = String(raw || '').split(/[,;\n]+/);
  for (var i = 0; i < parts.length; i++) {
    var token = String(parts[i] == null ? '' : parts[i]).trim();
    if (!token) { continue; }
    if (flatEsSid_(token)) {
      var sid = flatNormSid_(token);
      if (sid) { sids[sid] = true; }
      continue;
    }
    var n = flatNormName_(token);
    if (n) { nombres[n] = true; }
  }
  return { sids: sids, nombres: nombres };
}

/** Une los dos dialectos de varias celdas en un solo conjunto por dialecto. */
function flatUneCajas_(a, b) {
  var sids = {};
  var nombres = {};
  var k;
  for (k in a.sids) { sids[k] = true; }
  for (k in b.sids) { sids[k] = true; }
  for (k in a.nombres) { nombres[k] = true; }
  for (k in b.nombres) { nombres[k] = true; }
  return { sids: sids, nombres: nombres };
}

/** ¿La caja `(sid, nombreNormalizado)` está en el conjunto? S-ID primero, nombre
 *  solo como resto legacy — MISMO orden que `cfgEsCajaLegible_` y que
 *  `accessSetHas` del plugin. Los tres tienen que decidir igual. */
function flatConjuntoTieneCaja_(conj, sid, norm) {
  if (!conj) { return false; }
  if (sid && conj.sids[sid] === true) { return true; }
  return !!(norm && conj.nombres[norm] === true);
}

/** ¿El conjunto concede alguna caja? (sustituye al `for (k in ...) return true`
 *  sobre los mapas planos de antes). */
function flatConjuntoNoVacio_(conj) {
  var k;
  if (!conj) { return false; }
  for (k in conj.sids) { return true; }
  for (k in conj.nombres) { return true; }
  return false;
}

function flatIsAdminRole_(role) { return role === 'admin'; }
function flatIsChampionRole_(role) { return role === 'kdd-champion'; }

/**
 * Editores / editores-solo-de-Work / lectores esperados de una caja según el
 * Sheet. Los `workEditors` son LECTORES de la carpeta de caja: su escritura vive
 * únicamente en las subcarpetas del eje Work (#279·#3).
 *
 * #365 fase E — **el JOIN va por S-ID**, y el nombre solo decide en las celdas
 * que aún no se han migrado. Eso ELIMINA DE RAÍZ el modo de fallo del censo
 * vacío: el emparejamiento carpeta↔censo dejaba de funcionar en cuanto alguien
 * renombraba la caja en el árbol y no en el Sheet —dos tablas que nada mantiene
 * en sync— porque atravesaba un string mutable. El S-ID de la carpeta no cambia
 * nunca. El guard de abajo se queda como red, no como única defensa.
 */
function flatExpectedBoxAcl_(sid, boxName, roles) {
  var norm = flatNormName_(boxName);
  var sidNorm = flatNormSid_(sid);
  var editors = {};
  var workEditors = {};
  var viewers = {};
  // Cuántos usuarios casan ESTA caja, por cualquiera de los dos dialectos. Los
  // admin NO cuentan: son editores de todo por su rol, así que están presentes
  // aunque el JOIN no case nada — y por eso `editors` vacío no sirve para
  // detectar el caso.
  var censo = 0;
  for (var i = 0; i < roles.users.length; i++) {
    var u = roles.users[i];
    var escribe = flatConjuntoTieneCaja_(u.writeCajas, sidNorm, norm);
    var work = flatConjuntoTieneCaja_(u.workCajas, sidNorm, norm);
    var lee = flatConjuntoTieneCaja_(u.readCajas, sidNorm, norm);
    if (escribe || work || lee) { censo++; }
    if (flatIsAdminRole_(u.role) || escribe) { editors[u.email] = true; }
    else if (work) { workEditors[u.email] = true; viewers[u.email] = true; }
    else if (lee) { viewers[u.email] = true; }
  }
  return { editors: editors, workEditors: workEditors, viewers: viewers, censo: censo };
}

/** Aplica la ACL de una carpeta de caja. Owner intocable.
 *
 *  OJO al orden: primero la ACL de la carpeta (que DEGRADA a lector a los
 *  contributors que hoy son editores) y después las subcarpetas del eje Work.
 *  Al revés, la pasada de retirada de `flatApplyAcl_` no vería el permiso nuevo
 *  de las subcarpetas —son items distintos— pero un fallo a medias dejaría al
 *  contributor sin poder escribir NADA, que es peor que dejarlo como estaba. */
function flatApplyBoxAcl_(folder, sid, boxName, roles) {
  var expected = flatExpectedBoxAcl_(sid, boxName, roles);
  // GUARD DE CENSO VACÍO — es #287 aplicado POR CAJA en vez de a la matriz entera.
  //
  // Ya NO es la única defensa (#365 fase E). El emparejamiento carpeta↔censo va
  // por S-ID, que no cambia nunca, así que el caso que lo motivó —renombrar la
  // caja en el árbol y no en el Sheet, dos tablas que nada mantiene en sync—
  // dejó de vaciar el censo. Lo que queda cubierto aquí es el resto: una caja
  // cuyas celdas siguen SIN MIGRAR y cuyo nombre no casa, una fila del árbol
  // recién creada que aún no está en ninguna columna de rol, o un S-ID mal
  // escrito a mano.
  //
  // Sigue siendo la lección de #312/#320/#322/#359: "no encontré a nadie" no
  // puede colapsar en "no debe entrar nadie". La diferencia entre las dos es un
  // `JOIN` que falla, no una decisión de permisos.
  //
  // Se degrada a ADD-ONLY y se dice en ROJO. Coste de equivocarse en cada
  // dirección: barrer de más destruye el acceso de un equipo y hay que
  // reconstruirlo a mano; barrer de menos deja vivo un permiso que nadie
  // gestiona, con una línea roja apuntándolo. No es simétrico.
  //
  // Los admin NO cuentan como censo: son editores por rol, así que estarían
  // presentes igual con el JOIN roto (ver `flatExpectedBoxAcl_`).
  //
  // El freno del Sheet MIXTO que había aquí (`hayDialectoSid`) se retiró con
  // esta fase: existía porque el índice casaba solo por NOMBRE y una celda
  // migrada dejaba fuera a su dueño. Ahora se casa por los dos dialectos, así
  // que un Sheet a medias ya no produce un censo a medias.
  var barrer = expected.censo > 0;
  if (!barrer) {
    Logger.log('🔴 [' + sid + ' · ' + boxName + '] NADIE casa esta caja en el Sheet de Roles, ni por S-ID ni por ' +
      'nombre. NO se retira a nadie (add-only): barrer con un censo vacío echaría de la carpeta a todo el ' +
      'equipo. ARREGLO: pon "' + sid + '" (o "' + boxName + '") en las columnas E-H del Sheet de Roles. Si la ' +
      'caja de verdad no tiene a nadie asignado, esta línea es informativa y no hay nada que hacer.');
  }
  flatApplyAcl_(folder, expected.editors, expected.viewers, boxName, !barrer);
  var emails = [];
  for (var e in expected.workEditors) { if (expected.workEditors[e]) { emails.push(e); } }
  if (emails.length === 0) { return; }
  if (MIGRATE_DRY_RUN) {
    Logger.log('DRY: [' + boxName + '] DARÍA editor del eje Work (' + KDD_WORK_EDITOR_SUBFOLDERS_.join(', ') + ') a ' + emails.join(', '));
    return;
  }
  shareWorkSubfolders_(folder, emails);
}

/**
 * ACL de KDD_Studio_metadata: SOLO propietario y admins (#279·#6). Desde
 * #279·#5 los usuarios NO acceden a esta carpeta por Drive: el plugin la pide
 * por el proxy de ConfigData (metaList/metaRead/metaWrite/metaDelete), que
 * corre como el propietario y recorta por rol. Compartirla filtraría skills,
 * group-resumes y el registro completo a gente que no debe verlos.
 *
 * El reparto viejo (lector para todos, editor para champions) existía porque
 * el plugin escribía aquí con el token del usuario — ese camino ya no existe.
 * Los admins quedan editores por la misma decisión que los ficheros privados
 * (2026-08-03): operar sin depender del propietario.
 */
function flatApplyMetadataAcl_(root, roles) {
  var it = root.getFoldersByName(FLAT_META_FOLDER_NAME_);
  if (!it.hasNext()) {
    Logger.log('⚠️ Carpeta ' + FLAT_META_FOLDER_NAME_ + ' no encontrada bajo la raíz — ACL de metadata omitida.');
    return;
  }
  var folder = it.next();
  var editors = {};
  for (var i = 0; i < roles.users.length; i++) {
    var u = roles.users[i];
    if (flatIsAdminRole_(u.role)) { editors[u.email] = true; }
  }
  // Lectores esperados = {} → quien hoy sea lector o editor sin ser admin se
  // RETIRA (no se degrada): el acceso de los usuarios va por el proxy.
  flatApplyAcl_(folder, editors, {}, FLAT_META_FOLDER_NAME_, false);
}

/**
 * ACL de la carpeta `User-Connections`: SOLO propietario y admins (#279·#7).
 *
 * Hasta 2026-08-04 se compartía como EDITOR con TODO el que pudiera loguearse,
 * porque cada usuario escribía ahí su propio `<email>.json` con SU token y Drive
 * no tiene permiso "solo crear". El efecto colateral es que cualquiera de la
 * plantilla podía LEER el censo entero —quién entra, cuándo, con qué rol y a qué
 * cajas tiene acceso— y además BORRAR o FALSIFICAR la entrada de otro, que es lo
 * que volvía inútil el registro justo para aquello que servía: auditar.
 *
 * El registro de conexión PASARÁ al rastro de auditoría, escrito por el servidor
 * con la identidad verificada del llamante — pero eso es #283 y NO está hecho.
 * Hasta entonces no hay registro de conexiones de ningún tipo: el plugin ya
 * repartido lo sigue intentando en cada login y se queda en no-op silencioso
 * (no resuelve la carpeta, así que ni llega a pedir el fichero). No des por
 * retirado `src/services/userConnectionsLogger.ts`: sigue vivo y llamado desde
 * `src/core/state.ts` en cada `onAuthenticated`.
 *
 * Editores esperados = solo admins y lectores = {}: quien hoy sea editor sin ser
 * admin se RETIRA, no se degrada a lector — leer es justamente la fuga. Mismo
 * criterio que `flatApplyMetadataAcl_`; los admins se quedan para poder operar
 * sin depender del propietario.
 */
function flatApplyUserConnectionsAcl_(root, roles) {
  var folder = flatGetUserConnectionsFolder_(root);
  if (!folder) { return; }
  var editors = {};
  for (var i = 0; i < roles.users.length; i++) {
    var u = roles.users[i];
    if (flatIsAdminRole_(u.role)) { editors[u.email] = true; }
  }
  flatApplyAcl_(folder, editors, {}, 'User-Connections', false);
}

/**
 * Localiza la carpeta `User-Connections` bajo la raíz plana. YA NO LA CREA: no
 * queda nadie que escriba en ella, así que crearla solo dejaría una carpeta
 * vacía en las instalaciones nuevas. Si no existe, no hay ACL que reconciliar.
 * Los ficheros históricos NO se borran, y ojo con lo que eso significa: dejan de
 * verlos todos MENOS su propio dueño. Cada `<email>.json` lo creó el plugin con
 * el token de SU usuario, así que él es el PROPIETARIO y los permisos de Drive
 * son por-item: quitarle la carpeta no le quita su fichero, que puede seguir
 * leyendo, editando y borrando. Lo que este fix cierra —y era el motivo de
 * #279·#7— es el censo AJENO. La integridad del histórico no se recupera: eso
 * lo aporta el rastro de #283, no esta función.
 */
function flatGetUserConnectionsFolder_(root) {
  var it = root.getFoldersByName('User-Connections');
  if (it.hasNext()) { return it.next(); }
  Logger.log('flatApplyUserConnectionsAcl_: no existe la carpeta "User-Connections" — nada que reconciliar.');
  return null;
}

/**
 * DIAGNÓSTICO: enumera TODAS las carpetas llamadas `User-Connections` visibles
 * para el propietario, no solo la que cuelga de la raíz plana.
 *
 * Existe porque `flatApplyUserConnectionsAcl_` solo reconcilia los hijos
 * directos de la raíz plana, y hubo versiones del plugin que resolvían la
 * carpeta con un find-or-create capaz de crearla en OTRO sitio si el nivel de
 * arriba no era escribible. Una copia fuera de la raíz plana no la cierra el
 * sync y seguiría siendo legible por quien la tenga compartida. Ejecútalo antes
 * de dar por cerrada la fuga.
 */
function listUserConnectionsFolders() {
  var it = DriveApp.getFoldersByName('User-Connections');
  var n = 0;
  while (it.hasNext()) {
    var f = it.next();
    n++;
    var padres = [];
    var pit = f.getParents();
    while (pit.hasNext()) { padres.push(pit.next().getName()); }
    var ficheros = 0;
    var fit = f.getFiles();
    while (fit.hasNext()) { fit.next(); ficheros++; }
    var duenyo = '?';
    try { duenyo = f.getOwner().getEmail(); } catch (e) { duenyo = '(sin owner accesible)'; }
    Logger.log('  #' + n + ' id=' + f.getId() + ' padres=[' + padres.join(', ') +
      '] ficheros=' + ficheros + ' propietario=' + duenyo);
  }
  Logger.log('listUserConnectionsFolders: ' + n + ' carpeta(s) encontradas.');
  return n;
}

/**
 * Manda a la PAPELERA todas las carpetas `User-Connections`. Se ejecuta A MANO
 * una sola vez, cuando el rastro de #283 sustituya al registro de conexiones.
 *
 * Por qué se borra en vez de dejarla cerrada: sin nadie que escriba ni lea, lo
 * que queda es un censo histórico (email, hora, rol, S-IDs con acceso) de un
 * sistema que ya no existe, y encima no es fiable — era falsificable por los
 * propios auditados, que es lo que motivó #279·#7.
 *
 * DOS AVISOS que hay que tener claros antes de pulsar Run:
 *  · A la papelera, NUNCA definitivo (convención del repo): se puede deshacer
 *    durante los 30 días de retención de Drive.
 *  · Los `<email>.json` de dentro son PROPIEDAD de cada usuario (los creó su
 *    plugin con su token), así que esto los desvincula de la carpeta pero NO los
 *    borra de su Drive. No hay forma de borrarlos desde aquí: quien no es dueño
 *    recibe 403. Es una limitación de Drive, no un descuido.
 *
 * Ejecuta antes `listUserConnectionsFolders()` y revisa lo que sale.
 */
function trashUserConnectionsFolders() {
  if (MIGRATE_DRY_RUN) {
    Logger.log('DRY: mandaría a la papelera las carpetas de listUserConnectionsFolders(). Nada tocado.');
    return 0;
  }
  var it = DriveApp.getFoldersByName('User-Connections');
  var borradas = 0;
  var errores = 0;
  while (it.hasNext()) {
    var f = it.next();
    var id = f.getId();
    try {
      f.setTrashed(true);
      borradas++;
      Logger.log('  papelera ← ' + id);
    } catch (e) {
      errores++;
      Logger.log('  ⚠️ no se pudo retirar ' + id + ' (¿no eres el propietario?) — ' + (e && e.message ? e.message : String(e)));
    }
  }
  Logger.log('trashUserConnectionsFolders: ' + borradas + ' a la papelera, ' + errores + ' con error.');
  return borradas;
}

/**
 * Restaura la ACL de los ficheros de LOGIN (proyecto del web app, biblioteca,
 * config, Sheet de Roles…) que el web app necesita bajo executeAs:USER_ACCESSING.
 * Reutiliza flatApplyAcl_ sobre el File (misma API que Folder). Mínimos
 * privilegios: lector para todos los registrados; editor solo admins (+ KDD
 * Champions en los champion-files). addOnly según LOGIN_FILES_REMOVE_EXTRA_.
 */
function flatApplyLoginFilesAcl_(roles) {
  var props = PropertiesService.getScriptProperties();
  var readerIds = flatSplitIds_(props.getProperty('LOGIN_SHARE_READER_IDS') || '');
  var champIds = flatSplitIds_(props.getProperty('LOGIN_SHARE_CHAMPION_EDITOR_IDS') || '');
  var addOnly = !LOGIN_FILES_REMOVE_EXTRA_;
  var i;
  for (i = 0; i < readerIds.length; i++) { flatApplyOneLoginFileAcl_(readerIds[i], roles, false, addOnly); }
  for (i = 0; i < champIds.length; i++) { flatApplyOneLoginFileAcl_(champIds[i], roles, true, addOnly); }
}

/**
 * Ficheros de infraestructura del GAS: solo el PROPIETARIO y los ADMINS. En
 * cada pasada del sync, no una vez.
 *
 * Hace falta porque esos ficheros se crearon DENTRO de la raíz plana y **Drive
 * hereda hacia abajo**: cogen la ACL de la carpeta sin que nadie los comparta a
 * propósito (así aparecieron editores no-admin en ConfigData el 2026-08-03).
 * Arreglarlo a mano dura hasta el siguiente cambio de la carpeta.
 *
 * Cuáles son esos ficheros lo dice **ConfigData**, que es el único que los
 * conoce: su propio `ScriptApp.getScriptId()` y su `AUDIT_SHEET_ID`. Llegan en
 * la respuesta de `rolesMatrix` (ver `flatReadRolesIndex_`). **Sin lista que
 * mantener a mano**, así que no se puede quedar desfasada ni olvidar un fichero
 * nuevo.
 *
 * NO entra aquí el proyecto **del web app**, que los usuarios necesitan leer
 * para arrancar el deployment (lo gestiona `flatApplyLoginFilesAcl_`), ni el
 * Excel de Roles, cuya retirada es un hito del rollout
 * (`revokeRolesSheetAccess()`). Desde #292 ConfigData vive en ESE proyecto, así
 * que su `getScriptId()` manda el ID del web app en `privateFileIds` y hay que
 * eximirlo explícitamente — ver el guard del bucle.
 *
 * Los admins quedan como EDITORES (decisión de Sergio, 2026-08-03): necesitan
 * poder arreglar ConfigData y operar la auditoría sin depender del propietario.
 * Residual asumido: un admin puede editar el rastro, incluida la fila que
 * registra lo que él mismo hizo.
 *
 * Respeta MIGRATE_DRY_RUN.
 */
function flatApplyPrivateFilesAcl_(roles) {
  var ids = FLAT_PRIVATE_FILE_IDS_;
  if (ids.length === 0) {
    Logger.log('⚠️ flatApplyPrivateFilesAcl_: ConfigData no devolvió los IDs de sus ficheros — su deployment sirve una versión anterior a #279·#5. Re-despliégalo (Editar → Nueva versión) y repite. NO se ha tocado ninguna ACL.');
    return 0;
  }
  // Exención del proyecto del web app (#292). ConfigData manda su
  // `ScriptApp.getScriptId()` en `privateFileIds`, y desde la fusión ese ID ES
  // el proyecto que sirve el login: el mismo que `LOGIN_SHARE_READER_IDS`
  // reparte a todo registrado porque el deployment corre
  // `executeAs: USER_ACCESSING` y sin LECTURA nadie puede arrancarlo. Como los
  // privados se aplican DESPUÉS de los ficheros de login, tratarlo como privado
  // deshace en la misma pasada lo que el paso anterior acaba de conceder y deja
  // a la plantilla entera sin poder loguearse — cada pasada concedería y
  // retiraría a los mismos.
  //
  // La exención pide las DOS condiciones a la vez, y por eso no se puede
  // ensanchar desde fuera del código:
  //   · el ID es ESTE proyecto (`ScriptApp.getScriptId()`), que no sale de
  //     ninguna Script Property → quien las edite no puede hacer que la hoja de
  //     auditoría ni el Excel de Roles la cumplan;
  //   · y además está declarado en `LOGIN_SHARE_*_IDS` → si nadie necesita
  //     leerlo, sigue siendo privado.
  // Eximir SOLO por estar en las listas de login habría quitado la red que hoy
  // caza un `AUDIT_SHEET_ID` mal puesto ahí: el paso de login lo comparte con
  // toda la plantilla y este paso se lo retira. La protección que importa en el
  // proyecto no es que nadie lo lea, es que nadie lo EDITE, y eso ya lo aplica
  // `flatApplyOneLoginFileAcl_` dejando como editores solo a los admins.
  var esteProyecto = '';
  try { esteProyecto = String(ScriptApp.getScriptId() || ''); } catch (eId) { esteProyecto = ''; }
  var propsLogin = PropertiesService.getScriptProperties();
  var deLogin = {};
  var loginIds = flatSplitIds_(propsLogin.getProperty('LOGIN_SHARE_READER_IDS') || '')
    .concat(flatSplitIds_(propsLogin.getProperty('LOGIN_SHARE_CHAMPION_EDITOR_IDS') || ''));
  for (var l = 0; l < loginIds.length; l++) { deLogin[String(loginIds[l])] = true; }

  var editors = {};
  for (var u = 0; u < roles.users.length; u++) {
    if (flatIsAdminRole_(roles.users[u].role)) { editors[roles.users[u].email] = true; }
  }
  var tocados = 0;
  for (var i = 0; i < ids.length; i++) {
    if (esteProyecto && String(ids[i]) === esteProyecto && deLogin[String(ids[i])]) {
      Logger.log('privado: ' + ids[i] + ' es el proyecto del web app y está en LOGIN_SHARE_*_IDS — lo reparte ' +
        'flatApplyLoginFilesAcl_ (lectura para los registrados, edición solo admins). No se trata como privado: ' +
        'sin esa lectura nadie puede arrancar el deployment.');
      continue;
    }
    var file;
    try { file = DriveApp.getFileById(ids[i]); }
    catch (e) { Logger.log('⚠️ privado: ' + ids[i] + ' no accesible — ACL omitida. (' + e + ')'); continue; }
    // Lectores esperados = {}: quien no sea admin se va, no se degrada a lector.
    flatApplyAcl_(file, editors, {}, 'privado:' + file.getName(), false);
    tocados++;
  }
  return tocados;
}

/** Ejecutable a mano: deja ConfigData y la hoja de auditoría solo con el
 *  propietario y los admins, sin esperar a la próxima pasada del sync. */
function revokePrivateFilesAccess() {
  flatResetRetiradas_();
  var tocados = flatApplyPrivateFilesAcl_(flatReadRolesIndex_());
  // Reportar "hecho" cuando no se ha tocado nada manda a comprobar en Drive un
  // cambio que no existe, y a concluir que el script no funciona.
  if (!tocados) {
    Logger.log('NO se ha aplicado nada — mira el aviso de arriba.');
    return;
  }
  Logger.log('Hecho sobre ' + tocados + ' fichero(s). Comprueba en Drive → Compartir: solo tú y los admins. Repítelo si mueves alguno de sitio.');
}

/**
 * PASO OPERATIVO del rollout de #279: deja el Excel de Roles/árbol SIN NINGÚN
 * permiso más que el del propietario.
 *
 * Es el ÚLTIMO paso y el único irreversible de verdad, así que no se ejecuta
 * solo: hay que lanzarlo a mano (Run → revokeRolesSheetAccess) y únicamente
 * después de haber comprobado que el login, el árbol y un grant real funcionan
 * con ConfigData en los DOS entornos. Mientras el Excel siga compartido, el
 * rollback es re-publicar la versión anterior del deployment de OAuthToken.
 *
 * Existe como función y no como "entra en Drive y quita a todos" porque así es
 * repetible, deja log de a quién se le quitó, y se puede ensayar con
 * MIGRATE_DRY_RUN = true.
 */
function flatApplyRolesSheetAcl_() {
  if (!ROLES_SHEET_LOCKDOWN_) {
    Logger.log('⏸️ ROLES_SHEET_LOCKDOWN_ = false — el Excel de Roles NO se toca. Vuelve a ponerlo a true cuando todos estén en el deployment nuevo.');
    return;
  }
  var res = relayConfigData_('rolesMatrix', {});
  if (!res || res.ok !== true || !res.sheetId) {
    Logger.log('⛔ No se pudo obtener el ID del Excel de Roles desde ConfigData: ' + ((res && res.error) || 'sin respuesta'));
    return;
  }
  var file;
  try { file = DriveApp.getFileById(String(res.sheetId)); }
  catch (e) {
    Logger.log('⛔ No se pudo abrir el Excel de Roles ' + res.sheetId + ' — ¿lo ejecutas como su propietario? (' + e + ')');
    return;
  }
  // Sin editores ni lectores esperados y sin addOnly → retira a todo el mundo
  // salvo al propietario.
  flatApplyAcl_(file, {}, {}, 'roles-sheet', false);
}

/** Ejecutable a mano: deja el Excel de Roles sin ningún permiso salvo el del
 *  propietario, sin esperar a la próxima pasada del sync. */
function revokeRolesSheetAccess() {
  flatResetRetiradas_();
  flatApplyRolesSheetAcl_();
  Logger.log('Comprueba que un kb-consumer recibe 403 al abrir la URL del Excel y que SIGUE pudiendo loguearse.');
}

/** ACL de UN fichero de login. championEditor=true → admins + KDD Champions son
 *  editores; resto lectores. false → solo admins editores; resto lectores.
 *  Fichero inaccesible (el runner no lo posee/comparte) → log y sigue. */
function flatApplyOneLoginFileAcl_(fileId, roles, championEditor, addOnly) {
  if (flatIsProtectedFile_(fileId)) {
    Logger.log('⛔ ' + fileId + ' es el Excel de Roles: NO se reparte (#279). ' +
      'Quítalo de LOGIN_SHARE_*_IDS — ConfigData lo abre como propietario y nadie más necesita acceso.');
    return;
  }
  var file;
  try { file = DriveApp.getFileById(fileId); }
  catch (e) { Logger.log('⚠️ Fichero de login ' + fileId + ' no accesible — ACL omitida. (' + e + ')'); return; }
  var editors = {};
  var viewers = {};
  for (var i = 0; i < roles.users.length; i++) {
    var u = roles.users[i];
    // Solo se da/mantiene acceso a los ficheros de login a quien puede ACCEDER
    // a alguna caja (o es admin). Un usuario SIN NINGUNA caja (todas las
    // columnas de rol vacías y no admin) no tiene por qué loguearse → en modo
    // FULL se le retira el acceso a estos ficheros. Mientras conserve ≥1 caja,
    // se mantiene.
    if (!flatUserHasAnyBox_(u)) { continue; }
    if (flatIsAdminRole_(u.role) || (championEditor && flatIsChampionRole_(u.role))) { editors[u.email] = true; }
    else { viewers[u.email] = true; }
  }
  flatApplyAcl_(file, editors, viewers, 'login:' + file.getName(), addOnly);
}

// ¿El usuario puede acceder a AL MENOS una caja? admin → sí siempre; si no,
// tiene que aparecer en alguna columna de rol (writeCajas = col E/F, workCajas
// = col G, readCajas = col H). Sin ninguna caja → no debe tener acceso a los
// ficheros de login.
//
// Cuenta las DOS mitades de cada conjunto (S-ID y nombre): mirar solo una haría
// que, según por dónde vaya la migración, a media plantilla se le retirase el
// acceso a los ficheros de LOGIN — o sea, no podrían ni entrar en el plugin, y
// el motivo no se parecería en nada al síntoma.
function flatUserHasAnyBox_(u) {
  if (flatIsAdminRole_(u.role)) { return true; }
  if (flatConjuntoNoVacio_(u.writeCajas)) { return true; }
  // `workCajas` (col G) es OBLIGATORIO aquí desde #279·#3: al sacar a los
  // contributors de la escritura, un contributor PURO se queda con las otras dos
  // vacías. Sin esta línea el sync concluye que no tiene ninguna caja.
  if (flatConjuntoNoVacio_(u.workCajas)) { return true; }
  return flatConjuntoNoVacio_(u.readCajas);
}

/** Divide una lista de IDs (Script Property) separada por coma / ; / espacio /
 *  salto de línea. '' → []. */
function flatSplitIds_(raw) {
  var parts = String(raw || '').split(/[\s,;]+/);
  var out = [];
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i].trim();
    if (p) { out.push(p); }
  }
  return out;
}

/** ¿Es un email de usuario real? Filtra principals raros (espacios de Google
 *  Chat tipo `/namespaced-roster/...`) que Drive lista pero no hay que tocar. */
function flatIsUserEmail_(s) {
  return /^[^@\s\/]+@[^@\s]+\.[^@\s]+$/.test(String(s || ''));
}

/** Pone a cero el contador de retiradas de la pasada. Lo llaman las ENTRADAS,
 *  no los helpers: el tope es por ejecución, no por carpeta. */
function flatResetRetiradas_() {
  flatRetiradasPasada_ = 0;
}

/** Cuenta UNA retirada de la pasada y LANZA si se pasa de `FLAT_MAX_RETIRADAS_`.
 *  Se llama ANTES de retirar, así que la que se pasa del tope no llega a
 *  ejecutarse; las anteriores sí (ver el comentario de la constante). */
function flatContarRetirada_(label, quien) {
  flatRetiradasPasada_++;
  if (flatRetiradasPasada_ > FLAT_MAX_RETIRADAS_) {
    throw new Error('ABORTADO por el tope de seguridad: esta pasada ya lleva ' + flatRetiradasPasada_ +
      ' retiradas de permisos, por encima de FLAT_MAX_RETIRADAS_ = ' + FLAT_MAX_RETIRADAS_ +
      '. La siguiente iba a ser [' + label + '] ' + quien + '. Una pasada de mantenimiento retira unas pocas: ' +
      'un número así casi siempre significa que la matriz de roles se ha leído mal. Comprueba el Sheet, ensaya con ' +
      'MIGRATE_DRY_RUN = true y, si de verdad toca una limpieza masiva, sube el tope A PROPÓSITO y vuelve a lanzar.');
  }
}

/**
 * Saca la LISTA de una respuesta del servicio avanzado de Drive, sea v2 o v3, y
 * LANZA si no reconoce ninguna de las dos formas. Ese es todo el punto (#359).
 *
 * El 2026-08-07 el manifiesto del editor pasó a `v3` sin que nadie lo tocara en
 * el repositorio. En v3 la lista se llama `files`/`permissions`, no `items`, así
 * que el patrón que había en los tres lectores —
 *
 *     var items = (resp && resp.items) || [];
 *
 * — convirtió "no sé leer esto" en "no hay nada" SIN LANZAR. Diecisiete días sin
 * un solo error en el log, cero caminos capaces de retirar un acceso, 92 ítems
 * atascados y 64 personas sin el acceso que el Excel les concede. Es la tercera
 * vez que este proyecto paga la misma lección (#312 "no pude mirar" ≠ "no
 * existe", #320 rápido vs tardío, #322 respuesta perdida ≠ negativa), ahora en
 * la capa de deserialización.
 *
 * ACEPTA LAS DOS VERSIONES A PROPÓSITO: el manifiesto vuelve a decir v2 y no
 * sabemos cuándo Google la retirará del todo. Lo inaceptable no es una versión u
 * otra — es el silencio.
 *
 * OJO AL NOMBRE: el gemelo de esta función para `OAuthToken.gs` (`driveLista_`,
 * Entrega B de #359) va con OTRO nombre porque los tres `.gs` comparten espacio
 * global y el chequeo de colisiones de `scripts/gas-invariants.js` prohíbe
 * declarar el mismo símbolo dos veces. No unifiques los nombres.
 */
function flatDriveLista_(resp, campoV3) {
  if (resp && Object.prototype.toString.call(resp[campoV3]) === '[object Array]') { return resp[campoV3]; }
  if (resp && Object.prototype.toString.call(resp.items) === '[object Array]') { return resp.items; }
  throw new Error('Respuesta de Drive no reconocida: sin `' + campoV3 + '` (v3) ni `items` (v2). ' +
    'Claves recibidas: ' + (resp ? Object.keys(resp).join(',') : '(null)') +
    '. Leerlo como lista vacia es el bug #359.');
}

/**
 * Estado REAL de la ACL de un item (carpeta o fichero) → lista normalizada de
 * `{ permisoId, tipo, rol, email, dominio, nombre }`.
 *
 * #289 — POR QUÉ NO `getEditors()`/`getViewers()`: esas dos APIs devuelven
 * únicamente principals de tipo `user`. Un permiso de DOMINIO (toda la
 * empresa), de GRUPO (todos sus miembros, sin que aparezca ni un email) o de
 * "cualquiera con el enlace" era invisible para la pasada de retirada, así que
 * NO se retiraba jamás, en ninguna pasada. El sync sabía conceder
 * (`Drive.Permissions.insert`) pero para retirar miraba por otra ventana: daba
 * y no quitaba.
 *
 * El servicio avanzado de Drive (v2) ya estaba habilitado en el manifiesto y ya
 * se usaba en `shareNoEmail_`: esto no pide ni un scope nuevo ni
 * reautorización. Y es UNA llamada donde antes había dos.
 *
 * Si la llamada falla, LANZA en vez de devolver []: una lista vacía se leería
 * como "esta carpeta no tiene permisos que retirar" y el fallo pasaría callado.
 *
 * Y si la llamada NO falla pero devuelve algo ilegible, también lanza — por
 * `flatDriveLista_` (#359). Ese guard existía desde #289 y miraba al sitio
 * equivocado: la llamada de v3 tenía ÉXITO y devolvía `permissions` en vez de
 * `items`, así que el fallo entró por el `try` y el `catch` nunca se ejecutó.
 * Un modo de fallo previsto y protegido en la rama que no era.
 */
function flatListPermisos_(item) {
  var resp;
  try {
    resp = Drive.Permissions.list(item.getId());
  } catch (e) {
    throw new Error('No se pudieron listar los permisos de ' + item.getId() + ' — ' +
      (e && e.message ? e.message : String(e)) + '. Se para: seguir sin saber qué permisos hay ' +
      'significa no retirar nada y creer que estaba limpio.');
  }
  var items = flatDriveLista_(resp, 'permissions');
  var out = [];
  for (var i = 0; i < items.length; i++) {
    var p = items[i] || {};
    out.push({
      permisoId: String(p.id || ''),
      tipo: String(p.type || ''),
      rol: String(p.role || ''),
      email: String(p.emailAddress || p.value || '').toLowerCase(),
      dominio: String(p.domain || ''),
      nombre: String(p.name || '')
    });
  }
  return out;
}

/** ¿El rol de este permiso da ESCRITURA? `organizer`/`fileOrganizer` son de
 *  unidades compartidas; se tratan como editor por lo que permiten hacer. */
function flatEsRolDeEdicion_(rol) {
  return rol !== 'reader' && rol !== 'commenter';
}

/** A quién apunta un permiso, para el log. Un permiso de dominio o de enlace no
 *  tiene email, y sin esto la línea diría "retirado " y nada más. */
function flatQuienEsPermiso_(perm) {
  if (perm.tipo === 'anyone') { return 'cualquiera con el enlace'; }
  return perm.dominio || perm.email || perm.nombre || '(sin identificar)';
}

/** Descripción de un permiso no-`user` para logs y mensajes de error. */
function flatDescribePermiso_(perm) {
  return perm.tipo + ':' + flatQuienEsPermiso_(perm) + ' (' + perm.rol + ')';
}

/**
 * Retira UN permiso que no es de tipo `user`. Devuelve 'retirado' | 'heredado' |
 * 'error'. Respeta MIGRATE_DRY_RUN.
 *
 * `access denied` = el permiso lo hereda del padre y no se puede quitar desde
 * aquí: cuenta como `heredados` y NO rompe la pasada. Se resuelve barriendo el
 * padre, igual que con los permisos de usuario.
 */
function flatRemovePermisoNoUsuario_(item, perm, label) {
  var quien = flatDescribePermiso_(perm);
  if (MIGRATE_DRY_RUN) {
    Logger.log('DRY: [' + label + '] RETIRARÍA permiso no-usuario ' + quien);
    return 'retirado';
  }
  try {
    Drive.Permissions.remove(item.getId(), perm.permisoId);
    Logger.log('RETIRADO [' + label + '] permiso no-usuario ' + quien);
    return 'retirado';
  } catch (e) {
    if (flatEsPermisoHeredado_(e)) { return 'heredado'; }
    Logger.log('ERROR [' + label + '] retirando permiso no-usuario ' + quien + ': ' + e);
    return 'error';
  }
}

/**
 * ¿El fallo al retirar es "este permiso lo hereda del padre y no se puede
 * quitar desde aquí"? Se cuenta aparte y NO rompe la pasada: se resuelve
 * barriendo el padre.
 *
 * Hay que reconocer las DOS redacciones porque hay dos APIs en juego: DriveApp
 * (`removeEditor`/`removeViewer`) dice *"Access denied"*, y el servicio avanzado
 * (`Drive.Permissions.remove`, por donde van desde #289 los permisos que no son
 * de tipo `user`) devuelve un 403 del REST con *"Insufficient permissions for
 * this file"*. Con solo el primero, cada permiso de dominio heredado se
 * contaba como `errores` — y eso manda a buscar una avería donde solo hay una
 * carpeta padre que barrer.
 */
function flatEsPermisoHeredado_(e) {
  var msg = String((e && e.message) ? e.message : e);
  return /access denied|insufficient permissions|insufficientfilepermissions/i.test(msg);
}

/* `shareNoEmail_` NO se declara aquí: vive en `OAuthToken.gs`, en el mismo
 * proyecto. Hasta #292 había una copia byte a byte en cada fichero y una pisaba
 * a la otra en silencio (gana la que se evalúe la última, y eso depende del
 * orden de los ficheros en el editor). Daba igual mientras fueran idénticas;
 * el día que alguien tocara una, el sync y el alta habrían dejado de compartir
 * igual sin que nada lo dijera. El chequeo de colisiones de
 * `scripts/gas-invariants.js` impide que vuelva. */

/** Núcleo add/remove de una ACL. Nunca toca al propietario. Los "Access
 *  denied" al retirar (permiso heredado, ya no debería darse tras el cutover)
 *  se cuentan y se resumen en UNA línea, no error por usuario.
 *
 *  Es el EMBUDO: sus seis llamadores (cajas, KDD_Studio_metadata,
 *  User-Connections, ficheros privados, Excel de Roles y ficheros de login)
 *  heredan de aquí el barrido de #289 sin tocar ni una línea suya. */
function flatApplyAcl_(folder, expectedEditors, expectedViewers, label, addOnly) {
  var ownerEmail = flatOwnerEmail_(folder);
  var added = 0, removed = 0, errors = 0, inherited = 0;
  var noUsuario = { domain: 0, group: 0, anyone: 0, otros: 0 };

  // Estado actual por `Drive.Permissions.list` y NO por getEditors()/getViewers()
  // (#289 — ver el porqué en flatListPermisos_). Los principals que NO son de
  // tipo `user` se apartan como SOBRANTES: no hay ningún flujo de este sistema
  // que los conceda, así que cualquiera que aparezca es un permiso que nadie
  // gestiona.
  var currentEditors = {};
  var currentViewers = {};
  var sobrantes = [];
  var permisos = flatListPermisos_(folder);
  for (var p = 0; p < permisos.length; p++) {
    var perm = permisos[p];
    // El PROPIETARIO no se toca, sea del tipo que sea el permiso.
    if (perm.rol === 'owner') { continue; }
    if (perm.tipo !== 'user') { sobrantes.push(perm); continue; }
    if (!flatIsUserEmail_(perm.email) || perm.email === ownerEmail) { continue; }
    if (flatEsRolDeEdicion_(perm.rol)) { currentEditors[perm.email] = true; }
    else { currentViewers[perm.email] = true; }
  }

  Logger.log('ACL esperada [' + label + '] → editores: ' + (Object.keys(expectedEditors).join(', ') || '(solo owner)') +
    ' · lectores: ' + (Object.keys(expectedViewers).join(', ') || '(ninguno)'));

  var email;
  // AÑADIR/promocionar editores que faltan según el Sheet.
  for (email in expectedEditors) {
    if (email === ownerEmail || currentEditors[email]) { continue; }
    if (MIGRATE_DRY_RUN) { Logger.log('DRY: [' + label + '] AÑADIRÍA editor ' + email); added++; continue; }
    try {
      if (currentViewers[email]) { folder.removeViewer(email); }
      shareNoEmail_(folder, email, 'writer');
      added++;
    } catch (e) { errors++; Logger.log('ERROR [' + label + '] addEditor ' + email + ': ' + e); }
  }
  // AÑADIR lectores que faltan.
  for (email in expectedViewers) {
    if (email === ownerEmail || currentViewers[email]) { continue; }
    // Si hoy es editor y no debe serlo, la pasada de retirada lo degrada a lector.
    if (currentEditors[email]) { continue; }
    if (MIGRATE_DRY_RUN) { Logger.log('DRY: [' + label + '] AÑADIRÍA lector ' + email); added++; continue; }
    try { shareNoEmail_(folder, email, 'reader'); added++; }
    catch (e) { errors++; Logger.log('ERROR [' + label + '] addViewer ' + email + ': ' + e); }
  }
  if (!addOnly) {
    // RETIRAR editores que sobran (degradando a lector si están en col F/G).
    for (email in currentEditors) {
      if (email === ownerEmail || expectedEditors[email]) { continue; }
      flatContarRetirada_(label, 'editor ' + email);
      if (MIGRATE_DRY_RUN) { Logger.log('DRY: [' + label + '] RETIRARÍA editor ' + email + (expectedViewers[email] ? ' (degradado a lector)' : ' (no está en el Sheet para esta caja)')); removed++; continue; }
      try {
        folder.removeEditor(email);
        if (expectedViewers[email]) { shareNoEmail_(folder, email, 'reader'); }
        removed++;
      } catch (e) {
        if (flatEsPermisoHeredado_(e)) { inherited++; }
        else { errors++; Logger.log('ERROR [' + label + '] removeEditor ' + email + ': ' + e); }
      }
    }
    // RETIRAR lectores que sobran.
    for (email in currentViewers) {
      if (email === ownerEmail || expectedViewers[email] || expectedEditors[email]) { continue; }
      flatContarRetirada_(label, 'lector ' + email);
      if (MIGRATE_DRY_RUN) { Logger.log('DRY: [' + label + '] RETIRARÍA lector ' + email + ' (no está en el Sheet para esta caja)'); removed++; continue; }
      try { folder.removeViewer(email); removed++; }
      catch (e) {
        if (flatEsPermisoHeredado_(e)) { inherited++; }
        else { errors++; Logger.log('ERROR [' + label + '] removeViewer ' + email + ': ' + e); }
      }
    }
    // RETIRAR los que no son de tipo `user`: dominio, grupo y "cualquiera con
    // el enlace" (#289). Va DESPUÉS de añadir, igual que las dos pasadas de
    // arriba: nadie pierde acceso en la ventana entre las dos fases, y una caja
    // que hoy solo se ve por el permiso de dominio ya tiene el suyo por usuario
    // antes de que ese permiso desaparezca.
    //
    // El GRUPO se retira a PROPÓSITO: hoy nada en este sistema concede por
    // grupo, así que uno que aparezca es un permiso que nadie gestiona. Si algún
    // día se quiere usar uno adrede hará falta una allowlist — y entonces será
    // una decisión, no un descubrimiento.
    //
    // GUARD: si algún ALTA ha fallado, no se barre nada de este item. El permiso
    // no-usuario que íbamos a retirar puede ser la única razón por la que esta
    // gente entra hoy —el caso que quita el sueño es un fichero de LOGIN al que
    // se accede por permiso de dominio—, y retirarlo justo después de no haber
    // podido conceder los permisos por usuario deja a todo el mundo fuera del
    // web app, incluido quien lanzó el sync. Antes de #289 este camino no era
    // fatal porque el permiso de dominio era invisible y sobrevivía; ahora sí lo
    // sería. Se salta y se dice: la siguiente pasada lo reintenta.
    if (errors > 0 && sobrantes.length) {
      Logger.log('⚠️ [' + label + '] ' + sobrantes.length + ' permiso(s) no-usuario NO se retiran en esta pasada: ' +
        errors + ' alta(s) han fallado aquí, y retirarlos ahora podría dejar sin acceso a quien no ha llegado a recibirlo. ' +
        'Arregla el motivo de los errores de arriba y vuelve a lanzar.');
    } else {
      for (var s = 0; s < sobrantes.length; s++) {
        var sobra = sobrantes[s];
        flatContarRetirada_(label, flatDescribePermiso_(sobra));
        var res = flatRemovePermisoNoUsuario_(folder, sobra, label);
        if (res === 'heredado') { inherited++; continue; }
        if (res === 'error') { errors++; continue; }
        removed++;
        if (noUsuario[sobra.tipo] === undefined) { noUsuario.otros++; } else { noUsuario[sobra.tipo]++; }
      }
    }
  }

  var totalNoUsuario = noUsuario.domain + noUsuario.group + noUsuario.anyone + noUsuario.otros;
  if (added || removed || errors || inherited) {
    Logger.log('ACL [' + label + '] resumen: añadidos=' + added + ' · retirados=' + removed +
      // Desglosado por tipo a propósito: que se vea QUÉ CLASE de agujero había,
      // no solo cuántos. "3 permisos de dominio" y "3 usuarios de más" no son la
      // misma noticia ni llevan a la misma comprobación.
      (totalNoUsuario ? ' · no-usuario-retirados=' + totalNoUsuario +
        ' (dominio=' + noUsuario.domain + ' grupo=' + noUsuario.group +
        ' enlace=' + noUsuario.anyone + (noUsuario.otros ? ' otros=' + noUsuario.otros : '') + ')' : '') +
      (inherited ? ' · heredados-no-retirables=' + inherited : '') +
      (errors ? ' · errores=' + errors : ''));
  }
}

function flatOwnerEmail_(folder) {
  try {
    var owner = folder.getOwner();
    return owner ? String(owner.getEmail() || '').toLowerCase() : '';
  } catch (e) { return ''; }
}

function flatLogShares_(label, folder) {
  var owner = flatOwnerEmail_(folder);
  var eds = folder.getEditors().map(function (u) { return u.getEmail(); });
  var vws = folder.getViewers().map(function (u) { return u.getEmail(); });
  Logger.log('[' + label + '] owner=' + owner);
  Logger.log('[' + label + '] editores (' + eds.length + '): ' + eds.join(', '));
  Logger.log('[' + label + '] lectores (' + vws.length + '): ' + vws.join(', '));
}

// ════════════════════════════════════════════════════════════════════════════
//  DRENADOR DE LA COLA DE ACL (#318 — Frente 2)
// ════════════════════════════════════════════════════════════════════════════
//
// `grant`/`revoke` responden en cuanto la fila del Sheet está escrita y dejan el
// reparto de permisos en el buzón `ACL_QUEUE_FOLDER_ID` (lo hace
// `cfgAclEnqueue_`, en ConfigData). Esto lo aplica, COMO EL PROPIETARIO, desde
// un trigger de 10 minutos.
//
// POR QUÉ AQUÍ Y NO EN ConfigData: `CONFIGDATA_PROHIBIDO` le prohíbe contener un
// solo verbo de ACL, y con razón. Este fichero ya es el que reconcilia permisos
// como propietario, así que es su sitio natural. Además no lo carga ninguna
// entrada HTTP (`OAuthToken.gs` y `ConfigData.gs` no llaman a ninguna `sync*_`),
// así que tocarlo NO obliga a republicar las implementaciones: `Ctrl+S` basta.
//
// POR QUÉ EL PROPIETARIO Y NO EL QUE CONCEDE: hasta #318 la ACL la aplicaba la
// mitad pública con el token del operador, así que un KDD Champion sin esa caja
// compartida NO podía aplicarla (fallo real en "BSI Reporting Tool",
// 2026-08-06). Se pierde que en Drive conste quién concedió — la autoría sigue
// en el rastro de auditoría, que además nadie puede alterar.
//
// EN SERIE, NUNCA EN PARALELO: era el objetivo. Antes, N operadores concediendo
// a la vez eran N ejecuciones públicas escribiendo permisos SIMULTÁNEAMENTE
// contra el cupo del propietario. Ahora hay UNA pasada, un ítem detrás de otro,
// con pausa entre medias. Lo garantizan dos cosas: un solo trigger periódico, y
// la lease (si dos pasadas coincidieran, la segunda se sale al verla viva).

/** Lease de exclusión entre pasadas — mismo patrón que `cfgConsolidarRastro`. */
var ACL_QUEUE_LEASE_ = 'ACL_QUEUE_LEASE';
/** Presupuesto por pasada. El límite duro de Apps Script son 6 min. */
var ACL_QUEUE_BUDGET_MS_ = 4 * 60 * 1000;
/** Intentos por ítem antes de dejar de reintentarlo (pero NO de contarlo). */
var ACL_QUEUE_MAX_INTENTOS_ = 5;
/** Edad máxima de un ítem. Pasada, no se aplica: el ítem es una orden congelada
 *  y el drenador nunca re-lee el Sheet, así que uno viejo puede contradecir lo
 *  que el rol dice HOY. 24 h da margen de sobra a cualquier avería real y corta
 *  el caso peligroso (reponer la property tras días en el camino síncrono). */
var ACL_QUEUE_MAX_EDAD_MS_ = 24 * 60 * 60 * 1000;
/**
 * Carpeta DLQ para los ítems muertos, en la property `ACL_DLQ_FOLDER_ID`.
 * **Vacía = desactivado**: el ítem se queda en el buzón, exactamente como antes
 * de #359. Mismo interruptor de rollback que `ACL_QUEUE_FOLDER_ID`.
 *
 * POR QUÉ (#359): la decisión de #318 —"un ítem agotado NO se retira: quedarse
 * es la evidencia de que algo quedó a medias"— es correcta para UN ítem y NO
 * TIENE COTA PARA CIEN. El drenaje lee el contenido de cada fichero ANTES de
 * mirar su contador de intentos, así que los 92 cadáveres del incidente eran 92
 * lecturas de Drive cada 10 minutos, para siempre, y una pasada de 59 s para no
 * hacer nada útil. La evidencia no se pierde: se muda a una carpeta donde no
 * cuesta una lectura por pasada.
 *
 * REPROCESO (manual y a propósito). Mover el fichero de vuelta al buzón, poner
 * `intentos: 0` **y refrescar `at` a ahora**. Las tres cosas:
 *
 *  - Sin refrescar `at`, un ALTA no se aplica: `intentos: 0` la saca del guard
 *    de agotamiento pero cae acto seguido en el de caducidad, que mira `at` — se
 *    re-estampa como `caducado` y vuelve al DLQ sin haber hecho nada. El
 *    operador cree que ha reencolado 85 altas y no se aplica ninguna.
 *  - Antes de reprocesar una BAJA, mira el Sheet. Una baja NO caduca nunca
 *    (grant-only, a propósito), y su pareja más reciente ya no está en el buzón
 *    para colapsar contra ella: se aplicaría tal cual y puede RETIRAR un acceso
 *    vigente.
 *  - Refrescar `at` reordena el ítem al final de la cola, que es lo correcto:
 *    una orden reencolada hoy no puede pisar a otra más reciente.
 */
var ACL_DLQ_PROP_ = 'ACL_DLQ_FOLDER_ID';
/** Pausa entre ítems, para no rozar el límite de peticiones por usuario de
 *  Drive. Aquí dormir es barato: retiene UNA ranura (la del trigger) y no hay
 *  nadie esperando — al contrario que el `Utilities.sleep` del relay, que
 *  retiene dos y por eso la regla prohíbe engordarlo. */
var ACL_QUEUE_PAUSA_MS_ = 300;
/** Handler del trigger PERIÓDICO (cada 10 min). */
var ACL_QUEUE_HANDLER_ = 'syncAplicarAclPendientes';
/** Handler de la CONTINUACIÓN de un disparo. Es una función distinta a
 *  propósito: así `syncBorrarContinuacionesAcl_` puede borrar continuaciones
 *  por NOMBRE sin poder tocar nunca el trigger periódico. Distinguirlos por
 *  algún id guardado en una property sería frágil justo en la dirección
 *  peligrosa — perder ese id borraría el trigger permanente y la cola dejaría
 *  de drenarse sola, en silencio y para siempre. */
var ACL_QUEUE_CONTINUE_HANDLER_ = 'syncContinuarColaAcl';
/** Continuación cuando queda backlog: evita que un alta masiva tarde una pasada
 *  de 10 min por cada 30-45 personas. Solo se agenda si de verdad sobra trabajo. */
var ACL_QUEUE_CONTINUE_DELAY_MS_ = 60 * 1000;

/**
 * Aplica los repartos de ACL pendientes. Entrada del trigger de 10 min y
 * ejecutable a mano con `Run`.
 *
 * Cierra SIEMPRE con un recuento — `aplicados/pendientes/errores/descartados` —
 * porque el riesgo de este diseño no es que falle, es que falle EN SILENCIO: la
 * fila del Sheet diciendo que sí y Drive diciendo que no. Ese log es la señal
 * contable de que el buzón está al día.
 */
function syncAplicarAclPendientes() {
  var inicioPasada = new Date().getTime();
  // Aplica permisos como el propietario: el gate va aunque solo se llegue por
  // trigger o por Run del editor. En un trigger temporal el usuario efectivo ES
  // el propietario, así que pasa (verificado contra Apps Script real, 2026-08-05).
  //
  // Va ANTES de mirar el buzón, y no después como hasta #325: esta pasada ya no
  // hace solo el reparto — también PUBLICA la caché de lecturas, que desde #327
  // lee el Excel de Roles entero EN PROCESO. Dejar ese trabajo fuera del gate por
  // el camino en que el buzón no está configurado sería regalar la única barrera
  // que hay aquí. El publicador vuelve a afirmar por su cuenta antes de leer: es
  // él quien depende del gate, y depender de que un llamante se acuerde es
  // exactamente lo que este fichero no se puede permitir.
  cfgAssertPrivileged_();

  // UNA sonda por pasada, antes del reparto: es lo único que convierte "esto
  // vuelve a pasar en silencio" en "esto se ve el mismo día" (#359). No depende
  // del buzón, así que va antes de mirarlo — con el interruptor de rollback
  // puesto el dialecto sigue importando igual para `syncDrivePermissions`.
  syncChequearDialectoDrive_();

  // El memo de la pasada se crea AQUÍ desde #424 y se enhebra hacia abajo, para
  // que el drenaje y el barrido de nombres compartan UNA sola lectura del árbol.
  // El publicador NO lo usa, y es deliberado: lee el suyo fresco, y compartirle
  // esta foto cambiaría la frescura del censo de #370.
  var memoPasada = { cajas: {}, raiz: null, arbol: null };
  var res = null;
  var falloDrenaje = null;
  try {
    res = syncDrenarPasadaAcl_(memoPasada);
  } catch (eDrenaje) {
    // Se captura para PUBLICAR igual y se relanza al final: el buzón roto (una
    // carpeta borrada hace lanzar a `DriveApp.getFolderById`) no puede apagar
    // las lecturas para siempre. La excepción sigue viajando: que el trigger
    // conste en error es lo que hace visible el buzón roto.
    falloDrenaje = eDrenaje;
  }

  // PUNTO ÚNICO DE PUBLICACIÓN, y alcanzable desde TODAS las salidas del drenaje
  // (#332). Antes colgaba del final del camino feliz, así que tres salidas se
  // iban sin publicar —`lock`, `lease` y la excepción del buzón— pese a que el
  // párrafo de abajo declara lo contrario. Y las tres se disparan justo cuando
  // más falta hace: el `waitLock` se rinde porque hay `grant`s en curso, y cada
  // `grant` ha subido `CACHE_GEN`, o sea que el camino rápido está INALCANZABLE
  // hasta que alguien publique. Dos pasadas así seguidas pasan del corte de
  // frescura y la caché queda fría exactamente en la ventana congestionada que
  // #325 y #327 vinieron a resolver.
  //
  // Va FUERA de la lease, y a propósito (#325). La lease se toma por
  // `presupuesto + 60 s`, dimensionada para el drenaje y solo para él. Publicando
  // dentro, una pasada que drena hasta agotar presupuesto y luego publica puede
  // sobrevivir a su propia lease, y una continuación la vería viva y se saltaría
  // sin reagendar. Dos publicaciones simultáneas escriben datos válidos y, si se
  // entrelazan, el caso normal es un salt que no casa con su censo —un miss y una
  // lectura por el relay—, así que aquí la exclusión no compra casi nada y sí
  // cuesta romper el invariante de la lease.
  //
  // "Casi": si entre las lecturas de las dos pasadas cae una edición A MANO del
  // Sheet, la vieja puede pisar el índice de la nueva y la huella quedar escrita
  // por la otra, con lo que la detección de ediciones a mano no dispara en la
  // pasada siguiente. Es #336 y está abierta — acotada por el corte de frescura y
  // preexistente, pero NO es "inofensivo" y no conviene volver a escribirlo así.
  //
  // Ojo también con la salida por `lock`: quien retiene el `ScriptLock` es un
  // `grant`/`revoke`, y esos suben `CACHE_GEN` antes de soltarlo, así que la
  // publicación que sale por ahí se descarta casi siempre en la re-comprobación.
  // Garantiza un intento, no una publicación (#337).
  //
  // Su propio try/catch: que la publicación falle no puede dejar de reportar un
  // reparto que SÍ se hizo.
  try { syncPublicarCacheLecturas_(inicioPasada); }
  catch (ePub) {
    Logger.log('syncPublicarCacheLecturas_: la publicación falló entera — las lecturas siguen yendo por el relay. (' +
      (ePub && ePub.message ? ePub.message : String(ePub)) + ')');
  }
  // EL BARRIDO DE NOMBRES va DESPUÉS del publicador y ANTES del throw (#424).
  //
  // Después del publicador porque la caché de lecturas tiene prioridad: el
  // publicador ya se protege con su propia reserva, y comerle presupuesto la
  // dejaría sin publicar justo en la ventana congestionada que #325 y #332
  // vinieron a resolver. Un renombrado puede esperar 10 minutos; la caché no.
  //
  // Antes del throw por el mismo argumento de #332 que puso ahí al publicador:
  // `falloDrenaje` solo se puebla si revienta el BUZÓN de ACL, y el nombre de
  // las carpetas no depende del buzón para nada. Dejarlo detrás lo apagaría
  // precisamente en la avería que menos tiene que ver con él.
  //
  // Su propio try/catch, y es obligatorio: sin él, una excepción del barrido
  // ENMASCARA `falloDrenaje` y el trigger deja de constar en error.
  try { syncBarrerNombresDeCajas_(memoPasada, inicioPasada); }
  catch (eBarrido) {
    Logger.log('syncBarrerNombresDeCajas_: el barrido falló entero — los nombres se alinean en la próxima pasada. (' +
      (eBarrido && eBarrido.message ? eBarrido.message : String(eBarrido)) + ')');
  }
  if (falloDrenaje) { throw falloDrenaje; }
  return res;
}

/**
 * El reparto de la pasada: buzón, lease y drenaje. SIN la publicación de la
 * caché, que es de su llamante — separarlos es lo que garantiza que ninguna
 * salida de aquí pueda dejar las lecturas sin publicar (#332).
 *
 * Devuelve el resultado del drenaje o el motivo por el que no se drenó; lanza
 * solo lo que deba constar como error del trigger.
 */
function syncDrenarPasadaAcl_(memo) {
  // Repite el assert del llamante a propósito: este camino APLICA ACLs de Drive
  // como el propietario, así que es el que menos se puede permitir depender de
  // que alguien se acuerde de gatear antes. Mismo criterio que
  // `syncPublicarCacheLecturas_`, que solo LEE y sin embargo lo repite.
  cfgAssertPrivileged_();
  var props = PropertiesService.getScriptProperties();
  var folderId = props.getProperty('ACL_QUEUE_FOLDER_ID') || '';
  if (!folderId) {
    // La caché de lecturas (#325) NO depende del buzón de ACL: comparten trigger
    // y nada más. Con el interruptor de rollback de #318 puesto (property
    // borrada) el reparto vuelve a ser síncrono, pero las lecturas tienen que
    // seguir acelerándose igual — acoplarlas haría que apagar una apagase la
    // otra sin que nadie lo hubiera pedido.
    Logger.log('syncAplicarAclPendientes: ACL_QUEUE_FOLDER_ID sin configurar — no-op.');
    return { ok: false, error: 'sin configurar' };
  }

  var lock = LockService.getScriptLock();
  try { lock.waitLock(10000); }
  catch (e) {
    Logger.log('syncAplicarAclPendientes: no se pudo comprobar la lease — se salta el reparto.');
    return { ok: false, error: 'lock' };
  }
  var miLease = '';
  try {
    var ahora = new Date().getTime();
    var lease = Number(props.getProperty(ACL_QUEUE_LEASE_) || '0');
    if (lease > ahora) {
      Logger.log('syncAplicarAclPendientes: otra pasada en curso (lease viva) — se salta el reparto.');
      return { ok: false, error: 'lease' };
    }
    miLease = String(ahora + ACL_QUEUE_BUDGET_MS_ + 60000);
    props.setProperty(ACL_QUEUE_LEASE_, miLease);
  } finally {
    lock.releaseLock();
  }

  try {
    return syncDrenarColaAcl_(folderId, memo);
  } finally {
    // Limpiar SIEMPRE, también si la pasada lanza: una lease huérfana solo
    // caduca sola tras presupuesto + margen, y eso es una pasada perdida.
    //
    // Pero SOLO si sigue siendo la NUESTRA. El corte de presupuesto del drenaje
    // se comprueba antes de cada ítem, así que una pasada puede rebasar su lease
    // por la duración de un ítem completo (un timeout de Drive basta); entonces
    // otra pasada toma una lease nueva y este `finally`, borrando a ciegas, la
    // tiraba — dejando entrar a una tercera y poniendo N drenajes en paralelo
    // contra el cupo de Drive del propietario, que es exactamente lo que la lease
    // existe para impedir.
    try {
      if (String(props.getProperty(ACL_QUEUE_LEASE_) || '') === miLease) {
        props.setProperty(ACL_QUEUE_LEASE_, '0');
      }
    } catch (eLease) { /* caduca sola */ }
  }
}

/** Continuación de un disparo cuando quedó backlog. Handler propio para que las
 *  continuaciones se puedan borrar por nombre sin rozar el trigger periódico. */
function syncContinuarColaAcl() {
  return syncAplicarAclPendientes();
}

/**
 * El cuerpo del drenaje.
 *
 * ORDEN — el requisito que introduce encolar también las bajas: con varias
 * operaciones pendientes sobre el mismo (email, caja), aplicarlas al revés
 * resucita un acceso retirado. Se resuelve en dos pasos:
 *
 *   1. COLAPSO por `(email, boxKey)`: solo cuenta la de `at` mayor. Cada
 *      operación determina por completo el estado ACL deseado de ese par, así
 *      que las anteriores son ruido — y aplicarlas sería trabajo de Drive
 *      tirado. Las superadas se retiran sin aplicarse.
 *   2. Las supervivientes se aplican en orden de `at` ASCENDENTE.
 *
 * No se drenan "las bajas primero": con más de dos operaciones sobre el mismo
 * par, esa regla da un estado final incorrecto. El timestamp es la única que
 * aguanta.
 */
function syncDrenarColaAcl_(folderId, memo) {
  var inicio = new Date().getTime();
  var it = DriveApp.getFolderById(folderId).getFiles();
  var items = [];
  var corrompidos = [];
  var descartados = 0;

  var ahora = new Date().getTime();
  var ilegibles = 0;
  var caducados = 0;
  /** Cadáveres que SALIERON del buzón esta pasada. Se cuenta aparte de
   *  `descartados`/`caducados` porque son cosas distintas: uno dice "está
   *  muerto", el otro "y además ya no cuesta una lectura por pasada". */
  var movidosDlq = 0;
  /**
   * Muertos detectados durante la enumeración, para mudarlos DESPUÉS de
   * cerrarla.
   *
   * NO se mudan en el sitio, y no es cosmético: `FileIterator` es perezoso y
   * pagina contra la carpeta VIVA (por eso existe `getContinuationToken()`).
   * Sacar ficheros a mitad de paginación puede saltarse elementos de las páginas
   * siguientes, y un saltado NO incrementa `ilegibles`, así que el guard de
   * "un buzón que no se ha podido leer entero tampoco se puede colapsar" no
   * dispara: la pasada colapsaría y aplicaría sobre una vista PARCIAL. Si el
   * saltado es la PERDEDORA de un par cuya ganadora sí se aplicó y se retiró, la
   * perdedora sobrevive sola y la pasada siguiente la aplica — resucitando un
   * acceso revocado, que es exactamente lo que el bloque de las superadas de más
   * abajo existe para impedir.
   *
   * Es la misma razón por la que los corruptos, las superadas y los aplicados se
   * retiran todos fuera de este bucle. Era la única mutación del buzón dentro de
   * su propia enumeración en todo el proyecto GAS.
   */
  var cadaveres = [];

  while (it.hasNext()) {
    var file = it.next();
    // La LECTURA y el PARSEO se separan a propósito: un timeout de Drive al
    // leer no es un ítem corrupto. Metidos en el mismo try, un fallo
    // transitorio mandaba el reparto a la papelera y lo perdía para siempre —
    // el mismo error de clasificar lo transitorio como permanente que ya
    // costaba caro en el relay.
    var texto = null;
    try { texto = file.getBlob().getDataAsString(); }
    catch (errLec) {
      ilegibles++;
      Logger.log('syncAplicarAclPendientes: no se pudo LEER un ítem (se reintenta) — ' + errLec);
      continue;
    }
    var reg = null;
    try { reg = JSON.parse(texto); }
    catch (err) { reg = null; }
    if (!reg || !reg.op || !reg.email) {
      // Ahora sí: el texto se leyó y no es un ítem. No puede quedarse dando
      // vueltas para siempre, así que se cuenta y se retira.
      corrompidos.push(file);
      continue;
    }
    if (Number(reg.intentos || 0) >= ACL_QUEUE_MAX_INTENTOS_) {
      // Agotado: se deja de reintentar. NUNCA se borra —la evidencia de que algo
      // quedó a medias es lo que impide que este diseño falle en silencio— pero
      // desde #359 SÍ se muda al DLQ: quedarse en el buzón no tiene cota, y con
      // 92 cadáveres eran 92 lecturas de Drive cada 10 minutos, para siempre.
      // Sin `ACL_DLQ_FOLDER_ID` se queda donde estaba, como antes.
      descartados++;
      cadaveres.push({ file: file, reg: reg, motivo: 'agotado' });
      continue;
    }
    reg.at = Number(reg.at || 0);
    if (!isFinite(reg.at)) { reg.at = 0; }
    // CADUCIDAD. El ítem es una ORDEN CONGELADA: dice "pon a X como editor de
    // la caja Y" y el drenador nunca re-lee el Sheet, que es la única fuente de
    // verdad del rol. Un ítem viejo puede contradecir lo que el Sheet dice HOY
    // — el caso concreto: se usa el interruptor de rollback (borrar la
    // property), se opera en síncrono durante días, y al reponerla los ítems
    // huérfanos se aplican y RESUCITAN accesos ya revocados. Pasada la edad
    // máxima no se aplica y no se retira: queda como evidencia, igual que un
    // agotado, y lo reconcilia `syncDrivePermissions`.
    //
    // Solo aplica a las ALTAS. Una baja es monótonamente restrictiva: aplicarla
    // tarde no concede nada, y caducarla dejaría a un revocado con permiso real
    // indefinidamente — fail-OPEN, justo lo contrario de lo que busca la regla.
    if (reg.op === 'grant' && ahora - reg.at > ACL_QUEUE_MAX_EDAD_MS_) {
      caducados++;
      // Un caducado está tan muerto como un agotado, y encima escribía esta
      // línea en CADA pasada. Desde #359 también se muda al DLQ (#3).
      cadaveres.push({ file: file, reg: reg, motivo: 'caducado' });
      Logger.log('syncAplicarAclPendientes: ítem CADUCADO (' +
        Math.round((ahora - reg.at) / 3600000) + ' h) ' + reg.op + ' de ' + reg.email +
        ' en "' + reg.boxKey + '" — NO se aplica.');
      continue;
    }
    reg.__file = file;
    items.push(reg);
  }

  // El iterador ya está agotado: AHORA se puede mutar la carpeta sin riesgo de
  // saltarse páginas. Ver el comentario de `cadaveres`.
  for (var d = 0; d < cadaveres.length; d++) {
    if (syncMoverAlDlq_(cadaveres[d].file, cadaveres[d].reg, cadaveres[d].motivo, folderId)) { movidosDlq++; }
  }

  // Colapso por (email, caja): gana el `at` mayor.
  //
  // El S-ID entra en la clave, y no es cosmético: los nombres de caja SE
  // REPITEN entre áreas (58 duplicados en el árbol BBVA). Sin él, un grant a
  // "Reporting" del equipo A y un revoke de "Reporting" del equipo B colapsan
  // como si fueran el mismo par y uno de los dos se descarta sin aplicarse.
  var ultimos = {};
  var superados = [];
  for (var i = 0; i < items.length; i++) {
    var clave = claveDeItem_(items[i]);
    var prev = ultimos[clave];
    if (!prev) { ultimos[clave] = items[i]; continue; }
    if (items[i].at >= prev.at) { ultimos[clave] = items[i]; superados.push(prev); }
    else { superados.push(items[i]); }
  }
  var pendientes = [];
  for (var k in ultimos) {
    if (Object.prototype.hasOwnProperty.call(ultimos, k)) { pendientes.push(ultimos[k]); }
  }
  pendientes.sort(function (a, b) { return a.at - b.at; });

  // Las SUPERADAS se retiran AQUÍ, antes de aplicar nada.
  //
  // El colapso solo garantiza "de este par se aplica la más reciente" mientras
  // las dos estén en el buzón. Si se retiraran al final y la pasada muriera
  // antes (presupuesto agotado, 6 min duros de Apps Script, un setTrashed que
  // falla), la ganadora ya estaría aplicada y retirada y la PERDEDORA
  // sobreviviría sola: la pasada siguiente no tendría contra qué colapsarla y
  // la aplicaría — resucitando un acceso revocado. Retirarlas primero hace que
  // el peor caso sea perder una operación que ya estaba superada, que es
  // inocuo, en vez de revivir una que se había deshecho.
  //
  // Si una perdedora NO se puede retirar, su par entero se saca de esta pasada:
  // mejor esperar a la siguiente —donde el colapso se rehace con las dos
  // presentes— que aplicar la ganadora y dejar viva a la otra.
  var paresBloqueados = {};
  for (var s = 0; s < superados.length; s++) {
    try { superados[s].__file.setTrashed(true); }
    catch (eSup) {
      paresBloqueados[claveDeItem_(superados[s])] = true;
      Logger.log('syncAplicarAclPendientes: no se pudo retirar una operación superada — su par espera a la próxima pasada. (' + eSup + ')');
    }
  }
  // Un buzón que no se ha podido leer entero tampoco se puede colapsar: puede
  // haber una operación más reciente en el fichero ilegible.
  if (ilegibles > 0) {
    Logger.log('syncAplicarAclPendientes: ' + ilegibles + ' ítem(s) ilegibles — la pasada no aplica nada; se reintenta entera.');
    Logger.log('syncAplicarAclPendientes: aplicados=0 pendientes=' + pendientes.length +
      ' errores=0 descartados=' + descartados + (movidosDlq ? ' dlq=' + movidosDlq : '') +
      ' ilegibles=' + ilegibles);
    return {
      ok: true, aplicados: 0, pendientes: pendientes.length, errores: 0,
      descartados: descartados, caducados: caducados, superados: superados.length,
      corruptos: corrompidos.length, ilegibles: ilegibles, sinAnotar: 0,
      // Se declara aquí también: si falta, `res.heredados` sale `undefined` por
      // esta salida y cualquier consumidor lee mal.
      heredados: 0,
      // `-1` = no medido. Esta salida no cuenta el DLQ: la pasada no ha aplicado
      // nada y va a repetirse entera enseguida, así que el listado sería trabajo
      // tirado. Vale `-1` y no `0` para no fingir un DLQ vacío.
      dlq: movidosDlq, enDlq: -1,
      rateLimited: false, transitorio: true,
    };
  }

  var aplicados = 0;
  var errores = 0;
  var rateLimited = false;
  var transitorio = false;
  var sinProcesar = 0;
  var sinAnotar = 0;
  // Aparte de `aplicados` a propósito (#426): un heredado sale del buzón, pero
  // el acceso SIGUE VIVO por el padre. Contarlo como aplicado sería informar de
  // un reparto que no ocurrió.
  var heredados = 0;
  /**
   * Memo de la PASADA (#359). Tres cosas que no cambian mientras dura:
   *  - `cajas`: qué carpetas tiene cada `(sid, boxKey)`. Con 85 altas repartidas
   *    en 23 cajas, son 23 listados de la raíz plana en vez de 85.
   *  - `raiz`: si la raíz plana se puede consultar. Es una propiedad del
   *    REPOSITORIO, no del ítem, así que preguntarlo una vez por ítem era pagar
   *    N veces por la misma respuesta.
   *  - `arbol`: el árbol indexado por S-ID, que es el dato maestro contra el que
   *    se valida el par (S-ID, nombre). Abre dos hojas: una vez por pasada, no
   *    una por ítem.
   *
   * Desde #424 lo CREA el llamante y lo enhebra hasta aquí, para que el barrido
   * de nombres comparta esta misma foto del árbol en vez de abrir el Excel una
   * segunda vez. El `||` conserva a quien llame a esta función suelta.
   *
   * Nunca una global: el ámbito correcto es la pasada, y una global sobreviviría
   * entre ejecuciones del trigger convirtiendo una foto vieja en la verdad —
   * justo el error que ya cuesta caro en los ítems congelados. Con el árbol eso
   * sería además un fallo de SEGURIDAD: el gate del reparto validaría contra una
   * foto de hace horas del control de accesos.
   */
  var memoPasada = memo || { cajas: {}, raiz: null, arbol: null };

  for (var p = 0; p < pendientes.length; p++) {
    if (new Date().getTime() - inicio > ACL_QUEUE_BUDGET_MS_) {
      sinProcesar = pendientes.length - p;
      break;
    }
    var item = pendientes[p];
    if (paresBloqueados[claveDeItem_(item)]) { sinProcesar++; continue; }
    var res = syncAplicarItemAcl_(item, memoPasada);
    if (res.ok) {
      if (res.heredado === true) {
        heredados++;
        Logger.log('syncAplicarAclPendientes: ' + res.detalle + ' NO se pudo retirar — el permiso lo HEREDA de la carpeta padre. ' +
          'El ítem sale del buzón (reintentarlo no puede funcionar), pero el acceso SIGUE VIVO: se barre con removeGlobalRootShare.');
      } else {
        aplicados++;
      }
      try { item.__file.setTrashed(true); }
      catch (eDel) { Logger.log('syncAplicarAclPendientes: no se pudo retirar un ítem aplicado — ' + eDel); }
    } else if (res.rateLimited || res.transitorio) {
      // No es culpa del ítem: no se le suma intento. Y se para la pasada — si
      // Drive nos está frenando, o el repositorio entero no se puede consultar,
      // seguir insistiendo solo quema cuota y agota los intentos de TODO el
      // backlog por una avería que no tiene nada que ver con estos ítems.
      rateLimited = rateLimited || res.rateLimited === true;
      transitorio = transitorio || res.transitorio === true;
      Logger.log('syncAplicarAclPendientes: pasada detenida — ' + res.error);
      sinProcesar = pendientes.length - p;
      break;
    } else {
      errores++;
      if (!syncSumarIntentoAcl_(item, res.error)) { sinAnotar++; }
    }
    if (p < pendientes.length - 1) { Utilities.sleep(ACL_QUEUE_PAUSA_MS_); }
  }

  for (var c = 0; c < corrompidos.length; c++) {
    try { corrompidos[c].setTrashed(true); } catch (eCor) { /* idem */ }
  }

  if (sinProcesar > 0 && !rateLimited && !transitorio) { syncAgendarContinuacionAcl_(); }

  // Los que se MOVIERON ya no están en el buzón: incluirlos en el aviso mandaría
  // a ejecutar `syncDrivePermissions` a mirar una carpeta donde ya no hay nada.
  // Atascado = muerto Y todavía dentro.
  var atascados = descartados + caducados - movidosDlq;
  // Se cuenta SIEMPRE, no solo cuando esta pasada ha mudado algo: lo que hay que
  // vigilar es el backlog acumulado del DLQ, y ese sigue ahí en las pasadas que
  // no mudan nada — que son justo las que parecerían sanas.
  var enDlq = syncContarDlq_();
  Logger.log('syncAplicarAclPendientes: aplicados=' + aplicados +
    ' pendientes=' + sinProcesar +
    ' errores=' + errores +
    ' descartados=' + descartados +
    (caducados ? ' caducados=' + caducados : '') +
    (movidosDlq ? ' dlq=' + movidosDlq : '') +
    (superados.length ? ' superados=' + superados.length : '') +
    (corrompidos.length ? ' corruptos=' + corrompidos.length : '') +
    (ilegibles ? ' ilegibles=' + ilegibles : '') +
    // Un ítem cuyo intento no se pudo anotar se reintentaría en CADA pasada,
    // para siempre, sin llegar nunca al tope: es un bucle silencioso, y por eso
    // se cuenta aparte en vez de confundirse con los errores normales.
    (heredados ? ' heredados=' + heredados : '') +
    (sinAnotar ? ' SIN-ANOTAR=' + sinAnotar : '') +
    (rateLimited ? ' — Drive limito la tasa, se reanuda en la proxima pasada' : '') +
    (transitorio ? ' — el repositorio no se pudo consultar, se reanuda en la proxima pasada' : '') +
    (atascados ? ' — AVISO: hay ' + atascados + ' item(s) ATASCADOS en el buzon; ejecuta syncDrivePermissions' : '') +
    // La alarma sigue existiendo aunque el cadáver se haya mudado: apuntando al
    // DLQ, que es donde está ahora. Sin esto, la pasada siguiente cierra
    // `descartados=0` y parece sana con N accesos sin aplicar.
    (enDlq > 0 ? ' — AVISO: hay ' + (enDlq > ACL_DLQ_MAX_CUENTA_ ? ACL_DLQ_MAX_CUENTA_ + '+' : enDlq) +
      ' item(s) en el DLQ sin reconciliar; ejecuta syncDrivePermissions' : '') +
    // El único sitio donde esto se ve en producción: nada de `src/` consume el
    // objeto que devuelve esta función. Si el aviso se diluye, el fix habrá
    // cambiado ruido en el DLQ por silencio, que es peor.
    (heredados ? ' — AVISO: ' + heredados + ' acceso(s) NO se retiraron porque los hereda la carpeta padre; ' +
      'siguen VIVOS hasta que se ejecute removeGlobalRootShare' : ''));

  return {
    ok: true, aplicados: aplicados, pendientes: sinProcesar, errores: errores,
    descartados: descartados, caducados: caducados, superados: superados.length,
    corruptos: corrompidos.length, ilegibles: ilegibles, sinAnotar: sinAnotar,
    heredados: heredados,
    dlq: movidosDlq, enDlq: enDlq,
    rateLimited: rateLimited, transitorio: transitorio,
  };
}

/**
 * Aplica UN ítem. Reutiliza los mismos helpers que usaba la mitad pública
 * (`shareNoEmail_`, `shareWorkSubfolders_`, `accessShareLoginFiles_`), así que
 * los permisos que acaban puestos en Drive son idénticos a los de antes de
 * #318: lo único que cambia es con qué identidad se ponen.
 */
function syncAplicarItemAcl_(item, memo) {
  var email = String(item.email || '').toLowerCase().trim();
  var boxKey = String(item.boxKey || '');
  var sid = String(item.sid || '');
  // El memo es de la PASADA, no global: sin él este ítem se comporta como antes.
  var m = memo || { cajas: {}, raiz: null, arbol: null };
  var claveCaja = sid.toUpperCase() + '|' + boxKey;
  // PUNTO ÚNICO de validación de la operación, y va ARRIBA y no al final como
  // hasta #359: desde esta tarea el camino materializa la carpeta de la caja y
  // reparte los ficheros de login, y hacer las dos cosas por un ítem cuya
  // operación no sabemos aplicar deja efectos de una orden que se rechaza igual.
  // Las dos ramas de abajo cubren exactamente estos dos valores, así que no hay
  // caída al final: si alguien añade una tercera operación, se añade aquí.
  if (item.op !== 'grant' && item.op !== 'revoke') {
    return { ok: false, error: 'op desconocida: "' + item.op + '"' };
  }
  try {
    // Los ficheros de LOGIN se reparten (o se retiran) ANTES de tocar la carpeta
    // de la caja, y el orden NO es cosmético: el caso es CIRCULAR. Sin login, el
    // usuario no puede entrar al plugin, y hasta #359 entrar al plugin era la
    // única forma de que su caja se materializara. Que ahora la cree el drenaje
    // no permite mover esto detrás: si la creación falla —sin escritura en la
    // raíz plana, cuota, un S-ID que ya existe con otro nombre— el usuario se
    // quedaría además sin poder ni iniciar sesión. En espejo, la retirada de una
    // baja con CERO cajas tampoco puede depender de que la carpeta exista, o el
    // revocado conserva el acceso a los ficheros de login: lector de todos y, si
    // era champion, EDITOR.
    //
    // Y va también por delante del GATE DEL ÁRBOL de aquí abajo, por lo mismo:
    // un ítem rancio se rechaza —esa es la decisión— pero rechazarlo no puede
    // dejar además a la persona sin poder iniciar sesión. Pierde su caja, no su
    // cuenta. Confundir las dos cosas es cómo un problema de permisos acaba
    // reportándose como "mi usuario no funciona" (#304).
    //
    // El alta se reparte UNA SOLA VEZ (#359): `accessShareFileWith_` reinserta el
    // permiso sin comprobar si ya está —3 llamadas a Drive por fichero de login—
    // así que un ítem que falla y reintenta lo pagaba cinco veces. Es idempotente,
    // así que la marca es best-effort: si no se puede escribir, el intento
    // siguiente re-comparte, que es el comportamiento de antes. Y NO se marca si
    // el reparto devolvió errores: dar por hecho un login que no se repartió es
    // exactamente lo que deja a alguien fuera para siempre y en silencio.
    var share = { errors: 0 };
    if (item.op === 'grant' && item.loginOk !== true) {
      OAUTH_PROTECTED_FILE_IDS_ = item.protectedFileIds || [];
      share = accessShareLoginFiles_(email, item.userIsChampion === true);
      if (!share || !share.errors) { syncMarcarLoginListo_(item); }
    }
    if (item.op === 'revoke' && item.nowHasNoBox === true) {
      accessRemoveLoginFilesAccess_(email);
    }

    // ── EL GATE: el par (S-ID, nombre) contra el ÁRBOL (#359 §4) ─────────────
    //
    // Hasta aquí el segundo control de acceso lo hacía el NOMBRE DE LA CARPETA
    // de Drive. Ahora lo hace el dato maestro, y solo después se localiza por
    // S-ID. Las dos mitades van juntas: localizar por S-ID sin validar contra el
    // árbol no cerraría el agujero de #318, lo ABRIRÍA — el `sid` llega del
    // payload del cliente y la potestad se gatea por NOMBRE.
    //
    // Sin S-ID no hay nada que validar: se cae al camino legacy de siempre
    // (localizar por nombre, sin renombrar y sin materializar nada), que es
    // exactamente el comportamiento que tenía antes de esta entrega.
    var nombreArbol = '';
    if (sid) {
      var arbol = syncArbolPorSid_(m);
      if (!arbol.ok) {
        // ÁRBOL ILEGIBLE → FAIL-CLOSED, y TRANSITORIO: no es culpa del ítem, así
        // que no gasta intento y para la pasada. Repartir permisos sin poder
        // comprobar contra el dato maestro es justo lo que este gate impide.
        return { ok: false, transitorio: true, error: 'no se pudo leer el arbol de cajas: ' + arbol.error };
      }
      nombreArbol = String(arbol.porSid[sid.toUpperCase()] || '');
      if (!nombreArbol) {
        // El S-ID REPETIDO en dos filas se separa de los otros dos motivos
        // (#392): `syncArbolPorSid_` lo borra de `porSid` a propósito, así que
        // desde aquí es indistinguible de un S-ID inventado, y el operador que
        // lea el DLQ va a buscar una caja borrada que nunca existió.
        //
        // NO se marca `transitorio`: eso rompe el bucle y CANCELA la
        // continuación de la pasada entera (:2128 y :2149), o sea que una sola
        // fila mal escrita congelaría el reparto de todas las demás cajas hasta
        // que alguien mirara el log. Es un fallo PERMANENTE de este ítem —vive
        // hasta que una persona edite el árbol—, así que gasta intentos y acaba
        // en el DLQ, que es justo la superficie donde se ve. Lo que faltaba no
        // era reintentarlo: era decir por qué.
        if (arbol.ambiguos && arbol.ambiguos[sid.toUpperCase()] === true) {
          return {
            ok: false,
            error: 'el S-ID ' + sid + ' aparece en DOS filas del arbol con nombres distintos, asi que no hay forma ' +
              'de saber sobre que caja repartir. Deja una sola fila para ese S-ID en el arbol y reponlo desde el DLQ.',
          };
        }
        return {
          ok: false,
          error: 'el S-ID ' + sid + ' no tiene fila en el arbol — no se reparte nada sobre una caja que el ' +
            'dato maestro no reconoce (caja borrada del arbol, S-ID inventado, o carpeta huerfana).',
        };
      }
      if (flatNormName_(nombreArbol) !== boxKey) {
        // ÍTEM RANCIO o S-ID FORJADO, y son INDISTINGUIBLES desde aquí: el
        // `boxName` del ítem está congelado desde que se concedió el acceso, así
        // que un renombrado de la caja en el árbol produce exactamente la misma
        // discrepancia que un `{boxName:"Mi Caja", sid:"S099"}` malicioso. Se
        // rechaza: se acepta perder algún alta legítima en esa ventana —la
        // recupera `syncDrivePermissions`— antes que repartir permisos de la caja
        // de otro equipo. Fail-closed.
        return {
          ok: false,
          error: 'el par (S-ID, nombre) no casa con el arbol: el item trae "' + String(item.boxName || '') +
            '" para ' + sid + ' y el arbol dice "' + nombreArbol + '". O la caja se renombro despues de ' +
            'encolarse (item rancio) o ese S-ID no es el de esa caja. NO se aplica.',
        };
      }
    }

    var folders;
    // `revisarNombre` evita repetir el renombrado —y su `getName()`, que es una
    // llamada a Drive— una vez por ítem: con 85 altas en 23 cajas serían 85
    // comprobaciones para 23 carpetas. Y hace de segunda puerta para la condición
    // 2 del §4 (ver el `duplicadas` de abajo).
    var revisarNombre = false;
    if (Object.prototype.hasOwnProperty.call(m.cajas, claveCaja)) {
      folders = m.cajas[claveCaja];
    } else {
      // Con el par ya validado, la localización es por S-ID y SOLO por S-ID: el
      // S-ID es la identidad de una caja y el nombre es una etiqueta que el
      // árbol manda. Es lo que hace que `S049_TEST` con el árbol diciendo
      // `Control-M` deje de ser un limbo y pase a ser una carpeta que se
      // encuentra, se usa y se renombra.
      folders = findFlatBoxFolders_(boxKey, sid, nombreArbol !== '');
      m.cajas[claveCaja] = folders;
      revisarNombre = true;
    }

    // `findFlatBoxFolders_` devuelve [] por TRES motivos que no son el mismo:
    // la caja no existe, FLAT_ROOT_ID está vacía, o la consulta a Drive falló
    // (su catch se traga el error). Confundirlos es caro en las dos
    // direcciones: si es una avería y lo tratamos como "no existe", gastamos
    // intento —una caída de Drive de una hora agota los 5 de TODO el backlog— y
    // encima el freno anti-cuota no se dispara. Se discrimina sondeando la raíz
    // plana, que es una sola llamada... y su respuesta vale para TODA la pasada:
    // es una propiedad del repositorio, no de este ítem.
    //
    if (folders.length === 0) {
      var sonda = m.raiz;
      if (!sonda) { sonda = syncRaizPlanaLegible_(); m.raiz = sonda; }
      if (!sonda.ok) {
        return { ok: false, transitorio: true, error: 'no se pudo consultar el repositorio: ' + sonda.error };
      }

      // La caja NO está materializada: se crea aquí y se sigue con el reparto.
      //
      // Hasta #359 esto era el final del camino: el ítem gastaba sus 5 intentos
      // contra una precondición que sólo cumplía `ensureFlatBoxFolder_`, o sea
      // que la carpeta aparecía únicamente cuando alguien ABRÍA la caja desde el
      // plugin. Dar de alta en una caja que nadie había abierto perdía el acceso
      // a los ~50 min, en silencio: es #338, con caso real (`alcon cib`, 5 altas).
      // Creándola aquí, el presupuesto de 5 reintentos vuelve a medir lo que
      // dice medir —fallos transitorios de Drive— y no una espera de negocio.
      //
      // Vale para las DOS operaciones. En un `revoke` la carpeta recién creada
      // no tiene a nadie que retirar, pero la baja queda aplicada de verdad
      // sobre el estado real y el ítem sale de la cola, en vez de quemar cinco
      // intentos para acabar en el DLQ diciendo que no pudo hacer nada.
      // Se exige la carpeta, no solo el `ok`: un `ok` sin carpeta dejaría
      // `folders` con un hueco, los bucles de abajo reventarían por dentro y
      // —lo grave— cualquier variante que no reventara devolvería `ok`, el
      // drenador contaría `aplicados++` y mandaría el ítem a la papelera. Un
      // alta que nadie recibe, o un revocado que conserva EDITOR real con su
      // única evidencia destruida: el fallo que #255 cerró en el plugin y #318
      // en el servidor. Fail-closed en el único sitio donde puede ocurrir.
      //
      // EL NOMBRE DE LA CARPETA NUEVA SALE DEL ÁRBOL, no del `boxName` del ítem
      // (#359 §4): ese está CONGELADO desde que se concedió el acceso, así que
      // crear con él fabricaría una carpeta que la pasada siguiente tendría que
      // renombrar. Una sola fuente para el nombre, en la creación y en el
      // renombrado, o no converge nunca. Sin S-ID no hay árbol que consultar y se
      // mantiene el comportamiento legacy (que se niega a crear por nombre).
      var creacion = syncAsegurarCarpetaCaja_(sid, nombreArbol || item.boxName, boxKey);
      if (!creacion.ok || !creacion.folder) {
        return {
          ok: false,
          transitorio: creacion.transitorio === true,
          // `rateLimited` viaja también: sin él, un `createFolder` frenado por
          // cuota gasta intento y la pasada sigue insistiendo caja por caja.
          rateLimited: creacion.rateLimited === true,
          error: creacion.error || 'la caja "' + boxKey + '" se dio por materializada pero sin carpeta',
        };
      }
      folders = [creacion.folder];
      m.cajas[claveCaja] = folders;
      // Si el materializador vio DOS carpetas con este S-ID solo devuelve la más
      // antigua, así que `folders` ya no basta para aplicar la condición 2 del §4
      // ("con dos no se renombra ninguna"): se respeta no comprobando el nombre.
      revisarNombre = creacion.duplicadas !== true;
    }

    // EL NOMBRE LO MANDA EL ÁRBOL (#359 §4). Va aquí y no dentro del
    // materializador porque tiene que alcanzar también a la carpeta que YA
    // existía: el caso real es `S049_TEST` con el árbol diciendo `Control-M`, y
    // esa carpeta no pasa por ninguna creación. Best-effort: si el renombrado
    // falla, la ACL se aplica igual (la carpeta se localiza por S-ID) y el ítem
    // no gasta intento por una reconciliación que no es cosa suya.
    if (revisarNombre) { syncRenombrarSiDivergeDelArbol_(sid, folders, nombreArbol); }

    if (item.op === 'grant') {
      for (var j = 0; j < folders.length; j++) {
        if (item.wantsEditor === true) {
          try { folders[j].removeViewer(email); } catch (e0) { /* no era viewer */ }
          shareNoEmail_(folders[j], email, 'writer');
        } else {
          // El removeEditor importa: al DEGRADAR a quien era editor de la caja
          // entera, sin él conserva la escritura vieja y el cambio de rol es
          // decorativo.
          try { folders[j].removeEditor(email); } catch (e1) { /* no era editor */ }
          shareNoEmail_(folders[j], email, 'reader');
          if (item.wantsWorkEditor === true) { shareWorkSubfolders_(folders[j], [email]); }
        }
      }
      if (share && share.errors > 0) {
        return { ok: false, error: share.errors + ' fichero(s) de login no se pudieron compartir' };
      }
      return { ok: true };
    }

    if (item.op === 'revoke') {
      // Los dos `catch` NO pueden tragarse el error: un `removeEditor` que
      // falla por rate limit o por un permiso heredado devolvía `ok` igual, el
      // ítem se iba a la papelera y el usuario conservaba EDITOR real sin que
      // quedara rastro. "No era editor" y "no he podido quitarle el editor" se
      // parecen en el código y no se parecen en nada en Drive.
      //
      // TRES desenlaces, no dos (#426): el no-op benigno, el permiso HEREDADO del
      // padre —que no es una avería y no se arregla reintentando— y el fallo
      // real. El heredado solo se reconoce con `syncHeredadoConfirmado_`, que
      // mira el propietario de la carpeta; NUNCA por el mensaje a secas.
      var falloRetirada = '';
      var heredadoDe = '';
      for (var r = 0; r < folders.length; r++) {
        // Se recorren TODAS las carpetas aunque ya haya salido un heredado: con
        // un S-ID duplicado hay dos, y la de al lado puede fallar de verdad.
        try { folders[r].removeEditor(email); }
        catch (e2) {
          if (syncEsNoEraPrincipal_(e2)) { /* no estaba en esa lista: no-op legítimo */ }
          else if (syncHeredadoConfirmado_(folders[r], email, e2)) { heredadoDe = heredadoDe || syncDescribeHeredado_(folders[r], email); }
          else { falloRetirada = falloRetirada || String(e2 && e2.message ? e2.message : e2); }
        }
        try { folders[r].removeViewer(email); }
        catch (e3) {
          if (syncEsNoEraPrincipal_(e3)) { /* idem */ }
          else if (syncHeredadoConfirmado_(folders[r], email, e3)) { heredadoDe = heredadoDe || syncDescribeHeredado_(folders[r], email); }
          else { falloRetirada = falloRetirada || String(e3 && e3.message ? e3.message : e3); }
        }
      }
      // PRECEDENCIA ESTRICTA: cualquier fallo real gana. Un heredado en una
      // carpeta no puede enterrar un rate limit de la de al lado.
      if (falloRetirada) {
        return { ok: false, error: 'no se pudo retirar el permiso: ' + falloRetirada, rateLimited: syncEsRateLimit_(falloRetirada) };
      }
      if (heredadoDe) {
        // `ok` para que el ítem SALGA del buzón: reintentarlo cinco veces es
        // gastar cuota en algo que no puede funcionar nunca. Pero ni
        // `transitorio` ni `rateLimited`, y esto es load-bearing: cualquiera de
        // los dos PARA LA PASADA ENTERA y congela el reparto de las demás cajas.
        return { ok: true, heredado: true, detalle: heredadoDe };
      }
      return { ok: true };
    }
  } catch (err) {
    var msg = (err && err.message ? err.message : String(err));
    return { ok: false, error: msg, rateLimited: syncEsRateLimit_(msg) };
  }
}

/**
 * Carpetas de la raíz plana cuyo nombre empieza por `<sid>_`, ordenadas de más
 * antigua a más nueva. Localiza por **S-ID y solo por S-ID** — el S-ID es la
 * identidad de una caja, el nombre es una etiqueta.
 *
 * Se usa para decidir si hay que crear. Quién reparte permisos sobre qué carpeta
 * lo decide `findFlatBoxFolders_`, que desde la Entrega B de #359 localiza por el
 * MISMO criterio —S-ID— cuando el llamante ha validado antes el par (S-ID,
 * nombre) contra el árbol. Que estas dos discrepasen es lo que fabricaba el
 * limbo: una encontraba `S049_TEST` y decidía que la caja ya existía, la otra no
 * la reconocía porque el árbol decía `Control-M`, y la caja no se creaba nunca ni
 * se encontraba nunca.
 *
 * Lee la respuesta por `flatDriveLista_`, así que no se queda ciego bajo Drive
 * v3 — y quedarse ciego aquí significaría no ver la carpeta que ya existe y CREAR
 * UNA DUPLICADA, que es el peor desenlace posible de esta función.
 */
function syncCarpetasPorSid_(flatRootId, prefijo) {
  var q = "'" + flatRootId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
  var out = [];
  var pageToken = null;
  do {
    var resp = Drive.Files.list({ q: q, maxResults: 1000, pageToken: pageToken });
    var items = flatDriveLista_(resp, 'files');
    for (var i = 0; i < items.length; i++) {
      var nombre = String(items[i].title || items[i].name || '');
      if (nombre.indexOf(prefijo) === 0) {
        out.push(DriveApp.getFolderById(items[i].id));
      }
    }
    pageToken = resp && resp.nextPageToken;
  } while (pageToken);
  out.sort(function (a, b) { return a.getDateCreated() - b.getDateCreated(); });
  return out;
}

/**
 * Asegura la carpeta de una caja que el drenaje no ha encontrado: la crea si de
 * verdad no existe, y NUNCA duplica (#359 · cierra #338).
 *
 * POR QUÉ EXISTE: hasta ahora la carpeta de una caja se materializaba en UN solo
 * sitio —`ensureFlatBoxFolder_`, o sea cuando alguien ABRE la caja desde el
 * plugin—, así que dar de alta en una caja que nadie había abierto gastaba los 5
 * intentos contra una precondición que nadie iba a cumplir y perdía el acceso a
 * los ~50 min, en silencio. Creándola aquí, el presupuesto de reintentos vuelve
 * a medir lo que dice medir: fallos transitorios de Drive.
 *
 * LO QUE NO HACE, Y ES DELIBERADO: no renombra. Si ya existe una carpeta con
 * este S-ID la USA tal cual y devuelve `ok`; alinear su nombre con el del árbol
 * es trabajo de `syncRenombrarSiDivergeDelArbol_`, en el llamante, que es donde
 * viven las cuatro condiciones del §4 y donde se sabe si hay una o dos carpetas.
 * Repartir esa decisión entre dos sitios es cómo se acaba renombrando con dos
 * criterios distintos.
 *
 * El NOMBRE que recibe esta función sale del ÁRBOL, nunca del `boxName` del
 * ítem: ese está CONGELADO desde que se concedió el acceso, así que crear con él
 * fabricaría una carpeta que la pasada siguiente tendría que renombrar, y con dos
 * fuentes para el nombre este camino y el del plugin se pisarían cada 10 minutos
 * sin converger. Una sola fuente en la creación y en el renombrado, o nada.
 *
 * LA CARRERA DE LOS DOS CREADORES: el plugin (al abrir la caja) y esto pueden
 * crear a la vez. Lock corto SOLO alrededor del localizar-o-crear —nunca durante
 * el reparto: es el mismo mutex que grant/revoke y retenerlo los tumbaría a
 * todos— más post-comprobación. Si tras crear aparece más de una, se registra en
 * ROJO, se usa la MÁS ANTIGUA y no se toca la otra: fusionar carpetas
 * automáticamente es exactamente lo que no debe hacer un batch a las 3 de la
 * mañana.
 */
function syncAsegurarCarpetaCaja_(sid, boxName, boxKey) {
  var flatRootId = '';
  try { flatRootId = PropertiesService.getScriptProperties().getProperty('FLAT_ROOT_ID') || ''; }
  catch (eP) { return { ok: false, transitorio: true, error: 'no se pudo leer FLAT_ROOT_ID' }; }
  if (!flatRootId) { return { ok: false, transitorio: true, error: 'FLAT_ROOT_ID sin configurar' }; }

  // MAYÚSCULAS, y no es cosmético: el `sid` llega del payload del cliente sin
  // normalizar (`cfgAclEnqueue_` lo guarda crudo), mientras `findFlatBoxFolders_`
  // lo mayusculiza antes de comparar y `flatIndexRootFolders_` exige `S###_` en
  // mayúsculas. Sin esto, un `sid:'s049'` crea `s049_Control-M`: una carpeta que
  // no reconoce ni el reparto, ni la reconciliación masiva, ni el plugin. El
  // renombrado de esta misma pasada suele corregirlo —su destino sí va en
  // mayúsculas—, pero eso es taparlo con algo que es best-effort a propósito, y
  // además el `indexOf` case-sensitive de `syncCarpetasPorSid_` es la ÚLTIMA red
  // anti-duplicado cuando `findFlatBoxFolders_` ha devuelto [] por un error
  // tragado. La red no puede depender de cómo venga escrito el payload.
  var limpio = String(sid || '').trim().toUpperCase();
  if (!limpio) {
    // Sin S-ID no hay identidad, y crear por nombre es lo que llena la raíz de
    // duplicados. Se niega en vez de adivinar.
    return { ok: false, error: 'el item no trae S-ID: no se puede materializar la caja "' + boxKey + '" sin identidad' };
  }
  var prefijo = limpio + '_';
  var deseado = prefijo + String(boxName || '').trim();

  var lock = LockService.getScriptLock();
  var conLock = false;
  try { lock.waitLock(10000); conLock = true; }
  catch (eLock) {
    // Sin lock no se crea: la post-comprobación detecta el duplicado pero no lo
    // deshace, y una carpeta de más es mucho peor que una pasada de espera.
    return { ok: false, transitorio: true, error: 'no se pudo tomar el lock para materializar la caja "' + boxKey + '"' };
  }
  try {
    var previas;
    try { previas = syncCarpetasPorSid_(flatRootId, prefijo); }
    catch (eList) {
      // Incluye la respuesta ilegible de `flatDriveLista_`: "no pude mirar" NO
      // es "no existe", y aquí confundirlos crearía una carpeta duplicada.
      return { ok: false, transitorio: true, error: 'no se pudo listar la raiz plana: ' + (eList && eList.message ? eList.message : String(eList)) };
    }
    if (previas.length > 0) {
      // YA EXISTE → no se crea nada y se usa la que hay, la MÁS ANTIGUA
      // (`syncCarpetasPorSid_` las devuelve ordenadas).
      //
      // Hasta la Entrega B de #359 esto era un ERROR —"CAJA EN LIMBO"— y tenía
      // su motivo: el drenaje localizaba por S-ID **y** nombre y no sabía leer el
      // árbol, así que una carpeta `S049_TEST` con el árbol diciendo `Control-M`
      // no la encontraba nadie, y renombrarla con el `boxName` congelado del ítem
      // habría puesto a este camino y al del plugin en ping-pong cada 10 minutos.
      //
      // Ahora el llamante ya ha validado el par contra el árbol y localiza por
      // S-ID, así que llegar aquí con carpetas previas solo puede ser una CARRERA
      // con el plugin (que crea por su cuenta y no pasa por este lock) o un
      // listado que falló y a la segunda funcionó. En los dos casos lo correcto
      // es usar la que existe: crear al lado sería exactamente la carpeta
      // duplicada que esta función existe para impedir.
      //
      // El NOMBRE no se toca aquí: lo alinea el llamante con
      // `syncRenombrarSiDivergeDelArbol_`, que es el único sitio donde vive esa
      // decisión y donde están sus cuatro condiciones.
      if (previas.length > 1) {
        var nombresPrevias = [];
        for (var q = 0; q < previas.length; q++) { nombresPrevias.push(previas[q].getName()); }
        Logger.log('🔴 DOS carpetas con S-ID ' + limpio + ': ' + nombresPrevias.join(' · ') +
          '. Se usa la MAS ANTIGUA, no se toca la otra y NO se renombra ninguna — fusionarlas o borrarlas ' +
          'tiene que decidirlo una persona.');
      }
      return { ok: true, folder: previas[0], duplicadas: previas.length > 1 };
    }

    var creada = DriveApp.getFolderById(flatRootId).createFolder(deseado);
    Logger.log('[' + limpio + '] carpeta de caja CREADA por el drenaje: "' + deseado + '" (#338).');

    // POST-COMPROBACIÓN: el lock protege de otro drenaje, no del plugin, que usa
    // su propio camino.
    var tras;
    try { tras = syncCarpetasPorSid_(flatRootId, prefijo); }
    catch (ePost) { return { ok: true, folder: creada }; }
    if (tras.length > 1) {
      var nombres = [];
      for (var n = 0; n < tras.length; n++) { nombres.push(tras[n].getName()); }
      Logger.log('🔴 DOS carpetas con S-ID ' + limpio + ': ' + nombres.join(' · ') +
        '. Se usa la MAS ANTIGUA, no se toca la otra y NO se renombra ninguna — fusionarlas o borrarlas ' +
        'tiene que decidirlo una persona.');
      return { ok: true, folder: tras[0], duplicadas: true };
    }
    return { ok: true, folder: creada };
  } catch (err) {
    // UN `rateLimitExceeded` AQUÍ NO ES CULPA DEL ÍTEM. La sonda de la raíz
    // plana, que se memoiza al principio de la pasada, mide si el repositorio se
    // puede LEER — no si queda cuota para ESCRIBIR, así que no tapa este caso:
    // Drive puede empezar a limitar después de que la sonda diga que sí.
    //
    // Sin esto, el error caía en la rama normal del drenador: gastaba intento y
    // —lo importante— NO disparaba el freno anti-cuota, así que la pasada seguía
    // llamando a `createFolder` una vez por caja sin materializar, insistiendo
    // justo cuando Drive está pidiendo que pares. Es la discriminación que el
    // bloque de la sonda existe para hacer, aplicada al otro lado de la llamada.
    var msgCrear = (err && err.message ? err.message : String(err));
    var frenar = syncEsRateLimit_(msgCrear);
    return {
      ok: false,
      transitorio: frenar,
      rateLimited: frenar,
      error: 'no se pudo crear la carpeta de la caja "' + boxKey + '": ' + msgCrear,
    };
  } finally {
    if (conLock) { try { lock.releaseLock(); } catch (eRel) { /* caduca sola */ } }
  }
}

/**
 * El ÁRBOL indexado por S-ID: `{ 'S049': 'Control-M', … }` (#359 §4).
 *
 * POR QUÉ EXISTE: hasta ahora el segundo control de acceso del reparto era, de
 * facto, el NOMBRE DE UNA CARPETA DE DRIVE — `findFlatBoxFolders_` exigía S-ID
 * **y** nombre porque el `sid` llega del payload del cliente y el gate de
 * potestad (`cfgAuthorityForEmail_`) mira el NOMBRE, así que nadie validaba que
 * uno correspondiera al otro. Eso funcionaba como contención pero pagaba dos
 * precios: cualquiera con escritura sobre la carpeta podía renombrarla, y una
 * caja renombrada EN EL ÁRBOL dejaba de casar y sus ACLs no se aplicaban jamás.
 *
 * El control no desaparece, se MUEVE a un sitio mejor: el par (sid, nombre)
 * tiene que casar con una fila del árbol, que es el dato maestro. Y solo
 * entonces se puede localizar por S-ID. Las dos mitades van juntas: localizar
 * por S-ID sin validar contra el árbol no cierra el agujero de #318, lo ABRE.
 *
 * EN PROCESO, sin salir por HTTP (#327), mismo razonamiento que el publicador de
 * la caché: el salto por `relayConfigData_` existe para que la implementación
 * PÚBLICA cruce la frontera de privilegio, y este llamante ya corre como el
 * propietario y no es alcanzable por HTTP (lo fija `fallosSyncInalcanzablePorHttp`
 * en el build). Salir del proceso para volver a entrar costaba 10-85 s y una
 * ejecución privilegiada de más por pasada, cada 10 minutos.
 *
 * `treeRaw` y no `tree`: `tree` gatea por `cfgActionReadableKeys_`, así que si el
 * propietario dejase de estar marcado admin devolvería el árbol RECORTADO con
 * `ok:true` — y un árbol parcial hace que cajas legítimas parezcan huérfanas y
 * sus ítems acaben en el DLQ. Eso es "no pude mirar" colapsando en "no existe",
 * la lección de #312/#320/#322 y de este mismo #359. `treeRaw` es todo o nada.
 *
 * El caller es la identidad REAL que da Google y NO `OWNER_EMAIL`: la acción
 * gatea por `cfgLookupRole_(...).isAdmin` y pasar la constante puentearía el gate.
 *
 * Memoizado en el memo de la PASADA, no en una global: una global sobreviviría
 * entre ejecuciones del trigger y convertiría una foto vieja del árbol en la
 * verdad — el mismo error que ya cuesta caro en los ítems congelados.
 */
function syncArbolPorSid_(memo) {
  if (memo && memo.arbol) { return memo.arbol; }
  var out = null;
  var res = null;
  try {
    // El assert va ANTES de la llamada, y eso lo verifica el build
    // (`fallosLlamanteEnProceso`): por HTTP el gate de la acción es `isAdmin`;
    // en proceso no hay identidad que resolver, así que la barrera equivalente
    // —y más fuerte— es exigir ser el propietario. Se repite aquí aunque el
    // drenador ya afirme: el que depende del gate es este código, y depender de
    // que un llamante se acuerde es lo que este fichero no se puede permitir.
    cfgAssertPrivileged_();
    res = cfgActionTreeRaw_({ email: Session.getEffectiveUser().getEmail() });
  } catch (eArbol) {
    out = { ok: false, porSid: {}, error: (eArbol && eArbol.message ? eArbol.message : String(eArbol)) };
  }
  if (!out) {
    if (!res || res.ok !== true) {
      out = { ok: false, porSid: {}, error: (res && res.error) || 'sin respuesta' };
    } else if (!res.rows || !res.rows.length) {
      // Un árbol vacío NO es un árbol sin cajas: es un árbol que no se ha podido
      // leer (hoja equivocada, cabecera movida, permiso retirado). Tratarlo como
      // dato bueno haría que TODAS las cajas parecieran huérfanas a la vez.
      out = { ok: false, porSid: {}, error: 'el arbol vino VACIO — no hay ninguna caja que validar, y eso no puede ser cierto' };
    } else {
      var porSid = {};
      var ambiguos = {};
      var cuantas = 0;
      for (var i = 0; i < res.rows.length; i++) {
        var fila = res.rows[i] || {};
        var sidFila = String(fila.sid || '').trim().toUpperCase();
        var nombreFila = String(fila.servicio || '').trim();
        if (!sidFila || !nombreFila) { continue; }
        if (!Object.prototype.hasOwnProperty.call(porSid, sidFila)) {
          porSid[sidFila] = nombreFila;
          cuantas++;
          continue;
        }
        if (porSid[sidFila] === nombreFila || ambiguos[sidFila]) { continue; }
        // DOS filas con el mismo S-ID y distinto nombre: el dato maestro está
        // corrupto y no hay forma de saber cuál manda. Quedarse con la primera
        // sería renombrar la carpeta viva de un equipo al nombre de otro. Ese
        // S-ID queda inutilizable hasta que una persona lo arregle.
        ambiguos[sidFila] = true;
        Logger.log('🔴 ARBOL AMBIGUO: el S-ID ' + sidFila + ' aparece con dos nombres distintos ("' +
          porSid[sidFila] + '" y "' + nombreFila + '"). Sus altas y bajas NO se aplican y su carpeta NO se ' +
          'renombra hasta que el arbol tenga una sola fila para ese S-ID.');
      }
      for (var amb in ambiguos) {
        if (Object.prototype.hasOwnProperty.call(ambiguos, amb)) { delete porSid[amb]; cuantas--; }
      }
      // Si NINGUNA fila queda usable, el árbol no vale como dato maestro y esto
      // es transitorio, no un rechazo por ítem: mandar el backlog entero al DLQ
      // por una hoja mal leída es exactamente lo que costó los 92 accesos.
      // Dos índices MÁS, para el censo (#370). `porSid` no se toca: sus claves
      // son crudas porque el drenaje hace `arbol.porSid[sid.toUpperCase()]`
      // (:2267) y su `sidDrive` sale del árbol sin normalizar a propósito
      // (#363/#359 §4 — normalizarlo duplicaría carpetas en Drive).
      //
      //  · `porSidNorm` — el MISMO mapa con la clave por `cfgNormSid_`. Sin él,
      //    un `S49` escrito a mano en el árbol no casaba contra el `S049` que
      //    `cfgAllBoxKeysFromValues_` deriva de la celda, y el censo salía
      //    SUBCONJUNTO acertando la clave.
      //  · `filasPorNombre` — cuántas filas del árbol tienen ese nombre,
      //    **incluidas las que aún no tienen S-ID**. Es la definición de
      //    "nombre ambiguo" que usa `cfgCajaObjetivo_` (`filas.length > 1`
      //    sobre TODAS las filas), y por tanto la que usa el relay. Contar solo
      //    las materializadas hacía que dos homónimas —una migrada y la otra
      //    no, que es un estado normal— parecieran inequívocas, y entonces el
      //    censo de la migrada se publicaba también bajo `n:<nombre>`: un
      //    SUPERCONJUNTO que el relay no confirma, servido por la caché al
      //    champion de la OTRA caja. #293 por la puerta de la caché.
      // ⚠ Dos filas cuyos S-ID solo se distinguen por el padding (`S49` y
      // `S049`, el caso #363) COLAPSAN aquí en la misma clave. La detección de
      // duplicados de arriba compara en CRUDO, así que no las ve y no emite
      // `🔴 ARBOL AMBIGUO`. Quedarse con una —la primera o la última, da igual—
      // haría que el censo de esa clave se construyera sobre la caja
      // equivocada, y ACERTANDO la clave: sin miss que degrade al relay. Así
      // que el S-ID normalizado colisionado queda INUTILIZABLE, igual que un
      // S-ID con dos nombres: sus lecturas van por el relay y se dice en ROJO.
      var porSidNorm = {};
      var normColision = {};
      var s;
      for (s in porSid) {
        if (!Object.prototype.hasOwnProperty.call(porSid, s)) { continue; }
        var norm = cfgNormSid_(s);
        if (!norm) { continue; }
        if (Object.prototype.hasOwnProperty.call(porSidNorm, norm) && porSidNorm[norm] !== porSid[s]) {
          normColision[norm] = true;
          continue;
        }
        porSidNorm[norm] = porSid[s];
      }
      for (var nc in normColision) {
        if (!Object.prototype.hasOwnProperty.call(normColision, nc)) { continue; }
        delete porSidNorm[nc];
        Logger.log('🔴 ARBOL AMBIGUO (padding): dos filas con S-ID que normalizan a ' + nc +
          ' (p. ej. S49 y S049) y nombres distintos. El censo de esa caja NO se cachea y sus lecturas ' +
          'van por el relay hasta que el árbol use un solo S-ID. Escribe los S-ID con tres dígitos.');
      }
      var filasPorNombre = {};
      for (var f = 0; f < res.rows.length; f++) {
        var nom = cfgNormBox_(String((res.rows[f] || {}).servicio || ''));
        if (!nom) { continue; }
        filasPorNombre[nom] = (filasPorNombre[nom] || 0) + 1;
      }
      // `ambiguos` VIAJA (#392): el drenaje solo ve que `porSid[sid]` está
      // vacío, y eso lo dice igual una caja borrada del árbol, un S-ID
      // inventado y este caso —el S-ID repetido en dos filas—, que es el único
      // de los tres que se arregla editando el árbol. Sin distinguirlo, sus
      // altas mueren al DLQ con un mensaje que enumera las otras dos causas.
      out = cuantas > 0
        ? { ok: true, porSid: porSid, porSidNorm: porSidNorm, filasPorNombre: filasPorNombre, ambiguos: ambiguos }
        : { ok: false, porSid: {}, error: 'ninguna fila del arbol quedo usable (sin S-ID, sin nombre, o el S-ID repetido con nombres distintos)' };
    }
  }
  if (memo) { memo.arbol = out; }
  return out;
}

/**
 * Alinea el NOMBRE de la carpeta con el del árbol (#359 §4). Best-effort.
 *
 * POR QUÉ NO ES COSMÉTICO, que es lo que hace que esta función exista: basta con
 * que un admin renombre una caja en el Sheet del árbol —`S001` pasa de `Test` a
 * `Test2`— para que las DOS resoluciones se rompan a la vez y la caja quede EN
 * LIMBO por dos sitios, en silencio:
 *
 *   · El reparto de ACL no la reconocía (exigía S-ID **y** nombre) → el ítem
 *     agotaba intentos → DLQ. El acceso no se aplicaba nunca.
 *   · El plugin no puede hacer I/O sobre ella: `resolveFlatRootChildId` resuelve
 *     el primer salto por NOMBRE exacto (sin `in parents`, porque los usuarios no
 *     pueden listar la raíz plana) → 404 para todo el que no sea admin.
 *
 * O sea: no solo no entra el usuario nuevo, es que los que ya tenían acceso
 * pierden el I/O. Y nadie relaciona "he renombrado una caja en el Sheet" con "el
 * equipo ha perdido su caja". Renombrar es lo que mantiene vivas las dos.
 *
 * EL DESTINO SALE SIEMPRE DEL ÁRBOL, jamás del `boxName` del ítem — que está
 * CONGELADO desde que se concedió el acceso (verificado sobre los 92 ficheros
 * reales del incidente). Con dos fuentes distintas, este camino y el del plugin
 * se renombrarían mutuamente cada 10 minutos sin converger nunca. Con una sola,
 * la comparación LITERAL converge en una pasada: si el árbol dice `E-client` y la
 * carpeta `S013_e-client`, se renombra a `S013_E-client` y ya coinciden. Una
 * comparación normalizada dejaría vivas para siempre las diferencias de
 * mayúsculas y acentos, que es justo lo que la decisión de producto elimina.
 *
 * Y SOLO DESDE AQUÍ, que es el camino que corre como el PROPIETARIO. Nunca desde
 * `ensureFlatBoxFolder_`: esa corre con el token del usuario que abre la caja
 * (`executeAs: USER_ACCESSING`), un lector no tiene escritura sobre la carpeta,
 * el fallo se lo tragaría su try/catch y —si algún día medio funcionara— el
 * nombre flaparía según quién abriese la caja.
 *
 * Un fallo al renombrar NO tumba el ítem: la ACL ya se aplica sobre la carpeta
 * correcta (se localiza por S-ID), así que gastar un intento del ítem por una
 * reconciliación que se reintenta sola sería cobrarle a quien no debe.
 *
 * RIESGO RESIDUAL ACEPTADO: el árbol es un Sheet que se edita a mano, así que un
 * typo en una celda renombra la carpeta viva de un equipo en menos de 10 minutos.
 * Se acepta a cambio de que la divergencia no pueda existir. Si algún día duele,
 * la mitigación NO es volver a quitarlo: es exigir confirmación (un `Run` manual
 * que liste y renombre) en vez de hacerlo dentro de la pasada.
 */
function syncRenombrarSiDivergeDelArbol_(sid, folders, nombreArbol) {
  // CONDICIÓN 1 — el árbol tiene fila para este S-ID. Sin nombre destino no se
  // toca: es una carpeta HUÉRFANA (la pasada del 24-ago encontró 3, entre ellas
  // `S041_FXTA`) y el sync ya las registra por su cuenta.
  if (!nombreArbol) { return false; }
  // CONDICIÓN 2 — hay EXACTAMENTE UNA carpeta con este S-ID. Con dos no se
  // renombra ninguna: elegir cuál es la buena y qué hacer con la otra tiene que
  // decidirlo una persona, no un batch a las 3 de la mañana.
  if (!folders || folders.length !== 1) {
    if (folders && folders.length > 1) {
      var nombres = [];
      for (var n = 0; n < folders.length; n++) {
        try { nombres.push(folders[n].getName()); } catch (eNom) { nombres.push('(nombre ilegible)'); }
      }
      Logger.log('🔴 [' + sid + '] DOS carpetas con este S-ID: ' + nombres.join(' · ') +
        '. NO se renombra ninguna — cual es la buena y que hacer con la otra lo decide una persona.');
    }
    return false;
  }
  var carpeta = folders[0];
  var actual = '';
  try { actual = String(carpeta.getName() || ''); }
  catch (eLeer) {
    Logger.log('[' + sid + '] no se pudo leer el nombre de la carpeta — no se renombra en esta pasada.');
    return false;
  }
  var deseado = String(sid || '').trim().toUpperCase() + '_' + nombreArbol;
  // CONDICIÓN 3 — el nombre difiere DE VERDAD. Comparación exacta, no
  // normalizada: si no, se renombraría en cada pasada por un acento.
  if (actual === deseado) { return false; }
  try {
    carpeta.setName(deseado);
    Logger.log('[' + sid + '] carpeta RENOMBRADA: "' + actual + '" → "' + deseado + '" (el arbol manda, #359).');
    return true;
  } catch (eRen) {
    Logger.log('⚠️ [' + sid + '] NO se pudo renombrar "' + actual + '" a "' + deseado + '" — ' +
      (eRen && eRen.message ? eRen.message : String(eRen)) +
      '. La ACL SI se ha aplicado (la carpeta se localiza por S-ID), pero el plugin no podra hacer I/O ' +
      'sobre esta caja mientras el nombre no case: resuelve el primer salto por NOMBRE exacto.');
    return false;
  }
}

/** Lo que el barrido de nombres necesita tener por delante para no morir a
 *  mitad de una pasada. Es SUYO y no se comparte con el publicador: cuando
 *  aprieta el reloj, el que se queda fuera es el barrido. */
var BARRIDO_NOMBRES_RESERVA_MS_ = 30 * 1000;

/**
 * Alinea con el árbol el nombre de TODAS las carpetas de caja, una vez por
 * pasada del trigger de 10 minutos (#424).
 *
 * POR QUÉ EXISTE: hasta ahora `syncRenombrarSiDivergeDelArbol_` solo se llamaba
 * al aplicar un ítem de la cola de ACL, así que renombrar una caja en el árbol no
 * hacía NADA hasta que alguien, por casualidad, concedía o retiraba un acceso en
 * esa misma caja. Reproducido en NFQ el 2026-08-28: `MIDL` → `ATI Middle` en el
 * árbol, la reconciliación ya decía `ACL esperada [ATI Middle]`, y la carpeta
 * siguió llamándose `S044_MIDL` hasta que un alta la tocó 26 minutos más tarde.
 *
 * POR QUÉ AQUÍ Y NO EN `syncDrivePermissions`: esa es la reconciliación completa
 * y es un BOTÓN MANUAL — no tiene trigger periódico, su único `newTrigger` es la
 * auto-continuación. Colgarle el renombrado cambiaría "depende de que alguien
 * mueva un acceso" por "depende de que alguien pulse un botón", que no es mejor.
 * Lo único que corre solo es esta pasada.
 *
 * EL ORDEN DE DENTRO NO ES ESTILO: se lista Drive PRIMERO y el árbol solo se lee
 * si hay al menos una carpeta `S###_`. Así una pasada sin cajas no abre el Excel
 * para no comparar nada — y es lo que mantiene verdes los dos tests que
 * comprueban que un ítem sin S-ID no llega a leer el árbol.
 *
 * COSTE: UN listado paginado de la raíz plana por pasada y comparación en
 * MEMORIA. Solo se abre con `DriveApp.getFolderById` lo que diverge o está
 * duplicado, que en régimen normal es nada. Abrir las 667 carpetas de BBVA cada
 * 10 minutos sería un problema de cuota, no un detalle de implementación.
 */
function syncBarrerNombresDeCajas_(memo, inicioPasada) {
  var ahora = new Date().getTime();
  var base = isFinite(Number(inicioPasada)) ? Number(inicioPasada) : ahora;
  if (LIMITE_EJECUCION_MS_ - (ahora - base) < BARRIDO_NOMBRES_RESERVA_MS_) {
    Logger.log('syncBarrerNombresDeCajas_: sin presupuesto en esta pasada — los nombres se alinean en la siguiente.');
    return { ok: false, error: 'presupuesto' };
  }

  var flatRootId = '';
  try { flatRootId = PropertiesService.getScriptProperties().getProperty('FLAT_ROOT_ID') || ''; }
  catch (eP) { return { ok: false, error: 'no se pudo leer FLAT_ROOT_ID' }; }
  if (!flatRootId) { return { ok: false, error: 'FLAT_ROOT_ID sin configurar' }; }

  // UN solo listado para todas las cajas. `findFlatBoxFolders_` y
  // `syncCarpetasPorSid_` listan la raíz ENTERA en cada llamada, así que usarlos
  // aquí serían N listados; y `flatIndexRootFolders_` sí lista una vez pero
  // COLAPSA los duplicados quedándose con el último, con lo que dos carpetas del
  // mismo S-ID parecerían una y se renombraría — justo lo que la condición 2 de
  // `syncRenombrarSiDivergeDelArbol_` existe para impedir. Por eso ARRAYS.
  var porSid = {};
  var grupos = 0;
  try {
    var q = "'" + flatRootId + "' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false";
    var pageToken = null;
    do {
      var resp = Drive.Files.list({ q: q, maxResults: 1000, pageToken: pageToken });
      // Por `flatDriveLista_` y NUNCA por `resp.items`: bajo Drive v3 esa lectura
      // devolvía [] CON ÉXITO, y aquí un [] significa "ninguna carpeta que
      // alinear". El barrido se quedaría ciego EN SILENCIO, que es el mismo fallo
      // que esta ficha viene a cerrar, una capa más abajo (#359).
      var items = flatDriveLista_(resp, 'files');
      for (var i = 0; i < items.length; i++) {
        var nombre = String(items[i].title || items[i].name || '');
        var m = /^(S\d+)_/.exec(nombre);
        if (!m) { continue; }
        // S-ID CRUDO, sin normalizar el relleno de ceros: el árbol se indexa
        // igual de crudo a propósito, y normalizar AQUÍ es lo que fabricaría
        // carpetas duplicadas (#363). Que un `S49` del árbol no case con una
        // carpeta `S049_` es el comportamiento correcto, no un agujero.
        var sid = String(m[1]).toUpperCase();
        if (!porSid[sid]) { porSid[sid] = []; grupos++; }
        porSid[sid].push({ id: items[i].id, nombre: nombre });
      }
      pageToken = resp && resp.nextPageToken;
    } while (pageToken);
  } catch (eLista) {
    Logger.log('syncBarrerNombresDeCajas_: no se pudo listar la raíz plana — ' +
      (eLista && eLista.message ? eLista.message : String(eLista)));
    return { ok: false, error: 'listado' };
  }

  // NI UNA carpeta de caja: se sale SIN leer el árbol.
  if (grupos === 0) { return { ok: true, renombradas: 0, revisadas: 0 }; }

  var arbol = syncArbolPorSid_(memo);
  if (!arbol || arbol.ok !== true) {
    // FAIL-CLOSED. Renombrar contra un árbol a medias sería ponerle a la carpeta
    // viva de un equipo el nombre de otra.
    Logger.log('syncBarrerNombresDeCajas_: el árbol no se pudo leer — no se renombra nada. (' +
      ((arbol && arbol.error) || 'sin respuesta') + ')');
    return { ok: false, error: 'arbol' };
  }

  var renombradas = 0;
  var revisadas = 0;
  for (var sidRev in porSid) {
    if (!Object.prototype.hasOwnProperty.call(porSid, sidRev)) { continue; }
    if (new Date().getTime() - base > LIMITE_EJECUCION_MS_ - BARRIDO_NOMBRES_RESERVA_MS_) {
      Logger.log('syncBarrerNombresDeCajas_: presupuesto agotado a mitad — el resto se alinea en la pasada siguiente.');
      break;
    }
    var nombreArbol = arbol.porSid[sidRev];
    // Sin fila en el árbol es una carpeta HUÉRFANA, y esas las registra el sync
    // por su cuenta: aquí no hay nombre destino que aplicar.
    if (!nombreArbol) { continue; }
    var grupo = porSid[sidRev];
    // EL AHORRO: una sola carpeta con el nombre ya alineado no se abre siquiera.
    // Es el caso de las 28 (o 667) cajas en un día normal.
    if (grupo.length === 1 && grupo[0].nombre === sidRev + '_' + nombreArbol) { continue; }
    var folders = [];
    for (var g = 0; g < grupo.length; g++) {
      try { folders.push(DriveApp.getFolderById(grupo[g].id)); }
      catch (eAbrir) {
        Logger.log('syncBarrerNombresDeCajas_: no se pudo abrir la carpeta ' + grupo[g].id + ' — ' +
          (eAbrir && eAbrir.message ? eAbrir.message : String(eAbrir)));
      }
    }
    // Si falta por abrir aunque sea UNA, saltar: con la lista incompleta la
    // condición 2 vería una carpeta donde hay dos y renombraría la que no debe.
    if (folders.length !== grupo.length) { continue; }
    revisadas++;
    if (syncRenombrarSiDivergeDelArbol_(sidRev, folders, nombreArbol)) { renombradas++; }
  }

  if (renombradas > 0) {
    Logger.log('syncBarrerNombresDeCajas_: ' + renombradas + ' carpeta(s) alineadas con el árbol.');
  }
  return { ok: true, renombradas: renombradas, revisadas: revisadas };
}

/**
 * ¿Se puede consultar la raíz plana AHORA MISMO? Una sola llamada, para
 * distinguir "esta caja no está" de "Drive no me contesta".
 *
 * `FLAT_ROOT_ID` vacía cuenta como NO legible: con ella sin poner,
 * `findFlatBoxFolders_` devuelve [] siempre, y tratar eso como "la caja no
 * existe" gastaría los intentos de todos los ítems por un fallo de
 * configuración que se arregla en un minuto.
 */
function syncRaizPlanaLegible_() {
  var flatRootId = '';
  try { flatRootId = PropertiesService.getScriptProperties().getProperty('FLAT_ROOT_ID') || ''; }
  catch (eP) { return { ok: false, error: 'no se pudo leer FLAT_ROOT_ID' }; }
  if (!flatRootId) { return { ok: false, error: 'FLAT_ROOT_ID sin configurar' }; }
  try {
    var resp = Drive.Files.list({
      q: "'" + flatRootId + "' in parents and trashed = false",
      maxResults: 1,
    });
    // NO BASTA CON QUE LA LLAMADA NO LANCE: tiene que devolver algo que sepamos
    // leer. Bajo Drive v3 esta consulta tenía ÉXITO y traía la lista en `files`
    // en vez de en `items`, así que esta sonda respondía "el repositorio se
    // consulta perfectamente" mientras `findFlatBoxFolders_` devolvía [] — y ese
    // [] se lee como "esta caja no tiene carpeta", o sea ningún permiso que
    // retirar. El fallo de #359 pasando por delante de su propio detector.
    //
    // Esta sonda existe para separar "no pude mirar" de "no existe", y una
    // respuesta ilegible es el caso más puro de "no pude mirar": tiene que decir
    // que NO. Cuesta cero llamadas de más —la respuesta ya está aquí— y evita
    // que una migración de dialecto vuelva a gastar los intentos de todo el
    // backlog contra cajas que sí existen.
    flatDriveLista_(resp, 'files');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message ? e.message : String(e)) };
  }
}

/**
 * ¿El servicio avanzado de Drive sigue hablando el dialecto que este código
 * entiende? UNA vez por pasada del trigger (#359).
 *
 * NO mira el manifiesto — un script no puede leer su propio `appsscript.json`,
 * y ese fichero vive en el SERVIDOR, no en git: por eso `git status` decía
 * "limpio" durante los 17 días en que el editor corría v3 y el repositorio
 * declaraba v2. Mira el COMPORTAMIENTO, que es lo que de verdad importa y lo
 * único que se puede comprobar desde dentro.
 *
 * Es un LOG, no un bloqueo, y es deliberado: parar el reparto porque la API
 * cambió de forma sería peor que seguir degradado. Lo que no puede es callarse.
 *
 * Es también el DISPARADOR de la migración a v3 (§5 de la spec, aplazada por
 * decisión de producto): el día que escriba la línea roja, esa deuda pasa a ser
 * lo urgente.
 *
 * Coste: una consulta con `maxResults: 1` cada 10 minutos.
 */
function syncChequearDialectoDrive_() {
  var flatRootId = '';
  try { flatRootId = PropertiesService.getScriptProperties().getProperty('FLAT_ROOT_ID') || ''; }
  catch (eP) { return; }
  if (!flatRootId) { return; }
  var resp;
  try {
    resp = Drive.Files.list({
      q: "'" + flatRootId + "' in parents and trashed = false",
      maxResults: 1,
    });
  } catch (e) {
    // La sonda que lanza NO es un cambio de dialecto: es Drive caído, sin cuota
    // o la raíz mal configurada. Se registra y se sigue — quien discrimina eso
    // por ítem es `syncRaizPlanaLegible_`.
    Logger.log('⚠️ DIALECTO DRIVE: la consulta de sondeo LANZO — ' + (e && e.message ? e.message : String(e)));
    return;
  }
  if (resp && resp.items) { return; }   // lo que el codigo espera HOY (v2)
  Logger.log('🔴 DIALECTO DRIVE CAMBIADO: la respuesta ' +
    ((resp && resp.files) ? 'trae `files` (v3)' : 'no trae ni `items` ni `files`') +
    '. TODO el reparto de ACLs esta roto EN SILENCIO — ver #359. Claves recibidas: ' +
    (resp ? Object.keys(resp).join(',') : '(null)'));
}

/**
 * Identidad de un ítem de la cola: persona + caja EXACTA.
 *
 * El S-ID va dentro y no es cosmético: los nombres de caja se repiten entre
 * áreas (58 duplicados en el árbol BBVA), y sin él dos operaciones sobre cajas
 * homónimas DISTINTAS se colapsarían como si fueran el mismo par y una de las
 * dos se descartaría sin aplicarse.
 */
function claveDeItem_(item) {
  return String(item.email || '').toLowerCase() + '|' +
    String(item.sid || '').toUpperCase() + '|' + String(item.boxKey || '');
}

/**
 * ¿El error de `removeEditor`/`removeViewer` significa "esa persona no estaba
 * en esa lista"? Ese es el ÚNICO caso benigno: retirar a quien no está es un
 * no-op legítimo. Todo lo demás —rate limit, permiso heredado del padre,
 * avería— es una retirada que NO se hizo, y confundirla con el no-op es lo que
 * dejaba a un revocado con EDITOR real y el ítem en la papelera.
 */
function syncEsNoEraPrincipal_(err) {
  var m = String((err && err.message) ? err.message : err || '').toLowerCase();
  return m.indexOf('no such user') >= 0 || m.indexOf('not a viewer') >= 0 ||
    m.indexOf('not an editor') >= 0 || m.indexOf('no tiene acceso') >= 0;
}

/**
 * ¿Este fallo al retirar es CONFIRMADAMENTE un permiso que la caja HEREDA de su
 * carpeta padre? Es decir: algo que no se puede quitar desde aquí y que no se
 * arregla reintentando (#426).
 *
 * NO BASTA CON EL MENSAJE, y esa es toda la razón de ser de esta función.
 * `flatEsPermisoHeredado_` casa la denegación GENÉRICA de Drive, que además del
 * permiso heredado cubre al menos "el ejecutor no puede gestionar el compartido
 * de esta carpeta" y "el destinatario es el propietario". En la reconciliación
 * tragarse los tres solo mueve un contador de log, y el estado deseado se
 * recalcula en la pasada siguiente. Aquí NO: un `ok` retira el ítem del buzón
 * (`setTrashed`), o sea BORRA la orden, y lo único que vería el acceso
 * superviviente es `syncDrivePermissions`, que es un botón manual. Confundirlos
 * deja a un revocado con EDITOR real y sin rastro — exactamente el fallo que la
 * rama `revoke` documenta haber cerrado, y que no se reabre por comodidad.
 *
 * El discriminador es el PROPIETARIO de la carpeta, que sí es comprobable desde
 * aquí: si la carpeta es del propietario del proyecto —el mismo que ejecuta esta
 * pasada—, nadie puede denegarle su propia ACL directa, luego la denegación solo
 * puede venir de la herencia del padre. Si la carpeta es de otro, el mensaje es
 * ambiguo y se trata como avería.
 *
 * Sonda descartada, escrita para que nadie la vuelva a proponer: re-listar la ACL
 * del hijo NO discrimina. El permiso heredado SÍ aparece en ese listado — es
 * justo lo que hace que la reconciliación pueda contar `heredados-no-retirables`.
 */
function syncHeredadoConfirmado_(folder, email, err) {
  if (!flatEsPermisoHeredado_(err)) { return false; }
  var duenoCarpeta = flatOwnerEmail_(folder);
  if (!duenoCarpeta) { return false; }
  var propietario = '';
  try { propietario = String(PropertiesService.getScriptProperties().getProperty('OWNER_EMAIL') || '').toLowerCase().trim(); }
  catch (eProp) { return false; }
  if (!propietario || duenoCarpeta !== propietario) { return false; }
  // Al propietario de una carpeta no se le puede retirar: eso no es herencia,
  // es otra cosa que tampoco va a funcionar nunca. Se deja como avería para que
  // se vea, en vez de enterrarla en el contador de heredados.
  if (String(email || '').toLowerCase().trim() === duenoCarpeta) { return false; }
  return true;
}

/** Describe un heredado para el log: a quién y en qué carpeta. El nombre se lee
 *  SOLO aquí y no en el bucle, para no gastar una llamada a Drive por retirada
 *  en el camino feliz. */
function syncDescribeHeredado_(folder, email) {
  var nombre = '';
  try { nombre = String(folder.getName() || ''); } catch (eNom) { nombre = '(nombre ilegible)'; }
  return email + ' en "' + nombre + '"';
}

/** Drive frena por tasa con varias redacciones, y ninguna es culpa del ítem. */
function syncEsRateLimit_(msg) {
  var m = String(msg || '').toLowerCase();
  return m.indexOf('rate limit') >= 0 || m.indexOf('ratelimitexceeded') >= 0 ||
    m.indexOf('userratelimitexceeded') >= 0 || m.indexOf('too many requests') >= 0 ||
    m.indexOf('quota') >= 0;
}

/**
 * Suma un intento al ítem y lo deja en el buzón para la pasada siguiente.
 *
 * Devuelve `false` si NO pudo anotarlo. Importa: un ítem cuyo contador nunca
 * sube se reintenta en cada pasada para siempre, sin alcanzar jamás el tope que
 * lo marcaría como atascado — un bucle silencioso, que es la clase de fallo que
 * este diseño existe para no tener. El contador `SIN-ANOTAR` del log es su
 * única señal.
 */
function syncSumarIntentoAcl_(item, error) {
  var intentos = Number(item.intentos || 0) + 1;
  Logger.log('syncAplicarAclPendientes: ' + item.op + ' de ' + item.email + ' en "' +
    item.boxKey + '" fallo (intento ' + intentos + '/' + ACL_QUEUE_MAX_INTENTOS_ + ') — ' + error);
  try {
    var copia = {};
    for (var kk in item) {
      if (Object.prototype.hasOwnProperty.call(item, kk) && kk !== '__file') { copia[kk] = item[kk]; }
    }
    copia.intentos = intentos;
    copia.ultimoError = String(error || '').slice(0, 300);
    item.__file.setContent(JSON.stringify(copia));
    return true;
  } catch (e) {
    Logger.log('syncAplicarAclPendientes: NO se pudo anotar el intento — el ítem se reintentara ' +
      'indefinidamente sin llegar al tope. (' + e + ')');
    return false;
  }
}

/**
 * Anota en el ítem que sus ficheros de login YA se repartieron, para que las
 * pasadas siguientes no vuelvan a hacerlo (#359).
 *
 * Best-effort a propósito: si no se puede escribir, la pasada siguiente
 * re-comparte —que es exactamente el comportamiento de antes— y no se pierde
 * nada. Por eso NO devuelve nada ni se cuenta: al contrario que el contador de
 * intentos, aquí no anotar no produce ningún bucle silencioso.
 *
 * Escribe también en el objeto en memoria: si más tarde en esta misma pasada el
 * ítem pasa por `syncSumarIntentoAcl_`, su copia tiene que llevarse la marca o
 * el `setContent` de allí la borraría.
 */
function syncMarcarLoginListo_(item) {
  item.loginOk = true;
  try {
    var copia = {};
    for (var k in item) {
      if (Object.prototype.hasOwnProperty.call(item, k) && k !== '__file') { copia[k] = item[k]; }
    }
    item.__file.setContent(JSON.stringify(copia));
  } catch (e) {
    // Se re-comparte en la pasada siguiente. Inocuo: es idempotente.
    item.loginOk = false;
  }
}

/** Tope al recuento del DLQ: pasado él la línea dice "N+". Con el DLQ lleno, el
 *  número exacto no cambia ninguna decisión y contarlo entero sí cuesta. */
var ACL_DLQ_MAX_CUENTA_ = 500;

/**
 * Cuántos ítems muertos hay AHORA MISMO en el DLQ. `-1` = no se pudo saber
 * (property vacía o carpeta ilegible), y el llamante calla en vez de inventarse
 * un cero tranquilizador.
 *
 * POR QUÉ SE CUENTA EN CADA PASADA (#359): mudar los cadáveres al DLQ apagó sin
 * querer la ÚNICA alarma recurrente que había. Antes, un ítem muerto se quedaba
 * en el buzón y la pasada gritaba `ATASCADOS` cada 10 minutos, para siempre.
 * Después, la pasada de la mudanza lo dice una vez y las siguientes cierran
 * `descartados=0` — indistinguible de un sistema sano, con N accesos sin aplicar
 * y `syncDrivePermissions`, que es quien los reconcilia, SIN trigger periódico.
 * Para un `revoke` muerto eso significa alguien conservando EDITOR real sin una
 * sola señal. La evidencia se muda de carpeta; la alarma no se muda a ningún
 * sitio, así que hay que volver a levantarla apuntando al sitio nuevo.
 */
function syncContarDlq_() {
  var dlqId = '';
  try { dlqId = PropertiesService.getScriptProperties().getProperty(ACL_DLQ_PROP_) || ''; }
  catch (eP) { return -1; }
  if (!dlqId) { return -1; }
  try {
    var it = DriveApp.getFolderById(dlqId).getFiles();
    var n = 0;
    while (it.hasNext() && n <= ACL_DLQ_MAX_CUENTA_) { it.next(); n++; }
    return n;
  } catch (e) {
    Logger.log('syncContarDlq_: no se pudo contar el DLQ — ' + (e && e.message ? e.message : String(e)));
    return -1;
  }
}

/**
 * Mueve un ítem MUERTO al DLQ. Devuelve `true` solo si de verdad salió del
 * buzón — el llamante decide con eso qué contar y qué decir en el log (#359).
 *
 * `motivo` es `'agotado'` (gastó `ACL_QUEUE_MAX_INTENTOS_`) o `'caducado'`
 * (alta de más de `ACL_QUEUE_MAX_EDAD_MS_`). Los dos están igual de muertos y
 * los dos se releían eternamente; el caducado además escribía una línea de log
 * en CADA pasada.
 *
 * SIN property configurada devuelve `false` sin tocar nada: es el interruptor de
 * rollback, y su comportamiento tiene que ser byte a byte el de antes de #359.
 *
 * BEST-EFFORT EN DOS NIVELES, y nunca peor que hoy:
 *  - Si falla el ESTAMPADO, se registra y se mueve igual: el fichero conserva su
 *    `ultimoError` y una carpeta con contexto a medias sigue siendo mejor que
 *    otra lectura de Drive cada 10 minutos para siempre.
 *  - Si falla el MOVIMIENTO, el ítem se queda donde está. Se comporta como antes
 *    de esta tarea, que es el peor caso aceptable.
 */
function syncMoverAlDlq_(file, reg, motivo, buzonId) {
  var dlqId = '';
  try { dlqId = PropertiesService.getScriptProperties().getProperty(ACL_DLQ_PROP_) || ''; }
  catch (eP) { return false; }
  if (!dlqId) { return false; }

  // El DLQ NO puede ser el propio buzón. Con el mismo ID pegado en las dos
  // properties, `moveTo` sobre el padre actual no lanza: devolvería `true`, el
  // contador subiría, el aviso de atascados desaparecería... y los cadáveres
  // seguirían dentro, releyéndose cada 10 minutos. O sea, el log diría `dlq=92`
  // describiendo exactamente el estado que esta tarea viene a cerrar. Mismo
  // precedente que `CONFIG_DATA_URL` vs la implementación pública: dos
  // properties que TIENEN que ser distintas se comprueban, no se suponen.
  if (buzonId && dlqId === buzonId) {
    Logger.log('🔴 ACL_DLQ_FOLDER_ID es la MISMA carpeta que ACL_QUEUE_FOLDER_ID — no se muda nada. ' +
      'Los items muertos se quedarian en el buzon releyendose para siempre mientras el log dice que salieron. ' +
      'Pon el ID de una carpeta DISTINTA (sin compartir con nadie) o borra la property.');
    return false;
  }

  // Se estampa ANTES de mover para que el fichero se explique solo: si no,
  // acabas con una carpeta de UUIDs sin contexto. `ultimoError` ya viaja en el
  // JSON desde #318 (verificado sobre los 92 ficheros reales del incidente).
  try {
    var copia = {};
    for (var k in reg) {
      if (Object.prototype.hasOwnProperty.call(reg, k) && k !== '__file') { copia[k] = reg[k]; }
    }
    copia.motivo = motivo;
    copia.movidoAt = new Date().getTime();
    file.setContent(JSON.stringify(copia));
  } catch (eSet) {
    Logger.log('syncMoverAlDlq_: no se pudo estampar el motivo — se mueve igual, con el ultimoError que ya tuviera. (' +
      (eSet && eSet.message ? eSet.message : String(eSet)) + ')');
  }

  try {
    // `moveTo` y no `addFile` + `removeFile`: es UNA llamada y no puede dejar el
    // fichero en las dos carpetas a la vez si la segunda falla — con el par, un
    // fallo entre medias deja el cadáver en el DLQ Y en el buzón, o sea que
    // seguiría releyéndose que es justo lo que esto viene a cerrar.
    file.moveTo(DriveApp.getFolderById(dlqId));
    return true;
  } catch (eMov) {
    Logger.log('syncMoverAlDlq_: no se pudo mover al DLQ un ítem ' + motivo + ' — se queda en el buzón. (' +
      (eMov && eMov.message ? eMov.message : String(eMov)) + ')');
    return false;
  }
}

/** Agenda UNA continuación si quedó backlog. Borra antes las previas para no
 *  apilar triggers — apilarlos reintroduciría por la puerta de atrás justo la
 *  simultaneidad que este diseño elimina. */
function syncAgendarContinuacionAcl_() {
  try {
    syncBorrarContinuacionesAcl_();
    ScriptApp.newTrigger(ACL_QUEUE_CONTINUE_HANDLER_).timeBased().after(ACL_QUEUE_CONTINUE_DELAY_MS_).create();
    Logger.log('syncAplicarAclPendientes: queda backlog — continuacion agendada en ~' +
      Math.round(ACL_QUEUE_CONTINUE_DELAY_MS_ / 1000) + 's.');
  } catch (e) {
    Logger.log('syncAgendarContinuacionAcl_: no se pudo agendar (quota de triggers?) — el trigger de 10 min lo recoge igual. (' +
      (e && e.message ? e.message : String(e)) + ')');
  }
}

/** Borra SOLO las continuaciones. El trigger periódico usa OTRO handler, así que
 *  este barrido no puede alcanzarlo ni por accidente. */
function syncBorrarContinuacionesAcl_() {
  try {
    var triggers = ScriptApp.getProjectTriggers();
    for (var i = 0; i < triggers.length; i++) {
      if (triggers[i].getHandlerFunction() === ACL_QUEUE_CONTINUE_HANDLER_) {
        ScriptApp.deleteTrigger(triggers[i]);
      }
    }
  } catch (e) {
    Logger.log('syncBorrarContinuacionesAcl_: no se pudieron limpiar triggers — ' + (e && e.message ? e.message : String(e)));
  }
}

/**
 * Properties que este proyecto necesita para funcionar. Se registran por
 * PRESENCIA, nunca por valor: `SOURCES_TOKEN` y compañía no tienen por qué
 * acabar en un log que se pega en un chat.
 */
var SYNC_PROPS_CRITICAS_ = [
  // `SHEET_NAME` está aquí desde #359 §4 y NO es redundante con `TREE_SHEET_NAME`:
  // el gate del árbol pasa por `cfgLookupRole_`, que abre la pestaña de ROLES
  // para comprobar que el propietario es admin. O sea que una pestaña de Roles
  // renombrada tumba el reparto de ACL entero, y sin esta entrada el diagnóstico
  // enseñaba precisamente la mitad que NO falla en ese camino.
  'OWNER_EMAIL', 'CONFIG_DATA_URL', 'SHEET_ID', 'SHEET_NAME', 'TREE_SHEET_NAME',
  'FLAT_ROOT_ID', 'DRIVE_ROOT_ID', 'ALLOWED_DOMAINS',
  'ACL_QUEUE_FOLDER_ID', 'ACL_DLQ_FOLDER_ID', 'TRAIL_INBOX_FOLDER_ID', 'TRAIL_SHEET_ID',
];

/**
 * `Run → syncVerificarEntorno()` — foto del entorno en una pasada, para cotejar
 * el EDITOR contra el repositorio a ojo (#359 §6a).
 *
 * POR QUÉ EXISTE: `gas/appsscript.OAuthToken.json` estuvo 17 días diciendo `v2`
 * mientras el proyecto real corría `v3`, y `git status` decía "limpio" — el
 * manifiesto vive en el servidor, no en git. Sin `clasp` (npm bloqueado por el
 * proxy corporativo) no hay comparación automática posible; esto es lo que sí se
 * puede: preguntárselo al proyecto vivo.
 *
 * SIN `cfgAssertPrivileged_()`, y es deliberado: ese assert exige `OWNER_EMAIL`
 * puesta, y "¿está `OWNER_EMAIL` puesta?" es una de las preguntas que esta
 * función existe para contestar. Con el assert, el caso que más urge
 * diagnosticar sería el único que no diría nada. La barrera real es que aquí
 * solo se llega desde el editor: `sync-drive-permissions.gs` es inalcanzable por
 * HTTP, y eso lo verifica el build (`fallosSyncInalcanzablePorHttp`).
 */
function syncVerificarEntorno() {
  Logger.log('── syncVerificarEntorno ──────────────────────────────────');

  // 1. El dialecto de Drive, que es lo que nadie estaba mirando.
  syncChequearDialectoDrive_();
  var sonda = syncRaizPlanaLegible_();
  Logger.log('raíz plana legible: ' + (sonda.ok ? 'SÍ' : 'NO — ' + sonda.error));

  // 1b. EL ÁRBOL, que desde #359 §4 es el gate del reparto de ACL y por tanto un
  //     punto único de fallo: si no se puede leer, la pasada se para ENTERA cada
  //     10 minutos y a las 24 h el backlog de altas caduca al DLQ sin aplicarse.
  //
  //     Va aquí porque este diagnóstico se añadió justo para "algo se rompió y
  //     nadie lo ve", y sin esta línea no veía el modo de fallo que la misma
  //     tarea introdujo. Y el mensaje de la acción MIENTE en el caso más
  //     probable: `cfgActionTreeRaw_` descarta el `warning` de `cfgLookupRole_`,
  //     así que una `SHEET_ID` vacía o una pestaña de ROLES renombrada salen como
  //     "Solo un admin puede leer el árbol completo" (#333/#304). Por eso el
  //     recordatorio va pegado al resultado: lo que hay que mirar primero es la
  //     configuración del Sheet, no la columna D.
  var arbol = syncArbolPorSid_({});
  Logger.log('árbol legible: ' + (arbol.ok
    ? 'SÍ — ' + Object.keys(arbol.porSid).length + ' S-ID usables'
    : 'NO — ' + arbol.error +
      '  ⚠️ SIN ESTO NO SE REPARTE NINGUNA ACL. Comprueba SHEET_ID, SHEET_NAME (pestaña de ROLES, ' +
      'que es la que abre el gate) y TREE_SHEET_NAME antes de mirar si el propietario es admin: ' +
      'el mensaje de arriba no distingue "no eres admin" de "no pude leer el Sheet".'));

  // 2. Properties, por presencia. Cada `getProperty` va en su propio try: que
  //    una falle no puede dejarte sin ver el resto del cuadro.
  var presentes = [];
  var ausentes = [];
  for (var i = 0; i < SYNC_PROPS_CRITICAS_.length; i++) {
    var nombre = SYNC_PROPS_CRITICAS_[i];
    var valor = null;
    try { valor = PropertiesService.getScriptProperties().getProperty(nombre); }
    catch (eP) { valor = null; }
    if (valor) { presentes.push(nombre); } else { ausentes.push(nombre); }
  }
  Logger.log('properties presentes (' + presentes.length + '): ' + presentes.join(', '));
  Logger.log('properties AUSENTES  (' + ausentes.length + '): ' + (ausentes.length ? ausentes.join(', ') : '(ninguna)'));

  // 3. Las dos implementaciones. Se registran los VALORES a propósito: son URLs
  //    de deployment, no secretos, y compararlas es todo el objetivo — si
  //    `CONFIG_DATA_URL` apunta por error a la PÚBLICA, el login funciona para el
  //    propietario y para nadie más, y no hay otra forma de verlo desde aquí.
  var configUrl = '';
  try { configUrl = PropertiesService.getScriptProperties().getProperty('CONFIG_DATA_URL') || ''; }
  catch (eU) { configUrl = ''; }
  Logger.log('CONFIG_DATA_URL (privilegiada): ' + (configUrl || '(SIN CONFIGURAR — el login se cae para todos)'));
  try { Logger.log('getService().getUrl() (esta implementación): ' + (ScriptApp.getService().getUrl() || '(sin publicar)')); }
  catch (eS) { Logger.log('getService().getUrl(): no disponible — ' + (eS && eS.message ? eS.message : String(eS))); }
  Logger.log('Tienen que ser DISTINTAS. Si coinciden, `CONFIG_DATA_URL` apunta a la pública.');

  // 4. Los triggers, que es lo que de verdad mueve este fichero.
  try {
    var handlers = [];
    var triggers = ScriptApp.getProjectTriggers();
    for (var t = 0; t < triggers.length; t++) { handlers.push(triggers[t].getHandlerFunction()); }
    Logger.log('triggers instalados: ' + (handlers.length ? handlers.join(', ') : '(NINGUNO — la cola no se drena sola)'));
  } catch (eT) {
    Logger.log('triggers: no se pudieron listar — ' + (eT && eT.message ? eT.message : String(eT)));
  }

  Logger.log('── Cotéjalo con gas/appsscript.OAuthToken.json y docs/setup-environment.md ──');
}

/** Crea el trigger periódico de 10 min si no existe. Idempotente. Se ejecuta a
 *  mano desde el editor (Run), como `cfgInstalarTriggerRastro`. */
function syncInstalarTriggerAcl() {
  var existentes = ScriptApp.getProjectTriggers();
  for (var t = 0; t < existentes.length; t++) {
    if (existentes[t].getHandlerFunction() === ACL_QUEUE_HANDLER_) {
      Logger.log('syncInstalarTriggerAcl: ya existe — nada que hacer.');
      return;
    }
  }
  ScriptApp.newTrigger(ACL_QUEUE_HANDLER_).timeBased().everyMinutes(10).create();
  Logger.log('syncInstalarTriggerAcl: trigger creado (cada 10 min).');
}

// ════════════════════════════════════════════════════════════════════════════
//  #325 — Publicador de la caché de lecturas de `listBoxUsers`
// ════════════════════════════════════════════════════════════════════════════
//
// `listBoxUsers` en frío tarda 13-25 s, y la mitad privilegiada solo se lleva
// 6-9 de ellos: el resto es la pública esperando a que el buzón de Apps Script
// (`googleusercontent/macros/echo`) le entregue el resultado. #319 ya quitó la
// amplificación autoinfligida y el emparejamiento pública↔privilegiada es 1:1,
// así que dentro de ese camino no queda nada que optimizar. La única salida es
// no recorrerlo.
//
// Esto publica en `CacheService.getScriptCache()` —script-scoped, o sea
// COMPARTIDA entre las dos implementaciones, que son el mismo proyecto— los dos
// índices que la pública necesita para responder sola. Lo que hace que eso no
// sea un agujero está documentado en `cfgFastPathBoxKey_` (ConfigData.gs) y
// verificado en cada build: la clave del censo no se puede construir sin el
// `salt`, y el `salt` solo existe dentro de la entrada del email autorizado.
//
// **Vive AQUÍ y no en ConfigData a propósito**: ni `OAuthToken.gs` ni
// `ConfigData.gs` llaman a una sola función de este fichero, así que a este
// código no se llega por HTTP; triggers y `Run` usan el último código GUARDADO,
// no el desplegado. `Ctrl+S` basta para que empiece a publicar, sin republicar
// ninguna implementación — que es lo que permite encenderlo y mirar el log
// durante días ANTES de que exista ningún lector.

/**
 * Presupuesto para CONSTRUIR los índices, y su reloj arranca cuando la matriz de
 * roles ya está leída.
 *
 * No es un detalle: montar los índices es CPU pura (milisegundos), mientras que
 * conseguir los datos cuesta órdenes de magnitud más. Midiendo desde antes de la
 * lectura, el presupuesto se lo come ella y el bucle rompe en la PRIMERA vuelta:
 * la pasada cierra con `cajas=0`, `gestores=0` y cero claves escritas. Y como el
 * corte cae siempre en el mismo sitio, dos pasadas lentas seguidas dejan la caché
 * fría — justo en las ventanas congestionadas, que son las que motivaron #325.
 * Desde #327 la lectura es en proceso y tarda ~1 s en vez de 6-90, así que la
 * separación ya no es la diferencia entre publicar y no publicar; se mantiene
 * porque abrir el Excel sigue sin ser gratis y porque este contador tiene que
 * seguir midiendo lo que promete. El techo de la pasada lo pone el límite de
 * 6 min de Apps Script, no este contador.
 */
var CACHE_PUB_BUDGET_MS_ = 60 * 1000;

/**
 * El límite duro de una ejecución de Apps Script. No es una preferencia nuestra:
 * lo pone Google, y es el único techo real contra el que hay que decidir.
 */
var LIMITE_EJECUCION_MS_ = 6 * 60 * 1000;

/**
 * Las DOS reservas del trabajo que no tiene presupuesto propio, y van separadas
 * porque se cobran en momentos distintos.
 *
 * Juntarlas en una sola era un error: el corte de entrada reserva las dos, pero
 * cuando se calcula el tope del bucle la LECTURA ya se ha pagado, así que restar
 * la reserva entera otra vez la cobraba dos veces. Con una pasada admitida en el
 * borde (300 s gastados) y un Excel en frío, eso dejaba el tope del bucle en
 * negativo: se rompía en la primera vuelta, la pasada gastaba las dos lecturas
 * del Excel, escribía CERO claves y cerraba con `ok:true` y un `0/0` que se lee
 * como "no había nada que escribir".
 */
var CACHE_PUB_RESERVA_LECTURA_MS_ = 25 * 1000;
var CACHE_PUB_RESERVA_ESCRITURA_MS_ = 20 * 1000;

/**
 * Cuánto bucle de índices tiene que caber para que MEREZCA la pena entrar. Por
 * debajo de esto se publicarían cuatro cajas y se dejaría el resto fuera, que es
 * peor que aplazar: gasta el cupo del propietario para dejar la caché coja.
 */
var CACHE_PUB_MIN_BUCLE_MS_ = 15 * 1000;

/**
 * Lo que se reserva para CERRAR la pasada después del último lote: guardar la
 * huella y escribir el recuento. Es poco trabajo, pero es el que convierte una
 * publicación truncada en una publicación truncada Y CONTADA — sin él, morir en
 * el límite deja la huella sin actualizar y la detección de ediciones a mano se
 * pierde en silencio hasta la siguiente pasada que sí la guarde.
 */
var CACHE_PUB_CIERRE_MS_ = 10 * 1000;

/**
 * La decisión de entrar se toma sobre el tiempo que QUEDA, no sobre el gastado
 * (#332).
 *
 * Antes era un umbral fijo de 150 s de gasto, heredado de cuando detrás de la
 * puerta venía el relay con su espera impredecible. Con el drenaje presupuestado
 * en `ACL_QUEUE_BUDGET_MS_` (240 s), ese umbral hacía IMPOSIBLE publicar en
 * cuanto había backlog: la pasada llegaba aquí con 240 s gastados, aplazaba "a la
 * siguiente", la continuación drenaba otros 4 min y volvía a aplazar. O sea que
 * durante toda una cadena de continuaciones —justo cuando cada alta sube
 * `CACHE_GEN` y el camino rápido está inalcanzable— la caché no se publicaba ni
 * una vez, y "aplazada a la siguiente" era una promesa que el código no podía
 * cumplir.
 *
 * Preguntando por lo que queda, una pasada que drenó 240 s todavía entra con
 * ~115 s por delante, que es de sobra para leer, construir y escribir. Y el
 * número deja de ser mágico: sale de restar al límite duro lo que este código
 * necesita.
 */
function syncPuedePublicar_(gastado) {
  return (LIMITE_EJECUCION_MS_ - gastado)
    >= (CACHE_PUB_RESERVA_LECTURA_MS_ + CACHE_PUB_RESERVA_ESCRITURA_MS_ + CACHE_PUB_MIN_BUCLE_MS_);
}

/** Huella de la matriz publicada, con la generación bajo la que se publicó.
 *  Detecta ediciones A MANO del Sheet, que no pasan por `cfgBumpCacheGen_`. */
var CACHE_PUB_HUELLA_PROP_ = 'CACHE_SHEET_FP';

/** Tope por entrada. `CacheService` corta en ~100 KB por clave y una entrada que
 *  no cabe se descarta EN SILENCIO, que es justo lo que este fichero no se puede
 *  permitir: se comprueba antes y se cuenta en el log. */
var CACHE_PUB_MAX_BYTES_ = 90 * 1024;

/** Claves por `putAll`. De una en una serían cientos de llamadas al servicio
 *  dentro de un trigger que ya va justo de presupuesto. */
var CACHE_PUB_LOTE_ = 50;

/** Tope de longitud de clave de `CacheService` (250). Se comprueba ANTES de
 *  meterla en el lote porque `putAll` es todo-o-nada: una sola clave inválida
 *  —un nombre de caja absurdamente largo— tira las otras 49 del lote. Descartar
 *  esa caja cuesta una lectura lenta; perder el lote cuesta cincuenta. */
var CACHE_PUB_MAX_CLAVE_ = 250;

/**
 * Huella de las columnas que deciden roles (B..H, de la fila 3 en adelante).
 *
 * No es criptográfica y no necesita serlo: solo tiene que cambiar cuando cambien
 * los datos, para detectar una edición a mano del Excel. Se combinan longitud y
 * dos hashes independientes para que un cambio accidental no colisione.
 */
function syncHuellaRoles_(values) {
  // Separador OBLIGATORIO entre celda y celda: sin él, mover una letra de una
  // columna a la siguiente daría la MISMA huella y la edición pasaría
  // desapercibida ("Alfa"+"Beta" y "AlfaB"+"eta" concatenan igual). No hace
  // falta uno de FILA: el bucle emite siempre 7 celdas por fila, así que la
  // agrupación ya queda determinada por la posición.
  //
  // Va como escape y no como carácter literal porque este fichero se pega a mano
  // en el editor de Apps Script y los invisibles no sobreviven a un copy-paste.
  var sepCelda = '\u0001';
  var s = '';
  for (var i = 2; i < values.length; i++) {
    var fila = values[i] || [];
    for (var c = 1; c <= 7; c++) { s += String(fila[c] || '') + sepCelda; }
  }
  var h1 = 0x811c9dc5;
  var h2 = 0;
  for (var k = 0; k < s.length; k++) {
    var ch = s.charCodeAt(k);
    h1 = ((h1 ^ ch) * 16777619) >>> 0;
    h2 = ((h2 * 31) + ch) >>> 0;
  }
  return s.length + '-' + h1.toString(36) + '-' + h2.toString(36);
}

/**
 * Agrupa las claves del universo del censo por CAJA REAL, resolviendo cada una a
 * su par COMPLETO `(sid, boxKey)` contra el árbol (#370).
 *
 * EL BUG QUE CIERRA. `cfgAllBoxKeysFromValues_` deriva token a token, así que
 * cada clave nace con MEDIA pareja: `s:S049` → `{sid:'S049', boxKey:''}` y
 * `n:reporting` → `{sid:'', boxKey:'reporting'}`. El publicador construía el
 * censo con esa mitad mientras el relay resuelve LAS DOS. En una caja a medio
 * migrar eso publicaba un censo SUBCONJUNTO — y lo peligroso es que **acierta la
 * clave**: no hay miss que degrade al relay y lo salve. Verificado sobre el `.gs`
 * real: Sheet con `champ@` col E=`S049` y `ana@`/`luis@` col F=`Reporting` →
 * `s:S049` = [champ@], `n:reporting` = [ana@, luis@], relay = los TRES.
 *
 * Y el estado "a medio migrar" NO es transitorio: `cfgListAddSid_` hace que TODO
 * grant escriba S-ID mientras el migrador nunca toca las celdas ambiguas — o
 * sea, precisamente las homónimas, que no se migran nunca.
 *
 * REGLAS DE AGRUPACIÓN, y ninguna es opcional — el censo publicado tiene que
 * coincidir EXACTAMENTE con el que daría el relay para esa misma clave, o la
 * caché contesta algo que el gate real no confirma:
 *
 *  1. `s:S###` → el nombre sale del árbol. Se publica el MISMO censo también
 *     bajo `n:<nombre>` **solo si ese nombre resuelve de vuelta a UN único
 *     S-ID**. Con dos homónimas no se fusionan: un lector sin S-ID que pida
 *     `n:reporting` recibe del relay el censo por NOMBRE (`cfgCajaObjetivo_`
 *     deniega ante nombre ambiguo y `cfgCajaParaLeer_` degrada), que NO incluye
 *     a los de la celda `S049`. Fusionarlas serviría un superconjunto.
 *  2. `n:<nombre>` → si el árbol le da UN solo S-ID, par completo y se fusiona
 *     con `s:<sid>`. Ambiguo o desconocido → par solo-nombre, en solitario: es
 *     la verdad de ese Sheet y es lo que devuelve el relay.
 *  3. S-ID HUÉRFANO (no está en el árbol) → **no se publica**. El relay no puede
 *     dar ese censo (deniega antes, #368) y publicar uno inventaría una
 *     respuesta que el gate real no daría. Miss → relay. Latencia, no
 *     corrección.
 *
 * Devuelve `{ ok, grupos: [{claves:[…], sid, boxKey}], huerfanos }`, o
 * `ok:false` si el árbol no se puede leer — sin árbol no hay forma de completar
 * un par, y publicar medias parejas es justo el bug. Fail-closed: se pierde el
 * camino rápido de esa pasada, nunca la corrección.
 */
function syncGruposCenso_(universo, arbol) {
  if (!arbol || arbol.ok !== true) {
    return { ok: false, grupos: [], huerfanos: 0, error: (arbol && arbol.error) || 'arbol ilegible' };
  }
  // nombre normalizado → S-ID, solo cuando ese nombre tiene UNA sola caja.
  //
  // ⚠ "UNA sola caja" se cuenta con `filasPorNombre`, que incluye las filas del
  // árbol **sin S-ID todavía** — es la misma definición que usa
  // `cfgCajaObjetivo_` (`filas.length > 1` sobre TODAS las filas) y por tanto
  // la que usa el relay. Contarlo sobre las materializadas era el bug: dos
  // homónimas con una migrada y la otra no —estado NORMAL, el S-ID se acuña al
  // abrir la caja— parecían inequívocas, `n:<nombre>` se fusionaba en el grupo
  // `s:S###` y el censo de la migrada se servía por caché al champion de la
  // OTRA. Publicador y relay tienen que compartir la definición de "ambiguo" o
  // la caché contesta lo que el gate real deniega.
  var sidPorNombre = {};
  var porSidNorm = arbol.porSidNorm || {};
  var filasPorNombre = arbol.filasPorNombre || {};
  var sid;
  for (sid in porSidNorm) {
    if (!Object.prototype.hasOwnProperty.call(porSidNorm, sid)) { continue; }
    var clave = cfgNormBox_(porSidNorm[sid]);
    if (!clave) { continue; }
    // Más de una FILA con ese nombre → ambiguo, aunque solo una tenga S-ID.
    if ((filasPorNombre[clave] || 0) !== 1) { continue; }
    sidPorNombre[clave] = sid;
  }

  var grupos = {};
  var huerfanos = 0;
  var k;
  /** Mete `clave` en el grupo canónico `id`, fijando su par completo. */
  var meter = function (id, claveOriginal, sidPar, boxKeyPar) {
    if (!Object.prototype.hasOwnProperty.call(grupos, id)) {
      grupos[id] = { claves: [], sid: sidPar, boxKey: boxKeyPar };
    }
    grupos[id].claves.push(claveOriginal);
  };
  for (k in universo) {
    if (!Object.prototype.hasOwnProperty.call(universo, k)) { continue; }
    var par = universo[k];
    if (par.sid) {
      // Por el índice NORMALIZADO: `par.sid` viene de `cfgNormSid_` y las
      // claves de `porSid` son crudas, así que un `S49` del árbol no casaba.
      var nombre = porSidNorm[par.sid];
      if (!nombre) { huerfanos++; continue; }                       // regla 3
      var bk = cfgNormBox_(nombre);
      // El par completo es el mismo que devolvería `cfgCajaObjetivo_`: S-ID
      // validado contra el árbol + el nombre de SU fila.
      meter('s:' + par.sid, k, par.sid, bk);
      continue;
    }
    var propio = sidPorNombre[par.boxKey];                          // regla 2
    if (propio) { meter('s:' + propio, k, propio, par.boxKey); continue; }
    meter('n:' + par.boxKey, k, '', par.boxKey);
  }

  // Regla 1, segunda mitad: una caja identificada se publica bajo **LAS DOS**
  // claves con las que se la puede pedir, aunque el Sheet solo haya producido
  // una. Las dos direcciones hacen falta y por motivos distintos:
  //
  //  · `s:S###` — la pide el lector que SÍ manda S-ID (la superficie 'admin' lo
  //    deriva server-side). Sin ella, una caja cuyas celdas sigan todas por
  //    nombre nunca acierta y cae al relay para siempre.
  //  · `n:<nombre>` — la pide el lector que NO lo manda. Solo si el nombre
  //    resuelve de vuelta a ESTE S-ID: con dos homónimas, esa clave le
  //    corresponde al censo por nombre, no al de una de las dos.
  var id;
  for (id in grupos) {
    if (!Object.prototype.hasOwnProperty.call(grupos, id)) { continue; }
    var g = grupos[id];
    if (!g.sid) { continue; }                                       // grupo solo-nombre
    var porSid = 's:' + g.sid;
    if (g.claves.indexOf(porSid) < 0) { g.claves.push(porSid); }
    if (!g.boxKey) { continue; }
    if (sidPorNombre[g.boxKey] !== g.sid) { continue; }              // nombre ambiguo → no
    var porNombre = 'n:' + g.boxKey;
    if (g.claves.indexOf(porNombre) < 0) { g.claves.push(porNombre); }
  }

  var lista = [];
  for (id in grupos) {
    if (Object.prototype.hasOwnProperty.call(grupos, id)) { lista.push(grupos[id]); }
  }
  return { ok: true, grupos: lista, huerfanos: huerfanos };
}

/**
 * Publica los dos índices del camino rápido. Best-effort de principio a fin:
 * NADA de lo que falle aquí puede degradar la corrección de una lectura — como
 * mucho la deja lenta, que es exactamente como está hoy.
 *
 * Cierra siempre con un recuento (cajas, gestores, omitidos, generación) por el
 * mismo motivo que el drenador: el riesgo de un publicador no es fallar, es
 * fallar en silencio y que nadie sepa si la caché está viva.
 */
function syncPublicarCacheLecturas_(inicioPasada) {
  var inicio = new Date().getTime();
  // UN SOLO ORIGEN DE TIEMPO para las tres protecciones (entrada, bucle de
  // índices, bucle de escritura). Colgarlas cada una de `isFinite(inicioPasada)`
  // hacía que un `Run → syncPublicarCacheLecturas_()` desde el editor —el gesto
  // típico al depurar esto— las apagase LAS TRES, incluida la que evita morir a
  // mitad del `putAll` sin guardar la huella. Sin argumento, el reloj mide desde
  // el arranque del propio publicador, que es la cota correcta.
  var base = isFinite(Number(inicioPasada)) ? Number(inicioPasada) : inicio;
  var gastado = inicio - base;
  if (!syncPuedePublicar_(gastado)) {
    Logger.log('syncPublicarCacheLecturas_: quedan ' + Math.round((LIMITE_EJECUCION_MS_ - gastado) / 1000) +
      ' s de ejecución (la pasada lleva ' + Math.round(gastado / 1000) + ' s) — publicación aplazada a la ' +
      'siguiente para no morir en el límite de Apps Script.');
    return { ok: false, error: 'presupuesto' };
  }

  var cache = null;
  try { cache = CacheService.getScriptCache(); } catch (eCache) { cache = null; }
  if (!cache) {
    Logger.log('syncPublicarCacheLecturas_: sin CacheService — no se publica nada.');
    return { ok: false, error: 'sin cache' };
  }

  // EN PROCESO, sin salir por HTTP (#327).
  //
  // El salto por `relayConfigData_` existe para que la implementación PÚBLICA
  // cruce la frontera de privilegio, y se mantuvo incluso para el propietario por
  // un motivo DIAGNÓSTICO: un atajo en proceso habría escondido #292 tres semanas
  // más. Ninguna de las dos razones alcanza a ESTE llamante — el publicador solo
  // arranca por trigger o por `Run`, siempre como el propietario, y a este fichero
  // no se llega por HTTP (lo fija `fallosSyncInalcanzablePorHttp` en el build, y
  // sin ese invariante esta llamada no sería recomendable). El salto salía del
  // proceso para volver a entrar: 10-85 s medidos y una ejecución privilegiada de
  // más por pasada, cada 10 minutos, justo cuando el propietario ya va cargado.
  //
  // El gate queda MÁS FUERTE, no más débil: por HTTP bastaba ser admin; aquí hay
  // que ser además el propietario. Se afirma ANTES de leer y fuera del `try` para
  // que un fallo de identidad no se confunda en el log con un Excel ilegible: los
  // dos llamantes capturan la excepción, así que lo que se ve es una línea de log
  // distinta, no un trigger en rojo. Y se repite aquí aunque `syncAplicarAclPendientes`
  // ya afirme: el que depende del gate es este código, y depender de que un
  // llamante se acuerde es lo que este fichero no se puede permitir.
  cfgAssertPrivileged_();
  var res = null;
  try {
    // La ACCIÓN entera, y no el abridor de la hoja: es ella la que sella la
    // generación ANTES de leer los datos, y ese orden es el invariante de #325
    // (un sello que se pase de largo cuesta el gate, no una publicación).
    // Reimplementar la lectura aquí es lo que prohíbe la regla del censo, y por
    // lo mismo: las dos copias divergirían en silencio.
    //
    // El caller es la identidad REAL que acaba de dar Google y no `OWNER_EMAIL`:
    // la acción gatea por `cfgLookupRole_(...).isAdmin` y pasar la constante
    // puentearía ese gate. Es exactamente la que hoy viaja en el payload del relay.
    res = cfgActionRolesMatrix_({ email: Session.getEffectiveUser().getEmail() });
  } catch (eMatriz) {
    Logger.log('syncPublicarCacheLecturas_: la lectura de la matriz de roles lanzó — no se publica. (' +
      (eMatriz && eMatriz.message ? eMatriz.message : String(eMatriz)) + ')');
    return { ok: false, error: 'rolesMatrix' };
  }
  if (!res || res.ok !== true || !res.values || !res.values.length) {
    Logger.log('syncPublicarCacheLecturas_: no se pudo leer la matriz de roles — no se publica. (' +
      ((res && res.error) || 'sin respuesta') + ')');
    return { ok: false, error: 'rolesMatrix' };
  }
  var values = res.values;

  // El freno del SHEET A MEDIO MIGRAR se retiró aquí con la fase E de #365: el
  // censo se indexa ahora por CLAVE DE CAJA (S-ID si la celda está migrada,
  // nombre normalizado si no), el mismo criterio que usa el lector, así que un
  // Sheet a medias ya no produce un censo a medias.

  // GENERACIÓN EN EL MOMENTO DE LEER. Se vuelve a mirar antes de escribir: si un
  // grant/revoke ha entrado por medio, esta foto ya es vieja.
  var gen = Number(res.cacheGen);
  if (!isFinite(gen)) {
    Logger.log('syncPublicarCacheLecturas_: la matriz llegó sin `cacheGen` (¿ConfigData sin actualizar?) — no se publica.');
    return { ok: false, error: 'sin generacion' };
  }

  // EDICIÓN A MANO DEL SHEET. `CACHE_GEN` solo lo sube `grant`/`revoke`, así que
  // un admin que edite las columnas de roles directamente en el Excel no
  // invalida nada: sin esto, a quien le vacían la col E le seguiría respondiendo
  // la caché hasta el corte de frescura (15 min), cuando antes de #325 la
  // siguiente llamada ya le decía que no. Se detecta comparando la huella de la
  // matriz con la de la última publicación: si cambió y la generación NO, el
  // cambio vino por una vía que no invalida — se sube la generación y se
  // DESCARTA esta pasada. Todo el mundo cae al relay durante ≤10 min y la
  // siguiente pasada publica limpio.
  //
  // Se descarta en vez de publicar bajo la generación nueva a propósito: subirla
  // y seguir exigiría que entre el bump y la escritura no entrara un grant, y
  // eso no se puede garantizar sin lock. Más lento, nunca incorrecto.
  var huella = syncHuellaRoles_(values);
  var previo = null;
  try { previo = JSON.parse(PropertiesService.getScriptProperties().getProperty(CACHE_PUB_HUELLA_PROP_) || 'null'); }
  catch (eHuella) { previo = null; }
  if (previo && previo.fp !== huella && previo.gen === gen) {
    cfgBumpCacheGen_();
    var genTrasBump = cfgCacheGen_();
    Logger.log('syncPublicarCacheLecturas_: el Sheet cambió SIN pasar por grant/revoke (edición a mano) — ' +
      'generación ' + gen + ' → ' + genTrasBump + ' y publicación descartada; se republica en la próxima pasada.');
    // Si el bump no llegó a subir, NO se guarda la huella: hay que volver a
    // detectarlo en la siguiente pasada en vez de darlo por hecho.
    if (genTrasBump !== gen) {
      try { PropertiesService.getScriptProperties().setProperty(CACHE_PUB_HUELLA_PROP_, JSON.stringify({ fp: huella, gen: genTrasBump })); }
      catch (eSave) { /* se vuelve a detectar en la siguiente pasada */ }
    }
    return { ok: false, error: 'sheet editado a mano', gen: gen, genAhora: genTrasBump };
  }

  // El ÁRBOL, que es el otro dato de entrada (#370): sin él no se puede
  // completar el par (S-ID, nombre) de ninguna caja. Se lee AQUÍ, antes de
  // arrancar el reloj del bucle, por la misma razón que la matriz — es
  // conseguir los datos, no construir los índices, y cobrárselo al presupuesto
  // haría que un árbol lento dejara la pasada sin publicar nada.
  //
  // Fail-closed: sin árbol NO se publica ningún censo. Publicar con medias
  // parejas es exactamente el bug que esto cierra, y un censo subconjunto
  // ACIERTA la clave — no hay miss que degrade al relay y lo salve.
  var arbol = syncArbolPorSid_(null);

  // El reloj del trabajo propio arranca AQUÍ, con la matriz ya leída: el
  // presupuesto del bucle mide lo que cuesta construir y escribir los índices, no
  // lo que costó conseguir los datos. Sin esta separación, una lectura lenta se
  // comería el presupuesto entero y el bucle rompería en la primera vuelta —cero
  // claves publicadas— justo en las pasadas que más falta hacen.
  var inicioIndices = new Date().getTime();
  // …y se acota además por lo que QUEDA de ejecución. `CACHE_PUB_BUDGET_MS_` es
  // un TECHO, no la garantía de que existan 60 s: en una pasada que ya drenó, no
  // existen. Aquí solo se reserva el tramo de ESCRITURA — el de lectura ya se ha
  // pagado y restarlo otra vez lo cobraría dos veces.
  var presupuestoBucle = CACHE_PUB_BUDGET_MS_;
  var margen = LIMITE_EJECUCION_MS_ - (inicioIndices - base) - CACHE_PUB_RESERVA_ESCRITURA_MS_;
  if (margen < presupuestoBucle) { presupuestoBucle = margen; }
  if (presupuestoBucle < CACHE_PUB_MIN_BUCLE_MS_) {
    // Se abandona en vez de entrar a un bucle que no puede dar ni una vuelta:
    // eso cerraría con `cajas=0 gestores=0 claves-escritas=0/0` y `ok:true`, que
    // se lee como "no había nada que escribir" y no como "no se escribió nada".
    // La lectura ya está pagada; lo que se evita es MENTIR en el cierre.
    Logger.log('syncPublicarCacheLecturas_: la lectura de la matriz dejó la pasada sin margen de bucle (' +
      Math.round(presupuestoBucle / 1000) + ' s) — se abandona antes de construir; se republica en la próxima.');
    return { ok: false, error: 'presupuesto tras lectura' };
  }
  var managers = cfgManagersFromValues_(values);
  var universo = cfgAllBoxKeysFromValues_(values);
  // Cada clave, a su par COMPLETO (#370). Sin esto el censo se construía con la
  // mitad del token y una caja a medio migrar publicaba un SUBCONJUNTO bajo una
  // clave que ACIERTA — sin miss que la salvara.
  var agrupado = syncGruposCenso_(universo, arbol);
  if (agrupado.ok !== true) {
    Logger.log('syncPublicarCacheLecturas_: no se pudo completar el par (S-ID, nombre) de las cajas — ' +
      'no se publica NINGÚN censo y las lecturas van por el relay. (' + agrupado.error + ')');
    return { ok: false, error: 'arbol ilegible' };
  }
  if (agrupado.huerfanos > 0) {
    Logger.log('syncPublicarCacheLecturas_: ' + agrupado.huerfanos + ' clave(s) con un S-ID que no está en el ' +
      'árbol — no se publican (el relay tampoco las serviría). Revisa las columnas E-H del Sheet de Roles.');
  }
  var at = new Date().getTime();

  // Un `salt` NUEVO por caja y por pasada. Rotarlo deja huérfana cualquier
  // entrada de censo de una pasada anterior que siga viva: ningún índice de
  // gestor la nombra, así que no hay clave con la que alcanzarla.
  var salts = {};
  var entradas = {};
  var censos = 0;      // CAJAS con censo publicado (grupos)
  var clavesCenso = 0; // ENTRADAS escritas — una caja a medio migrar tiene DOS
  var omitidosPorTamano = 0;
  var truncadoPorTiempo = false;
  var clave;

  for (var gi = 0; gi < agrupado.grupos.length; gi++) {
    if (new Date().getTime() - inicioIndices > presupuestoBucle) { truncadoPorTiempo = true; break; }
    // El grupo trae el par COMPLETO (#370) y TODAS las claves bajo las que esa
    // misma caja se puede pedir: `s:S049` (lector con S-ID) y `n:<nombre>`
    // (lector sin él). El censo se construye UNA vez y se publica bajo las dos,
    // así que las dos contestan lo mismo — y lo mismo que el relay.
    var g = agrupado.grupos[gi];
    var cuerpo = JSON.stringify({ u: cfgBoxCensusFromValues_(values, g.boxKey, g.sid), at: at });
    if (cuerpo.length > CACHE_PUB_MAX_BYTES_) {
      // Sin salt no se reparte: el gestor pedirá la clave, no la encontrará y
      // caerá al relay. Degradación de latencia, nunca de corrección.
      omitidosPorTamano++;
      continue;
    }
    // El MISMO salt para todas las claves del grupo: son la misma caja, y el
    // salt solo tiene que existir dentro de la entrada del gestor autorizado.
    var salt = Utilities.getUuid();
    var algunaClave = false;
    for (var ci = 0; ci < g.claves.length; ci++) {
      clave = g.claves[ci];
      var claveCache = cfgFastPathBoxKey_(gen, clave, salt);
      if (claveCache.length > CACHE_PUB_MAX_CLAVE_) { omitidosPorTamano++; continue; }
      salts[clave] = salt;
      entradas[claveCache] = cuerpo;
      clavesCenso++;
      algunaClave = true;
    }
    if (algunaClave) { censos++; }
  }

  // Índice de gestores. Solo la col E (KDD Champions) y el admin dan potestad:
  // `cfgManagersFromValues_` es el espejo exacto de `cfgAuthorityForEmail_`, con
  // su regla de "solo la PRIMERA fila del email" incluida (#305).
  var gestores = 0;
  var omitidosGestor = 0;
  var email;
  for (email in managers) {
    if (!Object.prototype.hasOwnProperty.call(managers, email)) { continue; }
    var m = managers[email];
    var suyas = {};
    var n = 0;
    if (m.admin === true) {
      // El admin tiene potestad sobre TODAS. Es el único caso con abanico grande
      // y por eso el único que puede no caber: si su entrada se pasa de tamaño no
      // se publica y ese admin sigue yendo por el relay, siempre.
      for (clave in salts) {
        if (!Object.prototype.hasOwnProperty.call(salts, clave)) { continue; }
        suyas[clave] = salts[clave];
        n++;
      }
    } else {
      for (clave in m.boxes) {
        if (!Object.prototype.hasOwnProperty.call(m.boxes, clave)) { continue; }
        if (!salts[clave]) { continue; }
        suyas[clave] = salts[clave];
        n++;
      }
    }
    if (n === 0) { continue; }
    var cuerpoMgr = JSON.stringify({ b: suyas, at: at });
    var claveMgr = cfgFastPathMgrKey_(gen, email);
    if (cuerpoMgr.length > CACHE_PUB_MAX_BYTES_ || claveMgr.length > CACHE_PUB_MAX_CLAVE_) { omitidosGestor++; continue; }
    entradas[claveMgr] = cuerpoMgr;
    gestores++;
  }

  // RE-COMPROBACIÓN DE GENERACIÓN. Escribir con la generación ya cambiada sería
  // inofensivo —los lectores pedirían claves de la generación nueva y estas
  // quedarían inalcanzables—, pero la pasada habría gastado su trabajo para nada
  // y nadie se enteraría. Descartar aquí lo deja dicho en el log.
  var genAhora = cfgCacheGen_();
  if (genAhora !== gen) {
    Logger.log('syncPublicarCacheLecturas_: DESCARTADA — la generación cambió durante la lectura (' +
      gen + ' → ' + genAhora + '): un grant/revoke entró por medio y esta foto ya es vieja. Se republica en la próxima pasada.');
    return { ok: false, error: 'generacion', gen: gen, genAhora: genAhora };
  }

  var claves = Object.keys(entradas);
  var escritas = 0;
  var lotesFallidos = 0;
  for (var c = 0; c < claves.length; c += CACHE_PUB_LOTE_) {
    // RELOJ TAMBIÉN AQUÍ (#334). El bucle de índices tenía presupuesto y este no,
    // así que con `CacheService` lento la ejecución podía morir a mitad del
    // `putAll` por el límite duro: publicación parcial Y —lo que de verdad
    // importa— sin llegar a guardar la huella, con lo que la siguiente pasada
    // compara contra una foto anterior y pierde EN SILENCIO la detección de
    // ediciones a mano. Cortar aquí a tiempo deja lo mismo escrito pero por un
    // camino que sí guarda la huella y sí deja constancia en el log.
    if (new Date().getTime() - base > LIMITE_EJECUCION_MS_ - CACHE_PUB_CIERRE_MS_) {
      truncadoPorTiempo = true;
      break;
    }
    var lote = {};
    var fin = Math.min(c + CACHE_PUB_LOTE_, claves.length);
    for (var d = c; d < fin; d++) { lote[claves[d]] = entradas[claves[d]]; }
    try {
      cache.putAll(lote, CFG_FASTPATH_TTL_S_);
      escritas += (fin - c);
    } catch (ePut) {
      lotesFallidos++;
      Logger.log('syncPublicarCacheLecturas_: un lote de ' + (fin - c) + ' clave(s) no se pudo escribir — ' +
        (ePut && ePut.message ? ePut.message : String(ePut)));
    }
  }

  // La huella se guarda AQUÍ, con la generación bajo la que se acaba de
  // publicar, y no antes: lo que hay que recordar es "la última foto que llegó a
  // la caché", no cualquiera que se leyera. Guardarla en un camino que descarta
  // haría que la siguiente pasada comparase contra algo que nadie publicó.
  try {
    PropertiesService.getScriptProperties().setProperty(
      CACHE_PUB_HUELLA_PROP_, JSON.stringify({ fp: huella, gen: gen }),
    );
  } catch (eHuellaSave) {
    // Sin huella guardada, la comparación de la próxima pasada se hace contra
    // una foto ANTERIOR. Si nadie más toca nada, la huella sigue coincidiendo y
    // no pasa nada; pero si entre medias la generación se mueve por un
    // grant/revoke, la condición deja de casar y la protección contra ediciones
    // A MANO se pierde EN SILENCIO hasta el siguiente guardado que sí funcione.
    // Por eso se registra: es lo único que lo delata.
    Logger.log('syncPublicarCacheLecturas_: NO se pudo guardar la huella del Sheet — hasta la próxima pasada que sí la guarde, ' +
      'una edición manual del Excel podría no invalidar la caché.');
  }

  var lectorActivo = false;
  try { lectorActivo = String(PropertiesService.getScriptProperties().getProperty('FAST_PATH_ENABLED') || '') === 'true'; }
  catch (eFlag) { lectorActivo = false; }

  Logger.log('syncPublicarCacheLecturas_: gen=' + gen +
    ' cajas=' + censos +
    // Toda caja identificada y de nombre INEQUÍVOCO se publica bajo SUS DOS
    // claves (#370, "regla 1, segunda mitad"), esté migrada o no: lo sano es el
    // doble EXACTO de `cajas`. Menos = nombre ambiguo o S-ID sin resolver — NO
    // mide lo que falta por migrar (#423).
    ' claves-censo=' + clavesCenso +
    (agrupado.huerfanos ? ' SID-HUERFANOS=' + agrupado.huerfanos : '') +
    ' gestores=' + gestores +
    ' claves-escritas=' + escritas + '/' + claves.length +
    (omitidosPorTamano ? ' cajas-omitidas-por-tamano=' + omitidosPorTamano : '') +
    (omitidosGestor ? ' GESTORES-OMITIDOS-POR-TAMANO=' + omitidosGestor : '') +
    (lotesFallidos ? ' lotes-fallidos=' + lotesFallidos : '') +
    (truncadoPorTiempo ? ' — TRUNCADA por presupuesto: faltan claves por publicar (mira `claves-escritas`)' : '') +
    ' ttl=' + CFG_FASTPATH_TTL_S_ + 's' +
    ' — lector ' + (lectorActivo ? 'ACTIVO (FAST_PATH_ENABLED=true)' : 'apagado: se publica pero nadie lee'));

  return {
    ok: true, gen: gen, cajas: censos, clavesCenso: clavesCenso,
    huerfanos: agrupado.huerfanos, gestores: gestores,
    escritas: escritas, total: claves.length,
    omitidosPorTamano: omitidosPorTamano, omitidosGestor: omitidosGestor,
    lotesFallidos: lotesFallidos, truncada: truncadoPorTiempo, lectorActivo: lectorActivo,
  };
}
