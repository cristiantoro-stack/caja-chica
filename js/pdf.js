/* PDF mínimo: una imagen JPEG por página, al ancho de una hoja A4 y con el alto que necesite
   (las boletas largas no quedan achicadas). Sin librerías, funciona sin conexión. */
const Pdf = (() => {
  const cod = new TextEncoder();

  function textoPdf(s) {
    let hex = 'FEFF';
    for (const ch of String(s)) {
      const c = ch.codePointAt(0);
      if (c > 0xffff) {
        const v = c - 0x10000;
        hex += (0xd800 + (v >> 10)).toString(16).padStart(4, '0') + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, '0');
      } else {
        hex += c.toString(16).padStart(4, '0');
      }
    }
    return '<' + hex.toUpperCase() + '>';
  }

  function fechaPdf(d) {
    const p = n => String(n).padStart(2, '0');
    return `D:${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  /** paginas: [{ jpeg: Uint8Array, ancho, alto }] → Blob application/pdf */
  function crear(paginas, info = {}) {
    const partes = [], posiciones = [];
    let largo = 0;
    const escribir = x => { const b = typeof x === 'string' ? cod.encode(x) : x; partes.push(b); largo += b.length; };
    const objeto = (id, cuerpo) => {
      posiciones[id] = largo;
      escribir(`${id} 0 obj\n`);
      if (typeof cuerpo === 'function') cuerpo(); else escribir(cuerpo);
      escribir('\nendobj\n');
    };
    const n = paginas.length, total = 3 + n * 3;
    const idPagina = i => 4 + i * 3, idContenido = i => 5 + i * 3, idImagen = i => 6 + i * 3;

    escribir('%PDF-1.4\n');
    escribir(new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));
    objeto(1, '<< /Type /Catalog /Pages 2 0 R >>');
    objeto(2, `<< /Type /Pages /Kids [${paginas.map((_, i) => idPagina(i) + ' 0 R').join(' ')}] /Count ${n} >>`);
    objeto(3, `<< /Title ${textoPdf(info.titulo || 'Respaldo caja chica')} /Author ${textoPdf(info.autor || 'Telconsulting')}`
      + ` /Creator ${textoPdf('App Caja Chica · Telconsulting')} /CreationDate (${fechaPdf(new Date())}) >>`);

    paginas.forEach((p, i) => {
      let w = 595.28, h = w * p.alto / p.ancho;
      if (h > 14400) { w = w * 14400 / h; h = 14400; }
      w = Number(w.toFixed(2)); h = Number(h.toFixed(2));
      objeto(idPagina(i), `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im${i} ${idImagen(i)} 0 R >> >> /Contents ${idContenido(i)} 0 R >>`);
      const dibujo = `q ${w} 0 0 ${h} 0 0 cm /Im${i} Do Q`;
      objeto(idContenido(i), `<< /Length ${dibujo.length} >>\nstream\n${dibujo}\nendstream`);
      objeto(idImagen(i), () => {
        escribir(`<< /Type /XObject /Subtype /Image /Width ${p.ancho} /Height ${p.alto} /ColorSpace /DeviceRGB`
          + ` /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.jpeg.length} >>\nstream\n`);
        escribir(p.jpeg);
        escribir('\nendstream');
      });
    });

    const inicioXref = largo;
    let xref = `xref\n0 ${total + 1}\n0000000000 65535 f \n`;
    for (let id = 1; id <= total; id++) xref += String(posiciones[id]).padStart(10, '0') + ' 00000 n \n';
    escribir(xref);
    escribir(`trailer\n<< /Size ${total + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`);
    return new Blob(partes, { type: 'application/pdf' });
  }

  return { crear };
})();
