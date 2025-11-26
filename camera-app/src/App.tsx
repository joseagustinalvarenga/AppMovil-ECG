import { useEffect, useRef, useState } from "react";
import "./App.css";

/* Capacitor + ML Kit (Document Scanner) */
import { Capacitor } from "@capacitor/core";
import { DocumentScanner } from "@capacitor-mlkit/document-scanner";

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
const pct = (p?: number) =>
  typeof p === "number" ? (p * 100).toFixed(1) + "%" : "—";

/* ── OpenCV "like scanner" helpers para WEB ────────────────────────────── */
/**
 * IMPORTANTE: asegurate de cargar OpenCV.js en index.html
 * <script async src="/opencv/opencv.js"></script>
 */
declare global {
  interface Window { cv: any }
}

/** Espera a que OpenCV.js esté cargado con timeout de 5 segundos */
async function waitForOpenCV(): Promise<void> {
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
async function enhanceDocumentWithOpenCV(srcDataUrl: string): Promise<string> {
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
  { value: "dolor_precordial", label: "Dolor pre cordial" },
  { value: "palpitaciones", label: "Palpitaciones" },
  { value: "disnea", label: "Disnea" },
  { value: "sincope", label: "Síncope" },
  { value: "mareos", label: "Mareos" },
  { value: "otros", label: "Otros" },
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
  { value: "otro", label: "Otro" },
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
const SYMPTOM_ICONS: Record<string,string> = {
  dolor_precordial: "fa-solid fa-heart-pulse",
  palpitaciones: "fa-solid fa-wave-square",
  disnea: "fa-solid fa-lungs",
  sincope: "fa-solid fa-brain",
  mareos: "fa-solid fa-arrows-rotate",
  otros: "fa-solid fa-plus",
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
      setDoctorError("Ingresá tu nombre para continuar.");
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
  const [formStep, setFormStep] = useState<1|2|3>(1);
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
      setFormError("El nombre del paciente es obligatorio."); return;
    }
    if (form.age === "" || Number.isNaN(Number(form.age)) || Number(form.age) <= 0) {
      setFormError("La edad debe ser un número válido mayor a 0."); return;
    }
    if (!form.sintomaPrincipal) {
      setFormError("El síntoma principal es obligatorio."); return;
    }
    setStep("camera");
  };
  
  const resetForm = () => {
    setForm(getInitialFormState());
  };

  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiResponse, setApiResponse] = useState<ApiResponseShape | null>(null);

  const [serverRisk, setServerRisk] = useState<RiskResult | null>(null);
  const [apiCustomError, setApiCustomError] = useState<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

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

        // Procesar imagen con OpenCV (B/N)
        const processedImage = await enhanceDocumentWithOpenCV(dataUrl);
        setPhotoDataUrl(processedImage);
        setPreviewUrl(processedImage);
        setApiResponse(null);
        setApiError(null);
      } catch (err) {
        console.error("Error al escanear:", err);
        setApiError("Error al escanear la imagen");
      }
    } catch (e: any) {
      console.error("Error al escanear:", e);
      setApiError(e?.message ?? "No se pudo abrir el escáner");
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
      // Procesar imagen con OpenCV (B/N)
      const processedImage = await enhanceDocumentWithOpenCV(dataUrl);
      setPhotoDataUrl(processedImage);
      setPreviewUrl(processedImage);
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
    if (!form.name.trim()) { setFormError("El nombre del paciente es obligatorio."); return; }
    if (form.age === "" || Number.isNaN(Number(form.age)) || Number(form.age) <= 0) {
      setFormError("La edad debe ser un número válido mayor a 0."); return; }
    setFormStep(2);
  };

  const nextFromSymptoms = () => {
    setFormError(null);
    if (!form.sintomaPrincipal) { setFormError("Seleccioná el síntoma principal."); return; }
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
      ? `${String(import.meta.env.VITE_API_URL).replace(/\/+$/,'')}/api/analyze`
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

      // Mapear respuesta del backend al formato esperado
      const mappedApiResponse: ApiResponseShape = {
        prediction: {
          class: json.top_class || "Desconocido",
          probability: json.top_prob ?? 0,
        },
        predictions: json.probs ? Object.entries(json.probs).map(([cls, prob]) => ({
          class: cls,
          probability: prob as number,
        })) : undefined,
      };

      // Mapear riesgo del backend
      const mappedRisk: RiskResult = {
        level: (json.risk_level?.toLowerCase() || "error") as RiskLevel,
        title: json.risk_level || "Resultado",
        description: json.explanation || json.recommendation || "Análisis completado",
        action: json.recommendation || "Consulte con un especialista",
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
  };

  const calculateCombinedRisk = (
    apiResp: ApiResponseShape | null,
    clinicalData: ClinicalInfo
  ): RiskResult => {
    if (!apiResp || !apiResp.prediction) {
      return {
        level: "error",
        title: "Error de Análisis",
        description: apiCustomError || "No se pudo procesar la imagen del ECG.",
        action: "Por favor, intente escanear nuevamente.",
      };
    }
    const { prediction } = apiResp;
    const { antecedentes, sintomaPrincipal } = clinicalData;

    // REGLA 1: ALTO RIESGO
    if (prediction.class === "MI" && prediction.probability > 0.8) {
      return {
        level: "alto",
        title: "ALTO RIESGO DETECTADO",
        description: "El modelo detecta patrones consistentes con Infarto de Miocardio (MI) con alta confianza.",
        action: "Se recomienda derivación urgente a cardiología.",
      };
    }
    if (prediction.class === "Anormal" && antecedentes.tabaquista && sintomaPrincipal === "dolor_precordial") {
      return {
        level: "alto",
        title: "ALTO RIESGO POR CLÍNICA",
        description: "El modelo detecta anomalías en un paciente con factores de riesgo clave (tabaquista, dolor precordial).",
        action: "Se recomienda derivación urgente a cardiología.",
      };
    }
    // REGLA 2: RIESGO MEDIO
    if (prediction.class === "Anormal" || apiResp.review === true) {
      return {
        level: "medio",
        title: "REVISIÓN SUGERIDA",
        description: "El modelo detecta patrones anómalos no específicos o el resultado es inconcluso.",
        action: "Se sugiere derivar a cardiología para un análisis completo.",
      };
    }
    // REGLA 3: BAJO RIESGO
    if (prediction.class === "Normal" && prediction.probability > 0.7) {
      return {
        level: "bajo",
        title: "PROBABLE NORMALIDAD",
        description: "El modelo no detecta anomalías significativas.",
        action: "Confirmar el diagnóstico con la evaluación clínica completa.",
      };
    }
    // Fallback
    return {
      level: "medio",
      title: "REVISIÓN SUGERIDA",
      description: "El resultado del modelo es inconcluso. Se recomienda evaluación manual.",
      action: "Se sugiere derivar a cardiología si la clínica lo justifica.",
    };
  };

  // Si el backend retorna el riesgo completo, lo usamos; si no, fallback a la lógica local.
  const effectiveRisk = serverRisk ?? calculateCombinedRisk(apiResponse, form);

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
*PRE-DIAGNÓSTICO ECG*
*Médico:* ${doctorName}
*Paciente:* ${form.name} (${form.age} años)

*Datos Clínicos:*
- *Síntoma:* ${SINTOMAS_OPTIONS.find(o => o.value === form.sintomaPrincipal)?.label || 'N/A'}
- *Inicio:* ${INICIO_OPTIONS.find(o => o.value === form.inicio)?.label || 'N/A'}
- *Desencadenante:* ${DESENCADENANTE_OPTIONS.find(o => o.value === form.desencadenante)?.label || 'N/A'}
- *Antecedentes:* ${antecedentesTxt || 'Ninguno'}
- *Otras Cond.:* ${otrasCondTxt || 'Ninguna'}
- *Medicación:* ${form.medicacion.toUpperCase() || 'N/A'}

*Resultado de la App:*
- *Nivel de Riesgo:* ${effectiveRisk.title}
- *Acción Sugerida:* ${effectiveRisk.action}

_(Se adjunta imagen del ECG)_
    `;
    return encodeURIComponent(message.trim());
  };
  
  const WHATSAPP_NUMBER = "+5493754477472"; 
  const whatsappUrl = `https://wa.me/${WHATSAPP_NUMBER}?text=${getWhatsAppMessage()}`;


  return (
    <div className="app">
      {/* Font Awesome for medical-styled icons */}
      <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" />
      <style>{`
        .urgent-banner { display:flex; align-items:center; gap:12px; background: linear-gradient(90deg,#7f1d1d,#dc2626); color:#fff; padding:16px; border-radius:12px; border:2px solid #ef4444; animation: urgentPulse 1.5s infinite; }
        .urgent-banner__icon { font-size:28px; }
        .urgent-banner__body { display:flex; flex-direction:column; }
        .urgent-banner__title { font-weight:800; letter-spacing:.5px; font-size:18px; line-height:1.1; }
        .urgent-banner__subtitle { font-size:14px; opacity:.95; margin-top:2px; }
        @keyframes urgentPulse { 0%{box-shadow:0 0 0 0 rgba(220,38,38,.7)} 70%{box-shadow:0 0 0 14px rgba(220,38,38,0)} 100%{box-shadow:0 0 0 0 rgba(220,38,38,0)} }
        .btn-urgent { background:#b91c1c; border:2px solid #ef4444; color:#fff !important; animation: urgentPulse 1.5s infinite; }
        .risk-card[data-level="alto"] { border:2px solid #ef4444; }

        /* Wizard styles */
        .stepper { display:flex; gap:8px; margin-bottom:12px; }
        .step-dot { width:10px; height:10px; border-radius:999px; background:#e5e7eb; }
        .step-dot.active { background:#2563eb; }
        .section-title { font-weight:700; font-size:18px; margin:4px 0 8px; }

        /* Symptom cards grid */
        .symptom-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; }
        @media (min-width:420px){ .symptom-grid{ grid-template-columns:repeat(3,minmax(0,1fr)); } }
        .symptom-card {
          display:flex;
          flex-direction:column;
          align-items:flex-start;
          gap:6px;
          padding:14px;
          border:2px solid #ffffff;
          border-radius:14px;
          background:#0d1b4f;
          cursor:pointer;
          user-select:none;
          color:#ffffff !important;
        }
        .symptom-card i { font-size:18px; opacity:.9; }
        .symptom-card .label { font-size:14px; font-weight:600; }
        .symptom-card.active {
          border-color:#60a5fa;
          background:#1e3a8a;
          color:#ffffff !important;
        }
        .controls-row { display:flex; gap:10px; }
      `}</style>
      <style>{`
        .urgent-banner { display:flex; align-items:center; gap:12px; background: linear-gradient(90deg,#7f1d1d,#dc2626); color:#fff; padding:16px; border-radius:12px; border:2px solid #ef4444; animation: urgentPulse 1.5s infinite; }
        .urgent-banner__icon { font-size:28px; }
        .urgent-banner__body { display:flex; flex-direction:column; }
        .urgent-banner__title { font-weight:800; letter-spacing:.5px; font-size:18px; line-height:1.1; }
        .urgent-banner__subtitle { font-size:14px; opacity:.95; margin-top:2px; }
        @keyframes urgentPulse { 0%{box-shadow:0 0 0 0 rgba(220,38,38,.7)} 70%{box-shadow:0 0 0 14px rgba(220,38,38,0)} 100%{box-shadow:0 0 0 0 rgba(220,38,38,0)} }
        .btn-urgent { background:#b91c1c; border:2px solid #ef4444; color:#fff !important; animation: urgentPulse 1.5s infinite; }
        .risk-card[data-level="alto"] { border:2px solid #ef4444; }
      `}</style>
      {/* ── PANTALLA 1: Bienvenida / Médico ── */}
      {step === "welcome" && (
        <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="card card--elevated" style={{ textAlign: "center", padding: "32px 24px", maxWidth: 400, width: "100%" }}>
            <img src="/logo.png" alt="Logo" style={{ width: 96, height: 96, objectFit: "contain", margin: "0 auto 16px", display: "block" }} />
            <h1 className="h1">Ingreso del médico</h1>
            <p className="subtle" style={{ marginTop: 4 }}>Ingresá tu nombre para continuar.</p>
            <form onSubmit={handleEnter} className="form" style={{ marginTop: 16 }}>
              <div className="field">
                <label className="label" htmlFor="doctor">Nombre del médico</label>
                <input id="doctor" className="input" type="text" value={doctorName} onChange={(e) => setDoctorName(e.target.value)} placeholder="Ej: Dra. María González" required autoComplete="name" />
              </div>
              {doctorError && <p className="error" role="alert">{doctorError}</p>}
              <div className="toolbar" style={{ justifyContent: "center" }}>
                <button type="submit" className="btn btn-primary">Ingresar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── PANTALLA 2: Formulario paciente (COMPLETO) ── */}
      {step === "form" && (
        <div className="stack formPage full-viewport">
          <h1 className="h1">Información clínica del paciente</h1>
          <div className="subtle" style={{ marginBottom: 4 }}>
            Médico: <strong>{doctorName || "—"}</strong>
          </div>

          <form className="card form card--elevated formCard" onSubmit={(e)=>{e.preventDefault(); if(formStep===1) nextFromBasics(); else if(formStep===2) nextFromSymptoms(); else handleStartCamera(e);}} noValidate>
            {/* Stepper */}
            <div className="stepper" aria-hidden>
              <div className={`step-dot ${formStep===1?"active":""}`}></div>
              <div className={`step-dot ${formStep===2?"active":""}`}></div>
              <div className={`step-dot ${formStep===3?"active":""}`}></div>
            </div>

            {/* Paso 1: Datos básicos */}
            {formStep===1 && (
              <div className="stack">
                <div className="section-title">Datos básicos</div>
                <div className="row-fields">
                  <div className="field" style={{ flex: 2 }}>
                    <label className="label" htmlFor="name">Nombre del paciente</label>
                    <input id="name" className="input" type="text" value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} placeholder="Ej: Juan Pérez" required />
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="label" htmlFor="age">Edad</label>
                    <input id="age" className="input" type="number" min={1} max={120} value={form.age} onChange={(e) => setForm((f) => ({ ...f, age: e.target.value === "" ? "" : Number(e.target.value) }))} placeholder="Ej: 45" required inputMode="numeric" />
                  </div>
                </div>
                {formError && <p className="error" role="alert">{formError}</p>}
                <div className="toolbar">
                  <button type="submit" className="btn btn-primary">Continuar →</button>
                  <button type="button" className="btn btn-ghost" onClick={() => setStep("welcome")}>
                    ← Cambiar médico
                  </button>
                </div>
              </div>
            )}

            {/* Paso 2: Síntoma principal y contexto */}
            {formStep===2 && (
              <div className="stack">
                <div className="section-title">Síntoma principal</div>
                <div className="symptom-grid">
                  {SINTOMAS_OPTIONS.map(opt => (
                    <button type="button" key={opt.value}
                      className={`symptom-card ${form.sintomaPrincipal===opt.value?"active":""}`}
                      onClick={()=> setForm(f=>({ ...f, sintomaPrincipal: opt.value }))}
                      aria-pressed={form.sintomaPrincipal===opt.value}
                    >
                      <i className={SYMPTOM_ICONS[opt.value]} aria-hidden></i>
                      <span className="label">{opt.label}</span>
                    </button>
                  ))}
                </div>

                <div className="controls-row">
                  <div className="field" style={{ flex: 1 }}>
                    <label className="label" htmlFor="inicio">Inicio</label>
                    <select id="inicio" className="input" value={form.inicio} onChange={(e) => setForm((f) => ({ ...f, inicio: e.target.value }))}>
                      <option value="">Seleccionar...</option>
                      {INICIO_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                  <div className="field" style={{ flex: 1 }}>
                    <label className="label" htmlFor="desencadenante">Desencadenante</label>
                    <select id="desencadenante" className="input" value={form.desencadenante} onChange={(e) => setForm((f) => ({ ...f, desencadenante: e.target.value }))}>
                      <option value="">Seleccionar...</option>
                      {DESENCADENANTE_OPTIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </div>
                </div>

                {formError && <p className="error" role="alert">{formError}</p>}
                <div className="toolbar">
                  <button type="button" className="btn btn-ghost" onClick={()=> setFormStep(1)}>← Volver</button>
                  <button type="submit" className="btn btn-primary">Continuar →</button>
                </div>
              </div>
            )}

            {/* Paso 3: Factores de riesgo */}
            {formStep===3 && (
              <div className="stack">
                <div className="section-title">Factores de riesgo</div>
                <div className="field">
                  <label className="label">Antecedentes</label>
                  <div className="grid-checks">
                    {Object.entries(ANTECEDENTES_OPTIONS).map(([key, label]) => (
                      <label className="check" key={key}>
                        <input className="checkbox" type="checkbox" checked={form.antecedentes[key]} onChange={(e) => handleMultiSelectChange("antecedentes", key, e.target.checked)} />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <label className="label">Otras condiciones</label>
                  <div className="grid-checks">
                    {Object.entries(OTRAS_COND_OPTIONS).map(([key, label]) => (
                      <label className="check" key={key}>
                        <input className="checkbox" type="checkbox" checked={form.otrasCond[key]} onChange={(e) => handleMultiSelectChange("otrasCond", key, e.target.checked)} />
                        {label}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="field">
                  <label className="label">¿Toma medicación relevante?</label>
                  <div className="row-fields" style={{ gap: '16px', alignItems: 'center' }}>
                    <label className="check">
                      <input type="radio" name="medicacion" value="si" checked={form.medicacion === 'si'} onChange={() => setForm(f => ({...f, medicacion: 'si'}))} /> Sí
                    </label>
                    <label className="check">
                      <input type="radio" name="medicacion" value="no" checked={form.medicacion === 'no'} onChange={() => setForm(f => ({...f, medicacion: 'no'}))} /> No
                    </label>
                  </div>
                </div>

                {formError && <p className="error" role="alert">{formError}</p>}
                <div className="toolbar">
                  <button type="button" className="btn btn-ghost" onClick={()=> setFormStep(2)}>← Volver</button>
                  <button type="submit" className="btn btn-primary">Ir al escaneo →</button>
                </div>
              </div>
            )}
          </form>
        </div>
      )}

      {/* ── PANTALLA 3: Escaneo de ECG ── */}
      {step === "camera" && (
        <div className="stack">
          <h1 className="h1">Escanear ECG</h1>
          <div className="subtle" style={{ marginBottom: 4 }}>
            Médico: <strong>{doctorName || "—"}</strong> · Paciente: <strong>{form.name}</strong>
          </div>
          <div className="card card--elevated" style={{ padding: "20px", textAlign: "center" }}>
            <p className="subtle" style={{ marginBottom: "20px" }}>
              Coloque el ECG sobre una superficie plana con buena iluminación y presione el botón
            </p>
            <div className="toolbar" style={{ justifyContent: "center" }}>
              <button onClick={handleScanDocument} className="btn btn-primary btn-large" disabled={apiLoading} style={{ fontSize: "1.2em", padding: "12px 24px" }}>
                📄 Escanear ECG
              </button>
              {(!isNative || !Capacitor.isPluginAvailable?.("DocumentScanner")) && (
                <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
                  📎 Cargar archivo
                  <input ref={fileInputRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFilePick(file);
                      e.currentTarget.value = "";
                    }}/>
                </label>
              )}
            </div>
          </div>
          <div className="toolbar">
            <button onClick={sendImageToApi} className="btn btn-secondary" disabled={apiLoading || !photoDataUrl}>
              {apiLoading ? "Analizando ECG..." : "Analizar ECG"}
            </button>
            <button onClick={() => setStep("form")} className="btn btn-ghost" disabled={apiLoading}>
              ← Volver al formulario
            </button>
            {photoDataUrl && (
              <button onClick={clearPhoto} className="btn btn-ghost" disabled={apiLoading}>
                🗑️ Borrar imagen
              </button>
            )}
          </div>
          {apiError && <p className="error" role="alert">Error: {apiError}</p>}
          {previewUrl && (
            <div className="card">
              <h2 className="h2" style={{ marginBottom: "12px" }}>Vista previa del ECG</h2>
              <img className="imgPreview" src={previewUrl} alt="ECG escaneado" style={{ maxWidth: "100%", borderRadius: "8px" }} />
            </div>
          )}
        </div>
      )}

      {/* ── PANTALLA 4: Resultado (REDISEÑADA) ── */}
    {step === "result" && (
  <div className="stack result">
      {effectiveRisk.level === "alto" && (
            <div className="urgent-banner" role="alert" aria-live="assertive">
              <div className="urgent-banner__icon">🚨</div>
              <div className="urgent-banner__body">
                <div className="urgent-banner__title">DERIVACIÓN URGENTE A CARDIOLOGÍA</div>
                <div className="urgent-banner__subtitle">Se detectaron hallazgos compatibles con alto riesgo. Actúe de inmediato.</div>
              </div>
            </div>
          )}
          <h1 className="h1">Resultado del análisis</h1>
          <div className="context">
            <div className="chip">👨‍⚕️ {doctorName || "—"}</div>
            <div className="chip">🧑 {form.name || "—"} ({form.age || "—"} años)</div>
            {Object.entries(form.antecedentes).filter(([, c]) => c).map(([k]) => (
                <div key={k} className="chip chip--warn">{ANTECEDENTES_OPTIONS[k as keyof typeof ANTECEDENTES_OPTIONS]}</div>
            ))}
          </div>

          <div className={`card card--elevated risk-card`} data-level={effectiveRisk.level}>
            <span className="badge" data-level={effectiveRisk.level}>{effectiveRisk.title}</span>
            <h2 className="risk-card__description">{effectiveRisk.description}</h2>
            <p className="risk-card__action"><strong>Acción Sugerida:</strong> {effectiveRisk.action}</p>
          </div>

          {(effectiveRisk.level !== "bajo" && effectiveRisk.level !== "error") && (
            effectiveRisk.level === "alto" ? (
              <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="btn btn-large btn-whatsapp btn-urgent">
                🚑 Derivar URGENTE (WhatsApp)
              </a>
            ) : (
              <a href={whatsappUrl} target="_blank" rel="noopener noreferrer" className="btn btn-primary btn-large btn-whatsapp">
                📱 Derivar a Cardiólogo (WhatsApp)
              </a>
            )
          )}

          <div className="disclaimer card"><small><strong>Recordatorio:</strong> Esta es una herramienta de apoyo. La decisión final corresponde al profesional.</small></div>

          <details className="card evidence-card">
            <summary className="h2" style={{cursor: "pointer"}}>Ver detalles del análisis de la imagen</summary>
            {apiResponse && (
                <div className="resultCard" style={{marginTop: "16px"}}>
                  <div className="result__header">
                    <h3 className="result__title">{apiResponse.prediction?.class ?? "—"}</h3>
                    <div className="confidence"><span>Confianza</span><strong>{pct(apiResponse.prediction?.probability)}</strong></div>
                    <div className="bar"><div className="bar__fill" style={{ width: `${Math.round((apiResponse.prediction?.probability ?? 0) * 100)}%` }} /></div>
                  </div>
                  {!!apiResponse?.predictions?.length && (
                    <div className="altList">
                      <div className="altList__title">Otras probabilidades</div>
                      <div className="altList__grid">
                        {apiResponse.predictions.map((p, i) => (
                          <div key={i} className="altItem">
                            <div className="altItem__head">
                              <span className="altItem__class">{p.class}</span>
                              <span className="altItem__pct">{pct(p.probability)}</span>
                            </div>
                            <div className="bar bar--thin">
                              <div className="bar__fill" style={{ width: `${Math.round((p.probability ?? 0) * 100)}%` }} />
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
            )}
            {photoDataUrl && (
                <div className="imgCard" style={{marginTop: "16px"}}>
                    <h3 className="h3">Imagen Analizada</h3>
                    <img className="imgPreview imgPreview--rounded" src={photoDataUrl} alt="ECG escaneado" />
                </div>
            )}
          </details>
          
          <div className="toolbar toolbar--sticky">
            <button className="btn btn-secondary" onClick={() => {
              resetForm();
              clearPhoto();
              setApiResponse(null);
              setStep("form");
            }}>
              ➕ Analizar Nuevo Paciente
            </button>
            <button className="btn btn-ghost" onClick={() => setStep("camera")}>
              ← Escanear de nuevo
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
