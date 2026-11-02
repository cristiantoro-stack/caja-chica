/* App Caja Chica · flujo: capturar → revisar páginas → datos del gasto → guardar en Drive y en la planilla. */
(() => {
  const VERSION = '1.8.0';
  const MAX_BYTES = 20 * 1048576;
  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const TITULOS = { inicio: 'Caja Chica', paginas: 'Páginas del documento', datos: 'Datos del gasto', listo: 'Resultado', ajustes: 'Ajustes', registro: 'Registro',
    entrega: 'Entrega de tarjeta', acta: 'Acta de la tarjeta' };
  const GASTOS = ['Desembolso MP', 'Rendición Santander'];
  // Reembolso a un colaborador que pagó con su dinero: el medio es la transferencia a su cuenta, desde MP o Santander
  const MEDIO_REEMBOLSO = { 'Desembolso MP': 'Transferencia MP', 'Rendición Santander': 'Transferencia Santander' };
  const medioPorDefecto = mov => (mov === 'Desembolso MP' ? 'Tarjeta MP' : mov === 'Rendición Santander' ? 'Tarjeta Santander' : 'Transferencia Santander');
  const CAMPOS = { fFecha: 'fecha', fMonto: 'monto', fTipo: 'tipoDoc', fNumero: 'numero', fProveedor: 'proveedor', fRazon: 'razonSocial', fRut: 'rut',
    fMedio: 'medio', fCeco: 'ceco', fDetalle: 'detalle' };
  const URL_SERVIDOR = /^https:\/\/script\.google\.com\/(a\/macros\/[\w.-]+|macros)\/s\/[\w-]+\/exec$/;
  const PREFIJO = Api.demo ? 'cc-demo.' : 'cc.';

  const est = {
    vista: 'inicio', capa: null, trasCerrar: null, dialogo: null, volviendo: false, alLlegarAlInicio: null,
    paginas: [], pdf: null, origen: null, capturadoEn: null,
    lectura: null, lecturaId: 0,
    listas: null, tarjetas: {},
    movimiento: 'Desembolso MP', categoria: '', tocados: new Set(),
    guardando: false,
    registro: null,       // ficha abierta: { registro, representacion, deshacer, cargando, error }
    edicion: null,        // corrección en curso: { id, original, representacion, reembolso, previo }
    reembolso: false,     // lo pagó un colaborador y se le transfiere (datos en el bloque "Reembolso")
    medioSinReembolso: '',  // el medio que había antes de marcar el reembolso: vuelve al desmarcarlo
    ultimo: null,         // lo recién guardado (fotos y datos), para deshacer y volver a corregir
    tira: null,           // boleta larga unida: { clave, resultado, recorte, proceso }
    modoTira: 'auto',     // 'auto': quita el traslape entre fotos; 'simple': una tras otra
    modoCamara: 'documento',
    listoActual: null,
    entrega: null,        // acta en curso: { tipo, qr, ubicacion, foto, fotoUrl, idCliente, enviando, descartar }
    custodia: [],         // en poder de quién está cada tarjeta (lo informa el servidor)
    huellasQr: {},        // huella del QR de la tarjeta → últimos 4 dígitos
    personas: [], plantillas: [], proveedores: [],   // para llenar en un toque (los entrega el servidor en config)
    plantilla: null,      // rendición frecuente aplicada a la captura en curso
    plantillaSugerida: null, verTodasPlantillas: false,
    formularioGuardado: null,   // datos del gasto recuperados del teléfono: se aplican al volver a "Datos del gasto"
    etapa: undefined      // pantalla de trabajo guardada en el teléfono, para retomarla si Android cierra la app
  };
  let cadena = Promise.resolve();      // las fotos se procesan de a una (cuida la memoria del teléfono)
  // Agregar/quitar categorías y rendiciones frecuentes: en cada lista manda la última respuesta (y config no la pisa si es anterior)
  const turnos = { categorias: 0, plantillas: 0 }, cambiadasEn = { categorias: 0, plantillas: 0 };

  // ---------- Utilidades ----------

  const esc = s => String(s === undefined || s === null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const enlaceSeguro = u => (/^https:\/\//.test(String(u || '')) ? u : '#');
  const miles = n => Math.round(Number(n) || 0).toLocaleString('es-CL');
  const clp = n => '$' + miles(n);
  const soloDigitos = s => String(s || '').replace(/\D/g, '');
  const hoyISO = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };
  const fechaCorta = iso => (iso ? `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}` : '');
  const opciones = sel => Array.from($(sel).options).map(o => o.value);
  const listas = () => est.listas || Demo.listas;
  const hayDocumento = () => !!est.pdf || est.paginas.length > 0;
  const paginasTexto = n => (n === 1 ? '1 página' : `${n} páginas`);

  function leerLocal(clave) { try { return JSON.parse(localStorage.getItem(PREFIJO + clave)); } catch (e) { return null; } }
  function guardarLocal(clave, valor) { try { localStorage.setItem(PREFIJO + clave, JSON.stringify(valor)); } catch (e) { /* sin espacio */ } }

  function aBase64(blob) {
    return new Promise((ok, mal) => {
      const r = new FileReader();
      r.onload = () => ok(String(r.result).split(',')[1]);
      r.onerror = () => mal(r.error);
      r.readAsDataURL(blob);
    });
  }

  function rutInfo(rut) {
    const l = String(rut).toUpperCase().replace(/[^0-9K]/g, '');
    if (l.length < 7) return null;
    const cuerpo = l.slice(0, -1).replace(/^0+/, ''), dv = l.slice(-1);
    if (!/^\d{6,8}$/.test(cuerpo)) return null;
    let s = 0, m = 2;
    for (let i = cuerpo.length - 1; i >= 0; i--) { s += Number(cuerpo[i]) * m; m = m === 7 ? 2 : m + 1; }
    const r = 11 - (s % 11), esperado = r === 11 ? '0' : r === 10 ? 'K' : String(r);
    return { ok: esperado === dv, texto: cuerpo.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + '-' + dv };
  }

  function toast(mensaje, ms = 3200) {
    // Durante la presentación del logo el aviso quedaría tapado: espera a que termine (como máximo unos 5 s)
    if (document.documentElement.classList.contains('con-intro') && (toast.espera || 0) < 25) {
      toast.espera = (toast.espera || 0) + 1;
      clearTimeout(toast.diferido);
      toast.diferido = setTimeout(() => toast(mensaje, ms), 200);
      return;
    }
    toast.espera = 0;
    const t = $('#toast');
    t.textContent = mensaje;
    t.classList.add('visible');
    clearTimeout(toast.reloj);
    toast.reloj = setTimeout(() => t.classList.remove('visible'), ms);
  }

  // ---------- Navegación: cada entrada del historial lleva su profundidad desde el inicio ----------

  const estadoActual = () => history.state || { vista: 'inicio', prof: 0 };
  const profundidad = () => estadoActual().prof || 0;

  function mostrar(vista) {
    if (vista !== 'datos' && est.edicion) salirEdicion();
    if (vista !== 'entrega') { clearInterval(relojDeclaracion); relojDeclaracion = null; }
    est.vista = vista;
    $$('.vista').forEach(v => v.classList.toggle('activa', v.id === 'v-' + vista));
    $('#tituloVista').textContent = vista === 'datos' && est.edicion ? 'Corregir ' + est.edicion.id : TITULOS[vista];
    $('#btnVolver').hidden = vista === 'inicio';
    $('#barraLogo').hidden = vista !== 'inicio';
    $('#btnAjustes').hidden = vista !== 'inicio';
    window.scrollTo(0, 0);
    if (vista === 'inicio') cargarInicio();
    if (vista === 'ajustes') cargarAjustes();
    if (vista === 'registro') pintarRegistro();
    if (vista === 'paginas') pintarPaginas();
    if (vista === 'entrega' && est.entrega) $('#tituloVista').textContent = est.entrega.tipo === 'Devolución' ? 'Devolución de tarjeta' : 'Entrega de tarjeta';
    if (vista === 'entrega') pintarPersonasActa();
    guardarEtapa(['paginas', 'datos', 'entrega'].includes(vista) && !(vista === 'datos' && est.edicion) ? vista : null);
  }

  function ir(vista) {
    history.pushState({ vista, prof: profundidad() + 1 }, '');
    mostrar(vista);
  }

  /** Vuelve al inicio sacando del historial las pantallas intermedias; "despues" corre al llegar. */
  function volverInicio(despues) {
    const prof = profundidad();
    if (prof > 0) {
      est.volviendo = true;
      est.alLlegarAlInicio = despues || null;
      history.go(-prof);
    } else {
      mostrar('inicio');
      if (despues) despues();
    }
  }

  function abrirCapa(nombre) {
    est.capa = nombre;
    history.pushState({ vista: est.vista, prof: profundidad() + 1, capa: nombre }, '');
  }

  function cerrarCapa(despues) {
    est.trasCerrar = despues || null;
    est.cerrandoCapa = !!est.capa;                     // lo cierra la app (no el "atrás" del teléfono)
    if (est.capa) history.back();
  }

  function cerrarCapaSinHistorial() {
    if (est.capa === 'camara') detenerCamara();
    if (est.capa === 'qr') detenerQr();
    if (est.capa === 'editor') ocultarEditor();
    if (est.capa === 'tira') ocultarTira();
    if (est.capa === 'vista') ocultarVista();
    est.capa = null;
  }

  /**
   * Diálogo de confirmación. El botón "atrás" equivale a cancelar.
   * Con campo ({ placeholder }) pide un texto obligatorio y responde ese texto (o false si se cancela).
   */
  function preguntar(titulo, texto, si = 'Aceptar', no = 'Cancelar', campo = null) {
    return new Promise(ok => {
      const previo = document.activeElement, area = $('#dialogoCampo');
      let resultado = false;
      $('#dialogoTitulo').textContent = titulo;
      $('#dialogoTexto').textContent = texto;
      $('#dialogoSi').textContent = si;
      $('#dialogoNo').textContent = no || '';
      $('#dialogoNo').hidden = !no;
      area.hidden = !campo;
      area.value = campo && campo.valor ? campo.valor : '';
      area.classList.remove('invalido');
      area.placeholder = campo ? campo.placeholder || '' : '';
      const opcion = $('#dialogoOpcion'), conOpciones = !!(campo && campo.opciones);
      $('#dialogoOpcionCampo').hidden = !conOpciones;
      if (conOpciones) {
        $('#dialogoOpcionEtiqueta').textContent = campo.etiquetaOpcion || '';
        opcion.innerHTML = campo.opciones.map(o => `<option value="${esc(o.valor)}">${esc(o.texto)}</option>`).join('');
        opcion.value = campo.opcion || '';
      }
      est.dialogo = () => {
        $('#dialogo').hidden = true;
        area.hidden = true;
        $('#dialogoOpcionCampo').hidden = true;
        $('#dialogoSi').onclick = $('#dialogoNo').onclick = null;
        if (previo && previo.focus) previo.focus();
        ok(resultado);
      };
      let respondido = false;                       // un doble toque no debe retroceder dos veces
      const responder = v => {
        if (respondido) return;
        if (v && campo) {
          v = area.value.trim();
          if (!v) { area.classList.add('invalido'); area.focus(); return; }
          if (conOpciones) v = { texto: v, opcion: opcion.value };
        }
        respondido = true;
        resultado = v;
        history.back();
      };
      $('#dialogoSi').onclick = () => responder(true);
      $('#dialogoNo').onclick = () => responder(false);
      $('#dialogo').hidden = false;
      history.pushState({ vista: est.vista, prof: profundidad() + 1, dialogo: true }, '');
      (campo ? area : $('#dialogoSi')).focus();
    });
  }

  window.addEventListener('popstate', e => {
    const st = e.state || { vista: 'inicio', prof: 0 };
    if (est.volviendo) {
      est.volviendo = false;
      cerrarCapaSinHistorial();
      mostrar('inicio');
      const despues = est.alLlegarAlInicio;
      est.alLlegarAlInicio = null;
      if (despues) despues();
      return;
    }
    if (est.dialogo) {
      const cerrar = est.dialogo;
      est.dialogo = null;
      cerrar();
      return;
    }
    if (est.capa === 'editor' && ed && ed.previa && !est.cerrandoCapa) {
      ocultarPreviaEditor();
      history.pushState({ vista: est.vista, prof: (st.prof || 0) + 1, capa: 'editor' }, '');
      return;
    }
    if (est.capa) {
      est.cerrandoCapa = false;
      const capa = est.capa, deActa = capa === 'camara' && camara && camara.destino === 'acta';
      cerrarCapaSinHistorial();
      let siguiente = est.trasCerrar;
      est.trasCerrar = null;
      if (capa === 'camara' && !deActa && !siguiente && est.paginas.length) siguiente = 'paginas';   // "atrás" con fotos tomadas
      if (typeof siguiente === 'function') { siguiente(); return; }
      if (siguiente === 'inicio') volverInicio();
      else if (siguiente && siguiente !== est.vista) ir(siguiente);
      else if (est.vista === 'paginas') pintarPaginas();
      return;
    }
    if (est.guardando) {
      history.pushState({ vista: est.vista, prof: (st.prof || 0) + 1 }, '');
      toast('Espera a que termine de guardar');
      return;
    }
    let v = st.vista || 'inicio';
    // Salir de un acta a medio llenar no pierde nada: queda como borrador y el inicio ofrece seguirla
    if (est.vista === 'entrega' && v !== 'entrega') soltarEntrega();
    if (est.vista === 'listo' || v === 'listo' || est.vista === 'acta' || v === 'acta' || (v === 'datos' && !hayDocumento() && !est.edicion)
      || (v === 'paginas' && !est.paginas.length) || (v === 'registro' && !est.registro) || (v === 'entrega' && !est.entrega)) {
      if ((st.prof || 0) > 0) { volverInicio(); return; }
      v = 'inicio';
    }
    mostrar(v);
  });

  // ---------- Inicio ----------

  function cargarInicio() {
    $('#avisoConfig').hidden = Api.configurada();
    pintarCola();
    revisarSesion();
    revisarBorrador();
    const previo = leerLocal('resumen');
    if (previo) pintarResumen(previo);
    refrescarResumen(false);
  }

  async function refrescarResumen(avisar) {
    if (!Api.configurada()) return;
    try {
      const r = await Api.llamar('resumen');
      guardarLocal('resumen', r);
      pintarResumen(r);
      if (avisar) toast('Actualizado');
    } catch (e) {
      if (avisar || e.codigo === 'clave') toast(e.message, 5000);
    }
  }

  function pintarResumen(r) {
    const m = r.mes || {}, partes = String(m.mes || '').split('-');
    $('#kpiMes').textContent = partes[1] ? `${MESES[Number(partes[1]) - 1]} ${partes[0]}` : 'Este mes';
    $('#kpiMonto').textContent = clp(m.desembolsos || 0);
    $('#kpiDocs').textContent = m.documentos || 0;
    $('#kpiTarjeta').textContent = m.conTarjeta ? `${m.tarjetaOk}/${m.conTarjeta}` : '—';
    $('#kpiSaldo').textContent = clp(r.saldo || 0);
    pintarLista(r.ultimos || []);
    $('#btnVerMas').hidden = !r.ultimos || r.ultimos.length < 5;
    if (r.custodia) pintarCustodia(r.custodia);
    if (r.huellasQr) guardarHuellas(r.huellasQr);
    const planilla = enlaceSeguro(r.planillaUrl);
    $('#lnkPlanilla').hidden = planilla === '#';
    if (planilla !== '#') $('#lnkPlanilla').href = planilla;
  }

  const claseEstado = estado => ({ 'Conciliado': 'ok', 'Observado': 'alerta', 'Pendiente revisión': 'pendiente' }[estado] || '');

  function pintarLista(filas) {
    const ul = $('#ultimos');
    ul.innerHTML = '';
    $('#ayudaLista').hidden = !filas.length;
    if (!filas.length) {
      ul.innerHTML = '<li class="lista-vacia">Aún no hay registros este año</li>';
      return;
    }
    filas.forEach(f => {
      const li = document.createElement('li'), b = document.createElement('button');
      b.type = 'button';
      b.className = 'fila-registro';
      b.innerHTML = `<span class="lista-prov">${esc(f.proveedor || f.detalle || f.movimiento || f.id)}</span>
        <span class="lista-monto">${clp(f.monto)}</span>
        <span class="lista-sub">${esc(fechaCorta(f.fecha))} · ${esc(f.id)}</span>
        <span class="chip ${claseEstado(f.estado)}">${esc(f.estado || '')}</span>`;
      b.onclick = () => abrirRegistro(f);
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  async function verMas() {
    const b = $('#btnVerMas');
    b.disabled = true;
    try {
      const r = await Api.llamar('historial', { n: 60 });
      pintarLista(r.filas || []);
      b.hidden = true;
    } catch (e) {
      toast(e.message, 5000);
    } finally {
      b.disabled = false;
    }
  }

  async function pintarCola() {
    let items = [];
    try { items = await Api.pendientes(); } catch (e) { /* sin IndexedDB */ }
    const bloqueados = items.filter(i => (i.intentos || 0) >= 3);
    $('#avisoCola').hidden = !items.length;
    $('#btnDescartarCola').hidden = !bloqueados.length;
    // Un acta guardada en el teléfono ya cambia de manos la tarjeta en el inicio ("pendiente de envío")
    pintarCustodia(est.custodia, items.filter(i => i.accion === 'entregarTarjeta').map(i => i.payload));
    if (!items.length) return;
    const actas = items.filter(i => i.accion === 'entregarTarjeta').length, docs = items.length - actas;
    const que = [actas ? plural(actas, 'acta', 'actas') : '', docs ? plural(docs, 'documento', 'documentos') : ''].filter(Boolean).join(' y ');
    $('#textoCola').textContent = bloqueados.length
      ? `${bloqueados.length === 1 ? '1 envío no se pudo hacer' : bloqueados.length + ' envíos no se pudieron hacer'}: ${bloqueados[0].ultimoError || 'error del servidor'}`
      : `${que} esperando conexión`;
  }

  /** Botón "Enviar" del aviso de la cola: si hay documentos que parecen repetidos, pregunta antes de guardarlos. */
  async function enviarColaManual() {
    const repetidos = (await Api.pendientes()).filter(i => i.duplicado);
    let guardarRepetidos = false;
    if (repetidos.length) {
      guardarRepetidos = await preguntar('¿Guardar igual?', `${repetidos.length === 1 ? 'Un documento' : repetidos.length + ' documentos'} en espera ${repetidos.length === 1 ? 'parece repetido' : 'parecen repetidos'}: ${repetidos[0].ultimoError}.`, 'Guardar igual', 'No');
    }
    enviarCola(false, true, guardarRepetidos);
  }

  async function enviarCola(silencioso, incluirBloqueados, guardarRepetidos) {
    if (Api.demo) return;
    if (!Api.configurada() || !navigator.onLine) {
      if (!silencioso) toast(Api.configurada() ? 'Sin conexión a internet' : 'Primero vincula la app en Ajustes');
      return;
    }
    const n = await Api.enviarCola((r, item, e) => {
      if (r) toast(`${r.id} ${item.accion === 'entregarTarjeta' ? 'registrada' : 'enviado a Drive'}`);
      else if (e && e.datos && e.datos.duplicado) toast(`Ya estaba registrado como ${e.datos.duplicado.id}`);
    }, incluirBloqueados, guardarRepetidos);
    await pintarCola();
    if (n) refrescarResumen(false);
  }

  async function descartarBloqueados() {
    const bloqueados = (await Api.pendientes()).filter(i => (i.intentos || 0) >= 3);
    if (!bloqueados.length) return;
    const p = bloqueados[0].payload || {}, d = p.datos;
    const detalle = d ? `${d.proveedor || d.detalle || 'documento'} · ${clp(d.monto)}`
      : p.tarjeta ? `acta de ${p.tipo === 'Devolución' ? 'devolución' : 'entrega'} de la tarjeta ****${p.tarjeta.ultimos4}` : 'documento';
    const si = await preguntar('Descartar sin enviar', `Se borrará del teléfono sin llegar a Drive: ${detalle}${bloqueados.length > 1 ? ` y ${bloqueados.length - 1} más` : ''}. ¿Seguro?`, 'Descartar', 'Cancelar');
    if (!si) return;
    for (const b of bloqueados) await Api.descartar(b.id);
    pintarCola();
  }

  function revisarSesion() {
    const n = est.paginas.length;
    $('#avisoSesion').hidden = !hayDocumento() || est.vista !== 'inicio';
    if (hayDocumento()) $('#textoSesion').textContent = `Tienes una captura sin terminar (${n ? paginasTexto(n) : 'PDF'}).`;
  }

  /** Recupera una captura guardada en el teléfono (por ejemplo, si el sistema cerró Chrome). */
  async function restaurarSesion() {
    let s = null, f = null;
    try { s = await DB.leer('sesion', 'actual'); f = await DB.leer('sesion', 'formulario'); } catch (e) { s = null; }
    if (!s || est.paginas.length || est.pdf) return;
    if (s.pdf && s.pdf.blob) est.pdf = { blob: s.pdf.blob, nombre: s.pdf.nombre };
    else if (!s.paginas || !s.paginas.length) return;
    est.paginas = (est.pdf ? [] : s.paginas).map(p => Object.assign({}, p, { miniUrl: URL.createObjectURL(p.mini) }));
    est.formularioGuardado = f && f.valores ? f : null;
    est.origen = s.origen;
    est.capturadoEn = s.capturadoEn;
    est.modoTira = s.modoTira || 'auto';
    $('#chkUnir').checked = !!s.unir;
  }

  // ---------- Retomar donde quedó: la pantalla de trabajo y lo escrito se guardan en el teléfono ----------
  // Si Android cierra la app (por ejemplo, al abrir otra), al volver sigue en la misma pantalla y con los mismos datos.

  let relojFormulario = null;

  async function leerEtapa() {
    try {
      const e = await DB.leer('sesion', 'etapa');
      return e && e.vista && Date.now() - (e.guardado || 0) < 3 * 3600000 ? e.vista : null;   // más antigua: la ofrece el inicio
    } catch (e) {
      return null;
    }
  }

  async function guardarEtapa(vista) {
    if (est.etapa === vista) return;
    est.etapa = vista;
    try { if (vista) localStorage.setItem('cc.trabajando', '1'); else localStorage.removeItem('cc.trabajando'); } catch (e) { /* sin espacio */ }
    try {
      if (vista) await DB.guardar('sesion', 'etapa', { vista, guardado: Date.now() });
      else await DB.borrar('sesion', 'etapa');
    } catch (e) { /* sin IndexedDB: solo no se retoma sola */ }
  }

  /** Al abrir la app: vuelve a la pantalla en que estaba si Android la cerró. */
  async function retomarEtapa(vista) {
    if (vista === 'entrega') {
      const b = await leerBorrador();
      if (b && est.vista === 'inicio') { abrirEntrega(b.tipo, b); toast('Seguimos con el acta que estabas llenando'); }
      return;
    }
    if (hayDocumento() && est.vista === 'inicio') { retomarCaptura(vista); toast('Seguimos donde quedaste'); }
  }

  /** Seguir la captura: a "Datos del gasto" si ya se estaban llenando (o es un PDF); si no, a las páginas. */
  function retomarCaptura(vista) {
    $('#avisoSesion').hidden = true;
    if (est.pdf || vista === 'datos' || (!vista && est.formularioGuardado)) { entrarDatos(); return; }
    pintarPaginas();
    ir('paginas');
  }

  /** Entra a "Datos del gasto": aplica lo guardado en el teléfono (si Android cerró la app) o lee el documento. */
  function entrarDatos() {
    ir('datos');
    prepararDatos();
    const f = est.formularioGuardado;
    est.formularioGuardado = null;
    if (f) aplicarFormularioGuardado(f);
    if (f && f.lectura && f.paginasClave === clavePaginas()) {
      est.lectura = f.lectura;
      pintarLectura(f.lectura.sugeridos && f.lectura.sugeridos.fecha ? 'ok' : 'ok-sin-fecha');
      pintarControlTarjeta();
      revisarMonto();
    } else {
      leerDocumento();
    }
  }

  /** Identifica el documento en curso (páginas y sus ediciones, o el PDF): una lectura guardada vale solo para el mismo. */
  const clavePaginas = () => (est.pdf ? 'pdf:' + est.pdf.nombre + ':' + est.pdf.blob.size : est.paginas.map(p => p.id + ':' + (p.version || 0)).join('|'));

  /** Cambiaron las páginas: la lectura anterior (también la guardada en el teléfono) ya no sirve. */
  function olvidarLectura() {
    est.lectura = null;
    if (est.formularioGuardado) est.formularioGuardado.lectura = null;
  }

  function formularioActual() {
    const valores = {};
    IDS_FORMULARIO.forEach(id => { valores[id] = document.getElementById(id).value; });
    return {
      valores, categoria: est.categoria, movimiento: est.movimiento, tocados: Array.from(est.tocados), plantilla: est.plantilla,
      sugeridos: IDS_FORMULARIO.filter(id => document.getElementById(id).classList.contains('sugerido')), lectura: est.lectura,
      provAplicado: est.provAplicado || null, plantillaAplicada: est.plantillaAplicada || null, reembolso: !!est.reembolso,
      medioSinReembolso: est.medioSinReembolso || '',
      paginasClave: clavePaginas()
    };
  }

  /** Lo escrito en "Datos del gasto" se guarda poco después de cada cambio (no durante una corrección). */
  function tocarFormulario() {
    if (est.edicion || est.vista !== 'datos' || !hayDocumento()) return;
    clearTimeout(relojFormulario);
    relojFormulario = setTimeout(guardarFormulario, 600);
  }

  async function guardarFormulario() {
    clearTimeout(relojFormulario);
    relojFormulario = null;
    if (est.edicion || !hayDocumento()) return;
    try { await DB.guardar('sesion', 'formulario', Object.assign(formularioActual(), { guardado: Date.now() })); } catch (e) { /* sin espacio */ }
  }

  function aplicarFormularioGuardado(f) {
    est.movimiento = f.movimiento || 'Desembolso MP';
    est.tocados = new Set(f.tocados || []);
    est.plantilla = f.plantilla || null;
    est.provAplicado = f.provAplicado || null;
    est.plantillaAplicada = f.plantillaAplicada || null;
    est.reembolso = !!f.reembolso;
    est.medioSinReembolso = f.medioSinReembolso || '';
    elegirMovimiento(est.movimiento);
    const v = f.valores || {};
    IDS_FORMULARIO.forEach(id => {
      if (v[id] === undefined) return;
      const el = document.getElementById(id);
      if (el.tagName === 'SELECT' && v[id] && !opciones('#' + id).includes(v[id])) el.insertAdjacentHTML('beforeend', `<option>${esc(v[id])}</option>`);
      el.value = v[id];
    });
    (f.sugeridos || []).forEach(id => document.getElementById(id).classList.add('sugerido'));
    est.categoria = f.categoria || '';
    pintarCategorias();
    validarRut();
    validarCeco();
    pintarReembolso();
    validarReRut();
    pintarControlTarjeta();
    pintarPlantillas();
  }

  /** Al salir de la app: lo que esperaba su medio segundo se guarda de inmediato. */
  function guardarPendientes() {
    if (relojFormulario) guardarFormulario();
    if (relojBorrador && est.entrega) guardarBorrador();
  }

  // ---------- Captura ----------

  function liberar(p) {
    if (p.miniUrl) URL.revokeObjectURL(p.miniUrl);
    if (p.guia) URL.revokeObjectURL(p.guia);
    p.miniUrl = p.guia = p.guiaProceso = null;
    p.liberada = true;
  }

  function nuevaCaptura() {
    soltarUltimo();
    est.paginas.forEach(liberar);
    Object.assign(est, { paginas: [], pdf: null, origen: null, capturadoEn: null, lectura: null, categoria: '', movimiento: 'Desembolso MP',
      tira: null, modoTira: 'auto', modoCamara: 'documento', plantilla: null, plantillaSugerida: null, verTodasPlantillas: false,
      formularioGuardado: null, provAplicado: null, plantillaAplicada: null, reembolso: false, medioSinReembolso: '' });
    est.tocados = new Set();
    est.lecturaId++;
    $('#chkUnir').checked = false;
    mostrarTiraEn(null);
    limpiarFormulario();
    clearTimeout(relojFormulario);
    relojFormulario = null;
    DB.borrar('sesion', 'actual').catch(() => {});
    DB.borrar('sesion', 'formulario').catch(() => {});
  }

  /** Suelta lo recién guardado (ya no se ofrecerá volver a corregirlo con las mismas fotos). */
  function soltarUltimo() {
    const u = est.ultimo;
    est.ultimo = null;
    if (u && u.paginas) u.paginas.forEach(liberar);
  }

  async function descartarSiHay() {
    if (!hayDocumento()) return true;
    const n = est.paginas.length;
    return preguntar('Captura sin terminar', n ? `¿Descartar ${n === 1 ? 'la página capturada' : `las ${n} páginas capturadas`}?` : '¿Descartar el PDF sin guardar?', 'Descartar', 'Conservar');
  }

  function agregarFoto(blob, origen, captura) {
    const p = { id: 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), rot: 0, modo: 'documento', procesando: true,
      captura: captura || { via: origen } };
    est.paginas.push(p);
    est.origen = est.origen || origen;
    est.capturadoEn = est.capturadoEn || new Date().toISOString();
    olvidarLectura();
    if (!est.etapa) guardarEtapa('paginas');          // la cámara se abrió desde el inicio: si Android cierra la app, se vuelve aquí
    pintarPaginas();
    pintarContador();
    cadena = cadena.then(async () => {
      try {
        const fuente = await Escaner.cargar(blob);
        // La foto de la cámara se guarda tal cual (sin volver a comprimirla) si no hubo que achicarla
        p.fuente = fuente.original && blob.type === 'image/jpeg' ? blob : await Escaner.aJpeg(fuente, 0.92);
        p.quad = Escaner.detectar(fuente) || Escaner.COMPLETA;
        Object.assign(p, await Escaner.procesar(fuente, p));
        p.miniUrl = URL.createObjectURL(p.mini);
        p.version = 1;
        if (!est.paginas.includes(p)) liberar(p);       // se descartó la captura mientras se procesaba
      } catch (e) {
        est.paginas = est.paginas.filter(x => x !== p);
        toast(e.message || 'No se pudo leer la imagen');
      }
      p.procesando = false;
      pintarPaginas();
      pintarContador();
      pintarGuia();
      guardarSesion();
      unirPaginas();
    });
    return cadena;
  }

  function tomarArchivos(evento, origen) {
    const archivos = Array.from(evento.target.files || []);
    evento.target.value = '';
    if (!archivos.length) return;
    if (est.vista !== 'paginas') ir('paginas');
    archivos.forEach(f => agregarFoto(f, origen));
  }

  function usarPdf(blob, nombre, origen) {
    if (blob.size > MAX_BYTES) { toast('El PDF supera 20 MB: pide una versión más liviana', 5000); return; }
    est.pdf = { blob, nombre };
    est.origen = origen;
    est.capturadoEn = new Date().toISOString();
    guardarSesion();
    entrarDatos();
  }

  async function guardarSesion() {
    const listas = est.paginas.filter(p => !p.procesando && p.salida);
    try {
      if (!listas.length && !est.pdf) { await DB.borrar('sesion', 'actual'); return; }
      await DB.guardar('sesion', 'actual', {
        paginas: listas.map(p => ({ id: p.id, fuente: p.fuente, quad: p.quad, rot: p.rot, modo: p.modo, salida: p.salida, mini: p.mini, ancho: p.ancho, alto: p.alto,
          version: p.version, captura: p.captura || null })),
        pdf: est.pdf ? { blob: est.pdf.blob, nombre: est.pdf.nombre } : null,
        origen: est.origen, capturadoEn: est.capturadoEn, unir: $('#chkUnir').checked, modoTira: est.modoTira
      });
    } catch (e) { /* sin espacio en el teléfono: la captura sigue en memoria */ }
  }

  function pintarPaginas() {
    const cont = $('#paginas');
    cont.innerHTML = '';
    est.paginas.forEach((p, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'pagina' + (p.procesando ? ' procesando' : '');
      b.setAttribute('aria-label', `Página ${i + 1}: ver como quedará`);
      b.innerHTML = (p.miniUrl ? `<img src="${p.miniUrl}" alt="">` : '') + `<span class="pagina-num">${i + 1}</span>`;
      b.onclick = () => { if (!p.procesando) abrirVista(p); };
      cont.appendChild(b);
    });
    $('#filaUnir').hidden = est.paginas.length < 2;
    pintarBotonesVista();
    const ocupado = est.paginas.some(p => p.procesando), n = est.paginas.length;
    $('#btnContinuar').disabled = !n || ocupado;
    $('#btnContinuar').textContent = ocupado ? 'Procesando…' : `Continuar (${paginasTexto(n)})`;
    pintarTira();
  }

  // ---------- Boleta larga: fotos de cerca unidas en una sola imagen ----------

  let urlTira = null, blobTira = null;
  const claveTira = () => est.modoTira + '|' + est.paginas.map(p => p.id + ':' + (p.version || 0)).join('|');
  const tiraLista = () => !!(est.tira && est.tira.resultado && est.tira.clave === claveTira());
  const tiraActiva = () => $('#chkUnir').checked && est.paginas.length > 1 && !est.pdf;

  /** Muestra la tira (miniatura y vista completa) con una sola URL viva; null la suelta. */
  function mostrarTiraEn(blob) {
    if (blob === blobTira) return;
    if (urlTira) URL.revokeObjectURL(urlTira);
    blobTira = blob || null;
    urlTira = blob ? URL.createObjectURL(blob) : null;
    ['#tiraMini', '#tiraImg'].forEach(s => { if (urlTira) $(s).src = urlTira; else $(s).removeAttribute('src'); });
  }

  /**
   * Une las páginas (si está activada la boleta larga). Devuelve la tira lista o null. Una sola unión a la vez,
   * nunca con la cámara abierta (la foto siguiente tiene prioridad); al cerrarla, la vista de páginas la pide.
   */
  function unirPaginas() {
    if (!tiraActiva() || est.paginas.some(p => p.procesando) || est.capa === 'camara') { pintarTira(); return Promise.resolve(null); }
    const clave = claveTira();
    if (est.tira && est.tira.clave === clave) return est.tira.resultado || est.tira.fallo ? Promise.resolve(est.tira.resultado ? est.tira : null) : est.tira.proceso;
    const t = { clave, resultado: null, recorte: null, proceso: null, fallo: false };
    est.tira = t;
    pintarTira();
    const paginas = est.paginas.map(p => ({ salida: p.salida, ancho: p.ancho, alto: p.alto, clave: p.id + ':' + (p.version || 0) }));
    t.proceso = cadena = cadena.then(async () => {
      if (est.tira !== t) return null;
      try {
        const r = await Escaner.unirTira(paginas, { modo: est.modoTira, cancelado: () => est.tira !== t });
        if (!r || est.tira !== t) return null;
        t.resultado = r;
        // Por defecto solo se recortan los costados (la mesa): arriba y abajo se ajustan a mano en "Ver entera"
        const s = r.recorteSugerido || {};
        t.recorte = { x0: s.x0 || 0, y0: 0, x1: s.x1 === undefined ? 1 : s.x1, y1: 1 };
      } catch (e) {
        if (est.tira === t) t.fallo = true;           // no se reintenta sola: cambia al tocar las fotos
        toast('No se pudieron unir las fotos: ' + (e.message || 'error'), 5000);
        return null;
      } finally {
        pintarTira();
      }
      return t;
    });
    return t.proceso;
  }

  function pintarTira() {
    const n = est.paginas.length, activa = tiraActiva();
    $('#tiraVista').hidden = !activa;
    if (!activa) return;
    const lista = tiraLista(), r = lista && est.tira.resultado, procesando = est.paginas.some(p => p.procesando);
    const fallo = est.tira && est.tira.clave === claveTira() && est.tira.fallo;
    // Recuperada la captura o cerrada la cámara: si falta la unión, se pide ahora
    if (!lista && !fallo && !procesando && est.capa !== 'camara' && !(est.tira && est.tira.clave === claveTira())) { unirPaginas(); return; }
    const uniones = r ? r.uniones || [] : [];
    const fallidas = uniones.filter(u => !u.ok).length, dudosas = uniones.filter(u => u.ok && u.dudosa).length;
    $('#btnRevisarTira').disabled = !lista;
    mostrarTiraEn(lista ? r.salida : null);
    const texto = $('#tiraEstado');
    texto.classList.toggle('alerta', fallidas + dudosas > 0 || !!fallo);
    texto.textContent = fallo ? 'No se pudieron unir: borra o repite alguna foto'
      : !lista ? (procesando || est.capa === 'camara' ? 'Se unirán al terminar las fotos' : `Uniendo ${n} fotos…`)
        : est.modoTira === 'simple' ? `${n} fotos, una tras otra`
          : fallidas ? `${fallidas === 1 ? 'En una unión' : `En ${fallidas} uniones`} no se encontró el traslape (quedan una tras otra): revísala`
            : dudosas ? `${n} fotos unidas: revisa ${dudosas === 1 ? 'una unión' : dudosas + ' uniones'} en "Ver entera"`
              : `${n} fotos unidas sin repetir líneas`;
  }

  // Vista completa con recorte del perímetro
  let tiraEd = null;

  async function abrirTira() {
    const t = await unirPaginas();
    if (!t || !t.resultado || est.capa) return;
    tiraEd = { recorte: Object.assign({}, t.recorte), borde: null };
    if (urlTira) $('#tiraImg').src = urlTira;
    $('#capaTira').hidden = false;
    abrirCapa('tira');
    pintarTiraEditor();
  }

  function ocultarTira() {
    $('#capaTira').hidden = true;
    tiraEd = null;
  }

  function pintarTiraEditor() {
    if (!tiraEd || !est.tira || !est.tira.resultado) return;
    const r = tiraEd.recorte, m = $('#tiraMarco'), fallidas = (est.tira.resultado.uniones || []).filter(u => !u.ok || u.dudosa).length;
    m.style.left = (r.x0 * 100) + '%';
    m.style.top = (r.y0 * 100) + '%';
    m.style.width = ((r.x1 - r.x0) * 100) + '%';
    m.style.height = ((r.y1 - r.y0) * 100) + '%';
    const info = $('#tiraInfo');
    info.classList.toggle('alerta', fallidas > 0 && est.modoTira === 'auto');
    info.textContent = fallidas && est.modoTira === 'auto'
      ? 'Revisa las uniones: si falta o sobra una línea, toma de nuevo esa foto repitiendo 4–5 líneas de la anterior.'
      : 'Arrastra los bordes dorados para recortar.';
    $('#tiraModoTexto').textContent = est.modoTira === 'auto' ? 'Una tras otra' : 'Unión automática';
  }

  async function cambiarModoTira() {
    est.modoTira = est.modoTira === 'auto' ? 'simple' : 'auto';
    guardarSesion();
    $('#tiraInfo').textContent = 'Uniendo…';
    const t = await unirPaginas();
    if (!t || !tiraEd) return;
    tiraEd.recorte = Object.assign({}, t.recorte);
    pintarTiraEditor();
  }

  function moverBordeTira(e) {
    if (!tiraEd || !tiraEd.borde) return;
    const caja = $('#tiraEscena').getBoundingClientRect(), lienzo = $('#tiraLienzo'), r = tiraEd.recorte;
    const x = Math.min(1, Math.max(0, (e.clientX - caja.left) / caja.width));
    const y = Math.min(1, Math.max(0, (e.clientY - caja.top) / caja.height));
    const minX = 0.08, minY = Math.min(0.5, 60 / caja.height);
    if (tiraEd.borde === 'x0') r.x0 = Math.min(x, r.x1 - minX);
    if (tiraEd.borde === 'x1') r.x1 = Math.max(x, r.x0 + minX);
    if (tiraEd.borde === 'y0') r.y0 = Math.min(y, r.y1 - minY);
    if (tiraEd.borde === 'y1') r.y1 = Math.max(y, r.y0 + minY);
    // Cerca del borde de la pantalla se desplaza la vista (boletas más largas que la pantalla)
    const vista = lienzo.getBoundingClientRect();
    if (e.clientY < vista.top + 48) lienzo.scrollTop -= 14;
    else if (e.clientY > vista.bottom - 48) lienzo.scrollTop += 14;
    pintarTiraEditor();
  }

  // Guía de la cámara en modo boleta larga: el final de la foto anterior, para repetir esas líneas
  /** Guía de la cámara en boleta larga: una sola imagen por página (dos llamadas seguidas no crean dos). */
  async function pintarGuia() {
    const guia = $('#camaraGuia'), ultima = est.paginas[est.paginas.length - 1];
    if (est.modoCamara !== 'tramos' || !ultima || !ultima.salida) { guia.hidden = true; return; }
    try {
      if (!ultima.guiaProceso) ultima.guiaProceso = crearGuia(ultima);
      const url = await ultima.guiaProceso;
      if (!url || ultima !== est.paginas[est.paginas.length - 1]) return;
      $('#camaraGuiaImg').src = url;
      guia.hidden = est.modoCamara !== 'tramos';
    } catch (e) { guia.hidden = true; }
  }

  /** Las últimas líneas con texto de la página (no el margen en blanco del final): unas 4–5 líneas de la boleta. */
  async function crearGuia(p) {
    const bmp = await createImageBitmap(p.salida), w = 360, h = Math.max(8, Math.round(bmp.height * w / bmp.width));
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    const desde = Math.floor(h / 2), px = ctx.getImageData(0, desde, w, h - desde).data;
    let fin = h;
    for (let y = h - desde - 1; y >= 0; y--) {
      let oscuros = 0;
      for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11 < 110) oscuros++; }
      if (oscuros > w * 0.01) { fin = Math.min(h, desde + y + 8); break; }
    }
    const alto = Math.max(8, Math.min(Math.round(h * 0.25), Math.round(w * 0.35))), inicio = Math.max(0, fin - alto);
    const g = document.createElement('canvas');
    g.width = w;
    g.height = fin - inicio;
    g.getContext('2d').drawImage(c, 0, inicio, w, g.height, 0, 0, w, g.height);
    const blob = await Escaner.aJpeg(g, 0.8);
    if (p.liberada) return null;                         // la página se borró mientras tanto
    p.guia = URL.createObjectURL(blob);
    return p.guia;
  }

  function elegirModoCamara(modo) {
    est.modoCamara = modo;
    $$('.camara-modos button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.modo === modo)));
    pintarAyudaCamara(camara && camara.oscuro ? 'luz' : null);
    if (modo === 'tramos' && !$('#chkUnir').checked) {
      $('#chkUnir').checked = true;
      guardarSesion();
    }
    pintarGuia();
  }

  // ---------- Cámara dentro de la app ----------
  //
  // La foto sale del video en vivo, ya enfocado y con la luz ajustada, a la resolución más alta que entregue la cámara
  // (hasta ~12 MP). Al tocar el botón se espera a que el teléfono quede quieto (giroscopio) y de esa ráfaga corta se
  // guarda el cuadro más nítido (Estabilizador). Antes la foto se pedía aparte y en Android llegaba 1–2 s después del
  // toque, cuando la mano ya se había movido. Si la cámara solo entrega video de baja resolución se usa la foto
  // completa, con el aviso "no muevas el teléfono" hasta que llega. "Cámara del teléfono" abre la de Android.

  let flujo = null, captura = null, linterna = false, abriendoCamara = false, camara = null, relojCamara = null;
  const VIDEO_BAJO = 3e6;          // bajo ~3 MP por cuadro conviene la foto completa del teléfono

  /** destino: 'documento' (páginas de la boleta) o 'acta' (una foto del momento de la entrega). */
  async function abrirCamara(destino = 'documento') {
    if (abriendoCamara || flujo) return;
    const nativa = destino === 'acta' ? '#inFotoEntrega' : '#inCamaraNativa';
    if (leerLocal('camaraNativa') || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { $(nativa).click(); return; }
    abriendoCamara = true;
    try {
      try {
        // 4:3 a ~12 MP (el sensor completo); si no existe, la cámara entrega la resolución más cercana
        flujo = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } }
        });
      } catch (e) {
        toast(e.name === 'NotAllowedError' ? 'Sin permiso de cámara: se abre la cámara del teléfono' : 'Se abre la cámara del teléfono');
        $(nativa).click();
        return;
      }
      const video = $('#video');
      video.srcObject = flujo;
      try { await video.play(); } catch (e) { /* se reintenta al tocar */ }
      const pista = flujo.getVideoTracks()[0];
      pista.onended = () => { if (est.capa === 'camara') cerrarCapa(); };   // otra app tomó la cámara
      captura = 'ImageCapture' in window ? new ImageCapture(pista) : null;
      const cap = pista.getCapabilities ? pista.getCapabilities() : {};
      camara = { destino, cap, oscuro: false };
      linterna = false;
      $('#btnFlash').hidden = !cap.torch;
      $('#btnFlash').classList.remove('activo', 'sugerido');
      // Enfoque, luz y blancos automáticos y continuos
      const ajustes = {};
      if (cap.focusMode && cap.focusMode.includes('continuous')) ajustes.focusMode = 'continuous';
      if (cap.exposureMode && cap.exposureMode.includes('continuous')) ajustes.exposureMode = 'continuous';
      if (cap.whiteBalanceMode && cap.whiteBalanceMode.includes('continuous')) ajustes.whiteBalanceMode = 'continuous';
      if (Object.keys(ajustes).length) pista.applyConstraints({ advanced: [ajustes] }).catch(() => {});
      $('#capaCamara').classList.toggle('foto-simple', destino === 'acta');
      $('#capaCamara').hidden = false;
      abrirCapa('camara');
      Estabilizador.escucharGiro(true);
      vigilarCamara();
      pintarContador();
      if (destino === 'acta') { $('#camaraGuia').hidden = true; pintarAyudaCamara(); } else elegirModoCamara(est.modoCamara);
    } finally {
      abriendoCamara = false;
    }
  }

  function detenerCamara() {
    if (flujo) flujo.getTracks().forEach(t => { t.onended = null; t.stop(); });
    flujo = null;
    captura = null;
    camara = null;
    clearInterval(relojCamara);
    relojCamara = null;
    Estabilizador.escucharGiro(false);
    $('#video').srcObject = null;
    $('#capaCamara').hidden = true;
    $('#btnDisparar').classList.remove('ocupado', 'quieto', 'movido');
    ['#contador', '#btnCerrarCamara', '#btnCamaraTelefono'].forEach(b => { $(b).disabled = false; });
  }

  /** Texto de ayuda de la cámara: el del modo, o el aviso del momento (mantener firme, foto en curso, poca luz). */
  function pintarAyudaCamara(estado) {
    const ayuda = $('#camaraAyuda');
    const base = camara && camara.destino === 'acta' ? 'Foto de la persona con la tarjeta'
      : est.modoCamara === 'tramos' ? 'De cerca, arriba → abajo, repitiendo 4–5 líneas' : 'Encuadra el documento completo';
    const avisos = {
      firme: 'Mantén firme el teléfono…', quieto: 'Quieto ✓ tomando la foto', foto: 'Tomando la foto: no muevas el teléfono',
      luz: 'Poca luz: enciende la linterna para que salga nítida'
    };
    ayuda.textContent = avisos[estado] || base;
    ayuda.classList.toggle('aviso', !!avisos[estado]);
  }

  /** Mientras la cámara está abierta: el anillo del botón muestra si el teléfono está quieto y, con poca luz, se sugiere la linterna. */
  function vigilarCamara() {
    clearInterval(relojCamara);
    const lienzo = document.createElement('canvas');
    let vueltas = 0;
    relojCamara = setInterval(() => {
      const c = camara, boton = $('#btnDisparar');
      if (!flujo || !c || est.capa !== 'camara') return;
      const g = Estabilizador.giroReciente(250);
      boton.classList.toggle('quieto', g !== null && g < Estabilizador.UMBRAL_QUIETO);
      boton.classList.toggle('movido', g !== null && g >= Estabilizador.UMBRAL_QUIETO);
      if (++vueltas % 4 || boton.classList.contains('ocupado')) return;      // la luz, cada ~0,6 s
      const luz = Estabilizador.luzDe($('#video'), lienzo), oscuro = luz !== null && luz < 70 && !!c.cap.torch && !linterna;
      $('#btnFlash').classList.toggle('sugerido', oscuro);
      if (oscuro !== c.oscuro) { c.oscuro = oscuro; pintarAyudaCamara(oscuro ? 'luz' : null); }
    }, 150);
  }

  /** Tocar la imagen enfoca y mide la luz en ese punto (si la cámara lo permite). */
  function enfocarEn(e) {
    const c = camara, v = $('#video');
    if (!flujo || !c || !v.videoWidth) return;
    // El video se muestra recortado para llenar la pantalla (object-fit: cover): se pasa el toque a coordenadas del cuadro
    const r = v.getBoundingClientRect(), k = Math.max(r.width / v.videoWidth, r.height / v.videoHeight);
    const ancho = v.videoWidth * k, alto = v.videoHeight * k;
    const x = Math.min(1, Math.max(0, (e.clientX - r.left - (r.width - ancho) / 2) / ancho));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top - (r.height - alto) / 2) / alto));
    const anillo = $('#anilloFoco');
    anillo.style.left = e.clientX + 'px';
    anillo.style.top = e.clientY + 'px';
    anillo.classList.remove('activo');
    void anillo.offsetWidth;
    anillo.classList.add('activo');
    const pista = flujo.getVideoTracks()[0], modos = c.cap.focusMode || [], punto = { pointsOfInterest: [{ x, y }] };
    const continuo = () => {
      if (camara === c && modos.includes('continuous')) pista.applyConstraints({ advanced: [Object.assign({ focusMode: 'continuous' }, punto)] }).catch(() => {});
    };
    if (modos.includes('single-shot')) {
      pista.applyConstraints({ advanced: [Object.assign({ focusMode: 'single-shot' }, punto)] })
        .then(() => setTimeout(continuo, 1500))
        .catch(() => pista.applyConstraints({ advanced: [punto] }).catch(() => {}));
    } else {
      pista.applyConstraints({ advanced: [punto] }).catch(() => {});
    }
  }

  /** Foto completa del teléfono (lenta: en Android tarda 1–2 s). Acotada a ~12 MP para no agotar la memoria. */
  async function fotoDeCaptura() {
    if (!captura) return null;
    const pedir = async () => {
      const pc = await captura.getPhotoCapabilities();
      const maxW = pc.imageWidth && pc.imageWidth.max, maxH = pc.imageHeight && pc.imageHeight.max;
      if (maxW && maxH) {
        const k = Math.min(1, 4032 / Math.max(maxW, maxH));
        return captura.takePhoto({ imageWidth: Math.round(maxW * k), imageHeight: Math.round(maxH * k) });
      }
      return captura.takePhoto();
    };
    try {
      return await Promise.race([pedir(), new Promise(r => setTimeout(() => r(null), 6000))]);
    } catch (e) {
      return null;
    }
  }

  /** Nitidez de una foto completa medida igual que los cuadros del video (mismo recorte y escala): comparable. */
  async function nitidezDe(blob, anchoRef) {
    try {
      const bmp = await createImageBitmap(blob), m = Estabilizador.medir(bmp, document.createElement('canvas'), anchoRef);
      if (bmp.close) bmp.close();
      return m ? m.nitidez : null;
    } catch (e) {
      return null;
    }
  }

  async function disparar() {
    const boton = $('#btnDisparar'), v = $('#video'), c = camara;
    if (!flujo || !c || boton.classList.contains('ocupado')) return;
    if (!v.videoWidth) { toast('La cámara aún no está lista: intenta de nuevo'); return; }
    boton.classList.add('ocupado');
    // Mientras se toma (hasta 2,5 s) no se puede cerrar ni terminar: la foto en curso se perdería
    ['#btnListoCamara', '#contador', '#btnCerrarCamara', '#btnCamaraTelefono'].forEach(b => { $(b).disabled = true; });
    let mejor = null;
    try {
      pintarAyudaCamara(Estabilizador.hayGiro() && !Estabilizador.quieto() ? 'firme' : 'quieto');
      mejor = await Estabilizador.rafaga(v, { cancelado: () => camara !== c, alCambiar: e => { if (camara === c) pintarAyudaCamara(e); } });
      if (camara !== c) return;                         // se cerró la cámara mientras tanto
      let blob = null, via = 'cuadro', nitidez = mejor ? mejor.nitidez : null;
      // Video de baja resolución: la foto completa trae más detalle; se usa salvo que haya salido más borrosa que el mejor cuadro
      if (captura && !c.fotoLenta && v.videoWidth * v.videoHeight < VIDEO_BAJO) {
        pintarAyudaCamara('foto');
        const t0 = performance.now(), foto = await fotoDeCaptura();
        if (!foto || performance.now() - t0 > 4000) c.fotoLenta = (c.lentas = (c.lentas || 0) + 1) >= 2;   // dos veces: solo cuadros
        if (foto && camara === c) {
          const n = await nitidezDe(foto, mejor && mejor.medidaAncho);
          if (!mejor || n === null || n >= mejor.nitidez * 0.7) { blob = foto; via = 'foto'; nitidez = n; }
        }
        if (linterna && flujo) flujo.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: true }] }).catch(() => {});
      }
      if (camara !== c) return;
      if (!blob) {
        if (!mejor) throw new Error('No se pudo tomar la foto: intenta de nuevo');
        blob = await Escaner.aJpeg(mejor.lienzo, 0.92);
      }
      // El destello y la vibración van recién ahora: antes de esto, moverse arruinaba la foto
      const d = $('#destello');
      d.classList.remove('activo');
      void d.offsetWidth;
      d.classList.add('activo');
      if (navigator.vibrate) navigator.vibrate(25);
      const info = {
        via, ancho: via === 'cuadro' ? mejor.ancho : null, alto: via === 'cuadro' ? mejor.alto : null, video: v.videoWidth + 'x' + v.videoHeight,
        nitidez: nitidez === null ? null : Math.round(nitidez), espera: mejor ? mejor.espera : null, cuadros: mejor ? mejor.cuadros : 0,
        giro: mejor && mejor.giro !== null ? Math.round(mejor.giro * 10) / 10 : null
      };
      if (c.destino === 'acta') { cerrarCapa(); usarFotoEntrega(blob); return; }
      agregarFoto(blob, 'camara', info);
    } catch (e) {
      toast(e.message || 'No se pudo tomar la foto');
    } finally {
      if (mejor && mejor.lienzo) mejor.lienzo.width = mejor.lienzo.height = 0;   // suelta la memoria del cuadro (hasta 12 MP)
      // P1: si la cámara se cerró y se volvió a abrir, el botón es de la toma nueva (detenerCamara ya lo dejó libre)
      if (camara === c) {
        boton.classList.remove('ocupado');
        ['#contador', '#btnCerrarCamara', '#btnCamaraTelefono'].forEach(b => { $(b).disabled = false; });
        pintarContador();
        pintarAyudaCamara(c.oscuro ? 'luz' : null);
      }
    }
  }

  /** "Cámara del teléfono": la de Android (estabilizador óptico, HDR), una foto a la vez. */
  function usarCamaraTelefono() {
    const destino = camara ? camara.destino : 'documento';
    $(destino === 'acta' ? '#inFotoEntrega' : '#inCamaraNativa').click();     // dentro del toque: Android lo exige
    cerrarCapa();
  }

  function pintarContador() {
    const n = est.paginas.length, ultima = est.paginas[n - 1];
    $('#contadorNum').textContent = n;
    const img = $('#contadorImg');
    if (ultima && ultima.miniUrl) img.src = ultima.miniUrl; else img.removeAttribute('src');
    $('#btnListoCamara').disabled = !n;
  }

  // ---------- Editor de recorte ----------

  let ed = null, arrastre = null;

  async function abrirEditor(p) {
    if (!p || p.procesando) return;
    let fuente;
    try { fuente = await Escaner.cargar(p.fuente); } catch (e) { toast('No se pudo abrir la página'); return; }
    if (est.capa || !est.paginas.includes(p) || p.procesando || est.vista !== 'paginas') return;
    ed = { p, fuente, quad: p.quad.map(q => Object.assign({}, q)), rot: p.rot || 0, modo: p.modo || 'documento' };
    $('#capaEditor').hidden = false;
    abrirCapa('editor');
    pintarModo();
    requestAnimationFrame(dibujarEditor);
  }

  function ocultarEditor() {
    ocultarPreviaEditor();
    if (ed && ed.resultado) soltarResultado(ed);
    $('#capaEditor').hidden = true;
    ed = null;
    arrastre = null;
  }

  // ---------- Vista previa: la página como quedará en el PDF ----------

  /**
   * Zoom con dos dedos (pellizco centrado en los dedos), arrastre con un dedo cuando hay zoom y doble toque para acercar o
   * volver a la imagen entera. Sobre la imagen se aplica translate + scale (origen al centro).
   */
  function crearZoom(caja, img) {
    let s = 1, x = 0, y = 0, inicio = null, toque = null, ultimoToque = null;
    const punteros = new Map();
    const limitar = () => {
      s = Math.min(6, Math.max(1, s));
      const r = caja.getBoundingClientRect(), mx = Math.max(0, (img.offsetWidth * s - r.width) / 2 + 12), my = Math.max(0, (img.offsetHeight * s - r.height) / 2 + 12);
      if (s === 1) { x = 0; y = 0; return; }
      x = Math.min(mx, Math.max(-mx, x));
      y = Math.min(my, Math.max(-my, y));
    };
    const aplicar = () => { limitar(); img.style.transform = `translate(${x}px, ${y}px) scale(${s})`; };
    const centro = () => { const r = caja.getBoundingClientRect(); return { cx: r.left + r.width / 2, cy: r.top + r.height / 2 }; };
    const gesto = () => {
      const [a, b] = Array.from(punteros.values());
      return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, s, x, y };
    };
    const arrastre = p => ({ px: p.x, py: p.y, x, y, s });
    // El punto de la imagen bajo el foco se queda bajo el foco: t' = p' − (p − t)·s'/s (relativo al centro)
    const enfocar = (sNueva, fx0, fy0, fx1, fy1, base) => {
      const c = centro(), k = sNueva / base.s;
      x = (fx1 - c.cx) - (fx0 - c.cx - base.x) * k;
      y = (fy1 - c.cy) - (fy0 - c.cy - base.y) * k;
      s = sNueva;
      aplicar();
    };
    caja.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      try { caja.setPointerCapture(e.pointerId); } catch (err) { /* sin captura igual funciona */ }
      punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (punteros.size >= 2) { inicio = gesto(); toque = null; ultimoToque = null; return; }
      inicio = arrastre({ x: e.clientX, y: e.clientY });
      toque = { x: e.clientX, y: e.clientY, t: Date.now() };
    });
    caja.addEventListener('pointermove', e => {
      if (!punteros.has(e.pointerId)) return;
      punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (toque && Math.hypot(e.clientX - toque.x, e.clientY - toque.y) > 10) toque = null;      // ya es un arrastre
      if (punteros.size >= 2 && inicio && inicio.dist) {
        const g = gesto();
        enfocar(Math.min(6, Math.max(1, inicio.s * g.dist / inicio.dist)), inicio.mx, inicio.my, g.mx, g.my, inicio);
      } else if (punteros.size === 1 && inicio && inicio.px !== undefined && s > 1) {
        x = inicio.x + (e.clientX - inicio.px);
        y = inicio.y + (e.clientY - inicio.py);
        aplicar();
      }
    });
    const soltar = e => {
      const eraUnDedo = punteros.size === 1;
      punteros.delete(e.pointerId);
      if (punteros.size >= 2) inicio = gesto();                                  // quedan dos dedos: sigue el pellizco
      else if (punteros.size === 1) inicio = arrastre(Array.from(punteros.values())[0]);
      else inicio = null;
      if (e.type !== 'pointerup' || !eraUnDedo || !toque || Date.now() - toque.t > 250) { toque = null; return; }
      const ahora = { x: toque.x, y: toque.y, t: Date.now() };
      toque = null;
      if (ultimoToque && ahora.t - ultimoToque.t < 320 && Math.hypot(ahora.x - ultimoToque.x, ahora.y - ultimoToque.y) < 30) {
        ultimoToque = null;
        if (s > 1.05) { s = 1; aplicar(); } else enfocar(2.5, ahora.x, ahora.y, ahora.x, ahora.y, { s, x, y });
      } else {
        ultimoToque = ahora;
      }
    };
    caja.addEventListener('pointerup', soltar);
    caja.addEventListener('pointercancel', soltar);
    return {
      reiniciar() { s = 1; x = 0; y = 0; punteros.clear(); inicio = null; toque = null; ultimoToque = null; img.style.transform = ''; },
      escala: () => s
    };
  }

  let zoomVista = null, zoomEditor = null, urlVista = null, vistaPagina = null;

  /** Abre la vista previa de una página (lo que irá al PDF). */
  function abrirVista(p) {
    if (!p || !p.salida || est.capa) return;
    zoomVista = zoomVista || crearZoom($('#vistaLienzo'), $('#vistaImg'));
    $('#capaVista').hidden = false;
    abrirCapa('vista');
    mostrarEnVista(p);
    $('#vistaListo').focus();
  }

  function mostrarEnVista(p) {
    vistaPagina = p;
    if (urlVista) URL.revokeObjectURL(urlVista);
    urlVista = URL.createObjectURL(p.salida);
    $('#vistaImg').src = urlVista;
    zoomVista.reiniciar();
    const i = est.paginas.indexOf(p), n = est.paginas.length;
    $('#vistaTitulo').textContent = n > 1 ? `Página ${i + 1} de ${n}` : 'Página';
    pintarBotonesVista();
  }

  function pintarBotonesVista() {
    if (est.capa !== 'vista' || !vistaPagina) return;
    const i = est.paginas.indexOf(vistaPagina), lista = q => !!(q && q.salida && !q.procesando);
    $('#vistaAnterior').disabled = !lista(est.paginas[i - 1]);
    $('#vistaSiguiente').disabled = !lista(est.paginas[i + 1]);
  }

  function ocultarVista() {
    $('#capaVista').hidden = true;
    if (urlVista) URL.revokeObjectURL(urlVista);
    urlVista = null;
    vistaPagina = null;
    $('#vistaImg').removeAttribute('src');
  }

  function moverVista(paso) {
    const i = est.paginas.indexOf(vistaPagina), p = est.paginas[i + paso];
    if (p && !p.procesando && p.salida) mostrarEnVista(p);
  }

  async function borrarDesdeVista() {
    const p = vistaPagina;
    if (!p) return;
    const n = est.paginas.length, i = est.paginas.indexOf(p);
    if (!(await preguntar('Borrar página', n > 1 ? `¿Borrar la página ${i + 1}?` : '¿Borrar la página? No queda ninguna otra.', 'Borrar', 'Cancelar'))) return;
    liberar(p);
    est.paginas = est.paginas.filter(x => x !== p);
    olvidarLectura();
    guardarSesion();
    unirPaginas();
    const otra = est.paginas[Math.min(i, est.paginas.length - 1)];
    if (otra && otra.salida && !otra.procesando) { mostrarEnVista(otra); pintarPaginas(); }
    else cerrarCapa(est.paginas.length ? null : 'inicio');
  }

  // ---- En el editor: "Ver" muestra el resultado con los ajustes actuales, antes de aceptarlos ----

  const claveEd = () => JSON.stringify([ed.quad.map(q => [Math.round(q.x * 1e4), Math.round(q.y * 1e4)]), ed.rot, ed.modo]);

  function soltarResultado(e) {
    e.resultado = null;
  }

  function ocultarPreviaEditor() {
    $('#editorPrevia').hidden = true;
    $('#editorPreviaImg').removeAttribute('src');
    if (!$('#edVer').getAttribute('aria-busy')) $('#edVerTexto').textContent = 'Ver';
    if (ed && ed.previaUrl) { URL.revokeObjectURL(ed.previaUrl); ed.previaUrl = null; }
    if (ed) ed.previa = false;
  }

  /**
   * Resultado de la edición con unos ajustes: una sola vez por clave y en la misma fila de trabajo que las demás páginas
   * (cadena), para no procesar dos imágenes grandes a la vez en el teléfono.
   */
  function resultadoEdicion(e, clave) {
    if (e.resultado && e.resultado.clave === clave) return Promise.resolve(e.resultado);
    if (e.enCurso && e.enCurso.clave === clave) return e.enCurso.promesa;
    const ajustes = { quad: e.quad.map(q => Object.assign({}, q)), rot: e.rot, modo: e.modo };
    const promesa = cadena.then(() => Escaner.procesar(e.fuente, ajustes)).then(r => {
      e.resultado = Object.assign(r, { clave });
      if (e.enCurso && e.enCurso.clave === clave) e.enCurso = null;
      return e.resultado;
    });
    cadena = promesa.catch(() => {});
    e.enCurso = { clave, promesa };
    return promesa;
  }

  let turnoVer = 0;

  async function verEdicion() {
    if (!ed) return;
    if (ed.previa) { ocultarPreviaEditor(); return; }
    const e = ed, boton = $('#edVer'), clave = claveEd(), turno = ++turnoVer;
    boton.disabled = true;
    boton.setAttribute('aria-busy', 'true');
    $('#edVerTexto').textContent = '…';
    try {
      await resultadoEdicion(e, clave);
      if (ed !== e || turno !== turnoVer) return;               // se cerró el editor o hay otro "Ver" más nuevo
      if (claveEd() !== clave) { $('#edVerTexto').textContent = 'Ver'; return; }   // cambió un ajuste mientras se procesaba
      zoomEditor = zoomEditor || crearZoom($('#editorPrevia'), $('#editorPreviaImg'));
      e.previaUrl = URL.createObjectURL(e.resultado.salida);
      $('#editorPreviaImg').src = e.previaUrl;
      zoomEditor.reiniciar();
      $('#editorPrevia').hidden = false;
      e.previa = true;
      $('#edVerTexto').textContent = 'Ajustar';
    } catch (err) {
      toast('No se pudo procesar: ' + (err.message || 'error'));
      if (ed === e) $('#edVerTexto').textContent = 'Ver';
    } finally {
      if (turno === turnoVer) {
        boton.disabled = false;
        boton.removeAttribute('aria-busy');
        if (ed === e && !e.previa && $('#edVerTexto').textContent === '…') $('#edVerTexto').textContent = 'Ver';
      }
    }
  }

  function dibujarEditor() {
    if (!ed) return;
    const cont = $('#editorLienzo'), cw = cont.clientWidth - 48, ch = cont.clientHeight - 48;
    const fw = ed.fuente.width, fh = ed.fuente.height, recto = ed.rot % 180 !== 0;
    const k = recto ? Math.min(cw / fh, ch / fw) : Math.min(cw / fw, ch / fh);
    const w = Math.max(1, Math.round(fw * k)), h = Math.max(1, Math.round(fh * k)), dpr = Math.min(2, window.devicePixelRatio || 1);
    const canvas = $('#editorCanvas');
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    canvas.style.width = w + 'px';
    canvas.style.height = h + 'px';
    canvas.getContext('2d').drawImage(ed.fuente, 0, 0, canvas.width, canvas.height);
    const escena = $('#editorEscena');
    escena.style.width = w + 'px';
    escena.style.height = h + 'px';
    escena.style.transform = `rotate(${ed.rot}deg)`;
    const svg = $('#editorSvg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.innerHTML = '<path class="ed-sombra"/><polygon class="ed-poligono"/>'
      + [0, 1, 2, 3].map(i => `<circle class="ed-asa" data-i="${i}" r="11"/>`).join('')
      + [0, 1, 2, 3].map(i => `<circle class="ed-asa-toque" data-i="${i}" r="28"/>`).join('');
    ed.w = w;
    ed.h = h;
    pintarQuad();
  }

  function pintarQuad() {
    const svg = $('#editorSvg'), pts = ed.quad.map(q => [q.x * ed.w, q.y * ed.h]);
    svg.querySelector('.ed-poligono').setAttribute('points', pts.map(p => p.join(',')).join(' '));
    svg.querySelector('.ed-sombra').setAttribute('d', `M0 0H${ed.w}V${ed.h}H0Z M${pts.map(p => p.join(' ')).join(' L')}Z`);
    svg.querySelectorAll('circle').forEach(c => {
      const p = pts[Number(c.dataset.i)];
      c.setAttribute('cx', p[0]);
      c.setAttribute('cy', p[1]);
    });
  }

  /** Punto tocado → coordenadas de la imagen (0..1), considerando el giro de la vista. */
  function puntoEditor(e) {
    const r = $('#editorEscena').getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const a = -ed.rot * Math.PI / 180, dx = e.clientX - cx, dy = e.clientY - cy;
    const x = dx * Math.cos(a) - dy * Math.sin(a) + ed.w / 2, y = dx * Math.sin(a) + dy * Math.cos(a) + ed.h / 2;
    return { x: Math.min(1, Math.max(0, x / ed.w)), y: Math.min(1, Math.max(0, y / ed.h)) };
  }

  function pintarModo() {
    $('#edModoTexto').textContent = ed && ed.modo === 'color' ? 'Color' : 'B/N';
  }

  function aplicarEdicion() {
    const { p, fuente, quad, rot, modo } = ed;
    const visto = ed.resultado && ed.resultado.clave === claveEd() ? ed.resultado : null;
    if (visto) {
      ed.resultado = null;
      liberar(p);
      Object.assign(p, { quad, rot, modo, salida: visto.salida, mini: visto.mini, ancho: visto.ancho, alto: visto.alto, liberada: false });
      p.miniUrl = URL.createObjectURL(p.mini);
      p.version = (p.version || 0) + 1;
      olvidarLectura();
      cerrarCapa();
      pintarPaginas();
      guardarSesion();
      unirPaginas();
      return;
    }
    const enCurso = ed.enCurso && ed.enCurso.clave === claveEd() ? ed.enCurso.promesa : null;
    Object.assign(p, { quad, rot, modo, procesando: true });
    olvidarLectura();
    cerrarCapa();
    pintarPaginas();
    cadena = cadena.then(async () => {
      try {
        const nuevo = enCurso ? await enCurso : await Escaner.procesar(fuente, p);
        liberar(p);
        Object.assign(p, nuevo, { liberada: false });      // sigue viva: solo se soltaron sus imágenes anteriores
        p.miniUrl = URL.createObjectURL(p.mini);
        p.version = (p.version || 0) + 1;
      } catch (e) {
        toast('No se pudo procesar la página');
      }
      p.procesando = false;
      pintarPaginas();
      guardarSesion();
      unirPaginas();
    });
  }

  function borrarPagina() {
    const p = ed.p;
    liberar(p);
    est.paginas = est.paginas.filter(x => x !== p);
    olvidarLectura();
    guardarSesion();
    cerrarCapa(est.paginas.length ? null : 'inicio');
    unirPaginas();
  }

  // ---------- Datos del gasto ----------

  function llenarSelect(el, valores) {
    const actual = el.value;
    el.innerHTML = valores.map(v => `<option>${esc(v)}</option>`).join('');
    if (valores.includes(actual)) el.value = actual;
  }

  function limpiarFormulario() {
    ['fFecha', 'fMonto', 'fNumero', 'fProveedor', 'fRazon', 'fRut', 'fCeco', 'fDetalle', 'fObs', 'fEmpresa', 'fAsistentes', 'fMotivo',
      'fReNombre', 'fReRut', 'fReFecha', 'fReOperacion'].forEach(id => { document.getElementById(id).value = ''; });
    $('#fReRut').dataset.auto = '';
    $('#reRutEstado').textContent = '';
    $$('.sugerido, .invalido').forEach(el => el.classList.remove('sugerido', 'invalido'));
    $('#fRinde').value = Api.config().nombre || '';
    $('#fMonto').placeholder = '$0';
    ['#lectura', '#sugMonto', '#controlTarjeta', '#grupoRepresentacion'].forEach(s => { $(s).hidden = true; });
    $('#rutEstado').textContent = '';
    $('#provEstado').textContent = '';
    $('#cecoEstado').textContent = '';
    pintarReembolso();
  }

  function prepararDatos() {
    const L = listas();
    llenarSelect($('#fTipo'), L.tiposDoc);
    llenarSelect($('#fMedio'), L.medios);
    const cecoActual = $('#fCeco').value;
    $('#fCeco').innerHTML = '<option value="">Elegir (opcional)</option>'
      + L.cecos.map(c => `<option value="${esc(c.codigo)}">${esc(c.codigo)}${c.significado ? ' · ' + esc(c.significado) : ''}</option>`).join('');
    ponerCeco(cecoActual);
    $('#fFecha').max = hoyISO();          // sin fecha por defecto: el mes de la rendición lo define la fecha del documento
    $('#fReFecha').max = hoyISO();
    if (!$('#fRinde').value) $('#fRinde').value = Api.config().nombre || '';
    elegirMovimiento(est.movimiento);
    pintarPlantillas();
  }

  function elegirMovimiento(mov) {
    // Con reembolso, el medio "de antes" ya no es de esta cuenta: al desmarcarlo vuelve el habitual de la nueva
    if (est.reembolso && est.medioSinReembolso && mov !== est.movimiento) est.medioSinReembolso = medioPorDefecto(mov);
    est.movimiento = mov;
    $$('#segMovimiento button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.valor === mov)));
    const gasto = GASTOS.includes(mov);
    $('#grupoCategoria').hidden = !gasto;
    $('#campoCeco').hidden = !gasto;
    if (!gasto) est.reembolso = false;               // un ingreso no es un reembolso
    if (est.reembolso) $('#fMedio').value = MEDIO_REEMBOLSO[mov];
    else if (!est.tocados.has('medio')) $('#fMedio').value = medioPorDefecto(mov);
    if (gasto) {
      if (est.categoria === 'Recarga caja chica') est.categoria = '';
      $('#fDetalle').placeholder = '¿Qué se compró y para qué?';
      if (!est.tocados.has('tipoDoc') && $('#fTipo').value === 'Comprobante de transferencia') $('#fTipo').value = 'Boleta electrónica';
    } else {
      est.categoria = 'Recarga caja chica';
      $('#fDetalle').placeholder = 'Ej: recarga de caja chica desde Santander';
      if (!est.tocados.has('tipoDoc')) $('#fTipo').value = 'Comprobante de transferencia';
    }
    pintarCategorias();
    pintarReembolso();
    pintarControlTarjeta();
  }

  function pintarCategorias() {
    const cont = $('#chipsCategoria');
    if (est.categoria && GASTOS.includes(est.movimiento) && !est.edicion && (est.listas || Api.demo)
      && !listas().categorias.some(c => c.nombre === est.categoria)) est.categoria = '';
    cont.innerHTML = '';
    listas().categorias.filter(c => c.nombre !== 'Recarga caja chica').forEach(c => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = c.nombre;
      b.setAttribute('aria-pressed', String(est.categoria === c.nombre));
      b.onclick = () => (est.categoria === c.nombre ? quitarCategoria(c) : elegirCategoria(c));
      cont.appendChild(b);
    });
    const nueva = document.createElement('button');
    nueva.type = 'button';
    nueva.className = 'mas';
    nueva.textContent = '+ Nueva';
    nueva.onclick = categoriaNuevaEnGasto;
    cont.appendChild(nueva);
    $('#grupoRepresentacion').hidden = !(GASTOS.includes(est.movimiento) && est.categoria === 'Atención a clientes');
  }

  function elegirCategoria(c) {
    est.categoria = c.nombre;
    $('#chipsCategoria').classList.remove('invalido');
    if (!est.tocados.has('ceco')) {
      ponerCeco(c.ceco);
      validarCeco();
    }
    pintarCategorias();
  }

  function quitarCategoria(c) {
    est.categoria = '';
    if (!est.tocados.has('ceco') && c.ceco && $('#fCeco').value === c.ceco) { $('#fCeco').value = ''; $('#fCeco').classList.remove('sugerido'); validarCeco(); }
    pintarCategorias();
    tocarFormulario();
  }

  // ---------- Reembolso a colaborador ----------

  /** Lo pagó un colaborador con su dinero: se le transfiere (desde MP o Santander), el medio es esa transferencia y lo rinde él. */
  function cambiarReembolso(si) {
    const medio = $('#fMedio');
    est.reembolso = !!si && GASTOS.includes(est.movimiento);
    if (est.reembolso) {
      if (medio.value !== MEDIO_REEMBOLSO[est.movimiento]) est.medioSinReembolso = medio.value;
      medio.value = MEDIO_REEMBOLSO[est.movimiento];
      medio.classList.remove('sugerido', 'invalido');
    } else {
      // Vuelve el medio de antes; si no había otro (un registro que ya era reembolso), el habitual, marcado para revisarlo
      const antes = est.medioSinReembolso;
      est.medioSinReembolso = '';
      medio.value = antes && opciones('#fMedio').includes(antes) && antes !== MEDIO_REEMBOLSO[est.movimiento] ? antes : medioPorDefecto(est.movimiento);
      if (!antes) {
        medio.classList.add('sugerido');
        toast('Revisa el medio de pago con que se pagó la boleta');
      }
    }
    pintarReembolso();
    pintarControlTarjeta();
    tocarFormulario();
  }

  function pintarReembolso() {
    const gasto = GASTOS.includes(est.movimiento);
    if (!gasto) est.reembolso = false;
    $('#grupoReembolso').hidden = !gasto;
    $('#chkReembolso').checked = !!est.reembolso;
    $('#cuerpoReembolso').hidden = !est.reembolso;
    $('#fMedio').disabled = !!est.reembolso;
    $('#campoRinde').hidden = !!est.reembolso || !!est.edicion;
    $$('#segReembolso button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.valor === est.movimiento)));
    $('#segReembolso').classList.toggle('bloqueado', !!est.edicion);
    if (!est.reembolso) return;
    $('#fMedio').value = MEDIO_REEMBOLSO[est.movimiento];      // aunque otra acción lo haya cambiado (plantilla, datos recuperados)
    pintarPersonasReembolso();
    pintarAyudaReembolso();
  }

  /** Las personas de la base, primero las ya reembolsadas desde este teléfono. Tocar la elegida la suelta. */
  function pintarPersonasReembolso() {
    const cont = $('#rePersonas'), actual = normalNombre($('#fReNombre').value), uso = usoLocal('reembolsos');
    let orden = est.personas.map((p, i) => ({ p, i, n: uso[normalNombre(p.nombre)] || 0 })).sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.p);
    const elegida = orden.find(p => normalNombre(p.nombre) === actual);
    orden = orden.slice(0, 8);
    if (elegida && !orden.includes(elegida)) orden = [elegida].concat(orden.slice(0, 7));
    cont.innerHTML = '';
    orden.forEach(p => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = nombreCorto(p.nombre);
      b.title = p.nombre + (p.cargo ? ' · ' + p.cargo : '');
      b.setAttribute('aria-pressed', String(normalNombre(p.nombre) === actual));
      b.onclick = () => elegirReembolsado(normalNombre(p.nombre) === normalNombre($('#fReNombre').value) ? null : p);
      cont.appendChild(b);
    });
    const u = leerLocal('ultimoReembolso');
    const ver = !!(u && u.nombre && !est.edicion && !$('#fReNombre').value.trim() && Date.now() - (u.cuando || 0) < 45 * 86400000);
    $('#btnReAnterior').hidden = !ver;
    if (ver) {
      $('#btnReAnterior').textContent = `Igual que el anterior: ${nombreCorto(u.nombre)} · ${u.movimiento === 'Rendición Santander' ? 'Santander' : 'Mercado Pago'}`
        + (u.fecha ? ` · ${fechaCorta(u.fecha)}${u.operacion ? ' · op. ' + u.operacion : ''}` : ' · pendiente');
    }
  }

  function pintarAyudaReembolso() {
    $('#reAyuda').textContent = $('#fReFecha').value
      ? 'Si una misma transferencia paga varias boletas, registra cada una con la misma fecha y N° de operación. El comprobante de la transferencia no se adjunta: se cruza con la cartola.'
      : 'Sin fecha queda como reembolso pendiente. Cuando se le transfiera: abre el registro, toca «Corregir datos» y agrega la fecha y el N° de operación.';
  }

  /** La persona de la base dueña de ese RUT, si hay. */
  const personaDeRut = v => { const c = cuerpoRut(v); return c ? est.personas.find(x => cuerpoRut(x.rut) === c) || null : null; };

  /** Un toque en la persona: su nombre y su RUT (vacío si la base no lo tiene: no queda el RUT de otra persona). */
  function elegirReembolsado(p) {
    $('#fReNombre').value = p ? p.nombre : '';
    $('#fReNombre').classList.remove('invalido');
    const rut = $('#fReRut');
    rut.value = p ? p.rut || '' : '';
    rut.dataset.auto = p && p.rut ? '1' : '';
    validarReRut();
    pintarPersonasReembolso();
    tocarFormulario();
  }

  /** Nombre escrito a mano: si está en la base, queda completo y con su RUT (si no se escribió otro). */
  function nombreReembolsoEscrito() {
    const p = buscarPersona($('#fReNombre').value), rut = $('#fReRut');
    if (p) $('#fReNombre').value = p.nombre;
    const dueno = personaDeRut(rut.value);
    if (p && p.rut) { rut.value = p.rut; rut.dataset.auto = '1'; }
    else if (rut.dataset.auto === '1' || (dueno && dueno !== p)) { rut.value = ''; rut.dataset.auto = ''; }
    validarReRut();
    pintarPersonasReembolso();
  }

  function validarReRut() {
    const ok = revisarRut($('#fReRut'), $('#reRutEstado'), 'Es el RUT de Telconsulting, no del colaborador');
    const dueno = ok && personaDeRut($('#fReRut').value), s = $('#reRutEstado');
    if (dueno && normalNombre(dueno.nombre) !== normalNombre($('#fReNombre').value)) {
      s.textContent = `Es el RUT de ${dueno.nombre} en la base`;
      s.className = 'alerta';
    }
    return ok;
  }

  function usarReembolsoAnterior() {
    const u = leerLocal('ultimoReembolso');
    if (!u || est.edicion) return;
    if (u.movimiento !== est.movimiento && GASTOS.includes(u.movimiento)) elegirMovimiento(u.movimiento);
    [['fReNombre', u.nombre], ['fReRut', u.rut], ['fReFecha', u.fecha], ['fReOperacion', u.operacion]]
      .forEach(([id, v]) => { document.getElementById(id).value = v || ''; });
    $('#fReRut').dataset.auto = '';
    validarReRut();
    pintarReembolso();
    tocarFormulario();
  }

  /** El último reembolso queda a un toque (varias boletas pagadas con una sola transferencia) y la persona, a mano. */
  function recordarReembolso(d) {
    const re = d.reembolso;
    guardarLocal('ultimoReembolso', { nombre: re.nombre, rut: re.rut, fecha: re.fecha, operacion: re.operacion, movimiento: d.movimiento, cuando: Date.now() });
    contarUso('reembolsos', re.nombre);
    if (!buscarPersona(re.nombre, true)) {
      est.personas.push({ nombre: re.nombre, rut: re.rut || '', cargo: '', area: '', correo: '' });
      usarRapido({});
    }
  }

  function validarRut() { return revisarRut($('#fRut'), $('#rutEstado'), 'Es el RUT de Telconsulting, no del proveedor'); }

  function revisarRut(el, s, mensajeEmpresa) {
    const v = el.value.trim();
    if (!v) { s.textContent = ''; s.className = ''; return true; }
    const r = rutInfo(v);
    if (!r) { s.textContent = 'Formato no válido'; s.className = 'alerta'; return false; }
    el.value = r.texto;
    if (r.texto === '78.083.138-3') { s.textContent = mensajeEmpresa; s.className = 'alerta'; return false; }
    s.textContent = r.ok ? 'RUT válido' : 'Dígito verificador no válido';
    s.className = r.ok ? 'ok' : 'alerta';
    return r.ok;
  }

  /** CeCo en el selector: uno que no esté en el catálogo (un registro antiguo) se muestra igual, con la alerta de validarCeco. */
  function ponerCeco(v) {
    const el = $('#fCeco');
    if (v && !opciones('#fCeco').includes(v)) el.insertAdjacentHTML('beforeend', `<option value="${esc(v)}">${esc(v)} (fuera del catálogo)</option>`);
    el.value = v || '';
  }

  function validarCeco() {
    const el = $('#fCeco'), s = $('#cecoEstado'), v = el.value.trim();
    if (!v) { s.textContent = ''; s.className = ''; return true; }
    const c = listas().cecos.find(x => x.codigo.toLowerCase() === v.toLowerCase());
    if (c) {
      if (c.codigo !== v) el.value = c.codigo;
      s.textContent = c.significado || 'En el catálogo oficial';
      s.className = 'ok';
      return true;
    }
    s.textContent = 'No está en el catálogo oficial de CeCo';
    s.className = 'alerta';
    return false;
  }

  async function leerDocumento() {
    const id = ++est.lecturaId;
    est.lectura = null;
    pintarLectura('leyendo');
    if (!Api.configurada()) { pintarLectura('sin-config'); return; }
    try {
      let datos;
      if (est.pdf) {
        if (est.pdf.blob.size > 6 * 1048576) { pintarLectura('grande'); return; }
        datos = { pdf: await aBase64(est.pdf.blob) };
      } else {
        // Boleta larga con muchas fotos: el encabezado (RUT, folio, fecha) va arriba y el total abajo
        const n = est.paginas.length, lista = n > 6 ? est.paginas.slice(0, 3).concat(est.paginas.slice(n - 3)) : est.paginas;
        datos = { paginas: [] };
        for (const p of lista) {
          const imagen = Escaner.reducir ? await Escaner.reducir(p.salida, 4e6, 0.85) : p.salida;
          datos.paginas.push({ b64: await aBase64(imagen), tipo: 'image/jpeg' });
        }
      }
      const r = await Api.llamar('ocr', datos, { espera: 90000 });
      if (id !== est.lecturaId) return;
      est.lectura = r;
      aplicarSugeridos(r);
      pintarLectura(r.sugeridos && r.sugeridos.fecha ? 'ok' : 'ok-sin-fecha');
      pintarControlTarjeta();
      revisarMonto();
    } catch (e) {
      if (id !== est.lecturaId) return;
      pintarLectura(e.codigo === 'red' ? 'sin-red' : 'error', e.message);
    }
  }

  function pintarLectura(estado, detalle) {
    const el = $('#lectura'), ico = n => `<svg class="ico"><use href="#${n}"/></svg>`;
    const textos = {
      leyendo: '<span class="girando"></span><span>Leyendo el documento…</span>',
      ok: `${ico('i-check')}<span>Datos sugeridos desde el documento. Revísalos antes de guardar.</span>`,
      'ok-sin-fecha': `${ico('i-alerta')}<span>Datos sugeridos, pero no se leyó la fecha: ingrésala.</span>`,
      'sin-red': `${ico('i-nube')}<span>Sin conexión: completa los datos a mano.</span>`,
      'sin-config': `${ico('i-alerta')}<span>Vincula la app en Ajustes para leer el documento.</span>`,
      grande: `${ico('i-alerta')}<span>El PDF es muy grande para leerlo: completa los datos a mano.</span>`,
      error: `${ico('i-alerta')}<span>No se pudo leer el documento (${esc(detalle || 'error')}). Completa a mano.</span>`
    };
    el.className = 'lectura' + (estado === 'ok' ? ' ok' : estado === 'leyendo' ? '' : ' error');
    el.innerHTML = textos[estado];
    el.hidden = false;
  }

  function aplicarSugeridos(r) {
    const s = r.sugeridos || {};
    const delDocumento = el => {
      const a = est.plantillaAplicada;
      if (a && a.despues.v[el.id]) a.despues.v[el.id].valor = null;
    };
    const poner = (campo, el, valor) => {
      if (valor === null || valor === undefined || valor === '' || est.tocados.has(campo)) return;
      el.value = valor;
      el.classList.add('sugerido');
      delDocumento(el);
    };
    poner('fecha', $('#fFecha'), s.fecha);
    if (s.monto) poner('monto', $('#fMonto'), miles(s.monto));
    if (s.tipoDoc && opciones('#fTipo').includes(s.tipoDoc)) poner('tipoDoc', $('#fTipo'), s.tipoDoc);
    poner('numero', $('#fNumero'), s.numero);
    poner('proveedor', $('#fProveedor'), s.proveedor);
    poner('razonSocial', $('#fRazon'), s.razonSocial);
    poner('rut', $('#fRut'), s.rut);
    if (s.proveedorConocido && s.rut && !proveedorDeRut(cuerpoRut(s.rut))) {
      est.proveedores.push({ rut: s.rut, razonSocial: s.razonSocial || '', fantasia: s.proveedor || '', categoria: '', ceco: '', usos: 0, ultimo: '' });
    }
    validarRut();
    completarPorRut();
    if (!est.tocados.has('medio') && !est.reembolso && est.movimiento === 'Desembolso MP') {
      const t = r.tarjetas && r.tarjetas['Tarjeta MP'];
      if (t && t.resultado === 'coincide') { $('#fMedio').value = 'Tarjeta MP'; delDocumento($('#fMedio')); }
      else if (r.mercadoPago && opciones('#fMedio').includes('QR Mercado Pago')) { $('#fMedio').value = 'QR Mercado Pago'; delDocumento($('#fMedio')); }
    }
    sugerirPorProveedor();
    tocarFormulario();
  }

  function revisarMonto() {
    const nota = $('#sugMonto'), s = !est.edicion && est.lectura && est.lectura.sugeridos;
    const leido = s && s.montoConfianza !== 'baja' && s.monto, escrito = Number(soloDigitos($('#fMonto').value));
    if (!leido || !escrito || leido === escrito) { nota.hidden = true; return; }
    nota.innerHTML = `<span>El documento dice <strong>${clp(leido)}</strong></span><button type="button" class="btn-texto">Usar</button>`;
    nota.querySelector('button').onclick = () => { $('#fMonto').value = miles(leido); nota.hidden = true; };
    nota.hidden = false;
  }

  function pintarControlTarjeta() {
    const el = $('#controlTarjeta'), medio = $('#fMedio').value;
    const t = !est.edicion && /^Tarjeta/.test(medio) && est.lectura && est.lectura.tarjetas && est.lectura.tarjetas[medio];
    if (!t) { el.hidden = true; return; }
    const cuatro = x => '****' + x;
    const casos = {
      coincide: ['ok', 'i-check', `Tarjeta de la empresa verificada en el documento (${esc(String(t.texto || '').replace(/^✓\s*/, ''))})`],
      otra: ['alerta', 'i-alerta', `El documento muestra otra tarjeta (${esc((t.encontradas || []).map(cuatro).join(', '))})`],
      posible: ['revisar', 'i-alerta', 'Aparecen los dígitos de la tarjeta, pero no junto a la palabra tarjeta: revisa'],
      no_aparece: ['info', 'i-alerta', 'El documento no muestra la tarjeta (es normal en muchas boletas)'],
      sin_config: ['info', 'i-ajustes', 'Ingresa los 4 dígitos de la tarjeta en Ajustes para verificarla']
    };
    const c = casos[t.resultado];
    if (!c) { el.hidden = true; return; }
    el.className = 'control ' + c[0];
    el.innerHTML = `<svg class="ico"><use href="#${c[1]}"/></svg><span>${c[2]}</span>`;
    el.hidden = false;
  }

  function leerFormulario() {
    const gasto = GASTOS.includes(est.movimiento);
    const reembolso = gasto && est.reembolso ? { nombre: $('#fReNombre').value.trim(), rut: $('#fReRut').value.trim(),
      fecha: $('#fReFecha').value, operacion: $('#fReOperacion').value.trim() } : null;
    return {
      movimiento: est.movimiento,
      fecha: $('#fFecha').value,
      monto: Number(soloDigitos($('#fMonto').value)),
      tipoDoc: $('#fTipo').value,
      numero: $('#fNumero').value.trim(),
      proveedor: $('#fProveedor').value.trim(),
      razonSocial: $('#fRazon').value.trim(),
      rut: $('#fRut').value.trim(),
      detalle: $('#fDetalle').value.trim(),
      categoria: gasto ? est.categoria : 'Recarga caja chica',
      ceco: gasto ? $('#fCeco').value.trim() : '',
      medio: $('#fMedio').value,
      rinde: $('#fRinde').value.trim(),       // con reembolso, el servidor deja como Rinde al colaborador
      observaciones: $('#fObs').value.trim(),
      representacion: gasto && est.categoria === 'Atención a clientes'
        ? { empresa: $('#fEmpresa').value.trim(), asistentes: $('#fAsistentes').value.trim(), motivo: $('#fMotivo').value.trim() }
        : null,
      reembolso
    };
  }

  function validar(d) {
    $$('.invalido').forEach(el => el.classList.remove('invalido'));
    const falla = (sel, mensaje) => {
      const el = $(sel);
      el.classList.add('invalido');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return mensaje;
    };
    if (!hayDocumento() && !est.edicion) return 'Falta el documento';
    if (!d.fecha) return falla('#fFecha', 'Falta la fecha del documento');
    if (d.fecha > hoyISO()) return falla('#fFecha', 'La fecha no puede ser futura');
    if (est.edicion && d.fecha.slice(0, 4) !== String(est.edicion.original.fecha || '').slice(0, 4)) {
      return falla('#fFecha', 'El año no se puede cambiar: deshaz el registro y vuelve a ingresarlo');
    }
    if (!(d.monto > 0)) return falla('#fMonto', 'Falta el monto');
    if (!d.detalle) return falla('#fDetalle', 'Escribe qué se compró y para qué');
    if (GASTOS.includes(d.movimiento) && !d.categoria) return falla('#chipsCategoria', 'Elige una categoría');
    if (d.representacion && !d.representacion.empresa) return falla('#fEmpresa', 'Falta la empresa cliente');
    if (d.representacion && !d.representacion.motivo) return falla('#fMotivo', 'Falta el motivo comercial');
    if (d.reembolso) {
      if (!d.reembolso.nombre) return falla('#fReNombre', 'Falta a quién se le reembolsa');
      if (d.reembolso.rut && !validarReRut()) return falla('#fReRut', 'Revisa el RUT del colaborador (o déjalo vacío)');
      if (d.reembolso.fecha && d.reembolso.fecha > hoyISO()) return falla('#fReFecha', 'La transferencia no puede tener fecha futura');
      if (d.reembolso.operacion && !d.reembolso.fecha) return falla('#fReFecha', 'Falta la fecha de la transferencia');
    }
    if (d.rut && !validarRut()) return falla('#fRut', 'Revisa el RUT del proveedor (o déjalo vacío)');
    // Sin las listas del servidor no se bloquea el CeCo: el servidor lo valida igual y deja la alerta.
    if (d.ceco && est.listas && !validarCeco()) return falla('#fCeco', 'El centro de costo no está en el catálogo oficial');
    return null;
  }

  async function armarArchivo(d) {
    if (est.pdf) return { blob: est.pdf.blob, paginas: null, nombreOriginal: est.pdf.nombre };
    let pags = est.paginas.map(p => ({ salida: p.salida, ancho: p.ancho, alto: p.alto }));
    if ($('#chkUnir').checked && pags.length > 1) {
      const t = await unirPaginas();
      if (!t || !t.resultado) throw new Error('No se pudieron unir las fotos de la boleta larga');
      const r = t.recorte, entera = r.x0 <= 0 && r.y0 <= 0 && r.x1 >= 1 && r.y1 >= 1;
      pags = [entera ? t.resultado : await Escaner.recortar(t.resultado, r)];
    }
    const paginasPdf = [];
    for (const p of pags) paginasPdf.push({ jpeg: new Uint8Array(await p.salida.arrayBuffer()), ancho: p.ancho, alto: p.alto });
    const titulo = [d.tipoDoc, d.numero, d.proveedor].filter(Boolean).join(' ') || 'Respaldo caja chica';
    // La fecha del PDF es la de la captura: si se reintenta un guardado, el archivo es idéntico y el servidor lo reconoce
    const fecha = est.capturadoEn ? new Date(est.capturadoEn) : new Date();
    return { blob: Pdf.crear(paginasPdf, { titulo, autor: d.rinde || 'Telconsulting', fecha }), paginas: est.paginas.length, nombreOriginal: null };
  }

  async function guardar(forzar) {
    if (est.guardando) return;
    if (est.edicion) { guardarEdicion(); return; }
    const d = leerFormulario(), error = validar(d);
    if (error) { toast(error); return; }
    if (est.paginas.some(p => p.procesando)) { toast('Espera a que terminen de procesarse las páginas'); return; }
    const boton = $('#btnGuardar');
    est.guardando = true;
    boton.disabled = true;
    boton.textContent = 'Armando el PDF…';
    let payload = null, reintentar = false;
    try {
      const archivo = await armarArchivo(d);
      if (archivo.blob.size > MAX_BYTES) throw new Api.ErrorApi('El documento supera 20 MB', 'tamano');
      payload = {
        datos: d,
        archivo: { b64: await aBase64(archivo.blob), paginas: archivo.paginas, nombreOriginal: archivo.nombreOriginal },
        ocr: est.lectura ? { texto: est.lectura.texto, firma: est.lectura.firma } : null,
        meta: { capturadoEn: est.capturadoEn, origen: est.origen, dispositivo: navigator.userAgent, versionApp: VERSION,
          capturas: est.pdf ? null : est.paginas.map(p => p.captura || null), plantilla: est.plantilla || null,
          nombresEscritos: { proveedor: est.tocados.has('proveedor'), razonSocial: est.tocados.has('razonSocial') },
          registradoPor: Api.config().nombre || '' },
        forzar: !!forzar
      };
      if (!Api.configurada()) throw new Api.ErrorApi('La app aún no está vinculada', 'config');
      boton.textContent = 'Guardando en Drive…';
      const r = await Api.llamar('guardar', payload, { espera: 150000 });
      soltarUltimo();
      est.ultimo = {
        id: r.id, paginas: est.paginas, pdf: est.pdf, origen: est.origen, capturadoEn: est.capturadoEn, lectura: est.lectura,
        tira: est.tira, modoTira: est.modoTira, unir: $('#chkUnir').checked, datos: d,
        categoria: est.categoria, movimiento: est.movimiento, tocados: new Set(est.tocados), plantilla: est.plantilla,
        plantillaAplicada: est.plantillaAplicada
      };
      contarUso('plantillas', est.plantilla);
      recordarProveedor(d);
      if (d.reembolso) recordarReembolso(d);
      await terminarSesion(true);
      mostrarListo(r, d, null);
    } catch (e) {
      if (e.codigo === 'duplicado' && e.datos && e.datos.duplicado) {
        const dup = e.datos.duplicado, cuando = `${dup.id} (${fechaCorta(dup.fecha)} · ${clp(dup.monto)})`;
        if (dup.mismoArchivo) {
          await preguntar('Ya está registrado', `Este mismo documento ya está guardado como ${cuando}.`, 'Entendido', null);
        } else {
          reintentar = await preguntar('¿Documento repetido?', `Parece que ya está registrado como ${cuando}.\nMotivo: ${dup.motivo}.`, 'Guardar igual', 'No guardar');
        }
      } else if ((e.codigo === 'red' || e.codigo === 'config') && payload) {
        await Api.encolar(payload);
        contarUso('plantillas', est.plantilla);
        recordarProveedor(d);
        if (d.reembolso) recordarReembolso(d);
        await terminarSesion();
        mostrarListo(null, d, e.codigo);
      } else {
        toast('No se pudo guardar: ' + e.message, 6000);
      }
    } finally {
      est.guardando = false;
      boton.disabled = false;
      boton.textContent = 'Guardar en Drive';
    }
    if (reintentar) guardar(true);
  }

  /** Cierra la captura guardada. Con conservar, las fotos siguen en memoria (est.ultimo) para poder deshacer y corregir. */
  async function terminarSesion(conservar) {
    if (!conservar) est.paginas.forEach(liberar);
    est.paginas = [];
    est.pdf = null;
    est.tira = null;
    mostrarTiraEn(null);
    est.lecturaId++;
    est.formularioGuardado = null;
    clearTimeout(relojFormulario);
    relojFormulario = null;
    try { await DB.borrar('sesion', 'actual'); await DB.borrar('sesion', 'formulario'); } catch (e) { /* nada que borrar */ }
  }

  function mostrarListo(r, d, enCola) {
    const icono = $('#listoIcono');
    icono.classList.toggle('cola', !!enCola);
    icono.innerHTML = `<svg class="ico"><use href="#${enCola ? 'i-nube' : 'i-check'}"/></svg>`;
    $('#listoTitulo').textContent = enCola ? 'Guardado en el teléfono' : 'Respaldado en Drive';
    $('#listoId').textContent = r ? r.id + (r.prueba ? ' · prueba' : '') : '';
    $('#listoDetalle').textContent = enCola
      ? (enCola === 'config' ? 'Se enviará a Drive cuando vincules la app en Ajustes.' : 'Se enviará a Drive apenas haya conexión.')
      : [d.tipoDoc + (d.numero ? ' ' + d.numero : ''), d.proveedor, clp(d.monto)].filter(Boolean).join(' · ');
    const controles = $('#listoControles');
    controles.innerHTML = '';
    if (r) {
      const t = String(r.controlTarjeta || '');
      if (t && t !== 'No aplica') {
        const clase = t[0] === '✓' ? 'ok' : t[0] === '✗' ? 'alerta' : 'revisar';
        controles.insertAdjacentHTML('beforeend', `<div class="control ${clase}"><span>Control tarjeta: ${esc(t)}</span></div>`);
      }
      (r.alertas || []).forEach(a => controles.insertAdjacentHTML('beforeend',
        `<div class="control revisar"><svg class="ico"><use href="#i-alerta"/></svg><span>${esc(a)}</span></div>`));
      $('#lnkPdf').href = enlaceSeguro(r.respaldoUrl);
      $('#lnkFila').href = enlaceSeguro(r.planillaUrl);
    }
    const re = d && d.reembolso;
    if (re) {
      controles.insertAdjacentHTML('beforeend', `<div class="control info"><svg class="ico"><use href="#i-check"/></svg><span>${esc(re.fecha
        ? `Reembolso a ${re.nombre}: transferencia del ${fechaCorta(re.fecha)}${re.operacion ? ', op. ' + re.operacion : ''}`
        : `Reembolso pendiente a ${re.nombre}: cuando se le transfiera, toca «Corregir datos» y agrega la fecha`)}</span></div>`);
    }
    $('#listoEnlaces').hidden = !r;
    $('#btnCorregirListo').hidden = !r;
    est.listoDatos = d;
    $('#btnFrecuente').hidden = !d || !GASTOS.includes(d.movimiento);
    est.listoActual = r ? {
      id: r.id, fecha: d.fecha, monto: d.monto, proveedor: d.proveedor, detalle: d.detalle, movimiento: d.movimiento,
      tipoDoc: d.tipoDoc, numero: d.numero, estado: 'Pendiente revisión', respaldoUrl: r.respaldoUrl, controlTarjeta: r.controlTarjeta
    } : null;
    history.replaceState({ vista: 'listo', prof: profundidad() }, '');
    mostrar('listo');
    pintarCola();
  }

  // ---------- Ficha de un registro: corregir, deshacer o anular ----------

  async function abrirRegistro(f) {
    if (est.vista === 'registro') return;              // doble toque en la lista
    est.registro = { registro: f, representacion: null, reembolso: null, deshacer: null, cargando: true, error: null };
    ir('registro');
    await recargarRegistro(f.id);
  }

  /** Trae el registro fresco del servidor (la planilla pudo cambiar desde que se cargó la lista). */
  async function recargarRegistro(id) {
    const x = est.registro;
    if (!x || x.registro.id !== id) return;
    x.cargando = true;
    if (est.vista === 'registro') pintarRegistro();
    try {
      const r = await Api.llamar('registro', { id });
      if (est.registro !== x) return;
      Object.assign(x, { registro: r.registro, representacion: r.representacion || null, reembolso: r.reembolso || null, fichaLeida: r.fichaLeida !== false,
        deshacer: r.deshacer, error: null });
    } catch (e) {
      if (est.registro !== x) return;
      x.error = e.codigo === 'red' ? 'Sin conexión: para corregir o deshacer necesitas internet.' : e.message;
    }
    x.cargando = false;
    if (est.vista === 'registro') pintarRegistro();
  }

  function pintarRegistro() {
    const x = est.registro;
    if (!x) return;
    const f = x.registro, anulado = f.estado === 'Anulado';
    $('#rgId').textContent = f.id;
    $('#rgEstado').textContent = f.estado || '';
    $('#rgEstado').className = 'chip ' + claseEstado(f.estado);
    $('#rgMonto').textContent = clp(f.monto);
    $('#rgProveedor').textContent = [f.proveedor || f.detalle || f.movimiento || '', f.razonSocial && f.razonSocial !== f.proveedor ? f.razonSocial : '']
      .filter(Boolean).join(' · ');
    const filas = [
      ['Fecha', fechaCorta(f.fecha)], ['Documento', [f.tipoDoc, f.numero].filter(Boolean).join(' N° ')], ['RUT', f.rut],
      ['Detalle', f.detalle], ['Categoría', f.categoria], ['CeCo', f.ceco], ['Medio de pago', f.medio],
      ['Control tarjeta', f.controlTarjeta], ['Conciliación', f.conciliacion], ['Observaciones', f.observaciones]
    ].filter(p => p[1]);
    $('#rgDatos').innerHTML = filas.map(p => `<dt>${esc(p[0])}</dt><dd>${esc(p[1])}</dd>`).join('');
    const pdf = enlaceSeguro(f.respaldoUrl);
    $('#rgPdf').hidden = pdf === '#';
    $('#rgPdf').href = pdf;
    const listo = !x.cargando && !x.error && !!x.deshacer, puede = listo && x.deshacer.permitido;
    $('#rgCorregir').hidden = anulado;
    $('#rgCorregir').disabled = !listo || x.fichaLeida === false || !!x.operando;
    $('#rgCorregir').lastChild.textContent = x.cargando ? 'Cargando…' : 'Corregir datos';
    $('#rgDeshacer').hidden = anulado || (listo && !puede);
    $('#rgDeshacer').disabled = !puede || !!x.operando;
    $('#rgAnular').hidden = anulado || !listo || puede;
    $('#rgAnular').disabled = !!x.operando;
    $('#rgAyuda').hidden = anulado || (listo && !puede);
    const aviso = x.cargando ? '' : x.error ? x.error
      : anulado ? 'Registro anulado: queda tachado en la planilla como respaldo.'
        : x.fichaLeida === false ? 'No se pudo leer la ficha del registro en Drive: para corregirlo, vuelve a abrirlo en un rato.'
          : x.deshacer && !x.deshacer.permitido ? `No se puede deshacer: ${x.deshacer.motivo}. Puedes corregir los datos o anularlo indicando el motivo.` : '';
    $('#rgAviso').hidden = !aviso;
    $('#rgAvisoTexto').textContent = aviso;
  }

  /** Observaciones sin la línea "Reembolso: …" (la escribe el servidor). */
  const sinLineaReembolso = s => String(s || '').split(' · ').filter(x => !/^Reembolso( pendiente)?:/.test(x.trim())).join(' · ');

  const IDS_FORMULARIO = ['fFecha', 'fMonto', 'fTipo', 'fNumero', 'fProveedor', 'fRazon', 'fRut', 'fMedio', 'fCeco', 'fDetalle', 'fRinde', 'fObs',
    'fEmpresa', 'fAsistentes', 'fMotivo', 'fReNombre', 'fReRut', 'fReFecha', 'fReOperacion'];

  /** Copia del formulario de la captura en curso: la corrección usa el mismo formulario y al salir se devuelve tal cual. */
  function fotoFormulario() {
    const valores = {};
    IDS_FORMULARIO.forEach(id => { valores[id] = document.getElementById(id).value; });
    return { valores, categoria: est.categoria, movimiento: est.movimiento, tocados: new Set(est.tocados), lecturaOculta: $('#lectura').hidden,
      reembolso: est.reembolso, medioSinReembolso: est.medioSinReembolso };
  }

  function llenarFormulario(d, representacion, reembolso) {
    const poner = (id, v) => { document.getElementById(id).value = v === undefined || v === null ? '' : v; };
    const asegurarOpcion = (sel, v) => { if (v && !opciones(sel).includes(v)) $(sel).insertAdjacentHTML('beforeend', `<option>${esc(v)}</option>`); };
    asegurarOpcion('#fTipo', d.tipoDoc);
    asegurarOpcion('#fMedio', d.medio);
    ponerCeco(d.ceco);
    const rep = representacion || {};
    [['fFecha', d.fecha], ['fMonto', d.monto ? miles(d.monto) : ''], ['fTipo', d.tipoDoc], ['fNumero', d.numero], ['fProveedor', d.proveedor],
      ['fRazon', d.razonSocial],
      ['fRut', d.rut], ['fMedio', d.medio], ['fCeco', d.ceco], ['fDetalle', d.detalle], ['fRinde', d.rinde], ['fObs', d.observaciones],
      ['fEmpresa', rep.empresa], ['fAsistentes', rep.asistentes], ['fMotivo', rep.motivo]].forEach(([id, v]) => poner(id, v));
    const re = reembolso || {};
    [['fReNombre', re.nombre], ['fReRut', re.rut], ['fReFecha', re.fecha], ['fReOperacion', re.operacion]].forEach(([id, v]) => poner(id, v));
    $('#fReRut').dataset.auto = '';
    est.reembolso = !!reembolso;
    est.categoria = d.categoria || '';
    est.movimiento = d.movimiento || 'Desembolso MP';
  }

  function entrarEdicion() {
    const x = est.registro;
    if (!x || x.cargando || x.error || x.operando || x.fichaLeida === false || est.edicion) return;
    const f = x.registro;
    est.edicion = { id: f.id, original: f, representacion: x.representacion, reembolso: x.reembolso || null, previo: fotoFormulario() };
    prepararDatos();
    $$('.sugerido, .invalido').forEach(el => el.classList.remove('sugerido', 'invalido'));
    llenarFormulario(f, x.representacion, x.reembolso);
    $('#fObs').value = sinLineaReembolso(f.observaciones);
    est.medioSinReembolso = '';
    est.tocados = new Set(Object.values(CAMPOS));      // mientras se corrige no se autocompleta nada
    elegirMovimiento(est.movimiento);
    validarRut();
    validarReRut();
    validarCeco();
    ['#lectura', '#sugMonto', '#controlTarjeta', '#campoRinde', '#grupoFrecuentes'].forEach(s => { $(s).hidden = true; });
    $('#segMovimiento').classList.add('bloqueado');
    $('#provEstado').textContent = '';
    $('#avisoEdicion').hidden = false;
    $('#textoEdicion').textContent = f.estado === 'Pendiente revisión' || f.estado === 'Observado'
      ? 'Corrige lo que necesites. El tipo de movimiento no se cambia: si está mal, deshaz el registro.'
      : `Este registro ya está ${String(f.estado || '').toLowerCase()}: si cambias monto, fecha, medio de pago u otro dato del documento, volverá a revisión (Observado).`;
    $('#btnGuardar').textContent = 'Guardar cambios';
    ir('datos');
  }

  function salirEdicion() {
    const previo = est.edicion && est.edicion.previo;
    est.edicion = null;
    $('#segMovimiento').classList.remove('bloqueado');
    $('#avisoEdicion').hidden = true;
    $('#campoRinde').hidden = false;
    $('#btnGuardar').textContent = 'Guardar en Drive';
    $$('.sugerido, .invalido').forEach(el => el.classList.remove('sugerido', 'invalido'));
    $('#rutEstado').textContent = '';
    $('#cecoEstado').textContent = '';
    $('#reRutEstado').textContent = '';
    if (!previo) { pintarReembolso(); return; }
    est.categoria = previo.categoria;
    est.movimiento = previo.movimiento;
    est.tocados = previo.tocados;
    est.reembolso = !!previo.reembolso;
    est.medioSinReembolso = previo.medioSinReembolso || '';
    if (hayDocumento()) elegirMovimiento(est.movimiento);
    Object.keys(previo.valores).forEach(id => { document.getElementById(id).value = previo.valores[id]; });
    $('#lectura').hidden = previo.lecturaOculta;
    pintarReembolso();
    if (hayDocumento()) { pintarCategorias(); pintarControlTarjeta(); revisarMonto(); }
  }

  /** Solo los campos que cambiaron respecto de la planilla. */
  function cambiosEdicion(d) {
    const o = est.edicion.original, c = {};
    const texto = v => String(v === undefined || v === null ? '' : v).replace(/\s+/g, ' ').trim();
    // En un ingreso no se ven categoría ni CeCo: no se tocan (A&F pudo haberlos completado)
    const campos = ['fecha', 'monto', 'tipoDoc', 'numero', 'proveedor', 'razonSocial', 'rut', 'detalle', 'medio', 'observaciones']
      .concat(GASTOS.includes(d.movimiento) ? ['categoria', 'ceco'] : []);
    campos.forEach(k => { if (texto(d[k]) !== texto(k === 'observaciones' ? sinLineaReembolso(o[k]) : o[k])) c[k] = d[k]; });
    const rep = x => (x && (x.empresa || x.asistentes || x.motivo) ? [x.empresa, x.asistentes, x.motivo].map(texto).join('|') : '');
    if (rep(d.representacion) !== rep(est.edicion.representacion)) c.representacion = d.representacion;
    const rutDe = v => { const r = rutInfo(v || ''); return r ? r.texto : texto(v); };
    const re = x => (x && x.nombre ? [texto(x.nombre), rutDe(x.rut), texto(x.fecha), texto(x.operacion)].join('|') : '');
    if (re(d.reembolso) !== re(est.edicion.reembolso)) c.reembolso = d.reembolso;
    return c;
  }

  async function guardarEdicion() {
    if (est.guardando || !est.edicion) return;
    const d = leerFormulario(), error = validar(d);
    if (error) { toast(error); return; }
    const cambios = cambiosEdicion(d), id = est.edicion.id;
    if (!Object.keys(cambios).length) { toast('No hay cambios que guardar'); return; }
    const boton = $('#btnGuardar');
    est.guardando = true;
    boton.disabled = true;
    boton.textContent = 'Guardando cambios…';
    try {
      await Api.llamar('actualizar', { id, cambios, por: Api.config().nombre || 'App', registrado: est.edicion.original.registrado });
      est.guardando = false;
      if (est.ultimo && est.ultimo.id === id) {          // "Deshacer → Sí, corregir" debe retomar lo ya corregido
        const propios = Object.assign({}, cambios);
        if (propios.observaciones !== undefined) {     // las alertas las pone el servidor, no quien rinde
          propios.observaciones = String(propios.observaciones).split(' · ').filter(s => !/^(Alerta|Anulado|Reembolso|Reembolso pendiente):/.test(s.trim())).join(' · ');
        }
        Object.assign(est.ultimo.datos, propios);
        if (cambios.categoria !== undefined) est.ultimo.categoria = cambios.categoria;
      }
      toast('Corrección guardada ✓');
      refrescarResumen(false);
      history.back();                       // vuelve a la ficha, que se recarga con los datos nuevos
      recargarRegistro(id);
    } catch (e) {
      toast('No se pudo guardar: ' + e.message, 6000);
    } finally {
      est.guardando = false;
      boton.disabled = false;
      if (est.edicion) boton.textContent = 'Guardar cambios';
    }
  }

  async function deshacerRegistro() {
    const x = est.registro;
    if (!x || !x.deshacer || !x.deshacer.permitido) return;
    const f = x.registro;
    const si = await preguntar('Deshacer registro',
      `${f.id} · ${f.proveedor || f.detalle || ''} · ${clp(f.monto)}\nSe quita de la planilla, y el PDF y su ficha van a la papelera de Drive (se recuperan durante 30 días).`,
      'Deshacer', 'Cancelar');
    if (!si || est.registro !== x) return;
    x.operando = true;                     // mientras tanto no se corrige, ni se anula, ni se sale con "atrás"
    est.guardando = true;
    pintarRegistro();
    let r;
    try {
      r = await Api.llamar('deshacer', { id: f.id, por: Api.config().nombre || 'App', registrado: f.registrado });
    } catch (e) {
      // Google a veces responde con error aunque ya lo hizo: si el registro ya no existe, quedó deshecho
      let hecho = false;
      if (e.codigo !== 'config' && e.codigo !== 'clave') {
        try { await Api.llamar('registro', { id: f.id }); } catch (e2) { hecho = /No existe el registro/.test(e2.message || ''); }
      }
      if (!hecho) {
        est.guardando = false;
        x.operando = false;
        toast('No se pudo deshacer: ' + e.message, 6000);
        recargarRegistro(f.id);
        return;
      }
      r = { correlativoLiberado: false, advertencia: null };
    }
    est.guardando = false;
    est.registro = null;
    refrescarResumen(false);
    if (r.advertencia) toast(r.advertencia, 6000);
    if (est.ultimo && est.ultimo.id === f.id) {
      const corregir = await preguntar('Registro deshecho', 'Las fotos y los datos siguen en el teléfono. ¿Quieres corregirlos y volver a guardarlo?', 'Sí, corregir', 'No');
      if (corregir) { volverInicio(retomarUltimo); return; }
      soltarUltimo();
    }
    if (!r.advertencia) toast(`${f.id} deshecho ✓${r.correlativoLiberado ? ' · el número queda libre' : ''}`, 5000);
    if (est.vista === 'registro') volverInicio();
  }

  /** Vuelve a la captura recién deshecha: mismas fotos y datos, lista para corregir y guardar de nuevo. */
  function retomarUltimo() {
    const u = est.ultimo;
    if (!u) return;
    est.ultimo = null;
    nuevaCaptura();
    Object.assign(est, { paginas: u.paginas, pdf: u.pdf, origen: u.origen, capturadoEn: u.capturadoEn, lectura: u.lectura,
      tira: u.tira, modoTira: u.modoTira || 'auto' });
    $('#chkUnir').checked = !!u.unir;
    guardarSesion();
    if (est.paginas.length) { pintarPaginas(); ir('paginas'); }
    ir('datos');
    prepararDatos();
    llenarFormulario(u.datos, u.datos.representacion, u.datos.reembolso);
    est.categoria = u.categoria;
    est.tocados = u.tocados;
    elegirMovimiento(u.movimiento);
    llenarFormulario(u.datos, u.datos.representacion, u.datos.reembolso);     // elegirMovimiento pudo cambiar el medio sugerido
    est.categoria = u.categoria;
    pintarCategorias();
    pintarReembolso();
    validarRut();
    validarReRut();
    validarCeco();
    est.plantilla = u.plantilla || null;
    est.plantillaAplicada = u.plantillaAplicada || null;
    pintarPlantillas();
    if (est.lectura) { pintarLectura(est.lectura.sugeridos && est.lectura.sugeridos.fecha ? 'ok' : 'ok-sin-fecha'); pintarControlTarjeta(); revisarMonto(); }
    guardarFormulario();
  }

  async function anularRegistro() {
    const x = est.registro;
    if (!x || x.cargando || x.error) return;
    const f = x.registro;
    const motivo = await preguntar('Anular registro',
      `${f.id} · ${clp(f.monto)}\nQueda tachado en la planilla y sus archivos se renombran con "ANULADO". No se borra nada.`,
      'Anular', 'Cancelar', { placeholder: 'Motivo (obligatorio)' });
    if (!motivo || est.registro !== x) return;
    x.operando = true;
    est.guardando = true;
    pintarRegistro();
    let error = null;
    try {
      await Api.llamar('anular', { id: f.id, motivo, por: Api.config().nombre || 'App', registrado: f.registrado });
    } catch (e) {
      error = e;
    } finally {
      est.guardando = false;
      x.operando = false;
    }
    await recargarRegistro(f.id);
    // Se confirma con la planilla: Google a veces responde con error aunque el cambio ya quedó
    if (est.registro === x && x.registro.estado === 'Anulado') {
      toast(`${f.id} anulado ✓`);
      refrescarResumen(false);
    } else if (error) {
      toast('No se pudo anular: ' + error.message, 6000);
    }
  }

  // ---------- Entrega y devolución de la tarjeta: acta con momento, lugar y firma de ambos ----------

  const IDS_ENTREGA = ['eUltimos4', 'eEntregaNombre', 'eEntregaRut', 'eEntregaCargo', 'eRecibeNombre', 'eRecibeRut', 'eRecibeCargo',
    'eRecibeCorreo', 'eLugar', 'eSaldo', 'eDevolucionPrevista', 'eMotivo'];
  // Campos que aparecen en la declaración: si cambian después de firmar, hay que volver a firmar
  const IDS_DECLARACION = ['eUltimos4', 'eEntregaNombre', 'eEntregaRut', 'eRecibeNombre', 'eRecibeRut', 'eLugar', 'eSaldo', 'eDevolucionPrevista', 'eMotivo'];
  const valor = id => document.getElementById(id).value.trim();
  const normalNombre = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/\s+/g, ' ').trim();
  const mismoNombre = (a, b) => !!normalNombre(a) && normalNombre(a) === normalNombre(b);
  const dos = n => String(n).padStart(2, '0');
  // Guion y espacio que no se cortan al final de la línea ("29-10 14:54" queda junto)
  const fechaHoraCorta = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${dos(d.getDate())}‑${dos(d.getMonth() + 1)} ${dos(d.getHours())}:${dos(d.getMinutes())}`; };
  const plural = (n, uno, varios) => `${n} ${n === 1 ? uno : varios}`;
  let firmas = null, relojDeclaracion = null, flujoQr = null, abriendoQr = false, relojBorrador = null;

  function guardarHuellas(h) {
    est.huellasQr = h && typeof h === 'object' ? h : {};
    guardarLocal('huellasQr', est.huellasQr);
  }

  /** La tarjeta MP de la empresa (la configurada en Ajustes) y quién la tiene ahora. */
  function custodiaActual() {
    const mp = String((est.tarjetas && est.tarjetas.mp) || '').replace(/\D/g, '');
    return est.custodia.find(c => c.ultimos4 === mp) || est.custodia[0] || null;
  }

  /** Quién tiene la tarjeta según el servidor; un acta guardada en el teléfono y aún sin enviar manda (queda "pendiente de envío"). */
  function pintarCustodia(lista, pendientes) {
    est.custodia = Array.isArray(lista) ? lista : [];
    guardarLocal('custodia', est.custodia);
    if (pendientes) est.actasPendientes = pendientes;
    const c = custodiaActual(), mp = String((est.tarjetas && est.tarjetas.mp) || '').replace(/\D/g, '');
    const u4 = (c && c.ultimos4) || mp;
    const pendiente = (est.actasPendientes || []).filter(p => p.tarjeta && p.tarjeta.ultimos4 === u4)
      .sort((a, b) => String(a.momento).localeCompare(String(b.momento))).pop();
    $('#custodiaTarjeta').textContent = u4 ? `Tarjeta MP ****${u4}` : 'Tarjeta Mercado Pago';
    $('#custodiaTitular').textContent = pendiente ? `En poder de ${pendiente.recibe.nombre} (acta pendiente de envío)`
      : c ? `En poder de ${c.titular} desde ${fechaHoraCorta(c.desde)}` : 'Sin entregas registradas';
    $('#btnEntrega').textContent = tipoSugerido() === 'Devolución' ? 'Recibir' : 'Entregar';
  }

  /** Si la tarjeta la tiene otra persona, lo natural es recibirla (devolución); si no, entregarla. */
  function titularActual() {
    const c = custodiaActual(), u4 = c ? c.ultimos4 : '';
    const pendiente = (est.actasPendientes || []).filter(p => p.tarjeta && (!u4 || p.tarjeta.ultimos4 === u4))
      .sort((a, b) => String(a.momento).localeCompare(String(b.momento))).pop();
    return pendiente ? pendiente.recibe.nombre : c ? c.titular : '';
  }

  function tipoSugerido() {
    const t = titularActual();
    return t && !mismoNombre(t, Api.config().nombre) ? 'Devolución' : 'Entrega';
  }

  function prepararFirmas() {
    if (!firmas) {
      const alCambiar = f => {
        const caja = f.canvas.closest('.firma');
        caja.classList.toggle('firmada', f.valida());
        caja.classList.remove('invalido');
        if (est.entrega && f.trazos.length) tocarEntrega();
      };
      firmas = { entrega: new Custodia.Firma($('#firmaEntrega'), alCambiar), recibe: new Custodia.Firma($('#firmaRecibe'), alCambiar) };
    }
    firmas.entrega.preparar();
    firmas.recibe.preparar();
  }

  // ---- Borrador del acta: se guarda en el teléfono mientras se llena (si Android cierra la app, nada se pierde) ----

  async function leerBorrador() {
    try { return await DB.leer('sesion', 'acta'); } catch (e) { return null; }
  }

  function borrarBorrador() {
    clearTimeout(relojBorrador);
    DB.borrar('sesion', 'acta').catch(() => {});
    $('#avisoActa').hidden = true;
  }

  async function guardarBorrador() {
    clearTimeout(relojBorrador);
    const e = est.entrega;
    if (!e || !e.tocado || e.enviando) return;
    const campos = {};
    IDS_ENTREGA.forEach(id => { campos[id] = document.getElementById(id).value; });
    const autos = IDS_ENTREGA.filter(id => document.getElementById(id).dataset.auto === '1');
    const datos = {
      tipo: e.tipo, idCliente: e.idCliente, qr: e.qr, ubicacion: e.ubicacion, foto: e.foto || null, campos, autos,
      conforme: $('#eConforme').checked, momentoLeido: e.momentoLeido || null,
      firmas: firmas ? { entrega: firmas.entrega.datos(), recibe: firmas.recibe.datos() } : null, guardado: new Date().toISOString()
    };
    try { await DB.guardar('sesion', 'acta', datos); } catch (err) { /* sin espacio: el acta sigue en pantalla */ }
  }

  /** Marca el acta como empezada (desde aquí se guarda como borrador). */
  function tocarEntrega() {
    const e = est.entrega;
    if (!e) return;
    e.tocado = true;
    clearTimeout(relojBorrador);
    relojBorrador = setTimeout(guardarBorrador, 500);
  }

  async function revisarBorrador() {
    const b = await leerBorrador();
    $('#avisoActa').hidden = !b || est.vista !== 'inicio';
    if (b) $('#textoActa').textContent = `Tienes un acta de ${b.tipo === 'Devolución' ? 'devolución' : 'entrega'} sin terminar.`;
  }

  /** Botón Entregar/Recibir: si hay un acta a medio llenar, se ofrece seguirla. */
  async function pedirEntrega() {
    if (est.vista !== 'inicio' || Date.now() < (est.bloqueoToques || 0)) return;
    const b = await leerBorrador();
    if (b) {
      const seguir = await preguntar('Acta sin terminar', `Tienes un acta de ${b.tipo === 'Devolución' ? 'devolución' : 'entrega'} a medio llenar. ¿Quieres seguirla?`, 'Seguir esa', 'Empezar otra');
      if (seguir) { abrirEntrega(b.tipo, b); return; }
      borrarBorrador();
    }
    abrirEntrega(tipoSugerido());
  }

  function abrirEntrega(tipo, borrador) {
    if (est.vista !== 'inicio') return;
    soltarEntrega();
    $('#avisoActa').hidden = true;
    const b = borrador || null;
    est.entrega = { tipo, qr: b ? b.qr : null, ubicacion: b ? b.ubicacion : null, foto: null, fotoUrl: null, fotoProceso: null,
      idCliente: b ? b.idCliente : nuevoIdCliente(), enviando: false, tocado: !!b, momentoLeido: b ? b.momentoLeido : null };
    IDS_ENTREGA.forEach(id => { document.getElementById(id).value = b && b.campos ? b.campos[id] || '' : ''; });
    $$('#v-entrega .invalido').forEach(el => el.classList.remove('invalido'));
    $('#eEntregaRutEstado').textContent = $('#eRecibeRutEstado').textContent = '';
    $('#eConforme').checked = !!(b && b.conforme);
    $('#eFotoMini').hidden = true;
    $('#eFotoTexto').textContent = 'Foto del momento (opcional)';
    if (b && b.foto) mostrarFotoEntrega(b.foto);
    IDS_ENTREGA.forEach(id => { document.getElementById(id).dataset.auto = b && (b.autos || []).includes(id) ? '1' : ''; });
    if (!b) {
      const yo = yoCompleto(), c = custodiaActual(), mp = String((est.tarjetas && est.tarjetas.mp) || '').replace(/\D/g, '');
      $('#eUltimos4').value = (c && c.ultimos4) || mp || '';
      // Datos propuestos (de Ajustes o de la base de personas): elegir a otra persona los reemplaza
      const persona = (pre, p) => {
        [['Nombre', p.nombre], ['Rut', p.rut], ['Cargo', p.cargo]].forEach(([k, v]) => { const el = $(`#e${pre}${k}`); el.value = v || ''; el.dataset.auto = v ? '1' : ''; });
      };
      if (tipo === 'Devolución') { const t = titularActual(); persona('Entrega', buscarPersona(t) || { nombre: t }); persona('Recibe', yo); }
      else persona('Entrega', yo);
    }
    pintarQrEstado(b && b.qr ? 'QR leído ✓' : 'Sin escanear', b && b.qr ? 'ok' : '');
    pintarTipoEntrega();
    ir('entrega');
    requestAnimationFrame(() => {
      prepararFirmas();
      if (b && b.firmas) { firmas.entrega.cargar(b.firmas.entrega); firmas.recibe.cargar(b.firmas.recibe); }
      else { firmas.entrega.borrar(); firmas.recibe.borrar(); }
      pintarDeclaracion();
    });
    relojDeclaracion = setInterval(pintarDeclaracion, 5000);    // la hora visible avanza con el reloj hasta que ambos confirman
    pintarUbicacion();
    if (!b || !b.ubicacion || b.ubicacion.error) buscarUbicacion();
  }

  /** Al salir de la pantalla del acta: si se había empezado, queda guardada como borrador (el inicio la ofrece). */
  function soltarEntrega() {
    const e = est.entrega;
    if (e && e.tocado && !e.enviando) guardarBorrador();
    if (e && e.fotoUrl) URL.revokeObjectURL(e.fotoUrl);
    est.entrega = null;
  }

  function nuevoIdCliente() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  function pintarTipoEntrega() {
    const e = est.entrega, devolucion = e.tipo === 'Devolución';
    $$('#segEntrega button').forEach(b => b.setAttribute('aria-checked', String(b.dataset.valor === e.tipo)));
    $('#tituloEntrega').textContent = devolucion ? 'Entrega (quien devuelve)' : 'Entrega';
    $('#tituloRecibe').textContent = 'Recibe';
    $('#campoUso').hidden = devolucion;
    $('#campoDevolucion').hidden = devolucion;
    $('#btnRegistrarEntrega').textContent = devolucion ? 'Registrar devolución' : 'Registrar entrega';
    if (est.vista === 'entrega') $('#tituloVista').textContent = devolucion ? 'Devolución de tarjeta' : 'Entrega de tarjeta';
    pintarDeclaracion();
  }

  /** Las firmas valen para el texto que se leyó: si cambia algo de la declaración, se borran y se desmarca la conformidad. */
  function invalidarFirmas(aviso) {
    const firmado = firmas && (firmas.entrega.trazos.length || firmas.recibe.trazos.length);
    const confirmado = $('#eConforme').checked;
    if (!firmado && !confirmado) return;
    if (firmas) { firmas.entrega.borrar(); firmas.recibe.borrar(); }
    $('#eConforme').checked = false;
    if (est.entrega) est.entrega.momentoLeido = null;
    toast(aviso || 'Cambió el acta: firmen y confirmen de nuevo');
  }

  /** Cambiar entre entrega y devolución intercambia a las personas (el correo era de quien recibía: se limpia). */
  function cambiarTipoEntrega(tipo) {
    const e = est.entrega;
    if (!e || e.tipo === tipo) return;
    e.tipo = tipo;
    ['Nombre', 'Rut', 'Cargo'].forEach(k => {
      const a = $(`#eEntrega${k}`), b = $(`#eRecibe${k}`), t = a.value, ta = a.dataset.auto;
      a.value = b.value;
      b.value = t;
      a.dataset.auto = b.dataset.auto || '';
      b.dataset.auto = ta || '';
    });
    $('#eRecibeCorreo').value = '';
    $('#eRecibeCorreo').dataset.auto = '';
    ['eEntregaRut', 'eRecibeRut'].forEach(pintarEstadoRut);
    invalidarFirmas('Se borraron las firmas: firmen de nuevo');
    pintarTipoEntrega();
    tocarEntrega();
  }

  function pintarEstadoRut(id) {
    const el = document.getElementById(id), s = document.getElementById(id + 'Estado'), r = rutInfo(el.value);
    if (!el.value.trim()) { s.textContent = ''; s.className = ''; return; }
    if (r) el.value = r.texto;
    s.textContent = r && r.ok ? 'RUT válido' : 'RUT no válido';
    s.className = r && r.ok ? 'ok' : 'alerta';
  }

  function pintarQrEstado(texto, clase) {
    const el = $('#eQrEstado');
    el.textContent = texto;
    el.className = 'qr-estado' + (clase ? ' ' + clase : '');
  }

  function textoDeclaracion(momento) {
    const e = est.entrega, d = momento || new Date();
    const u4 = soloDigitos(valor('eUltimos4')).slice(0, 4), textoSaldo = valor('eSaldo');
    const fecha = `${d.getDate()} de ${MESES[d.getMonth()]} de ${d.getFullYear()}`, hora = `${dos(d.getHours())}:${dos(d.getMinutes())}`;
    const quien = (n, r) => `${n || '________'}${r ? `, RUT ${r}` : ''}`;
    const tarjeta = `la tarjeta Mercado Pago terminada en ${u4 || '____'}${textoSaldo !== '' ? `, con un saldo de ${clp(Number(soloDigitos(textoSaldo)))}` : ''}`;
    const base = `Yo, ${quien(valor('eRecibeNombre'), valor('eRecibeRut'))}, recibo de ${quien(valor('eEntregaNombre'), valor('eEntregaRut'))}, `
      + `${tarjeta}, en ${valor('eLugar') || '________'}, el ${fecha} a las ${hora}. `;
    const datos = 'Ambos autorizamos el registro de estos datos (incluidos lugar, firmas y foto) para el control de la tarjeta.';
    if (e && e.tipo === 'Devolución') {
      return base + 'Quien devuelve declara haber rendido en la App Caja Chica los gastos hechos con ella, o entregar ahora sus respaldos. ' + datos;
    }
    const uso = valor('eMotivo'), plazo = valor('eDevolucionPrevista');
    return base + `Me comprometo a usarla solo en gastos de Servicios de Telecomunicaciones SpA${uso ? ` (${uso})` : ''}, `
      + `a rendir cada gasto con su respaldo en la App Caja Chica y a devolverla cuando se me solicite${plazo ? ` o a más tardar el ${fechaCorta(plazo)}` : ''}. `
      + 'Quien entrega declara que la tarjeta está en buen estado. ' + datos;
  }

  /** La hora de la declaración avanza con el reloj hasta que ambos confirman; desde ahí queda fija y es la que se registra. */
  function pintarDeclaracion() {
    const e = est.entrega;
    if (!e || est.vista !== 'entrega') return;
    const texto = textoDeclaracion(e.momentoLeido ? new Date(e.momentoLeido) : new Date());
    if ($('#eDeclaracion').textContent !== texto) $('#eDeclaracion').textContent = texto;
  }

  async function buscarUbicacion() {
    const e = est.entrega;
    if (!e) return;
    e.buscandoUbicacion = true;
    pintarUbicacion();
    // Cada lectura mejor se usa al tiro (bajo techo el GPS puede no bajar de ±60 m); "Reintentar" no borra la anterior
    const r = await Custodia.ubicar(12000, mejor => {
      if (est.entrega !== e) return;
      e.ubicacion = mejor;
      pintarUbicacion();
    });
    if (est.entrega !== e) return;
    e.buscandoUbicacion = false;
    if (!r.error || !e.ubicacion || e.ubicacion.error) e.ubicacion = r.error && e.ubicacion && !e.ubicacion.error ? e.ubicacion : r;
    pintarUbicacion();
    if (e.tocado) guardarBorrador();
  }

  function pintarUbicacion() {
    const e = est.entrega, u = e && e.ubicacion, el = $('#eUbicacion'), t = $('#eUbicacionTexto');
    if (!u || (u.error && e.buscandoUbicacion)) {
      el.className = 'control info';
      t.textContent = 'Buscando la ubicación…';
    } else if (u.error) {
      el.className = 'control alerta';
      t.textContent = `${u.error}: escribe el lugar con detalle`;
    } else {
      el.className = 'control ' + (u.precision > 200 ? 'revisar' : 'ok');
      t.innerHTML = `Ubicación registrada (±${Number(u.precision)} m)${e.buscandoUbicacion ? ', mejorando…' : ''} · `
        + `<a href="https://maps.google.com/?q=${Number(u.lat)},${Number(u.lon)}" target="_blank" rel="noopener">ver mapa</a>`;
    }
    $('#btnReubicar').hidden = !u || !!(e && e.buscandoUbicacion);
  }

  // Lector del QR de la tarjeta (cámara dentro de la app)
  async function abrirLectorQr() {
    if (abriendoQr || flujoQr || !est.entrega || est.capa) return;
    abriendoQr = true;                     // un doble toque no abre dos cámaras
    try {
      if (!(await Custodia.lectorDisponible())) {
        toast('Este teléfono no lee códigos QR desde la app: escribe los 4 últimos dígitos', 6000);
        $('#eUltimos4').focus();
        return;
      }
      try {
        flujoQr = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } } });
      } catch (e) {
        flujoQr = null;
        toast(e.name === 'NotAllowedError' ? 'Sin permiso de cámara: escribe los 4 últimos dígitos' : 'No se pudo abrir la cámara: escribe los 4 últimos dígitos');
        return;
      }
      if (!est.entrega || est.vista !== 'entrega') { detenerQr(); return; }
      const video = $('#videoQr');
      video.srcObject = flujoQr;
      try { await video.play(); } catch (e) { /* se reintenta solo */ }
      $('#capaQr').hidden = false;
      abrirCapa('qr');
    } finally {
      abriendoQr = false;
    }
    let leido = null;
    try { leido = await Custodia.leerQr($('#videoQr'), () => est.capa !== 'qr'); } catch (e) { toast('No se pudo leer el QR: escribe los 4 últimos dígitos'); }
    if (est.capa === 'qr') cerrarCapa();
    if (leido && est.entrega) await usarQr(leido);
  }

  function detenerQr() {
    if (flujoQr) flujoQr.getTracks().forEach(t => t.stop());
    flujoQr = null;
    $('#videoQr').srcObject = null;
    $('#capaQr').hidden = true;
    est.bloqueoToques = Date.now() + 450;      // el segundo toque de un doble toque no cae en "Volver"
  }

  /**
   * Del QR nunca sale su texto. Si trae el número de la tarjeta, solo se usan sus 4 últimos dígitos (sin huella: un número
   * de tarjeta se podría reconstruir desde su huella). Si es otra cosa, su huella SHA-256 identifica la tarjeta física.
   */
  async function usarQr(texto) {
    const e = est.entrega, a = Custodia.analizarQr(texto);
    const h = a.tipo === 'numero' ? '' : await Custodia.huella(texto);
    if (est.entrega !== e) return;
    const anterior = soloDigitos(valor('eUltimos4'));
    e.qr = a.tipo === 'numero' ? { tipo: 'numero' } : { huella: h, tipo: a.tipo };
    const conocida = h ? est.huellasQr[h] || '' : '', u4 = a.ultimos4 || conocida;
    if (u4) $('#eUltimos4').value = u4;
    if (navigator.vibrate) navigator.vibrate(30);
    if (conocida) pintarQrEstado(`Tarjeta ****${conocida} reconocida ✓`, 'ok');
    else if (a.ultimos4) pintarQrEstado(`Tarjeta ****${a.ultimos4} leída ✓`, 'ok');
    else pintarQrEstado('QR leído ✓ Confirma los 4 dígitos: quedará asociado a esta tarjeta', 'alerta');
    if (u4 && u4 !== anterior) invalidarFirmas();
    tocarEntrega();
    pintarDeclaracion();
  }

  function mostrarFotoEntrega(blob) {
    const e = est.entrega;
    if (e.fotoUrl) URL.revokeObjectURL(e.fotoUrl);
    e.foto = blob;
    e.fotoUrl = URL.createObjectURL(blob);
    $('#eFotoMini').src = e.fotoUrl;
    $('#eFotoMini').hidden = false;
    $('#eFotoTexto').textContent = 'Cambiar la foto';
  }

  /** La foto se achica a ~2,5 MP. Mientras se procesa, Registrar la espera (no se envía el acta sin ella). */
  function usarFotoEntrega(archivo) {
    const e = est.entrega;
    if (!e || !archivo) return;
    $('#eFotoTexto').textContent = 'Procesando la foto…';
    e.fotoProceso = (async () => {
      try {
        const c = await Escaner.cargar(archivo), k = Math.min(1, Math.sqrt(2.5e6 / (c.width * c.height)));
        const blob = await Escaner.aJpeg(k < 1 ? Escaner.escalar(c, Math.round(c.width * k)) : c, 0.85);
        if (est.entrega !== e) return;
        mostrarFotoEntrega(blob);
        tocarEntrega();
      } catch (err) {
        if (est.entrega === e) $('#eFotoTexto').textContent = e.foto ? 'Cambiar la foto' : 'Foto del momento (opcional)';
        toast('No se pudo usar la foto: ' + (err.message || 'formato no soportado'));
      } finally {
        if (est.entrega === e) e.fotoProceso = null;
      }
    })();
  }

  function validarEntrega() {
    $$('#v-entrega .invalido').forEach(el => el.classList.remove('invalido'));
    const e = est.entrega;
    const falla = (sel, mensaje) => {
      const el = $(sel);
      el.classList.add('invalido');
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return mensaje;
    };
    const u4 = soloDigitos(valor('eUltimos4'));
    if (u4.length !== 4) return falla('#eUltimos4', 'Faltan los últimos 4 dígitos de la tarjeta');
    const conocida = e.qr && e.qr.huella && est.huellasQr[e.qr.huella];
    if (conocida && conocida !== u4) return falla('#eUltimos4', `El QR escaneado es de la tarjeta ****${conocida}: revisa los dígitos o vuelve a escanear`);
    if (!valor('eEntregaNombre')) return falla('#eEntregaNombre', 'Falta el nombre de quien entrega');
    const rutEntrega = valor('eEntregaRut');
    if (rutEntrega && !(rutInfo(rutEntrega) || {}).ok) return falla('#eEntregaRut', 'Revisa el RUT de quien entrega (o déjalo vacío)');
    if (!valor('eRecibeNombre')) return falla('#eRecibeNombre', 'Falta el nombre de quien recibe');
    const r = rutInfo(valor('eRecibeRut'));
    if (!r || !r.ok) return falla('#eRecibeRut', e.tipo === 'Devolución' && !valor('eRecibeRut')
      ? 'Falta tu RUT (puedes dejarlo guardado en Ajustes)' : 'Falta el RUT de quien recibe, o no es válido');
    if (r.texto === '78.083.138-3') return falla('#eRecibeRut', 'Ese es el RUT de la empresa: va el de la persona');
    if (mismoNombre(valor('eEntregaNombre'), valor('eRecibeNombre'))) return falla('#eRecibeNombre', 'Quien entrega y quien recibe deben ser personas distintas');
    const correo = valor('eRecibeCorreo');
    if (correo && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo)) return falla('#eRecibeCorreo', 'Revisa el correo (o déjalo vacío)');
    if (!valor('eLugar')) return falla('#eLugar', 'Escribe el lugar de la entrega');
    if (e.tipo === 'Entrega') {
      if (!valor('eMotivo')) return falla('#eMotivo', 'Escribe el uso autorizado de la tarjeta');
      const plazo = valor('eDevolucionPrevista');
      if (plazo && plazo < hoyISO()) return falla('#eDevolucionPrevista', 'La devolución prevista no puede ser una fecha pasada');
    }
    if (!firmas.entrega.valida()) { $('#firmaEntrega').closest('.firma').classList.add('invalido'); return falla('#firmaEntrega', 'Falta la firma de quien entrega'); }
    if (!firmas.recibe.valida()) { $('#firmaRecibe').closest('.firma').classList.add('invalido'); return falla('#firmaRecibe', 'Falta la firma de quien recibe'); }
    if (!$('#eConforme').checked) return falla('#eConforme', 'Confirmen que ambos leyeron la declaración');
    return null;
  }

  /**
   * Registrar: el acta se guarda PRIMERO en el teléfono (cola) y recién después se envía. Si Android cierra la app o no
   * hay señal, queda en la cola y se envía sola (el idCliente evita duplicados). Se espera hasta 45 s: el servidor tarda
   * unos 15 s en armar el acta.
   */
  async function registrarEntrega() {
    const e = est.entrega;
    if (!e || e.enviando || est.guardando) return;
    ['eEntregaRut', 'eRecibeRut'].forEach(id => { const r = rutInfo(valor(id)); if (r) document.getElementById(id).value = r.texto; });
    const boton = $('#btnRegistrarEntrega'), textoBoton = boton.textContent;
    if (e.fotoProceso) {
      boton.disabled = true;
      boton.textContent = 'Procesando la foto…';
      await e.fotoProceso;
      boton.disabled = false;
      boton.textContent = textoBoton;
      if (est.entrega !== e) return;
    }
    const error = validarEntrega();
    if (error) { toast(error); return; }
    e.enviando = true;
    est.guardando = true;
    boton.disabled = true;
    boton.textContent = 'Registrando…';
    let enviada = false;
    try {
      // Ubicación vieja (más de 5 min) o sin GPS: se intenta una lectura nueva corta antes de registrar
      const u = e.ubicacion, vieja = !u || u.error || (Date.now() - new Date(u.ubicadoEn).getTime() > 5 * 60000);
      if (vieja) {
        const nueva = await Custodia.ubicar(6000);
        if (!nueva.error || !u || u.error) e.ubicacion = nueva.error && u && !u.error ? u : nueva;
      }
      const momento = e.momentoLeido ? new Date(e.momentoLeido) : new Date(), textoSaldo = valor('eSaldo');
      const payload = {
        idCliente: e.idCliente,
        tipo: e.tipo,
        tarjeta: Object.assign({ ultimos4: soloDigitos(valor('eUltimos4')) },
          e.qr ? (e.qr.huella ? { qrHuella: e.qr.huella, qrTipo: e.qr.tipo } : { qrTipo: e.qr.tipo }) : {}),
        entrega: { nombre: valor('eEntregaNombre'), rut: valor('eEntregaRut'), cargo: valor('eEntregaCargo') },
        recibe: { nombre: valor('eRecibeNombre'), rut: valor('eRecibeRut'), cargo: valor('eRecibeCargo'), correo: valor('eRecibeCorreo') },
        lugar: Object.assign({ texto: valor('eLugar') }, e.ubicacion || { error: 'Ubicación no disponible' }),
        momento: momento.toISOString(),
        declaracion: textoDeclaracion(momento),
        firmas: { entrega: firmas.entrega.aPng(), recibe: firmas.recibe.aPng() },
        meta: { versionApp: VERSION, dispositivo: navigator.userAgent, origen: 'app' }
      };
      if (textoSaldo !== '') payload.saldo = Number(soloDigitos(textoSaldo));
      if (e.tipo === 'Entrega') {
        payload.motivo = valor('eMotivo');
        if (valor('eDevolucionPrevista')) payload.devolucionPrevista = valor('eDevolucionPrevista');
      }
      if (e.foto) payload.foto = await aBase64(e.foto);
      const idCola = await Api.encolar(payload, 'entregarTarjeta');
      borrarBorrador();                          // desde aquí el acta vive en la cola del teléfono
      recordarPersonas(payload);
      e.tocado = false;
      enviada = true;
      let r = null, enCola = null;
      try {
        if (!Api.configurada()) throw new Api.ErrorApi('La app aún no está vinculada', 'config');
        r = await Api.enviarUno(idCola, 45000);
      } catch (err) {
        if (err.codigo === 'red' || err.codigo === 'config' || err.codigo === 'clave') enCola = err.codigo;
        else {
          // El servidor la rechazó: vuelve a la pantalla para corregir (no queda en la cola)
          enviada = false;
          e.tocado = true;
          guardarBorrador();
          toast('No se pudo registrar: ' + err.message, 7000);
          return;
        }
      }
      est.guardando = false;
      soltarEntrega();
      mostrarActa(r, payload, enCola);
      if (r) refrescarResumen(false);
    } finally {
      est.guardando = false;
      if (!enviada) e.enviando = false;
      boton.disabled = false;
      boton.textContent = textoBoton;
    }
  }

  function mostrarActa(r, p, enCola) {
    const devolucion = p.tipo === 'Devolución', icono = $('#actaIcono');
    icono.classList.toggle('cola', !!enCola);
    icono.innerHTML = `<svg class="ico"><use href="#${enCola ? 'i-nube' : 'i-check'}"/></svg>`;
    $('#actaTitulo').textContent = enCola ? 'Acta guardada en el teléfono' : devolucion ? 'Devolución registrada' : 'Entrega registrada';
    $('#actaId').textContent = r ? `${r.id} · código ${r.codigo}${r.repetida ? ' · ya estaba registrada' : ''}` : '';
    // Quién la tiene: lo dice el servidor (un acta que llegó tarde puede no cambiar al titular)
    const titular = r && r.titular ? r.titular.nombre : p.recibe.nombre, u4 = r && r.titular ? r.titular.ultimos4 : p.tarjeta.ultimos4;
    $('#actaDetalle').textContent = enCola === 'config' ? 'Se enviará cuando vincules la app en Ajustes.'
      : enCola === 'clave' ? 'Se enviará cuando la clave de acceso esté al día (revisa Ajustes).'
        : enCola ? 'Se enviará sola apenas haya conexión, con la hora y el lugar de este momento.'
          : `La tarjeta ****${u4} queda en poder de ${titular}.`;
    const controles = $('#actaControles');
    controles.innerHTML = '';
    const agregar = (clase, ico, texto) => controles.insertAdjacentHTML('beforeend',
      `<div class="control ${clase}"><svg class="ico"><use href="#${ico}"/></svg><span>${esc(texto)}</span></div>`);
    if (r && r.advertencia) agregar('alerta', 'i-alerta', r.advertencia);
    if (r && r.esVigente === false) agregar('revisar', 'i-alerta', `Esta acta es anterior a la vigente: la tarjeta la tiene ${titular}`);
    if (r && r.direccion) agregar('info', 'i-ubicacion', r.direccion);
    if (r && r.periodo) {
      const pe = r.periodo, n = Number(pe.documentos) || 0, lim = pe.limite || {};
      const saldos = pe.saldoInicial !== null && pe.saldoInicial !== undefined && pe.saldoFinal !== null && pe.saldoFinal !== undefined
        ? ` · saldo al recibirla ${clp(pe.saldoInicial)}, al devolverla ${clp(pe.saldoFinal)}` : '';
      const limite = lim.documentos ? `, más ${plural(lim.documentos, 'gasto', 'gastos')} del día del traspaso por ${clp(lim.monto)}` : '';
      agregar('info', 'i-tarjeta', `Durante la custodia (${fechaHoraCorta(pe.desde)} → ${fechaHoraCorta(pe.hasta)}) `
        + `${n === 1 ? 'se registró 1 gasto' : `se registraron ${n} gastos`} con la tarjeta por ${clp(pe.monto)}${limite}${saldos}`);
    }
    ((r && r.alertas) || []).forEach(a => agregar('revisar', 'i-alerta', a));
    $('#lnkActa').href = enlaceSeguro(r && r.actaUrl);
    $('#lnkActaPlanilla').href = enlaceSeguro(r && r.planillaUrl);
    $('#actaEnlaces').hidden = !r;
    history.replaceState({ vista: 'acta', prof: profundidad() }, '');
    mostrar('acta');
    pintarCola();
    // El inicio muestra al titular al tiro (sin esperar al resumen del servidor)
    if (r && r.titular) {
      const otras = est.custodia.filter(c => c.ultimos4 !== r.titular.ultimos4);
      pintarCustodia(otras.concat([{ tarjeta: r.titular.tarjeta, ultimos4: r.titular.ultimos4, titular: r.titular.nombre, desde: r.titular.desde,
        id: r.titular.id, tipo: p.tipo }]));
    }
  }

  // ---------- Personas, rendiciones frecuentes y proveedores: llenar en un toque ----------
  // La base vive en la planilla Rendición Caja Chica (hojas Personas y Plantillas) y el servidor la entrega en config.

  const usoLocal = clave => leerLocal('uso.' + clave) || {};

  function contarUso(clave, nombre) {
    if (!nombre) return;
    const u = usoLocal(clave), k = normalNombre(nombre);
    u[k] = (u[k] || 0) + 1;
    guardarLocal('uso.' + clave, u);
  }

  /** Primer nombre y primer apellido: "Ana María Demo Ejemplo" → "Ana Demo". */
  function nombreCorto(nombre) {
    const w = String(nombre || '').trim().split(/\s+/);
    return w.length >= 4 ? `${w[0]} ${w[w.length - 2]}` : w.length === 3 ? `${w[0]} ${w[1]}` : w.join(' ');
  }

  /** La persona de la base con ese nombre: completo o, si no hay dudas, nombre y apellido. Con exacto, solo el completo. */
  function buscarPersona(nombre, exacto) {
    const k = normalNombre(nombre);
    if (!k) return null;
    const completo = est.personas.find(p => normalNombre(p.nombre) === k);
    if (completo || exacto) return completo || null;
    const cortos = est.personas.filter(p => normalNombre(nombreCorto(p.nombre)) === k);
    return cortos.length === 1 ? cortos[0] : null;
  }

  /** Los datos propios (Ajustes), completados con la base de personas. */
  function yoCompleto() {
    const c = Api.config(), b = buscarPersona(c.nombre) || {};
    return { nombre: c.nombre || b.nombre || '', rut: c.rut || b.rut || '', cargo: c.cargo || b.cargo || '' };
  }

  /** Personas, plantillas y proveedores del servidor (o los guardados en el teléfono, sin conexión). */
  function usarRapido(r, local) {
    if (Array.isArray(r.personas)) est.personas = r.personas.filter(p => p && p.nombre);
    if (Array.isArray(r.plantillas)) est.plantillas = r.plantillas.filter(p => p && p.nombre);
    if (Array.isArray(r.proveedores)) {
      est.proveedores = r.proveedores.filter(p => p && (p.fantasia || p.nombre || p.razonSocial))
        .map(p => Object.assign({}, p, { fantasia: p.fantasia || p.nombre || '', razonSocial: p.razonSocial || '' }));
    }
    if (!local) guardarLocal('rapido', { personas: est.personas, plantillas: est.plantillas, proveedores: est.proveedores });
    if (est.vista === 'datos') pintarPlantillas();
    if (est.vista === 'entrega') pintarPersonasActa();
    if (est.vista === 'ajustes') pintarGestion();
  }

  /** Chips con las personas más usadas (y quienes rinden en las rendiciones frecuentes): un toque llena nombre, RUT, cargo y correo. */
  function pintarPersonasActa() {
    if (!est.entrega) return;
    const uso = usoLocal('personas'), rinden = new Set(est.plantillas.map(p => normalNombre(p.rinde)).filter(Boolean));
    const puntos = p => (uso[normalNombre(p.nombre)] || 0) * 10
      + (rinden.has(normalNombre(p.nombre)) || rinden.has(normalNombre(nombreCorto(p.nombre))) ? 3 : 0);
    const orden = est.personas.map((p, i) => ({ p, i, n: puntos(p) })).sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.p);
    [['Entrega', 'Recibe'], ['Recibe', 'Entrega']].forEach(([pre, otro]) => {
      const cont = document.getElementById(`e${pre}Personas`), actual = normalNombre(valor(`e${pre}Nombre`));
      const delOtro = normalNombre(valor(`e${otro}Nombre`));
      cont.innerHTML = '';
      orden.filter(p => normalNombre(p.nombre) !== delOtro).slice(0, 6).forEach(p => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = nombreCorto(p.nombre);
        b.title = p.nombre + (p.cargo ? ' · ' + p.cargo : '');
        b.setAttribute('aria-pressed', String(normalNombre(p.nombre) === actual));
        b.onclick = () => elegirPersona(pre, p, false);
        cont.appendChild(b);
      });
    });
  }

  /**
   * Llena los datos de la persona elegida. Con un toque (chip) se usan todos sus datos; al escribir su nombre solo se
   * completan los campos vacíos o los que llenó antes otra persona elegida: lo escrito a mano no se pisa.
   */
  function elegirPersona(pre, p, desdeNombre) {
    if (!est.entrega) return;
    const campos = [[`e${pre}Nombre`, p.nombre], [`e${pre}Rut`, p.rut], [`e${pre}Cargo`, p.cargo]];
    if (pre === 'Recibe') campos.push(['eRecibeCorreo', p.correo]);
    const cambiados = [];
    campos.forEach(([id, v]) => {
      const el = document.getElementById(id), auto = el.dataset.auto === '1', vacio = !el.value.trim();
      if (id.endsWith('Nombre') && desdeNombre) {
        // "Ana Demo" escrito a mano: al salir del campo queda el nombre completo de la base
        if (el.value !== p.nombre && document.activeElement !== el) { el.value = p.nombre; cambiados.push(id); }
        return;
      }
      if (!desdeNombre) {
        // Toque en la persona: todos sus datos, y vacío lo que la base no tiene (no queda el RUT de otra persona)
        if (el.value !== (v || '')) { el.value = v || ''; cambiados.push(id); }
        el.dataset.auto = v ? '1' : '';
        return;
      }
      if (v && (vacio || auto)) {
        if (el.value !== v) { el.value = v; cambiados.push(id); }
        el.dataset.auto = '1';
      } else if (!v && auto && !vacio) {
        el.value = '';
        el.dataset.auto = '';
        cambiados.push(id);
      }
    });
    if (cambiados.length) {
      if (cambiados.some(id => IDS_DECLARACION.includes(id))) invalidarFirmas();
      pintarEstadoRut(`e${pre}Rut`);
      tocarEntrega();
      pintarDeclaracion();
    }
    pintarPersonasActa();
  }

  /** El nombre escrito ya no es el de la persona elegida: se sueltan los datos que se habían llenado solos (RUT, cargo, correo). */
  function soltarPersona(pre) {
    const ids = [`e${pre}Rut`, `e${pre}Cargo`].concat(pre === 'Recibe' ? ['eRecibeCorreo'] : []), cambiados = [];
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el.dataset.auto !== '1') return;
      el.dataset.auto = '';
      if (el.value) { el.value = ''; cambiados.push(id); }
    });
    if (!cambiados.length) return;
    if (cambiados.some(id => IDS_DECLARACION.includes(id))) invalidarFirmas();
    pintarEstadoRut(`e${pre}Rut`);
    pintarDeclaracion();
  }

  /** Tras registrar un acta: quienes participaron quedan a mano (el servidor también los da de alta en la base). */
  function recordarPersonas(a) {
    [a.entrega, a.recibe].forEach(x => {
      if (!x || !x.nombre) return;
      contarUso('personas', x.nombre);
      if (!buscarPersona(x.nombre, true)) est.personas.push({ nombre: x.nombre, rut: x.rut || '', cargo: x.cargo || '', area: '', correo: x.correo || '' });
    });
    usarRapido({});
  }

  function pintarPlantillas() {
    const grupo = $('#grupoFrecuentes'), cont = $('#chipsFrecuentes');
    if (est.edicion) { grupo.hidden = true; return; }
    if (est.plantilla && est.plantillas.length && !est.plantillas.some(p => p.nombre === est.plantilla)) {
      est.plantilla = null;                         // ya no existe (se quitó): el gasto no queda asociado a ella
      est.plantillaAplicada = null;
    }
    const uso = usoLocal('plantillas');
    let orden = est.plantillas.map((p, i) => ({ p, i, n: uso[normalNombre(p.nombre)] || 0 })).sort((a, b) => b.n - a.n || a.i - b.i).map(x => x.p);
    const sugerida = orden.find(p => p.nombre === est.plantillaSugerida);
    if (sugerida) orden = [sugerida].concat(orden.filter(p => p !== sugerida));
    const visibles = est.verTodasPlantillas ? orden : orden.slice(0, 8);
    cont.innerHTML = '';
    visibles.forEach(p => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = p.nombre;
      b.setAttribute('aria-pressed', String(est.plantilla === p.nombre));
      if (p === sugerida && est.plantilla !== p.nombre) b.classList.add('sugerida');
      b.onclick = () => aplicarPlantilla(p);
      cont.appendChild(b);
    });
    if (visibles.length < orden.length) {
      const mas = document.createElement('button');
      mas.type = 'button';
      mas.className = 'mas';
      mas.textContent = `Ver todas (${orden.length})`;
      mas.onclick = () => { est.verTodasPlantillas = true; pintarPlantillas(); };
      cont.appendChild(mas);
    }
    const nueva = document.createElement('button');
    nueva.type = 'button';
    nueva.className = 'mas';
    nueva.textContent = '+ Nueva';
    nueva.onclick = nuevaPlantilla;
    cont.appendChild(nueva);
    grupo.hidden = false;
  }

  /**
   * Rendición frecuente: llena el contexto del gasto (categoría, CeCo, detalle, medio, quién rinde) y, si el documento no
   * los trajo, el proveedor y su RUT. El monto y la fecha salen siempre del documento. Lo escrito a mano no se pisa.
   */
  /** Foto de los campos y elecciones del formulario: para deshacer una rendición frecuente si se desmarca. */
  function fotoCampos() {
    const v = {};
    IDS_FORMULARIO.forEach(id => {
      const el = document.getElementById(id);
      v[id] = { valor: el.value, sugerido: el.classList.contains('sugerido'), placeholder: el.placeholder || '' };
    });
    return { v, categoria: est.categoria, movimiento: est.movimiento };
  }

  /**
   * Desmarca la rendición frecuente: vuelve a como estaba lo que ella llenó y nadie cambió después (lo escrito a mano después
   * se respeta). Queda sin rendición frecuente: el gasto no es recurrente.
   */
  function quitarPlantilla(silencioso) {
    const a = est.plantillaAplicada;
    est.plantilla = null;
    est.plantillaAplicada = null;
    if (a) {
      const ahora = fotoCampos();                // antes de elegirMovimiento, que reescribe medio, tipo y categoría
      if (est.movimiento === a.despues.movimiento && a.antes.movimiento !== a.despues.movimiento) elegirMovimiento(a.antes.movimiento);
      IDS_FORMULARIO.forEach(id => {
        const el = document.getElementById(id), d = a.despues.v[id], b = a.antes.v[id], n = ahora.v[id];
        if (!d || !b) return;
        // Vuelve al valor de antes solo lo que sigue como lo dejó la plantilla y nadie escribió; el resto queda como estaba
        const dePlantilla = n.valor === d.valor && d.valor !== b.valor && !(CAMPOS[id] && est.tocados.has(CAMPOS[id]));
        const valor = dePlantilla ? b.valor : n.valor;
        if (el.value !== valor && !(el.tagName === 'SELECT' && valor && !opciones('#' + id).includes(valor))) el.value = valor;
        if (dePlantilla) el.classList.toggle('sugerido', b.sugerido);
        if (n.placeholder === d.placeholder && d.placeholder !== b.placeholder) el.placeholder = b.placeholder;
      });
      est.categoria = ahora.categoria === a.despues.categoria && a.antes.categoria !== a.despues.categoria ? a.antes.categoria : ahora.categoria;
      pintarCategorias();
      pintarReembolso();
      validarRut();
      validarCeco();
      completarPorRut();
      pintarControlTarjeta();
    }
    pintarPlantillas();
    tocarFormulario();
    if (!silencioso) toast('Sin rendición frecuente');
  }

  function aplicarPlantilla(p) {
    if (est.edicion) return;
    // Tocar la que ya está marcada la desmarca; si había otra, primero se deshace esa (no se mezclan)
    if (est.plantilla === p.nombre) { quitarPlantilla(); return; }
    if (est.plantilla) quitarPlantilla(true);
    const antes = fotoCampos();
    const poner = (sel, v, campo) => {
      const el = $(sel);
      if (!v || (campo && est.tocados.has(campo))) return;
      if (el.tagName === 'SELECT' && !opciones(sel).includes(v)) return;
      el.value = v;
      el.classList.add('sugerido');
      el.classList.remove('invalido');
    };
    est.plantilla = p.nombre;
    const mantieneCuenta = est.reembolso && p.movimiento && p.movimiento !== est.movimiento;
    if (p.movimiento && p.movimiento !== est.movimiento && listas().movimientos.includes(p.movimiento) && !est.reembolso) elegirMovimiento(p.movimiento);
    if (GASTOS.includes(est.movimiento)) {
      const cat = listas().categorias.find(c => c.nombre === p.categoria);
      if (cat) elegirCategoria(cat);
      if (!est.tocados.has('ceco')) {
        // Sin CeCo en la plantilla = depende del destino (oficina o proyecto): no se deja el de la categoría
        if (p.ceco) poner('#fCeco', p.ceco, 'ceco');
        else { $('#fCeco').value = ''; $('#fCeco').classList.remove('sugerido'); }
      }
      validarCeco();
    }
    poner('#fDetalle', p.detalle, 'detalle');
    if (!est.reembolso) poner('#fMedio', p.medio, 'medio');
    if (!$('#fTipo').classList.contains('sugerido')) poner('#fTipo', p.tipoDoc, 'tipoDoc');
    if (!$('#fProveedor').value.trim()) poner('#fProveedor', p.proveedor, 'proveedor');
    if (!$('#fRut').value.trim()) { poner('#fRut', p.rut, 'rut'); validarRut(); }
    completarPorRut();
    if (p.rinde) $('#fRinde').value = p.rinde;
    if (p.monto && !$('#fMonto').value) $('#fMonto').placeholder = `Típico ${clp(p.monto)}`;
    est.plantillaAplicada = { nombre: p.nombre, antes, despues: fotoCampos() };
    pintarControlTarjeta();
    pintarPlantillas();
    tocarFormulario();
    toast(mantieneCuenta ? `«${p.nombre}»: se mantiene el reembolso desde ${est.movimiento === 'Rendición Santander' ? 'Santander' : 'Mercado Pago'}`
      : `«${p.nombre}»: revisa el monto y la fecha. Tócala de nuevo para quitarla`);
  }

  const cuerpoRut = s => { const r = rutInfo(s); return r && r.ok ? r.texto.replace(/\./g, '').split('-')[0] : ''; };

  /** Proveedor ya usado (por RUT o nombre): completa su RUT, sugiere categoría y CeCo y destaca su rendición frecuente. */
  function sugerirPorProveedor() {
    if (est.edicion) return;
    const rut = cuerpoRut($('#fRut').value), nombre = normalNombre($('#fProveedor').value);
    const prov = est.proveedores.find(p => (rut && cuerpoRut(p.rut) === rut)
      || (nombre && (normalNombre(p.fantasia) === nombre || normalNombre(p.razonSocial) === nombre)));
    const plantilla = est.plantillas.find(p => (rut && p.rut && cuerpoRut(p.rut) === rut) || (nombre && p.proveedor && normalNombre(p.proveedor) === nombre));
    const sugerida = plantilla ? plantilla.nombre : null;
    if (sugerida !== est.plantillaSugerida) { est.plantillaSugerida = sugerida; pintarPlantillas(); }
    if (!prov) return;
    if (!$('#fRut').value.trim() && prov.rut && !est.tocados.has('rut')) { $('#fRut').value = prov.rut; $('#fRut').classList.add('sugerido'); validarRut(); completarPorRut(); }
    if (!est.plantilla && !est.categoria && prov.categoria && GASTOS.includes(est.movimiento)) {
      const cat = listas().categorias.find(c => c.nombre === prov.categoria);
      if (cat) elegirCategoria(cat);
      if (prov.ceco && !est.tocados.has('ceco')) { ponerCeco(prov.ceco); $('#fCeco').classList.add('sugerido'); validarCeco(); }
    }
  }

  /** Lo recién guardado queda en la lista del teléfono: el próximo documento del mismo RUT sale completo sin esperar al servidor. */
  function recordarProveedor(d) {
    const c = cuerpoRut(d.rut);
    if (!c || !GASTOS.includes(d.movimiento)) return;
    est.rutSinDatos = (est.rutSinDatos || []).filter(x => x !== c);
    const p = proveedorDeRut(c);
    if (p) {
      if (!p.razonSocial && d.razonSocial) p.razonSocial = d.razonSocial;
      if (!p.fantasia && d.proveedor) p.fantasia = d.proveedor;
    } else if (d.razonSocial || d.proveedor) {
      est.proveedores.push({ rut: d.rut, razonSocial: d.razonSocial || '', fantasia: d.proveedor || '', categoria: d.categoria || '', ceco: d.ceco || '',
        usos: 1, ultimo: d.fecha });
    }
    usarRapido({});
  }

  /** El proveedor de un RUT en la lista del teléfono (cuerpo sin dígito verificador) o null. */
  const proveedorDeRut = cuerpo => (cuerpo ? est.proveedores.find(p => cuerpoRut(p.rut) === cuerpo) || null : null);

  /** Pone los nombres del proveedor conocido: reemplaza lo sugerido por el lector, nunca lo escrito a mano. */
  function aplicarProveedor(p) {
    const poner = (sel, campo, v) => {
      const el = $(sel);
      if (!v || est.tocados.has(campo) || el.value === v) return;
      el.value = v;
      el.classList.add('sugerido');
      el.classList.remove('invalido');
    };
    poner('#fRazon', 'razonSocial', p.razonSocial);
    poner('#fProveedor', 'proveedor', p.fantasia || p.razonSocial);
    est.provAplicado = { rut: cuerpoRut(p.rut), razon: $('#fRazon').value, fantasia: $('#fProveedor').value };
    pintarEstadoProveedor('conocido', p);
  }

  /** Cambió el RUT a uno sin datos: los nombres que se habían puesto solos con el RUT anterior ya no corresponden. */
  function soltarProveedor(rut) {
    const a = est.provAplicado;
    if (!a || a.rut === rut) return;
    [['#fRazon', 'razonSocial', a.razon], ['#fProveedor', 'proveedor', a.fantasia]].forEach(([sel, campo, v]) => {
      const el = $(sel);
      if (!est.tocados.has(campo) && v && el.value === v) { el.value = ''; el.classList.remove('sugerido'); }
    });
    est.provAplicado = null;
  }

  function pintarEstadoProveedor(estado, p) {
    const el = $('#provEstado');
    el.className = estado === 'conocido' ? 'ok' : estado === 'nuevo' ? 'aviso' : '';
    el.textContent = estado === 'conocido' ? `Proveedor conocido${p && p.fuente ? ' · ' + p.fuente : ''}`
      : estado === 'buscando' ? 'Buscando el proveedor por su RUT…'
        : estado === 'nuevo' ? 'Proveedor nuevo: escribe sus nombres y la próxima vez saldrán solos' : '';
  }

  /**
   * Con un RUT válido, los nombres salen solos: primero de la lista del teléfono (base de proveedores, fuentes de A&F y lo ya
   * registrado) y, si no está, se le pregunta al servidor. Si nadie lo conoce, se escriben a mano una vez y quedan aprendidos.
   */
  function completarPorRut() {
    const rut = cuerpoRut($('#fRut').value);
    if (!rut) { soltarProveedor(''); pintarEstadoProveedor(''); return; }
    const local = proveedorDeRut(rut);
    if (local) { aplicarProveedor(local); return; }
    soltarProveedor(rut);
    if (!Api.demo && (!Api.configurada() || !navigator.onLine)) { pintarEstadoProveedor('nuevo'); return; }
    if (est.rutConsultado === rut) return;
    if ((est.rutSinDatos || []).includes(rut)) { pintarEstadoProveedor('nuevo'); return; }
    est.rutConsultado = rut;
    pintarEstadoProveedor('buscando');
    Api.llamar('proveedor', { rut: $('#fRut').value }).then(r => {
      if (cuerpoRut($('#fRut').value) !== rut) return;
      const p = r && r.proveedor;
      if (!p) { est.rutSinDatos = (est.rutSinDatos || []).concat([rut]); pintarEstadoProveedor('nuevo'); return; }
      const nuevo = { rut: p.rut, razonSocial: p.razonSocial || '', fantasia: p.fantasia || '', categoria: p.categoria || '', ceco: p.ceco || '',
        usos: 0, ultimo: '', fuente: p.fuente || '' };
      est.proveedores.push(nuevo);
      aplicarProveedor(nuevo);
    }).catch(() => { if (cuerpoRut($('#fRut').value) === rut) pintarEstadoProveedor('nuevo'); })
      .finally(() => { if (est.rutConsultado === rut) est.rutConsultado = null; });
  }

  /** Después de guardar: deja este gasto como rendición frecuente (un botón en "Datos del gasto"). */
  async function guardarFrecuente() {
    const d = est.listoDatos, b = $('#btnFrecuente');
    if (!d) return;
    if (await crearPlantilla(d, b)) b.hidden = true;
  }

  /** "+ Nueva" en Rendiciones frecuentes: con lo ya llenado en "Datos del gasto" (monto y fecha salen siempre del documento). */
  async function nuevaPlantilla() {
    const d = leerFormulario();
    if (!d.detalle && (!d.categoria || !GASTOS.includes(d.movimiento))) {
      toast('Primero elige la categoría o escribe el detalle: la rendición frecuente copia lo que ya llenaste', 5000);
      return;
    }
    const nombre = await crearPlantilla(d, null);
    if (!nombre || est.vista !== 'datos' || est.edicion) return;
    const ahora = fotoCampos();                      // queda marcada: desmarcarla no cambia nada de lo escrito
    est.plantilla = nombre;
    est.plantillaAplicada = { nombre, antes: ahora, despues: ahora };
    pintarPlantillas();
    tocarFormulario();
  }

  /** Guarda (o reemplaza, si se confirma) una rendición frecuente con los datos d. Devuelve su nombre o null. */
  async function crearPlantilla(d, b) {
    if (!navigator.onLine) { toast('Sin conexión: para crear una rendición frecuente necesitas internet'); return null; }
    const sugerido = [d.categoria, d.proveedor].filter(Boolean).join(' · ').slice(0, 60);
    const nombre = await preguntar('Rendición frecuente', 'Queda como botón en "Datos del gasto": llena categoría, CeCo, detalle, medio, proveedor y quién rinde. El monto y la fecha se toman siempre del documento.',
      'Guardar', 'Cancelar', { placeholder: 'Nombre del botón (ej: Desayuno empresa)', valor: sugerido });
    if (!nombre) return;
    const limpio = nombre.replace(/\s+/g, ' ').trim().slice(0, 60);
    const existe = est.plantillas.some(p => normalNombre(p.nombre) === normalNombre(limpio));
    if (existe && !(await preguntar('Ya existe', `Ya hay una rendición frecuente «${limpio}». ¿Reemplazarla con los datos de este gasto?`, 'Reemplazar', 'Cancelar'))) return null;
    if (b) b.disabled = true;
    const turno = ++turnos.plantillas;
    toast('Guardando la rendición frecuente…', 8000);
    try {
      const r = await Api.llamar('guardarPlantillas', { reemplazar: true, completa: true, plantillas: [{ nombre: limpio, movimiento: d.movimiento, categoria: d.categoria,
        ceco: d.ceco, detalle: d.detalle, proveedor: d.proveedor, rut: d.rut, tipoDoc: d.tipoDoc,
        medio: d.reembolso ? medioPorDefecto(d.movimiento) : d.medio, rinde: d.rinde }] });
      cambiadasEn.plantillas = Date.now();
      if (r.plantillas && turno === turnos.plantillas) usarRapido({ plantillas: r.plantillas });
      // 14) Si ya existía con otras mayúsculas, el servidor conserva su nombre: ese es el que queda marcado
      const guardada = (r.plantillas || []).find(p => normalNombre(p.nombre) === normalNombre(limpio));
      const visible = !r.plantillas || !!guardada;
      toast(visible ? `Listo: «${limpio}» aparece en "Datos del gasto"` + ((r.avisos || []).length ? ` (${r.avisos[0]})` : '')
        : `«${limpio}» quedó en la planilla, pero la app muestra solo las primeras 60: quita alguna que no se use (Ajustes)`, 6000);
      return visible ? (guardada ? guardada.nombre : limpio) : null;
    } catch (e) {
      toast(e.codigo === 'red' ? 'Sin conexión: para crear una rendición frecuente necesitas internet' : 'No se pudo guardar: ' + e.message, 6000);
      return null;
    } finally {
      if (b) b.disabled = false;
    }
  }

  // ---------- Categorías y rendiciones frecuentes (Ajustes y "+ Nueva") ----------

  /** Categoría nueva: queda en la hoja Listas para todos. El CeCo sugerido se pone solo al elegirla (vacío si depende del proyecto). */
  async function nuevaCategoria() {
    if (!Api.demo && !Api.configurada()) { toast('Primero vincula la app (Conexión con Drive)'); return null; }
    if (!navigator.onLine) { toast('Sin conexión: para crear una categoría necesitas internet'); return null; }
    const L = listas(), cecos = L.cecos || [];
    // Como sugerido, solo códigos finales: uno que agrupa otros (nodo padre) no sirve para imputar
    const finales = cecos.filter(c => !cecos.some(o => o.codigo !== c.codigo && o.codigo.startsWith(c.codigo + '-')));
    const r = await preguntar('Nueva categoría', 'Queda disponible para todos los gastos y en la planilla. El CeCo sugerido se pone solo al elegirla: déjalo vacío si depende del proyecto.',
      'Crear', 'Cancelar', { placeholder: 'Nombre (ej: Peajes y TAG)', etiquetaOpcion: 'CeCo sugerido',
        opciones: [{ valor: '', texto: 'Sin CeCo sugerido' }].concat(finales.map(c => ({ valor: c.codigo, texto: c.codigo + (c.significado ? ' · ' + c.significado : '') }))) });
    if (!r) return null;
    const nombre = r.texto.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (normalNombre(nombre) === normalNombre('Recarga caja chica')) { toast('«Recarga caja chica» es la de los ingresos: usa otro nombre', 5000); return null; }
    const existe = L.categorias.find(c => normalNombre(c.nombre) === normalNombre(nombre));
    if (existe) { toast(`Ya existe «${existe.nombre}»`); return existe; }
    const turno = ++turnos.categorias;
    toast('Creando la categoría…', 8000);
    try {
      const x = await Api.llamar('agregarCategoria', { nombre, ceco: r.opcion });
      cambiadasEn.categorias = Date.now();
      if (turno === turnos.categorias) usarCategorias(x.categorias);
      toast(x.creada ? `Categoría «${x.categoria.nombre}» creada` : x.aviso);
      return x.categoria;
    } catch (e) {
      toast(e.codigo === 'red' ? 'Sin conexión: para crear una categoría necesitas internet' : 'No se pudo crear: ' + e.message, 6000);
      return null;
    }
  }

  /** "+ Nueva" en Categoría: la crea y la deja elegida en el gasto. */
  async function categoriaNuevaEnGasto() {
    const c = await nuevaCategoria();
    if (!c || est.vista !== 'datos' || !GASTOS.includes(est.movimiento)) return;
    const cat = listas().categorias.find(x => normalNombre(x.nombre) === normalNombre(c.nombre));
    if (cat) elegirCategoria(cat);
    tocarFormulario();
  }

  function usarCategorias(categorias) {
    if (!Array.isArray(categorias)) return;
    est.listas = Object.assign({}, listas(), { categorias });
    guardarLocal('listas', est.listas);
    if (est.vista === 'datos') pintarCategorias();
    if (est.vista === 'ajustes') pintarGestion();
  }

  /** Ajustes: las categorías y rendiciones frecuentes de la app, cada una con "Quitar". */
  function pintarGestion() {
    const sinDatos = !Api.demo && (!Api.configurada() || !est.listas);
    $('#btnNuevaCategoria').hidden = sinDatos;
    if (sinDatos) {
      $('#gestionCategorias').innerHTML = `<p class="ayuda">${Api.configurada() ? 'Abre la app con conexión para cargar las categorías.' : 'Vincula la app (Conexión con Drive) para ver y agregar categorías.'}</p>`;
      $('#gestionPlantillas').innerHTML = '';
      return;
    }
    const FIJAS = ['Atención a clientes', 'Otros'];     // la app las necesita (representación y "todo lo demás")
    const fila = (titulo, sub, tipo, nombre) => `<li><span><strong>${esc(titulo)}</strong>${sub ? `<small>${esc(sub)}</small>` : ''}</span>`
      + (tipo ? `<button type="button" class="btn-texto" data-quitar="${tipo}" data-nombre="${esc(nombre)}">Quitar</button>` : '') + '</li>';
    const cats = listas().categorias.filter(c => c.nombre !== 'Recarga caja chica');
    $('#gestionCategorias').innerHTML = `<h3>Categorías (${cats.length})</h3><ul>`
      + cats.map(c => fila(c.nombre, c.ceco ? 'CeCo sugerido: ' + c.ceco : '', FIJAS.includes(c.nombre) ? null : 'categoria', c.nombre)).join('') + '</ul>';
    $('#gestionPlantillas').innerHTML = `<h3>Rendiciones frecuentes (${est.plantillas.length})</h3>` + (est.plantillas.length
      ? '<ul>' + est.plantillas.map(p => fila(p.nombre, [p.categoria, p.detalle].filter(Boolean).join(' · '), 'plantilla', p.nombre)).join('') + '</ul>'
      : '<p class="ayuda">Aún no hay: se crean en "Datos del gasto" con + Nueva.</p>');
  }

  async function quitarDeLista(tipo, nombre, boton) {
    const categoria = tipo === 'categoria';
    const si = await preguntar(categoria ? 'Quitar categoría' : 'Quitar rendición frecuente', categoria
      ? `«${nombre}» deja de aparecer en la app. Si ya se usó en gastos de este año o la usa una rendición frecuente, no se puede quitar.`
      : `«${nombre}» deja de aparecer en la app. Queda guardada en la planilla, desactivada, por si se quiere recuperar.`, 'Quitar', 'Cancelar');
    if (!si) return;
    if (!navigator.onLine) { toast('Sin conexión: para quitarla necesitas internet'); return; }
    boton.disabled = true;
    const lista = categoria ? 'categorias' : 'plantillas', turno = ++turnos[lista];
    try {
      const r = await Api.llamar(categoria ? 'quitarCategoria' : 'quitarPlantilla', { nombre });
      cambiadasEn[lista] = Date.now();
      // 3) El gasto a medio llenar la suelta al volver a "Datos del gasto" (pintarCategorias / pintarPlantillas)
      if (categoria) {
        if (normalNombre(est.categoria) === normalNombre(nombre)) est.categoria = '';
        if (turno === turnos[lista]) usarCategorias(r.categorias);
      } else {
        if (est.plantilla && normalNombre(est.plantilla) === normalNombre(nombre)) { est.plantilla = null; est.plantillaAplicada = null; }
        if (turno === turnos[lista]) usarRapido({ plantillas: r.plantillas });
      }
      pintarGestion();
      toast(r.quitada ? `«${nombre}» ya no aparece en la app` : (r.aviso || `«${nombre}» ya no estaba`));
    } catch (e) {
      boton.disabled = false;
      toast(e.codigo === 'red' ? 'Sin conexión: para quitarla necesitas internet' : e.message, 6000);
    }
  }

  // ---------- Ajustes y vinculación ----------

  function cargarAjustes() {
    const c = Api.config();
    $('#aUrl').value = c.url || '';
    $('#aToken').value = c.token || '';
    $('#aNombre').value = c.nombre || '';
    $('#aRut').value = c.rut || '';
    $('#aCargo').value = c.cargo || '';
    $('#aTarjetaMP').value = '';
    $('#aTarjetaSan').value = '';
    $('#aTarjetaMP').placeholder = (est.tarjetas && est.tarjetas.mp) || 'Últimos 4';
    $('#aTarjetaSan').placeholder = (est.tarjetas && est.tarjetas.santander) || 'Opcional';
    $('#aCamaraNativa').checked = !!leerLocal('camaraNativa');
    $('#estadoConexion').textContent = '';
    $('#version').textContent = `App Caja Chica v${VERSION} · Telconsulting`;
    pintarGestion();
  }

  function leerConexion() {
    const url = $('#aUrl').value.trim(), token = $('#aToken').value.trim();
    if (url && !URL_SERVIDOR.test(url)) { toast('La dirección debe ser la del servidor y terminar en /exec'); return null; }
    return { url, token };
  }

  async function guardarAjustes() {
    const conexion = leerConexion();
    if (!conexion) return;
    const mp = soloDigitos($('#aTarjetaMP').value), san = soloDigitos($('#aTarjetaSan').value);
    if ((mp && mp.length !== 4) || (san && san.length !== 4)) { toast('Ingresa solo los últimos 4 dígitos de cada tarjeta'); return; }
    const rut = $('#aRut').value.trim(), infoRut = rut ? rutInfo(rut) : null;
    if (rut && !(infoRut && infoRut.ok)) { toast('Revisa tu RUT (o déjalo vacío)'); return; }
    Api.guardarConfig(Object.assign(conexion, { nombre: $('#aNombre').value.trim(), rut: infoRut ? infoRut.texto : '', cargo: $('#aCargo').value.trim() }));
    guardarLocal('camaraNativa', $('#aCamaraNativa').checked);
    if (mp || san) {
      try {
        const r = await Api.llamar('configurar', Object.assign({}, mp ? { tarjetaMP: mp } : {}, san ? { tarjetaSantander: san } : {}));
        est.tarjetas = r.tarjetas || {};
        guardarLocal('tarjetas', est.tarjetas);
      } catch (e) {
        toast('Se guardó la conexión, pero no las tarjetas: ' + e.message, 6000);
        return;
      }
    }
    toast('Ajustes guardados');
    cargarConfig();
    history.back();
  }

  async function probarConexion() {
    const conexion = leerConexion(), el = $('#estadoConexion');
    if (!conexion) return;
    Api.guardarConfig(conexion);
    el.className = 'estado-conexion';
    el.textContent = 'Probando…';
    try {
      const r = await Api.llamar('ping');
      el.textContent = `Conectado ✓ ${r.cuenta ? '· ' + r.cuenta : ''} · servidor v${r.version}`;
      el.classList.add('ok');
      cargarConfig();
    } catch (e) {
      el.textContent = e.message;
      el.classList.add('error');
    }
  }

  async function cargarConfig() {
    if (!Api.configurada()) return;
    const inicio = Date.now();
    try {
      const r = await Api.llamar('config');
      // Si mientras tanto se agregó o quitó una categoría o frecuente, esta respuesta ya viene atrasada en eso
      const atrasada = cambiadasEn.categorias > inicio;
      est.listas = atrasada && est.listas ? Object.assign({}, r.listas, { categorias: est.listas.categorias }) : r.listas;
      est.tarjetas = r.tarjetas || {};
      guardarLocal('listas', est.listas);
      guardarLocal('tarjetas', est.tarjetas);
      usarRapido({ personas: r.personas, plantillas: cambiadasEn.plantillas > inicio ? undefined : r.plantillas, proveedores: r.proveedores });
      if (r.custodia) pintarCustodia(r.custodia);
      if (r.huellasQr) guardarHuellas(r.huellasQr);
      if (est.vista === 'datos') { pintarCategorias(); validarCeco(); pintarPlantillas(); }
    } catch (e) {
      if (e.codigo === 'clave') toast('La clave de acceso no es válida: revisa Ajustes', 5000);
    }
  }

  /** Enlace de vinculación: …/#vincular=<base64url de {u: url, t: clave, n: nombre}>. El "#" no viaja a ningún servidor web. */
  async function vincularDesdeEnlace() {
    const m = location.hash.match(/^#vincular=([\w-]+)/);
    if (!m) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    let datos;
    try {
      const b64 = m[1].replace(/-/g, '+').replace(/_/g, '/');
      datos = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0))));
      if (!URL_SERVIDOR.test(datos.u || '') || !datos.t || String(datos.t).length < 24) throw new Error('incompleto');
    } catch (e) {
      toast('El enlace de vinculación no es válido');
      return;
    }
    const actual = Api.config();
    if (actual.url && (actual.url !== datos.u || actual.token !== datos.t)) {
      const si = await preguntar('Cambiar vinculación', 'Este enlace conecta la app con otro servidor. Acéptalo solo si te lo entregó Administración y Finanzas.', 'Reemplazar', 'Cancelar');
      if (!si) return;
    }
    Api.guardarConfig({ url: datos.u, token: datos.t, nombre: datos.n || actual.nombre || '' });
    toast('App vinculada con Drive ✓');
    $('#avisoConfig').hidden = true;
    cargarConfig();
    refrescarResumen(false);
  }

  /** Archivos recibidos con "Compartir" desde otra app (WhatsApp, Gmail, Galería…). */
  async function recibirCompartidos() {
    let lista = null;
    try {
      lista = await DB.leer('compartidos', 'ultimo');
      await DB.borrar('compartidos', 'ultimo');
    } catch (e) { lista = null; }
    history.replaceState(history.state, '', location.pathname);
    if (!lista || !lista.length) return;
    const pdf = lista.find(a => a.tipo === 'application/pdf');
    if (pdf) {
      if (!(await descartarSiHay())) { toast('Se conservó la captura anterior: comparte el PDF de nuevo después', 5000); return; }
      nuevaCaptura();
      usarPdf(pdf.blob, pdf.nombre, 'compartido');
      return;
    }
    const imagenes = lista.filter(a => /^image\//.test(a.tipo));
    if (!imagenes.length) return;
    if (est.paginas.length) {
      const agregar = await preguntar('Captura sin terminar', `Tienes ${paginasTexto(est.paginas.length)} sin guardar. ¿Agrego lo compartido a esa captura?`, 'Agregar', 'Empezar de cero');
      if (!agregar) nuevaCaptura();
    } else {
      nuevaCaptura();
    }
    ir('paginas');
    imagenes.forEach(a => agregarFoto(a.blob, 'compartido'));
  }

  // ---------- Instalación en el teléfono ----------

  /** Botón "Instalar" propio: Chrome ofrece la instalación y la app la muestra sin tener que buscarla en el menú. */
  function prepararInstalacion() {
    const instalada = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
    if (instalada) return;
    let pedido = null;
    window.addEventListener('beforeinstallprompt', e => {
      e.preventDefault();
      pedido = e;
      $('#avisoInstalar').hidden = false;
      $('#avisoNavegador').hidden = true;
    });
    window.addEventListener('appinstalled', () => {
      pedido = null;
      $('#avisoInstalar').hidden = true;
      toast('App instalada ✓ Ábrela desde el ícono "Caja Chica"', 6000);
    });
    $('#btnInstalar').onclick = async () => {
      if (!pedido) return;
      pedido.prompt();
      const r = await pedido.userChoice.catch(() => null);
      pedido = null;
      $('#avisoInstalar').hidden = true;
      if (r && r.outcome === 'accepted') toast('Instalando… aparecerá el ícono "Caja Chica"', 6000);
    };
    // Navegadores que no instalan apps (p. ej. el de Xiaomi): se indica abrir el enlace en Chrome
    if (/MiuiBrowser|XiaoMi|HeyTap|OPR\/|Firefox/i.test(navigator.userAgent) || !/Chrome\//.test(navigator.userAgent)) {
      $('#avisoNavegador').hidden = false;
    }
  }

  // ---------- Eventos ----------

  function enlazar() {
    $('#btnVolver').onclick = () => history.back();
    $('#btnAjustes').onclick = () => ir('ajustes');
    $$('[data-ir]').forEach(b => { b.onclick = () => (b.dataset.ir === 'inicio' ? volverInicio() : ir(b.dataset.ir)); });

    const libre = () => Date.now() >= (est.bloqueoToques || 0);
    $('#btnEscanear').onclick = async () => { if (libre() && await descartarSiHay()) { nuevaCaptura(); abrirCamara(); } };
    $('#btnGaleria').onclick = async () => { if (libre() && await descartarSiHay()) { nuevaCaptura(); $('#inGaleria').click(); } };
    $('#btnPdf').onclick = async () => { if (libre() && await descartarSiHay()) { nuevaCaptura(); $('#inPdf').click(); } };
    $('#btnRefrescar').onclick = () => refrescarResumen(true);
    $('#btnEnviarCola').onclick = enviarColaManual;
    $('#btnDescartarCola').onclick = descartarBloqueados;
    $('#btnRetomar').onclick = () => retomarCaptura(null);
    // Tras cerrar un aviso, el segundo toque de un doble toque no debe caer en el botón que sube a su lugar
    $('#btnDescartar').onclick = () => { nuevaCaptura(); $('#avisoSesion').hidden = true; est.bloqueoToques = Date.now() + 450; };
    $('#btnSeguirActa').onclick = async () => { const b = await leerBorrador(); if (b) abrirEntrega(b.tipo, b); else revisarBorrador(); };
    $('#btnDescartarActa').onclick = async () => {
      const si = await preguntar('Descartar el acta', '¿Borrar el acta sin terminar, con sus firmas?', 'Descartar', 'Conservar');
      if (si) { borrarBorrador(); est.bloqueoToques = Date.now() + 450; }
    };

    $('#inGaleria').onchange = e => tomarArchivos(e, 'galeria');
    $('#inCamaraNativa').onchange = e => tomarArchivos(e, 'camara');
    $('#inPdf').onchange = e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) usarPdf(f, f.name, 'pdf');
    };

    $('#btnMasCamara').onclick = () => abrirCamara();
    $('#btnMasGaleria').onclick = () => $('#inGaleria').click();
    $('#btnContinuar').onclick = entrarDatos;
    $('#chkUnir').onchange = () => { guardarSesion(); unirPaginas(); };
    $('#btnRevisarTira').onclick = abrirTira;
    $('#tiraModo').onclick = cambiarModoTira;
    $('#tiraTodo').onclick = () => { if (tiraEd) { tiraEd.recorte = { x0: 0, y0: 0, x1: 1, y1: 1 }; pintarTiraEditor(); } };
    $('#tiraAuto').onclick = () => {
      if (!tiraEd || !est.tira || !est.tira.resultado) return;
      tiraEd.recorte = Object.assign({ x0: 0, y0: 0, x1: 1, y1: 1 }, est.tira.resultado.recorteSugerido || {});
      pintarTiraEditor();
    };
    $('#tiraListo').onclick = () => {
      if (tiraEd && est.tira) est.tira.recorte = Object.assign({}, tiraEd.recorte);
      cerrarCapa();
      pintarTira();
    };
    const escena = $('#tiraEscena');
    escena.addEventListener('pointerdown', e => {
      const borde = e.target.dataset && e.target.dataset.borde;
      if (!tiraEd || !borde) return;
      tiraEd.borde = borde;
      e.target.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    escena.addEventListener('pointermove', moverBordeTira);
    ['pointerup', 'pointercancel'].forEach(t => escena.addEventListener(t, () => { if (tiraEd) tiraEd.borde = null; }));
    $$('.camara-modos button').forEach(b => { b.onclick = () => elegirModoCamara(b.dataset.modo); });

    $('#btnDisparar').onclick = disparar;
    $('#btnCamaraTelefono').onclick = usarCamaraTelefono;
    $('#video').addEventListener('click', enfocarEn);
    $('#btnCerrarCamara').onclick = () => cerrarCapa(camara && camara.destino === 'acta' ? null : est.paginas.length ? 'paginas' : null);
    $('#btnListoCamara').onclick = () => cerrarCapa('paginas');
    $('#contador').onclick = () => { if (est.paginas.length) cerrarCapa('paginas'); };
    $('#btnFlash').onclick = () => {
      if (!flujo) return;
      linterna = !linterna;
      flujo.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: linterna }] }).catch(() => {});
      $('#btnFlash').classList.toggle('activo', linterna);
    };

    const svg = $('#editorSvg');
    svg.addEventListener('pointerdown', e => {
      if (!ed || e.target.dataset.i === undefined) return;
      arrastre = Number(e.target.dataset.i);
      e.target.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    svg.addEventListener('pointermove', e => {
      if (arrastre === null || !ed) return;
      ed.quad[arrastre] = puntoEditor(e);
      pintarQuad();
    });
    ['pointerup', 'pointercancel'].forEach(t => svg.addEventListener(t, () => { arrastre = null; }));
    $('#edGirar').onclick = () => { ocultarPreviaEditor(); ed.rot = (ed.rot + 90) % 360; dibujarEditor(); };
    $('#edVer').onclick = verEdicion;
    $('#edAuto').onclick = () => {
      ocultarPreviaEditor();
      const q = Escaner.detectar(ed.fuente);
      if (!q) toast('No se distingue el borde: ajusta las esquinas a mano');
      ed.quad = (q || Escaner.COMPLETA).map(p => Object.assign({}, p));
      pintarQuad();
    };
    $('#edTodo').onclick = () => { ocultarPreviaEditor(); ed.quad = Escaner.COMPLETA.map(p => Object.assign({}, p)); pintarQuad(); };
    $('#edModo').onclick = () => {
      ed.modo = ed.modo === 'color' ? 'documento' : 'color';
      pintarModo();
      if (ed.previa) { ocultarPreviaEditor(); verEdicion(); }        // en la vista previa, B/N ↔ color se ve al tiro
    };
    // Vista previa de una página
    $('#vistaAnterior').onclick = () => moverVista(-1);
    $('#vistaSiguiente').onclick = () => moverVista(1);
    $('#vistaListo').onclick = () => cerrarCapa();
    $('#vistaBorrar').onclick = borrarDesdeVista;
    $('#vistaEditar').onclick = () => { const p = vistaPagina; if (p) cerrarCapa(() => abrirEditor(p)); };
    $('#edBorrar').onclick = borrarPagina;
    $('#edListo').onclick = aplicarEdicion;
    window.addEventListener('resize', () => {
      if (ed) dibujarEditor();
      if (zoomVista && est.capa === 'vista') zoomVista.reiniciar();
      if (zoomEditor && ed && ed.previa) zoomEditor.reiniciar();
    });

    Object.keys(CAMPOS).forEach(id => {
      const el = document.getElementById(id), campo = CAMPOS[id];
      const tocar = () => { est.tocados.add(campo); el.classList.remove('sugerido', 'invalido'); };
      el.addEventListener('input', tocar);
      el.addEventListener('change', tocar);
    });
    $('#btnHoy').onclick = () => { $('#fFecha').value = hoyISO(); est.tocados.add('fecha'); $('#fFecha').classList.remove('sugerido', 'invalido'); };
    $('#fMonto').addEventListener('input', e => {
      const d = soloDigitos(e.target.value).replace(/^0+/, '');
      e.target.value = d ? miles(Number(d)) : '';
      revisarMonto();
    });
    $('#fRut').addEventListener('blur', () => { validarRut(); completarPorRut(); sugerirPorProveedor(); });
    $('#fProveedor').addEventListener('change', sugerirPorProveedor);
    // Lo escrito en "Datos del gasto" se guarda en el teléfono mientras se llena
    ['input', 'change', 'click'].forEach(t => $('#v-datos').addEventListener(t, tocarFormulario));
    $('#fCeco').addEventListener('input', validarCeco);
    $('#fMedio').addEventListener('change', pintarControlTarjeta);
    $('#segMovimiento').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b && !est.edicion) elegirMovimiento(b.dataset.valor);
    });
    $('#chkReembolso').onchange = e => cambiarReembolso(e.target.checked);
    $('#segReembolso').addEventListener('click', e => {
      const b = e.target.closest('button');
      if (b && !est.edicion) elegirMovimiento(b.dataset.valor);
    });
    $('#btnReAnterior').onclick = usarReembolsoAnterior;
    $('#fReNombre').addEventListener('input', pintarPersonasReembolso);
    $('#fReNombre').addEventListener('change', nombreReembolsoEscrito);
    $('#fReRut').addEventListener('input', () => { $('#fReRut').dataset.auto = ''; });
    $('#fReRut').addEventListener('blur', validarReRut);
    $('#fReFecha').addEventListener('change', pintarAyudaReembolso);
    $('#form').addEventListener('submit', e => e.preventDefault());
    $('#btnGuardar').onclick = () => guardar(false);

    $('#btnOtro').onclick = () => volverInicio(() => { nuevaCaptura(); abrirCamara(); });
    $('#btnCorregirListo').onclick = () => { if (est.listoActual) abrirRegistro(est.listoActual); };
    $('#btnFrecuente').onclick = guardarFrecuente;
    $('#btnNuevaCategoria').onclick = nuevaCategoria;
    $('#v-ajustes').addEventListener('click', e => {
      const b = e.target.closest('[data-quitar]');
      if (b) quitarDeLista(b.dataset.quitar, b.dataset.nombre, b);
    });
    $('#btnEntrega').onclick = pedirEntrega;
    $('#segEntrega').addEventListener('click', e => { const b = e.target.closest('button'); if (b) cambiarTipoEntrega(b.dataset.valor); });
    $('#btnLeerQr').onclick = abrirLectorQr;
    $('#btnCerrarQr').onclick = () => cerrarCapa();
    $('#btnVolver').addEventListener('click', e => { if (Date.now() < (est.bloqueoToques || 0)) e.stopImmediatePropagation(); }, true);
    $('#btnReubicar').onclick = buscarUbicacion;
    $('#btnFotoEntrega').onclick = () => abrirCamara('acta');
    $('#inFotoEntrega').onchange = ev => { const f = ev.target.files[0]; ev.target.value = ''; usarFotoEntrega(f); };
    $$('#v-entrega [data-borrar]').forEach(b => { b.onclick = () => { if (firmas) { firmas[b.dataset.borrar].borrar(); tocarEntrega(); } }; });
    $('#btnRegistrarEntrega').onclick = registrarEntrega;
    // Lo que sale en la declaración: si cambia después de firmar, se vuelve a firmar
    $('#eUltimos4').addEventListener('input', ev => { ev.target.value = soloDigitos(ev.target.value).slice(0, 4); });
    $('#eSaldo').addEventListener('input', ev => {
      const d = soloDigitos(ev.target.value).replace(/^0+(?=\d)/, '');     // "0" es un saldo válido (tarjeta vacía)
      ev.target.value = d ? miles(Number(d)) : '';
    });
    IDS_ENTREGA.forEach(id => document.getElementById(id).addEventListener('input', () => {
      if (!est.entrega) return;
      document.getElementById(id).dataset.auto = '';       // escrito a mano: elegir a otra persona no lo pisa
      if (IDS_DECLARACION.includes(id)) invalidarFirmas();
      tocarEntrega();
      pintarDeclaracion();
    }));
    // Nombre de una persona de la base (escrito completo, o nombre y apellido al salir del campo): se llenan su RUT, cargo y correo
    ['Entrega', 'Recibe'].forEach(pre => {
      const el = document.getElementById(`e${pre}Nombre`);
      el.addEventListener('input', () => {
        if (!est.entrega) return;
        const p = buscarPersona(el.value, true);
        if (p) elegirPersona(pre, p, true);
        else { soltarPersona(pre); pintarPersonasActa(); }
      });
      el.addEventListener('change', () => { const p = buscarPersona(el.value); if (p && est.entrega) elegirPersona(pre, p, true); });
    });
    $('#aNombre').addEventListener('change', () => {
      const p = buscarPersona($('#aNombre').value);
      if (!p) return;
      $('#aNombre').value = p.nombre;
      if (!$('#aRut').value.trim() && p.rut) $('#aRut').value = p.rut;
      if (!$('#aCargo').value.trim() && p.cargo) $('#aCargo').value = p.cargo;
    });
    ['eEntregaRut', 'eRecibeRut'].forEach(id => document.getElementById(id).addEventListener('blur', () => {
      pintarEstadoRut(id);
      pintarDeclaracion();
    }));
    $('#eConforme').addEventListener('change', ev => {
      if (!est.entrega) return;
      est.entrega.momentoLeido = ev.target.checked ? new Date().toISOString() : null;   // la hora que ambos confirmaron
      ev.target.classList.remove('invalido');
      tocarEntrega();
      pintarDeclaracion();
    });
    // La cola se envía sola: al volver a la app, al recuperar la señal y cada 45 s mientras quede algo pendiente
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') enviarCola(true);
      else guardarPendientes();                 // Android puede cerrar la app al salir: lo escrito se guarda ya
    });
    window.addEventListener('pagehide', guardarPendientes);
    setInterval(async () => {
      let items = [];
      try { items = await Api.pendientes(); } catch (e) { return; }
      if (navigator.onLine && items.some(i => (i.intentos || 0) < 3)) enviarCola(true);
    }, 45000);
    window.addEventListener('resize', () => { if (est.vista === 'entrega' && firmas) { firmas.entrega.preparar(); firmas.recibe.preparar(); } });
    $('#btnVerMas').onclick = verMas;
    $('#rgCorregir').onclick = entrarEdicion;
    $('#rgDeshacer').onclick = deshacerRegistro;
    $('#rgAnular').onclick = anularRegistro;
    $('#btnGuardarAjustes').onclick = guardarAjustes;
    $('#btnProbar').onclick = probarConexion;
    window.addEventListener('online', () => enviarCola(true));
  }

  async function iniciar() {
    history.replaceState({ vista: 'inicio', prof: 0 }, '');
    $('#avisoDemo').hidden = !Api.demo;
    est.listas = leerLocal('listas');
    est.tarjetas = leerLocal('tarjetas') || {};
    est.huellasQr = leerLocal('huellasQr') || {};
    if (leerLocal('custodia')) pintarCustodia(leerLocal('custodia'));
    usarRapido(leerLocal('rapido') || {}, true);
    prepararInstalacion();
    enlazar();
    await restaurarSesion();
    const etapa = await leerEtapa();               // antes de mostrar el inicio, que la borra
    mostrar('inicio');
    await vincularDesdeEnlace();
    cargarConfig();
    enviarCola(true);
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

    const q = new URLSearchParams(location.search);
    if (q.has('compartido')) await recibirCompartidos();
    else if (q.get('accion') === 'escanear' && leerLocal('camaraNativa')) toast('Toca «Escanear documento» para abrir la cámara del teléfono', 5000);
    else if (q.get('accion') === 'escanear' && await descartarSiHay()) { nuevaCaptura(); abrirCamara(); }
    else if (etapa) await retomarEtapa(etapa);

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      const habiaControlador = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.register('sw.js').catch(() => {});
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (habiaControlador && est.vista === 'inicio' && !hayDocumento() && !est.guardando) location.reload();
      });
    }
  }

  iniciar();
})();
