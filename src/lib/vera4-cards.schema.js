/**
 * vera4-cards.schema.js — Contrato de las 30 cards del CEREBRO de Vera (cards.vera4).
 *
 * DE DONDE SALEN: VERA_BRAIN_MASTER v1.1 (Parte VI, el Ciclo de Relevancia:
 * Infiltracion -> Sincronizacion -> Manifestacion -> Aprendizaje) aterrizado en
 * los 4 tabs que ya existen. Cada card es un acto del ciclo, no un widget.
 *
 * EL PRINCIPIO, EL MISMO DE cards.v2: el frontend define los MOLDES y Vera los
 * LLENA con su juicio. Este archivo ES el molde, y sigue AL PINTOR
 * (js/views/dashboard/Vera4.mixin.js), no al reves. Si aqui se declara un campo
 * que el pintor no lee, Vera gasta una sesion escribiendo algo invisible.
 *
 * EL REPARTO ES PARTE DEL CONTRATO: cada type pertenece a UN tab. Las reglas de
 * los tabs se contradicen entre si —Mi Marca tiene prohibido nombrar a la
 * competencia— asi que una card en el tab equivocado no es un problema estetico:
 * hace que el tablero diga lo que no debe. Por eso el scope se valida aqui.
 *
 * LIMITES MAS ANCHOS QUE EL PROMPT (leccion cara de cards.v2): al prompt se le
 * piden 280 chars y el schema admite 360. Unos caracteres de mas no pueden
 * costar una lectura entera que ya se pago.
 *
 * schema_version: 4
 */
import { z } from "zod";

export const VERA4_SCHEMA = "cards.vera4";
export const VERA4_SCHEMA_VERSION = 4;

/* ── Vocabulario compartido ─────────────────────────────────────────────── */
const txt = (min, max) => z.string().trim().min(min).max(max);
const opt = (s) => s.optional().nullable();
// Evidencia: la disciplina anti-invencion. Es opcional en la forma pero el
// prompt la exige; sin ella una card es una opinion sin respaldo.
const EVIDENCE = opt(z.array(z.string().max(120)).max(12));
const PRIORIDAD = z.enum(["alta", "media", "baja"]);
const CONFIANZA = z.enum(["alta", "media", "baja", "exploratoria"]);
const ROL = z.enum(["competidor_directo", "competidor_indirecto", "referente", "aliado", "otro_sector"]);
// Fecha en texto: se admite ISO o lenguaje ("en 12 dias"). Vera escribe para un
// humano, no para un parser.
const FECHA = txt(3, 40);

/** Card de LISTA: el molde repetido de las fichas. */
const fichas = (item, { min = 1, max = 8 } = {}) =>
  z.object({
    type: z.string(),
    items: z.array(item).min(min).max(max),
    evidence: EVIDENCE,
  }).strip();

/* ══════════════════════════════════════════════════════════════════════════
   MI MARCA — la marca contra si misma (prohibido nombrar competencia)
   ══════════════════════════════════════════════════════════════════════════ */

const silencio = fichas(z.object({
  // El tema abandonado por un rival NO vive aqui: eso es Competencia.
  clase: z.enum(["pieza_retirada", "pregunta_sin_respuesta"]),
  quien: opt(txt(1, 80)),
  que: txt(3, 260),
  desde: opt(FECHA),
  lectura: txt(10, 360),
  evidence: EVIDENCE,
}).strip(), { max: 6 });

const latencia = z.object({
  type: z.literal("latencia"),
  dias_promedio: opt(z.number().min(0).max(3650)),
  delta: opt(txt(1, 80)),
  peor: opt(z.object({
    ventana: txt(3, 110),
    se_abrio: opt(FECHA),
    reaccion: opt(txt(1, 40)),      // fecha o "nunca"
    costo: opt(txt(3, 200)),
  }).strip()),
  mejor: opt(z.object({
    ventana: txt(3, 110),
    dias: opt(z.number().min(0).max(3650)),
    que_se_hizo: opt(txt(3, 200)),
  }).strip()),
  markdown: opt(txt(10, 400)),
  evidence: EVIDENCE,
}).strip().refine((c) => c.dias_promedio != null || c.peor, {
  message: "latencia sin cifra ni ventana perdida no dice nada: da al menos dias_promedio o peor",
});

const impacto_vs_ruido = z.object({
  type: z.literal("impacto_vs_ruido"),
  impacto: z.array(z.object({
    que: txt(3, 140), mecanismo: txt(10, 260), evidence: EVIDENCE,
  }).strip()).max(6).default([]),
  ruido: z.array(z.object({
    que: txt(3, 140), por_que_no_mueve: txt(10, 260), evidence: EVIDENCE,
  }).strip()).max(6).default([]),
  // La instruccion es el punto de la card: si de aqui no sale algo que el
  // equipo DEJE de hacer, no se decidio nada.
  dejar_de_hacer: opt(txt(10, 260)),
}).strip().refine((c) => (c.impacto?.length || 0) + (c.ruido?.length || 0) > 0, {
  message: "la card necesita al menos una entrada en impacto o en ruido",
});

const emocion_objetivo = z.object({
  type: z.literal("emocion_objetivo"),
  emocion: z.enum(["urgencia", "deseo", "confianza", "nostalgia", "empoderamiento", "pertenencia", "asombro"]),
  para_quien: txt(3, 110),
  momento: opt(txt(3, 160)),
  que_la_dispara: txt(10, 360),
  cita: opt(txt(3, 240)),
  evidence: EVIDENCE,
}).strip();

const ritmo = z.object({
  type: z.literal("ritmo"),
  rafagas: z.array(z.object({
    cuando: FECHA, piezas: opt(z.number().min(2).max(200)), costo: opt(txt(5, 200)),
  }).strip()).max(8).default([]),
  silencios: z.array(z.object({
    desde: FECHA, hasta: opt(FECHA), ventana_perdida: opt(txt(3, 160)),
  }).strip()).max(8).default([]),
  instruccion: opt(txt(10, 300)),
}).strip().refine((c) => (c.rafagas?.length || 0) + (c.silencios?.length || 0) > 0 || c.instruccion, {
  message: "un ritmo sin rafagas, sin silencios y sin instruccion no es una lectura",
});

