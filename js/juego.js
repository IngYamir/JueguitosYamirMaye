import {
    aplicarFotoPerfil,
    damasDB,
    detenerHeartbeat,
    esErrorSesion,
    guardarSesion,
    iniciarHeartbeat,
    limpiarSesionDamas,
    mensajeError,
    obtenerSesionGuardada
} from './supabase.js';
import {
    eliminarTodosLosCanales,
    suscribirsePartida,
    suscribirseSala
} from './realtime.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INTERVALO_RIVAL_MS = 3_000;
const INTERVALO_POSTPARTIDA_MS = 3_000;
const COLORES_CONFETI = ['#efa960', '#ffd776', '#be4a45', '#86b68c', '#f7e2c4'];
const AUDIO_FONDO_URL = new URL('../sound/fondo.mp3', import.meta.url).href;
const AUDIO_MOVER_URL = new URL('../sound/mover.mp3', import.meta.url).href;
const VOLUMEN_FONDO = 0.22;
const VOLUMEN_MOVER = 0.85;

const estadoJuego = {
    sesionId: null,
    jugadorId: null,
    partidaId: null,
    perfil: null,
    resumen: null,
    fichas: [],
    fichaSeleccionada: null,
    movimientosSugeridos: [],
    movimientoEnProceso: false,
    accionPostpartidaEnProceso: false,
    mensajeEnProceso: false,
    partidaFinalizada: false,
    fichaCadenaId: null,
    orientacion: null,
    celdas: new Map(),
    recargaPendiente: false,
    recargaPromesa: null,
    seleccionSolicitadaId: null,
    ultimaFichaMovidaId: null,
    fichasCoronadasAnimadas: new Set(),
    postpartida: null,
    accionesPostpartida: [],
    consultaPostpartidaEnCurso: false,
    postpartidaPollingId: null,
    rivalPollingId: null,
    rivalPollingEnCurso: false,
    tableroInicialCargado: false,
    audioFondo: null,
    audioMovimiento: null,
    audioDesbloqueoRegistrado: false,
    modalAbierto: false,
    confetiMostrado: false,
    mensajeEnviadoLocalmente: false,
    lecturaMensajeIntentada: false,
    comprobandoRevancha: false,
    salaRevanchaSuscrita: false,
    rivalTermino: false,
    navegando: false,
    sesionInvalida: false
};

const dom = {};

// -----------------------------------------------------------------------------
// AUDIO DEL JUEGO
// -----------------------------------------------------------------------------
// Los archivos deben existir exactamente en:
//   sound/fondo.mp3
//   sound/mover.mp3
//
// La musica intenta arrancar al abrir la partida. Si el navegador bloquea el
// autoplay con sonido, se inicia en la primera interaccion del usuario.
function prepararAudio() {
    if (!estadoJuego.audioFondo) {
        const fondo = new Audio(AUDIO_FONDO_URL);
        fondo.loop = true;
        fondo.preload = 'auto';
        fondo.volume = VOLUMEN_FONDO;
        fondo.setAttribute('aria-hidden', 'true');
        estadoJuego.audioFondo = fondo;
    }

    if (!estadoJuego.audioMovimiento) {
        const mover = new Audio(AUDIO_MOVER_URL);
        mover.preload = 'auto';
        mover.volume = VOLUMEN_MOVER;
        mover.setAttribute('aria-hidden', 'true');
        estadoJuego.audioMovimiento = mover;
    }
}

function quitarDesbloqueoAudio() {
    if (!estadoJuego.audioDesbloqueoRegistrado) return;
    estadoJuego.audioDesbloqueoRegistrado = false;
    document.removeEventListener('pointerdown', manejarPrimeraInteraccionAudio, true);
    document.removeEventListener('touchstart', manejarPrimeraInteraccionAudio, true);
    document.removeEventListener('keydown', manejarPrimeraInteraccionAudio, true);
}

function registrarDesbloqueoAudio() {
    if (estadoJuego.audioDesbloqueoRegistrado) return;
    estadoJuego.audioDesbloqueoRegistrado = true;
    document.addEventListener('pointerdown', manejarPrimeraInteraccionAudio, true);
    document.addEventListener('touchstart', manejarPrimeraInteraccionAudio, true);
    document.addEventListener('keydown', manejarPrimeraInteraccionAudio, true);
}

async function reproducirMusicaFondo() {
    prepararAudio();
    const audio = estadoJuego.audioFondo;
    if (!audio || estadoJuego.navegando || document.visibilityState === 'hidden') return false;
    if (!audio.paused) return true;

    try {
        await audio.play();
        quitarDesbloqueoAudio();
        return true;
    } catch (error) {
        // NotAllowedError es normal hasta que exista una interaccion del usuario.
        if (error?.name === 'NotAllowedError') {
            registrarDesbloqueoAudio();
        } else {
            console.warn('[Audio] No se pudo reproducir sound/fondo.mp3:', error);
        }
        return false;
    }
}

function manejarPrimeraInteraccionAudio() {
    quitarDesbloqueoAudio();
    void reproducirMusicaFondo();
}

function pausarMusicaFondo() {
    const audio = estadoJuego.audioFondo;
    if (audio && !audio.paused) audio.pause();
}

async function reproducirSonidoMovimiento() {
    prepararAudio();
    const audio = estadoJuego.audioMovimiento;
    if (!audio || estadoJuego.navegando) return;

    try {
        audio.pause();
        audio.currentTime = 0;
        await audio.play();
    } catch (error) {
        if (error?.name === 'NotAllowedError') {
            registrarDesbloqueoAudio();
        } else {
            console.warn('[Audio] No se pudo reproducir sound/mover.mp3:', error);
        }
    }
}

function detenerAudioJuego() {
    quitarDesbloqueoAudio();

    for (const audio of [estadoJuego.audioFondo, estadoJuego.audioMovimiento]) {
        if (!audio) continue;
        audio.pause();
        try {
            audio.currentTime = 0;
        } catch {
            // Algunos navegadores pueden impedir cambiar currentTime antes de cargar.
        }
    }
}

function detectarFichaMovida(fichasAnteriores, fichasNuevas) {
    if (!Array.isArray(fichasAnteriores) || !Array.isArray(fichasNuevas)) return null;
    if (!fichasAnteriores.length) return null;

    const posicionesAnteriores = new Map(
        fichasAnteriores.map((ficha) => [
            String(ficha.ficha_id),
            `${Number(ficha.fila_tablero)}:${Number(ficha.columna_tablero)}`
        ])
    );

    for (const ficha of fichasNuevas) {
        const id = String(ficha.ficha_id);
        const posicionAnterior = posicionesAnteriores.get(id);
        if (!posicionAnterior) continue;

        const posicionNueva = `${Number(ficha.fila_tablero)}:${Number(ficha.columna_tablero)}`;
        if (posicionAnterior !== posicionNueva) return id;
    }

    return null;
}

