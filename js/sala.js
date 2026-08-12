import {
    aplicarFotoPerfil,
    damasDB,
    esErrorConfiguracionSupabase,
    esErrorSesion,
    guardarSesion,
    mensajeError
} from './supabase.js';
import {
    eliminarCanal,
    suscribirseSala
} from './realtime.js';

const INTERVALO_POLLING_MS = 4_000;
const INTERVALO_SALA_PUBLICA_MS = 30_000;

const estadoSala = {
    sesionId: null,
    jugadorId: null,
    perfil: null,
    esperando: false,
    consultaEstadoEnCurso: false,
    cancelacionEnCurso: false,
    redirigiendo: false,
    pollingId: null,
    pollingPublicoId: null,
    versionConsultaPublica: 0,
    errorConfiguracionNotificado: false,
    inicializada: false,
    callbacks: {
        onPartida: null,
        onError: null,
        onEsperaCambia: null,
        onConexionCambia: null
    }
};

const dom = {};

function obtenerElementos() {
    dom.salaPublica = document.querySelector('#sala-publica');
    dom.salaAvatar = document.querySelector('#sala-avatar');
    dom.salaInicial = document.querySelector('#sala-inicial');
    dom.salaNombre = document.querySelector('#sala-nombre');
    dom.salaMensaje = document.querySelector('#sala-mensaje');
    dom.panelEspera = document.querySelector('#panel-espera');
    dom.esperaTexto = document.querySelector('#espera-texto');
    dom.cancelarEspera = document.querySelector('#cancelar-espera');
    dom.conexionEstado = document.querySelector('#conexion-estado');
}

function mostrar(elemento, visible) {
    if (!elemento) return;
    elemento.hidden = !visible;
    elemento.classList.toggle('oculto', !visible);
}

function ponerEstadoConexion(estado) {
    if (!dom.conexionEstado) return;

    const conectado = estado === 'SUBSCRIBED';
    const conectando = estado === 'CONNECTING';
    const error = estado === 'CHANNEL_ERROR' || estado === 'TIMED_OUT';

    dom.conexionEstado.textContent = conectado
        ? 'Conectado en tiempo real'
        : error
            ? 'Reconectando…'
            : conectando
                ? 'Conectando…'
                : 'Conexión en espera';
    dom.conexionEstado.dataset.estado = conectado ? 'conectado' : error ? 'error' : 'conectando';
    estadoSala.callbacks.onConexionCambia?.(estado);
}

function mostrarSalaVacia() {
    if (dom.salaNombre) dom.salaNombre.textContent = 'La mesa está libre';
    if (dom.salaMensaje) dom.salaMensaje.textContent = 'No hay jugadores esperando';
    if (dom.salaInicial) dom.salaInicial.textContent = '—';
    if (dom.salaAvatar) {
        dom.salaAvatar.removeAttribute('src');
        dom.salaAvatar.hidden = true;
    }
    if (dom.salaInicial) dom.salaInicial.hidden = false;
    dom.salaPublica?.classList.remove('hay-jugador');
}

function mostrarJugadorEsperando(jugador) {
    const nombre = String(jugador?.nombre_usuario || 'Alguien');
    if (dom.salaNombre) dom.salaNombre.textContent = nombre;
    if (dom.salaMensaje) dom.salaMensaje.textContent = `${nombre} quiere jugar contigo`;
    aplicarFotoPerfil(
        dom.salaAvatar,
        dom.salaInicial,
        nombre,
        jugador?.foto_perfil_url
    );
    dom.salaPublica?.classList.add('hay-jugador');
}

function notificarError(error, opciones = {}) {
    console.error('[Sala de espera]', error);
    estadoSala.callbacks.onError?.(error, opciones);
}