const autopsia = z.object({
  type: z.literal("autopsia"),
  pieza: txt(3, 160),
  que_estuvo_bien: opt(txt(5, 260)),
  // Los seis sospechosos del Ritual de la Autopsia (Parte III, Capa 6).
  culpable: z.enum(["mensaje", "emocion", "timing", "formato", "adn", "mi_intuicion"]),
  por_que: txt(20, 700),
  descartados: z.array(z.object({
    sospechoso: txt(2, 30), por_que_no: txt(5, 200),
  }).strip()).max(6).default([]),
  leccion: txt(10, 320),
  evidence: EVIDENCE,
}).strip();

const victoria_explicada = z.object({
  type: z.literal("victoria_explicada"),
  pieza: txt(3, 160),
  mecanismo: txt(20, 500),
  condiciones: z.array(z.object({
    condicion: txt(3, 180), repetible: z.boolean(),
  }).strip()).max(8).default([]),
  // La prueba que separa causa de coincidencia: el rasgo, ¿esta tambien en las
  // que fracasaron? Sin esto una victoria explicada es una anecdota.
  prueba_contraria: opt(txt(10, 300)),
  como_se_repite: txt(10, 320),
  evidence: EVIDENCE,
}).strip();

const causalidad = z.object({
  type: z.literal("causalidad"),
  resultado: txt(5, 200),
  alternativas: z.array(z.object({
    explicacion: txt(3, 200), descartada_porque: opt(txt(5, 220)), evidence: EVIDENCE,
  }).strip()).max(6).default([]),
  veredicto: z.enum(["causa_nuestra", "mezcla", "coincidencia"]),
  confianza: opt(CONFIANZA),
  prueba_propuesta: opt(z.object({
    como: txt(10, 300), mide: opt(txt(2, 110)), dura: opt(txt(2, 80)),
  }).strip()),
}).strip();

/* ══════════════════════════════════════════════════════════════════════════
   COMPETENCIA — los perfiles monitoreados (doctrina de roles innegociable)
   ══════════════════════════════════════════════════════════════════════════ */

const anomalia = fichas(z.object({
  perfil: txt(1, 90),
  rol: ROL,
  antes: txt(3, 200),               // sin el ANTES no hay anomalia, hay actividad
  ahora: txt(3, 200),
  hipotesis: opt(txt(5, 260)),
  veredicto: z.enum(["responder_hoy", "vigilar", "ignorar"]),
  prioridad: opt(PRIORIDAD),
  evidence: EVIDENCE,
}).strip(), { max: 8 });

const error_ajeno = fichas(z.object({
  quien: txt(1, 90),
  rol: ROL,
  que_intento: txt(5, 220),
  evidencia_del_fallo: txt(5, 220),   // observable, no chisme
  causa_raiz: txt(10, 260),
  me_puede_pasar: z.boolean(),
  que_ajusto: txt(5, 220),
  evidence: EVIDENCE,
}).strip(), { max: 6 });



/* ══════════════════════════════════════════════════════════════════════════
   MI MARCA · SALUD DE MARCA — lo que un CMO mira primero de su propia marca:
   disponibilidad mental (en que momentos lo piensan), activos distintivos
   (que codigos son famosos Y suyos), el reparto construir/cosechar y el bucle
   de aprendizaje. Nada de esto es engagement, a proposito: esta medido que
   likes y compartidos casi no predicen si a la marca la recuerdan.
   ══════════════════════════════════════════════════════════════════════════ */

const cobertura_momentos = z.object({
  type: z.literal("cobertura_momentos"),
  momentos: z.array(z.object({
    cep: txt(3, 120),                       // el momento dicho como lo diria una persona
    cobertura: z.number().min(0).max(100),
    cubierto: z.boolean(),
    piezas: opt(z.number().min(0).max(9999)),
  }).strip()).min(2).max(14),
  ventana_dias: opt(z.number().min(1).max(400)),
  nota_metodo: opt(txt(5, 200)),
  evidence: EVIDENCE,
}).strip();

const rejilla_codigos = z.object({
  type: z.literal("rejilla_codigos"),
  activos: z.array(z.object({
    tipo: txt(2, 40),                       // color | tipografia | personaje | formato | frase...
    nombre: txt(2, 90),
    fama: z.number().min(0).max(100),       // cuantos lo ligan a la marca
    unicidad: z.number().min(0).max(100),   // cuantos lo ligan SOLO a la marca
    veces_aplicado: opt(z.number().min(0).max(9999)),
    de_cuantas_piezas: opt(z.number().min(0).max(9999)),
  }).strip()).min(2).max(12),
  umbral: opt(z.number().min(0).max(100)),  // 50 por defecto (Romaniuk)
  // Nuestros dos ejes son consistencia de uso y reconocimiento observado, no la
  // encuesta de Romaniuk. Es una aproximacion honesta y TIENE que decirse.
  nota_metodo: txt(5, 220),
  evidence: EVIDENCE,
}).strip();

const deriva_codigos = z.object({
  type: z.literal("deriva_codigos"),
  fechas: z.array(txt(2, 20)).min(2).max(24),
  series: z.array(z.object({
    codigo: txt(2, 90),
    valores: z.array(z.number().min(0).max(100)).min(2).max(24),
  }).strip()).min(1).max(6),
  destacado: opt(txt(2, 90)),               // el que se apaga: va en color, el resto en gris
  evidence: EVIDENCE,
}).strip().refine((c) => c.series.every((x) => x.valores.length === c.fechas.length), {
  message: "cada codigo necesita un valor por fecha, en el mismo orden",
});