function obtenerElementos() {
    dom.app = document.querySelector('#app-juego');
    dom.conexion = document.querySelector('#conexion-estado');
    dom.jugador1 = document.querySelector('#jugador-1');
    dom.jugador1Foto = document.querySelector('#jugador-1-foto');
    dom.jugador1Inicial = document.querySelector('#jugador-1-inicial');
    dom.jugador1Nombre = document.querySelector('#jugador-1-nombre');
    dom.jugador1Color = document.querySelector('#jugador-1-color');
    dom.jugador2 = document.querySelector('#jugador-2');
    dom.jugador2Foto = document.querySelector('#jugador-2-foto');
    dom.jugador2Inicial = document.querySelector('#jugador-2-inicial');
    dom.jugador2Nombre = document.querySelector('#jugador-2-nombre');
    dom.jugador2Color = document.querySelector('#jugador-2-color');
    dom.tablero = document.querySelector('#tablero');
    dom.turno = document.querySelector('#turno-estado');
    dom.detalle = document.querySelector('#partida-detalle');
    dom.instruccion = document.querySelector('#instruccion-juego');
    dom.anuncio = document.querySelector('#anuncio-juego');
    dom.toasts = document.querySelector('#toast-container');
    dom.modal = document.querySelector('#modal-postpartida');
    dom.modalTitulo = document.querySelector('#modal-titulo');
    dom.modalDescripcion = document.querySelector('#modal-descripcion');
    dom.modalJugadores = document.querySelector('#modal-jugadores');
    dom.bloqueEsperaMensaje = document.querySelector('#bloque-espera-mensaje');
    dom.mensajeRecibido = document.querySelector('#mensaje-recibido');
    dom.bloqueMensajePerdedor = document.querySelector('#bloque-mensaje-perdedor');
    dom.etiquetaMensaje = document.querySelector('#etiqueta-mensaje');
    dom.mensajePositivo = document.querySelector('#mensaje-positivo');
    dom.contadorMensaje = document.querySelector('#contador-mensaje');
    dom.enviarMensaje = document.querySelector('#enviar-mensaje');
    dom.mensajeConfirmacion = document.querySelector('#mensaje-confirmacion');
    dom.acciones = document.querySelector('#acciones-postpartida');
    dom.volverJugar = document.querySelector('#volver-jugar');
    dom.terminar = document.querySelector('#terminar');
    dom.estadoRevancha = document.querySelector('#estado-revancha');
    dom.confeti = document.querySelector('#confeti');
}

function elementosEsencialesPresentes() {
    return Boolean(
        dom.app &&
        dom.tablero &&
        dom.turno &&
        dom.modal &&
        dom.mensajePositivo &&
        dom.enviarMensaje &&
        dom.volverJugar &&
        dom.terminar
    );
}

function mostrar(elemento, visible) {
    if (!elemento) return;
    elemento.hidden = !visible;
    elemento.classList.toggle('oculto', !visible);
    if (elemento.hasAttribute('aria-hidden') || elemento.getAttribute('role') === 'dialog') {
        elemento.setAttribute('aria-hidden', String(!visible));
    }
}

function anunciar(texto) {
    if (dom.anuncio) dom.anuncio.textContent = texto;
}

function mostrarToast(texto, tipo = 'error', duracion = 4_600) {
    if (!dom.toasts || !texto) return;

    const toast = document.createElement('div');
    toast.className = `toast toast-${tipo}`;
    toast.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
    toast.textContent = texto;
    dom.toasts.append(toast);

    window.setTimeout(() => {
        toast.classList.add('toast--saliendo');
        window.setTimeout(() => toast.remove(), 260);
    }, duracion);
}

function informarError(error, predeterminado) {
    console.error('[Juego] Error original:', error);
    const texto = mensajeError(error, predeterminado);
    mostrarToast(texto, 'error');
    anunciar(`Error: ${texto}`);
    return texto;
}

function ponerEstadoConexion(estado) {
    if (!dom.conexion) return;
    const conectado = estado === 'SUBSCRIBED';
    const fallo = estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT';

    dom.conexion.textContent = conectado
        ? 'Partida sincronizada'
        : fallo
            ? 'Reconectando…'
            : 'Sincronizando partida…';
    dom.conexion.dataset.estado = conectado ? 'conectado' : fallo ? 'error' : 'conectando';
}

function manejarEstadoRealtime(estado) {
    ponerEstadoConexion(estado);
    if (estado === 'SUBSCRIBED' && estadoJuego.partidaId && !estadoJuego.navegando) {
        void solicitarRecarga().catch((error) => {
            informarError(error, 'No se pudo recuperar la sincronizacion de la partida.');
        });
    }
}

function esUuid(valor) {
    return UUID.test(String(valor || '').trim());
}

function claveCasilla(fila, columna) {
    return `${Number(fila)}:${Number(columna)}`;
}

function dentroDelTablero(fila, columna) {
    return fila >= 1 && fila <= 8 && columna >= 1 && columna <= 8;
}

function idsIguales(a, b) {
    return String(a || '') === String(b || '');
}

function numero(valor) {
    const convertido = Number(valor);
    return Number.isFinite(convertido) ? convertido : null;
}

function jugadorPorId(jugadorId) {
    const resumen = estadoJuego.resumen;
    if (!resumen) return null;

    if (idsIguales(jugadorId, resumen.jugador_1_id)) {
        return {
            id: String(resumen.jugador_1_id),
            nombre: String(resumen.jugador_1_nombre || 'Jugador 1'),
            foto: resumen.jugador_1_foto,
            color: String(resumen.jugador_1_color || 'rojo'),
            puesto: 1
        };
    }

    if (idsIguales(jugadorId, resumen.jugador_2_id)) {
        return {
            id: String(resumen.jugador_2_id),
            nombre: String(resumen.jugador_2_nombre || 'Jugador 2'),
            foto: resumen.jugador_2_foto,
            color: String(resumen.jugador_2_color || 'negro'),
            puesto: 2
        };
    }

    return null;
}

function jugadorActual() {
    return jugadorPorId(estadoJuego.jugadorId);
}

function jugadorRival() {
    const resumen = estadoJuego.resumen;
    if (!resumen) return null;
    return idsIguales(estadoJuego.jugadorId, resumen.jugador_1_id)
        ? jugadorPorId(resumen.jugador_2_id)
        : jugadorPorId(resumen.jugador_1_id);
}

function esMiTurno() {
    return Boolean(
        estadoJuego.resumen?.estado === 'en_curso' &&
        idsIguales(estadoJuego.resumen?.jugador_turno_id, estadoJuego.jugadorId)
    );
}

function obtenerFicha(fichaId) {
    return estadoJuego.fichas.find((ficha) => idsIguales(ficha.ficha_id, fichaId)) || null;
}

function fichaEn(fila, columna) {
    return estadoJuego.fichas.find((ficha) => (
        Number(ficha.fila_tablero) === Number(fila) &&
        Number(ficha.columna_tablero) === Number(columna)
    )) || null;
}

function puedeSeleccionarse(ficha) {
    if (!ficha || estadoJuego.movimientoEnProceso || estadoJuego.partidaFinalizada) return false;
    if (!esMiTurno() || !idsIguales(ficha.jugador_propietario_id, estadoJuego.jugadorId)) return false;
    if (estadoJuego.fichaCadenaId && !idsIguales(ficha.ficha_id, estadoJuego.fichaCadenaId)) return false;
    return true;
}

function direccionFichaNormal(ficha) {
    return String(ficha?.color) === 'rojo' ? 1 : -1;
}

function calcularMovimientosNormales(ficha, soloCapturas) {
    const fila = Number(ficha.fila_tablero);
    const columna = Number(ficha.columna_tablero);
    const avance = direccionFichaNormal(ficha);
    const movimientos = [];

    for (const direccionColumna of [-1, 1]) {
        const filaSimple = fila + avance;
        const columnaSimple = columna + direccionColumna;

        if (
            !soloCapturas &&
            dentroDelTablero(filaSimple, columnaSimple) &&
            !fichaEn(filaSimple, columnaSimple)
        ) {
            movimientos.push({
                fila: filaSimple,
                columna: columnaSimple,
                captura: false
            });
        }

        const filaDestino = fila + (2 * avance);
        const columnaDestino = columna + (2 * direccionColumna);
        const intermedia = fichaEn(fila + avance, columna + direccionColumna);

        if (
            dentroDelTablero(filaDestino, columnaDestino) &&
            intermedia &&
            !idsIguales(intermedia.jugador_propietario_id, ficha.jugador_propietario_id) &&
            !fichaEn(filaDestino, columnaDestino)
        ) {
            movimientos.push({
                fila: filaDestino,
                columna: columnaDestino,
                captura: true,
                fichaCapturadaId: intermedia.ficha_id
            });
        }
    }

    return soloCapturas ? movimientos.filter((movimiento) => movimiento.captura) : movimientos;
}

