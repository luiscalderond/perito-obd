// Lógica OBD-II: transporte Bluetooth (ELM327 por BLE), modo demo, lectura y reglas del semáforo.
// Funciones puras exportadas también para pruebas en Node.
(function (root) {
  "use strict";

  // ---------- Utilidades de respuesta ELM327 ----------

  // Limpia la respuesta: quita eco, "SEARCHING...", prompt y espacios. Devuelve líneas en hex.
  function cleanLines(raw) {
    return String(raw || "")
      .replace(/>/g, "")
      .split(/[\r\n]+/)
      .map(function (l) { return l.trim().toUpperCase(); })
      .filter(function (l) {
        return l && l.indexOf("SEARCHING") < 0 && l.indexOf("BUS INIT") < 0 && l !== "OK";
      })
      .map(function (l) { return l.replace(/\s+/g, ""); });
  }

  function isNoData(raw) {
    return /NO ?DATA|UNABLE|ERROR|STOPPED|\?|CAN ?ERROR|BUS ?ERROR/i.test(String(raw || ""));
  }

  // Une respuestas multi-trama ISO-TP ("014", "0:4902..", "1:....") en una sola cadena hex.
  function joinFrames(lines) {
    var hasFrames = lines.some(function (l) { return /^[0-9A-F]:/.test(l); });
    if (!hasFrames) return lines.join("");
    return lines
      .filter(function (l) { return /^[0-9A-F]:/.test(l); })
      .map(function (l) { return l.slice(2); })
      .join("");
  }

  function bytesAfter(hex, marker) {
    var i = hex.indexOf(marker);
    if (i < 0) return null;
    var rest = hex.slice(i + marker.length), out = [];
    for (var j = 0; j + 1 < rest.length; j += 2) out.push(parseInt(rest.substr(j, 2), 16));
    return out;
  }

  // Bytes de datos de un PID de modo 01 (primera ECU que responda).
  function pidBytes(raw, pid) {
    if (isNoData(raw)) return null;
    var lines = cleanLines(raw);
    var marker = "41" + pid.toUpperCase();
    for (var k = 0; k < lines.length; k++) {
      var b = bytesAfter(lines[k], marker);
      if (b && b.length) return b;
    }
    var joined = bytesAfter(joinFrames(lines), marker);
    return joined && joined.length ? joined : null;
  }

  // ---------- Decodificadores ----------

  function parseVin(raw) {
    if (isNoData(raw)) return null;
    var hex = joinFrames(cleanLines(raw));
    var b = bytesAfter(hex, "4902");
    if (!b) return null;
    var s = b.map(function (c) { return String.fromCharCode(c); }).join("").replace(/[^A-HJ-NPR-Z0-9]/g, "");
    return s.length >= 17 ? s.slice(-17) : null;
  }

  function decodeDtc(a, b) {
    var letters = ["P", "C", "B", "U"];
    return letters[a >> 6] + ((a >> 4) & 3) + (a & 15).toString(16).toUpperCase() +
      ((b >> 4) & 15).toString(16).toUpperCase() + (b & 15).toString(16).toUpperCase();
  }

  // mode: "43" (activos), "47" (pendientes), "4A" (permanentes)
  function parseDtcs(raw, mode) {
    if (isNoData(raw)) return [];
    var lines = cleanLines(raw), chunks = [];
    if (lines.some(function (l) { return /^[0-9A-F]:/.test(l); })) chunks = [joinFrames(lines)];
    else chunks = lines;
    var found = {};
    chunks.forEach(function (hex) {
      var i = hex.indexOf(mode);
      if (i < 0) return;
      var data = hex.slice(i + 2);
      var n = Math.floor(data.length / 2);
      // En CAN viene un byte con la cantidad de códigos: número impar de bytes.
      if (n % 2 === 1) data = data.slice(2);
      for (var j = 0; j + 3 < data.length; j += 4) {
        var a = parseInt(data.substr(j, 2), 16), c = parseInt(data.substr(j + 2, 2), 16);
        if (a === 0 && c === 0) continue;
        found[decodeDtc(a, c)] = true;
      }
    });
    return Object.keys(found);
  }

  var SPARK_MONITORS = ["Catalizador", "Catalizador calefactado", "Sistema evaporativo", "Aire secundario",
    "Refrigerante A/C", "Sensor de oxígeno", "Calefactor sensor O2", "Recirculación de gases (EGR)"];
  var DIESEL_MONITORS = ["Catalizador NMHC", "Catalizador NOx/SCR", null, "Presión de sobrealimentación",
    null, "Sensor de gases de escape", "Filtro de partículas (DPF)", "EGR / VVT"];
  var CONT_MONITORS = ["Fallas de encendido", "Sistema de combustible", "Componentes"];

  function parseMonitors(raw) {
    var b = pidBytes(raw, "01");
    if (!b || b.length < 4) return null;
    var A = b[0], B = b[1], C = b[2], D = b[3];
    var diesel = !!(B & 8);
    var names = diesel ? DIESEL_MONITORS : SPARK_MONITORS;
    var list = [];
    for (var i = 0; i < 3; i++) {
      if (B & (1 << i)) list.push({ name: CONT_MONITORS[i], ready: !(B & (1 << (i + 4))) });
    }
    for (var j = 0; j < 8; j++) {
      if (names[j] && (C & (1 << j))) list.push({ name: names[j], ready: !(D & (1 << j)) });
    }
    return {
      mil: !!(A & 128),
      dtcCount: A & 127,
      diesel: diesel,
      monitors: list,
      incomplete: list.filter(function (m) { return !m.ready; }).length
    };
  }

  function word(b) { return b && b.length >= 2 ? b[0] * 256 + b[1] : null; }

  var DECODE = {
    "05": function (b) { return b ? b[0] - 40 : null; },                         // °C refrigerante
    "06": function (b) { return b ? Math.round((b[0] - 128) * 1000 / 128) / 10 : null; }, // % STFT B1
    "07": function (b) { return b ? Math.round((b[0] - 128) * 1000 / 128) / 10 : null; }, // % LTFT B1
    "08": function (b) { return b ? Math.round((b[0] - 128) * 1000 / 128) / 10 : null; }, // % STFT B2
    "09": function (b) { return b ? Math.round((b[0] - 128) * 1000 / 128) / 10 : null; }, // % LTFT B2
    "0C": function (b) { return b && b.length >= 2 ? Math.round(word(b) / 4) : null; },   // rpm
    "21": word,                                                                    // km con testigo encendido
    "31": word,                                                                    // km desde borrado
    "4E": word,                                                                    // min desde borrado
    "A6": function (b) {                                                           // km odómetro (si existe)
      return b && b.length >= 4 ? Math.round(((b[0] * 16777216) + (b[1] << 16) + (b[2] << 8) + b[3]) / 10) : null;
    }
  };

  function decodePid(raw, pid) {
    var b = pidBytes(raw, pid);
    return DECODE[pid] ? DECODE[pid](b) : null;
  }

  function parseVoltage(raw) {
    var m = String(raw || "").match(/(\d{1,2}\.\d)\s*V/i);
    return m ? parseFloat(m[1]) : null;
  }

  // ---------- Reglas del semáforo ----------
  // Cada hallazgo: { nivel: "rojo"|"amarillo"|"verde"|"gris", sistema, titulo, detalle }

  // Significado en lenguaje simple de los códigos más comunes; el resto lo explicará la IA.
  var DTC_TXT = {
    P0171: "mezcla pobre banco 1", P0174: "mezcla pobre banco 2", P0172: "mezcla rica banco 1", P0175: "mezcla rica banco 2",
    P0300: "fallas de encendido en varios cilindros", P0420: "catalizador con baja eficiencia", P0430: "catalizador banco 2 con baja eficiencia",
    P0128: "termostato: motor no alcanza temperatura", P0101: "sensor de flujo de aire (MAF)", P0442: "fuga pequeña en sistema evaporativo",
    P0455: "fuga grande en sistema evaporativo (tapa de gasolina)", P0700: "falla registrada en la caja automática", P0562: "voltaje de sistema bajo"
  };
  function dtcList(codes) {
    return codes.map(function (c) {
      var m = /^P030([1-8])$/.exec(c);
      var t = m ? "falla de encendido en cilindro " + m[1] : DTC_TXT[c];
      return t ? c + " (" + t + ")" : c;
    }).join(", ");
  }

  function evaluate(d) {
    var out = [];
    function add(nivel, sistema, titulo, detalle) { out.push({ nivel: nivel, sistema: sistema, titulo: titulo, detalle: detalle }); }

    // Fallas
    var act = d.dtcActivos || [], pen = d.dtcPendientes || [], per = d.dtcPermanentes || [];
    if (act.length || (d.monitores && d.monitores.mil)) {
      add("rojo", "Fallas", "Fallas activas en el motor",
        (act.length ? "Códigos: " + dtcList(act) + ". " : "") + (d.monitores && d.monitores.mil ? "El testigo de motor está encendido." : ""));
    } else if (per.length) {
      add("rojo", "Fallas", "Fallas permanentes registradas",
        "Códigos: " + dtcList(per) + ". Estas fallas no se borran con escáner: el problema existió hace poco y el sistema aún no confirma que se corrigió.");
    } else if (pen.length) {
      add("amarillo", "Fallas", "Fallas pendientes", "Códigos: " + dtcList(pen) + ". El motor detectó algo que todavía no se confirma como falla.");
    } else {
      add("verde", "Fallas", "Sin códigos de falla", "No hay fallas activas, pendientes ni permanentes en el motor.");
    }

    // Borrado reciente
    var mon = d.monitores, km = d.kmDesdeBorrado, min = d.minDesdeBorrado;
    if (mon || km != null) {
      var inc = mon ? mon.incomplete : 0;
      var poco = km != null && km < 100;
      if (inc >= 2 && (poco || km == null)) {
        add("rojo", "Borrado", "Posible borrado de fallas reciente",
          inc + " monitores incompletos" + (km != null ? " y solo " + km + " km desde el último borrado" : "") +
          ". Es típico de un carro al que le limpiaron las fallas antes de venderlo. Repetir la lectura tras unos 100 km.");
      } else if (inc >= 2 || poco) {
        add("amarillo", "Borrado", "Revisar borrado de fallas",
          (inc ? inc + " monitores incompletos. " : "") + (km != null ? km + " km desde el último borrado" : "") +
          (min != null ? " (" + min + " min de motor)." : "."));
      } else {
        add("verde", "Borrado", "Sin señales de borrado reciente",
          (km != null ? km.toLocaleString("es-EC") + " km desde el último borrado. " : "") + "Monitores completos.");
      }
    }

    // Kilometraje
    var kmTab = d.kmTablero, odo = d.odometroEcu;
    if (kmTab != null && odo != null) {
      var diff = Math.abs(odo - kmTab);
      if (diff > 1000) add("rojo", "Kilometraje", "Kilometraje inconsistente",
        "Tablero: " + kmTab.toLocaleString("es-EC") + " km. Computadora del motor: " + odo.toLocaleString("es-EC") + " km. Diferencia de " + diff.toLocaleString("es-EC") + " km.");
      else add("verde", "Kilometraje", "Kilometraje coherente", "El tablero coincide con la computadora del motor (" + odo.toLocaleString("es-EC") + " km).");
    } else if (kmTab != null && km != null && km > kmTab + 500) {
      add("rojo", "Kilometraje", "Kilometraje imposible",
        "La computadora registra " + km.toLocaleString("es-EC") + " km desde el último borrado, más que los " + kmTab.toLocaleString("es-EC") + " km del tablero.");
    } else if (kmTab != null) {
      add("gris", "Kilometraje", "Kilometraje sin verificar", "Este modelo no entrega el odómetro por OBD genérico. Se verificará con los paquetes de marca.");
    }

    // Batería y carga
    var vr = d.voltajeReposo, va = d.voltajeArranque, vc = d.voltajeCarga;
    if (vr != null || va != null || vc != null) {
      var nivel = "verde", notas = [];
      if (vr != null) { notas.push("reposo " + vr.toFixed(1) + " V"); if (vr < 11.8) nivel = "rojo"; else if (vr < 12.2 && nivel !== "rojo") nivel = "amarillo"; }
      if (va != null) { notas.push("arranque " + va.toFixed(1) + " V"); if (va < 9.0) nivel = "rojo"; else if (va < 9.6 && nivel !== "rojo") nivel = "amarillo"; }
      if (vc != null) { notas.push("cargando " + vc.toFixed(1) + " V"); if ((vc < 13.2 || vc > 15.0) && nivel === "verde") nivel = "amarillo"; }
      var tit = nivel === "verde" ? "Batería y alternador en buen estado" : nivel === "amarillo" ? "Batería o carga a revisar" : "Batería débil";
      add(nivel, "Batería", tit, "Medido: " + notas.join(", ") + ".");
    }

    // Mezcla de combustible (motor en marcha)
    var lt = [d.ltft1, d.ltft2].filter(function (x) { return x != null; });
    var st = [d.stft1, d.stft2].filter(function (x) { return x != null; });
    if (lt.length) {
      var tot = lt.map(function (v, i) { return v + (st[i] || 0); });
      var peor = tot.reduce(function (m, v) { return Math.abs(v) > Math.abs(m) ? v : m; }, 0);
      var n2 = Math.abs(peor) > 20 ? "rojo" : Math.abs(peor) > 10 ? "amarillo" : "verde";
      var causa = peor > 10 ? " La computadora está agregando combustible: posible fuga de vacío, filtro o bomba débil, o sensor de aire sucio."
        : peor < -10 ? " La computadora está quitando combustible: posibles inyectores goteando o sensor de oxígeno defectuoso." : "";
      add(n2, "Motor", n2 === "verde" ? "Mezcla de combustible normal" : "Mezcla de combustible desajustada",
        "Corrección total " + (peor > 0 ? "+" : "") + peor.toFixed(1) + "% (largo plazo " + lt.map(function (v) { return (v > 0 ? "+" : "") + v; }).join(" / ") + "%)." + causa);
    }

    // Temperatura
    if (d.refrigerante != null) {
      var t = d.refrigerante;
      if (t > 105) add("rojo", "Refrigeración", "Motor caliente", "Refrigerante a " + t + " °C. Revisar radiador, ventilador y bomba de agua.");
      else if (t < 70 && d.rpm) add("amarillo", "Refrigeración", "Motor no alcanza temperatura", "Refrigerante a " + t + " °C. Si el motor lleva más de 10 minutos encendido, revisar termostato.");
      else add("verde", "Refrigeración", "Temperatura normal", "Refrigerante a " + t + " °C.");
    }

    var orden = { rojo: 0, amarillo: 1, gris: 2, verde: 3 };
    out.sort(function (a, b) { return orden[a.nivel] - orden[b.nivel]; });
    return out;
  }

  // ---------- Transportes ----------

  // Servicios BLE conocidos de adaptadores ELM327 (vLinker, genéricos FFF0/FFE0).
  var BLE_SERVICES = [
    "e7810a71-73ae-499d-8c15-faa9aef0c3f2",
    0xfff0, 0xffe0, 0x18f0,
    "0000fff0-0000-1000-8000-00805f9b34fb"
  ];

  function BleTransport(log) {
    this.log = log || function () {};
    this.buffer = "";
    this.waiter = null;
    this.queue = Promise.resolve();
  }

  BleTransport.prototype.connect = async function () {
    if (!navigator.bluetooth) throw new Error("Este navegador no tiene Bluetooth web. Use Chrome en Android.");
    var device = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    this.device = device;
    this.log("Adaptador elegido: " + (device.name || "sin nombre"));
    var server = await device.gatt.connect();
    var services = await server.getPrimaryServices();
    var writeChar = null, notifyChar = null;
    for (var s = 0; s < services.length; s++) {
      var chars = await services[s].getCharacteristics();
      for (var c = 0; c < chars.length; c++) {
        var p = chars[c].properties;
        if (!writeChar && (p.write || p.writeWithoutResponse)) writeChar = chars[c];
        if (!notifyChar && (p.notify || p.indicate)) notifyChar = chars[c];
      }
      if (writeChar && notifyChar) { this.log("Servicio: " + services[s].uuid); break; }
      writeChar = null; notifyChar = null;
    }
    if (!writeChar || !notifyChar) throw new Error("El adaptador no expone un canal de datos compatible.");
    this.writeChar = writeChar;
    var self = this;
    await notifyChar.startNotifications();
    notifyChar.addEventListener("characteristicvaluechanged", function (e) {
      self.buffer += new TextDecoder().decode(e.target.value);
      if (self.buffer.indexOf(">") >= 0 && self.waiter) {
        var w = self.waiter; self.waiter = null;
        var out = self.buffer; self.buffer = "";
        w(out);
      }
    });
    device.addEventListener("gattserverdisconnected", function () { self.log("Adaptador desconectado."); });
  };

  BleTransport.prototype.send = function (cmd, timeoutMs) {
    var self = this;
    var job = function () {
      return new Promise(function (resolve) {
        self.buffer = "";
        var timer = setTimeout(function () { self.waiter = null; resolve(self.buffer + " [sin respuesta]"); }, timeoutMs || 4000);
        self.waiter = function (txt) { clearTimeout(timer); resolve(txt); };
        var data = new TextEncoder().encode(cmd + "\r");
        var writes = Promise.resolve();
        for (var i = 0; i < data.length; i += 20) {
          (function (chunk) {
            writes = writes.then(function () {
              return self.writeChar.properties.writeWithoutResponse
                ? self.writeChar.writeValueWithoutResponse(chunk)
                : self.writeChar.writeValue(chunk);
            });
          })(data.slice(i, i + 20));
        }
        writes.catch(function (e) { clearTimeout(timer); self.waiter = null; resolve("ERROR " + e.message); });
      });
    };
    var p = this.queue.then(job);
    this.queue = p.catch(function () {});
    return p;
  };

  // Carro simulado: Kia Sportage 2019 con fallas borradas y cilindro con falla pendiente.
  function DemoTransport() { this.running = false; this.cranking = false; }
  DemoTransport.prototype.connect = async function () {};
  DemoTransport.prototype.send = async function (cmd) {
    await new Promise(function (r) { setTimeout(r, 120); });
    var c = cmd.toUpperCase().replace(/\s/g, "");
    var R = {
      "ATZ": "ELM327 v1.5\r\r>", "ATE0": "OK\r\r>", "ATL0": "OK\r\r>", "ATS0": "OK\r\r>", "ATH0": "OK\r\r>", "ATSP0": "OK\r\r>",
      "ATDPN": "A6\r\r>",
      "0100": "SEARCHING...\r4100BE3FA813\r\r>",
      "0902": "014\r0:4902014B4E41\r1:504E383142424B\r2:37353132333435\r\r>",
      "0101": "41010007E561\r\r>",
      "03": "4300\r\r>",
      "07": "47010301\r\r>",
      "0A": "4A00\r\r>",
      "0131": "41310012\r\r>",
      "0121": "41210000\r\r>",
      "014E": "414E0009\r\r>",
      "01A6": "NO DATA\r\r>",
      "0105": this.running ? "41057D\r\r>" : "410545\r\r>",
      "010C": this.running ? "410C0C80\r\r>" : "410C0000\r\r>",
      "0106": "410685\r\r>", "0107": "410786\r\r>", "0108": "NO DATA\r\r>", "0109": "NO DATA\r\r>"
    };
    if (c === "ATRV") {
      var v = this.cranking ? (9.9 + Math.random() * 0.6) : this.running ? 14.2 : 12.5;
      return v.toFixed(1) + "V\r\r>";
    }
    return R[c] || "NO DATA\r\r>";
  };

  var api = {
    isNoData: isNoData, cleanLines: cleanLines, joinFrames: joinFrames, pidBytes: pidBytes, parseVin: parseVin,
    parseDtcs: parseDtcs, parseMonitors: parseMonitors, decodePid: decodePid, parseVoltage: parseVoltage,
    evaluate: evaluate, BleTransport: BleTransport, DemoTransport: DemoTransport, decodeDtc: decodeDtc
  };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.OBD = api;
})(typeof window !== "undefined" ? window : this);