const construir_vs_cosechar = z.object({
  type: z.literal("construir_vs_cosechar"),
  meses: z.array(txt(2, 20)).min(2).max(18),
  construir: z.array(z.number().min(0)).min(2).max(18),
  cosechar: z.array(z.number().min(0)).min(2).max(18),
  vara: opt(z.number().min(0).max(100)),    // 60 por defecto (Binet & Field)
  nota_metodo: txt(5, 200),
  evidence: EVIDENCE,
}).strip().refine((c) => c.construir.length === c.meses.length && c.cosechar.length === c.meses.length, {
  message: "construir y cosechar necesitan un valor por mes, en el mismo orden",
});

const aplauso_vs_propagacion = z.object({
  type: z.literal("aplauso_vs_propagacion"),
  piezas: z.array(z.object({
    titulo: txt(3, 140),
    aplauso: z.number().min(0),
    propagacion: z.number().min(0),
    formato: opt(txt(2, 40)),
  }).strip()).min(3).max(40),
  medianas: opt(z.object({
    aplauso: z.number().min(0), propagacion: z.number().min(0),
  }).strip()),
  // El limite que la card DEBE confesar: esto no mide memoria de marca.
  nota_limite: opt(txt(10, 240)),
  evidence: EVIDENCE,
}).strip();

const penetracion_vs_lealtad = z.object({
  type: z.literal("penetracion_vs_lealtad"),
  meses: z.array(txt(2, 20)).min(3).max(24),
  series: z.array(z.object({
    nombre: txt(2, 60),
    valores: z.array(z.number().min(0)).min(3).max(24),
  }).strip()).length(2),                    // exactamente dos: gente nueva vs los mismos
  base: opt(txt(5, 120)),
  evidence: EVIDENCE,
}).strip().refine((c) => c.series.every((x) => x.valores.length === c.meses.length), {
  message: "cada serie necesita un valor por mes, en el mismo orden",
});

const biblioteca_patrones = z.object({
  type: z.literal("biblioteca_patrones"),
  patrones: z.array(z.object({
    patron: txt(10, 240),
    confirmado: z.number().min(0).max(999),
    // Un patron refutado NO se borra: saber que una creencia fallo vale tanto
    // como la que aguanta.
    refutado: z.number().min(0).max(999),
    confianza: CONFIANZA,
    ultima_prueba: opt(FECHA),
    que_decide: txt(5, 220),                // si no cambia una decision, es trivia
  }).strip()).min(1).max(20),
  evidence: EVIDENCE,
}).strip();

/* ══════════════════════════════════════════════════════════════════════════
   COMPETENCIA · INSTRUMENTOS — la forma la fija el tablero, Vera alimenta la
   serie. Las escalas son FIJAS a proposito: sin escala fija no se puede
   comparar ni entre perfiles ni entre meses, y el instrumento deja de acumular
   historia (se vuelve una foto distinta cada ciclo en vez de un movimiento).
   ══════════════════════════════════════════════════════════════════════════ */

// La nota de metodo es OBLIGATORIA en todo instrumento de juicio: un grafico
// parece una medicion aunque no lo sea, y esa es la forma mas facil de que el
// tablero mienta con cara de rigor.
const NOTA_METODO = txt(5, 200);

const territorio_tematico = z.object({
  type: z.literal("territorio_tematico"),
  temas: z.array(txt(2, 40)).min(2).max(8),      // >8 y el ojo deja de distinguir
  perfiles: z.array(txt(1, 90)).min(1).max(6),
  // celdas[perfil][tema] = 0-100. El 0 es un HALLAZGO (nadie lo cubre), no un hueco.
  celdas: z.array(z.array(z.number().min(0).max(100))).min(1).max(6),
  nota_metodo: NOTA_METODO,
  evidence: EVIDENCE,
}).strip().refine((c) => c.celdas.length === c.perfiles.length
  && c.celdas.every((f) => f.length === c.temas.length), {
  message: "celdas tiene que ser una fila por perfil y una columna por tema, en el mismo orden",
});

const registro_de_voz = z.object({
  type: z.literal("registro_de_voz"),
  tonos: z.array(txt(2, 24)).min(3).max(6),
  perfiles: z.array(z.object({
    perfil: txt(1, 90),
    mezcla: z.array(z.number().min(0).max(100)).min(3).max(6),
  }).strip()).min(1).max(8),
  nota_metodo: NOTA_METODO,
  evidence: EVIDENCE,
}).strip().refine((c) => c.perfiles.every((p) => p.mezcla.length === c.tonos.length), {
  message: "cada perfil reparte sus puntos entre EXACTAMENTE los mismos tonos, en el mismo orden",
});

const emocion_competencia = z.object({
  type: z.literal("emocion_competencia"),
  // Escala con polaridad y un neutro en medio: de eso vive la divergente.
  escala: z.array(txt(2, 24)).min(3).max(7),
  perfiles: z.array(z.object({
    perfil: txt(1, 90),
    valores: z.array(z.number().min(0)).min(3).max(7),
  }).strip()).min(1).max(8),
  nota_metodo: NOTA_METODO,
  evidence: EVIDENCE,
}).strip()
  .refine((c) => c.escala.some((e) => /neutr/i.test(e)), {
    message: "la escala necesita un punto neutro (llamalo 'neutro'): es donde se parte el eje",
  })
  .refine((c) => c.perfiles.every((p) => p.valores.length === c.escala.length), {
    message: "cada perfil da un valor por cada punto de la escala, en el mismo orden",
  });

const busqueda_vs_voz = z.object({
  type: z.literal("busqueda_vs_voz"),
  meses: z.array(txt(2, 20)).min(3).max(24),
  // Dos series INDEXADAS a 100 en el origen. Nunca dos ejes: la alineacion de
  // dos escalas distintas inventa una correlacion que no esta en el dato.
  series: z.array(z.object({
    nombre: txt(2, 40),
    valores: z.array(z.number().min(0)).min(3).max(24),
  }).strip()).min(2).max(3),
  base: opt(txt(5, 120)),
  evidence: EVIDENCE,
}).strip().refine((c) => c.series.every((s) => s.valores.length === c.meses.length), {
  message: "cada serie necesita un valor por mes, en el mismo orden",
});