function calcularMovimientosDama(ficha, soloCapturas) {
    const movimientos = [];
    const filaOrigen = Number(ficha.fila_tablero);
    const columnaOrigen = Number(ficha.columna_tablero);

    for (const [pasoFila, pasoColumna] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
        let fila = filaOrigen + pasoFila;
        let columna = columnaOrigen + pasoColumna;

        while (dentroDelTablero(fila, columna)) {
            const ocupante = fichaEn(fila, columna);

            if (!ocupante) {
                if (!soloCapturas) {
                    movimientos.push({ fila, columna, captura: false });
                }
                fila += pasoFila;
                columna += pasoColumna;
                continue;
            }

            if (idsIguales(ocupante.jugador_propietario_id, ficha.jugador_propietario_id)) {
                break;
            }

            const filaDestino = fila + pasoFila;
            const columnaDestino = columna + pasoColumna;
            if (
                dentroDelTablero(filaDestino, columnaDestino) &&
                !fichaEn(filaDestino, columnaDestino)
            ) {
                movimientos.push({
                    fila: filaDestino,
                    columna: columnaDestino,
                    captura: true,
                    fichaCapturadaId: ocupante.ficha_id
                });
            }
            break;
        }
    }

    return soloCapturas ? movimientos.filter((movimiento) => movimiento.captura) : movimientos;
}

function calcularMovimientosSugeridos(ficha, soloCapturas = false) {
    if (!ficha) return [];
    return String(ficha.tipo) === 'dama'
        ? calcularMovimientosDama(ficha, soloCapturas)
        : calcularMovimientosNormales(ficha, soloCapturas);
}

function construirTablero(orientacion) {
    if (!dom.tablero) return;

    const esJugadorUno = orientacion === 'jugador-1';
    const filas = esJugadorUno
        ? [8, 7, 6, 5, 4, 3, 2, 1]
        : [1, 2, 3, 4, 5, 6, 7, 8];
    const columnas = esJugadorUno
        ? [8, 7, 6, 5, 4, 3, 2, 1]
        : [1, 2, 3, 4, 5, 6, 7, 8];

    const fragmento = document.createDocumentFragment();
    estadoJuego.celdas.clear();

    filas.forEach((fila, indiceFila) => {
        columnas.forEach((columna, indiceColumna) => {
            const casilla = document.createElement('div');
            const oscura = (fila + columna) % 2 === 1;
            casilla.className = `casilla ${oscura ? 'casilla-oscura' : 'casilla-clara'}`;
            casilla.dataset.fila = String(fila);
            casilla.dataset.columna = String(columna);
            casilla.dataset.interactiva = 'false';
            casilla.setAttribute('role', 'gridcell');
            casilla.setAttribute('aria-rowindex', String(indiceFila + 1));
            casilla.setAttribute('aria-colindex', String(indiceColumna + 1));
            casilla.setAttribute('aria-label', `Fila ${fila}, columna ${columna}`);
            casilla.tabIndex = -1;
            estadoJuego.celdas.set(claveCasilla(fila, columna), casilla);
            fragmento.append(casilla);
        });
    });

    dom.tablero.replaceChildren(fragmento);
    estadoJuego.orientacion = orientacion;
}

function actualizarBloqueoTablero() {
    const interactivo = esMiTurno() && !estadoJuego.movimientoEnProceso && !estadoJuego.partidaFinalizada;
    dom.tablero?.classList.toggle('tablero--bloqueado', !interactivo);
    dom.tablero?.classList.toggle('tablero--procesando', estadoJuego.movimientoEnProceso);
    dom.tablero?.setAttribute('aria-disabled', String(!interactivo));
    dom.tablero?.setAttribute('aria-busy', String(estadoJuego.movimientoEnProceso));
}

function etiquetaFicha(ficha, seleccionable) {
    const tipo = String(ficha.tipo) === 'dama' ? 'dama' : 'ficha normal';
    const color = String(ficha.color) === 'rojo' ? 'roja' : 'negra';
    const posicion = `fila ${ficha.fila_tablero}, columna ${ficha.columna_tablero}`;
    return `${tipo} ${color}, ${posicion}${seleccionable ? ', seleccionable' : ''}`;
}

function renderizarTablero() {
    if (!dom.tablero || !estadoJuego.resumen) return;

    const orientacion = idsIguales(estadoJuego.jugadorId, estadoJuego.resumen.jugador_1_id)
        ? 'jugador-1'
        : 'jugador-2';
    if (estadoJuego.orientacion !== orientacion || estadoJuego.celdas.size !== 64) {
        construirTablero(orientacion);
    }

    const sugerencias = new Map(
        estadoJuego.movimientosSugeridos.map((movimiento) => [
            claveCasilla(movimiento.fila, movimiento.columna),
            movimiento
        ])
    );

    for (const [clave, casilla] of estadoJuego.celdas) {
        casilla.replaceChildren();
        const sugerencia = sugerencias.get(clave);
        casilla.classList.toggle('casilla-disponible', Boolean(sugerencia));
        casilla.dataset.disponible = String(Boolean(sugerencia));
        casilla.dataset.interactiva = String(Boolean(sugerencia));
        casilla.tabIndex = sugerencia && !estadoJuego.movimientoEnProceso ? 0 : -1;
        const [fila, columna] = clave.split(':');
        casilla.setAttribute(
            'aria-label',
            sugerencia
                ? `Fila ${fila}, columna ${columna}, destino posible${sugerencia.captura ? ' con captura' : ''}`
                : `Fila ${fila}, columna ${columna}, vacía`
        );
    }

    for (const ficha of estadoJuego.fichas) {
        const casilla = estadoJuego.celdas.get(
            claveCasilla(ficha.fila_tablero, ficha.columna_tablero)
        );
        if (!casilla) continue;

        const seleccionable = puedeSeleccionarse(ficha);
        const seleccionada = idsIguales(
            estadoJuego.fichaSeleccionada?.ficha_id,
            ficha.ficha_id
        );
        const boton = document.createElement('button');
        boton.type = 'button';
        boton.className = `ficha ficha-${String(ficha.color) === 'rojo' ? 'roja' : 'negra'}`;
        boton.dataset.fichaId = String(ficha.ficha_id);
        boton.dataset.color = String(ficha.color || '');
        boton.dataset.tipo = String(ficha.tipo || 'normal');
        boton.setAttribute('aria-label', etiquetaFicha(ficha, seleccionable));
        boton.setAttribute('aria-pressed', String(seleccionada));
        boton.disabled = !seleccionable;

        if (String(ficha.tipo) === 'dama') boton.classList.add('dama');
        if (seleccionada) boton.classList.add('ficha-seleccionada');
        if (idsIguales(estadoJuego.ultimaFichaMovidaId, ficha.ficha_id)) {
            boton.classList.add('ficha-movida');
        }
        if (estadoJuego.fichasCoronadasAnimadas.has(String(ficha.ficha_id))) {
            boton.classList.add('coronacion');
        }

        casilla.setAttribute('aria-label', `Fila ${ficha.fila_tablero}, columna ${ficha.columna_tablero}, ${etiquetaFicha(ficha, seleccionable)}`);
        casilla.append(boton);
    }

    actualizarBloqueoTablero();
}

function renderizarJugador(numeroJugador) {
    const esUno = numeroJugador === 1;
    const jugador = jugadorPorId(
        esUno ? estadoJuego.resumen?.jugador_1_id : estadoJuego.resumen?.jugador_2_id
    );
    if (!jugador) return;

    const tarjeta = esUno ? dom.jugador1 : dom.jugador2;
    const foto = esUno ? dom.jugador1Foto : dom.jugador2Foto;
    const inicial = esUno ? dom.jugador1Inicial : dom.jugador2Inicial;
    const nombre = esUno ? dom.jugador1Nombre : dom.jugador2Nombre;
    const color = esUno ? dom.jugador1Color : dom.jugador2Color;
    const tieneTurno = idsIguales(jugador.id, estadoJuego.resumen?.jugador_turno_id);

    if (nombre) nombre.textContent = jugador.nombre;
    if (color) {
        const muestra = color.querySelector('.color-jugador__muestra');
        color.replaceChildren();
        if (muestra) color.append(muestra);
        color.append(document.createTextNode(jugador.color === 'rojo' ? ' Fichas rojas' : ' Fichas negras'));
        color.classList.toggle('color-jugador--rojo', jugador.color === 'rojo');
        color.classList.toggle('color-jugador--negro', jugador.color === 'negro');
    }

    tarjeta?.setAttribute('data-color', jugador.color);
    tarjeta?.setAttribute('data-turno', String(tieneTurno));
    tarjeta?.classList.toggle('es-turno', tieneTurno);
    tarjeta?.setAttribute(
        'aria-label',
        `${jugador.nombre}, fichas ${jugador.color === 'rojo' ? 'rojas' : 'negras'}${tieneTurno ? ', tiene el turno' : ''}`
    );
    aplicarFotoPerfil(foto, inicial, jugador.nombre, jugador.foto);
}

