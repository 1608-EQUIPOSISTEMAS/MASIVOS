const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

// -----------------------------------------------------------------
// NUEVO: Importaciones para Socket.io y http
const http = require('http');
const { Server } = require("socket.io");
const qrcode = require('qrcode'); // MODIFICADO: Usamos 'qrcode' en lugar de 'qrcode-terminal'
// -----------------------------------------------------------------

const app = express();
const port = 3000;

// -----------------------------------------------------------------
// NUEVO: Configuración del servidor con Socket.io
const server = http.createServer(app); // Creamos un servidor http
const io = new Server(server);         // Inicializamos socket.io en el servidor
// -----------------------------------------------------------------

// --- (Tu código de carpetas y Multer sigue igual) ---
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const storage = multer.diskStorage({
  destination: './uploads',
  filename: (_, file, cb) => {
    cb(null, 'imagen.jpg');
  },
});
const upload = multer({ storage });
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
if (!fs.existsSync('enviados.csv')) {
  fs.writeFileSync('enviados.csv', 'numero,fecha,loteId,estado\n');
}
// --- (Fin de tu código sin cambios) ---


// ✅ Cliente WhatsApp
const client = new Client({
  authStrategy: new LocalAuth()
});

// -----------------------------------------------------------------
// MODIFICADO: Variables de estado globales
let clientReady = false;
let qrCodeString = null; // Guardaremos el QR aquí
// -----------------------------------------------------------------

// 📲 MODIFICADO: Evento QR
client.on('qr', qr => {
  console.log('📲 Generando QR... (Revisa la consola o la web)');
  
  // Generamos un DataURL (imagen) para enviar al HTML
  qrcode.toDataURL(qr, (err, url) => {
    if (err) {
      console.error("Error generando QR Data URL:", err);
      return;
    }
    qrCodeString = url; // Guardamos el QR
    io.emit('qr', url); // Enviamos el QR a TODOS los clientes web
    io.emit('status', 'WAITING_FOR_QR'); // Informamos que estamos esperando
  });
});

// MODIFICADO: Evento Ready
client.on('ready', () => {
  clientReady = true;
  qrCodeString = null; // Ya no necesitamos el QR
  console.log('✅ Conectado a WhatsApp Web');
  io.emit('status', 'CONNECTED'); // Informamos que estamos conectados
});

client.on('auth_failure', msg => {
  console.error('❌ Error de autenticación:', msg);
  clientReady = false;
  io.emit('status', 'NOT_CONNECTED'); // Informamos del fallo
});

// NUEVO: Evento de desconexión
client.on('disconnected', (reason) => {
  console.log('❌ Cliente desconectado:', reason);
  clientReady = false;
  qrCodeString = null;
  io.emit('status', 'NOT_CONNECTED'); // Informamos que estamos desconectados
});

client.initialize();


// -----------------------------------------------------------------
// NUEVO: Manejo de conexiones de Socket.io
io.on('connection', (socket) => {
  console.log('🔌 Nuevo cliente web conectado');

  // Alguien se acaba de conectar, mandarle el estado actual
  if (clientReady) {
    socket.emit('status', 'CONNECTED');
  } else if (qrCodeString) {
    // Si no estamos listos, pero SÍ tenemos un QR, se lo mandamos
    socket.emit('status', 'WAITING_FOR_QR');
    socket.emit('qr', qrCodeString);
  } else {
    socket.emit('status', 'NOT_CONNECTED');
  }

  socket.on('disconnect', () => {
    console.log('🔌 Cliente web desconectado');
  });
});
// -----------------------------------------------------------------


// --- (Tu función sanitizarNumero sigue igual) ---
function sanitizarNumero(numero) {
  let n = String(numero).replace(/\D/g, '');
  if (n.length === 9) n = '51' + n;
  return n;
}