/* ══ COMPETENCIA · JUICIO (sin grafico a proposito) ═══════════════════════ */

// El veredicto es el campo que faltaba. Un molde cuyo unico campo obligatorio se
// llama "en_que_se_equivoca" ya afirma la conclusion antes de mirar la evidencia:
// si el rival acierta, Vera igual tiene que rellenarlo y termina fabricandole un
// error. "tiene_razon" es una salida legitima — y suele ser la mas util, porque
// obliga a explicar el MECANISMO por el que a el le funciona y a nosotros no.
const VEREDICTO_SUPUESTO = z.enum(["se_equivoca", "tiene_razon", "parcial"]);

const supuesto_punto_ciego = fichas(z.object({
  perfil: txt(1, 90),
  rol: ROL,
  que_cree: txt(10, 300),               // el supuesto en SUS palabras
  veredicto: VEREDICTO_SUPUESTO,
  en_que_acierta: opt(txt(10, 300)),    // obligatorio si tiene_razon o parcial
  en_que_se_equivoca: opt(txt(10, 300)),// obligatorio si se_equivoca o parcial
  evidencia_de_la_grieta: txt(10, 300),
  // El hermano de senal_que_la_desmiente en proxima_movida. El encargo ya pedia
  // en prosa "busca lo que la DESMENTIRIA" y por eso no se cumplia: lo que es
  // campo se cumple, lo que es prosa se evapora.
  que_lo_desmentiria: txt(10, 300),
  como_se_explota: txt(10, 300),
  confianza: CONFIANZA,                 // siempre hipotesis, nunca certeza
  evidence: EVIDENCE,
}).strip().refine(
  (i) => (i.veredicto === "se_equivoca" ? !!i.en_que_se_equivoca
        : i.veredicto === "tiene_razon" ? !!i.en_que_acierta
        : !!i.en_que_acierta && !!i.en_que_se_equivoca),
  { message: "el veredicto manda: se_equivoca exige en_que_se_equivoca, tiene_razon exige en_que_acierta, parcial exige los dos" },
), { max: 6 });

const proxima_movida = fichas(z.object({
  perfil: txt(1, 90),
  movida_probable: txt(10, 240),
  por_que_ahora: txt(10, 300),
  senal_que_la_confirma: txt(5, 240),
  // Sin la señal que la desmiente no es una hipotesis, es un deseo: buscar solo
  // lo que te da la razon es la forma mas comun de equivocarse con confianza.
  senal_que_la_desmiente: txt(5, 240),
  revisar_el: FECHA,
  confianza: CONFIANZA,
  si_ocurre_que_hago: txt(10, 300),
  evidence: EVIDENCE,
}).strip(), { max: 5 });

/* ══════════════════════════════════════════════════════════════════════════
   TENDENCIAS — el mercado (aqui no se audita la cuenta propia)
   ══════════════════════════════════════════════════════════════════════════ */

const pulso_nicho = z.object({
  type: z.literal("pulso_nicho"),
  estado: z.enum(["caliente", "tibio", "frio", "girando"]),
  titular: txt(10, 180),
  numero: opt(txt(1, 40)),
  delta: opt(txt(1, 160)),
  markdown: opt(txt(10, 500)),
  evidence: EVIDENCE,
}).strip();

const senal_debil = fichas(z.object({
  titulo: txt(3, 110),
  que_vi: txt(10, 460),
  por_que_nadie_lo_ve: opt(txt(5, 220)),
  si_es_real: opt(txt(5, 260)),
  ventana: opt(txt(2, 160)),         // el reloj: una señal sin tiempo no se acciona
  fuerza: opt(z.enum(["fuerte", "media", "tenue"])),
  evidence: EVIDENCE,
}).strip(), { max: 6 });

const triangulacion = z.object({
  type: z.literal("triangulacion"),
  nombre_oportunidad: txt(3, 110),
  // Tres señales o no hay triangulacion: con dos es una corazonada con adorno.
  senales: z.array(z.object({
    observacion: txt(5, 360),
    fuente: opt(txt(2, 90)),
    evidence: EVIDENCE,
  }).strip()).min(2).max(6),
  conclusion: txt(15, 500),
  confianza: opt(CONFIANZA),
}).strip();

const tension = fichas(z.object({
  tension: txt(5, 200),
  cita: opt(txt(3, 240)),            // la cita real que la delata
  de_donde: opt(txt(1, 90)),
  por_que_nadie_la_toca: opt(txt(5, 240)),
  que_diria_la_marca: opt(txt(5, 260)),
  evidence: EVIDENCE,
}).strip(), { max: 6 });

/* Propuestas de oportunidad: por cada fecha del calendario, DOS ideas que esta
   marca podria producir. El minimo y el maximo de propuestas son 2 a proposito:
   con una sola parece la unica salida posible y no hay eleccion; con tres o mas
   es un menu que nadie decide. La regla la impone el schema para que no dependa
   de que Vera se acuerde. */
const propuestas_fecha = z.object({
  type: z.literal("propuestas_fecha"),
  fechas: z.array(z.object({
    // El calendario de al lado ya muestra la fecha: aqui viaja solo para
    // parear, por eso `cuando` es texto corto ("7 ago") y no una fecha ISO.
    cuando: txt(2, 40),
    evento: txt(3, 120),
    propuestas: z.array(z.object({
      titulo: txt(4, 120),
      formato: opt(txt(2, 40)),
      idea: txt(15, 420),
      // El permiso de la marca para hablar de esa fecha. Sin esto la propuesta
      // sirve para cualquiera del nicho.
      por_que_esta_marca: txt(10, 300),
      evidence: EVIDENCE,
    }).strip()).length(2),
  }).strip()).min(1).max(4),
}).strip();

/* Algoritmo (Competencia). El gemelo de la card de Mi Marca y a la vez su
   opuesto: alli se lee como el algoritmo trata a la cuenta propia; aqui, que
   esta premiando en los perfiles vigilados. Cada afirmacion exige la PRUEBA
   observada en un perfil concreto — sin eso seria repetir lo que "se dice" de
   cada plataforma, que es justo el ruido del que este tablero protege. */