function renderizarEstadoTurno() {
    const resumen = estadoJuego.resumen;
    if (!resumen) return;

    if (estadoJuego.partidaFinalizada) {
        if (dom.turno) dom.turno.textContent = 'Partida finalizada';
        if (dom.detalle) dom.detalle.textContent = `Finalizó en el turno ${resumen.numero_turno || '—'}`;
        if (dom.instruccion) dom.instruccion.textContent = 'La base de datos confirmó el resultado de la partida.';
        anunciar('La partida terminó. Se muestra el resultado.');
        return;
    }

    const turno = jugadorPorId(resumen.jugador_turno_id);
    if (esMiTurno()) {
        const continuacion = Boolean(estadoJuego.fichaCadenaId);
        if (dom.turno) dom.turno.textContent = continuacion ? 'Continúa la captura' : 'Tu turno';
        if (dom.instruccion) {
            dom.instruccion.textContent = continuacion
                ? 'Debes continuar con la misma ficha y elegir otra captura resaltada.'
                : 'Elige una de tus fichas y luego una casilla resaltada.';
        }
        anunciar(continuacion ? 'Debes continuar la captura con la misma ficha.' : 'Tu turno.');
    } else {
        if (dom.turno) dom.turno.textContent = `Turno de ${turno?.nombre || 'tu rival'}`;
        if (dom.instruccion) dom.instruccion.textContent = 'El tablero se actualizará cuando el otro jugador mueva.';
        anunciar(`Turno de ${turno?.nombre || 'tu rival'}.`);
    }

    if (dom.detalle) dom.detalle.textContent = `Turno ${resumen.numero_turno || 1}`;
}

function renderizarJuego() {
    if (!estadoJuego.resumen) return;
    renderizarJugador(1);
    renderizarJugador(2);
    renderizarEstadoTurno();
    renderizarTablero();
    dom.app?.setAttribute('aria-busy', 'false');
}

function reconciliarSeleccion(resumenAnterior) {
    const cadena = estadoJuego.fichas.find((ficha) => ficha.ficha_cadena_id)?.ficha_cadena_id || null;
    estadoJuego.fichaCadenaId = cadena ? String(cadena) : null;

    if (!esMiTurno() || estadoJuego.partidaFinalizada) {
        estadoJuego.fichaSeleccionada = null;
        estadoJuego.movimientosSugeridos = [];
        estadoJuego.seleccionSolicitadaId = null;
        return;
    }

    let seleccion = null;
    if (estadoJuego.fichaCadenaId) {
        seleccion = obtenerFicha(estadoJuego.fichaCadenaId);
    } else if (estadoJuego.seleccionSolicitadaId) {
        seleccion = obtenerFicha(estadoJuego.seleccionSolicitadaId);
    } else {
        const cambioTurno = Boolean(
            resumenAnterior &&
            (
                Number(resumenAnterior.numero_turno) !== Number(estadoJuego.resumen.numero_turno) ||
                !idsIguales(resumenAnterior.jugador_turno_id, estadoJuego.resumen.jugador_turno_id)
            )
        );
        if (!cambioTurno && estadoJuego.fichaSeleccionada) {
            seleccion = obtenerFicha(estadoJuego.fichaSeleccionada.ficha_id);
        }
    }

    estadoJuego.seleccionSolicitadaId = null;
    const seleccionValida = Boolean(
        seleccion &&
        idsIguales(seleccion.jugador_propietario_id, estadoJuego.jugadorId) &&
        (!estadoJuego.fichaCadenaId || idsIguales(seleccion.ficha_id, estadoJuego.fichaCadenaId))
    );
    if (!seleccionValida) seleccion = null;
    estadoJuego.fichaSeleccionada = seleccion;
    estadoJuego.movimientosSugeridos = seleccion
        ? calcularMovimientosSugeridos(seleccion, Boolean(estadoJuego.fichaCadenaId))
        : [];
}

async function cargarEstadoDesdeBase() {
    const partidaConsultada = estadoJuego.partidaId;
    const resumenAnterior = estadoJuego.resumen;
    const fichasAnteriores = estadoJuego.tableroInicialCargado ? estadoJuego.fichas : [];

    const [consultaResumen, consultaTablero] = await Promise.all([
        damasDB
            .from('v_resumen_partida')
            .select('*')
            .eq('partida_id', partidaConsultada)
            .maybeSingle(),
        damasDB
            .from('v_tablero_partida')
            .select('*')
            .eq('partida_id', partidaConsultada)
            .order('ficha_id', { ascending: true })
    ]);

    if (consultaResumen.error) throw consultaResumen.error;
    if (consultaTablero.error) throw consultaTablero.error;
    if (!consultaResumen.data) throw new Error('No encontramos esta partida.');
    if (!idsIguales(partidaConsultada, estadoJuego.partidaId)) return;

    const resumen = consultaResumen.data;
    const pertenece = idsIguales(estadoJuego.jugadorId, resumen.jugador_1_id) ||
        idsIguales(estadoJuego.jugadorId, resumen.jugador_2_id);
    if (!pertenece) throw new Error('Tu jugador no pertenece a esta partida.');

    const fichasNuevas = Array.isArray(consultaTablero.data) ? consultaTablero.data : [];
    const fichaMovidaDetectada = estadoJuego.tableroInicialCargado
        ? detectarFichaMovida(fichasAnteriores, fichasNuevas)
        : null;

    if (fichaMovidaDetectada) {
        estadoJuego.ultimaFichaMovidaId = String(fichaMovidaDetectada);
    }

    estadoJuego.resumen = resumen;
    estadoJuego.fichas = fichasNuevas;
    estadoJuego.tableroInicialCargado = true;
    estadoJuego.partidaFinalizada = resumen.estado === 'finalizada';
    reconciliarSeleccion(resumenAnterior);
    renderizarJuego();
    actualizarPollingRival();

    if (fichaMovidaDetectada) {
        void reproducirSonidoMovimiento();
    }

    if (estadoJuego.ultimaFichaMovidaId) {
        const idAnimado = estadoJuego.ultimaFichaMovidaId;
        window.setTimeout(() => {
            if (idsIguales(estadoJuego.ultimaFichaMovidaId, idAnimado)) {
                estadoJuego.ultimaFichaMovidaId = null;
                dom.tablero?.querySelectorAll('.ficha-movida').forEach((elemento) => {
                    elemento.classList.remove('ficha-movida');
                });
            }
        }, 520);
    }

    if (estadoJuego.fichasCoronadasAnimadas.size) {
        const ids = [...estadoJuego.fichasCoronadasAnimadas];
        window.setTimeout(() => {
            ids.forEach((id) => estadoJuego.fichasCoronadasAnimadas.delete(id));
            dom.tablero?.querySelectorAll('.coronacion').forEach((elemento) => {
                elemento.classList.remove('coronacion');
            });
        }, 850);
    }

    if (estadoJuego.partidaFinalizada) {
        void abrirPostpartida();
    }
}

