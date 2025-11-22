import { useEffect, useRef, useState } from "react";
import "./App.css";

/* Capacitor + ML Kit (Document Scanner) */
import { Capacitor } from "@capacitor/core";
import { DocumentScanner } from "@capacitor-mlkit/document-scanner";

/* ── Tipos ─────────────────────────────────────────────────────────────── */
type Step = "welcome" | "form" | "camera" | "result";

type ClinicalInfo = {
  name: string;
  age: number | "";
  smoker: boolean;
  heartIssues: boolean;
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
declare global {
  interface Window { cv: any }
}

/** Espera a que OpenCV.js esté cargado */
async function waitForOpenCV(): Promise<void> {
  if (typeof window === "undefined") return;
  await new Promise<void>((res) => {
    const check = () => (window as any).cv && (window as any).cv.Mat ? res() : setTimeout(check, 50);
    check();
  });
}

/** Mejora tipo escáner: corrige perspectiva y binariza. Devuelve dataURL */
async function enhanceDocumentWithOpenCV(srcDataUrl: string): Promise<string> {
  await waitForOpenCV();
  const cv = (window as any).cv;

  const img = await (async () => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.src = srcDataUrl;
    await new Promise((r, e) => { i.onload = () => r(null); i.onerror = e; });
    return i;
  })();

  // dataURL -> Mat
  const canvas = document.createElement("canvas");
  canvas.width = img.width; canvas.height = img.height;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const src = cv.imread(canvas);

  const gray = new cv.Mat(); const blur = new cv.Mat(); const edges = new cv.Mat();
  cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
  cv.GaussianBlur(gray, blur, new cv.Size(5,5), 0);
  cv.Canny(blur, edges, 75, 200);

  const contours = new cv.MatVector(); const hierarchy = new cv.Mat();
  cv.findContours(edges, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

  let docContour: any = null; let maxArea = 0;
  for (let i=0; i<contours.size(); i++) {
    const c = contours.get(i);
    const peri = cv.arcLength(c, true);
    const approx = new cv.Mat();
    cv.approxPolyDP(c, approx, 0.02 * peri, true);
    if (approx.rows === 4) {
      const area = cv.contourArea(approx);
      if (area > maxArea) { maxArea = area; docContour = approx; }
      else approx.delete();
    } else approx.delete();
  }

  let dstDataUrl = srcDataUrl; // fallback si no detecta 4 puntos

  if (docContour) {
    // ordenar 4 puntos (tl, tr, br, bl)
    const pts = [];
    for (let r=0; r<4; r++) { const p = docContour.intPtr(r); pts.push({x:p[0], y:p[1]}); }
    const sum = (p:any)=>p.x+p.y;
    pts.sort((a,b)=>sum(a)-sum(b));
    const [tl, br] = [pts[0], pts[3]];
    const [tr, bl] = [pts.slice(1,2)[0], pts.slice(2,3)[0]];
    const ordered = [tl, tr, br, bl];

    const widthA = Math.hypot(ordered[2].x - ordered[3].x, ordered[2].y - ordered[3].y);
    const widthB = Math.hypot(ordered[1].x - ordered[0].x, ordered[1].y - ordered[0].y);
    const maxW = Math.max(widthA, widthB) | 0;

    const heightA = Math.hypot(ordered[1].x - ordered[2].x, ordered[1].y - ordered[2].y);
    const heightB = Math.hypot(ordered[0].x - ordered[3].x, ordered[0].y - ordered[3].y);
    const maxH = Math.max(heightA, heightB) | 0;

    const srcTri = cv.matFromArray(4,1,cv.CV_32FC2,[ordered[0].x,ordered[0].y, ordered[1].x,ordered[1].y, ordered[2].x,ordered[2].y, ordered[3].x,ordered[3].y]);
    const dstTri = cv.matFromArray(4,1,cv.CV_32FC2,[0,0, maxW-1,0, maxW-1,maxH-1, 0,maxH-1]);

    const M = cv.getPerspectiveTransform(srcTri, dstTri);
    const warped = new cv.Mat();
    cv.warpPerspective(src, warped, M, new cv.Size(maxW, maxH));

    // mejora tipo "escáner": adaptive threshold más agresivo para ECG
    const warpedGray = new cv.Mat();
    const bin = new cv.Mat();
    cv.cvtColor(warped, warpedGray, cv.COLOR_RGBA2GRAY);
    cv.adaptiveThreshold(warpedGray, bin, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY, 21, 20);

    // a dataURL
    const outCanvas = document.createElement("canvas");
    outCanvas.width = bin.cols; outCanvas.height = bin.rows;
    cv.imshow(outCanvas, bin);
    dstDataUrl = outCanvas.toDataURL("image/png");

    // liberar
    srcTri.delete(); dstTri.delete(); M.delete();
    warped.delete(); warpedGray.delete(); bin.delete();
  }

  // liberar
  src.delete(); gray.delete(); blur.delete(); edges.delete();
  contours.delete(); hierarchy.delete(); if (docContour) docContour.delete();

  return dstDataUrl;
}

/* ── Capacitor helpers ─────────────────────────────────────────────────── */
const isNative = Capacitor.isNativePlatform();
const normalizeUri = (uri: string) => (isNative ? Capacitor.convertFileSrc(uri) : uri);

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

  /* ── FORM PACIENTE ────────────────────────────────────────────────────── */
  const [form, setForm] = useState<ClinicalInfo>({
    name: "",
    age: "",
    smoker: false,
    heartIssues: false,
  });
  const [formError, setFormError] = useState<string | null>(null);

  const handleStartCamera = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!form.name.trim()) {
      setFormError("El nombre del paciente es obligatorio.");
      return;
    }
    if (form.age === "" || Number.isNaN(Number(form.age)) || Number(form.age) <= 0) {
      setFormError("La edad debe ser un número mayor a 0.");
      return;
    }
    setStep("camera");
  };

  /* ── Estados para manejo de imagen y API ── */
  const [photoDataUrl, setPhotoDataUrl] = useState<string | null>(null);
  const [apiLoading, setApiLoading] = useState(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [apiResponse, setApiResponse] = useState<ApiResponseShape | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  /* ── Escaneo y procesamiento de imagen ── */
  const handleScanDocument = async () => {
    // En navegador (ngrok) no hay plugin: disparamos file picker
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

        // Procesar imagen para mejorar visualización del ECG
        const processedImage = await enhanceDocumentWithOpenCV(dataUrl);
        setPhotoDataUrl(processedImage);
        setPreviewUrl(processedImage); // Mostrar previsualización
        setApiResponse(null);
        setApiError(null);
      } catch (err) {
        console.error("Error al procesar la imagen:", err);
        throw new Error("No se pudo procesar la imagen escaneada");
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
    const dataUrl = await fileToDataUrl(file);
    // Procesar imagen para mejorar visualización del ECG
    const processedImage = await enhanceDocumentWithOpenCV(dataUrl);
    setPhotoDataUrl(processedImage);
    setPreviewUrl(processedImage); // Mostrar previsualización
    setApiResponse(null);
    setApiError(null);
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

  /* ── Enviar imagen a API y mostrar respuesta ───────────────────────── */
  const sendImageToApi = async (): Promise<void> => {
    if (!photoDataUrl) {
      setApiError("No hay imagen para enviar.");
      return;
    }

    const base64Image = photoDataUrl.split(",")[1];

    try {
      setApiLoading(true);
      setApiError(null);

      const resp = await fetch("http://localhost:8000/predict", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image_b64: base64Image }),
      });

      if (!resp.ok) {
        const text = await resp.text().catch(() => "");
        throw new Error(`API ${resp.status} ${resp.statusText}${text ? " - " + text : ""}`);
      }

      const json = (await resp.json()) as ApiResponseShape;
      setApiResponse(json);
      setStep("result");
    } catch (err: any) {
      setApiError(err?.message || "Error al enviar imagen a la API");
      setApiResponse(null);
    } finally {
      setApiLoading(false);
    }
  };

  return (
    <div className="app">
      {/* ── PANTALLA 1: Bienvenida / Médico ── */}
      {step === "welcome" && (
        <div className="app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div
            className="card card--elevated"
            style={{ textAlign: "center", padding: "32px 24px", maxWidth: 400, width: "100%" }}
          >
            <img
              src="/logo.png"
              alt="Logo"
              style={{ width: 96, height: 96, objectFit: "contain", margin: "0 auto 16px", display: "block" }}
            />
            <h1 className="h1">Ingreso del médico</h1>
            <p className="subtle" style={{ marginTop: 4 }}>Ingresá tu nombre para continuar.</p>

            <form onSubmit={handleEnter} className="form" style={{ marginTop: 16 }}>
              <div className="field">
                <label className="label" htmlFor="doctor">Nombre del médico</label>
                <input
                  id="doctor" className="input" type="text"
                  value={doctorName} onChange={(e) => setDoctorName(e.target.value)}
                  placeholder="Ej: Dra. María González" required autoComplete="name"
                />
              </div>

              {doctorError && <p className="error" role="alert">{doctorError}</p>}

              <div className="toolbar" style={{ justifyContent: "center" }}>
                <button type="submit" className="btn btn-primary">Ingresar</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── PANTALLA 2: Formulario paciente ── */}
      {step === "form" && (
        <div className="stack formPage full-viewport">
          <h1 className="h1">Información clínica básica</h1>

          <div className="subtle" style={{ marginBottom: 4 }}>
            Médico: <strong>{doctorName || "—"}</strong>
          </div>

          <form className="card form card--elevated formCard" onSubmit={handleStartCamera} noValidate>
            <div className="field">
              <label className="label" htmlFor="name">Nombre del paciente</label>
              <input
                id="name" className="input" type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Ej: Juan Pérez" required autoComplete="name"
              />
            </div>

            <div className="field">
              <label className="label" htmlFor="age">Edad</label>
              <input
                id="age" className="input" type="number" min={1} max={120}
                value={form.age}
                onChange={(e) => setForm((f) => ({ ...f, age: e.target.value === "" ? "" : Number(e.target.value) }))}
                placeholder="Ej: 45" required inputMode="numeric"
              />
            </div>

            <div className="row">
              <label className="check">
                <input className="checkbox" type="checkbox"
                  checked={form.smoker} onChange={(e) => setForm((f) => ({ ...f, smoker: e.target.checked }))}/>
                ¿Es fumador?
              </label>

              <label className="check">
                <input className="checkbox" type="checkbox"
                  checked={form.heartIssues} onChange={(e) => setForm((f) => ({ ...f, heartIssues: e.target.checked }))}/>
                ¿Tiene problemas cardíacos?
              </label>
            </div>

            {formError && <p className="error" role="alert">{formError}</p>}

            <div className="toolbar">
              <button type="submit" className="btn btn-primary">Continuar al escaneo</button>
              <button type="button" className="btn btn-ghost" onClick={() => setStep("welcome")}>
                ← Cambiar médico
              </button>
            </div>
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
              Coloque el ECG sobre una superficie plana con buena iluminación y presione el botón para escanearlo
            </p>

            {/* Barra de acciones principal */}
            <div className="toolbar" style={{ justifyContent: "center" }}>
              <button 
                onClick={handleScanDocument} 
                className="btn btn-primary btn-large" 
                disabled={apiLoading}
                style={{ fontSize: "1.2em", padding: "12px 24px" }}
              >
                📄 Escanear ECG
              </button>

              {/* Opción de cargar archivo solo en web */}
              {(!isNative || !Capacitor.isPluginAvailable?.("DocumentScanner")) && (
                <label className="btn btn-secondary" style={{ cursor: "pointer" }}>
                  📎 Cargar archivo ECG
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) handleFilePick(file);
                      e.currentTarget.value = "";
                    }}
                  />
                </label>
              )}
            </div>
          </div>

          {/* Barra de acciones secundaria */}
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

          {/* Mensajes de error */}
          {apiError && <p className="error" role="alert">Error: {apiError}</p>}

          {/* Vista previa del ECG escaneado */}
          {previewUrl && (
            <div className="card">
              <h2 className="h2" style={{ marginBottom: "12px" }}>Vista previa del ECG</h2>
              <img className="imgPreview" src={previewUrl} alt="ECG escaneado" style={{ maxWidth: "100%", borderRadius: "8px" }} />
            </div>
          )}
        </div>
      )}

      {/* ── PANTALLA 4: Resultado ── */}
      {step === "result" && apiResponse && (
        <div className="stack result">
          <h1 className="h1">Resultado del análisis</h1>

          <div className="context">
            <div className="chip">👨‍⚕️ {doctorName || "—"}</div>
            <div className="chip">🧑‍🦱 Paciente: {form.name || "—"}</div>
            <div className="chip">🎂 Edad: {form.age || "—"}</div>
            {form.smoker && <div className="chip chip--warn">🚬 Fumador</div>}
            {form.heartIssues && <div className="chip chip--warn">❤ Antecedentes cardíacos</div>}
          </div>

          {apiResponse.review && (
            <div className="alert alert--danger">
              <div className="alert__icon">⚠️</div>
              <div className="alert__body">
                <div className="alert__title">Revisión necesaria</div>
                <div className="alert__text">LLAMAR A UN CARDIÓLOGO</div>
              </div>
            </div>
          )}

          <div className="card card--elevated resultCard">
            <div className="result__header">
              <span className="badge">Pre-diagnóstico</span>
              <h2 className="result__title">
                {apiResponse.prediction?.class ?? "—"}
              </h2>
              <div className="confidence">
                <span>Confianza</span>
                <strong>{pct(apiResponse.prediction?.probability)}</strong>
              </div>
              <div className="bar">
                <div
                  className="bar__fill"
                  style={{ width: `${Math.round((apiResponse.prediction?.probability ?? 0) * 100)}%` }}
                />
              </div>
            </div>

            {!!apiResponse.predictions?.length && (
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
                        <div
                          className="bar__fill"
                          style={{ width: `${Math.round((p.probability ?? 0) * 100)}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {typeof apiResponse.margin === "number" && (
              <div className="meta">
                <span className="meta__label">Margen</span>
                <code className="meta__code">{apiResponse.margin.toFixed(4)}</code>
              </div>
            )}
          </div>

          {photoDataUrl && (
            <div className="card imgCard">
              <img className="imgPreview imgPreview--rounded" src={photoDataUrl} alt="ECG escaneado" />
            </div>
          )}

          <div className="toolbar toolbar--sticky">
            <button className="btn btn-primary" onClick={() => setStep("camera")}>
              ➕ Analizar otro ECG
            </button>
            <button className="btn btn-ghost" onClick={() => setStep("form")}>
              ← Volver al formulario
            </button>
          </div>
        </div>
      )}

      {step === "result" && !apiResponse && (
        <div className="stack">
          <h1 className="h1">Resultado del análisis</h1>
          <div className="card">No hay respuesta disponible.</div>
          <div className="toolbar">
            <button className="btn btn-primary" onClick={() => setStep("camera")}>
              Volver al escáner
            </button>
          </div>
        </div>
      )}
    </div>
  );
}