import {
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
    consultarEstadoSala,
    establecerSesionSala,
    inicializarSala,
    iniciarOUnirsePartida
} from './sala.js';
import { eliminarTodosLosCanales } from './realtime.js';

const estadoLogin = {
    loginEnProceso: false,
    sesionValidada: false,
    esperando: false,
    sesionId: null,
    perfil: null,
    redirigiendo: false
};

const dom = {};

function obtenerElementos() {
    dom.formulario = document.querySelector('#login-form');
    dom.usuario = document.querySelector('#usuario');
    dom.contrasena = document.querySelector('#contrasena');
    dom.botonIniciar = document.querySelector('#iniciar-partida');
    dom.error = document.querySelector('#login-error');
    dom.anuncio = document.querySelector('#anuncio-index');
    dom.toastContainer = document.querySelector('#toast-container');
}

function anunciar(texto) {
    if (dom.anuncio) dom.anuncio.textContent = texto;
}

function limpiarError() {
    if (!dom.error) return;
    dom.error.textContent = '';
    dom.error.hidden = true;
    dom.error.classList.add('oculto');
}

function mostrarError(error) {
    const texto = typeof error === 'string' ? error : mensajeError(error);
    if (dom.error) {
        dom.error.textContent = texto;
        dom.error.hidden = false;
        dom.error.classList.remove('oculto');
    }
    anunciar(`Error: ${texto}`);
}