function solicitarRecarga({
    seleccionarFichaId = null,
    fichaMovidaId = null,
    fichaCoronadaId = null
} = {}) {
    if (seleccionarFichaId) estadoJuego.seleccionSolicitadaId = String(seleccionarFichaId);
    if (fichaMovidaId) estadoJuego.ultimaFichaMovidaId = String(fichaMovidaId);
    if (fichaCoronadaId) estadoJuego.fichasCoronadasAnimadas.add(String(fichaCoronadaId));
    estadoJuego.recargaPendiente = true;

    if (estadoJuego.recargaPromesa) return estadoJuego.recargaPromesa;

    estadoJuego.recargaPromesa = (async () => {
        while (estadoJuego.recargaPendiente && !estadoJuego.navegando) {
            estadoJuego.recargaPendiente = false;
            await cargarEstadoDesdeBase();
        }
    })().finally(() => {
        estadoJuego.recargaPromesa = null;
    });

    return estadoJuego.recargaPromesa;
}

// -----------------------------------------------------------------------------
// POLLING DE RESPALDO DURANTE EL TURNO DEL RIVAL
// -----------------------------------------------------------------------------
// Realtime sigue siendo el mecanismo principal. Este polling garantiza que, si
// un evento Realtime se retrasa o se pierde, el tablero, el turno, capturas,
// coronaciones y la victoria se reflejen sin recargar manualmente la pagina.
function debeSincronizarPorPollingRival() {
    return Boolean(
        estadoJuego.partidaId &&
        estadoJuego.resumen?.estado === 'en_curso' &&
        !esMiTurno() &&
        !estadoJuego.partidaFinalizada &&
        !estadoJuego.movimientoEnProceso &&
        !estadoJuego.navegando &&
        !estadoJuego.sesionInvalida
    );
}

function detenerPollingRival() {
    if (estadoJuego.rivalPollingId !== null) {
        window.clearInterval(estadoJuego.rivalPollingId);
        estadoJuego.rivalPollingId = null;
    }
}

async function ejecutarPollingRival() {
    if (!debeSincronizarPorPollingRival()) {
        detenerPollingRival();
        return;
    }

    // Si Realtime u otra accion ya esta recargando el estado, esa misma recarga
    // es suficiente. Evitamos iniciar otra llamada simultanea.
    if (estadoJuego.rivalPollingEnCurso || estadoJuego.recargaPromesa) return;

    estadoJuego.rivalPollingEnCurso = true;
    try {
        await solicitarRecarga();
    } catch (error) {
        if (esErrorSesion(error)) {
            await manejarSesionInvalida();
        } else {
            // El polling es un respaldo: un fallo puntual no debe inundar la UI
            // con toasts cada tres segundos. Realtime y el siguiente ciclo siguen.
            console.warn('[Polling rival] No se pudo actualizar la partida:', mensajeError(error));
        }
    } finally {
        estadoJuego.rivalPollingEnCurso = false;
        actualizarPollingRival();
    }
}

function iniciarPollingRival() {
    if (estadoJuego.rivalPollingId !== null || !debeSincronizarPorPollingRival()) return;

    estadoJuego.rivalPollingId = window.setInterval(() => {
        void ejecutarPollingRival();
    }, INTERVALO_RIVAL_MS);
}

function actualizarPollingRival() {
    if (debeSincronizarPorPollingRival()) {
        iniciarPollingRival();
    } else {
        detenerPollingRival();
    }
}

function manejarVisibilidadJuego() {
    if (document.visibilityState !== 'visible') {
        pausarMusicaFondo();
        return;
    }

    void reproducirMusicaFondo();

    // Al volver a la pestana, sincroniza inmediatamente si seguimos esperando
    // el movimiento del rival, sin tener que esperar al siguiente ciclo de 3 s.
    if (debeSincronizarPorPollingRival()) {
        void ejecutarPollingRival();
    }
}

function seleccionarFicha(ficha) {
    if (!puedeSeleccionarse(ficha)) return;

    if (idsIguales(estadoJuego.fichaSeleccionada?.ficha_id, ficha.ficha_id)) {
        if (estadoJuego.fichaCadenaId) return;
        estadoJuego.fichaSeleccionada = null;
        estadoJuego.movimientosSugeridos = [];
    } else {
        estadoJuego.fichaSeleccionada = ficha;
        estadoJuego.movimientosSugeridos = calcularMovimientosSugeridos(
            ficha,
            Boolean(estadoJuego.fichaCadenaId)
        );
    }

    renderizarTablero();
    if (estadoJuego.fichaSeleccionada) {
        anunciar(
            estadoJuego.movimientosSugeridos.length
                ? `Ficha seleccionada. ${estadoJuego.movimientosSugeridos.length} destinos sugeridos.`
                : 'Ficha seleccionada. No tiene destinos visuales disponibles.'
        );
    }
}

async function realizarMovimiento(destino) {
    const ficha = estadoJuego.fichaSeleccionada;
    if (!ficha || !destino || estadoJuego.movimientoEnProceso) return;

    const sigueSugerido = estadoJuego.movimientosSugeridos.some((movimiento) => (
        Number(movimiento.fila) === Number(destino.fila) &&
        Number(movimiento.columna) === Number(destino.columna)
    ));
    if (!sigueSugerido) return;

    estadoJuego.movimientoEnProceso = true;
    const fichaId = String(ficha.ficha_id);
    actualizarBloqueoTablero();

    try {
        const { data, error } = await damasDB.rpc('fn_realizar_movimiento', {
            p_sesion_id: estadoJuego.sesionId,
            p_partida_id: estadoJuego.partidaId,
            p_fila_origen: Number(ficha.fila_tablero),
            p_columna_origen: Number(ficha.columna_tablero),
            p_fila_destino: Number(destino.fila),
            p_columna_destino: Number(destino.columna)
        });
        if (error) throw error;
        if (!data?.exito) throw new Error('La base de datos no confirmó el movimiento.');

        estadoJuego.fichaSeleccionada = null;
        estadoJuego.movimientosSugeridos = [];
        await solicitarRecarga({
            seleccionarFichaId: data.debe_continuar ? (data.ficha_id || fichaId) : null,
            fichaMovidaId: data.ficha_id || fichaId,
            fichaCoronadaId: data.coronada ? (data.ficha_id || fichaId) : null
        });

        if (data.debe_continuar) {
            anunciar('Captura realizada. Debes continuar con la misma ficha.');
        }
    } catch (error) {
        if (esErrorSesion(error)) {
            await manejarSesionInvalida();
            return;
        }

        informarError(error, 'La base de datos rechazó el movimiento.');
        await solicitarRecarga({ seleccionarFichaId: fichaId }).catch((errorRecarga) => {
            console.error('[Juego] Tampoco se pudo recuperar el tablero.', errorRecarga);
        });
    } finally {
        estadoJuego.movimientoEnProceso = false;
        renderizarJuego();
    }
}

function manejarClickTablero(evento) {
    if (estadoJuego.movimientoEnProceso || estadoJuego.partidaFinalizada) return;

    const botonFicha = evento.target.closest('.ficha');
    if (botonFicha && dom.tablero.contains(botonFicha)) {
        evento.stopPropagation();
        seleccionarFicha(obtenerFicha(botonFicha.dataset.fichaId));
        return;
    }

    const casilla = evento.target.closest('.casilla');
    if (!casilla || !dom.tablero.contains(casilla)) return;

    const destino = estadoJuego.movimientosSugeridos.find((movimiento) => (
        Number(movimiento.fila) === Number(casilla.dataset.fila) &&
        Number(movimiento.columna) === Number(casilla.dataset.columna)
    ));
    if (destino) {
        void realizarMovimiento(destino);
    } else if (!estadoJuego.fichaCadenaId && !casilla.querySelector('.ficha')) {
        estadoJuego.fichaSeleccionada = null;
        estadoJuego.movimientosSugeridos = [];
        renderizarTablero();
    }
}

function manejarTecladoTablero(evento) {
    if (evento.key !== 'Enter' && evento.key !== ' ') return;
    const casilla = evento.target.closest('.casilla');
    if (!casilla || casilla.dataset.disponible !== 'true') return;
    evento.preventDefault();
    manejarClickTablero({
        target: casilla,
        stopPropagation() {}
    });
}