const algoritmo_rival = z.object({
  type: z.literal("algoritmo_rival"),
  plataformas: z.array(z.object({
    plataforma: txt(2, 30),
    que_premia: txt(15, 320),
    // El perfil y el numero que lo delatan. Obligatorio a proposito.
    prueba: txt(10, 300),
    a_quien_alcanza: opt(txt(5, 220)),
    // Lo unico que convierte la observacion en util: que hace ESTA marca con eso.
    que_me_llevo: txt(10, 280),
    evidence: EVIDENCE,
  }).strip()).min(1).max(5),
  // Lo que se repite en todas las plataformas, si es que se repite.
  patron_transversal: opt(txt(15, 400)),
}).strip();

const lo_que_falta = fichas(z.object({
  hueco: txt(3, 120),
  demanda_observada: txt(5, 200),
  quien_no_lo_cubre: opt(txt(3, 160)),
  angulo_de_la_marca: txt(5, 260),
  intencion_comercial: opt(PRIORIDAD),
  evidence: EVIDENCE,
}).strip(), { max: 6 });


/* ══════════════════════════════════════════════════════════════════════════
   TENDENCIAS · LA DISCIPLINA DE FUTUROS — separar una moda de una tendencia,
   ordenar por horizonte y decidir si a ESTA marca le toca. Sin las tres, una
   lista de tendencias es una revista.
   ══════════════════════════════════════════════════════════════════════════ */

const crecimiento_categoria = z.object({
  type: z.literal("crecimiento_categoria"),
  total_cambio: opt(txt(1, 40)),
  // Las dos mitades de la historia: la marea y el nado. Pueden ser negativas.
  efecto_categoria: z.number(),
  efecto_cuota: z.number(),
  cuota_antes: opt(txt(1, 20)),
  cuota_ahora: opt(txt(1, 20)),
  unidad: opt(txt(2, 60)),          // aqui la unidad es conversacion observada, no ventas
  evidence: EVIDENCE,
}).strip();

const tendencia_o_moda = z.object({
  type: z.literal("tendencia_o_moda"),
  senales: z.array(z.object({
    tema: txt(3, 110),
    serie: z.array(z.number().min(0)).min(2).max(24),
    // Los TRES marcadores, los tres a la vez: colapsarlos en un puntaje destruye
    // el diagnostico. Una senal que pica altisimo en UNA plataforma es una moda.
    semanas_activa: opt(z.number().min(0).max(520)),
    plataformas: z.array(txt(2, 30)).max(8).default([]),
    consistencia: opt(z.enum(["alta", "media", "baja"])),
    veredicto: z.enum(["tendencia", "moda", "pronto_para_saber"]),
    evidence: EVIDENCE,
  }).strip()).min(1).max(10),
  nota_metodo: opt(txt(5, 200)),
}).strip();

const tres_horizontes = z.object({
  type: z.literal("tres_horizontes"),
  h1: z.array(z.object({ senal: txt(3, 130), que_exige: txt(5, 220), cuando: opt(FECHA) }).strip()).max(6).default([]),
  h2: z.array(z.object({ senal: txt(3, 130), que_preparar: txt(5, 220), revisar_el: opt(FECHA) }).strip()).max(6).default([]),
  h3: z.array(z.object({ senal: txt(3, 130), por_que_importa: txt(5, 220) }).strip()).max(6).default([]),
  evidence: EVIDENCE,
}).strip().refine((c) => (c.h1?.length || 0) + (c.h2?.length || 0) + (c.h3?.length || 0) > 0, {
  message: "los tres horizontes vacios no ordenan nada",
}).refine((c) => !((c.h2?.length || 0) === 0 && (c.h3?.length || 0) === 0 && (c.h1?.length || 0) > 2), {
  message: "todo en H1 no es ordenar: si todo se siente urgente, no decidiste horizonte",
});

const derecho_a_jugar = fichas(z.object({
  senal: txt(3, 140),
  autoridad: z.enum(["si", "parcial", "no"]),
  audiencia: z.enum(["si", "parcial", "no"]),
  momento: z.enum(["pronto", "justo", "tarde"]),
  territorio: z.enum(["libre", "disputado", "tomado"]),
  veredicto: z.enum(["tomar", "adaptar", "dejar_pasar"]),
  razon: txt(10, 300),
  evidence: EVIDENCE,
}).strip(), { max: 8 });

const curva_adopcion = z.object({
  type: z.literal("curva_adopcion"),
  senales: z.array(z.object({
    tema: txt(3, 110),
    // innovadores | nicho especializado | mainstream — reparten 100
    mezcla: z.array(z.number().min(0).max(100)).length(3),
  }).strip()).min(1).max(8),
  nota_metodo: txt(5, 200),
  evidence: EVIDENCE,
}).strip();

/* ══════════════════════════════════════════════════════════════════════════
   ESTRATEGIA — la sintesis. El unico tab que cruza los tres mundos.
   ══════════════════════════════════════════════════════════════════════════ */

const decision_del_dia = z.object({
  type: z.literal("decision_del_dia"),
  decision: txt(8, 160),
  por_que: txt(15, 400),
  // Sin costo de inaccion no era la decision de hoy: era una idea.
  costo_de_no_hacerla: txt(8, 300),
  quien: opt(z.enum(["vera", "equipo_humano", "ambos"])),
  horizonte: z.enum(["hoy", "esta_semana", "este_mes"]),
  confianza: opt(CONFIANZA),
  evidence: EVIDENCE,
}).strip();

const autoridad_adn = fichas(z.object({
  senal: txt(3, 160),
  veredicto: z.enum(["tomar", "adaptar", "dejar_pasar"]),
  razon_desde_el_adn: txt(10, 320),
  puerta_de_entrada: opt(txt(5, 240)),
  evidence: EVIDENCE,
}).strip(), { max: 8 });

