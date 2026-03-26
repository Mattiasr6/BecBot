const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const XLSX = require('xlsx');

const PERIODO_ACTUAL = "Marzo-2026 (MOD II/I)";
const PAUSA_ENTRE_GRUPOS_MS = 60_000;
const MAX_NOMBRE_GRUPO = 100;
const ARCHIVO_EXCEL = 'materias.xlsx';
const REPORTE_EXCEL = 'Reporte_Materias.xlsx';

let filas = [];

process.on('uncaughtException', (err) => {
  console.error('💥 Error no capturado:', err.message);
  guardarReporte(filas);
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  console.error('💥 Promesa rechazada:', reason);
  guardarReporte(filas);
});

function formatearTelefono(telefono) {
  if (!telefono) return null;
  return String(telefono).replace(/[\s\-\+]/g, '') + '@c.us';
}

function generarNombreGrupo({ Materia, Turno, Aula }) {
  const nombre = `${String(Materia).trim()} - ${String(Turno).trim()} - ${String(Aula).trim()}`;
  return nombre.length > MAX_NOMBRE_GRUPO
    ? nombre.substring(0, MAX_NOMBRE_GRUPO)
    : nombre;
}

function leerExcel() {
  try {
    const workbook = XLSX.readFile(ARCHIVO_EXCEL);
    const sheetName = workbook.SheetNames[0];
    const worksheet = workbook.Sheets[sheetName];
    const filas = XLSX.utils.sheet_to_json(worksheet, { defval: '' });
    return filas.map((fila) => {
      const filaLimpia = {};
      for (const key of Object.keys(fila)) {
        const claveLimpia = key.trim();
        const valor = fila[key];
        filaLimpia[claveLimpia] = typeof valor === 'string' ? valor.trim() : valor;
      }
      return filaLimpia;
    });
  } catch (err) {
    throw new Error(`No se pudo abrir "${ARCHIVO_EXCEL}": ${err.message}`);
  }
}

function guardarReporte(filas) {
  if (!filas || filas.length === 0) return;
  try {
    const ws = XLSX.utils.json_to_sheet(filas);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Reporte');
    XLSX.writeFile(wb, REPORTE_EXCEL);
    console.log(`📁 Reporte guardado: ${REPORTE_EXCEL}`);
  } catch (err) {
    console.error('Error guardando reporte:', err.message);
  }
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
  require('qrcode-terminal').generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('✅ Autenticación exitosa. Sesión guardada con LocalAuth.');
});

client.on('auth_failure', (msg) => {
  console.error('❌ Falló la autenticación:', msg);
  guardarReporte(filas);
  process.exit(1);
});

client.on('disconnected', (reason) => {
  console.log('⚠️ Conexión perdida:', reason);
  guardarReporte(filas);
  process.exit(1);
});