function renderizarJugadoresModal() {
    if (!dom.modalJugadores || !estadoJuego.resumen) return;
    dom.modalJugadores.replaceChildren();

    const ganador = jugadorPorId(estadoJuego.resumen.jugador_ganador_id);
    const perdedor = jugadorPorId(estadoJuego.resumen.jugador_perdedor_id);
    if (!ganador || !perdedor) return;

    const crearTarjeta = (jugador, etiqueta) => {
        const contenedor = document.createElement('div');
        contenedor.className = 'modal-jugador';

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        const imagen = document.createElement('img');
        imagen.className = 'avatar__imagen';
        imagen.alt = `Foto de ${jugador.nombre}`;
        imagen.hidden = true;
        const inicial = document.createElement('span');
        inicial.className = 'avatar__inicial';
        inicial.setAttribute('aria-hidden', 'true');
        avatar.append(imagen, inicial);

        const nombre = document.createElement('span');
        nombre.className = 'modal-jugador__nombre';
        nombre.textContent = `${etiqueta}: ${jugador.nombre}`;
        contenedor.append(avatar, nombre);
        aplicarFotoPerfil(imagen, inicial, jugador.nombre, jugador.foto);
        return contenedor;
    };

    const separador = document.createElement('span');
    separador.className = 'modal-jugadores__separador';
    separador.textContent = 'vs';
    separador.setAttribute('aria-hidden', 'true');

    dom.modalJugadores.append(
        crearTarjeta(ganador, 'Ganador'),
        separador,
        crearTarjeta(perdedor, 'Rival')
    );
}

function lanzarConfeti() {
    if (!dom.confeti || estadoJuego.confetiMostrado) return;
    estadoJuego.confetiMostrado = true;
    const fragmento = document.createDocumentFragment();

    for (let indice = 0; indice < 46; indice += 1) {
        const pieza = document.createElement('i');
        pieza.className = 'confeti__pieza';
        pieza.style.left = `${Math.random() * 100}%`;
        pieza.style.backgroundColor = COLORES_CONFETI[indice % COLORES_CONFETI.length];
        pieza.style.animationDelay = `${Math.random() * 0.8}s`;
        pieza.style.animationDuration = `${2.5 + Math.random() * 1.7}s`;
        pieza.style.setProperty('--desvio', `${-80 + Math.random() * 160}px`);
        fragmento.append(pieza);
    }

    dom.confeti.append(fragmento);
    window.setTimeout(() => dom.confeti?.replaceChildren(), 5_200);
}

function mensajeDisponible() {
    return Boolean(
        estadoJuego.mensajeEnviadoLocalmente ||
        estadoJuego.postpartida?.mensaje_positivo_enviado ||
        estadoJuego.postpartida?.mensaje_positivo_recibido
    );
}

function actualizarContadorMensaje() {
    if (!dom.contadorMensaje || !dom.mensajePositivo) return;
    dom.contadorMensaje.textContent = `${dom.mensajePositivo.value.length} / 500`;
}

function renderizarPostpartida() {
    if (!estadoJuego.resumen || !estadoJuego.modalAbierto) return;

    const ganador = jugadorPorId(estadoJuego.resumen.jugador_ganador_id);
    const perdedor = jugadorPorId(estadoJuego.resumen.jugador_perdedor_id);
    const soyGanador = idsIguales(estadoJuego.jugadorId, estadoJuego.resumen.jugador_ganador_id);
    const estadoLocal = estadoJuego.postpartida;

    if (soyGanador) {
        if (dom.modalTitulo) dom.modalTitulo.textContent = '🏆 ¡Ganaste!';
        if (dom.modalDescripcion) {
            dom.modalDescripcion.textContent = estadoLocal?.mensaje_positivo_recibido
                ? `${perdedor?.nombre || 'Tu rival'} te dejó un mensaje.`
                : `Esperando el mensaje de ${perdedor?.nombre || 'tu rival'}…`;
        }
        mostrar(dom.bloqueEsperaMensaje, true);
        mostrar(dom.bloqueMensajePerdedor, false);

        const textoEspera = dom.bloqueEsperaMensaje?.querySelector('p');
        if (estadoLocal?.mensaje_positivo_recibido) {
            if (textoEspera) {
                textoEspera.textContent = `${perdedor?.nombre || 'Tu rival'} dice que le gusta de ti:`;
            }
            if (dom.mensajeRecibido) {
                dom.mensajeRecibido.textContent = estadoLocal.mensaje_positivo_recibido;
                mostrar(dom.mensajeRecibido, true);
            }
        } else {
            if (textoEspera) textoEspera.textContent = `Esperando el mensaje de ${perdedor?.nombre || 'tu rival'}…`;
            mostrar(dom.mensajeRecibido, false);
        }
    } else {
        if (dom.modalTitulo) dom.modalTitulo.textContent = `Esta vez ganó ${ganador?.nombre || 'tu rival'}`;
        if (dom.modalDescripcion) {
            dom.modalDescripcion.textContent = 'Una buena partida también termina con un gesto amable.';
        }
        mostrar(dom.bloqueEsperaMensaje, false);
        mostrar(dom.bloqueMensajePerdedor, true);
        if (dom.etiquetaMensaje) {
            dom.etiquetaMensaje.textContent = `Dile algo que te guste de ${ganador?.nombre || 'tu rival'}`;
        }

        const enviado = Boolean(
            estadoJuego.mensajeEnviadoLocalmente || estadoLocal?.mensaje_positivo_enviado
        );
        if (dom.mensajePositivo) dom.mensajePositivo.disabled = enviado || estadoJuego.mensajeEnProceso;
        if (dom.enviarMensaje) {
            dom.enviarMensaje.disabled = enviado || estadoJuego.mensajeEnProceso;
            dom.enviarMensaje.textContent = estadoJuego.mensajeEnProceso
                ? 'Enviando…'
                : enviado
                    ? 'Mensaje enviado'
                    : 'Enviar mensaje';
            dom.enviarMensaje.classList.toggle('cargando', estadoJuego.mensajeEnProceso);
        }
        if (dom.mensajeConfirmacion) {
            dom.mensajeConfirmacion.textContent = enviado
                ? 'Tu mensaje fue enviado. Gracias por cerrar bien la partida.'
                : '';
            mostrar(dom.mensajeConfirmacion, enviado);
        }
    }

    const habilitarAcciones = mensajeDisponible();
    mostrar(dom.acciones, habilitarAcciones);

    const accionLocal = estadoLocal?.accion_seleccionada;
    if (dom.volverJugar) {
        dom.volverJugar.disabled = estadoJuego.accionPostpartidaEnProceso ||
            accionLocal === 'volver_a_jugar' || estadoJuego.rivalTermino;
        dom.volverJugar.textContent = accionLocal === 'volver_a_jugar'
            ? 'Revancha solicitada'
            : 'Volver a jugar';
    }
    if (dom.terminar) dom.terminar.disabled = estadoJuego.accionPostpartidaEnProceso;

    if (estadoJuego.rivalTermino) {
        if (dom.estadoRevancha) {
            dom.estadoRevancha.textContent = 'El otro jugador terminó su sesión. Puedes terminar para volver al inicio.';
        }
        mostrar(dom.estadoRevancha, true);
    } else if (accionLocal === 'volver_a_jugar') {
        if (dom.estadoRevancha) {
            dom.estadoRevancha.textContent = 'Esperando que el otro jugador acepte la revancha…';
        }
        mostrar(dom.estadoRevancha, true);
    } else if (!estadoJuego.navegando) {
        mostrar(dom.estadoRevancha, false);
    }
}

async function marcarMensajeLeido() {
    if (estadoJuego.lecturaMensajeIntentada) return;
    estadoJuego.lecturaMensajeIntentada = true;

    const { error } = await damasDB.rpc('fn_marcar_mensaje_leido', {
        p_sesion_id: estadoJuego.sesionId,
        p_partida_id: estadoJuego.partidaId
    });
    if (error) console.warn('[Postpartida] No se pudo marcar el mensaje como leído.', error);
}