const puerta_aprobacion = fichas(z.object({
  que: txt(5, 160),
  puerta: z.enum(["publicacion", "crisis", "estrategia", "gasto", "contacto_externo"]),
  espera_desde: opt(FECHA),
  costo_de_esperar: opt(txt(5, 220)),
  estado: opt(z.enum(["vigente", "vence_pronto", "vencido"])),
}).strip(), { max: 8 });

const produccion_viva = z.object({
  type: z.literal("produccion_viva"),
  accion_actual: txt(5, 160),
  en_curso: z.array(z.object({
    pieza: txt(3, 130),
    formato: opt(txt(1, 40)),
    sirve_a: opt(txt(3, 130)),
    estado: opt(z.enum(["investigando", "creando", "verificando", "lista"])),
  }).strip()).max(10).default([]),
  bloqueado: z.array(z.object({
    que: txt(3, 130), por: txt(3, 160), desde: opt(FECHA),
  }).strip()).max(8).default([]),
  proximas: z.array(txt(3, 130)).max(5).default([]),
}).strip();

const pieza_asombro = z.object({
  type: z.literal("pieza_asombro"),
  titulo: txt(5, 120),
  escena: txt(30, 800),             // la escena concreta, no un mood
  formato: txt(2, 60),
  por_que_este_formato: opt(txt(10, 300)),
  copy_semilla: opt(txt(5, 360)),
  emocion: opt(txt(2, 40)),
  por_que_nadie_mas: txt(10, 320),  // si otra marca podria publicarla, no es asombro
  que_necesita: z.array(txt(3, 130)).max(8).default([]),
  evidence: EVIDENCE,
}).strip();

const formato = fichas(z.object({
  idea: txt(3, 130),
  formato: txt(2, 60),
  descartado: opt(txt(2, 60)),      // el formato obvio que se descarta
  por_que_moriria: opt(txt(5, 260)),
  prueba: opt(txt(5, 260)),
  evidence: EVIDENCE,
}).strip(), { max: 6 });

const cadena_portafolio = z.object({
  type: z.literal("cadena_portafolio"),
  eslabones: z.array(z.object({
    pieza: txt(2, 110),
    canal: opt(txt(1, 40)),
    empuja_a: opt(txt(2, 110)),
    estado: opt(z.enum(["existe", "falta"])),
  }).strip()).min(1).max(10),
  roto_en: opt(txt(3, 160)),
  que_se_pierde: opt(txt(5, 260)),
  como_se_arregla: opt(txt(5, 300)),
  evidence: EVIDENCE,
}).strip();

const verificacion = z.object({
  type: z.literal("verificacion"),
  revisadas: opt(z.number().min(0).max(999)),
  corregidas: z.array(z.object({
    pieza: txt(2, 130), que_estaba_mal: txt(5, 220), como_quedo: opt(txt(3, 220)),
  }).strip()).max(12).default([]),
  rechazadas: z.array(z.object({
    pieza: txt(2, 130), por_que: txt(5, 240),
  }).strip()).max(12).default([]),
  markdown: opt(txt(10, 360)),
}).strip();

const brief_humano = fichas(z.object({
  que: txt(5, 160),
  sirve_a: opt(txt(3, 130)),
  con_quien: opt(txt(2, 120)),
  donde: opt(txt(2, 120)),
  pasos: z.array(txt(3, 160)).max(10).default([]),
  antes_de_grabar: z.array(txt(3, 140)).max(8).default([]),
  tiempo: opt(txt(2, 80)),
  no_hacer: opt(txt(5, 200)),
  listo_cuando: opt(txt(5, 200)),
}).strip(), { max: 5 });

const bucle_outcome = z.object({
  type: z.literal("bucle_outcome"),
  tasa_acierto: opt(txt(1, 40)),
  items: z.array(z.object({
    movida: txt(5, 160),
    cuando: opt(FECHA),
    estado: z.enum(["se_hizo", "no_se_hizo", "se_hizo_distinto"]),
    resultado: opt(txt(3, 240)),
    veredicto: opt(z.enum(["acerte", "me_equivoque", "sin_datos"])),
    por_que_no: opt(txt(3, 220)),
    evidence: EVIDENCE,
  }).strip()).min(1).max(12),
  markdown: opt(txt(10, 360)),
}).strip();

/* ══════════════════════════════════════════════════════════════════════════
   LA INTUICION — la unica card que vive en VARIOS tabs, UNA POR TAB.

   POR QUE EXISTE ESTA EXCEPCION: hasta el 2026-07-31 la Intuicion era una sola
   —la de Mi Marca— y el frontend la COPIABA al pie de los otros tres tabs. El
   cliente veia el mismo parrafo cuatro veces, y la unica capa donde Vera dice
   lo que un tablero no puede decir quedaba diciendo lo mismo mires donde mires.
   Ahora cada tab escribe LA SUYA: mismo metodo, sujeto distinto.

   NO ES UNA TEMATICA, ES UNA LENTE. Las demas cards tienen tema asignado; esta
   tiene un METODO: partir de UNA cosa concreta que Vera vio, separar el acierto
   del culpable —sin condenar todo— y terminar en algo que se pueda producir. El
   culpable puede ser el formato, el momento, el encuadre, quien aparece o lo que
   se callo: lo dicta el caso, no el molde.

   LA VARA: si un tablero pudiera decirlo con una cifra, no es intuicion — es una
   etiqueta. Lo que va aqui es el POR QUE que la cifra no trae.

   MI MARCA NO ESTA EN ESTA LISTA a proposito: su Intuicion vive en cards.v2
   (vera-mimarca-cards.schema.js, se escribe con publishMiMarcaCard y ademas
   reparte por periodo). Un mismo concepto con DOS productores es como se llega a
   una card que nadie escribe porque cada uno cree que la escribe el otro.
   ══════════════════════════════════════════════════════════════════════════ */

