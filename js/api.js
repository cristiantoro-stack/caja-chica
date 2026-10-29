/* Comunicación con el servidor (Apps Script de la cuenta de Telconsulting) y cola sin conexión. */
const Api = (() => {
  const demo = new URLSearchParams(location.search).has('demo');
  const CLAVE = demo ? 'cc-demo.config' : 'cc.config';

  class ErrorApi extends Error {
    constructor(mensaje, codigo, datos) { super(mensaje); this.codigo = codigo; this.datos = datos; }
  }

  function config() {
    try { return JSON.parse(localStorage.getItem(CLAVE)) || {}; } catch (e) { return {}; }
  }
  function guardarConfig(cambios) {
    localStorage.setItem(CLAVE, JSON.stringify(Object.assign(config(), cambios)));
  }
  const configurada = () => demo || !!(config().url && config().token);

  async function llamar(accion, datos = {}, { espera = 60000 } = {}) {
    if (demo) return Demo.responder(accion, datos);
    const { url, token } = config();
    if (!url || !token) throw new ErrorApi('Falta vincular la app con Drive (Ajustes)', 'config');
    if (!navigator.onLine) throw new ErrorApi('Sin conexión a internet', 'red');
    const control = new AbortController(), reloj = setTimeout(() => control.abort(), espera);
    let respuesta;
    try {
      // Cuerpo en texto plano: evita la verificación previa (CORS) que Apps Script no responde.
      respuesta = await fetch(url, {
        method: 'POST', body: JSON.stringify(Object.assign({ accion, token }, datos)),
        signal: control.signal, redirect: 'follow', cache: 'no-store'
      });
    } catch (e) {
      throw new ErrorApi(e.name === 'AbortError' ? 'El servidor tardó demasiado en responder' : 'Sin conexión con el servidor', 'red');
    } finally {
      clearTimeout(reloj);
    }
    const texto = await respuesta.text();
    let j;
    try { j = JSON.parse(texto); } catch (e) {
      throw new ErrorApi(respuesta.ok ? 'Respuesta inesperada: revisa la dirección del servidor en Ajustes'
        : 'Error del servidor (' + respuesta.status + ')', 'servidor');
    }
    if (!j.ok) throw new ErrorApi(j.error || 'Error del servidor', j.codigo || 'servidor', j);
    return j;
  }

  // ---------- Cola sin conexión ----------

  async function encolar(payload) {
    const id = 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await DB.guardar('cola', id, { id, payload, creado: new Date().toISOString(), intentos: 0 });
    return id;
  }

  const pendientes = async () => (await DB.todos('cola')) || [];

  /** Envía lo que esté en cola, de a un envío a la vez. Los que fallaron 3 veces solo se reintentan a pedido. */
  let envioEnCurso = null;
  function enviarCola(alAvanzar, incluirBloqueados, guardarRepetidos) {
    if (demo) return Promise.resolve(0);
    if (!envioEnCurso) {
      envioEnCurso = enviarPendientes(alAvanzar, !!incluirBloqueados, !!guardarRepetidos).finally(() => { envioEnCurso = null; });
    }
    return envioEnCurso;
  }

  async function enviarPendientes(alAvanzar, incluirBloqueados, guardarRepetidos) {
    let enviados = 0;
    for (const item of await pendientes()) {
      if ((item.intentos || 0) >= 3 && !incluirBloqueados) continue;
      if (item.duplicado && !guardarRepetidos) continue;     // un "parecido" solo se guarda si la persona lo confirma
      try {
        const payload = item.duplicado ? Object.assign({}, item.payload, { forzar: true }) : item.payload;
        const r = await llamar('guardar', payload, { espera: 150000 });
        await DB.borrar('cola', item.id);
        enviados++;
        if (alAvanzar) alAvanzar(r, item, null);
      } catch (e) {
        if (e.codigo === 'red' || e.codigo === 'config' || e.codigo === 'clave') break;
        if (e.codigo === 'duplicado') {
          const dup = e.datos && e.datos.duplicado;
          if (dup && dup.mismoArchivo) {          // ya había llegado (se perdió la respuesta): no se repite
            await DB.borrar('cola', item.id);
            if (alAvanzar) alAvanzar(null, item, e);
            continue;
          }
          item.intentos = 3;                      // parecido a otro registro: queda retenido hasta que la persona decida
          item.duplicado = dup || true;
          item.ultimoError = dup ? `parece repetido de ${dup.id} (${dup.motivo})` : 'parece repetido';
          await DB.guardar('cola', item.id, item);
          continue;
        }
        item.intentos = (item.intentos || 0) + 1;
        item.ultimoError = e.message;
        await DB.guardar('cola', item.id, item);
      }
    }
    return enviados;
  }

  const descartar = id => DB.borrar('cola', id);

  return { demo, ErrorApi, config, guardarConfig, configurada, llamar, encolar, pendientes, enviarCola, descartar };
})();

