// Registro y verificación de certificados en Supabase (solo a través de funciones públicas).
(function (root) {
  "use strict";
  var URL_API = "https://jxsdgzoteeklxhqkorde.supabase.co/rest/v1/rpc/";
  var KEY = "sb_publishable_EfARpl_kqAKG7cIJ32bLuQ_GQrffu4W";
  var VERIFY_URL = "https://luiscalderond.github.io/perito-obd/verificar.html";

  async function rpc(name, body) {
    var r = await fetch(URL_API + name, {
      method: "POST",
      headers: { "apikey": KEY, "Authorization": "Bearer " + KEY, "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    if (!r.ok) throw new Error("Servidor respondió " + r.status);
    return r.json();
  }

  async function registrar(d) {
    var datos = {};
    Object.keys(d).forEach(function (k) { if (["hallazgos", "texto", "codigo", "fecha", "registrado"].indexOf(k) < 0) datos[k] = d[k]; });
    var rows = await rpc("crear_certificado", {
      p_placa: d.placa || null, p_vin: d.vin || null, p_km: d.kmTablero != null ? d.kmTablero : null,
      p_hallazgos: d.hallazgos, p_datos: datos
    });
    if (!rows || !rows[0]) throw new Error("Sin respuesta del servidor");
    return rows[0];
  }

  async function ver(codigo) {
    var rows = await rpc("ver_certificado", { p_codigo: codigo });
    return rows && rows[0] ? rows[0] : null;
  }

  function urlVerificacion(codigo) { return VERIFY_URL + "?c=" + encodeURIComponent(codigo); }

  root.CLOUD = { registrar: registrar, ver: ver, urlVerificacion: urlVerificacion };
})(window);
