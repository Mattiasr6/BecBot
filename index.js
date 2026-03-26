const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const fs = require('fs');
const XLSX = require('xlsx');

const PAUSA_ENTRE_GRUPOS_MS = 45_000;
const MAX_NOMBRE_GRUPO = 100;
const ARCHIVO_EXCEL = 'materias.xlsx';
const REPORTE_EXCEL = 'Reporte_Materias.xlsx';

const esperar = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function formatearTelefono(telefono) {
  if (!telefono) return null;
  return String(telefono).replace(/[\s\-\+]/g, '') + '@c.us';
}

function generarNombreGrupo({ Materia, Turno, Aula }) {
  const nombre = `${Materia.trim()} - ${Turno.trim()} - ${Aula.trim()}`;
  return nombre.length > MAX_NOMBRE_GRUPO
    ? nombre.substring(0, MAX_NOMBRE_GRUPO)
    : nombre;
}

function leerExcel() {
  try {
    const workbook = XLSX.readFile(ARCHIVO_EXCEL);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const filas = XLSX.utils.sheet_to_json(worksheet);
    return filas;
  } catch (err) {
    throw new Error(`No se pudo abrir "${ARCHIVO_EXCEL}": ${err.message}`);
  }
}

function guardarReporte(filas) {
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
  XLSX.writeFile(wb, REPORTE_EXCEL);
  console.log(`📁 Reporte guardado: ${REPORTE_EXCEL}`);
}

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  },
});

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

client.on('ready', async () => {
  console.log('🟢 WhatsApp Web conectado y listo.\n');

  let filas;
  try {
    filas = leerExcel();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }

  if (filas.length === 0) {
    console.log('⚠️ El archivo Excel está vacío. No hay grupos por crear.');
    process.exit(0);
  }

  console.log(`📋 Se encontraron ${filas.length} materias en el Excel.\n`);
  console.log('═'.repeat(60));

  let creados = 0;
  let fallidos = 0;

  for (let i = 0; i < filas.length; i++) {
    const fila = filas[i];
    fila.Estado = '';

    const nombreGrupo = generarNombreGrupo(fila);
    const numeroDocente = formatearTelefono(fila.TelefonoDocente);
    const numeroBecario = formatearTelefono(fila.TelefonoBecario);

    console.log(`\n[${i + 1}/${filas.length}] Creando grupo: "${nombreGrupo}"`);

    const participantes = [];
    if (numeroDocente) {
      console.log(`   👨‍🏫 Docente: ${fila.Docente} (${numeroDocente})`);
      participantes.push(numeroDocente);
    }
    if (numeroBecario) {
      console.log(`   👨‍💻 Becario: ${fila.TelefonoBecario}`);
      participantes.push(numeroBecario);
    }

    if (participantes.length === 0) {
      console.log('   ⚠️ No hay participantes válidos. Saltando...');
      fila.Estado = '❌ Error: Sin participantes válidos';
      fallidos++;
      continue;
    }

    try {
      console.log('   🔄 Creando grupo...');
      const grupo = await client.createGroup(nombreGrupo, participantes);
      const grupoId = grupo.gid._serialized;

      let docenteBloqueado = false;

      if (numeroDocente && grupo.gpisMissingParticipants?.includes(numeroDocente)) {
        console.log('   ⚠️ Docente no pudo ser añadido (privacidad)');
        docenteBloqueado = true;
      }

      console.log('   ⏳ Esperando 3s para promoción...');
      await esperar(3000);

      console.log('   🔝 Promoviendo a administradores...');
      const chat = await client.getChatById(grupoId);
      await chat.promoteParticipants(participantes);

      if (docenteBloqueado && numeroBecario) {
        console.log('   🔗 Generando link de invitación...');
        const inviteCode = await chat.getInviteCode();
        const linkInvitacion = `https://chat.whatsapp.com/${inviteCode}`;

        console.log('   📤 Enviando link al becario...');
        const mensaje = `⚠️ Hola. El bot no pudo añadir al docente de la materia ${fila.Materia} por su configuración de privacidad. Por favor, pásale este link oficial para que se una: ${linkInvitacion}`;
        await client.sendMessage(numeroBecario, mensaje);

        fila.Estado = '⚠️ Creado (Docente bloqueó añadir. Link enviado al becario)';
        console.log('   ✅ Link enviado al becario.');
      } else {
        fila.Estado = '✅ Creado y Admin';
      }

      console.log('   ⏳ Esperando 2s para salir del grupo...');
      await esperar(2000);

      console.log('   🚪 Saliendo del grupo (Operación Fantasma)...');
      await chat.leave();

      console.log('   ✅ Grupo creado con admins y bot keluar.');
      creados++;
    } catch (err) {
      console.log(`   ❌ Error: ${err.message}`);
      fila.Estado = `❌ Error: ${err.message}`;
      fallidos++;
    }

    if (i < filas.length - 1) {
      console.log(`   ⏳ Esperando ${PAUSA_ENTRE_GRUPOS_MS / 1000}s anti-ban...`);
      await new Promise((resolve) => setTimeout(resolve, PAUSA_ENTRE_GRUPOS_MS));
    }
  }

  console.log('\n📁 Generando reporte...');
  guardarReporte(filas);

  console.log('\n' + '═'.repeat(60));
  console.log('📊 RESUMEN FINAL:');
  console.log(`   ✅ Grupos creados: ${creados}`);
  console.log(`   ❌ Fallidos:       ${fallidos}`);
  console.log(`   📋 Total:          ${filas.length}`);
  console.log('═'.repeat(60));
  console.log('\n🏁 Proceso finalizado. Puedes cerrar esta terminal.');

  process.exit(0);
});

console.log('🚀 Iniciando BecBot...');
console.log('⏳ Conectando con WhatsApp Web (esto puede tardar unos segundos)...\n');
client.initialize();