async function recuperarRevanchaSiExiste() {
    if (estadoJuego.comprobandoRevancha || estadoJuego.navegando) return;
    const acciones = estadoJuego.accionesPostpartida;
    if (acciones.length < 2 || !acciones.every((fila) => fila.accion_seleccionada === 'volver_a_jugar')) {
        return;
    }

    estadoJuego.comprobandoRevancha = true;
    try {
        const { data, error } = await damasDB.rpc('fn_accion_postpartida', {
            p_sesion_id: estadoJuego.sesionId,
            p_partida_id: estadoJuego.partidaId,
            p_accion: 'volver_a_jugar'
        });
        if (error) throw error;
        if (esUuid(data)) await navegarANuevaPartida(data);
    } catch (error) {
        if (esErrorSesion(error)) await manejarSesionInvalida();
        else console.warn('[Postpartida] No se pudo recuperar la revancha todavía.', error);
    } finally {
        estadoJuego.comprobandoRevancha = false;
    }
}

async function consultarEstadoPostpartida({ silencioso = false } = {}) {
    if (
        !estadoJuego.partidaFinalizada ||
        estadoJuego.consultaPostpartidaEnCurso ||
        estadoJuego.navegando
    ) return;

    estadoJuego.consultaPostpartidaEnCurso = true;
    try {
        const [consultaLocal, consultaAcciones] = await Promise.all([
            damasDB
                .from('v_estado_postpartida')
                .select('*')
                .eq('partida_id', estadoJuego.partidaId)
                .eq('jugador_id', estadoJuego.jugadorId)
                .maybeSingle(),
            damasDB
                .from('v_estado_postpartida')
                .select('jugador_id,accion_seleccionada')
                .eq('partida_id', estadoJuego.partidaId)
        ]);
        if (consultaLocal.error) throw consultaLocal.error;
        if (consultaAcciones.error) throw consultaAcciones.error;

        estadoJuego.postpartida = consultaLocal.data || estadoJuego.postpartida;
        estadoJuego.accionesPostpartida = Array.isArray(consultaAcciones.data)
            ? consultaAcciones.data
            : [];
        estadoJuego.rivalTermino = estadoJuego.accionesPostpartida.some((fila) => (
            !idsIguales(fila.jugador_id, estadoJuego.jugadorId) &&
            fila.accion_seleccionada === 'terminar'
        ));
        renderizarPostpartida();

        if (
            idsIguales(estadoJuego.jugadorId, estadoJuego.resumen?.jugador_ganador_id) &&
            estadoJuego.postpartida?.mensaje_positivo_recibido &&
            !estadoJuego.postpartida?.mensaje_positivo_leido_en
        ) {
            void marcarMensajeLeido();
        }

        if (estadoJuego.postpartida?.accion_seleccionada === 'volver_a_jugar') {
            void recuperarRevanchaSiExiste();
        }
    } catch (error) {
        if (esErrorSesion(error)) {
            await manejarSesionInvalida();
        } else if (!silencioso) {
            informarError(error, 'No pudimos consultar el cierre de la partida.');
        } else {
            console.warn('[Postpartida] Polling:', mensajeError(error));
        }
    } finally {
        estadoJuego.consultaPostpartidaEnCurso = false;
    }
}

function iniciarPollingPostpartida() {
    if (estadoJuego.postpartidaPollingId !== null) return;
    estadoJuego.postpartidaPollingId = window.setInterval(() => {
        void consultarEstadoPostpartida({ silencioso: true });
    }, INTERVALO_POSTPARTIDA_MS);
}

function detenerPollingPostpartida() {
    if (estadoJuego.postpartidaPollingId !== null) {
        window.clearInterval(estadoJuego.postpartidaPollingId);
        estadoJuego.postpartidaPollingId = null;
    }
}

function manejarEventoSalaRevancha(evento) {
    if (evento?.tipo_evento !== 'partida_lista') return;
    if (!idsIguales(evento.jugador_destino_id, estadoJuego.jugadorId)) return;
    const nuevaPartidaId = evento.partida_id || evento.datos?.nueva_partida_id;
    if (esUuid(nuevaPartidaId) && !idsIguales(nuevaPartidaId, estadoJuego.partidaId)) {
        void navegarANuevaPartida(nuevaPartidaId);
    }
}

function suscribirSalaParaRevancha() {
    if (estadoJuego.salaRevanchaSuscrita) return;
    estadoJuego.salaRevanchaSuscrita = true;
    suscribirseSala(manejarEventoSalaRevancha, {
        onEstado: (estado) => {
            if (estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT') {
                console.warn('[Realtime] La sala de revancha está reconectando.');
            }
        }
    });
}

async function abrirPostpartida() {
    if (!estadoJuego.resumen || !estadoJuego.partidaFinalizada) return;

    const primeraApertura = !estadoJuego.modalAbierto;
    estadoJuego.modalAbierto = true;
    mostrar(dom.modal, true);
    document.body.classList.add('modal-abierto');
    renderizarJugadoresModal();
    renderizarPostpartida();
    suscribirSalaParaRevancha();
    iniciarPollingPostpartida();

    if (idsIguales(estadoJuego.jugadorId, estadoJuego.resumen.jugador_ganador_id)) {
        lanzarConfeti();
    }

    await consultarEstadoPostpartida({ silencioso: !primeraApertura });

    if (primeraApertura) {
        const soyPerdedor = idsIguales(
            estadoJuego.jugadorId,
            estadoJuego.resumen.jugador_perdedor_id
        );
        const foco = soyPerdedor && !mensajeDisponible()
            ? dom.mensajePositivo
            : mensajeDisponible()
                ? dom.volverJugar
                : dom.modal;
        window.setTimeout(() => foco?.focus(), 80);
    }
}

async function enviarMensajePositivo() {
    if (estadoJuego.mensajeEnProceso || estadoJuego.mensajeEnviadoLocalmente) return;
    const mensaje = dom.mensajePositivo?.value.trim() || '';
    if (!mensaje) {
        mostrarToast('Escribe un mensaje antes de enviarlo.', 'error');
        dom.mensajePositivo?.focus();
        return;
    }
    if (mensaje.length > 500) {
        mostrarToast('El mensaje no puede superar 500 caracteres.', 'error');
        return;
    }

    estadoJuego.mensajeEnProceso = true;
    renderizarPostpartida();
    try {
        const { data, error } = await damasDB.rpc('fn_enviar_mensaje_positivo', {
            p_sesion_id: estadoJuego.sesionId,
            p_partida_id: estadoJuego.partidaId,
            p_mensaje: mensaje
        });
        if (error) throw error;
        if (data === null || data === undefined) throw new Error('La base de datos no confirmó el mensaje.');

        estadoJuego.mensajeEnviadoLocalmente = true;
        mostrarToast('Mensaje enviado.', 'exito');
        await consultarEstadoPostpartida({ silencioso: false });
    } catch (error) {
        if (esErrorSesion(error)) await manejarSesionInvalida();
        else informarError(error, 'No fue posible enviar el mensaje.');
    } finally {
        estadoJuego.mensajeEnProceso = false;
        renderizarPostpartida();
    }
}

async function navegarANuevaPartida(nuevaPartidaId) {
    if (!esUuid(nuevaPartidaId) || estadoJuego.navegando) return;
    estadoJuego.navegando = true;
    detenerPollingRival();
    detenerPollingPostpartida();
    detenerHeartbeat();
    detenerAudioJuego();
    guardarSesion({ partidaId: String(nuevaPartidaId) });
    if (dom.estadoRevancha) dom.estadoRevancha.textContent = 'Revancha lista. Abriendo el tablero…';
    mostrar(dom.estadoRevancha, true);
    anunciar('Revancha lista. Abriendo el nuevo tablero.');
    await eliminarTodosLosCanales();
    window.location.assign(`./juego.html?partida=${encodeURIComponent(nuevaPartidaId)}`);
}