// --- (Tu función registrarEnvio sigue igual) ---
function registrarEnvio(numero, loteId, estado) {
  const fecha = new Date().toISOString().replace('T', ' ').slice(0, 19);
  fs.appendFileSync('enviados.csv', `${numero},${fecha},${loteId},${estado}\n`);
}

// -----------------------------------------------------------------
// ⬇️⬇️⬇️ MODIFICACIÓN PRINCIPAL ⬇️⬇️⬇️
// -----------------------------------------------------------------

// 📁 Ruta para formulario web (MODIFICADA)
app.post('/enviar', upload.single('imagen'), async (req, res) => {
  if (!clientReady) {
    return res.status(503).send('❌ WhatsApp no está listo aún. Reinicia y escanea el QR si es necesario.');
  }

  const numeros = (req.body.numeros || '').split('\n').map(n => n.trim()).filter(n => n);
  const mensaje = req.body.mensaje || '';
  const imagenPath = req.file ? path.resolve(req.file.path) : null;

  if (numeros.length === 0) {
    return res.status(400).send('Debes enviar al menos un número.');
  }
  
  // 1. Respondemos al usuario INMEDIATAMENTE
  res.status(200).send(`✅ Proceso iniciado. Se enviarán ${numeros.length} números en lotes. Revisa los logs en vivo.`);

  // 2. Llamamos a la función de procesamiento en segundo plano (SIN await)
  //    Le pasamos los números, el mensaje, la ruta de la imagen y el socket.
  procesarEnviosPorLotes(numeros, mensaje, imagenPath);
});


