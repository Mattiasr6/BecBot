const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const csv = require('csv-parser');

// ─────────────────────────────────────────────
//  🤖 BecBot — Creador automático de grupos WA
// ─────────────────────────────────────────────

const PAUSA_ENTRE_GRUPOS_MS = 25_000; // 25 segundos anti-ban
const MAX_NOMBRE_GRUPO = 100;
const ARCHIVO_CSV = 'materias.csv';

// ── Utilidades ───────────────────────────────

/**
 * Pausa obligatoria envuelta en una Promesa.
 * @param {number} ms - Milisegundos a esperar.
 */
const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Limpia el número de teléfono y lo convierte al formato de WhatsApp.
 * Quita +, espacios y guiones, luego agrega @c.us
 * @param {string} telefono - Número crudo del CSV.
 * @returns {string} Número formateado (ej: 59171644140@c.us)
 */
function formatearTelefono(telefono) {
  return telefono.replace(/[\s\-\+]/g, '') + '@c.us';
}

/**
 * Genera el nombre del grupo concatenando Materia, Turno y Aula.
 * Si supera los 100 caracteres, lo recorta.
 * @param {object} fila - Fila del CSV con Materia, Turno, Aula.
 * @returns {string} Nombre del grupo (máx. 100 caracteres).
 */
function generarNombreGrupo({ Materia, Turno, Aula }) {
  const nombre = `${Materia.trim()} - ${Turno.trim()} - ${Aula.trim()}`;
  return nombre.length > MAX_NOMBRE_GRUPO
    ? nombre.substring(0, MAX_NOMBRE_GRUPO)
    : nombre;
}

/**
 * Lee el archivo CSV y devuelve un array de filas.
 * @returns {Promise<Array>} Filas del CSV parseadas.
 */
function leerCSV() {
  return new Promise((resolve, reject) => {
    const filas = [];
    fs.createReadStream(ARCHIVO_CSV)
      .on('error', (err) => {
        reject(new Error(`❌ No se pudo abrir "${ARCHIVO_CSV}": ${err.message}`));
      })
      .pipe(csv())
      .on('data', (fila) => filas.push(fila))
      .on('end', () => resolve(filas))
      .on('error', (err) => reject(err));
  });
}

// ── Cliente de WhatsApp ──────────────────────

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

// Mostrar QR en la terminal para autenticarse
client.on('qr', (qr) => {
  console.log('\n📱 Escanea este código QR con WhatsApp:\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('✅ Autenticación exitosa. Sesión guardada con LocalAuth.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Falló la autenticación:', msg);
  process.exit(1);
});

// ── Lógica principal al estar listo ──────────

client.on('ready', async () => {
  console.log('🟢 WhatsApp Web conectado y listo.\n');

  let filas;
  try {
    filas = await leerCSV();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (filas.length === 0) {
    console.log('⚠️ El archivo CSV está vacío. No hay grupos por crear.');
    process.exit(0);
  }

  console.log(`📋 Se encontraron ${filas.length} materias en el CSV.\n`);
  console.log('═'.repeat(60));

  let creados = 0;
  let fallidos = 0;

  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    const nombreGrupo = generarNombreGrupo(fila);
    const telefono = formatearTelefono(fila.Telefono);

    console.log(`\n[${i + 1}/${filas.length}] Creando grupo: "${nombreGrupo}"`);
    console.log(`   👤 Docente: ${fila.Docente} (${telefono})`);

    try {
      const grupo = await client.createGroup(nombreGrupo, [telefono]);

      // Verificar si hubo participantes que no se pudieron agregar
      if (grupo.gpisMissingParticipants && grupo.gpisMissingParticipants.length > 0) {
        console.log(`   ⚠️ Falló al añadir al docente en ${fila.Materia}, hazlo manual`);
        console.log(`   ✅ Grupo creado (sin docente).`);
      } else {
        console.log(`   ✅ Grupo creado exitosamente con el docente.`);
      }

      creados++;
    } catch (err) {
      console.log(`   ⚠️ Falló al añadir al docente en ${fila.Materia}, hazlo manual`);
      console.log(`   💬 Error: ${err.message}`);
      fallidos++;
    }

    // ── Escudo Anti-Ban: pausa de 25 segundos ──
    if (i < filas.length - 1) {
      console.log(`   ⏳ Esperando ${PAUSA_ENTRE_GRUPOS_MS / 1000}s antes del siguiente grupo...`);
      await esperar(PAUSA_ENTRE_GRUPOS_MS);
    }
  }

  // ── Resumen final ──────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log('📊 RESUMEN FINAL:');
  console.log(`   ✅ Grupos creados: ${creados}`);
  console.log(`   ❌ Fallidos:       ${fallidos}`);
  console.log(`   📋 Total:          ${filas.length}`);
  console.log('═'.repeat(60));
  console.log('\n🏁 Proceso finalizado. Puedes cerrar esta terminal.');

  process.exit(0);
});

// ── Arrancar el cliente ──────────────────────
console.log('🚀 Iniciando BecBot...');
console.log('⏳ Conectando con WhatsApp Web (esto puede tardar unos segundos)...\n');
client.initialize();