async function ejecutarAccionPostpartida(accion) {
    if (estadoJuego.accionPostpartidaEnProceso || !mensajeDisponible()) return;
    estadoJuego.accionPostpartidaEnProceso = true;
    renderizarPostpartida();

    try {
        const { data, error } = await damasDB.rpc('fn_accion_postpartida', {
            p_sesion_id: estadoJuego.sesionId,
            p_partida_id: estadoJuego.partidaId,
            p_accion: accion
        });
        if (error) throw error;

        if (accion === 'terminar') {
            await finalizarSesionLocal();
            return;
        }

        if (esUuid(data)) {
            await navegarANuevaPartida(data);
            return;
        }

        estadoJuego.postpartida = {
            ...(estadoJuego.postpartida || {}),
            accion_seleccionada: 'volver_a_jugar'
        };
        if (dom.estadoRevancha) {
            dom.estadoRevancha.textContent = 'Esperando que el otro jugador acepte la revancha…';
        }
        mostrar(dom.estadoRevancha, true);
        await consultarEstadoPostpartida({ silencioso: true });
    } catch (error) {
        if (esErrorSesion(error)) await manejarSesionInvalida();
        else informarError(error, 'No fue posible registrar tu decisión.');
    } finally {
        estadoJuego.accionPostpartidaEnProceso = false;
        renderizarPostpartida();
    }
}

async function finalizarSesionLocal() {
    estadoJuego.navegando = true;
    detenerPollingRival();
    detenerPollingPostpartida();
    detenerHeartbeat();
    detenerAudioJuego();
    await eliminarTodosLosCanales();
    limpiarSesionDamas();
    window.location.replace('./index.html');
}

async function manejarEventoPartida(evento) {
    if (!evento || !idsIguales(evento.partida_id, estadoJuego.partidaId)) return;
    const tipo = String(evento.tipo_evento || '');

    if (['movimiento', 'captura', 'coronacion', 'partida_iniciada'].includes(tipo)) {
        const fichaId = evento.datos?.ficha_id;
        await solicitarRecarga({
            fichaMovidaId: fichaId,
            fichaCoronadaId: tipo === 'coronacion' ? fichaId : null
        }).catch((error) => informarError(error, 'No se pudo sincronizar el tablero.'));
        return;
    }

    if (tipo === 'victoria') {
        await solicitarRecarga().catch((error) => informarError(error, 'No se pudo cargar el resultado.'));
        return;
    }

    if (tipo === 'mensaje_positivo_enviado') {
        await consultarEstadoPostpartida({ silencioso: false });
        return;
    }

    if (tipo === 'revancha_creada') {
        const nuevaPartidaId = evento.datos?.nueva_partida_id;
        if (esUuid(nuevaPartidaId)) await navegarANuevaPartida(nuevaPartidaId);
    }
}

async function recuperarPartidaId() {
    const guardada = obtenerSesionGuardada();
    const parametro = new URL(window.location.href).searchParams.get('partida');

    if (parametro && esUuid(parametro)) return parametro;
    if (parametro && !esUuid(parametro)) {
        mostrarToast('El identificador de la URL no es válido; intentaremos recuperar tu partida.', 'error');
    }
    const { data, error } = await damasDB.rpc('fn_estado_sala_espera', {
        p_sesion_id: estadoJuego.sesionId
    });
    if (error) throw error;
    if (data?.estado === 'partida_iniciada' && esUuid(data.partida_id)) {
        return data.partida_id;
    }

    // Una partida finalizada ya no aparece en fn_estado_sala_espera; conservar
    // su UUID permite recuperar el modal de cierre tras un refresh.
    return guardada.partidaId && esUuid(guardada.partidaId)
        ? guardada.partidaId
        : null;
}

async function validarPerfil(sesionId) {
    const { data, error } = await damasDB.rpc('fn_obtener_perfil_sesion', {
        p_sesion_id: sesionId
    });
    if (error) throw error;
    if (!data?.jugador_id) throw new Error('La sesión no devolvió un perfil válido.');
    return data;
}

function normalizarUrlPartida(partidaId) {
    const url = new URL(window.location.href);
    url.searchParams.set('partida', partidaId);
    window.history.replaceState(null, '', `${url.pathname}?${url.searchParams.toString()}${url.hash}`);
}

function iniciarHeartbeatJuego() {
    iniciarHeartbeat({
        sesionId: estadoJuego.sesionId,
        onSesionInvalida: () => void manejarSesionInvalida(),
        onError: (error) => console.warn('[Heartbeat]', mensajeError(error))
    });
}

async function manejarSesionInvalida() {
    if (estadoJuego.sesionInvalida || estadoJuego.navegando) return;
    estadoJuego.sesionInvalida = true;
    estadoJuego.partidaFinalizada = true;
    estadoJuego.movimientoEnProceso = false;
    detenerPollingRival();
    detenerPollingPostpartida();
    detenerHeartbeat();
    detenerAudioJuego();
    limpiarSesionDamas();
    actualizarBloqueoTablero();
    await eliminarTodosLosCanales();
    mostrarToast('Tu sesión venció. Volveremos al inicio para que puedas entrar de nuevo.', 'error', 2_200);
    anunciar('Tu sesión venció. Volviendo al inicio.');
    window.setTimeout(() => window.location.replace('./index.html'), 1_650);
}

function registrarEventos() {
    dom.tablero.addEventListener('click', manejarClickTablero);
    dom.tablero.addEventListener('keydown', manejarTecladoTablero);
    dom.mensajePositivo.addEventListener('input', actualizarContadorMensaje);
    dom.enviarMensaje.addEventListener('click', () => void enviarMensajePositivo());
    dom.volverJugar.addEventListener('click', () => void ejecutarAccionPostpartida('volver_a_jugar'));
    dom.terminar.addEventListener('click', () => void ejecutarAccionPostpartida('terminar'));
    document.addEventListener('visibilitychange', manejarVisibilidadJuego);
}

async function inicializar() {
    obtenerElementos();
    if (!elementosEsencialesPresentes()) {
        console.error('[Juego] Faltan elementos esenciales en juego.html.');
        return;
    }

    registrarEventos();
    construirTablero('jugador-2');
    actualizarContadorMensaje();

    prepararAudio();
    registrarDesbloqueoAudio();
    void reproducirMusicaFondo();

    const guardada = obtenerSesionGuardada();
    if (!guardada.sesionId) {
        window.location.replace('./index.html');
        return;
    }

    estadoJuego.sesionId = guardada.sesionId;
    try {
        estadoJuego.perfil = await validarPerfil(estadoJuego.sesionId);
        estadoJuego.jugadorId = String(estadoJuego.perfil.jugador_id);
        guardarSesion({
            sesionId: estadoJuego.sesionId,
            jugadorId: estadoJuego.jugadorId,
            nombreUsuario: estadoJuego.perfil.nombre_usuario,
            foto: estadoJuego.perfil.foto_perfil_url
        });
        iniciarHeartbeatJuego();

        const partidaId = await recuperarPartidaId();
        if (!partidaId) {
            mostrarToast('No hay una partida activa para recuperar. Volviendo a la sala.', 'error', 2_000);
            window.setTimeout(() => window.location.replace('./index.html'), 1_200);
            return;
        }

        estadoJuego.partidaId = String(partidaId);
        guardarSesion({ partidaId: estadoJuego.partidaId });
        normalizarUrlPartida(estadoJuego.partidaId);
        suscribirsePartida(
            estadoJuego.partidaId,
            (evento) => void manejarEventoPartida(evento),
            { onEstado: manejarEstadoRealtime, debounceMs: 150 }
        );
        await solicitarRecarga();
    } catch (error) {
        if (esErrorSesion(error)) {
            await manejarSesionInvalida();
            return;
        }

        informarError(error, 'No fue posible cargar la partida.');
        if (dom.turno) dom.turno.textContent = 'No pudimos abrir la partida';
        if (dom.detalle) dom.detalle.textContent = 'Revisa la conexión y vuelve a intentarlo';
        dom.app?.setAttribute('aria-busy', 'false');
    }
}

window.addEventListener('pagehide', () => {
    detenerPollingRival();
    detenerPollingPostpartida();
    detenerHeartbeat();
    detenerAudioJuego();
    void eliminarTodosLosCanales();
});
window.addEventListener('pageshow', (evento) => {
    if (evento.persisted) window.location.reload();
});

document.addEventListener('DOMContentLoaded', () => void inicializar());