// 🚀 NUEVA FUNCIÓN: Procesamiento por lotes
async function procesarEnviosPorLotes(numerosRaw, mensaje, imagenPath) {
  
  // --- Constantes de configuración ---
  const TAMANO_LOTE = 35;
  const TIEMPO_ESPERA_LOTE_MINUTOS = 15;
  const TIEMPO_ESPERA_LOTE_MS = TIEMPO_ESPERA_LOTE_MINUTOS * 60 * 1000;
  // Mantenemos la espera corta entre números (anti-spam)
  const ESPERA_ENTRE_NUMEROS_MIN = 7000; // 7 segundos
  const ESPERA_ENTRE_NUMEROS_MAX = 12000; // 12 segundos
  // ---------------------------------
  
  const loteId = `L${Date.now()}`;
  const totalNumeros = numerosRaw.length;
  const totalLotes = Math.ceil(totalNumeros / TAMANO_LOTE);

  let exitosos = [];
  let fallidos = [];
  let media = null; // Objeto MessageMedia

  io.emit('log', `===== INICIO DEL PROCESO (Lote ID: ${loteId}) =====`);
  io.emit('log', `Total de números: ${totalNumeros}. Lotes de ${TAMANO_LOTE}. Total de lotes: ${totalLotes}.`);

  // Si hay imagen, la pre-cargamos UNA SOLA VEZ
  if (imagenPath) {
    try {
      media = MessageMedia.fromFilePath(imagenPath);
      io.emit('log', '🖼 Imagen cargada exitosamente.');
    } catch (err) {
      io.emit('log', `❌ Error cargando la imagen: ${err.message}. Se enviará solo texto.`);
      imagenPath = null;
    }
  }

  // Loop principal por lotes
  for (let i = 0; i < totalNumeros; i += TAMANO_LOTE) {
    const loteActual = numerosRaw.slice(i, i + TAMANO_LOTE);
    const numLote = (i / TAMANO_LOTE) + 1;

    io.emit('log', `--- Procesando Lote ${numLote} de ${totalLotes} (${loteActual.length} números) ---`);
    
    // Loop interno (para cada número dentro del lote)
    for (const [index, numeroRaw] of loteActual.entries()) {
      io.emit('log', `[Lote ${numLote} | ${index + 1}/${loteActual.length}] Procesando ${numeroRaw}...`);
      const numero = sanitizarNumero(numeroRaw);

      if (!numero || numero.length < 9) {
        io.emit('log', `🚫 Formato inválido: ${numeroRaw}`);
        registrarEnvio(numeroRaw, loteId, 'INVALID_FORMAT');
        fallidos.push(numeroRaw);
        continue;
      }

      let numberId = null;
      try {
        numberId = await client.getNumberId(numero);
      } catch (err) {
        io.emit('log', `⚠️ getNumberId falló para ${numero}: ${err.message}`);
        numberId = null;
      }

      if (!numberId) {
        io.emit('log', `🚫 ${numeroRaw} no está en WhatsApp (getNumberId null)`);
        registrarEnvio(numeroRaw, loteId, 'NO_REGISTRADO');
        fallidos.push(numeroRaw);
        continue;
      }

      const chatId = numberId._serialized;

      try {
        if (media) {
          await client.sendMessage(chatId, media, { caption: mensaje });
        } else {
          await client.sendMessage(chatId, mensaje);
        }

        io.emit('log', `✅ [Lote ${numLote}] Enviado a ${numeroRaw}`);
        registrarEnvio(numeroRaw, loteId, 'ÉXITO');
        exitosos.push(numeroRaw);

      } catch (err) {
        const msg = (err && err.message) ? err.message : String(err);
        io.emit('log', `❌ [Lote ${numLote}] Error enviando a ${numeroRaw}: ${msg}`);

        if (msg.includes('Evaluation failed') || msg.includes('getChat')) {
          registrarEnvio(numeroRaw, loteId, 'EVAL_GETCHAT');
        } else {
          registrarEnvio(numeroRaw, loteId, 'FALLO');
        }
        fallidos.push(numeroRaw);
      }

      // Espera corta ENTRE NÚMEROS
      // Solo esperamos si no es el último número del lote
      if (index < loteActual.length - 1) {
        const esperaCorta = Math.floor(Math.random() * (ESPERA_ENTRE_NUMEROS_MAX - ESPERA_ENTRE_NUMEROS_MIN + 1)) + ESPERA_ENTRE_NUMEROS_MIN;
        io.emit('log', `⏳ Espera corta: ${esperaCorta / 1000} s...`);
        await new Promise(r => setTimeout(r, esperaCorta));
      }
    } // Fin del loop de números (lote)

    io.emit('log', `--- Fin del Lote ${numLote} ---`);

    // Espera larga ENTRE LOTES
    // Solo esperamos si no es el último lote
    if (i + TAMANO_LOTE < totalNumeros) {
      io.emit('log', `⏸ Esperando ${TIEMPO_ESPERA_LOTE_MINUTOS} minutos antes del siguiente lote...`);
      await new Promise(r => setTimeout(r, TIEMPO_ESPERA_LOTE_MS));
    }

  } // Fin del loop de lotes

  io.emit('log', `\n📊 ===== PROCESO COMPLETADO =====`);
  io.emit('log', `🧾 Lote ID: ${loteId}`);
  io.emit('log', `✅ Total Enviados: ${exitosos.length}`);
  io.emit('log', `❌ Total Fallidos: ${fallidos.length}`);
  if (fallidos.length > 0) io.emit('log', `🚫 Números fallidos:\n${fallidos.join('\n')}`);
  
  // Borrar la imagen subida después de terminar
  if (imagenPath && fs.existsSync(imagenPath)) {
    fs.unlinkSync(imagenPath);
    io.emit('log', '🗑 Imagen temporal eliminada.');
  }

  io.emit('process_finished');
}

// -----------------------------------------------------------------
// ⬆️⬆️⬆️ FIN DE LA MODIFICACIÓN ⬆️⬆️⬆️
// -----------------------------------------------------------------


// MODIFICADO: Usamos server.listen en lugar de app.listen
server.listen(port, '0.0.0.0', () => {
  console.log(`🚀 Interfaz activa en: http://localhost:${port}`);
  console.log(`🚀 Accesible públicamente en: http://34.42.193.17:${port}`);
});