export async function actualizarSalaPublica() {
    const version = ++estadoSala.versionConsultaPublica;
    dom.salaPublica?.setAttribute('aria-busy', 'true');

    try {
        const { data, error } = await damasDB
            .from('v_sala_espera_publica')
            .select('*')
            .order('creada_en', { ascending: true })
            .limit(1);

        if (error) throw error;
        if (version !== estadoSala.versionConsultaPublica) return;

        estadoSala.errorConfiguracionNotificado = false;

        const jugador = Array.isArray(data) ? data[0] : null;
        if (jugador) mostrarJugadorEsperando(jugador);
        else mostrarSalaVacia();
    } catch (error) {
        if (version !== estadoSala.versionConsultaPublica) return;
        mostrarSalaVacia();
        if (dom.salaMensaje) {
            dom.salaMensaje.textContent = 'No pudimos consultar la mesa. Volveremos a intentarlo.';
        }
        const esErrorConfiguracion = esErrorConfiguracionSupabase(error);
        const yaNotificado = estadoSala.errorConfiguracionNotificado;
        if (esErrorConfiguracion) estadoSala.errorConfiguracionNotificado = true;

        // Los errores pasajeros de la consulta publica no interrumpen el
        // acceso. Una instalacion incompleta, en cambio, debe mostrarse una vez
        // porque tambien impediria ejecutar la RPC de inicio de sesion.
        if (!esErrorConfiguracion || !yaNotificado) {
            notificarError(error, { silencioso: !esErrorConfiguracion });
        }
    } finally {
        if (version === estadoSala.versionConsultaPublica) {
            dom.salaPublica?.setAttribute('aria-busy', 'false');
        }
    }
}

function detenerPolling() {
    if (estadoSala.pollingId !== null) {
        window.clearInterval(estadoSala.pollingId);
        estadoSala.pollingId = null;
    }
}

function iniciarPolling() {
    detenerPolling();
    estadoSala.pollingId = window.setInterval(() => {
        void consultarEstadoSala({ silencioso: true });
    }, INTERVALO_POLLING_MS);
}

function iniciarPollingSalaPublica() {
    if (estadoSala.pollingPublicoId !== null) return;
    estadoSala.pollingPublicoId = window.setInterval(() => {
        void actualizarSalaPublica();
    }, INTERVALO_SALA_PUBLICA_MS);
}

function detenerPollingSalaPublica() {
    if (estadoSala.pollingPublicoId !== null) {
        window.clearInterval(estadoSala.pollingPublicoId);
        estadoSala.pollingPublicoId = null;
    }
}

function cambiarEstadoEspera(esperando, texto = 'Esperando al otro jugador…') {
    estadoSala.esperando = Boolean(esperando);
    mostrar(dom.panelEspera, estadoSala.esperando);
    if (dom.esperaTexto) dom.esperaTexto.textContent = texto;
    if (dom.cancelarEspera) dom.cancelarEspera.disabled = false;

    if (estadoSala.esperando) iniciarPolling();
    else detenerPolling();

    estadoSala.callbacks.onEsperaCambia?.(estadoSala.esperando);
}

async function irAPartida(partidaId) {
    if (!partidaId || estadoSala.redirigiendo) return;
    estadoSala.redirigiendo = true;
    cambiarEstadoEspera(false);
    guardarSesion({ partidaId: String(partidaId) });

    try {
        await eliminarCanal('sala');
    } catch (error) {
        console.warn('[Sala de espera] No se pudo retirar el canal antes de navegar.', error);
    }

    if (typeof estadoSala.callbacks.onPartida === 'function') {
        estadoSala.callbacks.onPartida(String(partidaId));
        return;
    }

    window.location.assign(`./juego.html?partida=${encodeURIComponent(partidaId)}`);
}

async function procesarRespuestaSala(respuesta) {
    if (!respuesta || respuesta.exito === false) {
        throw new Error(respuesta?.mensaje || 'No fue posible preparar la partida.');
    }

    if (respuesta.estado === 'partida_iniciada' && respuesta.partida_id) {
        await irAPartida(respuesta.partida_id);
        return respuesta;
    }

    if (respuesta.estado === 'esperando') {
        cambiarEstadoEspera(true, 'Esperando al otro jugador…');
        return respuesta;
    }

    if (respuesta.estado === 'sin_solicitud') {
        cambiarEstadoEspera(false);
        await actualizarSalaPublica();
        return respuesta;
    }

    throw new Error('La sala devolvió un estado que no reconocemos.');
}