function mostrarToast(texto, tipo = 'error') {
    if (!dom.toastContainer) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${tipo}`;
    toast.setAttribute('role', tipo === 'error' ? 'alert' : 'status');
    toast.textContent = texto;
    dom.toastContainer.append(toast);
    window.setTimeout(() => toast.remove(), 4_500);
}

function actualizarFormulario() {
    const usandoSesion = estadoLogin.sesionValidada && estadoLogin.perfil;
    const bloqueado = estadoLogin.loginEnProceso || estadoLogin.esperando || estadoLogin.redirigiendo;

    if (usandoSesion) {
        dom.usuario.value = estadoLogin.perfil.nombre_usuario || '';
        dom.usuario.disabled = true;
        dom.contrasena.value = '';
        dom.contrasena.disabled = true;
        dom.contrasena.required = false;
        dom.botonIniciar.textContent = estadoLogin.esperando
            ? 'Buscando rival…'
            : `Iniciar como ${estadoLogin.perfil.nombre_usuario}`;
    } else {
        dom.usuario.disabled = estadoLogin.loginEnProceso || estadoLogin.redirigiendo;
        dom.contrasena.disabled = estadoLogin.loginEnProceso || estadoLogin.redirigiendo;
        dom.contrasena.required = true;
        dom.botonIniciar.textContent = estadoLogin.loginEnProceso
            ? 'Abriendo la mesa…'
            : 'Iniciar partida';
    }

    dom.botonIniciar.disabled = bloqueado;
    dom.formulario?.setAttribute('aria-busy', String(estadoLogin.loginEnProceso));
}

function guardarPerfilEnSesion(sesionId, perfil) {
    guardarSesion({
        sesionId: String(sesionId),
        jugadorId: String(perfil.jugador_id),
        nombreUsuario: String(perfil.nombre_usuario || ''),
        foto: String(perfil.foto_perfil_url || '')
    });
}

function activarHeartbeat() {
    iniciarHeartbeat({
        sesionId: estadoLogin.sesionId,
        onSesionInvalida: () => void manejarSesionInvalida(),
        onError: (error) => console.warn('[Heartbeat]', mensajeError(error))
    });
}

async function manejarSesionInvalida(mensaje = 'Tu sesión venció. Inicia de nuevo para jugar.') {
    detenerHeartbeat();
    await eliminarTodosLosCanales();
    limpiarSesionDamas();

    estadoLogin.sesionValidada = false;
    estadoLogin.sesionId = null;
    estadoLogin.perfil = null;
    estadoLogin.esperando = false;
    estadoLogin.loginEnProceso = false;
    estadoLogin.redirigiendo = false;
    establecerSesionSala();
    actualizarFormulario();
    mostrarError(mensaje);

    await inicializarSala({
        onPartida: navegarAPartida,
        onError: manejarErrorSala,
        onEsperaCambia: manejarCambioEspera
    });
}

function navegarAPartida(partidaId) {
    if (!partidaId || estadoLogin.redirigiendo) return;
    estadoLogin.redirigiendo = true;
    guardarSesion({ partidaId: String(partidaId) });
    anunciar('Partida lista. Abriendo el tablero…');
    actualizarFormulario();
    window.location.assign(`./juego.html?partida=${encodeURIComponent(partidaId)}`);
}

function manejarCambioEspera(esperando) {
    estadoLogin.esperando = Boolean(esperando);
    if (estadoLogin.esperando) limpiarError();
    actualizarFormulario();
    anunciar(esperando ? 'Esperando al otro jugador…' : 'La mesa está lista para iniciar.');
}

function manejarErrorSala(error, { silencioso = false } = {}) {
    if (esErrorSesion(error)) {
        void manejarSesionInvalida();
        return;
    }
    if (!silencioso) {
        mostrarError(error);
        mostrarToast(mensajeError(error));
    }
}

function esErrorPartidaActiva(error) {
    const texto = [error?.message, error?.details, error?.hint]
        .filter(Boolean)
        .join(' ')
        .toLocaleLowerCase('es');
    return texto.includes('ya esta en una partida activa') ||
        texto.includes('ya está en una partida activa');
}

async function obtenerPerfil(sesionId) {
    const { data, error } = await damasDB.rpc('fn_obtener_perfil_sesion', {
        p_sesion_id: sesionId
    });
    if (error) throw error;
    if (!data?.jugador_id) throw new Error('La sesión no devolvió un perfil válido.');
    return data;
}

async function recuperarSesion() {
    const guardada = obtenerSesionGuardada();
    if (!guardada.sesionId) return;

    try {
        const perfil = await obtenerPerfil(guardada.sesionId);
        estadoLogin.sesionId = String(guardada.sesionId);
        estadoLogin.perfil = perfil;
        estadoLogin.sesionValidada = true;
        guardarPerfilEnSesion(guardada.sesionId, perfil);
        establecerSesionSala({
            sesionId: guardada.sesionId,
            jugadorId: perfil.jugador_id,
            perfil
        });
        activarHeartbeat();
        actualizarFormulario();
        await consultarEstadoSala({ silencioso: false });
    } catch (error) {
        console.warn('[Login] No se pudo recuperar la sesión.', error);
        if (esErrorSesion(error)) {
            limpiarSesionDamas();
            estadoLogin.sesionId = null;
            estadoLogin.perfil = null;
            estadoLogin.sesionValidada = false;
            establecerSesionSala();
            actualizarFormulario();
            mostrarError('La sesión anterior venció. Puedes iniciar una nueva.');
        } else {
            mostrarError(error);
        }
    }
}

async function iniciarConSesionActual() {
    limpiarError();
    estadoLogin.loginEnProceso = true;
    actualizarFormulario();
    try {
        await iniciarOUnirsePartida();
    } catch (error) {
        console.error('[Login] No se pudo iniciar o unir la partida.', error);
        if (esErrorSesion(error)) await manejarSesionInvalida();
        else if (esErrorPartidaActiva(error)) await consultarEstadoSala({ silencioso: false });
        else mostrarError(error);
    } finally {
        estadoLogin.loginEnProceso = false;
        actualizarFormulario();
    }
}

async function iniciarSesionYPartida() {
    const usuario = dom.usuario.value.trim();
    const contrasena = dom.contrasena.value;

    if (!usuario || !contrasena) {
        mostrarError('Escribe tu usuario y contraseña para entrar.');
        return;
    }

    limpiarError();
    estadoLogin.loginEnProceso = true;
    actualizarFormulario();

    let nuevaSesionId = null;
    try {
        const { data: sesionId, error: errorLogin } = await damasDB.rpc('fn_iniciar_sesion', {
            p_nombre_usuario: usuario,
            p_contrasena: contrasena
        });
        if (errorLogin) throw errorLogin;
        if (!sesionId) throw new Error('No fue posible crear la sesión.');
        nuevaSesionId = String(sesionId);

        const perfil = await obtenerPerfil(nuevaSesionId);
        estadoLogin.sesionId = nuevaSesionId;
        estadoLogin.perfil = perfil;
        estadoLogin.sesionValidada = true;
        dom.contrasena.value = '';

        guardarPerfilEnSesion(nuevaSesionId, perfil);
        establecerSesionSala({
            sesionId: nuevaSesionId,
            jugadorId: perfil.jugador_id,
            perfil
        });
        activarHeartbeat();
        anunciar(`Sesión iniciada como ${perfil.nombre_usuario}. Buscando rival…`);
        await iniciarOUnirsePartida();
    } catch (error) {
        console.error('[Login] Error original:', error);
        if (esErrorSesion(error)) {
            await manejarSesionInvalida();
        } else if (esErrorPartidaActiva(error) && estadoLogin.sesionValidada) {
            await consultarEstadoSala({ silencioso: false });
        } else {
            mostrarError(error);
        }

        if (nuevaSesionId && !estadoLogin.sesionValidada) {
            try {
                await damasDB.rpc('fn_cerrar_sesion', { p_sesion_id: nuevaSesionId });
            } catch (errorCierre) {
                console.warn('[Login] No se pudo cerrar una sesión incompleta.', errorCierre);
            }
            limpiarSesionDamas();
        }
    } finally {
        estadoLogin.loginEnProceso = false;
        actualizarFormulario();
    }
}

async function manejarSubmit(evento) {
    evento.preventDefault();
    if (estadoLogin.loginEnProceso || estadoLogin.esperando || estadoLogin.redirigiendo) return;

    if (estadoLogin.sesionValidada && !estadoLogin.esperando) await iniciarConSesionActual();
    else await iniciarSesionYPartida();
}

async function inicializar() {
    obtenerElementos();
    if (!dom.formulario || !dom.usuario || !dom.contrasena || !dom.botonIniciar) {
        console.error('[Login] Faltan elementos esenciales del formulario.');
        return;
    }

    dom.formulario.addEventListener('submit', (evento) => void manejarSubmit(evento));
    actualizarFormulario();

    await inicializarSala({
        onPartida: navegarAPartida,
        onError: manejarErrorSala,
        onEsperaCambia: manejarCambioEspera
    });
    await recuperarSesion();
}

window.addEventListener('pagehide', () => detenerHeartbeat());
window.addEventListener('pageshow', (evento) => {
    if (evento.persisted) window.location.reload();
});
document.addEventListener('DOMContentLoaded', () => void inicializar());