client.on('ready', async () => {
  console.log('🟢 WhatsApp Web conectado y listo.\n');

  try {
    filas = leerExcel();
  } catch (err) {
    console.error(err.message);
    guardarReporte(filas);
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
    fila.Estado = fila.Estado || '';
    fila.LinkInvitacion = fila.LinkInvitacion || '';

    const nombreGrupo = generarNombreGrupo(fila);
    const numeroDocente = formatearTelefono(fila.TelefonoDocente);
    const numeroBecario = formatearTelefono(fila.TelefonoBecario);

    const estadosExito = ['✅ Creado y Admin', '⚠️ Creado (Docente bloqueó añadir. Link enviado al becario)'];
    if (estadosExito.includes(fila.Estado)) {
      console.log(`\n⏩ Saltando "${nombreGrupo}" - Ya procesado anteriormente.`);
      continue;
    }

    console.log(`\n[${i + 1}/${filas.length}] Creando grupo: "${nombreGrupo}"`);

    const participantesRaw = [numeroDocente, numeroBecario].filter(Boolean);
    const participantes = participantesRaw.map(p => p.includes('@c.us') ? p : p + '@c.us');

    if (participantes.length === 0) {
      console.log('   ⚠️ Sin participantes válidos. Saltando...');
      fila.Estado = '❌ Sin participantes';
      fallidos++;
      continue;
    }

    console.log('   👨‍🏫 Docente:', numeroDocente || 'N/A');
    console.log('   👨‍💻 Becario:', numeroBecario || 'N/A');

    try {
      console.log('   🔄 Creando grupo...');
      const grupo = await client.createGroup(nombreGrupo, participantes);

      if (!grupo || !grupo.gid) {
        console.log('   ❌ Error: createGroup no devolvió gid (Rate Limit?)');
        fila.Estado = '❌ Rate Limit';
        fila.LinkInvitacion = '-';
        fallidos++;
        continue;
      }

      const grupoId = grupo.gid._serialized;
      console.log('   ✅ Grupo creado:', grupoId);

      let docenteBloqueado = false;
      if (numeroDocente && grupo.gpisMissingParticipants?.includes(numeroDocente)) {
        console.log('   ⚠️ Docente no añadido (privacidad)');
        docenteBloqueado = true;
      }

      const descripcion = `📚 Materia: ${fila.Materia}
👨‍🏫 Docente: ${fila.Docente}
🕒 Turno: ${fila.Turno}
🏫 Aula: ${fila.Aula}

Grupo oficial - Universidad`;

      console.log('   📤 Enviando información...');
      await client.sendMessage(grupoId, `*📌 INFORMACIÓN DE LA MATERIA:*\n\n${descripcion}`);

      const chat = await client.getChatById(grupoId);

      console.log('   🔝 Promoviendo a admins...');
      try {
        await chat.promoteParticipants(participantes);
      } catch (err) {
        console.log('   ⚠️ Error promoviendo:', err.message);
      }

      let linkInvitacion = '-';
      try {
        const inviteCode = await chat.getInviteCode();
        linkInvitacion = `https://chat.whatsapp.com/${inviteCode}`;
        fila.LinkInvitacion = linkInvitacion;
      } catch (err) {
        console.log('   ⚠️ Error obteniendo link:', err.message);
      }

      console.log('   🔒 Aplicando blindaje Anti-Trolls...');
      try {
        await chat.setInfoAdminsOnly(true);
      } catch (err) {
        console.log('   ⚠️ Error blindaje:', err.message);
      }

      if (docenteBloqueado && numeroBecario && linkInvitacion !== '-') {
        const mensaje = `⚠️ El docente de ${fila.Materia} no pudo ser añadido. Pásale este link:\n${linkInvitacion}`;
        await client.sendMessage(numeroBecario, mensaje);
        fila.Estado = '⚠️ Creado (Docente bloqueó)';
      } else {
        fila.Estado = '✅ Creado y Admin';
      }

      console.log('   🚪 Saliendo del grupo...');
      await chat.leave();

      console.log('   ✅ Completado');
      creados++;

    } catch (err) {
      console.log('   ❌ Error:', err.message);
      fila.Estado = `❌ ${err.message}`;
      fila.LinkInvitacion = '-';
      fallidos++;
    }

    if (i < filas.length - 1) {
      console.log(`   ⏳ Esperando ${PAUSA_ENTRE_GRUPOS_MS / 1000}s anti-ban...`);
      await new Promise((resolve) => setTimeout(resolve, PAUSA_ENTRE_GRUPOS_MS));
    }
  }

  guardarReporte(filas);

  console.log('\n' + '═'.repeat(60));
  console.log('📊 RESUMEN FINAL:');
  console.log(`   ✅ Grupos creados: ${creados}`);
  console.log(`   ❌ Fallidos:       ${fallidos}`);
  console.log(`   📋 Total:          ${filas.length}`);
  console.log('═'.repeat(60));
  console.log('\n🏁 Proceso finalizado.');

  process.exit(0);
});

console.log('🚀 Iniciando BecBot...');
console.log('⏳ Conectando con WhatsApp Web...\n');
client.initialize();