async function manejarEventoSala(evento) {
    await actualizarSalaPublica();

    if (evento?.tipo_evento !== 'partida_lista') return;
    if (!estadoSala.jugadorId) return;
    if (String(evento.jugador_destino_id || '') !== String(estadoSala.jugadorId)) return;

    const partidaId = evento.partida_id || evento.datos?.nueva_partida_id;
    if (partidaId) await irAPartida(partidaId);
}

export function establecerSesionSala({ sesionId = null, jugadorId = null, perfil = null } = {}) {
    estadoSala.sesionId = sesionId ? String(sesionId) : null;
    estadoSala.jugadorId = jugadorId ? String(jugadorId) : null;
    estadoSala.perfil = perfil;
    estadoSala.redirigiendo = false;
}

export async function iniciarOUnirsePartida() {
    if (!estadoSala.sesionId) throw new Error('No hay una sesión válida para iniciar la partida.');

    const { data, error } = await damasDB.rpc('fn_iniciar_o_unirse_partida', {
        p_sesion_id: estadoSala.sesionId
    });

    if (error) throw error;
    return procesarRespuestaSala(data);
}

export async function consultarEstadoSala({ silencioso = false } = {}) {
    if (!estadoSala.sesionId || estadoSala.consultaEstadoEnCurso || estadoSala.redirigiendo) {
        return null;
    }

    estadoSala.consultaEstadoEnCurso = true;
    try {
        const { data, error } = await damasDB.rpc('fn_estado_sala_espera', {
            p_sesion_id: estadoSala.sesionId
        });
        if (error) throw error;
        return await procesarRespuestaSala(data);
    } catch (error) {
        if (esErrorSesion(error)) notificarError(error);
        else if (!silencioso) notificarError(error);
        else console.warn('[Sala de espera] Polling:', mensajeError(error));
        return null;
    } finally {
        estadoSala.consultaEstadoEnCurso = false;
    }
}

export async function cancelarEspera() {
    if (!estadoSala.sesionId || estadoSala.cancelacionEnCurso) return false;

    estadoSala.cancelacionEnCurso = true;
    if (dom.cancelarEspera) dom.cancelarEspera.disabled = true;

    try {
        const { data, error } = await damasDB.rpc('fn_cancelar_espera', {
            p_sesion_id: estadoSala.sesionId
        });
        if (error) throw error;

        if (data === true) {
            cambiarEstadoEspera(false);
            await actualizarSalaPublica();
            return true;
        }

        // La solicitud puede haberse emparejado en el mismo instante en que se
        // pulso cancelar. En ese caso la RPC devuelve false y el estado real se
        // recupera antes de detener el polling o cerrar el panel.
        await consultarEstadoSala({ silencioso: false });
        return false;
    } catch (error) {
        notificarError(error);
        return false;
    } finally {
        estadoSala.cancelacionEnCurso = false;
        if (dom.cancelarEspera) dom.cancelarEspera.disabled = false;
    }
}

export async function inicializarSala({
    onPartida = null,
    onError = null,
    onEsperaCambia = null,
    onConexionCambia = null
} = {}) {
    obtenerElementos();
    estadoSala.callbacks = { onPartida, onError, onEsperaCambia, onConexionCambia };

    if (!estadoSala.inicializada) {
        dom.cancelarEspera?.addEventListener('click', () => void cancelarEspera());
        estadoSala.inicializada = true;
    }

    ponerEstadoConexion('CONNECTING');
    await suscribirseSala(
        (evento) => void manejarEventoSala(evento),
        {
            onEstado: (estado) => {
                ponerEstadoConexion(estado);
                if (estado === 'SUBSCRIBED') {
                    void actualizarSalaPublica();
                    if (estadoSala.esperando) {
                        void consultarEstadoSala({ silencioso: true });
                    }
                }
            }
        }
    );
    iniciarPollingSalaPublica();
    await actualizarSalaPublica();
}

export async function destruirSala() {
    detenerPolling();
    detenerPollingSalaPublica();
    estadoSala.esperando = false;
    estadoSala.sesionId = null;
    estadoSala.jugadorId = null;
    await eliminarCanal('sala');
}
