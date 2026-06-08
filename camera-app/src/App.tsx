import { useEffect, useRef, useState } from "react";
import "./App.css";

/* Capacitor + ML Kit (Document Scanner) */
import { Capacitor } from "@capacitor/core";
import { DocumentScanner } from "@capacitor-mlkit/document-scanner";
import { Share } from "@capacitor/share";
import { Filesystem, Directory } from "@capacitor/filesystem";

/* ── Tipos ─────────────────────────────────────────────────────────────── */
type Step = "welcome" | "form" | "camera" | "result";
type MultiSelect = Record<string, boolean>;

type ClinicalInfo = {
  name: string;
  age: number | "";
  sintomaPrincipal: string;
  inicio: string;
  desencadenante: string;
  medicacion: "si" | "no" | "";
  antecedentes: MultiSelect;
  otrasCond: MultiSelect;
};

type ApiPrediction = {
  class: string;
  probability: number; // 0..1
};

type ApiResponseShape = {
  prediction: ApiPrediction;
  predictions?: ApiPrediction[];
  margin?: number;
  review?: boolean;
};

/* ── Util ──────────────────────────────────────────────────────────────── */

const todayStr = () => new Date().toLocaleDateString("es-AR", { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/* ── OpenCV "like scanner" helpers para WEB ────────────────────────────── */
/**
 * IMPORTANTE: asegurate de cargar OpenCV.js en index.html
 * <script async src="/opencv/opencv.js"></script>
 */
declare global {
  interface Window { cv: any }
}

/** Espera a que OpenCV.js esté cargado con timeout de 5 segundos */
export async function waitForOpenCV(): Promise<void> {
  if (typeof window === "undefined") return;
  return new Promise<void>((res, rej) => {
    const timeoutId = setTimeout(() => {
      rej(new Error("OpenCV no disponible"));
    }, 5000);
    const check = () => {
      if ((window as any).cv && (window as any).cv.Mat) {
        clearTimeout(timeoutId);
        res();
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });
}

/** Convierte imagen a B/N (grayscale). Si falla, devuelve original. */
export async function enhanceDocumentWithOpenCV(srcDataUrl: string): Promise<string> {
  try {
    await waitForOpenCV();
    const cv = (window as any).cv;

    const img = new Image();
    img.src = srcDataUrl;

    await new Promise<void>((resolve, reject) => {
      img.onload = () => resolve();
      img.onerror = () => reject(new Error("No se pudo cargar imagen"));
      setTimeout(() => reject(new Error("Timeout cargando imagen")), 3000);
    });

    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return srcDataUrl;
    ctx.drawImage(img, 0, 0);

    const src = cv.imread(canvas);
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);

    const blurred = new cv.Mat();
    cv.GaussianBlur(gray, blurred, new cv.Size(3, 3), 0);

    const bin = new cv.Mat();
    cv.adaptiveThreshold(blurred, bin, 255, cv.ADAPTIVE_THRESH_MEAN_C, cv.THRESH_BINARY, 15, 10);

    const outCanvas = document.createElement("canvas");
    outCanvas.width = bin.cols;
    outCanvas.height = bin.rows;
    cv.imshow(outCanvas, bin);
    const result = outCanvas.toDataURL("image/png");

    src.delete();
    gray.delete();
    blurred.delete();
    bin.delete();

    return result;
  } catch (err) {
    console.warn("OpenCV fallo, usando original:", err);
    return srcDataUrl;
  }
}



/* ── Capacitor helpers ─────────────────────────────────────────────────── */
const isNative = Capacitor.isNativePlatform();
const normalizeUri = (uri: string) => (isNative ? Capacitor.convertFileSrc(uri) : uri);

/* ── Opciones para Formularios ─────────────────────────────────────────── */
const SINTOMAS_OPTIONS = [
  { value: "dolor_precordial", label: "Dolor precordial" },
  { value: "palpitaciones", label: "Palpitaciones" },
  { value: "disnea", label: "Disnea" },
  { value: "sincope", label: "Síncope" },
  { value: "mareos", label: "Mareos" },
];

const INICIO_OPTIONS = [
  { value: "subito", label: "Súbito" },
  { value: "progresivo", label: "Progresivo" },
];

const DESENCADENANTE_OPTIONS = [
  { value: "esfuerzo", label: "Con esfuerzo" },
  { value: "reposo", label: "Reposo" },
  { value: "emociones", label: "Emociones" },
  { value: "respiracion", label: "Con respiración" },
];

const ANTECEDENTES_OPTIONS = {
  tabaquista: "Tabaquista",
  enf_coronaria: "Enf. coronaria",
  diabetes: "Diabetes",
  dislipemia: "Dislipemia",
  hta: "Hipertensión (HTA)",
  arritmia: "Arritmia conocida",
};

const OTRAS_COND_OPTIONS = {
  fiebre: "Fiebre",
  anemia: "Anemia / Sangrado activo",
  hipoxia: "Hipoxia",
  sustancias: "Consumo de sustancias",
};

// Íconos para síntomas (Font Awesome)
const SYMPTOM_ICONS: Record<string, string> = {
  dolor_precordial: "fa-solid fa-heart-pulse",
  palpitaciones: "fa-solid fa-wave-square",
  disnea: "fa-solid fa-lungs",
  sincope: "fa-solid fa-brain",
  mareos: "fa-solid fa-arrows-rotate",
};

/* ── App ───────────────────────────────────────────────────────────────── */
export default function App() {
  const [step, setStep] = useState<Step>("welcome");
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  /* ── MÉDICO ───────────────────────────────────────────────────────────── */
  const [doctorName, setDoctorName] = useState<string>("");
  const [doctorError, setDoctorError] = useState<string | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem("doctorName");
    if (saved) setDoctorName(saved);
  }, []);

  const handleEnter = (e: React.FormEvent) => {
    e.preventDefault();
    setDoctorError(null);
    if (!doctorName.trim()) {
      setDoctorError("Datos obligatorios.");
      return;
    }
    localStorage.setItem("doctorName", doctorName.trim());
    setStep("form");
  };

  /* ── FORM PACIENTE (COMPLETO) ─────────────────────────────────────────── */
  const getInitialFormState = (): ClinicalInfo => ({
    name: "",
    age: "",
    sintomaPrincipal: "",
    inicio: "",
    desencadenante: "",
    medicacion: "",
    antecedentes: Object.keys(ANTECEDENTES_OPTIONS).reduce((acc, key) => ({ ...acc, [key]: false }), {} as MultiSelect),
    otrasCond: Object.keys(OTRAS_COND_OPTIONS).reduce((acc, key) => ({ ...acc, [key]: false }), {} as MultiSelect),
  });

  const [form, setForm] = useState<ClinicalInfo>(getInitialFormState());
  const [formStep, setFormStep] = useState<1 | 2 | 3>(1);
  const [formError, setFormError] = useState<string | null>(null);

  const handleMultiSelectChange = (
    category: "antecedentes" | "otrasCond",
    key: string,
    isChecked: boolean
  ) => {
    setForm((f) => ({
      ...f,
      [category]: {
        ...(f as any)[category],
        [key]: isChecked,
      },
    }));
  };

  const handleStartCamera = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!form.name.trim()) {
      setFormError("Nombre requerido."); return;
    }
    if (form.age === "" || Number.isNaN(Number(form.age)) || Number(form.age) <= 0) {
      setFormError("Edad inválida."); return;
    }
    if (!form.sintomaPrincipal) {
      setFormError("Síntoma requerido."); return;
    }
    setStep("camera");
  };

  const resetForm = () => {
    setForm(getInitialFormState());
    setFormStep(1);
  };

  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiResponse, setApiResponse] = useState<ApiResponseShape | null>(null);

  const [serverRisk, setServerRisk] = useState<RiskResult | null>(null);
  const [apiCustomError, setApiCustomError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [showScoreModal, setShowScoreModal] = useState(false);

  /* ── Escaneo y procesamiento de imagen (ROBUSTO, tomado del 1º código) ── */
  const handleScanDocument = async () => {
    if (!isNative || !Capacitor.isPluginAvailable?.("DocumentScanner")) {
      fileInputRef.current?.click();
      return;
    }

    try {
      const result = await DocumentScanner.scanDocument({
        resultFormats: "JPEG",
        pageLimit: 1,
        galleryImportAllowed: true,
        scannerMode: "FULL",
      });

      if (!result?.scannedImages?.length) {
        throw new Error("No se obtuvo ninguna imagen del escaneo");
      }

      try {
        const src = normalizeUri(result.scannedImages[0]);
        const resp = await fetch(src);
        const blob = await resp.blob();
        const reader = new FileReader();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });

        // Usar imagen original (sin procesar con OpenCV)
        setPhotoDataUrl(dataUrl);
        setPreviewUrl(dataUrl);
        setApiResponse(null);
        setApiError(null);
      } catch (err) {
        console.error("Error al escanear:", err);
        setApiError("Error al escanear la imagen");
      }
    } catch (e: any) {
      console.error("Error al escanear:", e);
      const errMsg = e?.message || String(e);
      if (errMsg.toLowerCase().includes("cancel") || errMsg.includes("result code 0")) {
        // Ignorar de forma amigable si el usuario cancela la captura
        return;
      }
      setApiError(errMsg || "No se pudo abrir el escáner");
    }
  };

  const handleFilePick = async (file: File) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setApiError("El archivo debe ser una imagen.");
      return;
    }

    try {
      const dataUrl = await fileToDataUrl(file);
      // Usar imagen original (sin procesar con OpenCV)
      setPhotoDataUrl(dataUrl);
      setPreviewUrl(dataUrl);
      setApiResponse(null);
      setApiError(null);
      if (step !== "camera") setStep("camera");
    } catch (err: any) {
      console.error("Error al cargar imagen:", err);
      setApiError("Error al procesar la imagen");
    }
  };

  const fileToDataUrl = (file: File) =>
    new Promise<string>((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result as string);
      fr.onerror = reject;
      fr.readAsDataURL(file);
    });

  const clearPhoto = () => {
    setPhotoDataUrl(null);
    setPreviewUrl(null);
    setApiResponse(null);
    setApiError(null);
  };

  /* ── Wizard handlers ─────────────────────────────────────────────────── */
  const nextFromBasics = () => {
    setFormError(null);
    if (!form.name.trim()) { setFormError("Nombre requerido."); return; }
    if (form.age === "" || Number.isNaN(Number(form.age)) || Number(form.age) <= 0) {
      setFormError("Edad inválida."); return;
    }
    setFormStep(2);
  };

  const nextFromSymptoms = () => {
    setFormError(null);
    if (!form.sintomaPrincipal) { setFormError("Seleccioná el síntoma."); return; }
    setFormStep(3);
  };

  /* ── Enviar imagen a API y mostrar respuesta (de tu 1º código) ───────── */
  const sendImageToApi = async (): Promise<void> => {
    if (!photoDataUrl) {
      setApiError("No hay imagen para analizar.");
      return;
    }

    // Prioriza la URL pública del backend definida en .env (VITE_API_URL).
    // Si no existe, usamos el backend local en http://localhost:8000 (fallback).
    const API_ANALYZE_URL = import.meta.env.VITE_API_URL
      ? `${String(import.meta.env.VITE_API_URL).replace(/\/+$/, '')}/api/analyze`
      : "http://localhost:8000/api/analyze";

    setApiLoading(true);
    setApiError(null);
    setApiCustomError(null);
    setServerRisk(null);

    try {
      const payload = {
        image: photoDataUrl,
        clinical: form,
        doctor: doctorName,
      };

      const resp = await fetch(API_ANALYZE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(text || `HTTP ${resp.status}`);
      }

      const json = await resp.json();

      const translateClass = (rawCls: string) => {
        if (!rawCls) return "Desconocido";
        const cls = rawCls.trim().toLowerCase();

        if (cls === "normal") return "Normal";
        if (cls === "abnormal_heartbeat" || cls === "abnormal" || cls === "anormal") return "Latido Anormal";
        if (cls === "myocardial infarction" || cls === "mi") return "Infarto de Miocardio";
        if (cls === "history of mi" || cls.includes("history")) return "Antecedente de Infarto";

        // Fallback robusto por si envía solo "Infarction" o variaciones
        if (cls.includes("infarction")) return "Infarto de Miocardio";

        return rawCls;
      };

      // Mapear respuesta del backend al formato esperado
      const mappedApiResponse: ApiResponseShape = {
        prediction: {
          class: translateClass(json.top_class || "Desconocido"),
          probability: json.top_prob ?? 0,
        },
        predictions: json.probs ? Object.entries(json.probs).map(([cls, prob]) => ({
          class: translateClass(cls),
          probability: prob as number,
        })) : undefined,
      };

      // Mapear riesgo del backend
      let parsedLevel = json.risk_level?.toLowerCase() || "error";
      if (parsedLevel === "moderado" || parsedLevel === "moderate") parsedLevel = "medio";

      const mappedRisk: RiskResult = {
        level: parsedLevel as RiskLevel,
        title: json.risk_level || "Resultado",
        description: json.explanation || json.recommendation || "Análisis completado",
        action: json.recommendation || "Consulte con un especialista",
        score: json.score,
        score_breakdown: json.score_breakdown,
      };

      setApiResponse(mappedApiResponse);
      setServerRisk(mappedRisk);
      setStep("result");

    } catch (err: any) {
      console.error("Error al comunicarse con el backend:", err);
      setApiError(err?.message ?? "Error al comunicarse con el servidor");
    } finally {
      setApiLoading(false);
    }
  };

  /* ── 🧠 LÓGICA DE RIESGO COMBINADO (del 2º código) ───────────────────── */
  type RiskLevel = "alto" | "medio" | "bajo" | "error";
  type RiskResult = {
    level: RiskLevel;
    title: string;
    description: string;
    action: string;
    score?: number;
    score_breakdown?: { label: string; pts: number }[];
  };



  // 1. Calcula puntuación de riesgo clínico de forma dinámica
  const getScoreBreakdown = () => {
    let score = 0;
    const items: { label: string; pts: number }[] = [];

    const add = (label: string, pts: number) => {
      if (pts > 0) {
        items.push({ label, pts });
        score += pts;
      }
    };

    // 1. Sintoma Principal
    if (form.sintomaPrincipal === "dolor_precordial") add("Síntoma: Dolor precordial", 3);
    else if (["palpitaciones", "sincope", "disnea"].includes(form.sintomaPrincipal)) {
      add("Síntoma: " + (SINTOMAS_OPTIONS.find(o => o.value === form.sintomaPrincipal)?.label || form.sintomaPrincipal), 2);
    }
    else if (form.sintomaPrincipal === "mareos") {
      add("Síntoma: Mareos", 1);
    }

    // 2. Antecedentes
    if (form.antecedentes.tabaquista) add("Antecedente: Tabaquista", 2);
    if (form.antecedentes.enf_coronaria) add("Antecedente: Enf. coronaria", 3);
    if (form.antecedentes.diabetes) add("Antecedente: Diabetes", 2);
    if (form.antecedentes.dislipemia) add("Antecedente: Dislipemia", 1);
    if (form.antecedentes.hta) add("Antecedente: HTA", 2);
    if (form.antecedentes.arritmia) add("Antecedente: Arritmia", 2);

    // 3. Otras Condiciones
    if (form.otrasCond.fiebre) add("Condición: Fiebre", 1);
    if (form.otrasCond.anemia) add("Condición: Anemia", 2);
    if (form.otrasCond.hipoxia) add("Condición: Hipoxia", 3);
    if (form.otrasCond.sustancias) add("Condición: Sustancias", 2);

    // 4. Medicacion
    if (form.medicacion === "si") add("Medicación Relevante", 1);

    // 5. Inteligencia Artificial (Clase predicha)
    if (apiResponse?.prediction) {
      if (apiResponse.prediction.class === "Infarto de Miocardio") {
        add("IA: Patrón Infarto de Miocardio", Math.round(apiResponse.prediction.probability * 5));
      } else if (apiResponse.prediction.class === "Latido Anormal") {
        add("IA: Patrón Latido Anormal", Math.round(apiResponse.prediction.probability * 3));
      }
    }

    return { score, items };
  };

  const scoreData = serverRisk?.score !== undefined && serverRisk?.score_breakdown !== undefined
    ? { score: serverRisk.score, items: serverRisk.score_breakdown }
    : getScoreBreakdown();
  const riskScore = scoreData.score;

  // 2. Lógica Estricta basada en Tabla de Puntuación
  const getEffectiveRisk = (): RiskResult => {
    if (!apiResponse || !apiResponse.prediction) {
      return {
        level: "error",
        title: "Error de Análisis",
        description: apiCustomError || "No se pudo procesar la imagen del ECG.",
        action: "Por favor, intente escanear nuevamente.",
      };
    }

    const forceAlto = serverRisk?.level === "alto" ||
      (apiResponse.prediction.class === "Infarto de Miocardio" && apiResponse.prediction.probability >= 0.5);

    if (riskScore >= 10 || forceAlto) {
      return {
        level: "alto",
        title: "ALTO RIESGO",
        description: "Score Clínico ≥ 10 o Detección Crítica de IA.",
        action: "Derivar urgente / evaluación urgente según disponibilidad"
      };
    } else if (riskScore >= 5 && riskScore < 10) {
      return {
        level: "medio",
        title: "RIESGO MODERADO",
        description: "Score Clínico entre 5 y 9.",
        action: "Consulta recomendada en corto plazo / control y seguimiento"
      };
    } else {
      return {
        level: "bajo",
        title: "RIESGO BAJO",
        description: "Score Clínico menor a 5.",
        action: "Seguimiento ambulatorio"
      };
    }
  };

  const effectiveRisk = getEffectiveRisk();

  /* ── 📱 LÓGICA WHATSAPP (del 2º código) ──────────────────────────────── */
  const getWhatsAppMessage = () => {
    const antecedentesTxt = Object.entries(form.antecedentes)
      .filter(([, isChecked]) => isChecked)
      .map(([key]) => ANTECEDENTES_OPTIONS[key as keyof typeof ANTECEDENTES_OPTIONS])
      .join(', ');

    const otrasCondTxt = Object.entries(form.otrasCond)
      .filter(([, isChecked]) => isChecked)
      .map(([key]) => OTRAS_COND_OPTIONS[key as keyof typeof OTRAS_COND_OPTIONS])
      .join(', ');

    const message = `
*REPORTE PRELIMINAR ECG*
*Fecha:* ${todayStr()}
*Médico:* ${doctorName}
*Paciente:* ${form.name} (${form.age} años)

*CUADRO CLÍNICO:*
- *Síntoma:* ${SINTOMAS_OPTIONS.find(o => o.value === form.sintomaPrincipal)?.label || 'N/A'}
- *Inicio:* ${INICIO_OPTIONS.find(o => o.value === form.inicio)?.label || 'N/A'}
- *Desencadenante:* ${DESENCADENANTE_OPTIONS.find(o => o.value === form.desencadenante)?.label || 'N/A'}
- *Antecedentes:* ${antecedentesTxt || 'Ninguno'}
- *Otras Cond.:* ${otrasCondTxt || 'Ninguna'}
- *Medicación:* ${form.medicacion.toUpperCase() || 'N/A'}

*ANÁLISIS DE IA:*
- *Clase Predicha:* ${apiResponse?.prediction?.class || 'N/A'}
- *Confianza:* ${apiResponse?.prediction?.probability ? (apiResponse.prediction.probability * 100).toFixed(1) + '%' : 'N/A'}
- *Score Clínico:* ${riskScore.toFixed(1)} pts
- *Resultado:* ${effectiveRisk.title}
- *Recomendación:* ${effectiveRisk.action}

_(Imagen adjunta)_
    `;
    return encodeURIComponent(message.trim());
  };

  const WHATSAPP_NUMBER = "+5493754477472";
  const whatsappUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${getWhatsAppMessage()}`;

  const handleShare = async () => {
    const text = decodeURIComponent(getWhatsAppMessage());

    if (isNative && photoDataUrl) {
      try {
        const base64Data = photoDataUrl.split(',')[1];
        const fileName = `ECG_${form.name.replace(/\s+/g, '_')}_${Date.now()}.png`;

        const result = await Filesystem.writeFile({
          path: fileName,
          data: base64Data,
          directory: Directory.Cache,
        });

        await Share.share({
          title: `Reporte ECG - ${form.name}`,
          text: text,
          url: result.uri,
          dialogTitle: 'Compartir reporte de ECG',
        });
      } catch (err: any) {
        console.error("Error al compartir de forma nativa:", err);
        window.open(whatsappUrl, '_blank');
      }
    } else {
      if (navigator.share && photoDataUrl) {
        try {
          const response = await fetch(photoDataUrl);
          const blob = await response.blob();
          const file = new File([blob], `ECG_${form.name.replace(/\s+/g, '_')}.png`, { type: 'image/png' });

          await navigator.share({
            title: `Reporte ECG - ${form.name}`,
            text: text,
            files: [file]
          });
        } catch (err) {
          console.warn("navigator.share failed, falling back to whatsapp URL:", err);
          window.open(whatsappUrl, '_blank');
        }
      } else {
        window.open(whatsappUrl, '_blank');
      }
    }
  };

  /* Componentes Internos para UI Limpia */
  const AppHeader = () => (
    <header className="app-header">
      <div className="app-brand">
        {/* Usamos un ícono médico como logo placeholder */}
        <i className="fa-solid fa-heart-pulse" style={{ fontSize: 24, color: '#38bdf8' }}></i>
        <span>CardioScan<span style={{ opacity: 0.6 }}>PRO</span></span>
      </div>
      {doctorName && (
        <div className="user-profile">
          <i className="fa-solid fa-user-doctor"></i>
          <span>{doctorName}</span>
        </div>
      )}
    </header>
  );

  return (
    <div className="app">
      {/* Font Awesome */}
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />

      {step !== "welcome" && <AppHeader />}

      <main className="main-content">

        {/* ── PANTALLA 1: Bienvenida / Médico ── */}
        {step === "welcome" && (
          <div style={{ display: "flex", flex: 1, alignItems: "center", justifyContent: "center", flexDirection: 'column' }}>
            <div className="card" style={{ maxWidth: 400, width: "100%", padding: 40, textAlign: 'center' }}>
              <div style={{ marginBottom: 24 }}>
                <i className="fa-solid fa-heart-pulse" style={{ fontSize: 56, color: 'var(--primary)' }}></i>
              </div>
              <h1 style={{ fontSize: '1.5rem', fontWeight: 800, color: 'var(--brand-dark)', margin: '0 0 8px' }}>CardioScan PRO</h1>
              <p className="subtle">Sistema de Análisis de ECG</p>

              <form onSubmit={handleEnter} style={{ marginTop: 32, display: 'flex', flexDirection: 'column', gap: 16 }}>
                <div>
                  <label className="label" htmlFor="doctor" style={{ textAlign: 'left' }}>Identificación Profesional</label>
                  <input
                    id="doctor"
                    className="input"
                    type="text"
                    value={doctorName}
                    onChange={(e) => setDoctorName(e.target.value)}
                    placeholder="Dr./Dra. Nombre Apellido"
                    required
                    autoComplete="name"
                  />
                </div>

                {doctorError && <div style={{ color: 'var(--danger)', fontSize: '0.85rem' }}>{doctorError}</div>}

                <button type="submit" className="btn btn-primary" style={{ width: '100%' }}>
                  Iniciar Sesión
                </button>
              </form>
            </div>
            <div style={{ marginTop: 20, fontSize: '0.8rem', color: 'var(--text-muted)' }}>
              v2.0.1 • Uso Profesional Exclusivo
            </div>
          </div>
        )}

        {/* ── PANTALLA 2: Formulario paciente (WIZARD) ── */}
        {step === "form" && (
          <div className="stack">
            <div className="steps-indicator">
              <div className={`step-item ${formStep >= 1 ? 'active' : ''}`}>
                <div className="step-circle">1</div>
                <span>Datos</span>
              </div>
              <div className={`step-item ${formStep >= 2 ? 'active' : ''}`}>
                <div className="step-circle">2</div>
                <span>Clínica</span>
              </div>
              <div className={`step-item ${formStep >= 3 ? 'active' : ''}`}>
                <div className="step-circle">3</div>
                <span>Antecedentes</span>
              </div>
            </div>

            <form onSubmit={(e) => { e.preventDefault(); if (formStep === 1) nextFromBasics(); else if (formStep === 2) nextFromSymptoms(); else handleStartCamera(e); }} noValidate>

              {/* Paso 1: Datos básicos */}
              {formStep === 1 && (
                <div className="card">
                  <div className="section-header">
                    <i className="fa-solid fa-user-injured" style={{ color: 'var(--primary)' }}></i>
                    <div className="section-title">Identificación de Paciente</div>
                  </div>

                  <div className="stack">
                    <div>
                      <label className="label" htmlFor="name">Nombre Completo</label>
                      <input id="name" className="input" type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Apellido, Nombre" required />
                    </div>

                    <div>
                      <label className="label" htmlFor="age">Edad (Años)</label>
                      <input id="age" className="input" type="number" min={1} max={120} value={form.age} onChange={(e) => setForm((f) => ({ ...f, age: e.target.value === "" ? "" : Number(e.target.value) }))} placeholder="00" required inputMode="numeric" />
                    </div>
                  </div>

                  {formError && <div style={{ color: 'var(--danger)', marginTop: 12, fontSize: '0.9rem' }}>{formError}</div>}

                  <div className="toolbar">
                    <button type="button" className="btn btn-secondary" onClick={() => setStep("welcome")}>Salir</button>
                    <button type="submit" className="btn btn-primary">Siguiente</button>
                  </div>
                </div>
              )}

              {/* Paso 2: Síntoma principal y contexto */}
              {formStep === 2 && (
                <div className="card">
                  <div className="section-header">
                    <i className="fa-solid fa-stethoscope" style={{ color: 'var(--primary)' }}></i>
                    <div className="section-title">Presentación Clínica</div>
                  </div>

                  <div className="stack">
                    <div>
                      <label className="label">Síntoma Cardinal</label>
                      <div className="input" style={{ padding: 0, border: 'none', background: 'transparent', overflowY: 'auto', maxHeight: 200 }}>
                        {SINTOMAS_OPTIONS.map(opt => (
                          <div key={opt.value}
                            style={{
                              padding: '12px', borderBottom: '1px solid var(--border-light)',
                              display: 'flex', alignItems: 'center', gap: 12, cursor: 'pointer',
                              background: form.sintomaPrincipal === opt.value ? 'var(--primary-light)' : 'transparent',
                              color: form.sintomaPrincipal === opt.value ? 'var(--primary)' : 'inherit',
                              fontWeight: form.sintomaPrincipal === opt.value ? 700 : 400
                            }}
                            onClick={() => setForm(f => ({ ...f, sintomaPrincipal: opt.value }))}
                          >
                            <i className={SYMPTOM_ICONS[opt.value]} style={{ width: 20, textAlign: 'center' }}></i>
                            {opt.label}
                            {form.sintomaPrincipal === opt.value && <i className="fa-solid fa-check" style={{ marginLeft: 'auto' }}></i>}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                      <div>
                        <label className="label" htmlFor="inicio">Inicio</label>
                        <select id="inicio" value={form.inicio} onChange={(e) => setForm((f) => ({ ...f, inicio: e.target.value }))}>
                          <option value="">Seleccionar...</option>
                          {INICIO_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="label" htmlFor="desencadenante">Contexto</label>
                        <select id="desencadenante" value={form.desencadenante} onChange={(e) => setForm((f) => ({ ...f, desencadenante: e.target.value }))}>
                          <option value="">Seleccionar...</option>
                          {DESENCADENANTE_OPTIONS.map((opt) => (
                            <option key={opt.value} value={opt.value}>{opt.label}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                  </div>

                  {formError && <div style={{ color: 'var(--danger)', marginTop: 12, fontSize: '0.9rem' }}>{formError}</div>}

                  <div className="toolbar">
                    <button type="button" className="btn btn-secondary" onClick={() => setFormStep(1)}>Atrás</button>
                    <button type="submit" className="btn btn-primary">Siguiente</button>
                  </div>
                </div>
              )}

              {/* Paso 3: Factores de riesgo */}
              {formStep === 3 && (
                <div className="card">
                  <div className="section-header">
                    <i className="fa-solid fa-file-medical" style={{ color: 'var(--primary)' }}></i>
                    <div className="section-title">Antecedentes y Factores</div>
                  </div>

                  <div className="stack">
                    <div>
                      <label className="label">Comorbilidades</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        {Object.entries(ANTECEDENTES_OPTIONS).map(([key, label]) => (
                          <div key={key}
                            onClick={() => handleMultiSelectChange("antecedentes", key, !form.antecedentes[key])}
                            style={{
                              padding: '8px 12px', borderRadius: 4, cursor: 'pointer', fontSize: '0.85rem',
                              border: form.antecedentes[key] ? '1px solid var(--primary)' : '1px solid var(--border)',
                              background: form.antecedentes[key] ? 'var(--primary-light)' : 'white',
                              color: form.antecedentes[key] ? 'var(--primary-dark)' : 'var(--text-muted)'
                            }}
                          >
                            {label}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="label">Signos Vitales / Condiciones</label>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        {Object.entries(OTRAS_COND_OPTIONS).map(([key, label]) => (
                          <div key={key}
                            onClick={() => handleMultiSelectChange("otrasCond", key, !form.otrasCond[key])}
                            style={{
                              padding: '8px 12px', borderRadius: 4, cursor: 'pointer', fontSize: '0.85rem',
                              border: form.otrasCond[key] ? '1px solid var(--primary)' : '1px solid var(--border)',
                              background: form.otrasCond[key] ? 'var(--primary-light)' : 'white',
                              color: form.otrasCond[key] ? 'var(--primary-dark)' : 'var(--text-muted)'
                            }}
                          >
                            {label}
                          </div>
                        ))}
                      </div>
                    </div>

                    <div>
                      <label className="label">Medicación Relevante</label>
                      <div className="segmented-control">
                        <div className={`segment-opt ${form.medicacion === 'si' ? 'active' : ''}`} onClick={() => setForm(f => ({ ...f, medicacion: 'si' }))}>Sí</div>
                        <div className={`segment-opt ${form.medicacion === 'no' ? 'active' : ''}`} onClick={() => setForm(f => ({ ...f, medicacion: 'no' }))}>No</div>
                      </div>
                    </div>
                  </div>

                  {formError && <div style={{ color: 'var(--danger)', marginTop: 12, fontSize: '0.9rem' }}>{formError}</div>}

                  <div className="toolbar">
                    <button type="button" className="btn btn-secondary" onClick={() => setFormStep(2)}>Atrás</button>
                    <button type="submit" className="btn btn-primary">
                      <i className="fa-solid fa-camera" style={{ marginRight: 8 }}></i>
                      Capturar ECG
                    </button>
                  </div>
                </div>
              )}
            </form>
          </div>
        )}

        {/* ── PANTALLA 3: Escaneo de ECG ── */}
        {step === "camera" && (
          <div className="scan-screen">
            {/* Header con info del paciente */}
            <div className="scan-patient-bar">
              <i className="fa-solid fa-user-injured"></i>
              <span>{form.name} • {form.age} años</span>
            </div>

            {/* Área principal de escaneo */}
            <div className="scan-area">
              {photoDataUrl ? (
                <div className="scan-preview-container">
                  <img src={previewUrl || ""} className="scan-preview-img" alt="ECG capturado" />
                  <div className="scan-preview-badge">
                    <i className="fa-solid fa-check-circle"></i> Imagen capturada
                  </div>
                </div>
              ) : (
                <div className="scan-placeholder">
                  <div className="scan-frame">
                    <div className="scan-corner scan-corner-tl"></div>
                    <div className="scan-corner scan-corner-tr"></div>
                    <div className="scan-corner scan-corner-bl"></div>
                    <div className="scan-corner scan-corner-br"></div>
                    <div className="scan-line-anim"></div>
                  </div>
                  <div className="scan-instructions">
                    <div className="scan-icon-pulse">
                      <i className="fa-solid fa-camera-retro"></i>
                    </div>
                    <h3>Escanear ECG</h3>
                    <p>Alinee el trazado del electrocardiograma dentro del recuadro y presione <strong>Capturar</strong></p>
                  </div>
                </div>
              )}
            </div>

            {/* Botones de acción */}
            <div className="scan-actions">
              {!photoDataUrl ? (
                <>
                  <button onClick={handleScanDocument} className="scan-btn-capture">
                    <i className="fa-solid fa-camera"></i>
                    <span>Capturar ECG</span>
                  </button>

                  {(!isNative || !Capacitor.isPluginAvailable?.("DocumentScanner")) && (
                    <label className="scan-btn-upload">
                      <i className="fa-solid fa-image"></i>
                      <span>Galería</span>
                      <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => {
                        const file = e.target.files?.[0]; if (file) handleFilePick(file); e.currentTarget.value = "";
                      }} />
                    </label>
                  )}
                </>
              ) : (
                <>
                  <button onClick={sendImageToApi} className="scan-btn-analyze" disabled={apiLoading}>
                    {apiLoading ? (
                      <><i className="fa-solid fa-spinner fa-spin"></i><span>Analizando...</span></>
                    ) : (
                      <><i className="fa-solid fa-microscope"></i><span>Analizar ECG</span></>
                    )}
                  </button>
                  <button onClick={clearPhoto} className="scan-btn-retry" disabled={apiLoading}>
                    <i className="fa-solid fa-rotate-right"></i>
                    <span>Reintentar</span>
                  </button>
                </>
              )}
            </div>

            <button onClick={() => setStep("form")} className="scan-btn-cancel" disabled={apiLoading}>
              <i className="fa-solid fa-arrow-left" style={{ marginRight: 8 }}></i>
              Volver al formulario
            </button>

            {apiError && <div className="scan-error"><i className="fa-solid fa-circle-exclamation"></i> {apiError}</div>}
          </div>
        )}

        {/* ── PANTALLA 4: Resultado (LAB REPORT STYLE) ── */}
        {step === "result" && (
          <div className="stack">

            <div className={`premium-report-card level-${effectiveRisk.level}`}>
              {/* Disclaimer Prominente */}
              <div className="premium-disclaimer">
                <i className="fa-solid fa-triangle-exclamation"></i>
                <span><strong>Herramienta de apoyo diagnóstico</strong> · No reemplaza la evaluación médica</span>
              </div>

              <header className="premium-report-header">
                <div className="premium-header-logo">
                  <div className="premium-header-logo-icon">
                    <i className="fa-solid fa-file-medical-alt"></i>
                  </div>
                  <div>
                    <h2>Reporte Clínico</h2>
                    <p>Fecha de emisión: {todayStr()}</p>
                  </div>
                </div>
                <div className="premium-patient-id">
                  ID: PAC-{Math.floor(1000 + Math.random() * 9000)}
                </div>
              </header>

              <div className="premium-report-body">
                {/* Clase Ganadora */}
                <div className="premium-section premium-hero-result">
                  <div className="premium-label" style={{ justifyContent: 'center' }}>
                    <i className="fa-solid fa-microscope"></i> Patrón Compatible
                  </div>
                  <div className="premium-diagnosis-title">
                    {apiResponse?.prediction?.class || 'No determinado'}
                  </div>
                  <div className="premium-diagnosis-subtitle" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '12px', marginTop: '12px' }}>
                    <span>Análisis algorítmico de trazado</span>
                    {apiResponse?.prediction?.probability !== undefined && (
                      <span style={{
                        background: '#e0f2fe',
                        color: '#0284c7',
                        padding: '4px 10px',
                        borderRadius: '999px',
                        fontWeight: 700,
                        fontSize: '0.85rem'
                      }}>
                        Certeza: {(apiResponse.prediction.probability * 100).toFixed(1)}%
                      </span>
                    )}
                  </div>
                </div>

                {/* Grilla de Métricas (Riesgo y Score) */}
                <div className="premium-metrics-grid">
                  <div className="premium-metric-card">
                    <div className="premium-label" style={{ justifyContent: 'center' }}>Nivel de Riesgo Global</div>
                    <div className={`premium-risk-badge badge-${effectiveRisk.level}`}>
                      {effectiveRisk.level === 'alto' && <><i className="fa-solid fa-circle-exclamation"></i> ALTO</>}
                      {effectiveRisk.level === 'medio' && <><i className="fa-solid fa-triangle-exclamation"></i> MODERADO</>}
                      {effectiveRisk.level === 'bajo' && <><i className="fa-solid fa-circle-check"></i> BAJO</>}
                      {effectiveRisk.level === 'error' && <><i className="fa-solid fa-circle-xmark"></i> ERROR</>}
                    </div>
                  </div>

                  <div className="premium-metric-card clickable-card" onClick={() => setShowScoreModal(true)} style={{ cursor: 'pointer', position: 'relative' }}>
                    <div className="premium-label" style={{ justifyContent: 'center' }}>
                      Score Clínico Total
                      <i className="fa-solid fa-circle-info" style={{ marginLeft: 6, opacity: 0.6 }}></i>
                    </div>
                    <div className="premium-score-value">
                      <span className="score-number">{riskScore.toFixed(1)}</span>
                      <span className="score-unit">pts</span>
                    </div>
                  </div>
                </div>

                {/* Modal de Desglose de Score */}
                {showScoreModal && (
                  <div className="score-modal-overlay" onClick={() => setShowScoreModal(false)}>
                    <div className="score-modal-content" onClick={e => e.stopPropagation()}>
                      <div className="score-modal-header">
                        <h3>Detalle del Score Clínico</h3>
                        <button onClick={() => setShowScoreModal(false)} className="score-modal-close">
                          <i className="fa-solid fa-xmark"></i>
                        </button>
                      </div>
                      <div className="score-modal-body">
                        {scoreData.items.length === 0 ? (
                          <div style={{ textAlign: 'center', padding: '20px', color: 'var(--text-muted)' }}>No hay puntos asignados.</div>
                        ) : (
                          <div className="score-breakdown-list">
                            {scoreData.items.map((item, idx) => (
                              <div key={idx} className="score-breakdown-item">
                                <span>{item.label}</span>
                                <strong>+{item.pts} pts</strong>
                              </div>
                            ))}
                          </div>
                        )}
                        <div className="score-breakdown-total">
                          <span>Total Puntos</span>
                          <span>{riskScore} pts</span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* Plan Sugerido */}
                <div className={`premium-plan plan-${effectiveRisk.level}`}>
                  <div className="premium-label">
                    <i className="fa-solid fa-notes-medical"></i> Plan Sugerido
                  </div>
                  <div className="premium-plan-content">
                    <i className="fa-solid fa-user-doctor"></i>
                    <p>{effectiveRisk.action}</p>
                  </div>
                </div>
              </div>

              <footer className="premium-report-footer">
                <div>
                  Validado por: <strong>{doctorName}</strong> (Licencia: PRO-2026)
                </div>
                <div>
                  Paciente: <strong>{form.name}</strong> - v1.0.4
                </div>
              </footer>
            </div>

            <div className="toolbar" style={{ flexWrap: 'wrap' }}>
              <button onClick={handleShare} className="btn btn-primary">
                <i className="fa-brands fa-whatsapp" style={{ marginRight: 8 }}></i>
                Compartir por WhatsApp
              </button>
              <button
                onClick={() => { clearPhoto(); setStep("camera"); }}
                className="btn btn-secondary"
              >
                <i className="fa-solid fa-camera-rotate" style={{ marginRight: 8 }}></i>
                Re-escanear ECG
              </button>
              <button
                onClick={() => { clearPhoto(); setStep("welcome"); resetForm(); }}
                className="btn btn-secondary"
              >
                Nuevo Análisis
              </button>
            </div>

          </div>
        )}
      </main>
    </div>
  );
}