const intuicion = z.object({
  type: z.literal("intuicion"),
  // El hallazgo en una frase. No el tema: la conclusion.
  titulo: txt(6, 120),
  // De UNA cosa concreta, no del periodo en abstracto: la pieza del rival, la
  // senal del mercado, la decision sobre la mesa. Sin esto es un horoscopo.
  de_donde: txt(10, 320),
  // Lo que el tablero YA muestra de eso. Nombrarlo es lo que obliga a que el
  // resto de la card diga algo distinto.
  lo_obvio: opt(txt(10, 320)),
  // El mecanismo que un humano no ve a simple vista: por que paso lo que paso.
  el_porque: txt(30, 900),
  // Separar el acierto del culpable. Condenarlo todo junto es mas facil de
  // escribir y no le sirve a nadie: se tira lo que estaba bien.
  acierto: opt(txt(5, 320)),
  culpable: opt(txt(5, 320)),
  // La salida ejecutable. Si no termina en algo que se pueda producir, quedo a
  // medias — por audaz que suene el diagnostico.
  que_hago: txt(10, 500),
  confianza: opt(CONFIANZA),
  evidence: EVIDENCE,
}).strip();

/* ══════════════════════════════════════════════════════════════════════════
   SIN TABLERO — hablan de Vera, no de la marca. Se validan igual: el dia que
   exista donde ponerlas, el contrato ya esta.
   ══════════════════════════════════════════════════════════════════════════ */

const recalibracion = z.object({
  type: z.literal("recalibracion"),
  creia: txt(10, 260),
  lo_tumbo: txt(10, 300),
  ahora_creo: txt(10, 300),
  que_hago_distinto: txt(10, 300),
  evidence: EVIDENCE,
}).strip();

const humildad = z.object({
  type: z.literal("humildad"),
  dato_faltante: z.array(z.object({
    que: txt(3, 160), que_decision_cojea: opt(txt(5, 240)), como_se_consigue: opt(txt(5, 240)),
  }).strip()).max(6).default([]),
  afirmacion_fragil: opt(z.object({
    cual: txt(5, 300), por_que_fragil: opt(txt(5, 240)), como_verificarla: opt(txt(5, 240)),
  }).strip()),
  angulo_no_corrido: opt(z.object({
    cual: txt(3, 200), que_podria_esconder: opt(txt(5, 240)),
  }).strip()),
}).strip();

const a2a_readiness = z.object({
  type: z.literal("a2a_readiness"),
  veredicto: z.enum(["invisible", "mencionada", "opcion_logica"]),
  consulta: opt(z.object({
    pregunta: txt(5, 200),
    que_respondio: txt(10, 500),
    aparece: opt(z.boolean()),
    errores: opt(txt(5, 300)),
  }).strip()),
  riqueza_semantica: opt(txt(10, 300)),
  historia_de_relevancia: opt(txt(10, 300)),
  reputacion: opt(txt(10, 300)),
  que_falta: z.array(z.object({
    accion: txt(5, 200), impacto: opt(z.enum(["alto", "medio", "bajo"])),
  }).strip()).max(8).default([]),
  evidence: EVIDENCE,
}).strip();

/* ══════════════════════════════════════════════════════════════════════════
   El reparto. Es contrato, no documentacion.
   ══════════════════════════════════════════════════════════════════════════ */

const CARD = {
  // Mi Marca
  silencio, latencia, impacto_vs_ruido, emocion_objetivo,
  ritmo, autopsia, victoria_explicada, causalidad,
  cobertura_momentos, rejilla_codigos, deriva_codigos, construir_vs_cosechar,
  aplauso_vs_propagacion, penetracion_vs_lealtad, biblioteca_patrones,
  // Competencia
  anomalia, error_ajeno,
  territorio_tematico, registro_de_voz, emocion_competencia, busqueda_vs_voz,
  supuesto_punto_ciego, proxima_movida,
  // Tendencias
  pulso_nicho, senal_debil, triangulacion, tension, propuestas_fecha, lo_que_falta,
  algoritmo_rival,
  crecimiento_categoria, tendencia_o_moda, tres_horizontes, derecho_a_jugar, curva_adopcion,
  // Estrategia
  decision_del_dia, autoridad_adn, puerta_aprobacion, produccion_viva,
  pieza_asombro, formato, cadena_portafolio, verificacion, brief_humano, bucle_outcome,
  // En varios tabs, una por tab
  intuicion,
  // Sin tablero
  recalibracion, humildad, a2a_readiness,
};

/* El reparto: type -> el tab donde vive. `null` = todavia no tiene tablero.
   Un ARRAY = vive en varios, y entonces escribe UNA por tab (hoy solo la
   Intuicion). Nunca significa "la misma card repetida": significa que ese acto
   se hace cuatro veces con cuatro sujetos distintos. */
export const VERA4_TAB = {
  silencio: "mi_marca", latencia: "mi_marca", impacto_vs_ruido: "mi_marca",
  emocion_objetivo: "mi_marca", ritmo: "mi_marca",
  autopsia: "mi_marca", victoria_explicada: "mi_marca", causalidad: "mi_marca",
  cobertura_momentos: "mi_marca", rejilla_codigos: "mi_marca", deriva_codigos: "mi_marca",
  construir_vs_cosechar: "mi_marca", aplauso_vs_propagacion: "mi_marca",
  penetracion_vs_lealtad: "mi_marca", biblioteca_patrones: "mi_marca",
  anomalia: "monitoreo", error_ajeno: "monitoreo",
  territorio_tematico: "monitoreo", registro_de_voz: "monitoreo",
  emocion_competencia: "monitoreo", busqueda_vs_voz: "monitoreo",
  supuesto_punto_ciego: "monitoreo", proxima_movida: "monitoreo",
  pulso_nicho: "tendencias", senal_debil: "tendencias", triangulacion: "tendencias",
  tension: "tendencias", propuestas_fecha: "tendencias", lo_que_falta: "tendencias",
  algoritmo_rival: "monitoreo",
  crecimiento_categoria: "tendencias", tendencia_o_moda: "tendencias",
  tres_horizontes: "tendencias", derecho_a_jugar: "tendencias", curva_adopcion: "tendencias",
  decision_del_dia: "estrategia", autoridad_adn: "estrategia", puerta_aprobacion: "estrategia",
  produccion_viva: "estrategia", pieza_asombro: "estrategia", formato: "estrategia",
  cadena_portafolio: "estrategia", verificacion: "estrategia", brief_humano: "estrategia",
  bucle_outcome: "estrategia",
  // Mi Marca NO esta aqui: su Intuicion es cards.v2 (publishMiMarcaCard) y
  // reparte por periodo. Ver el bloque de la card arriba.
  intuicion: ["monitoreo", "tendencias", "estrategia"],
  recalibracion: null, humildad: null, a2a_readiness: null,
};

