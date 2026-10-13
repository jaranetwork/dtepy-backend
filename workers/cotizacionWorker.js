/**
 * Worker de cotizaciones automáticas.
 *
 * Cadencia (hora de Asunción):
 *   - 00:00 a 06:00  → cada 5 min. Es la ventana en la que tiene que quedar
 *                      cargada la cotización del día. Si la fuente todavía no
 *                      publicó, se reintenta a los 5 min, y a los 5, y a los 5.
 *   - resto del día  → cada 60 min, pero sin pasarse de la medianoche: el
 *                      worker despierta a las 00:00:30 en punto, así la
 *                      cotización del día entra en segundos y no hasta una
 *                      hora después.
 *
 * Cuando la empresa YA tiene la cotización vigente del día, el chequeo no sale
 * a la red: se resuelve con una consulta a la base. El día normal son unas
 * pocas peticiones HTTP en total.
 *
 * El estado vive en los datos (la fecha de la última cotización), no en el
 * proceso: reiniciar el contenedor en medio de la ventana no saltea nada.
 */

require('dotenv').config();
const { ocultarCredenciales } = require('../utils/ocultarCredenciales');
const mongoose = require('mongoose');
const cotizacionSync = require('../services/cotizacionSyncService');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/sifen_db';

const INTERVALO_ACTIVO_MS = parseInt(process.env.COTIZACION_INTERVALO_ACTIVO_MS || '300000', 10);  // 5 min
const INTERVALO_REPOSO_MS = parseInt(process.env.COTIZACION_INTERVALO_REPOSO_MS || '3600000', 10); // 60 min
const VENTANA_DESDE = parseInt(process.env.COTIZACION_VENTANA_DESDE || '0', 10);
const VENTANA_HASTA = parseInt(process.env.COTIZACION_VENTANA_HASTA || '6', 10);

mongoose.connect(MONGODB_URI, {
  maxPoolSize: 5,
  serverSelectionTimeoutMS: 5000
})
  .then(() => console.log('✅ [COTIZACION-WORKER] MongoDB conectado'))
  .catch((err) => console.error('❌ [COTIZACION-WORKER] Error conectando a MongoDB:', err.message));

function enVentanaActiva() {
  const hora = cotizacionSync.horaAsuncion();
  return hora >= VENTANA_DESDE && hora < VENTANA_HASTA;
}

/**
 * Milisegundos hasta el próximo arranque de la ventana activa (hora de
 * Asunción), con unos segundos de gracia para no caer justo en el borde.
 */
function msHastaProximaVentana() {
  const partes = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/Asuncion',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    })
      .formatToParts(new Date())
      .filter((p) => p.type !== 'literal')
      .map((p) => [p.type, Number(p.value)])
  );
  const ahoraSeg = partes.hour * 3600 + partes.minute * 60 + partes.second;
  const objetivoSeg = VENTANA_DESDE * 3600 + 30;
  let delta = objetivoSeg - ahoraSeg;
  if (delta <= 0) delta += 24 * 3600;
  return delta * 1000;
}

function proximoIntervaloMs() {
  if (enVentanaActiva()) return INTERVALO_ACTIVO_MS;
  // Fuera de la ventana se chequea cada hora, pero NUNCA pasándose del
  // arranque de la próxima: con un intervalo fijo de 60 min, un tick a las
  // 23:59 dormía hasta las 00:59 y la cotización del día entraba una hora
  // tarde. Así el worker despierta a las 00:00:30 en punto.
  return Math.min(INTERVALO_REPOSO_MS, msHastaProximaVentana());
}

async function tick() {
  try {
    const resultados = await cotizacionSync.sincronizarTodas();
    for (const r of resultados) {
      if (r.estado === 'ok') {
        console.log(`💱 [COTIZACION-WORKER] ${r.ruc}: ${r.mensaje}`);
        for (const m of r.monedas || []) {
          if (m.estado === 'aplicada') {
            console.log(`   → ${m.moneda}: ${m.valorAnterior ?? 's/d'} → ${m.valor} Gs (fecha ${m.fechaCotizacion})`);
          }
        }
      } else if (r.estado === 'bloqueada') {
        console.warn(`🚧 [COTIZACION-WORKER] ${r.ruc}: ${r.mensaje}`);
        for (const m of r.monedas || []) {
          if (m.estado === 'bloqueada') console.warn(`   → ${m.moneda}: ${m.mensaje}`);
        }
      } else if (r.estado === 'error') {
        console.error(`❌ [COTIZACION-WORKER] ${r.ruc}: ${r.mensaje}`);
      } else if (r.estado === 'pendiente_fuente') {
        console.log(`⏳ [COTIZACION-WORKER] ${r.ruc}: ${r.mensaje}`);
      }
    }
  } catch (err) {
    console.error('❌ [COTIZACION-WORKER] Error en el ciclo:', err.message);
  } finally {
    setTimeout(tick, proximoIntervaloMs());
  }
}

console.log('👷 ========================================');
console.log('👷   WORKER DE COTIZACIONES INICIADO');
console.log('👷 ========================================');
console.log(`⏱️  Ventana activa ${String(VENTANA_DESDE).padStart(2, '0')}:00-${String(VENTANA_HASTA).padStart(2, '0')}:00 (Asunción): cada ${INTERVALO_ACTIVO_MS / 60000} min`);
console.log(`⏱️  Resto del día: cada ${INTERVALO_REPOSO_MS / 60000} min`);
console.log(`📅 Cotización objetivo de hoy: la publicada el ${cotizacionSync.fechaObjetivo()}`);
console.log(`📍 MongoDB: ${ocultarCredenciales(MONGODB_URI)}`);
console.log('=========================================\n');

// Primer chequeo al arrancar (cubre el caso de un despliegue en plena ventana)
setTimeout(tick, 5000);

process.on('SIGINT', async () => {
  console.log('\n🛑 [COTIZACION-WORKER] Cerrando...');
  await mongoose.connection.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🛑 [COTIZACION-WORKER] SIGTERM recibido...');
  await mongoose.connection.close();
  process.exit(0);
});
