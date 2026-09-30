import type { components } from "./api";

export type Consultation = components["schemas"]["Consultation"];
export type ConsultationFields = components["schemas"]["ConsultationFields"];
export type Job = components["schemas"]["Job"];
export type ExportReceipt = components["schemas"]["ExportReceipt"];
export type Health = components["schemas"]["Health"];
export type ApiErrorBody = components["schemas"]["ErrorResponse"];

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

/** baseUrl includes /api, e.g. http://localhost:8000/api. No OpenAI keys here. */
export function createMedHubClient(baseUrl: string) {
  const base = baseUrl.replace(/\/$/, "");
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    if (init.body && !(init.body instanceof FormData)) headers.set("Content-Type", "application/json");
    const response = await fetch(`${base}${path}`, { ...init, headers });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = (body as ApiErrorBody | null)?.error;
      throw new ApiError(response.status, error?.code ?? "HTTP_ERROR", error?.message ?? "Ошибка API");
    }
    return body as T;
  }
  return {
    health: () => request<Health>("/health"),
    create: (patient_id: string, language: "ru" | "kk" | "auto" = "ru") =>
      request<Consultation>("/consultations", {
        method: "POST", body: JSON.stringify({ patient_id, language }),
      }),
    get: (id: string) => request<Consultation>(`/consultations/${encodeURIComponent(id)}`),
    save: (consultation: Consultation, fields: ConsultationFields) =>
      request<Consultation>(`/consultations/${consultation.id}`, {
        method: "PATCH", body: JSON.stringify({ expected_revision: consultation.revision, fields }),
      }),
    demo: (consultation: Consultation) => request<Job>(`/consultations/${consultation.id}/demo`, {
      method: "POST", body: JSON.stringify({ expected_revision: consultation.revision }),
    }),
    upload: (consultation: Consultation, file: File) => {
      const body = new FormData();
      body.set("file", file);
      body.set("expected_revision", String(consultation.revision));
      return request<Job>(`/consultations/${consultation.id}/audio`, { method: "POST", body });
    },
    job: (id: string, signal?: AbortSignal) =>
      request<Job>(`/jobs/${encodeURIComponent(id)}`, { signal }),
    confirm: (consultation: Consultation) =>
      request<Consultation>(`/consultations/${consultation.id}/confirm`, {
        method: "POST", body: JSON.stringify({ expected_revision: consultation.revision }),
      }),
    export: (consultation: Consultation) =>
      request<ExportReceipt>(`/consultations/${consultation.id}/export`, {
        method: "POST", body: JSON.stringify({ expected_revision: consultation.revision }),
      }),
  };
}