export const VERA4_TYPES = Object.keys(CARD);
export const VERA4_SCOPES = ["mi_marca", "monitoreo", "tendencias", "estrategia"];

/** Los tabs donde vive un type, siempre como lista (vacia si no tiene tablero). */
export function tabsDeCard(tipo) {
  const t = VERA4_TAB[String(tipo || "")];
  if (t == null) return [];
  return Array.isArray(t) ? t : [t];
}

/** Si esa card se puede publicar en ese tab. */
export function cardCabeEn(tipo, scope) {
  return tabsDeCard(tipo).includes(String(scope || ""));
}

export const VERA4_TYPES_POR_SCOPE = VERA4_SCOPES.reduce((acc, s) => {
  acc[s] = VERA4_TYPES.filter((t) => cardCabeEn(t, s));
  return acc;
}, {});
export const NOMBRE_TAB_V4 = {
  mi_marca: "Mi Marca", monitoreo: "Competencia",
  tendencias: "Tendencias", estrategia: "Estrategia",
};

/* ── Saneo de forma ──────────────────────────────────────────────────────────
   La leccion que cards.v2 ya pago: una entrega murio por un campo de 161
   caracteres. Un texto unos caracteres mas largo de la cuenta es un defecto de
   FORMA y se recorta; lo que NO se toca es el contenido — si falta un campo
   obligatorio o el valor no es del tipo esperado, la card se rechaza igual y
   Vera la corrige. Medido en el estreno de Tendencias: 3 de 3 rechazos eran
   recortes de una linea, y cada uno le costaba una vuelta de conversacion. */
function _recortar(txtLargo, max) {
  let corte = String(txtLargo).slice(0, max).trimEnd();
  const ultimoEspacio = corte.lastIndexOf(" ");
  // Se corta en palabra, pero solo si no mutila la frase a menos del 60%.
  if (ultimoEspacio > max * 0.6) corte = corte.slice(0, ultimoEspacio).trimEnd();
  return corte.replace(/[,;:\u2014-]$/, "").trimEnd();
}

function _enRuta(raiz, ruta) {
  let n = raiz;
  for (const k of ruta) { if (n == null || typeof n !== "object") return undefined; n = n[k]; }
  return n;
}

function _ponerEnRuta(raiz, ruta, valor) {
  if (!ruta.length) return false;
  let n = raiz;
  for (const k of ruta.slice(0, -1)) { if (n == null || typeof n !== "object") return false; n = n[k]; }
  if (n == null || typeof n !== "object") return false;
  n[ruta[ruta.length - 1]] = valor;
  return true;
}

/** Intenta arreglar SOLO defectos de forma (largo). Devuelve el valor saneado. */
function _sanearForma(molde, valor, pasadas = 3) {
  let v = valor;
  for (let i = 0; i < pasadas; i++) {
    const r = molde.safeParse(v);
    if (r.success) return { ok: true, valor: r.data, saneados: i > 0 };
    let toco = false;
    if (i === 0) v = JSON.parse(JSON.stringify(v));   // copia: el saneo muta
    for (const issue of r.error.issues) {
      if (issue.code !== "too_big") continue;
      const actual = _enRuta(v, issue.path || []);
      const max = Number(issue.maximum);
      if (!Number.isFinite(max) || max <= 0) continue;
      if (typeof actual === "string") {
        toco = _ponerEnRuta(v, issue.path, _recortar(actual, max)) || toco;
      } else if (Array.isArray(actual)) {
        // El orden es suyo: lo que puso primero es lo que mas le importa.
        toco = _ponerEnRuta(v, issue.path, actual.slice(0, max)) || toco;
      }
    }
    if (!toco) break;
  }
  return { ok: false, valor: v };
}

/**
 * Valida UNA card contra su molde. Devuelve {ok, card} o {ok:false, errores}.
 * Se valida de a una a proposito: una card mala no puede tumbar a sus hermanas
 * — es exactamente el fallo que hizo perder lecturas enteras de $0.19 en v2.
 */
export function validarCardV4(card) {
  if (!card || typeof card !== "object" || Array.isArray(card)) {
    return { ok: false, errores: ["(raiz): una card es un objeto {type, ...}"] };
  }
  const tipo = String(card.type || "");
  const molde = CARD[tipo];
  if (!molde) {
    return {
      ok: false,
      errores: [`type: '${tipo || "(vacio)"}' no existe. Validos: ${VERA4_TYPES.join(", ")}`],
    };
  }
  const sano = _sanearForma(molde, card);
  if (sano.ok) {
    return { ok: true, card: { ...sano.valor, type: tipo }, saneada: sano.saneados };
  }
  const r = molde.safeParse(sano.valor);
  if (!r.success) {
    return {
      ok: false,
      errores: r.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`),
    };
  }
  // `type` sobrevive al strip de los moldes de lista, que no lo declaran literal.
  return { ok: true, card: { ...r.data, type: tipo } };
}

/** El tab al que pertenece una card, o null si no vive en ninguno todavia.
    OJO: puede devolver un ARRAY (la Intuicion vive en tres tabs). Para preguntar
    "¿cabe aqui?" usa cardCabeEn, que no tiene que adivinar la forma. */
export function tabDeCard(tipo) {
  return VERA4_TAB[String(tipo || "")] ?? undefined;
}