/* Respuestas simuladas para probar la app sin servidor (?demo). */
const Demo = (() => {
  const espera = ms => new Promise(r => setTimeout(r, ms));
  let correlativo = 7;
  const listas = {
    movimientos: ['Desembolso MP', 'Ingreso caja chica', 'Rendición Santander'],
    tiposDoc: ['Boleta electrónica', 'Factura electrónica', 'Factura exenta electrónica', 'Boleta manual',
      'Comprobante de pago', 'Comprobante de transferencia', 'Nota de crédito', 'Guía de despacho', 'Otro'],
    categorias: [
      { nombre: 'Alimentación equipo', ceco: 'ADMVTA-GASVAR-GASADM' }, { nombre: 'Atención a clientes', ceco: 'ADMTVA-GASVAR-GASCOM' },
      { nombre: 'Movilización y estacionamiento', ceco: '' }, { nombre: 'Combustible', ceco: '' },
      { nombre: 'Materiales y ferretería', ceco: '' }, { nombre: 'Insumos de oficina', ceco: 'ADMVTA-GASVAR-GASADM' },
      { nombre: 'Aseo y cafetería', ceco: 'ADMVTA-GASVAR-GASADM' }, { nombre: 'Envíos y courier', ceco: '' },
      { nombre: 'Trámites y notaría', ceco: 'ADMVTA-GASVAR-GASADM' }, { nombre: 'Tecnología y accesorios', ceco: '' },
      { nombre: 'Recarga caja chica', ceco: '' }, { nombre: 'Otros', ceco: '' }
    ],
    medios: ['Tarjeta MP', 'QR Mercado Pago', 'Transferencia MP', 'Tarjeta Santander', 'Transferencia Santander', 'Efectivo'],
    estados: ['Pendiente revisión', 'Revisado', 'Conciliado', 'Observado', 'Anulado'],
    cecos: [{ codigo: 'ADMVTA-GASVAR-GASADM', significado: 'Gastos administrativos variables' },
      { codigo: 'ADMTVA-GASVAR-GASCOM', significado: 'Gastos comerciales variables' },
      { codigo: 'nRC-INT-SAT', significado: 'Internet satelital no recurrente' }]
  };
  const ultimos = [
    { id: 'CC-2026-0006', fecha: '2026-10-27', proveedor: 'COPEC S.A.', monto: 25990, estado: 'Pendiente revisión', controlTarjeta: '✓ ****1234', respaldoUrl: '#' },
    { id: 'CC-2026-0005', fecha: '2026-10-24', proveedor: 'Ferretería El Maestro Ltda.', monto: 59500, estado: 'Conciliado', controlTarjeta: '✓ ****1234', respaldoUrl: '#' },
    { id: 'CC-2026-0004', fecha: '2026-10-22', proveedor: 'Estacionamientos Central', monto: 12490, estado: 'Observado', controlTarjeta: '✗ Otra tarjeta ****5678', respaldoUrl: '#' }
  ];

  async function responder(accion, datos) {
    await espera(accion === 'ocr' ? 1600 : accion === 'guardar' ? 1400 : 300);
    switch (accion) {
      case 'ping': return { ok: true, version: 'demo', cuenta: 'demo@telconsulting.cl' };
      case 'config': return { ok: true, listas, tarjetas: { mp: '****1234', santander: '' }, planillaUrl: '#', version: 'demo' };
      case 'configurar': return { ok: true, tarjetas: { mp: '****' + (datos.tarjetaMP || '1234'), santander: '' } };
      case 'resumen': return {
        ok: true, saldo: 154510, planillaUrl: '#', ultimos,
        mes: { mes: '2026-10', documentos: 6, desembolsos: 245300, ingresos: 400000, conTarjeta: 5, tarjetaOk: 4 }
      };
      case 'ocr': return {
        ok: true, texto: 'COPEC S.A.\nR.U.T.: 99.520.000-7\nBOLETA ELECTRONICA\nN° 45872310\nTOTAL $ 25.990\n************1234',
        sugeridos: { tipoDoc: 'Boleta electrónica', numero: '45872310', fecha: '2026-10-27', monto: 25990, montoConfianza: 'alta', rut: '99.520.000-7', proveedor: 'COPEC S.A.' },
        tarjetas: { 'Tarjeta MP': { resultado: 'coincide', encontradas: ['1234'], texto: '✓ ****1234' },
          'Tarjeta Santander': { resultado: 'sin_config', encontradas: ['1234'], texto: 'Tarjeta sin configurar' } },
        mercadoPago: false
      };
      case 'guardar': {
        const id = 'CC-2026-' + String(++correlativo).padStart(4, '0');
        return { ok: true, id, fila: 4 + correlativo, respaldoUrl: '#', resumenUrl: '#', planillaUrl: '#', controlTarjeta: '✓ ****1234', alertas: [] };
      }
      default: return { ok: true };
    }
  }
  return { responder, listas };
})();
